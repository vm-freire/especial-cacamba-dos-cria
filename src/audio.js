// Áudio: pipeline do microfone (ruído, gate, ganho) e saída (vozes, tela, soundboard)

import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';

// RNNoise: rede neural pequena que separa voz de ruído (teclado, mouse, ventilador), inclusive durante a fala
let rnWasm = null;
const rnBinary = () =>
  (rnWasm =
    rnWasm ||
    loadRnnoise({
      url: new URL('./rnnoise/rnnoise.wasm', import.meta.url).href,
      simdUrl: new URL('./rnnoise/rnnoise_simd.wasm', import.meta.url).href,
    }).catch((e) => {
      rnWasm = null;
      throw e;
    }));

const dbFromRms = (rms) => (rms > 0 ? 20 * Math.log10(rms) : -100);

function rmsOf(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export class MicPipeline {
  constructor(settings) {
    this.settings = settings;
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    this.dest = this.ctx.createMediaStreamDestination();
    this.inGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.gate = this.ctx.createGain();
    this.gate.gain.value = 0;
    this.inGain.connect(this.analyser);
    // atraso pequeno no áudio enviado: o filtro decide olhando 40 ms "à frente" e não corta o começo da fala
    this.lookahead = this.ctx.createDelay(0.2);
    this.lookahead.delayTime.value = 0.04;
    this.inGain.connect(this.lookahead);
    this.lookahead.connect(this.gate);
    // mudo separado do gate: o monitor escuta antes do mudo, os amigos escutam depois
    this.muteGain = this.ctx.createGain();
    this.muteGain.gain.value = 1;
    this.gate.connect(this.muteGain);
    this.muteGain.connect(this.dest);
    // "ouvir meu microfone": som já processado (ruído/gate) indo para o alto-falante
    this.monitor = this.ctx.createGain();
    this.monitor.gain.value = 0;
    this.gate.connect(this.monitor);
    this.monitor.connect(this.ctx.destination);
    this.monitoring = false;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.raw = null;
    this.src = null;
    this.muted = false;
    this.db = -100;
    this.speaking = false;
    this.lastOpen = 0;
    this.above = 0;
    this.floor = null;
    this.onSpeaking = null;
    this.timer = setInterval(() => this.tick(), 10);
  }

  /** Track estável enviada aos peers (não muda ao trocar de microfone). */
  get track() {
    return this.dest.stream.getAudioTracks()[0];
  }

  async start() {
    const s = this.settings;
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    const constraints = {
      audio: {
        deviceId: s.inputDevice && s.inputDevice !== 'default' ? { exact: s.inputDevice } : undefined,
        echoCancellation: s.echoCancellation,
        noiseSuppression: s.noiseSuppression,
        autoGainControl: s.autoGainControl,
        channelCount: 1,
        sampleRate: 48000,
        voiceIsolation: s.noiseSuppression,
      },
      video: false,
    };
    let raw;
    try {
      raw = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // o ID do dispositivo mudou (acontece no Windows): procura pelo nome salvo, senão usa o padrão
      delete constraints.audio.deviceId;
      let byLabel = null;
      if (s.inputDeviceLabel) {
        try {
          const devs = await navigator.mediaDevices.enumerateDevices();
          byLabel = devs.find((d) => d.kind === 'audioinput' && d.label === s.inputDeviceLabel);
        } catch (_) {}
      }
      if (byLabel) constraints.audio.deviceId = { exact: byLabel.deviceId };
      raw = await navigator.mediaDevices.getUserMedia(constraints).catch(async () => {
        delete constraints.audio.deviceId;
        return navigator.mediaDevices.getUserMedia(constraints);
      });
      if (byLabel) {
        s.inputDevice = byLabel.deviceId;
        if (this.onDeviceFixed) this.onDeviceFixed(byLabel.deviceId);
      }
    }
    this.deviceLabel = raw.getAudioTracks()[0]?.label || '';
    this.stopRaw();
    this.raw = raw;
    this.src = this.ctx.createMediaStreamSource(raw);
    await this.chain();
    this.applyGain();
  }

  // microfone -> [RNNoise] -> [filtro de voz] -> ganho/gate
  async chain() {
    if (!this.src) return;
    try { this.src.disconnect(); } catch (_) {}
    this.dropNodes();
    let node = this.src;
    this.denoiseOn = false;
    if (this.settings.aiNoise) {
      try {
        const bin = await rnBinary();
        if (!this.workletReady) {
          await this.ctx.audioWorklet.addModule(new URL('./rnnoise/workletProcessor.js', import.meta.url).href);
          this.workletReady = true;
        }
        if (!this.src) return;
        this.denoise = new RnnoiseWorkletNode(this.ctx, { maxChannels: 1, wasmBinary: bin });
        node.connect(this.denoise);
        node = this.denoise;
        this.denoiseOn = true;
      } catch (e) {
        console.warn('rnnoise', e);
      }
    }
    if (this.settings.voiceFilter === 'autotune') {
      try {
        this.filter = await this.makeAutotune();
        if (!this.src) return;
        node.connect(this.filter.input);
        node = this.filter.output;
      } catch (e) {
        console.warn('autotune', e);
        this.filter = null;
      }
    }
    node.connect(this.inGain);
  }

  dropNodes() {
    if (this.denoise) {
      try { this.denoise.disconnect(); this.denoise.destroy(); } catch (_) {}
      this.denoise = null;
    }
    if (this.filter) {
      for (const n of this.filter.nodes) try { n.disconnect(); } catch (_) {}
      this.filter = null;
    }
  }

  // "Autotune": o padrão do Autotune Igão (estilo trap) — motor + brilho, saturação, reverb e delay
  async makeAutotune() {
    const ctx = this.ctx;
    if (!this.autotuneReady) {
      await ctx.audioWorklet.addModule(new URL('./autotune/autotune-processor.js', import.meta.url).href);
      this.autotuneReady = true;
    }
    const motor = new AudioWorkletNode(ctx, 'autotune-igao', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        // os ajustes que o Igão usa no app dele: trap pesado, +1 semitom, ganho +10 dB, volume +12 dB, redução 100%
        params: { ativo: true, tom: 0, escala: 'menor', velocidade: 0, intensidade: 1, transpor: 1, voz: 'media', ganhoEntrada: 3.1623, volume: 3.9811, reducaoRuido: 1 },
      },
    });
    const graves = ctx.createBiquadFilter();
    graves.type = 'highpass';
    graves.frequency.value = 90;
    const brilho = ctx.createBiquadFilter();
    brilho.type = 'highshelf';
    brilho.frequency.value = 3500;
    brilho.gain.value = 5;
    const sat = ctx.createWaveShaper();
    const curva = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curva[i] = Math.tanh(1.6 * x) / Math.tanh(1.6);
    }
    sat.curve = curva;
    const mix = ctx.createGain();
    motor.connect(graves).connect(brilho).connect(sat).connect(mix);
    // reverb 25%
    const envioReverb = ctx.createGain();
    envioReverb.gain.value = 0.25 * 0.7;
    const conv = ctx.createConvolver();
    const sr = ctx.sampleRate;
    const n = Math.round(sr * 1.8);
    const pre = Math.round(sr * 0.02);
    const ir = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / sr;
        lp += (Math.random() * 2 - 1 - lp) * (0.35 - 0.25 * (t / 1.8));
        d[i] = lp * Math.exp(-3.2 * t);
      }
    }
    conv.buffer = ir;
    sat.connect(envioReverb).connect(conv).connect(mix);
    // delay 20% (240 ms, com repetição)
    const envioDelay = ctx.createGain();
    envioDelay.gain.value = 0.2 * 0.55;
    const atraso = ctx.createDelay(1);
    atraso.delayTime.value = 0.24;
    const escuro = ctx.createBiquadFilter();
    escuro.type = 'lowpass';
    escuro.frequency.value = 3200;
    const volta = ctx.createGain();
    volta.gain.value = 0.35;
    sat.connect(envioDelay).connect(atraso).connect(escuro);
    escuro.connect(volta).connect(atraso);
    escuro.connect(mix);
    // limitador no fim: com o ganho alto do Igão, reverb + delay somados passariam de 0 dB e estourariam
    const nivel = ctx.createGain();
    nivel.gain.value = 0.8;
    const limite = ctx.createDynamicsCompressor();
    limite.threshold.value = -4;
    limite.knee.value = 2;
    limite.ratio.value = 20;
    limite.attack.value = 0.002;
    limite.release.value = 0.12;
    mix.connect(nivel).connect(limite);
    return { input: motor, output: limite, nodes: [motor, graves, brilho, sat, mix, envioReverb, conv, envioDelay, atraso, escuro, volta, nivel, limite] };
  }

  stopRaw() {
    this.dropNodes();
    if (this.src) {
      try { this.src.disconnect(); } catch (_) {}
      this.src = null;
    }
    if (this.raw) {
      this.raw.getTracks().forEach((t) => t.stop());
      this.raw = null;
    }
  }

  async update(settings) {
    const prev = this.settings;
    this.settings = settings;
    const restart =
      prev.inputDevice !== settings.inputDevice ||
      prev.echoCancellation !== settings.echoCancellation ||
      prev.noiseSuppression !== settings.noiseSuppression ||
      prev.autoGainControl !== settings.autoGainControl;
    if (restart && this.raw) await this.start();
    else if (prev.aiNoise !== settings.aiNoise || prev.voiceFilter !== settings.voiceFilter) await this.chain();
    this.applyGain();
  }

  applyGain() {
    this.inGain.gain.setTargetAtTime(this.settings.inputVolume / 100, this.ctx.currentTime, 0.02);
  }

  setMuted(m) {
    this.muted = m;
  }

  async setMonitor(on, sinkId) {
    this.monitoring = on;
    if (on && this.ctx.setSinkId) {
      try {
        await this.ctx.setSinkId(sinkId && sinkId !== 'default' ? sinkId : '');
      } catch (_) {}
    }
    this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  tick() {
    if (!this.src) return;
    const s = this.settings;
    this.db = dbFromRms(rmsOf(this.analyser, this.buf));
    const now = performance.now();
    // nível do ruído do ambiente: desce rápido, sobe devagar (a fala tem pausas, então ele não "aprende" a voz)
    if (this.floor == null || this.db < this.floor) this.floor = this.floor == null ? this.db : this.floor * 0.6 + this.db * 0.4;
    else this.floor = Math.min(-35, this.floor + 0.02);
    // filtro automático: liga junto com a supressão inteligente (se o manual estiver desligado)
    const auto = s.aiNoise && !s.gateEnabled;
    const gateOn = s.gateEnabled || auto;
    const threshold = s.gateEnabled ? s.gateThreshold : auto ? Math.max(-50, Math.min(-32, this.floor + 12)) : -60;
    this.autoThreshold = threshold;
    // voz é contínua; tecla/clique é um estalo curto: só abre com 40 ms seguidos acima do limite
    this.above = this.db > threshold ? this.above + 1 : 0;
    if (this.above >= (gateOn ? 4 : 1)) this.lastOpen = now;
    // com filtro de voz o fim do reverb/delay precisa passar, então o portão demora mais pra fechar
    const open = gateOn ? now - this.lastOpen < (this.filter ? 900 : 320) : true;
    const t = this.ctx.currentTime;
    this.gate.gain.setTargetAtTime(open ? 1 : 0, t, open ? 0.004 : 0.06);
    this.muteGain.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.01);
    const speaking = !this.muted && now - this.lastOpen < 320;
    if (speaking !== this.speaking) {
      this.speaking = speaking;
      if (this.onSpeaking) this.onSpeaking(speaking);
    }
  }

  /** nível 0..1 para o medidor */
  get level() {
    return Math.min(1, Math.max(0, (this.db + 80) / 80));
  }

  destroy() {
    clearInterval(this.timer);
    this.stopRaw();
    this.ctx.close().catch(() => {});
  }
}

/** Saída: tudo passa por um AudioContext com setSinkId (alto-falante escolhido). */
export class OutputMixer {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.sfx = this.ctx.createGain();
    this.sfx.connect(this.master);
    this.voices = new Map(); // key -> {el, src, gain, analyser}
    this.buf = new Float32Array(512);
    this.deafened = false;
    this.volume = 1;
    this.activeSounds = new Set();
  }

  async resume() {
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
  }

  async setSink(deviceId) {
    try {
      if (this.ctx.setSinkId) await this.ctx.setSinkId(deviceId && deviceId !== 'default' ? deviceId : '');
    } catch (e) {
      console.warn('setSinkId falhou', e);
    }
  }

  setVolume(v) {
    this.volume = v / 100;
    this.applyMaster();
  }

  setSfxVolume(v) {
    this.sfx.gain.setTargetAtTime(v / 100, this.ctx.currentTime, 0.02);
  }

  setDeafened(d) {
    this.deafened = d;
    this.applyMaster();
  }

  applyMaster() {
    this.master.gain.setTargetAtTime(this.deafened ? 0 : this.volume, this.ctx.currentTime, 0.02);
  }

  /** Adiciona uma track remota (voz ou áudio de tela). */
  addTrack(key, track, volume = 100) {
    this.removeTrack(key);
    const stream = new MediaStream([track]);
    // Bug do Chromium: stream remoto precisa estar num elemento para o WebAudio receber dados
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    el.play().catch(() => {});
    const src = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    gain.gain.value = volume / 100;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    src.connect(gain);
    gain.connect(this.master);
    this.voices.set(key, { el, src, gain, analyser });
  }

  setVolumeWhere(test, volume) {
    for (const k of this.voices.keys()) if (test(k)) this.setTrackVolume(k, volume);
  }

  setTrackVolume(key, volume) {
    const v = this.voices.get(key);
    if (v) v.gain.gain.setTargetAtTime(volume / 100, this.ctx.currentTime, 0.02);
  }

  level(key) {
    const v = this.voices.get(key);
    if (!v) return -100;
    return dbFromRms(rmsOf(v.analyser, this.buf));
  }

  removeTrack(key) {
    const v = this.voices.get(key);
    if (!v) return;
    try { v.src.disconnect(); v.gain.disconnect(); } catch (_) {}
    v.el.srcObject = null;
    this.voices.delete(key);
  }

  removeAll() {
    for (const k of [...this.voices.keys()]) this.removeTrack(k);
  }

  // start/end em segundos: toca só o pedaço escolhido no corte do som
  playBuffer(buffer, volume = 100, start = 0, end = null) {
    this.resume();
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = volume / 100;
    node.connect(g);
    g.connect(this.sfx);
    const s0 = Math.max(0, Math.min(start || 0, buffer.duration - 0.05));
    const e0 = end && end > s0 ? Math.min(end, buffer.duration) : buffer.duration;
    node.start(0, s0, e0 - s0);
    this.activeSounds.add(node);
    node.onended = () => this.activeSounds.delete(node);
  }

  stopSounds() {
    for (const n of this.activeSounds) {
      try { n.stop(); } catch (_) {}
    }
    this.activeSounds.clear();
  }

  decode(arrayBuffer) {
    return this.ctx.decodeAudioData(arrayBuffer);
  }
}
