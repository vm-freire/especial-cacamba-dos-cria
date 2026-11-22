// Sons da interface, sintetizados na hora (sem arquivos): mute, entrar, sair, tela...
// Timbre de "sino macio": senoide + harmônico leve, ataque rápido, cauda curta com eco.

export class Sfx {
  constructor(mixer) {
    this.mixer = mixer;
    const ctx = mixer.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.55;
    // eco curtinho para dar corpo
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.09;
    const fb = ctx.createGain();
    fb.gain.value = 0.18;
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    this.bus.connect(mixer.master);
    this.bus.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(mixer.master);
    this.enabled = true;
  }

  note(freq, start, dur = 0.16, vol = 0.22, type = 'sine', bend = 0) {
    const ctx = this.mixer.ctx;
    const t = ctx.currentTime + start;
    const mk = (mult, gainMul, wave) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = wave;
      o.frequency.setValueAtTime(freq * mult, t);
      if (bend) o.frequency.exponentialRampToValueAtTime(freq * mult * bend, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol * gainMul, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(this.bus);
      o.start(t);
      o.stop(t + dur + 0.05);
    };
    mk(1, 1, type);
    mk(2, 0.18, 'sine');
    mk(3, 0.05, 'sine');
  }

  play(name) {
    if (!this.enabled) return;
    this.mixer.resume();
    const n = (f, s, d, v, ty, b) => this.note(f, s, d, v, ty, b);
    switch (name) {
      case 'join-self': // você entrou: três notas subindo
        n(523.25, 0, 0.18); n(659.25, 0.08, 0.18); n(987.77, 0.16, 0.32);
        break;
      case 'leave-self': // você saiu: três notas descendo
        n(783.99, 0, 0.18); n(587.33, 0.08, 0.18); n(392.0, 0.16, 0.32);
        break;
      case 'join': // alguém entrou
        n(659.25, 0, 0.16, 0.18); n(880.0, 0.09, 0.26, 0.18);
        break;
      case 'leave': // alguém saiu
        n(880.0, 0, 0.16, 0.18); n(587.33, 0.09, 0.26, 0.18);
        break;
      case 'mute':
        n(622.25, 0, 0.09, 0.2, 'triangle'); n(415.3, 0.06, 0.14, 0.2, 'triangle');
        break;
      case 'unmute':
        n(415.3, 0, 0.09, 0.2, 'triangle'); n(622.25, 0.06, 0.14, 0.2, 'triangle');
        break;
      case 'deafen':
        n(523.25, 0, 0.1, 0.2, 'triangle'); n(392.0, 0.06, 0.1, 0.2, 'triangle'); n(261.63, 0.12, 0.2, 0.2, 'triangle');
        break;
      case 'undeafen':
        n(261.63, 0, 0.1, 0.2, 'triangle'); n(392.0, 0.06, 0.1, 0.2, 'triangle'); n(523.25, 0.12, 0.2, 0.2, 'triangle');
        break;
      case 'share-start':
        n(587.33, 0, 0.12, 0.18); n(880.0, 0.07, 0.12, 0.18); n(1174.66, 0.14, 0.3, 0.16);
        break;
      case 'share-stop':
        n(1174.66, 0, 0.12, 0.16); n(880.0, 0.07, 0.12, 0.18); n(587.33, 0.14, 0.3, 0.18);
        break;
      case 'notify': // convite / aviso
        n(987.77, 0, 0.12, 0.16); n(1318.51, 0.1, 0.35, 0.14);
        break;
      case 'error':
        n(220, 0, 0.18, 0.2, 'square', 0.8);
        break;
    }
  }
}
