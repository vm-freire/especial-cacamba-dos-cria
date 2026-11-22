// Motor copiado do Autotune Igão (src/autotune-processor.js), sem mudanças. Copiado pro dist/ no build.
'use strict';
// Motor do Autotune Igão.
// Roda dentro de um AudioWorklet (thread de áudio) e também no Node, para os testes.
//
// 1. Detecção de nota: YIN sobre uma cópia do sinal reduzida para ~16 kHz.
// 2. Escolha da nota alvo: nota mais próxima da escala, com histerese.
// 3. Correção: TD-PSOLA (recorta "grãos" de um período e reespaça), o que
//    muda a nota sem mudar o timbre. Atraso fixo e pequeno (~10 a 20 ms).

const NOMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const ESCALAS = {
  cromatica: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  maior: [0, 2, 4, 5, 7, 9, 11],
  menor: [0, 2, 3, 5, 7, 8, 10],
  menorHarmonica: [0, 2, 3, 5, 7, 8, 11],
  menorPentatonica: [0, 3, 5, 7, 10],
  maiorPentatonica: [0, 2, 4, 7, 9],
};

// Nota mais grave esperada por tipo de voz (define o atraso: quanto mais grave, mais atraso).
const VOZES = { grave: 70, media: 95, aguda: 150 };
const FREQ_MAX = 1100;

// Padrão "trap": correção instantânea (robótica), cromática, 100% do efeito.
const PADRAO = {
  ativo: true,
  tom: 0,
  escala: 'cromatica',
  velocidade: 0, // ms até chegar na nota (0 = instantâneo)
  intensidade: 1, // 0..1 (mistura com a voz original)
  transpor: 0, // semitons
  voz: 'media',
  ganhoEntrada: 1, // linear
  volume: 1, // linear
  reducaoRuido: 0.6, // 0..1: força do portão de ruído automático (0 = desligado)
};

class AutotuneCore {
  constructor(sampleRate, params) {
    this.sr = sampleRate;
    this.N = 16384;
    this.mask = this.N - 1;
    this.inBuf = new Float32Array(this.N);
    this.acc = new Float32Array(this.N);
    this.t = 0;

    // Cópia reduzida para a detecção.
    this.dec = Math.max(1, Math.round(sampleRate / 16000));
    this.dsr = sampleRate / this.dec;
    this.DN = 4096;
    this.dmask = this.DN - 1;
    this.dbuf = new Float32Array(this.DN);
    this.dn = 0;
    this.decCount = 0;
    this.lpA = Math.exp((-2 * Math.PI * 3000) / sampleRate);
    this.lp1 = 0;
    this.lp2 = 0;
    this.W = Math.round(0.02 * this.dsr);
    const tauMaxAbs = Math.ceil(this.dsr / 50) + 2;
    this.frame = new Float32Array(this.W + tauMaxAbs);
    this.cmnd = new Float32Array(tauMaxAbs + 2);
    this.hop = 128;
    this.hopCount = 0;

    // Estado da afinação.
    this.saltoPendente = 0;
    this.freq = 0;
    this.voiced = false;
    this.nota = -1;
    this.corr = 0;
    this.ratio = 1;
    this.nivel = 0;

    // Portão de voz: só deixa passar o que parece a SUA voz.
    //  - mais alto que o chiado do ambiente (piso);
    //  - perto do volume em que você canta (o app aprende): sons de longe ficam de fora;
    //  - com nota (voz cantada) ou, se não tiver nota ("sss", "ch"), longo e agudo como
    //    essas consoantes: clique de teclado é curto, batida é grave, e nenhum tem nota.
    // Abre antes da voz chegar na saída porque a saída anda ~15 ms atrás da entrada.
    this.piso = -60;
    this.limiar = -54;
    this.vozDb = -Infinity; // volume típico da sua voz (aprendido)
    this.contaNota = 0; // análises seguidas com nota
    this.contaForte = 0; // análises seguidas fortes e agudas, sem nota
    this.eHop = 0; // energia do último trecho
    this.dHop = 0; // energia da diferença entre amostras (alta = som agudo, chiado)
    this.xAnt = 0;
    this.ultimaVoz = -Infinity;
    this.ultimoBarulho = -Infinity; // último som barrado (para a tela mostrar)
    this.abertoAte = -Infinity;
    this.portao = 1;
    this.kAbrir = 1 - Math.exp(-1 / (0.003 * sampleRate));
    this.kFechar = 1 - Math.exp(-1 / (0.06 * sampleRate));

    // Estado do PSOLA.
    this.P = sampleRate / 150;
    this.nextSyn = 0;
    this.ana = 0;
    this.vg = 0; // 1 = voz com nota (usa o afinado)
    this.p = { ...PADRAO };
    this.setParams(params || {});
    this.bg = this.p.ativo ? 0 : 1; // 1 = efeito desligado (passa direto, sem atraso)
    this.ana = -this.D;
    this.kSuave = 1 - Math.exp(-1 / (0.008 * sampleRate));
  }

  setParams(params) {
    Object.assign(this.p, params);
    const p = this.p;
    const minFreq = VOZES[p.voz] || VOZES.media;
    this.tauMin = Math.max(2, Math.floor(this.dsr / FREQ_MAX));
    this.tauMax = Math.min(this.cmnd.length - 2, Math.ceil(this.dsr / minFreq));
    this.Pmax = this.sr / minFreq;
    this.D = Math.ceil(1.2 * this.Pmax) + 128;
    const escala = ESCALAS[p.escala] || ESCALAS.cromatica;
    this.permitidas = new Array(12).fill(false);
    for (const g of escala) this.permitidas[(((g + p.tom) % 12) + 12) % 12] = true;
    if (this.nota >= 0 && !this.permitidas[this.nota % 12]) this.nota = -1;
  }

  atrasoMs() {
    return (this.D / this.sr) * 1000;
  }

  detectar() {
    const W = this.W;
    const tm = this.tauMax;
    const len = W + tm;
    const f = this.frame;
    const ini = this.dn - len;
    for (let j = 0; j < len; j++) f[j] = this.dbuf[(ini + j) & this.dmask];

    let soma2 = 0;
    for (let j = tm; j < len; j++) soma2 += f[j] * f[j];
    const rms = Math.sqrt(soma2 / W);
    this.nivel = rms;
    const db = 20 * Math.log10(rms + 1e-12);
    this.ultimoDb = db;
    this.ultimaClareza = 1;
    this.atualizarPiso(db);
    if (db < this.limiar) return 0;

    // YIN: diferença cumulativa normalizada.
    const c = this.cmnd;
    c[0] = 1;
    let acum = 0;
    for (let tau = 1; tau <= tm; tau++) {
      let d = 0;
      for (let j = 0; j < W; j++) {
        const x = f[j] - f[j + tau];
        d += x * x;
      }
      acum += d;
      c[tau] = acum > 0 ? (d * tau) / acum : 1;
    }

    let tau = -1;
    for (let k = this.tauMin; k <= tm; k++) {
      if (c[k] < 0.15) {
        while (k + 1 <= tm && c[k + 1] < c[k]) k++;
        tau = k;
        break;
      }
    }
    if (tau < 0) {
      let melhor = this.tauMin;
      for (let k = this.tauMin; k <= tm; k++) if (c[k] < c[melhor]) melhor = k;
      if (c[melhor] > 0.3) {
        this.ultimaClareza = c[melhor];
        return 0;
      }
      tau = melhor;
    }
    this.ultimaClareza = c[tau];
    if (tau >= tm) return 0;

    let t = tau;
    if (tau > 1) {
      const a = c[tau - 1];
      const b = c[tau];
      const d = c[tau + 1];
      const den = a - 2 * b + d;
      if (den > 1e-9) t = tau + (0.5 * (a - d)) / den;
    }
    return this.dsr / t;
  }

  atualizarAfinacao(dt) {
    const bruta = this.detectar();
    this.atualizarPortao(this.ultimoDb, bruta > 0 && this.ultimaClareza < 0.25);
    if (bruta <= 0) {
      this.voiced = false;
      this.freq = 0;
      this.saltoPendente = 0;
      return;
    }
    // Salto grande (ex.: erro de oitava) só vale se a leitura seguinte confirmar.
    const f = bruta;
    if (this.freq > 0 && Math.abs(Math.log2(f / this.freq)) > 0.25) {
      const confirma = this.saltoPendente > 0 && Math.abs(Math.log2(f / this.saltoPendente)) < 0.1;
      if (!confirma) {
        this.saltoPendente = f;
        return;
      }
    }
    this.saltoPendente = 0;
    this.freq = f;
    this.voiced = true;
    this.P = Math.min(this.sr / f, this.Pmax * 1.05);

    const midi = 69 + 12 * Math.log2(f / 440);
    let alvo = -1;
    let dist = Infinity;
    const base = Math.round(midi);
    for (let n = base - 6; n <= base + 6; n++) {
      if (!this.permitidas[((n % 12) + 12) % 12]) continue;
      const dd = Math.abs(midi - n);
      if (dd < dist) {
        dist = dd;
        alvo = n;
      }
    }
    if (this.nota < 0 || Math.abs(midi - this.nota) > dist + 0.1 || Math.abs(midi - this.nota) > 3) {
      this.nota = alvo;
    }

    const desejada = this.nota - midi;
    const vel = this.p.velocidade;
    const alfa = vel <= 0 ? 1 : 1 - Math.exp((-dt * 1000) / vel);
    this.corr += (desejada - this.corr) * alfa;
    const r = Math.pow(2, (this.corr + this.p.transpor) / 12);
    this.ratio = Math.min(2.2, Math.max(0.45, r));
  }

  atualizarPiso(db) {
    // Piso do ruído: desce rápido (silêncio), sobe devagar (~1,5 dB/s) para não "aprender" a voz.
    if (db < this.piso) this.piso += (db - this.piso) * 0.3;
    else this.piso = Math.min(db, this.piso + 0.004);
    this.piso = Math.min(-35, Math.max(-90, this.piso));
    const r = this.p.reducaoRuido;
    this.limiar = Math.min(-30, Math.max(-75, this.piso + 6 + 10 * r));
  }

  // Abaixo deste volume não é você (está longe do microfone). Mais forte = mais exigente.
  limiarVoz() {
    const r = this.p.reducaoRuido;
    return Number.isFinite(this.vozDb) ? this.vozDb - (22 - 12 * r) : -Infinity;
  }

  atualizarPortao(db, temNota) {
    const r = this.p.reducaoRuido;
    const hop = this.hop / this.sr;
    if (r <= 0) {
      this.abertoAte = this.t + this.sr; // desligado: sempre aberto
      return;
    }
    const alto = db > this.limiar && db > this.limiarVoz();
    // "sss", "ch", "f": chiado agudo (diferença entre amostras grande). Batida é grave.
    const agudo = this.dHop > 0.5 * this.eHop;
    this.eHop = 0;
    this.dHop = 0;
    this.contaNota = alto && temNota ? this.contaNota + 1 : 0;
    this.contaForte = alto && agudo ? this.contaForte + 1 : 0;
    // Achou nota, ou som forte sem nota por ~45 ms (clique de tecla dura menos).
    const voz = this.contaNota >= 1 || this.contaForte >= Math.round(0.045 / hop);
    if (voz) {
      // Segura aberto 100 ms depois (não corta finais de palavra).
      this.abertoAte = this.t + Math.round(0.1 * this.sr);
      this.ultimaVoz = this.t;
      // Aprende o volume da sua voz: sobe rápido, desce devagar.
      if (temNota) {
        if (!Number.isFinite(this.vozDb)) this.vozDb = db;
        else this.vozDb += (db - this.vozDb) * (db > this.vozDb ? 0.05 : 0.001);
      }
    } else if (db > this.limiar && this.t > this.abertoAte) {
      this.ultimoBarulho = this.t;
    }
    // Muito tempo sem você cantar: esquece devagar o volume aprendido (0,25 dB/s).
    if (Number.isFinite(this.vozDb) && this.t - this.ultimaVoz > 10 * this.sr) this.vozDb -= 0.25 * hop;
  }

  ler(pos) {
    const i = Math.floor(pos);
    const fr = pos - i;
    const a = this.inBuf[i & this.mask];
    const b = this.inBuf[(i + 1) & this.mask];
    return a + (b - a) * fr;
  }

  // Procura, perto de "cand", o ponto que mais se parece com o ciclo em "anterior".
  alinhar(cand, anterior, P, maisNova) {
    const meio = Math.floor(P / 2);
    const raio = Math.max(1, Math.floor(P / 6));
    const buf = this.inBuf;
    const m = this.mask;
    const a0 = Math.round(anterior);
    const base = Math.round(cand);
    let melhor = cand;
    let max = -Infinity;
    for (let d = -raio; d <= raio; d++) {
      const c = base + d;
      if (c + meio > maisNova) break;
      let s = 0;
      for (let k = -meio; k < meio; k += 2) s += buf[(a0 + k) & m] * buf[(c + k) & m];
      if (s > max) {
        max = s;
        melhor = c;
      }
    }
    return melhor;
  }

  colocarGraos(L) {
    const t = this.t;
    const maisNova = t + L - 1;
    let guarda = 0;
    while (this.nextSyn - this.P < t + L && guarda++ < 64) {
      const P = this.P;
      const alvo = this.nextSyn - this.D;
      if (Math.abs(alvo - this.ana) > 4 * P) this.ana = alvo;
      while (this.ana + 0.5 * P < alvo) {
        const anterior = this.ana;
        this.ana += P;
        // Encaixa o recorte no ciclo real da onda: tira a tremedeira que sobra na nota.
        if (this.voiced) this.ana = this.alinhar(this.ana, anterior, P, maisNova);
      }
      let a = this.ana;
      while (a + P > maisNova) a -= P;

      const s0 = Math.floor(this.nextSyn);
      const fr = this.nextSyn - s0;
      const Pi = Math.ceil(P);
      const escala = 1 / this.ratio;
      const kIni = Math.max(-Pi, t - s0);
      const acc = this.acc;
      const m = this.mask;
      for (let k = kIni; k <= Pi; k++) {
        const off = k - fr;
        if (off <= -P || off >= P) continue;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * off) / P);
        acc[(s0 + k) & m] += w * escala * this.ler(a + off);
      }
      this.nextSyn += P / this.ratio;
    }
  }

  // entrada: Float32Array (ou null); saida: Float32Array com L amostras.
  process(entrada, saida, L) {
    const p = this.p;
    const m = this.mask;
    const g = p.ganhoEntrada;
    for (let i = 0; i < L; i++) {
      const x = entrada ? entrada[i] * g : 0;
      this.inBuf[(this.t + i) & m] = x;
      this.eHop += x * x;
      this.dHop += (x - this.xAnt) * (x - this.xAnt);
      this.xAnt = x;
      this.lp1 = x + this.lpA * (this.lp1 - x);
      this.lp2 = this.lp1 + this.lpA * (this.lp2 - this.lp1);
      if (++this.decCount >= this.dec) {
        this.decCount = 0;
        this.dbuf[this.dn & this.dmask] = this.lp2;
        this.dn++;
      }
    }
    this.hopCount += L;
    while (this.hopCount >= this.hop) {
      this.hopCount -= this.hop;
      this.atualizarAfinacao(this.hop / this.sr);
    }

    this.colocarGraos(L);

    const vAlvo = this.voiced ? 1 : 0;
    const bAlvo = p.ativo ? 0 : 1;
    const k = this.kSuave;
    const mix = p.intensidade;
    const vol = p.volume;
    const D = this.D;
    const fechado = Math.pow(10, (-70 * p.reducaoRuido) / 20);
    for (let i = 0; i < L; i++) {
      const tt = this.t + i;
      const idx = tt & m;
      const afinado = this.acc[idx];
      this.acc[idx] = 0;
      const seco = this.inBuf[(tt - D) & m];
      this.vg += (vAlvo - this.vg) * k;
      this.bg += (bAlvo - this.bg) * k;
      const pAlvo = tt <= this.abertoAte + D ? 1 : fechado;
      this.portao += (pAlvo - this.portao) * (pAlvo > this.portao ? this.kAbrir : this.kFechar);
      let proc = this.vg * afinado + (1 - this.vg) * seco;
      proc = mix * proc + (1 - mix) * seco;
      let y = (this.bg * this.inBuf[idx] + (1 - this.bg) * proc) * vol * this.portao;
      if (y > 1) y = 1;
      else if (y < -1) y = -1;
      saida[i] = y;
    }
    this.t += L;
  }

  medidor() {
    const midi = this.freq > 0 ? 69 + 12 * Math.log2(this.freq / 440) : null;
    return {
      freq: this.freq,
      nota: this.voiced ? this.nota : -1,
      cents: midi !== null && this.nota >= 0 ? Math.round((midi - this.nota) * 100) : 0,
      nivelDb: 20 * Math.log10(this.nivel + 1e-12),
      pisoDb: this.piso,
      limiarDb: Math.max(this.limiar, this.limiarVoz()),
      vozDb: Number.isFinite(this.vozDb) ? this.vozDb : null,
      barrando: this.t - this.ultimoBarulho < 0.4 * this.sr,
      atrasoMs: this.atrasoMs(),
    };
  }
}

if (typeof registerProcessor === 'function') {
  class ProcessadorAutotune extends AudioWorkletProcessor {
    constructor(opcoes) {
      super();
      const params = (opcoes && opcoes.processorOptions && opcoes.processorOptions.params) || {};
      this.core = new AutotuneCore(sampleRate, params);
      this.mono = new Float32Array(128);
      this.contaMedidor = 0;
      this.port.onmessage = (e) => {
        if (e.data && e.data.tipo === 'params') this.core.setParams(e.data.params);
      };
    }

    process(inputs, outputs) {
      const saida = outputs[0];
      const L = saida[0].length;
      const ent = inputs[0];
      let entrada = null;
      if (ent && ent.length > 0) {
        if (ent.length === 1) entrada = ent[0];
        else {
          if (this.mono.length !== L) this.mono = new Float32Array(L);
          const a = ent[0];
          const b = ent[1];
          for (let i = 0; i < L; i++) this.mono[i] = 0.5 * (a[i] + b[i]);
          entrada = this.mono;
        }
      }
      this.core.process(entrada, saida[0], L);
      for (let c = 1; c < saida.length; c++) saida[c].set(saida[0]);

      this.contaMedidor += L;
      if (this.contaMedidor >= 1536) {
        this.contaMedidor = 0;
        this.port.postMessage({ tipo: 'medidor', ...this.core.medidor() });
      }
      return true;
    }
  }
  registerProcessor('autotune-igao', ProcessadorAutotune);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AutotuneCore, PADRAO, ESCALAS, NOMES, VOZES };
}
