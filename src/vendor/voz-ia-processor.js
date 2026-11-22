// Ponte de áudio das vozes com IA.
// Entrada: junta o microfone em pedaços de 8160 amostras (170 ms a 48 kHz) e manda pra thread principal.
// Saída: toca a voz convertida que volta, com uma folguinha pra não engasgar.
class VozIaProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.hop = (opts.processorOptions && opts.processorOptions.hop) || 8160;
    this.acc = new Float32Array(this.hop);
    this.accN = 0;
    this.fila = []; // pedaços convertidos
    this.cur = null;
    this.pos = 0;
    this.tocando = false;
    this.folga = Math.round(sampleRate * 0.04); // espera 40 ms além de 1 pedaço antes de começar
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.reset) {
        this.fila = [];
        this.cur = null;
        this.tocando = false;
        return;
      }
      if (d instanceof Float32Array) {
        this.fila.push(d);
        if (this.fila.length > 4) this.fila.splice(0, this.fila.length - 2); // atraso acumulado: pula pra frente
      }
    };
  }
  disponivel() {
    let n = this.cur ? this.cur.length - this.pos : 0;
    for (const f of this.fila) n += f.length;
    return n;
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    const n = out.length;
    if (inp) {
      let i = 0;
      while (i < inp.length) {
        const k = Math.min(inp.length - i, this.hop - this.accN);
        this.acc.set(inp.subarray(i, i + k), this.accN);
        this.accN += k;
        i += k;
        if (this.accN === this.hop) {
          this.port.postMessage(this.acc, [this.acc.buffer]);
          this.acc = new Float32Array(this.hop);
          this.accN = 0;
        }
      }
    }
    if (!this.tocando && this.disponivel() >= this.hop + this.folga) this.tocando = true;
    for (let i = 0; i < n; i++) {
      if (!this.tocando) {
        out[i] = 0;
        continue;
      }
      if (!this.cur || this.pos >= this.cur.length) {
        this.cur = this.fila.shift() || null;
        this.pos = 0;
        if (!this.cur) {
          // acabou (engasgou): silêncio até juntar de novo
          this.tocando = false;
          out[i] = 0;
          continue;
        }
      }
      out[i] = this.cur[this.pos++];
    }
    return true;
  }
}
registerProcessor('voz-ia', VozIaProcessor);
