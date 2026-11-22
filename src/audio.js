// Áudio: pipeline do microfone (ruído, gate, ganho) e saída (vozes, tela, soundboard)

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
    this.analyser.fftSize = 1024;
    this.gate = this.ctx.createGain();
    this.gate.gain.value = 0;
    this.inGain.connect(this.analyser);
    this.inGain.connect(this.gate);
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
    this.onSpeaking = null;
    this.timer = setInterval(() => this.tick(), 20);
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
    this.src.connect(this.inGain);
    this.applyGain();
  }

  stopRaw() {
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
    const threshold = s.gateEnabled ? s.gateThreshold : -60;
    if (this.db > threshold) this.lastOpen = now;
    const open = s.gateEnabled ? now - this.lastOpen < 280 : true;
    const t = this.ctx.currentTime;
    this.gate.gain.setTargetAtTime(open ? 1 : 0, t, open ? 0.004 : 0.06);
    this.muteGain.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.01);
    const speaking = !this.muted && now - this.lastOpen < 280;
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
