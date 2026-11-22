// Especial Caçamba dos Cria — interface
import * as B from './backend.js';
import { MicPipeline, OutputMixer } from './audio.js';
import { Mesh, SCREEN_PRESETS } from './rtc.js';
import { icon } from './icons.js';
import { Sfx } from './sfx.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const bridge = window.cacamba || {
  getSources: async () => [],
  selectSource: async () => {},
  version: async () => 'dev',
  openExternal: async (u) => window.open(u),
  installUpdate: async () => {},
  checkUpdate: async () => ({ ok: false }),
  onShortcut: () => {},
  onUpdate: () => {},
  platform: 'web',
};
const root = $('#root');
const modalRoot = $('#modal-root');

// ---------------------------------------------------------------- configurações
const DEFAULTS = {
  inputDevice: 'default',
  outputDevice: 'default',
  inputVolume: 100,
  outputVolume: 100,
  sfxVolume: 70,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  gateEnabled: true,
  gateThreshold: -50,
  quality: '1080p60',
  mode: 'motion',
  shareAudio: false,
  codec: 'h264',
  uiSounds: true,
  userVolumes: {},
  screenVolumes: {},
  turnUrl: '',
  turnUser: '',
  turnPass: '',
};
let S = { ...DEFAULTS };
try {
  S = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('cacamba.settings') || '{}') };
} catch (_) {}
const saveSettings = () => {
  try {
    localStorage.setItem('cacamba.settings', JSON.stringify(S));
  } catch (_) {}
};

// ---------------------------------------------------------------- estado
const st = {
  user: null,
  me: null,
  members: new Map(),
  rooms: [],
  servers: [],
  view: localStorage.getItem('cacamba.view') || 'home',
  homeTab: 'online',
  notifications: [],
  roomServerId: null,
  roomName: '',
  roomsUnsub: null,
  presence: [],
  sounds: [],
  sid: crypto.randomUUID(),
  presenceObj: null,
  roomId: null,
  muted: false,
  deafened: false,
  sharing: false,
  screenStream: null,
  remote: new Map(), // sid -> { mic, screenVideo, screenAudio }
  conn: {},
  ping: {},
  speaking: new Set(),
  lastSpeak: new Map(),
  focus: null,
  showSB: true,
  update: null,
  unsubs: [],
  prevRoomSids: new Set(),
};
let mic = null;
let mesh = null;
const out = new OutputMixer();
out.setVolume(S.outputVolume);
out.setSfxVolume(S.sfxVolume);
out.setSink(S.outputDevice);
const sfx = new Sfx(out);
const soundCache = new Map();
let registering = false;
let lastSfx = 0;

// ---------------------------------------------------------------- helpers de UI
function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

const initials = (name) => (name || '?').trim().charAt(0).toUpperCase();
function avatar(name, color, speakKey = '', extra = '') {
  const sp = speakKey && st.speaking.has(speakKey) ? ' speaking' : '';
  return `<div class="avatar${sp} ${extra}" ${speakKey ? `data-speak="${speakKey}"` : ''} style="background:${esc(color || '#f0b232')}">${esc(initials(name))}</div>`;
}

function blip(kind) {
  if (!S.uiSounds) return;
  sfx.play(kind);
}

function closeModal() {
  modalRoot.innerHTML = '';
  if (meterRaf) cancelAnimationFrame(meterRaf);
  meterRaf = null;
}
function openModal(html, { wide = false, raw = false } = {}) {
  closeModal();
  modalRoot.innerHTML = `<div class="overlay" data-act="overlay">${raw ? html : `<div class="modal${wide ? ' wide' : ''}">${html}</div>`}</div>`;
  return modalRoot.firstElementChild;
}

let ctxEl = null;
function closeCtx() {
  if (ctxEl) ctxEl.remove();
  ctxEl = null;
}
function openCtx(x, y, html) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  ctxEl.innerHTML = html;
  document.body.appendChild(ctxEl);
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  ctxEl.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  return ctxEl;
}
document.addEventListener('mousedown', (e) => {
  if (ctxEl && !ctxEl.contains(e.target)) closeCtx();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeCtx();
    if (modalRoot.innerHTML) {
      closeModal();
      onSettingsClosed();
    }
    else if (st.focus) {
      st.focus = null;
      renderStage();
    }
  }
});

// ---------------------------------------------------------------- autenticação
let authTab = 'login';
function authShell(inner) {
  return `<div class="auth">
    <div class="auth-photo" style="background-image:url('grupo.jpg')"><div class="auth-photo-text"><b>Os cria</b><span>Voz, tela e zoeira sem travar.</span></div></div>
    <div class="auth-side"><div class="auth-card">${inner}</div></div>
  </div>`;
}
function renderAuth(error = '') {
  const reg = authTab === 'register';
  root.innerHTML = authShell(`
    <div class="brand"><div class="brand-mark"><span>CC</span></div>
      <div><h1>Especial Caçamba<br/>dos Cria</h1><p>Voz, tela e zoeira. Só pros cria.</p></div></div>
    <div class="tabs">
      <button data-act="auth-tab" data-tab="login" class="${reg ? '' : 'on'}">Entrar</button>
      <button data-act="auth-tab" data-tab="register" class="${reg ? 'on' : ''}">Criar conta</button>
    </div>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form id="auth-form">
      ${reg ? `<div class="field"><label>Apelido</label><input type="text" name="name" maxlength="32" required autocomplete="nickname"/></div>` : ''}
      <div class="field"><label>E-mail</label><input type="email" name="email" required autocomplete="email"/></div>
      <div class="field"><label>Senha</label><input type="password" name="password" minlength="6" required autocomplete="${reg ? 'new-password' : 'current-password'}"/></div>
      <button class="btn primary" type="submit">${reg ? 'Criar conta e entrar' : 'Entrar'}</button>
    </form>`);
  const f = $('#auth-form');
  f.querySelector('input').focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const btn = f.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Carregando...';
    try {
      if (reg) {
        registering = true;
        await B.register(d);
        registering = false;
        await afterLogin();
      } else {
        await B.login(d.email, d.password);
      }
    } catch (err) {
      registering = false;
      renderAuth(B.friendlyError(err));
    }
  });
}

function renderProfile(error = '') {
  root.innerHTML = authShell(`
    <div class="brand"><div class="brand-mark"><span>CC</span></div>
      <div><h1>Quase lá</h1><p>Escolhe como a galera vai te ver.</p></div></div>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form id="inv-form">
      <div class="field"><label>Apelido</label><input type="text" name="name" maxlength="32" required value="${esc(st.user.displayName || '')}"/></div>
      <button class="btn primary" type="submit">Entrar</button>
      <button class="btn ghost" type="button" data-act="logout" style="width:100%;margin-top:8px">Sair da conta</button>
    </form>`);
  $('#inv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    try {
      await B.completeProfile(st.user, d.name);
      await afterLogin();
    } catch (err) {
      renderProfile(B.friendlyError(err));
    }
  });
}

B.onAuth(async (user) => {
  st.user = user;
  if (registering) return;
  if (!user) {
    await teardown();
    renderAuth();
    return;
  }
  await afterLogin();
});

async function afterLogin() {
  root.innerHTML = `<div class="empty"><div><div class="brand-mark"><span>CC</span></div><h3>Abrindo a caçamba...</h3></div></div>`;
  let me = null;
  try {
    me = await B.getMember(st.user.uid);
  } catch (e) {
    console.error(e);
  }
  if (!me) return renderProfile();
  st.me = me;
  await startSession();
}

async function startSession() {
  st.unsubs.forEach((u) => u());
  st.unsubs = [
    B.watchMembers((m) => {
      st.members = m;
      const mine = m.get(st.user.uid);
      if (mine) st.me = mine;
      renderSidebar();
      renderStage();
    }),
    B.watchMyServers(st.user.uid, (servers) => {
      st.servers = servers;
      if (st.view !== 'home' && !servers.find((x) => x.id === st.view)) setView('home');
      renderRail();
      renderSidebar();
      renderHead();
      renderStage();
    }),
    B.watchNotifications(st.user.uid, (list, added) => {
      st.notifications = list;
      for (const n of added) {
        blip('notify');
        toast(n.type === 'server-invite' ? `${n.fromName} te chamou pro servidor ${n.serverName}` : `${n.fromName} te adicionou como amigo`);
      }
      renderRail();
      if (st.view === 'home') {
        renderSidebar();
        renderStage();
      }
    }),
    B.watchPresence(onPresence),
    B.watchSounds((s) => {
      st.sounds = s;
      renderSoundboard();
      s.forEach((x) => loadSound(x.id).catch(() => {}));
    }),
    B.watchSignals(st.sid, (from, data) => {
      if (mesh) mesh.handleSignal(from, data);
    }),
  ];
  st.presenceObj = new B.Presence(st.sid, st.user.uid);
  await st.presenceObj.start(presenceState());
  setView(st.view, true);
  renderMain();
}

function setView(view, silent = false) {
  st.view = view;
  try {
    localStorage.setItem('cacamba.view', view);
  } catch (_) {}
  if (st.roomsUnsub) st.roomsUnsub();
  st.roomsUnsub = null;
  st.rooms = [];
  if (view !== 'home') {
    st.roomsUnsub = B.watchRooms(view, (rooms) => {
      st.rooms = rooms;
      renderSidebar();
      renderHead();
      renderStage();
    });
  }
  if (!silent) {
    st.focus = null;
    renderMain();
  }
}

const currentServer = () => st.servers.find((x) => x.id === st.view) || null;
const inCallHere = () => st.roomId && st.roomServerId === st.view;

function presenceState() {
  return {
    name: st.me.name,
    color: st.me.color,
    roomId: st.roomId,
    serverId: st.roomServerId,
    muted: st.muted || st.deafened,
    deafened: st.deafened,
    sharing: st.sharing,
  };
}

async function teardown() {
  await leaveRoom(true);
  st.unsubs.forEach((u) => u());
  st.unsubs = [];
  if (st.roomsUnsub) st.roomsUnsub();
  st.roomsUnsub = null;
  if (st.presenceObj) await st.presenceObj.stop();
  st.presenceObj = null;
  st.me = null;
}

window.addEventListener('beforeunload', () => {
  if (st.presenceObj) st.presenceObj.stop();
});

// ---------------------------------------------------------------- presença / sala
function onPresence(list) {
  st.presence = list;
  if (st.roomId && mesh) {
    const inRoom = list.filter((p) => p.roomId === st.roomId);
    const sids = new Set(inRoom.map((p) => p.sid));
    mesh.sync([...sids]);
    // sons de entrar/sair
    for (const sid of sids) if (!st.prevRoomSids.has(sid) && sid !== st.sid && st.prevRoomSids.size) blip('join');
    for (const sid of st.prevRoomSids) if (!sids.has(sid) && sid !== st.sid) blip('leave');
    st.prevRoomSids = sids;
  }
  renderSidebar();
  renderStage();
  renderHead();
}

const presenceOf = (sid) => st.presence.find((p) => p.sid === sid);
const roomMembers = (roomId) => st.presence.filter((p) => p.roomId === roomId);

function iceServers() {
  const list = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  if (S.turnUrl.trim()) {
    list.push({
      urls: S.turnUrl.split(',').map((s) => s.trim()).filter(Boolean),
      username: S.turnUser,
      credential: S.turnPass,
    });
  }
  return list;
}

async function ensureMic() {
  if (mic) return mic;
  try {
    mic = new MicPipeline(S);
    await mic.start();
    mic.setMuted(st.muted || st.deafened);
    return mic;
  } catch (e) {
    console.error(e);
    toast('Não consegui abrir o microfone. Confere nas Configurações.', true);
    if (mic) mic.destroy();
    mic = null;
    return null;
  }
}

async function joinRoom(roomId) {
  if (st.roomId === roomId) return;
  if (st.roomId) await leaveRoom();
  await out.resume();
  await ensureMic();
  st.roomId = roomId;
  st.roomServerId = st.view;
  st.roomName = (st.rooms.find((r) => r.id === roomId) || {}).name || 'Sala';
  st.focus = null;
  st.prevRoomSids = new Set();
  mesh = new Mesh({
    mySid: st.sid,
    iceServers: iceServers(),
    codec: S.codec,
    micTrack: mic ? mic.track : null,
    signal: (to, data) => B.sendSignal(st.sid, to, data),
    onTrack: onRemoteTrack,
    onData: onPeerData,
    onState: (sid, s) => {
      st.conn[sid] = s;
      renderHead();
    },
    onPeerGone: (sid) => {
      out.removeTrack(sid + ':mic');
      out.removeTrack(sid + ':screen');
      st.remote.delete(sid);
      delete st.conn[sid];
      delete st.ping[sid];
      if (st.focus === 's:' + sid) st.focus = null;
    },
  });
  // mesh existe ANTES de anunciar a presença na sala (para não perder ofertas)
  await st.presenceObj.set({ roomId, serverId: st.roomServerId });
  onPresence(st.presence);
  blip('join-self');
  renderMain();
}

async function leaveRoom(silent = false) {
  if (!st.roomId) return;
  if (st.sharing) await stopShare(true);
  if (mesh) mesh.closeAll();
  mesh = null;
  out.removeAll();
  st.remote.clear();
  st.conn = {};
  st.ping = {};
  st.roomId = null;
  st.roomServerId = null;
  st.focus = null;
  st.prevRoomSids = new Set();
  if (mic) {
    mic.destroy();
    mic = null;
  }
  if (st.presenceObj) await st.presenceObj.set({ roomId: null, serverId: null, sharing: false });
  if (!silent) {
    blip('leave-self');
    renderMain();
  }
}

function onRemoteTrack(sid, role, track) {
  const r = st.remote.get(sid) || {};
  const p = presenceOf(sid);
  const uid = p ? p.uid : '';
  if (role === 'mic') {
    r.mic = track;
    out.addTrack(sid + ':mic', track, S.userVolumes[uid] ?? 100);
  } else if (role === 'screen-audio') {
    r.screenAudio = track;
    out.addTrack(sid + ':screen', track, S.screenVolumes[uid] ?? 100);
  } else if (role === 'screen-video') {
    r.screenVideo = track;
  }
  st.remote.set(sid, r);
  renderStage();
}

function onPeerData(sid, msg) {
  if (msg.t === 'sound') {
    const p = presenceOf(sid);
    playSound(msg.id, p ? p.name : 'Alguém');
  }
}

// ---------------------------------------------------------------- microfone / fone
function applyMute() {
  if (mic) mic.setMuted(st.muted || st.deafened);
  out.setDeafened(st.deafened);
  if (st.presenceObj) st.presenceObj.set({ muted: st.muted || st.deafened, deafened: st.deafened });
  renderControls();
  renderUserPanel();
  renderSidebar();
}
function toggleMute() {
  if (st.deafened) {
    st.deafened = false;
    st.muted = false;
  } else st.muted = !st.muted;
  blip(st.muted ? 'mute' : 'unmute');
  applyMute();
}
function toggleDeafen() {
  st.deafened = !st.deafened;
  if (!st.deafened && st.muted) st.muted = false;
  blip(st.deafened ? 'deafen' : 'undeafen');
  applyMute();
}
bridge.onShortcut((name) => {
  if (!st.me) return;
  if (name === 'mute') toggleMute();
  if (name === 'deafen') toggleDeafen();
});

// ---------------------------------------------------------------- compartilhar tela
async function openSharePicker() {
  if (!st.roomId) return toast('Entra numa sala primeiro.');
  let sources = [];
  try {
    sources = await bridge.getSources();
  } catch (e) {
    return toast('Não consegui listar as telas.', true);
  }
  let tab = 'screen';
  let selected = (sources.find((s) => s.type === 'screen') || sources[0] || {}).id;
  const peers = Math.max(1, roomMembers(st.roomId).length - 1);

  const draw = () => {
    const list = sources.filter((s) => s.type === tab);
    const p = SCREEN_PRESETS[S.quality];
    const up = ((p.bitrate * peers) / 1e6).toFixed(1);
    openModal(
      `
      <div class="modal-head"><h3>Compartilhar tela</h3><button class="ibtn" data-act="close">${icon('close')}</button></div>
      <div class="modal-body">
        <div class="picker-tabs">
          <button data-act="pick-tab" data-tab="screen" class="${tab === 'screen' ? 'on' : ''}">Telas</button>
          <button data-act="pick-tab" data-tab="window" class="${tab === 'window' ? 'on' : ''}">Janelas / Jogos</button>
        </div>
        <div class="sources">
          ${
            list
              .map(
                (s) => `<button class="source ${s.id === selected ? 'on' : ''}" data-act="pick-src" data-id="${esc(s.id)}">
              <div class="thumb" style="background-image:url('${s.thumb || ''}')"></div>
              <div class="nm">${s.icon ? `<img src="${s.icon}"/>` : ''}<span class="ellipsis">${esc(s.name)}</span></div>
            </button>`
              )
              .join('') || '<div class="muted">Nada aqui.</div>'
          }
        </div>
        <div class="label">Qualidade</div>
        <div class="quality">
          ${Object.entries(SCREEN_PRESETS)
            .map(
              ([k, v]) =>
                `<button data-act="pick-q" data-q="${k}" class="${S.quality === k ? 'on' : ''}">${k === 'source' ? 'Nativa' : k.replace(/p(\d+)/, 'p<small>$1 FPS</small>')}${k === 'source' ? '<small>60 FPS</small>' : ''}</button>`
            )
            .join('')}
        </div>
        <div class="hint">Upload estimado: ~${up} Mbps (${peers} ${peers > 1 ? 'pessoas assistindo' : 'pessoa assistindo'}). Se travar, baixa a qualidade.</div>
        <div class="toggle"><div class="t"><b>Modo jogo (fluidez)</b><small>Prioriza FPS. Desliga para texto/código nítido.</small></div>
          <button class="switch ${S.mode === 'motion' ? 'on' : ''}" data-act="pick-mode"></button></div>
        <div class="toggle"><div class="t"><b>Transmitir áudio do PC</b><small>Som do jogo/vídeo. Use fone para a voz dos amigos não voltar.</small></div>
          <button class="switch ${S.shareAudio ? 'on' : ''}" data-act="pick-audio"></button></div>
      </div>
      <div class="modal-foot"><button class="btn ghost" data-act="close">Cancelar</button>
        <button class="btn primary" data-act="pick-go" ${selected ? '' : 'disabled'}>${icon('screen', 'sm')} Transmitir</button></div>`,
      { wide: true }
    );
    const m = modalRoot.firstElementChild;
    m.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'pick-tab') {
        tab = b.dataset.tab;
        draw();
      } else if (a === 'pick-src') {
        selected = b.dataset.id;
        $$('.source', m).forEach((x) => x.classList.toggle('on', x.dataset.id === selected));
        $('[data-act="pick-go"]', m).disabled = false;
      } else if (a === 'pick-src-dbl') {
      } else if (a === 'pick-q') {
        S.quality = b.dataset.q;
        saveSettings();
        draw();
      } else if (a === 'pick-mode') {
        S.mode = S.mode === 'motion' ? 'detail' : 'motion';
        saveSettings();
        b.classList.toggle('on', S.mode === 'motion');
      } else if (a === 'pick-audio') {
        S.shareAudio = !S.shareAudio;
        saveSettings();
        b.classList.toggle('on', S.shareAudio);
      } else if (a === 'pick-go') {
        closeModal();
        startShare(selected);
      }
    });
  };
  draw();
}

async function startShare(sourceId) {
  const p = SCREEN_PRESETS[S.quality] || SCREEN_PRESETS['1080p60'];
  const video = { width: { max: p.w }, height: { max: p.h }, frameRate: { ideal: p.fps, max: p.fps } };
  const audio = S.shareAudio
    ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true, suppressLocalAudioPlayback: false }
    : false;
  let stream;
  try {
    await bridge.selectSource({ id: sourceId, audio: !!audio });
    stream = await navigator.mediaDevices.getDisplayMedia({ video, audio, systemAudio: audio ? 'include' : 'exclude' });
  } catch (e) {
    if (audio) {
      try {
        await bridge.selectSource({ id: sourceId, audio: false });
        stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
        toast('Não deu pra capturar o áudio; transmitindo só o vídeo.');
      } catch (e2) {
        console.error(e2);
      }
    }
    if (!stream) {
      console.error(e);
      return toast('Não consegui capturar a tela.', true);
    }
  }
  if (!st.roomId || !mesh) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = S.mode === 'detail' ? 'detail' : 'motion';
  vt.addEventListener('ended', () => stopShare());
  st.screenStream = stream;
  st.sharing = true;
  await mesh.setScreen(stream, { ...p, mode: S.mode });
  await st.presenceObj.set({ sharing: true });
  blip('share-start');
  renderStage();
  renderControls();
  renderSidebar();
}

async function stopShare(silent = false) {
  if (!st.sharing) return;
  st.sharing = false;
  if (st.screenStream) st.screenStream.getTracks().forEach((t) => t.stop());
  st.screenStream = null;
  if (st.focus === 's:' + st.sid) st.focus = null;
  if (mesh) await mesh.setScreen(null);
  if (st.presenceObj) await st.presenceObj.set({ sharing: false });
  if (!silent) {
    blip('share-stop');
    renderStage();
    renderControls();
    renderSidebar();
  }
}

// ---------------------------------------------------------------- soundboard
function loadSound(id) {
  if (!soundCache.has(id)) {
    const p = (async () => {
      const url = await B.getSoundData(id);
      if (!url) throw new Error('sem dados');
      const buf = await (await fetch(url)).arrayBuffer();
      return out.decode(buf);
    })();
    p.catch(() => soundCache.delete(id));
    soundCache.set(id, p);
  }
  return soundCache.get(id);
}

async function playSound(id, fromName = null) {
  const snd = st.sounds.find((s) => s.id === id);
  if (!snd) return;
  try {
    const buf = await loadSound(id);
    out.playBuffer(buf, snd.volume ?? 100);
    const el = $(`.sound[data-id="${id}"]`);
    if (el) {
      el.classList.add('playing');
      setTimeout(() => el.classList.remove('playing'), Math.min(buf.duration * 1000, 4000));
    }
    if (fromName) sfxPop(`${fromName} tocou ${snd.emoji || '🔊'} ${snd.name}`);
  } catch (e) {
    console.error(e);
  }
}

function clickSound(id) {
  const now = Date.now();
  if (now - lastSfx < 250) return;
  lastSfx = now;
  playSound(id);
  if (mesh) mesh.broadcast({ t: 'sound', id });
}

function sfxPop(text) {
  const stage = $('.stage');
  if (!stage) return;
  const el = document.createElement('div');
  el.className = 'sfx-pop';
  el.textContent = text;
  stage.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function openUploadSound() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,.mp3,.wav,.ogg,.m4a';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 700 * 1024) return toast('Arquivo muito grande (máx. 700 KB). Corta o áudio.', true);
    let duration = 0;
    try {
      const buf = await out.decode(await file.arrayBuffer());
      duration = buf.duration;
    } catch (_) {
      return toast('Formato de áudio não suportado.', true);
    }
    if (duration > 30) return toast('Som muito longo (máx. 30 segundos).', true);
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const base = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
    const emojis = ['🔊', '😂', '💀', '🔥', '🤡', '🐐', '💥', '🚨', '👏', '😱', '🗑️', '🎺'];
    openModal(`
      <div class="modal-head"><h3>Novo som</h3><button class="ibtn" data-act="close">${icon('close')}</button></div>
      <form id="snd-form" class="modal-body">
        <div class="field"><label>Nome</label><input type="text" name="name" maxlength="40" required value="${esc(base)}"/></div>
        <div class="field"><label>Emoji</label>
          <div class="row" style="flex-wrap:wrap;gap:6px">${emojis
            .map((e, i) => `<label class="btn ghost" style="padding:6px 8px;font-size:18px"><input type="radio" name="emoji" value="${e}" ${i === 0 ? 'checked' : ''} style="display:none"/>${e}</label>`)
            .join('')}</div></div>
        <div class="field"><label>Volume do som: <span id="sv">100</span>%</label><input type="range" name="volume" min="10" max="200" value="100" oninput=""/></div>
        <div class="hint">${duration.toFixed(1)}s • ${(file.size / 1024).toFixed(0)} KB</div>
      </form>
      <div class="modal-foot"><button class="btn ghost" data-act="close">Cancelar</button><button class="btn primary" id="snd-save">${icon('upload', 'sm')} Enviar</button></div>`);
    const f = $('#snd-form');
    $$('label.btn', f).forEach((l) =>
      l.addEventListener('click', () => {
        $$('label.btn', f).forEach((x) => (x.style.background = ''));
        l.style.background = 'var(--bg4)';
      })
    );
    $$('label.btn', f)[0].style.background = 'var(--bg4)';
    f.volume.addEventListener('input', () => ($('#sv').textContent = f.volume.value));
    $('#snd-save').addEventListener('click', async (e) => {
      const d = Object.fromEntries(new FormData(f));
      if (!d.name.trim()) return;
      e.target.disabled = true;
      e.target.textContent = 'Enviando...';
      try {
        await B.uploadSound({ uid: st.user.uid, name: d.name.trim(), emoji: d.emoji, dataUrl, volume: +d.volume });
        closeModal();
        toast('Som adicionado!');
      } catch (err) {
        console.error(err);
        toast('Falha ao enviar: ' + B.friendlyError(err), true);
        e.target.disabled = false;
      }
    });
  };
  input.click();
}

// ---------------------------------------------------------------- renderização
function renderMain() {
  if (!st.me) return;
  root.innerHTML = `
  <div class="app">
    <nav class="rail" id="rail"></nav>
    <aside class="sidebar"><div id="sidebar-body" style="display:flex;flex-direction:column;flex:1;min-height:0"></div><div id="callbar"></div><div class="userpanel" id="userpanel"></div></aside>
    <main class="main">
      <div id="update-slot"></div>
      <div class="main-head" id="main-head"></div>
      <div class="body">
        <div class="stage"><div id="stage" style="flex:1;display:flex;flex-direction:column;min-height:0"></div><div class="controls" id="controls"></div></div>
        <div class="soundboard" id="soundboard" style="${st.showSB ? '' : 'display:none'}"></div>
      </div>
    </main>
  </div>`;
  tileEls.clear();
  stageSig = '';
  renderRail();
  renderSidebar();
  renderUserPanel();
  renderHead();
  renderStage();
  renderControls();
  renderSoundboard();
  renderUpdate();
}

const serverInitials = (name) =>
  (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

function renderRail() {
  const el = $('#rail');
  if (!el) return;
  const notif = st.notifications.length;
  el.innerHTML = `
    <button class="rail-btn rail-home ${st.view === 'home' ? 'on' : ''}" data-act="view" data-view="home" title="Amigos e convites">
      <span class="brand-mini"><span>CC</span></span>${notif ? `<i class="badge">${notif}</i>` : ''}</button>
    <div class="rail-sep"></div>
    ${st.servers
      .map(
        (sv) => `<button class="rail-btn ${st.view === sv.id ? 'on' : ''}" data-act="view" data-view="${sv.id}" title="${esc(sv.name)}" style="--c:${esc(sv.color || '#ffb21e')}">
          <span class="srv">${esc(serverInitials(sv.name))}</span>${st.roomServerId === sv.id ? '<i class="dot"></i>' : ''}</button>`
      )
      .join('')}
    <button class="rail-btn add" data-act="add-server" title="Criar ou entrar num servidor">${icon('plus')}</button>`;
}

function flags(p) {
  return `<span class="flags">${p.sharing ? '<span class="live">AO VIVO</span>' : ''}${p.deafened ? icon('headsetOff', 'sm') : p.muted ? icon('micOff', 'sm') : ''}</span>`;
}

const onlineUids = () => new Set(st.presence.map((p) => p.uid));
const myFriends = () => (st.me?.friends || []).map((u) => st.members.get(u)).filter(Boolean);

function renderSidebar() {
  const el = $('#sidebar-body');
  if (!el) return;
  if (st.view === 'home') {
    const on = onlineUids();
    const friends = myFriends();
    el.innerHTML = `
      <div class="side-head"><div class="brand-mark"><span>CC</span></div><b>Especial Caçamba<br/>dos Cria</b></div>
      <div class="rooms">
        <div class="room on" data-act="noop">${icon('people', 'sm')}<span>Amigos</span></div>
        <div class="rooms-title"><span class="label">Mensagens / convites</span></div>
        ${st.notifications.length ? st.notifications.map((n) => `<div class="rm">${icon(n.type === 'server-invite' ? 'mail' : 'people', 'sm')}<span class="ellipsis">${esc(n.fromName)}</span></div>`).join('') : '<div class="hint" style="padding:0 8px">Nada novo.</div>'}
        <div class="rooms-title"><span class="label">Amigos — ${friends.length}</span></div>
        ${friends.map((m) => `<div class="rm" data-uid="${m.id}">${avatar(m.name, m.color)}<span class="ellipsis">${esc(m.name)}</span><span class="flags"><i class="status ${on.has(m.id) ? 'on' : ''}"></i></span></div>`).join('') || '<div class="hint" style="padding:0 8px">Adicione a galera na aba Adicionar amigo.</div>'}
      </div>`;
    return;
  }
  const sv = currentServer();
  if (!sv) {
    el.innerHTML = '';
    return;
  }
  const on = onlineUids();
  const svMembers = (sv.members || []).map((u) => st.members.get(u)).filter(Boolean);
  svMembers.sort((a, b) => (on.has(b.id) ? 1 : 0) - (on.has(a.id) ? 1 : 0) || a.name.localeCompare(b.name));
  el.innerHTML = `
    <button class="server-head" data-act="server-menu"><b class="ellipsis">${esc(sv.name)}</b>${icon('expand', 'sm')}</button>
    <button class="btn invite-btn" data-act="invite">${icon('personAdd', 'sm')} Convidar pessoas</button>
    <div class="rooms">
      <div class="rooms-title"><span class="label">Salas de voz</span><button data-act="add-room" title="Criar sala">${icon('plus', 'sm')}</button></div>
      ${st.rooms
        .map((r) => {
          const ms = roomMembers(r.id);
          return `<div class="room ${st.roomId === r.id ? 'on' : ''}" data-act="join" data-room="${r.id}">${icon('voice', 'sm')}<span class="ellipsis">${esc(r.name)}</span>${ms.length ? `<span class="count">${ms.length}</span>` : ''}</div>
          ${ms.length ? `<div class="room-members">${ms.map((p) => `<div class="rm" data-sid="${p.sid}">${avatar(p.name, p.color, p.sid)}<span class="ellipsis">${esc(p.name)}</span>${flags(p)}</div>`).join('')}</div>` : ''}`;
        })
        .join('')}
    </div>
    <div class="online-list">
      <div class="label" style="margin-top:10px">Membros — ${svMembers.length}</div>
      ${svMembers.map((m) => `<div class="rm ${on.has(m.id) ? '' : 'offline'}" data-uid="${m.id}">${avatar(m.name, m.color)}<span class="ellipsis">${esc(m.name)}${sv.ownerId === m.id ? ' 👑' : ''}</span><span class="flags"><i class="status ${on.has(m.id) ? 'on' : ''}"></i></span></div>`).join('')}
    </div>`;
}

function renderUserPanel() {
  const el = $('#userpanel');
  if (!el || !st.me) return;
  const m = st.muted || st.deafened;
  el.innerHTML = `
    ${avatar(st.me.name, st.me.color, st.sid)}
    <div class="who"><b class="ellipsis">${esc(st.me.name)}</b><small>${st.roomId ? 'Em chamada' : 'Online'}</small></div>
    <button class="ibtn ${m ? 'off' : ''}" data-act="mute" title="Mutar (Ctrl+Shift+M)">${icon(m ? 'micOff' : 'mic')}</button>
    <button class="ibtn ${st.deafened ? 'off' : ''}" data-act="deafen" title="Desativar áudio (Ctrl+Shift+D)">${icon(st.deafened ? 'headsetOff' : 'headset')}</button>
    <button class="ibtn" data-act="settings" title="Configurações">${icon('gear')}</button>`;
  const cb = $('#callbar');
  if (cb) {
    const sv = st.servers.find((x) => x.id === st.roomServerId);
    cb.innerHTML = st.roomId
      ? `<div class="callbar"><div class="grow"><b>Voz conectada</b><small class="ellipsis">${esc(st.roomName)} / ${esc(sv ? sv.name : '')}</small></div>
         <button class="ibtn" data-act="go-call" title="Ir para a chamada">${icon('voice')}</button>
         <button class="ibtn off" data-act="leave" title="Desconectar">${icon('hangup')}</button></div>`
      : '';
  }
}

function renderHead() {
  const el = $('#main-head');
  if (!el) return;
  if (st.view === 'home') {
    const tabs = [
      ['online', 'Online'],
      ['all', 'Todos os amigos'],
      ['invites', `Convites${st.notifications.length ? ` (${st.notifications.length})` : ''}`],
      ['add', 'Adicionar amigo'],
    ];
    el.innerHTML = `${icon('people')}<h2>Amigos</h2><div class="head-tabs">${tabs
      .map(([k, l]) => `<button data-act="home-tab" data-tab="${k}" class="${st.homeTab === k ? 'on' : ''} ${k === 'add' ? 'green' : ''}">${l}</button>`)
      .join('')}</div><div class="grow"></div>
      <button class="btn ghost" data-act="toggle-sb">${icon('sound', 'sm')} Soundboard</button>`;
    return;
  }
  const room = inCallHere() ? st.rooms.find((r) => r.id === st.roomId) : null;
  if (!room) {
    const sv = currentServer();
    el.innerHTML = `<h2>${esc(sv ? sv.name : '')}</h2><div class="grow"></div>
      <button class="btn ghost" data-act="toggle-sb">${icon('sound', 'sm')} Soundboard</button>`;
    return;
  }
  const peers = Object.values(st.conn);
  const connecting = peers.filter((s) => s !== 'connected').length;
  const n = roomMembers(st.roomId).length;
  el.innerHTML = `${icon('voice')}<h2>${esc(room.name)}</h2>
    <span class="conn ${connecting ? 'warn' : ''}">${connecting ? `Conectando com ${connecting}...` : 'Voz conectada'} • ${n} na sala</span>
    <div class="grow"></div>
    <button class="btn ghost" data-act="toggle-sb">${icon('sound', 'sm')} Soundboard</button>`;
}

function renderHome(el) {
  const on = onlineUids();
  const friendIds = new Set(st.me.friends || []);
  const card = (m, actions) => `<div class="friend" data-uid="${m.id}">${avatar(m.name, m.color)}<div class="grow"><b>${esc(m.name)}</b><small class="muted">${on.has(m.id) ? 'Online' : 'Offline'}</small></div>${actions}</div>`;
  let body = '';
  if (st.homeTab === 'online' || st.homeTab === 'all') {
    const list = myFriends().filter((m) => st.homeTab === 'all' || on.has(m.id));
    body = `<div class="label">${st.homeTab === 'all' ? 'Todos os amigos' : 'Online'} — ${list.length}</div>
      ${list.map((m) => card(m, `<button class="btn" data-act="invite-to" data-uid="${m.id}">${icon('personAdd', 'sm')} Chamar pro servidor</button><button class="ibtn" data-act="remove-friend" data-uid="${m.id}" title="Remover amigo">${icon('close', 'sm')}</button>`)).join('') || `<div class="hint">${st.homeTab === 'all' ? 'Você ainda não adicionou ninguém.' : 'Nenhum amigo online agora.'}</div>`}`;
  } else if (st.homeTab === 'invites') {
    body = `<div class="label">Convites — ${st.notifications.length}</div>
      ${st.notifications
        .map(
          (n) => `<div class="friend">${icon(n.type === 'server-invite' ? 'mail' : 'people', 'lg')}<div class="grow"><b>${esc(n.fromName)}</b><small class="muted">${n.type === 'server-invite' ? `te chamou pro servidor <b>${esc(n.serverName)}</b>` : 'te adicionou como amigo'}</small></div>
          ${n.type === 'server-invite' ? `<button class="btn primary" data-act="accept-invite" data-id="${n.id}">Entrar</button>` : !friendIds.has(n.from) ? `<button class="btn primary" data-act="accept-friend" data-id="${n.id}">Adicionar de volta</button>` : ''}
          <button class="ibtn" data-act="dismiss" data-id="${n.id}" title="Dispensar">${icon('close', 'sm')}</button></div>`
        )
        .join('') || '<div class="hint">Nenhum convite.</div>'}`;
  } else {
    const q = (st.friendQuery || '').trim().toLowerCase();
    const others = [...st.members.values()].filter((m) => m.id !== st.user.uid && (!q || (m.name || '').toLowerCase().includes(q)));
    others.sort((a, b) => (on.has(b.id) ? 1 : 0) - (on.has(a.id) ? 1 : 0) || a.name.localeCompare(b.name));
    body = `<div class="label">Adicionar amigo</div>
      <div class="hint" style="margin-bottom:10px">Todo mundo que tem conta no app aparece aqui. Procura pelo apelido.</div>
      <input type="text" id="friend-q" placeholder="Digite o apelido..." value="${esc(st.friendQuery || '')}"/>
      <div style="margin-top:12px">${others
        .slice(0, 60)
        .map((m) => card(m, friendIds.has(m.id) ? '<span class="muted">Já é amigo</span>' : `<button class="btn primary" data-act="add-friend" data-uid="${m.id}">${icon('personAdd', 'sm')} Adicionar</button>`))
        .join('') || '<div class="hint">Ninguém encontrado.</div>'}</div>`;
  }
  el.innerHTML = `<div class="home">${body}</div>`;
  const qi = $('#friend-q');
  if (qi) {
    qi.addEventListener('input', () => {
      st.friendQuery = qi.value;
      const pos = qi.selectionStart;
      renderStage();
      const n = $('#friend-q');
      n.focus();
      n.setSelectionRange(pos, pos);
    });
  }
}

function renderControls() {
  const el = $('#controls');
  if (!el) return;
  if (!inCallHere()) {
    el.innerHTML = '';
    return;
  }
  const m = st.muted || st.deafened;
  el.innerHTML = `
    <button class="cbtn ${m ? 'off' : ''}" data-act="mute" title="Ctrl+Shift+M">${icon(m ? 'micOff' : 'mic')}</button>
    <button class="cbtn ${st.deafened ? 'off' : ''}" data-act="deafen" title="Ctrl+Shift+D">${icon(st.deafened ? 'headsetOff' : 'headset')}</button>
    <button class="cbtn ${st.sharing ? 'live' : ''}" data-act="share">${icon(st.sharing ? 'screenOff' : 'screen')} ${st.sharing ? 'Parar transmissão' : 'Compartilhar tela'}</button>
    <button class="cbtn ${st.showSB ? 'on' : ''}" data-act="toggle-sb" title="Soundboard">${icon('sound')}</button>
    <button class="cbtn" data-act="settings" title="Configurações">${icon('gear')}</button>
    <button class="cbtn leave" data-act="leave" title="Sair da sala">${icon('hangup')}</button>`;
}

// ---- palco (tiles com chave, para não recriar vídeos)
const tileEls = new Map();
let stageSig = '';

function makeTile(key, kind) {
  const el = document.createElement('div');
  el.className = 'tile ' + kind;
  el.dataset.key = key;
  if (kind === 'screen') {
    el.innerHTML = `<video autoplay playsinline muted></video><span class="live">AO VIVO</span><div class="tag"></div>
      <div class="tools"></div>`;
  } else {
    el.innerHTML = `<div class="av"></div><div class="tag"></div><span class="ping"></span>`;
  }
  return el;
}

function renderStage() {
  const el = $('#stage');
  if (!el) return;
  if (st.view === 'home') {
    tileEls.clear();
    stageSig = '';
    return renderHome(el);
  }
  if (!inCallHere()) {
    tileEls.clear();
    stageSig = '';
    el.innerHTML = st.servers.length
      ? `<div class="empty"><div><div class="brand-mark"><span>CC</span></div>
      <h3>Escolhe uma sala aí do lado</h3><p>Clica numa sala de voz pra entrar na resenha.<br/>Depois é só compartilhar a tela e soltar os efeitos.</p>
      ${st.roomId ? `<p><button class="btn" data-act="go-call">Voltar pra chamada em ${esc(st.roomName)}</button></p>` : ''}</div></div>`
      : `<div class="empty"><div><div class="brand-mark"><span>CC</span></div>
      <h3>Cria um servidor pra galera</h3><p>Ou entra num com o código que te mandaram.</p><p><button class="btn primary" data-act="add-server">Criar / entrar em servidor</button></p></div></div>`;
    return;
  }
  const people = roomMembers(st.roomId);
  if (!people.find((p) => p.sid === st.sid)) {
    people.unshift({ sid: st.sid, uid: st.user.uid, name: st.me.name, color: st.me.color, muted: st.muted || st.deafened, deafened: st.deafened, sharing: st.sharing });
  }
  const screens = people.filter((p) => (p.sid === st.sid ? st.sharing : p.sharing));
  const keys = [...screens.map((p) => 's:' + p.sid), ...people.map((p) => 'p:' + p.sid)];
  if (st.focus && !keys.includes(st.focus)) st.focus = null;

  // cria/remove
  for (const k of [...tileEls.keys()]) if (!keys.includes(k)) tileEls.delete(k);
  for (const k of keys) if (!tileEls.has(k)) tileEls.set(k, makeTile(k, k.startsWith('s:') ? 'screen' : 'person'));

  // atualiza conteúdo
  const many = keys.length > 6 || !!st.focus;
  for (const p of people) {
    const t = tileEls.get('p:' + p.sid);
    const me = p.sid === st.sid;
    const sp = st.speaking.has(p.sid);
    t.classList.toggle('speaking', sp);
    t.classList.toggle('small', many);
    t.dataset.sid = p.sid;
    t.dataset.speak = p.sid;
    const avHtml = avatar(p.name, p.color);
    if (t._av !== avHtml) {
      t.querySelector('.av').innerHTML = avHtml;
      t._av = avHtml;
    }
    t.querySelector('.tag').innerHTML = `${p.deafened ? icon('headsetOff') : p.muted ? icon('micOff') : ''}<span class="ellipsis">${esc(p.name)}${me ? ' (você)' : ''}</span>`;
    t.querySelector('.ping').textContent = !me && st.ping[p.sid] != null ? `${Math.round(st.ping[p.sid] * 1000)} ms` : '';
  }
  for (const p of screens) {
    const t = tileEls.get('s:' + p.sid);
    const me = p.sid === st.sid;
    const video = t.querySelector('video');
    let track = null;
    if (me) track = st.screenStream && st.screenStream.getVideoTracks()[0];
    else track = st.remote.get(p.sid)?.screenVideo || null;
    if (track && video._tid !== track.id) {
      video.srcObject = new MediaStream([track]);
      video._tid = track.id;
      video.play().catch(() => {});
    }
    t.dataset.sid = p.sid;
    t.querySelector('.tag').innerHTML = `${icon('screen')}<span class="ellipsis">${esc(p.name)}${me ? ' (sua tela)' : ''}</span>`;
    const tools = t.querySelector('.tools');
    const tsig = me ? 'me' : 'r' + (S.screenVolumes[p.uid] ?? 100);
    if (tools._sig !== tsig) {
      tools._sig = tsig;
      tools.innerHTML = `${
        me
          ? ''
          : `<label title="Volume da transmissão" onclick="event.stopPropagation()">${icon('volume', 'sm')}<input type="range" min="0" max="200" value="${S.screenVolumes[p.uid] ?? 100}" data-screenvol="${p.uid}" data-sid="${p.sid}"/></label>`
      }<button data-act="fullscreen" title="Tela cheia">${icon('full', 'sm')}</button>`;
    }
  }

  // layout
  const sig = (st.focus || '') + '|' + keys.join(',');
  if (sig !== stageSig) {
    stageSig = sig;
    el.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'grid' + (st.focus ? ' focus' : '');
    if (st.focus) {
      const main = document.createElement('div');
      main.className = 'focus-main';
      main.appendChild(tileEls.get(st.focus));
      const strip = document.createElement('div');
      strip.className = 'strip';
      keys.filter((k) => k !== st.focus).forEach((k) => strip.appendChild(tileEls.get(k)));
      grid.append(main, strip);
    } else {
      keys.forEach((k) => grid.appendChild(tileEls.get(k)));
    }
    el.appendChild(grid);
    $$('video', el).forEach((v) => v.play().catch(() => {}));
  }
}

function renderSoundboard() {
  const el = $('#soundboard');
  if (!el) return;
  el.style.display = st.showSB ? '' : 'none';
  el.innerHTML = `
    <div class="sb-head">${icon('sound')}<b>Soundboard</b><button class="ibtn" data-act="toggle-sb" title="Fechar">${icon('close', 'sm')}</button></div>
    <div class="sb-grid">
      ${
        st.sounds
          .map(
            (s) =>
              `<button class="sound" data-act="sound" data-id="${s.id}" title="${esc(s.name)} — clique direito para opções"><span class="em">${esc(s.emoji || '🔊')}</span><span class="nm">${esc(s.name)}</span></button>`
          )
          .join('') || `<div class="sb-empty">Nenhum som ainda.<br/>Sobe o primeiro aí embaixo!</div>`
      }
    </div>
    <div class="sb-foot">
      <div class="row"><span class="muted" style="font-size:12px;width:70px">Volume</span><input type="range" min="0" max="100" value="${S.sfxVolume}" data-sfxvol/></div>
      <div class="row">
        <button class="btn grow" data-act="upload-sound">${icon('upload', 'sm')} Adicionar som</button>
        <button class="btn" data-act="stop-sounds" title="Parar todos os sons">${icon('stop', 'sm')}</button>
      </div>
      <div class="hint">${st.roomId ? 'Todo mundo na sala escuta.' : 'Fora de sala só você escuta.'}</div>
    </div>`;
}

function renderUpdate() {
  const el = $('#update-slot');
  if (!el) return;
  el.innerHTML =
    st.update && st.update.state === 'ready'
      ? `<div class="update-bar">Versão ${esc(st.update.version)} baixada! <button data-act="install-update">Reiniciar e atualizar</button></div>`
      : '';
}
bridge.onUpdate((info) => {
  st.update = info;
  renderUpdate();
});

// ---------------------------------------------------------------- loops (falando / ping)
setInterval(() => {
  if (!st.roomId) {
    if (st.speaking.size) {
      st.speaking.clear();
      $$('[data-speak]').forEach((e) => e.classList.remove('speaking'));
    }
    return;
  }
  const now = performance.now();
  if (mic && mic.speaking) st.lastSpeak.set(st.sid, now);
  for (const sid of st.remote.keys()) if (out.level(sid + ':mic') > -50) st.lastSpeak.set(sid, now);
  const next = new Set();
  for (const [sid, t] of st.lastSpeak) if (now - t < 300) next.add(sid);
  const changed = [...next].some((s) => !st.speaking.has(s)) || [...st.speaking].some((s) => !next.has(s));
  if (changed) {
    st.speaking = next;
    $$('[data-speak]').forEach((e) => e.classList.toggle('speaking', next.has(e.dataset.speak)));
  }
}, 80);

setInterval(async () => {
  if (!mesh) return;
  for (const sid of mesh.peers.keys()) {
    const r = await mesh.rtt(sid);
    if (r != null) st.ping[sid] = r;
  }
  $$('.tile.person').forEach((t) => {
    const sid = t.dataset.sid;
    const pe = t.querySelector('.ping');
    if (pe && sid !== st.sid && st.ping[sid] != null) pe.textContent = `${Math.round(st.ping[sid] * 1000)} ms`;
  });
}, 3000);

// ---------------------------------------------------------------- configurações
let settingsTab = 'voice';
let meterRaf = null;

async function openSettings(tab = settingsTab) {
  settingsTab = tab;
  let inputs = [];
  let outputs = [];
  if (tab === 'voice') {
    if (!mic) {
      // abre o mic só pra testar (sem enviar a ninguém)
      await ensureMic();
    }
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      inputs = devs.filter((d) => d.kind === 'audioinput');
      outputs = devs.filter((d) => d.kind === 'audiooutput');
    } catch (_) {}
  }
  const version = await bridge.version();
  const sw = (key, title, desc) =>
    `<div class="toggle"><div class="t"><b>${title}</b><small>${desc}</small></div><button class="switch ${S[key] ? 'on' : ''}" data-set-bool="${key}"></button></div>`;
  const opt = (list, cur) =>
    list
      .map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || (d.deviceId === 'default' ? 'Padrão' : 'Dispositivo'))}</option>`)
      .join('');

  const sections = {
    voice: `
      <h2>Voz e áudio</h2>
      <div class="two">
        <div><div class="label">Microfone</div><select data-set="inputDevice">${opt(inputs, S.inputDevice)}</select></div>
        <div><div class="label">Alto-falante / fone</div><select data-set="outputDevice">${opt(outputs, S.outputDevice)}</select></div>
        <div><div class="label">Volume do microfone — <span data-show="inputVolume">${S.inputVolume}</span>%</div><input type="range" min="0" max="200" value="${S.inputVolume}" data-set-num="inputVolume"/></div>
        <div><div class="label">Volume da saída — <span data-show="outputVolume">${S.outputVolume}</span>%</div><input type="range" min="0" max="200" value="${S.outputVolume}" data-set-num="outputVolume"/></div>
      </div>
      <div class="label">Teste do microfone</div>
      <div class="meter" id="mic-meter"><i></i><b style="left:${((S.gateThreshold + 80) / 80) * 100}%"></b></div>
      <div class="hint">Fala alguma coisa: a barra verde mostra seu volume. A linha laranja é o limite do filtro de ruído.</div>
      <div class="label">Processamento de voz</div>
      ${sw('noiseSuppression', 'Supressão de ruído', 'Remove ventilador, teclado, barulho de fundo.')}
      ${sw('echoCancellation', 'Cancelamento de eco', 'Evita que seus amigos se escutem pelo seu microfone.')}
      ${sw('autoGainControl', 'Ganho automático', 'Ajusta seu volume sozinho (desliga se seu volume ficar oscilando).')}
      ${sw('gateEnabled', 'Filtro de ruído (noise gate)', 'Só transmite quando você fala acima do limite.')}
      <div class="label">Sensibilidade do filtro — <span data-show="gateThreshold">${S.gateThreshold}</span> dB</div>
      <input type="range" min="-80" max="-10" value="${S.gateThreshold}" data-set-num="gateThreshold"/>
      <div class="label">Outros</div>
      ${sw('uiSounds', 'Sons de entrada/saída e mute', 'Bipes quando alguém entra, sai ou você muta.')}`,
    stream: `
      <h2>Transmissão de tela</h2>
      <div class="label">Qualidade padrão</div>
      <select data-set="quality">${Object.entries(SCREEN_PRESETS)
        .map(([k, v]) => `<option value="${k}" ${S.quality === k ? 'selected' : ''}>${v.label} — ${(v.bitrate / 1e6).toFixed(1)} Mbps por pessoa</option>`)
        .join('')}</select>
      <div class="label">Codec de vídeo</div>
      <select data-set="codec">
        <option value="h264" ${S.codec === 'h264' ? 'selected' : ''}>H.264 — usa a placa de vídeo (recomendado para jogos)</option>
        <option value="vp9" ${S.codec === 'vp9' ? 'selected' : ''}>VP9 — melhor imagem, usa mais CPU</option>
        <option value="av1" ${S.codec === 'av1' ? 'selected' : ''}>AV1 — melhor compressão, só PCs/GPUs novos</option>
        <option value="vp8" ${S.codec === 'vp8' ? 'selected' : ''}>VP8 — compatibilidade máxima</option>
      </select>
      <div class="hint">O codec vale a partir da próxima vez que você entrar numa sala.</div>
      <div class="label">Preferências</div>
      ${sw('shareAudio', 'Transmitir áudio do PC por padrão', 'Som do jogo junto com a tela.')}
      <div class="toggle"><div class="t"><b>Modo jogo (fluidez)</b><small>Prioriza FPS em vez de nitidez.</small></div><button class="switch ${S.mode === 'motion' ? 'on' : ''}" data-act="toggle-mode"></button></div>
      <div class="label">Dicas para não travar</div>
      <div class="hint" style="font-size:13px;line-height:1.6">• Cada pessoa assistindo usa o upload informado acima (é conexão direta, sem servidor no meio).<br/>
      • Internet com 10 Mbps de upload aguenta 1080p60 para 1 pessoa, ou 1080p30 para 2.<br/>
      • Cabo de rede é melhor que Wi-Fi.<br/>• Jogo em tela cheia exclusiva às vezes não aparece: usa "janela sem bordas".</div>`,
    keys: `
      <h2>Atalhos</h2>
      <div class="hint" style="margin-bottom:12px">Funcionam mesmo com o jogo em foco.</div>
      <div class="toggle"><div class="t"><b>Mutar / desmutar microfone</b></div><span class="kbd">Ctrl</span>+<span class="kbd">Shift</span>+<span class="kbd">M</span></div>
      <div class="toggle"><div class="t"><b>Desativar / ativar áudio</b></div><span class="kbd">Ctrl</span>+<span class="kbd">Shift</span>+<span class="kbd">D</span></div>
      <div class="toggle"><div class="t"><b>Sair do foco / fechar janela</b></div><span class="kbd">Esc</span></div>`,
    account: `
      <h2>Minha conta</h2>
      <div class="row" style="margin:16px 0">${avatar(st.me.name, st.me.color, '', '')}<div><b>${esc(st.me.name)}</b><div class="muted">${esc(st.user.email)}</div></div></div>
      <div class="label">Apelido</div>
      <div class="row"><input type="text" id="nick" maxlength="32" value="${esc(st.me.name)}"/><button class="btn" data-act="save-nick">Salvar</button></div>
      <div class="label">Cor</div>
      <div class="row">${['#f0b232', '#5865f2', '#23a55a', '#eb459e', '#ed4245', '#3ba5c9', '#e67e22', '#9b59b6']
        .map((c) => `<button data-act="set-color" data-color="${c}" style="width:28px;height:28px;border-radius:50%;background:${c};outline:${st.me.color === c ? '2px solid #fff' : 'none'};outline-offset:2px"></button>`)
        .join('')}</div>
      <div class="label">Sessão</div>
      <button class="btn danger" data-act="logout">${icon('logout', 'sm')} Sair da conta</button>`,
    advanced: `
      <h2>Avançado</h2>
      <div class="label">Servidor TURN (opcional)</div>
      <div class="hint" style="margin-bottom:10px">Só precisa se alguém não conseguir conectar (rede de faculdade, 4G, CGNAT). Pode usar um gratuito como o do metered.ca. Todo mundo precisa colocar o mesmo.</div>
      <div class="field"><label>URL(s) — separadas por vírgula</label><input type="text" data-set="turnUrl" value="${esc(S.turnUrl)}" placeholder="turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443"/></div>
      <div class="two"><div class="field"><label>Usuário</label><input type="text" data-set="turnUser" value="${esc(S.turnUser)}"/></div>
      <div class="field"><label>Senha</label><input type="password" data-set="turnPass" value="${esc(S.turnPass)}"/></div></div>
      <div class="hint">Vale a partir da próxima vez que você entrar numa sala.</div>`,
    about: `
      <h2>Sobre</h2>
      <p>Especial Caçamba dos Cria <b>v${esc(version)}</b></p>
      <p class="muted">Voz e tela direto entre vocês (WebRTC peer-to-peer). O Firebase só guarda as contas, salas e sons.</p>
      <button class="btn" data-act="check-update">Procurar atualização</button>`,
  };

  openModal(
    `<div class="modal settings">
      <nav>
        ${[
          ['voice', 'Voz e áudio'],
          ['stream', 'Transmissão'],
          ['keys', 'Atalhos'],
          ['account', 'Minha conta'],
          ['advanced', 'Avançado'],
          ['about', 'Sobre'],
        ]
          .map(([k, l]) => `<button data-act="set-tab" data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`)
          .join('')}
      </nav>
      <section>${sections[tab]}<button class="ibtn close-x" data-act="close">${icon('close')}</button></section>
    </div>`,
    { raw: true }
  );

  const m = modalRoot.firstElementChild;
  m.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.set) {
      S[t.dataset.set] = t.value;
      saveSettings();
      if (t.dataset.set === 'inputDevice' && mic) await mic.update({ ...S });
      if (t.dataset.set === 'outputDevice') await out.setSink(S.outputDevice);
    }
  });
  m.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.setNum) {
      const k = t.dataset.setNum;
      S[k] = +t.value;
      saveSettings();
      const show = $(`[data-show="${k}"]`, m);
      if (show) show.textContent = t.value;
      if (k === 'inputVolume' && mic) mic.update({ ...S });
      if (k === 'outputVolume') out.setVolume(S.outputVolume);
      if (k === 'gateThreshold') {
        if (mic) mic.update({ ...S });
        const mark = $('#mic-meter b', m);
        if (mark) mark.style.left = ((S.gateThreshold + 80) / 80) * 100 + '%';
      }
    }
  });
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-set-bool]');
    if (!b) return;
    const k = b.dataset.setBool;
    S[k] = !S[k];
    saveSettings();
    b.classList.toggle('on', S[k]);
    if (mic) await mic.update({ ...S });
  });

  if (tab === 'voice') {
    const bar = $('#mic-meter i', m);
    const loop = () => {
      if (!$('#mic-meter')) return;
      if (bar && mic) {
        bar.style.width = mic.level * 100 + '%';
        bar.style.opacity = mic.speaking || !S.gateEnabled ? 1 : 0.35;
      }
      meterRaf = requestAnimationFrame(loop);
    };
    loop();
  }
}

function onSettingsClosed() {
  // se abriu o mic só para teste e não está em sala, fecha
  if (!st.roomId && mic) {
    mic.destroy();
    mic = null;
  }
}


// ---------------------------------------------------------------- servidores / convites
function openServerModal() {
  openModal(`
    <div class="modal-head"><h3>Servidor</h3><button class="ibtn" data-act="close">${icon('close')}</button></div>
    <div class="modal-body">
      <div class="label" style="margin-top:0">Criar um servidor novo</div>
      <form id="srv-create" class="row"><input type="text" name="name" maxlength="40" placeholder="Ex.: Caçamba dos Cria" required/><button class="btn primary" type="submit">Criar</button></form>
      <div class="hint">Já vem com as salas Geral, Jogatina, Resenha e AFK.</div>
      <div class="label">Entrar com código de convite</div>
      <form id="srv-join" class="row"><input type="text" name="code" maxlength="12" placeholder="Ex.: K7P2QX9A" required style="text-transform:uppercase"/><button class="btn" type="submit">Entrar</button></form>
      <div class="hint" style="margin-bottom:14px">Pede o código pra quem já está no servidor (botão "Convidar pessoas").</div>
    </div>`);
  $('#srv-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    e.target.querySelector('button').disabled = true;
    try {
      const id = await B.createServer(name, st.user.uid);
      closeModal();
      setView(id);
    } catch (err) {
      toast(B.friendlyError(err), true);
      e.target.querySelector('button').disabled = false;
    }
  });
  $('#srv-join').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = e.target.code.value.trim();
    if (!code) return;
    try {
      const sv = await B.findServerByCode(code);
      if (!sv) return toast('Código não encontrado.', true);
      if (!(sv.members || []).includes(st.user.uid)) await B.joinServer(sv.id, st.user.uid);
      closeModal();
      setView(sv.id);
      toast(`Você entrou em ${sv.name}!`);
    } catch (err) {
      toast(B.friendlyError(err), true);
    }
  });
}

function openInviteModal(serverId = st.view) {
  const sv = st.servers.find((x) => x.id === serverId);
  if (!sv) return;
  const friends = myFriends().filter((m) => !(sv.members || []).includes(m.id));
  openModal(`
    <div class="modal-head"><h3>Convidar pro ${esc(sv.name)}</h3><button class="ibtn" data-act="close">${icon('close')}</button></div>
    <div class="modal-body">
      <div class="label" style="margin-top:0">Código do servidor</div>
      <div class="code-box"><span>${esc(sv.code)}</span><button class="btn primary" data-act="copy-code" data-code="${esc(sv.code)}">Copiar</button></div>
      <div class="hint">Manda esse código no zap. A pessoa clica no <b>+</b> da barra da esquerda → Entrar com código.</div>
      <div class="label">Chamar amigos</div>
      ${friends.map((m) => `<div class="friend">${avatar(m.name, m.color)}<div class="grow"><b>${esc(m.name)}</b></div><button class="btn" data-act="send-invite" data-uid="${m.id}" data-server="${sv.id}">Convidar</button></div>`).join('') || '<div class="hint" style="margin-bottom:14px">Todos os seus amigos já estão aqui (ou adicione amigos na tela inicial).</div>'}
    </div>`);
}

function inviteFriendPicker(uid) {
  const m = st.members.get(uid);
  const list = st.servers.filter((sv) => !(sv.members || []).includes(uid));
  openModal(`
    <div class="modal-head"><h3>Chamar ${esc(m ? m.name : '')} pra qual servidor?</h3><button class="ibtn" data-act="close">${icon('close')}</button></div>
    <div class="modal-body">
      ${list.map((sv) => `<div class="friend"><span class="srv-mini" style="background:${esc(sv.color)}">${esc(serverInitials(sv.name))}</span><div class="grow"><b>${esc(sv.name)}</b></div><button class="btn" data-act="send-invite" data-uid="${uid}" data-server="${sv.id}">Convidar</button></div>`).join('') || '<div class="hint" style="margin-bottom:14px">Ele já está em todos os seus servidores.</div>'}
    </div>`);
}

function serverMenu(btn) {
  const sv = currentServer();
  if (!sv) return;
  const owner = sv.ownerId === st.user.uid;
  const r = btn.getBoundingClientRect();
  const c = openCtx(
    r.left + 8,
    r.bottom + 4,
    `<button class="item" data-x="invite">Convidar pessoas</button>
     <button class="item" data-x="room">Criar sala</button>
     ${owner ? '<button class="item" data-x="rename">Renomear servidor</button><button class="item" data-x="code">Gerar novo código</button><button class="item danger" data-x="delete">Excluir servidor</button>' : '<button class="item danger" data-x="leave">Sair do servidor</button>'}`
  );
  c.addEventListener('click', async (ev) => {
    const x = ev.target.dataset.x;
    if (!x) return;
    closeCtx();
    if (x === 'invite') openInviteModal();
    if (x === 'room') promptText('Nova sala', '', (v) => B.createRoom(sv.id, v, st.rooms.length + 1));
    if (x === 'rename') promptText('Renomear servidor', sv.name, (v) => B.renameServer(sv.id, v));
    if (x === 'code') {
      await B.resetServerCode(sv.id);
      toast('Código novo gerado. O antigo não funciona mais.');
    }
    if (x === 'delete')
      confirmBox(`Excluir o servidor "${sv.name}" pra todo mundo? Não tem volta.`, async () => {
        if (st.roomServerId === sv.id) await leaveRoom();
        await B.deleteServer(sv.id);
        setView('home');
      });
    if (x === 'leave')
      confirmBox(`Sair do servidor "${sv.name}"?`, async () => {
        if (st.roomServerId === sv.id) await leaveRoom();
        await B.leaveServer(sv.id, st.user.uid);
        setView('home');
      }, 'Sair');
  });
}

// ---------------------------------------------------------------- menus de contexto
function personMenu(e, sid) {
  const p = presenceOf(sid);
  if (!p || sid === st.sid) return;
  e.preventDefault();
  const vol = S.userVolumes[p.uid] ?? 100;
  const c = openCtx(
    e.clientX,
    e.clientY,
    `<div class="ctx-title">${esc(p.name)}</div>
     <div class="ctx-range"><small><span>Volume do usuário</span><span id="uv">${vol}%</span></small>
     <input type="range" min="0" max="200" value="${vol}" id="uv-range"/></div>
     <button class="item" data-x="mute">${vol === 0 ? 'Desmutar para mim' : 'Mutar para mim'}</button>
     <button class="item" data-x="reset">Volume padrão (100%)</button>`
  );
  const apply = (v) => {
    S.userVolumes[p.uid] = v;
    saveSettings();
    $('#uv', c).textContent = v + '%';
    $('#uv-range', c).value = v;
    for (const q of st.presence) if (q.uid === p.uid) out.setTrackVolume(q.sid + ':mic', v);
  };
  $('#uv-range', c).addEventListener('input', (ev) => apply(+ev.target.value));
  c.addEventListener('click', (ev) => {
    const x = ev.target.dataset.x;
    if (x === 'mute') {
      apply(vol === 0 ? 100 : 0);
      closeCtx();
    }
    if (x === 'reset') {
      apply(100);
      closeCtx();
    }
  });
}

function roomMenu(e, roomId) {
  e.preventDefault();
  const r = st.rooms.find((x) => x.id === roomId);
  if (!r) return;
  const c = openCtx(
    e.clientX,
    e.clientY,
    `<div class="ctx-title">${esc(r.name)}</div>
     <button class="item" data-x="rename">Renomear sala</button>
     <button class="item danger" data-x="delete">Excluir sala</button>`
  );
  c.addEventListener('click', async (ev) => {
    const x = ev.target.dataset.x;
    closeCtx();
    if (x === 'rename') promptText('Renomear sala', r.name, (v) => B.renameRoom(roomId, v));
    if (x === 'delete') {
      if (roomMembers(roomId).length) return toast('Tem gente na sala. Espera esvaziar.');
      confirmBox(`Excluir a sala "${r.name}"?`, () => B.deleteRoom(roomId));
    }
  });
}

function soundMenu(e, id) {
  e.preventDefault();
  const s = st.sounds.find((x) => x.id === id);
  if (!s) return;
  const owner = st.members.get(s.uid);
  const c = openCtx(
    e.clientX,
    e.clientY,
    `<div class="ctx-title">${esc(s.emoji)} ${esc(s.name)}</div>
     <div class="ctx-range"><small><span>Volume do som</span><span id="sv2">${s.volume ?? 100}%</span></small>
     <input type="range" min="10" max="200" value="${s.volume ?? 100}" id="sv-range"/></div>
     <button class="item" data-x="preview">Ouvir só eu</button>
     <button class="item" data-x="rename">Renomear</button>
     <button class="item danger" data-x="delete">Excluir som</button>
     <div class="hint" style="padding:4px 10px">Enviado por ${esc(owner ? owner.name : '?')}</div>`
  );
  $('#sv-range', c).addEventListener('input', (ev) => ($('#sv2', c).textContent = ev.target.value + '%'));
  $('#sv-range', c).addEventListener('change', (ev) => B.updateSound(id, { volume: +ev.target.value }));
  c.addEventListener('click', (ev) => {
    const x = ev.target.dataset.x;
    if (!x) return;
    closeCtx();
    if (x === 'preview') playSound(id);
    if (x === 'rename') promptText('Renomear som', s.name, (v) => B.updateSound(id, { name: v.slice(0, 40) }));
    if (x === 'delete') confirmBox(`Excluir o som "${s.name}" pra todo mundo?`, () => B.deleteSound(id));
  });
}

function promptText(title, value, onOk) {
  openModal(`
    <div class="modal-head"><h3>${esc(title)}</h3></div>
    <form class="modal-body" id="pt-form"><input type="text" name="v" maxlength="40" value="${esc(value)}" required/></form>
    <div class="modal-foot"><button class="btn ghost" data-act="close">Cancelar</button><button class="btn primary" id="pt-ok">Salvar</button></div>`);
  const f = $('#pt-form');
  f.v.focus();
  f.v.select();
  const ok = async (e) => {
    e.preventDefault();
    const v = f.v.value.trim();
    if (!v) return;
    closeModal();
    try {
      await onOk(v);
    } catch (err) {
      toast(B.friendlyError(err), true);
    }
  };
  f.addEventListener('submit', ok);
  $('#pt-ok').addEventListener('click', ok);
}

function confirmBox(text, onOk, okLabel = 'Excluir') {
  openModal(`
    <div class="modal-head"><h3>Confirmar</h3></div>
    <div class="modal-body"><p>${esc(text)}</p></div>
    <div class="modal-foot"><button class="btn ghost" data-act="close">Cancelar</button><button class="btn danger" id="cf-ok">${esc(okLabel)}</button></div>`);
  $('#cf-ok').addEventListener('click', async () => {
    closeModal();
    try {
      await onOk();
    } catch (err) {
      toast(B.friendlyError(err), true);
    }
  });
}

// ---------------------------------------------------------------- eventos globais
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) {
    const tile = e.target.closest('.tile.screen');
    if (tile) {
      st.focus = st.focus === tile.dataset.key ? null : tile.dataset.key;
      renderStage();
    }
    return;
  }
  const a = b.dataset.act;
  switch (a) {
    case 'auth-tab':
      authTab = b.dataset.tab;
      renderAuth();
      break;
    case 'overlay':
      if (e.target === b) {
        closeModal();
        onSettingsClosed();
      }
      break;
    case 'close':
      closeModal();
      onSettingsClosed();
      break;
    case 'join':
      if (st.roomId === b.dataset.room) {
        st.focus = null;
        renderStage();
      } else joinRoom(b.dataset.room);
      break;
    case 'leave':
      leaveRoom();
      break;
    case 'mute':
      toggleMute();
      break;
    case 'deafen':
      toggleDeafen();
      break;
    case 'share':
      if (st.sharing) stopShare();
      else openSharePicker();
      break;
    case 'toggle-sb':
      st.showSB = !st.showSB;
      renderSoundboard();
      renderControls();
      break;
    case 'settings':
      openSettings();
      break;
    case 'set-tab':
      if (meterRaf) cancelAnimationFrame(meterRaf);
      openSettings(b.dataset.tab);
      break;
    case 'toggle-mode':
      S.mode = S.mode === 'motion' ? 'detail' : 'motion';
      saveSettings();
      b.classList.toggle('on', S.mode === 'motion');
      break;
    case 'add-room':
      promptText('Nova sala', '', (v) => B.createRoom(st.view, v, st.rooms.length + 1));
      break;
    case 'view':
      if (b.dataset.view !== st.view) setView(b.dataset.view);
      break;
    case 'go-call':
      if (st.roomServerId) setView(st.roomServerId);
      break;
    case 'home-tab':
      st.homeTab = b.dataset.tab;
      renderHead();
      renderStage();
      break;
    case 'add-server':
      openServerModal();
      break;
    case 'server-menu':
      serverMenu(b);
      break;
    case 'invite':
      openInviteModal();
      break;
    case 'invite-to':
      inviteFriendPicker(b.dataset.uid);
      break;
    case 'send-invite': {
      const sv = st.servers.find((x) => x.id === (b.dataset.server || st.view));
      if (!sv) break;
      b.disabled = true;
      await B.notify({ to: b.dataset.uid, from: st.user.uid, fromName: st.me.name, type: 'server-invite', serverId: sv.id, serverName: sv.name }).catch((err) => toast(B.friendlyError(err), true));
      b.textContent = 'Convidado!';
      break;
    }
    case 'copy-code':
      navigator.clipboard.writeText(b.dataset.code).then(() => toast('Código copiado!'));
      break;
    case 'add-friend': {
      const uid = b.dataset.uid;
      b.disabled = true;
      await B.addFriend(st.user.uid, uid).catch((err) => toast(B.friendlyError(err), true));
      B.notify({ to: uid, from: st.user.uid, fromName: st.me.name, type: 'friend' }).catch(() => {});
      toast('Amigo adicionado!');
      break;
    }
    case 'remove-friend':
      confirmBox(`Remover ${st.members.get(b.dataset.uid)?.name || 'amigo'} dos amigos?`, () => B.removeFriend(st.user.uid, b.dataset.uid), 'Remover');
      break;
    case 'accept-invite': {
      const n = st.notifications.find((x) => x.id === b.dataset.id);
      if (!n) break;
      try {
        await B.joinServer(n.serverId, st.user.uid);
        await B.dismissNotification(n.id);
        toast(`Você entrou em ${n.serverName}!`);
        setView(n.serverId);
      } catch (err) {
        toast('Esse servidor não existe mais.', true);
        B.dismissNotification(n.id).catch(() => {});
      }
      break;
    }
    case 'accept-friend': {
      const n = st.notifications.find((x) => x.id === b.dataset.id);
      if (!n) break;
      await B.addFriend(st.user.uid, n.from).catch(() => {});
      await B.dismissNotification(n.id).catch(() => {});
      break;
    }
    case 'dismiss':
      B.dismissNotification(b.dataset.id).catch(() => {});
      break;
    case 'sound':
      clickSound(b.dataset.id);
      break;
    case 'upload-sound':
      openUploadSound();
      break;
    case 'stop-sounds':
      out.stopSounds();
      break;
    case 'fullscreen': {
      e.stopPropagation();
      const tile = b.closest('.tile');
      if (document.fullscreenElement) document.exitFullscreen();
      else tile.requestFullscreen().catch(() => {});
      break;
    }
    case 'logout':
      closeModal();
      await teardown();
      await B.logout();
      break;
    case 'save-nick': {
      const v = $('#nick').value.trim();
      if (!v) return;
      await B.updateMember(st.user.uid, { name: v.slice(0, 32) }).catch((err) => toast(B.friendlyError(err), true));
      st.me.name = v.slice(0, 32);
      st.presenceObj.set({ name: st.me.name });
      toast('Apelido salvo!');
      break;
    }
    case 'set-color':
      await B.updateMember(st.user.uid, { color: b.dataset.color }).catch(() => {});
      st.me.color = b.dataset.color;
      st.presenceObj.set({ color: b.dataset.color });
      openSettings('account');
      break;
    case 'install-update':
      bridge.installUpdate();
      break;
    case 'check-update': {
      b.disabled = true;
      const r = await bridge.checkUpdate();
      b.disabled = false;
      toast(r.ok ? (r.version ? `Última versão: ${r.version}` : 'Tudo atualizado.') : 'Não deu pra verificar agora.');
      break;
    }
  }
});

document.addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.tile.screen');
  if (!tile) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else tile.requestFullscreen().catch(() => {});
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.screenvol !== undefined) {
    const uid = t.dataset.screenvol;
    S.screenVolumes[uid] = +t.value;
    saveSettings();
    out.setTrackVolume(t.dataset.sid + ':screen', +t.value);
  } else if (t.dataset.sfxvol !== undefined) {
    S.sfxVolume = +t.value;
    saveSettings();
    out.setSfxVolume(S.sfxVolume);
  }
});

document.addEventListener('contextmenu', (e) => {
  const snd = e.target.closest('.sound');
  if (snd) return soundMenu(e, snd.dataset.id);
  const room = e.target.closest('.room');
  if (room) return roomMenu(e, room.dataset.room);
  const who = e.target.closest('[data-sid]');
  if (who) return personMenu(e, who.dataset.sid);
});

// destrava o áudio no primeiro clique
document.addEventListener('pointerdown', () => out.resume(), { once: true });
