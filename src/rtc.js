// WebRTC em malha (cada um conecta direto com cada um — sem servidor de mídia no meio)
// Transceivers fixos: [0] voz, [1] vídeo da tela, [2] áudio da tela.
// Começar/parar a transmissão é só replaceTrack -> instantâneo, sem renegociar.

const ROLES = ['mic', 'screen-video', 'screen-audio'];

export const SCREEN_PRESETS = {
  '720p30': { label: '720p • 30 FPS', w: 1280, h: 720, fps: 30, bitrate: 2_500_000 },
  '1080p30': { label: '1080p • 30 FPS', w: 1920, h: 1080, fps: 30, bitrate: 4_500_000 },
  '1080p60': { label: '1080p • 60 FPS', w: 1920, h: 1080, fps: 60, bitrate: 8_000_000 },
  '1440p60': { label: '1440p • 60 FPS', w: 2560, h: 1440, fps: 60, bitrate: 12_000_000 },
  source: { label: 'Resolução nativa • 60 FPS', w: 3840, h: 2160, fps: 60, bitrate: 16_000_000 },
};

function preferCodec(transceiver, codec) {
  try {
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps || !transceiver.setCodecPreferences) return;
    const want = caps.codecs.filter((c) => c.mimeType.toLowerCase() === `video/${codec}`);
    if (!want.length) return;
    // H.264: prefere perfil high/constrained-baseline com packetization-mode=1
    want.sort((a, b) => {
      const pa = /packetization-mode=1/.test(a.sdpFmtpLine || '') ? 0 : 1;
      const pb = /packetization-mode=1/.test(b.sdpFmtpLine || '') ? 0 : 1;
      return pa - pb;
    });
    const rest = caps.codecs.filter((c) => !want.includes(c));
    transceiver.setCodecPreferences([...want, ...rest]);
  } catch (e) {
    console.warn('codec pref', e);
  }
}

// Opus em alta qualidade: estéreo off, FEC on, DTX off, 64 kbps
function tuneOpus(sdp) {
  return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (line, pt, params) => {
    if (/maxaveragebitrate/.test(params)) return line;
    return `a=fmtp:${pt} ${params};maxaveragebitrate=96000;usedtx=0`;
  });
}

class Peer {
  constructor(mesh, sid) {
    this.mesh = mesh;
    this.sid = sid;
    this.initiator = mesh.mySid < sid;
    this.pendingIce = [];
    this.tx = null;
    this.closed = false;
    this.disconnectTimer = null;

    const pc = new RTCPeerConnection({
      iceServers: mesh.iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    this.pc = pc;

    this.dc = pc.createDataChannel('ctl', { negotiated: true, id: 0 });
    this.dc.onmessage = (e) => {
      try {
        mesh.onData(sid, JSON.parse(e.data));
      } catch (_) {}
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) mesh.signal(sid, { type: 'ice', candidate: e.candidate.toJSON() });
    };

    pc.ontrack = (e) => {
      const idx = pc.getTransceivers().indexOf(e.transceiver);
      const role = ROLES[idx];
      if (role) mesh.onTrack(sid, role, e.track);
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      mesh.onState(sid, st);
      clearTimeout(this.disconnectTimer);
      if (st === 'connected') this.applyScreenParams();
      if (st === 'failed') this.restart();
      if (st === 'disconnected') this.disconnectTimer = setTimeout(() => this.restart(), 4000);
    };

    pc.onnegotiationneeded = async () => {
      if (!this.initiator || this.closed) return;
      try {
        await this.makeOffer();
      } catch (e) {
        console.error('offer', e);
      }
    };

    if (this.initiator) {
      this.tx = [
        pc.addTransceiver('audio', { direction: 'sendrecv' }),
        pc.addTransceiver('video', { direction: 'sendrecv' }),
        pc.addTransceiver('audio', { direction: 'sendrecv' }),
      ];
      this.attachLocal();
    }
  }

  async makeOffer(iceRestart = false) {
    const offer = await this.pc.createOffer({ iceRestart });
    offer.sdp = tuneOpus(offer.sdp);
    await this.pc.setLocalDescription(offer);
    this.mesh.signal(this.sid, { type: 'sdp', sdp: this.pc.localDescription.toJSON() });
    // se a resposta não vier (o outro ainda não estava ouvindo), reenvia
    clearTimeout(this.offerTimer);
    let tries = 0;
    const resend = () => {
      if (this.closed || this.pc.signalingState !== 'have-local-offer' || tries++ > 5) return;
      this.mesh.signal(this.sid, { type: 'sdp', sdp: this.pc.localDescription.toJSON() });
      this.offerTimer = setTimeout(resend, 5000);
    };
    this.offerTimer = setTimeout(resend, 5000);
  }

  attachLocal() {
    if (!this.tx) return;
    const m = this.mesh;
    preferCodec(this.tx[1], m.codec);
    this.tx[0].sender.replaceTrack(m.micTrack || null);
    this.tx[1].sender.replaceTrack(m.screenVideo || null);
    this.tx[2].sender.replaceTrack(m.screenAudio || null);
  }

  async handle(data) {
    const pc = this.pc;
    if (data.type === 'sdp') {
      const desc = data.sdp;
      if (desc.type === 'offer') {
        if (this.initiator) return; // nunca deveria acontecer
        await pc.setRemoteDescription(desc);
        if (!this.tx) {
          this.tx = pc.getTransceivers().slice(0, 3);
          this.tx.forEach((t) => (t.direction = 'sendrecv'));
          this.attachLocal();
        }
        const answer = await pc.createAnswer();
        answer.sdp = tuneOpus(answer.sdp);
        await pc.setLocalDescription(answer);
        this.mesh.signal(this.sid, { type: 'sdp', sdp: pc.localDescription.toJSON() });
      } else if (desc.type === 'answer') {
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription(desc);
      }
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      this.applyScreenParams();
      this.applyMicParams();
    } else if (data.type === 'ice') {
      if (!pc.remoteDescription) this.pendingIce.push(data.candidate);
      else await pc.addIceCandidate(data.candidate).catch(() => {});
    } else if (data.type === 'restart') {
      this.restart();
    }
  }

  restart() {
    if (this.closed) return;
    if (this.initiator) {
      this.makeOffer(true).catch((e) => console.error('ice restart', e));
    } else {
      this.mesh.signal(this.sid, { type: 'restart' });
    }
  }

  async applyMicParams() {
    if (!this.tx) return;
    try {
      const s = this.tx[0].sender;
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) return;
      p.encodings[0].maxBitrate = 96000;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      await s.setParameters(p);
    } catch (_) {}
  }

  async applyScreenParams() {
    if (!this.tx || !this.mesh.screenVideo) return;
    const opts = this.mesh.screenOpts;
    try {
      const s = this.tx[1].sender;
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) return;
      p.encodings[0].maxBitrate = opts.bitrate;
      p.encodings[0].maxFramerate = opts.fps;
      p.encodings[0].scaleResolutionDownBy = 1;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      p.degradationPreference = opts.mode === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
      await s.setParameters(p);
    } catch (e) {
      console.warn('screen params', e);
    }
  }

  send(obj) {
    if (this.dc.readyState === 'open') this.dc.send(JSON.stringify(obj));
  }

  async stats() {
    const out = { rtt: null, outKbps: 0, inKbps: 0, codec: null, fps: null, res: null };
    try {
      const report = await this.pc.getStats();
      report.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) out.rtt = r.currentRoundTripTime;
      });
    } catch (_) {}
    return out;
  }

  close() {
    this.closed = true;
    clearTimeout(this.disconnectTimer);
    clearTimeout(this.offerTimer);
    try { this.dc.close(); } catch (_) {}
    try { this.pc.close(); } catch (_) {}
  }
}

export class Mesh {
  constructor({ mySid, iceServers, codec, micTrack, signal, onTrack, onData, onState, onPeerGone }) {
    this.mySid = mySid;
    this.iceServers = iceServers;
    this.codec = codec || 'h264';
    this.micTrack = micTrack;
    this.signal = signal;
    this.onTrack = onTrack;
    this.onData = onData;
    this.onState = onState;
    this.onPeerGone = onPeerGone;
    this.peers = new Map();
    this.screenVideo = null;
    this.screenAudio = null;
    this.screenOpts = SCREEN_PRESETS['1080p60'];
  }

  /** Sincroniza com a lista de participantes da sala. */
  sync(sids) {
    const want = new Set(sids.filter((s) => s !== this.mySid));
    for (const sid of want) if (!this.peers.has(sid)) this.peers.set(sid, new Peer(this, sid));
    for (const sid of [...this.peers.keys()]) {
      if (!want.has(sid)) this.remove(sid);
    }
  }

  remove(sid) {
    const p = this.peers.get(sid);
    if (!p) return;
    p.close();
    this.peers.delete(sid);
    this.onPeerGone(sid);
  }

  async handleSignal(from, data) {
    let p = this.peers.get(from);
    if (!p) {
      // oferta chegou antes da presença: cria o peer na hora
      if (data.type !== 'sdp' || data.sdp.type !== 'offer') return;
      p = new Peer(this, from);
      this.peers.set(from, p);
    }
    try {
      await p.handle(data);
    } catch (e) {
      console.error('signal', e);
    }
  }

  setMicTrack(track) {
    this.micTrack = track;
    for (const p of this.peers.values()) if (p.tx) p.tx[0].sender.replaceTrack(track);
  }

  async setScreen(stream, opts) {
    this.screenVideo = stream ? stream.getVideoTracks()[0] || null : null;
    this.screenAudio = stream ? stream.getAudioTracks()[0] || null : null;
    if (opts) this.screenOpts = opts;
    for (const p of this.peers.values()) {
      if (!p.tx) continue;
      await p.tx[1].sender.replaceTrack(this.screenVideo).catch(() => {});
      await p.tx[2].sender.replaceTrack(this.screenAudio).catch(() => {});
      p.applyScreenParams();
    }
  }

  broadcast(obj) {
    for (const p of this.peers.values()) p.send(obj);
  }

  async rtt(sid) {
    const p = this.peers.get(sid);
    if (!p) return null;
    return (await p.stats()).rtt;
  }

  closeAll() {
    for (const sid of [...this.peers.keys()]) this.remove(sid);
  }
}
