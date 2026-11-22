// Conversão de voz com IA (RVC) em tempo real, rodando local com onnxruntime.
//
// Caminho de cada pedaço (171 ms):
//   mic 48 kHz -> 16 kHz -> [content vec (CPU) + rmvpe (CPU)] -> modelo da voz (placa de vídeo, DirectML)
//   -> SOLA (emenda sem estalo) -> 48 kHz
// Usado pelo app (tempo real) e pelo Estúdio de Vozes (arquivo inteiro).

export const SR_IN = 48000;
export const HOP16 = 2720; // 17 quadros de 10 ms = 170 ms
export const HOP48 = HOP16 * 3; // 8160 amostras a 48 kHz
export const WIN16 = 9600; // janela de 0,6 s (contexto + pedaço novo)
// A placa de vídeo (DirectML) só fica rápida no PRIMEIRO tamanho de entrada que vê: por isso a janela é
// sempre do mesmo tamanho e o primeiro uso de cada modelo é com esse tamanho.
const F0_MIN_MEL = 1127 * Math.log(1 + 50 / 700);
const F0_MAX_MEL = 1127 * Math.log(1 + 1100 / 700);

// ---------- float16 ----------
// O onnxruntime transforma Uint16Array em Float16Array nativo (Node 24+), que o binding nativo
// não consegue ler; então os dados vão por um Uint16Array que aponta pra mesma memória.
function halfTensor(ort, f32, dims) {
  let u16;
  if (typeof Float16Array !== 'undefined') {
    const h = new Float16Array(f32.length);
    h.set(f32);
    u16 = new Uint16Array(h.buffer);
  } else {
    u16 = new Uint16Array(f32.length);
    for (let i = 0; i < f32.length; i++) u16[i] = toHalf(f32[i]);
  }
  const t = new ort.Tensor('float16', u16, dims);
  t.cpuData = u16;
  return t;
}
const _f = new Float32Array(1);
const _u = new Uint32Array(_f.buffer);
function toHalf(v) {
  _f[0] = v;
  const x = _u[0];
  const s = (x >> 16) & 0x8000;
  const e = ((x >> 23) & 0xff) - 112;
  if (e <= 0) return s;
  if (e >= 31) return s | 0x7c00;
  return s | (e << 10) | ((x & 0x7fffff) >> 13);
}
function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return 0;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
function toFloat32(data) {
  if (data instanceof Float32Array) return data;
  if (data instanceof Uint16Array) {
    const o = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) o[i] = fromHalf(data[i]);
    return o;
  }
  return Float32Array.from(data); // Float16Array nativo
}

// ---------- reamostragem ----------
// 48k -> 16k: passa-baixa (FIR janelado, corte 7,2 kHz) e pega 1 de cada 3, guardando o estado entre pedaços
const FIR = (() => {
  const n = 63;
  const h = new Float32Array(n);
  const fc = 7200 / 48000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const k = i - (n - 1) / 2;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
})();

export class Down3 {
  constructor() {
    this.hist = new Float32Array(FIR.length - 1);
  }
  process(x) {
    const H = this.hist.length;
    const buf = new Float32Array(H + x.length);
    buf.set(this.hist);
    buf.set(x, H);
    const out = new Float32Array(Math.floor(x.length / 3));
    for (let o = 0; o < out.length; o++) {
      const end = H + o * 3; // amostra mais nova usada
      let acc = 0;
      for (let k = 0; k < FIR.length; k++) acc += FIR[k] * buf[end - k];
      out[o] = acc;
    }
    this.hist = buf.slice(buf.length - H);
    return out;
  }
}

// taxa qualquer -> 48k, linear, contínuo entre pedaços
export class Resampler {
  constructor(from, to) {
    this.step = from / to;
    this.pos = 0;
    this.last = 0;
  }
  process(x, nOut) {
    const out = new Float32Array(nOut);
    for (let i = 0; i < nOut; i++) {
      const p = this.pos + i * this.step;
      const i0 = Math.floor(p);
      const fr = p - i0;
      const a = i0 - 1 < 0 ? this.last : x[i0 - 1];
      const b = i0 < x.length ? x[i0] : x[x.length - 1];
      out[i] = a + (b - a) * fr;
    }
    const used = this.pos + nOut * this.step;
    this.pos = used - x.length;
    this.last = x[x.length - 1];
    return out;
  }
}

// ---------- modelos ----------
export class RvcEngine {
  /**
   * @param ort módulo onnxruntime-node
   * @param paths { contentVec, rmvpe }
   */
  constructor(ort, paths) {
    this.ort = ort;
    this.paths = paths;
    this.emb = null;
    this.f0 = null;
    this.voice = null;
    this.gpu = true;
  }

  async init() {
    const ort = this.ort;
    const threads = Math.max(2, Math.min(4, (await import('os')).cpus().length - 2));
    const cpu = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: threads };
    const dml = { executionProviders: ['dml'], graphOptimizationLevel: 'all' };
    try {
      this.emb = await ort.InferenceSession.create(this.paths.contentVec, dml);
      this.f0 = await ort.InferenceSession.create(this.paths.rmvpe, dml);
      this.gpu = true;
    } catch (_) {
      // sem placa compatível com DirectX 12: vai no processador (mais lento)
      this.emb = await ort.InferenceSession.create(this.paths.contentVec, cpu);
      this.f0 = await ort.InferenceSession.create(this.paths.rmvpe, cpu);
      this.gpu = false;
    }
    this.cpuOpt = cpu;
    // primeiro uso já no tamanho fixo
    const w = await this.features(new Float32Array(WIN16));
    this.frames = w.n;
  }

  /** carrega o modelo da voz (.onnx do w-okada ou do RVC WebUI) */
  async loadVoice(modelPath) {
    const ort = this.ort;
    let s = null;
    try {
      if (!this.gpu) throw new Error('cpu');
      s = await ort.InferenceSession.create(modelPath, { executionProviders: ['dml'], graphOptimizationLevel: 'all' });
    } catch (e) {
      s = await ort.InferenceSession.create(modelPath, this.cpuOpt);
    }
    if (this.voice) await this.voice.session.release().catch(() => {});
    const names = s.inputNames;
    let meta = {};
    try {
      meta = JSON.parse(s.handler?.metadata?.metadata || '{}');
    } catch (_) {}
    const kind = names.includes('feats') ? 'wokada' : names.includes('phone') ? 'webui' : null;
    if (!kind) throw new Error('modelo de voz em formato desconhecido');
    // o do w-okada guarda a taxa na metadata; o do WebUI não, então descobre rodando
    this.voice = { session: s, kind, sr: meta.samplingRate || 0, half: false };
    const n = this.frames;
    const probe = await this.runVoice(new Float32Array(n * 768), new Float32Array(n), n, true);
    this.voice.sr = this.voice.sr || Math.round(probe.length / n) * 100;
    return { sr: this.voice.sr, gpu: this.gpu, kind };
  }

  async features(a16) {
    const ort = this.ort;
    const [e, r] = await Promise.all([
      this.emb.run({ audio: new ort.Tensor('float32', a16, [1, a16.length]) }),
      this.f0.run({
        waveform: new ort.Tensor('float32', a16, [1, a16.length]),
        threshold: new ort.Tensor('float32', new Float32Array([0.3]), [1]),
      }),
    ]);
    const u = e.unit12;
    const T = u.dims[1];
    const pf = r.pitchf.data;
    const n = Math.min(T * 2, pf.length);
    // content vec sai a 50 quadros/s; o modelo quer 100: repete cada quadro
    const feats = new Float32Array(n * 768);
    const ud = u.data;
    for (let i = 0; i < n; i++) feats.set(ud.subarray((i >> 1) * 768, (i >> 1) * 768 + 768), i * 768);
    return { feats, f0: Float32Array.from(pf.subarray(0, n)), n };
  }

  async runVoice(feats, f0, n, probe = false, tran = 0) {
    const ort = this.ort;
    const v = this.voice;
    const pitch = new BigInt64Array(n);
    const pitchf = new Float32Array(n);
    const k = 2 ** (tran / 12);
    for (let i = 0; i < n; i++) {
      const f = f0[i] * k;
      pitchf[i] = f;
      let m = 1127 * Math.log(1 + f / 700);
      if (m > 0) m = ((m - F0_MIN_MEL) * 254) / (F0_MAX_MEL - F0_MIN_MEL) + 1;
      pitch[i] = BigInt(Math.max(1, Math.min(255, Math.round(m))));
    }
    const s = v.session;
    let feeds;
    if (v.kind === 'wokada') {
      const half = probe ? await this.isHalf('feats') : v.half;
      if (probe) v.half = half;
      feeds = {
        feats: half ? halfTensor(ort, feats, [1, n, 768]) : new ort.Tensor('float32', feats, [1, n, 768]),
        p_len: new ort.Tensor('int64', new BigInt64Array([BigInt(n)]), [1]),
        pitch: new ort.Tensor('int64', pitch, [1, n]),
        pitchf: new ort.Tensor('float32', pitchf, [1, n]),
        sid: new ort.Tensor('int64', new BigInt64Array([0n]), [1]),
      };
    } else {
      const half = probe ? await this.isHalf('phone') : v.half;
      if (probe) v.half = half;
      const rnd = new Float32Array(192 * n);
      for (let i = 0; i < rnd.length; i++) rnd[i] = gauss();
      feeds = {
        phone: half ? halfTensor(ort, feats, [1, n, 768]) : new ort.Tensor('float32', feats, [1, n, 768]),
        phone_lengths: new ort.Tensor('int64', new BigInt64Array([BigInt(n)]), [1]),
        pitch: new ort.Tensor('int64', pitch, [1, n]),
        pitchf: new ort.Tensor('float32', pitchf, [1, n]),
        ds: new ort.Tensor('int64', new BigInt64Array([0n]), [1]),
        rnd: half ? halfTensor(ort, rnd, [1, 192, n]) : new ort.Tensor('float32', rnd, [1, 192, n]),
      };
    }
    const out = await s.run(feeds);
    const first = out.audio || out[s.outputNames[0]];
    return toFloat32(first.data);
  }

  // descobre se a entrada é float16 tentando float32 primeiro
  async isHalf(name) {
    const meta = this.voice.session.inputMetadata;
    if (Array.isArray(meta)) {
      const m = meta.find((x) => x.name === name);
      if (m && m.type) return m.type === 'float16';
    }
    const n = this.frames; // mesmo tamanho fixo (ver WIN16)
    const ort = this.ort;
    try {
      const feeds = this.voice.kind === 'wokada'
        ? {
            feats: new ort.Tensor('float32', new Float32Array(n * 768), [1, n, 768]),
            p_len: new ort.Tensor('int64', new BigInt64Array([BigInt(n)]), [1]),
            pitch: new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]),
            pitchf: new ort.Tensor('float32', new Float32Array(n), [1, n]),
            sid: new ort.Tensor('int64', new BigInt64Array([0n]), [1]),
          }
        : {
            phone: new ort.Tensor('float32', new Float32Array(n * 768), [1, n, 768]),
            phone_lengths: new ort.Tensor('int64', new BigInt64Array([BigInt(n)]), [1]),
            pitch: new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]),
            pitchf: new ort.Tensor('float32', new Float32Array(n), [1, n]),
            ds: new ort.Tensor('int64', new BigInt64Array([0n]), [1]),
            rnd: new ort.Tensor('float32', new Float32Array(192 * n), [1, 192, n]),
          };
      await this.voice.session.run(feeds);
      return false;
    } catch (_) {
      return true;
    }
  }

  /** arquivo inteiro (Estúdio): passa pelo mesmo caminho do tempo real, então soa igual ao que os amigos ouvem.
   *  Entra áudio 16 kHz, sai 48 kHz. */
  async convertWhole(a16, opts = {}) {
    const a48 = new Resampler(16000, SR_IN).process(a16, a16.length * 3);
    const st = new RvcStream(this, opts);
    const pad = HOP48 * 2; // empurra o fim pra fora
    const total = a48.length + pad;
    const out = new Float32Array(Math.ceil(total / HOP48) * HOP48);
    const blk = new Float32Array(HOP48);
    for (let o = 0; o < total; o += HOP48) {
      blk.fill(0);
      if (o < a48.length) blk.set(a48.subarray(o, Math.min(a48.length, o + HOP48)));
      out.set(await st.process(blk), o);
    }
    return { audio: out, tran: st.tran, userF0: st.userF0 };
  }

  /** mediana do tom (Hz) de um áudio 16 kHz — para achar o tom alvo de uma voz */
  async medianF0(a16) {
    const ort = this.ort;
    // sessão separada no processador: tamanho livre sem estragar a velocidade da placa
    this.f0cpu = this.f0cpu || (await ort.InferenceSession.create(this.paths.rmvpe, this.cpuOpt));
    const r = await this.f0cpu.run({
      waveform: new ort.Tensor('float32', a16, [1, a16.length]),
      threshold: new ort.Tensor('float32', new Float32Array([0.3]), [1]),
    });
    const v = Array.from(r.pitchf.data).filter((x) => x > 50);
    if (v.length < 20) return 0;
    v.sort((a, b) => a - b);
    return v[v.length >> 1];
  }
}

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- tempo real ----------
export class RvcStream {
  constructor(engine, { tran = 0, f0Target = 0, userF0 = 0 } = {}) {
    this.engine = engine;
    this.down = new Down3();
    this.win = new Float32Array(WIN16);
    this.tranBase = tran;
    this.f0Target = f0Target;
    this.userF0 = userF0; // tom médio de quem fala (aprende sozinho)
    this.voiced = [];
    this.sr = engine.voice.sr;
    this.hopOut = (HOP16 * this.sr) / 16000;
    this.cf = Math.round(this.sr * 0.02);
    this.search = Math.round(this.sr * 0.012);
    this.sola = null;
    this.up = new Resampler(this.sr, SR_IN);
    this.fadeIn = new Float32Array(this.cf).map((_, i) => Math.sin(((i + 0.5) / this.cf) * Math.PI * 0.5) ** 2);
    this.silentRuns = 0;
  }

  /** semitons a aplicar: se a voz tem tom alvo, ajusta sozinho pro tom de quem fala */
  get tran() {
    if (this.f0Target && this.userF0) {
      return Math.max(-24, Math.min(24, Math.round(12 * Math.log2(this.f0Target / this.userF0))));
    }
    return this.tranBase;
  }

  learnF0(f0) {
    for (let i = f0.length - 17; i < f0.length; i++) if (f0[i] > 60 && f0[i] < 600) this.voiced.push(f0[i]);
    if (this.voiced.length > 600) this.voiced.splice(0, this.voiced.length - 600);
    if (this.voiced.length >= 150) {
      const s = [...this.voiced].sort((a, b) => a - b);
      const med = s[s.length >> 1];
      // só muda com diferença clara (evita o tom ficar pulando)
      if (!this.userF0 || Math.abs(12 * Math.log2(med / this.userF0)) > 1.5) this.userF0 = med;
    }
  }

  /** 8160 amostras a 48 kHz entram, 8160 saem (com ~1 pedaço de atraso) */
  async process(x48) {
    const x16 = this.down.process(x48);
    this.win.copyWithin(0, x16.length);
    this.win.set(x16, WIN16 - x16.length);
    let peak = 0;
    for (let i = 0; i < x16.length; i++) peak = Math.max(peak, Math.abs(x16[i]));
    // silêncio: não gasta a placa; devolve silêncio emendado
    if (peak < 0.003) {
      this.silentRuns++;
      if (this.silentRuns > 2) {
        this.sola = null;
        return new Float32Array(HOP48);
      }
    } else this.silentRuns = 0;
    const { feats, f0, n } = await this.engine.features(this.win);
    this.learnF0(f0);
    const y = await this.engine.runVoice(feats, f0, n, false, this.tran);
    const need = this.hopOut + this.cf + this.search;
    const start = Math.max(0, y.length - need);
    const a = y.subarray(start);
    let off = 0;
    if (this.sola) {
      let best = -Infinity;
      for (let o = 0; o <= this.search; o++) {
        let num = 0;
        let den = 1e-8;
        for (let i = 0; i < this.cf; i++) {
          num += a[o + i] * this.sola[i];
          den += a[o + i] * a[o + i];
        }
        const c = num / Math.sqrt(den);
        if (c > best) {
          best = c;
          off = o;
        }
      }
    }
    const res = Float32Array.from(a.subarray(off, off + this.hopOut));
    if (this.sola) {
      for (let i = 0; i < this.cf; i++) res[i] = res[i] * this.fadeIn[i] + this.sola[i] * (1 - this.fadeIn[i]);
    } else {
      for (let i = 0; i < this.cf; i++) res[i] *= this.fadeIn[i];
    }
    this.sola = Float32Array.from(a.subarray(off + this.hopOut, off + this.hopOut + this.cf));
    return this.up.process(res, HOP48);
  }
}
