// Especial Caçamba dos Cria — interface
import * as B from './backend.js';
import { MicPipeline, OutputMixer } from './audio.js';
import { Mesh, SCREEN_PRESETS } from './rtc.js';
import { icon } from './icons.js';
import { Sfx } from './sfx.js';
import { createMusicBot, parseCommand, isBotActive, fmtDur } from './bot.js';

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
  checkUpdate: async () => ({ state: 'dev' }),
  updateState: async () => ({ state: 'dev' }),
  setFullscreen: async () => false,
  onFullscreen: () => {},
  onShortcut: () => {},
  onUpdate: () => {},
  platform: 'web',
};
const root = $('#root');
const modalRoot = $('#modal-root');

// ---------------------------------------------------------------- configurações
const DEFAULTS = {
  camDevice: '',
  camDeviceLabel: '',
  inputDevice: 'default',
  inputDeviceLabel: '',
  outputDevice: 'default',
  outputDeviceLabel: '',
  startFullscreen: false,
  inputVolume: 100,
  outputVolume: 100,
  sfxVolume: 70,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  gateEnabled: false,
  aiNoise: true,
  voiceFilter: '', // '' = voz normal, 'autotune', 'ai:<id>' (voz com IA)
  vozF0: 0, // tom médio da sua voz (aprendido sozinho pelas vozes com IA)
  settingsVersion: 4,
  gateThreshold: -50,
  quality: '1080p60',
  mode: 'motion',
  shareAudio: true,
  codec: 'h264',
  uiSounds: true,
  userVolumes: {},
  screenVolumes: {},
  botVolume: 70,
  turnUrl: '',
  turnUser: '',
  turnPass: '',
};
let S = { ...DEFAULTS };
try {
  S = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('cacamba.settings') || '{}') };
} catch (_) {}
// v1.0.1: processamento de voz passa a vir desligado (microfone limpo); migra quem veio da 1.0.0
if ((S.settingsVersion || 1) < 2) {
  Object.assign(S, { echoCancellation: false, noiseSuppression: false, autoGainControl: false, gateEnabled: false, settingsVersion: 2 });
  try {
    localStorage.setItem('cacamba.settings', JSON.stringify(S));
  } catch (_) {}
}
if (S.settingsVersion < 3) {
  Object.assign(S, { shareAudio: true, settingsVersion: 3 });
  try {
    localStorage.setItem('cacamba.settings', JSON.stringify(S));
  } catch (_) {}
}
if (S.settingsVersion < 4) {
  Object.assign(S, { aiNoise: true, settingsVersion: 4 });
  try {
    localStorage.setItem('cacamba.settings', JSON.stringify(S));
  } catch (_) {}
}
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
  cam: false,
  camStream: null,
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
  mode: 'chat', // no servidor: 'chat' (canal de texto) ou 'stage' (chamada)
  textId: null, // canal de texto aberto
  msgs: [],
  msgCh: null,
  msgUnsub: null,
  bot: null, // estado do bot de música do servidor aberto
  botServer: null,
  botUnsub: null,
  ephemeral: [], // avisos que só eu vejo no chat
  botRunsOpen: new Set(), // blocos de conversa do bot que eu abri
  pendingFiles: [], // anexos esperando enviar
  musResults: [],
};
let mic = null;
let mesh = null;
const out = new OutputMixer();
const bot = createMusicBot({
  B,
  bridge,
  out,
  st,
  S,
  getMesh: () => mesh,
  onChange: () => {
    renderBotBar();
    renderSidebar();
  },
  roomName: (id) => st.rooms.find((r) => r.id === id)?.name || 'canal',
});
out.setVolume(S.outputVolume);
out.setSfxVolume(S.sfxVolume);
applyOutputDevice();
const sfx = new Sfx(out);
const soundCache = new Map();
let registering = false;
let lastSfx = 0;

// alto-falante salvo: tenta pelo ID e, se o Windows trocou o ID, acha pelo nome
async function applyOutputDevice() {
  let id = S.outputDevice;
  if (id && id !== 'default' && S.outputDeviceLabel) {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const outs = devs.filter((d) => d.kind === 'audiooutput');
      if (outs.length && outs.some((d) => d.label) && !outs.find((d) => d.deviceId === id)) {
        const byLabel = outs.find((d) => d.label === S.outputDeviceLabel);
        if (byLabel) {
          id = byLabel.deviceId;
          S.outputDevice = id;
          saveSettings();
        }
      }
    } catch (_) {}
  }
  await out.setSink(id);
  if (mic && mic.monitoring) mic.setMonitor(true, id);
}

// ---------------------------------------------------------------- tela cheia
let isFullscreen = false;
function renderFsButton() {
  const b = $('#fs-btn');
  if (b) {
    b.innerHTML = icon(isFullscreen ? 'fullExit' : 'full', 'sm');
    b.title = isFullscreen ? 'Sair da tela cheia (F11)' : 'Tela cheia (F11)';
  }
}
function renderWinCtl() {
  document.body.classList.toggle('fs', isFullscreen);
  const c = $('#win-ctl');
  if (c && !c.dataset.ready) {
    const [mn, fs, x] = c.querySelectorAll('button');
    mn.innerHTML = icon('minimize', 'sm');
    fs.innerHTML = icon('fullExit', 'sm');
    x.innerHTML = icon('close', 'sm');
    c.dataset.ready = '1';
  }
}
bridge.isFullscreen?.().then((on) => {
  isFullscreen = !!on;
  renderFsButton();
  renderWinCtl();
});
bridge.onFullscreen((on) => {
  isFullscreen = on;
  renderFsButton();
  renderWinCtl();
});
if (S.startFullscreen) bridge.setFullscreen(true);
renderFsButton();

// ---------------------------------------------------------------- helpers de UI
function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

const initials = (name) => (name || '?').trim().charAt(0).toUpperCase();
// uid opcional: se a pessoa tiver foto de perfil, mostra a foto no lugar da inicial
const photoOf = (uid) => (uid && (uid === st.user?.uid ? st.me?.photo : st.members.get(uid)?.photo)) || '';
const titleOf = (uid) => (uid && (uid === st.user?.uid ? st.me?.title : st.members.get(uid)?.title)) || '';
function avatar(name, color, speakKey = '', extra = '', uid = '') {
  const sp = speakKey && st.speaking.has(speakKey) ? ' speaking' : '';
  const ph = photoOf(uid);
  return `<div class="avatar${sp} ${extra}" ${speakKey ? `data-speak="${speakKey}"` : ''} style="background:${esc(color || '#f0b232')}">${ph ? `<img src="${esc(ph)}" alt=""/>` : esc(initials(name))}</div>`;
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
  B.ensureNickClaim(st.user.uid, me.name)
    .then((r) => {
      if (r === 'taken') toast(`Teu apelido "${me.name}" tá repetido com outra conta. Troca em Configurações → Minha conta pra poder editar o perfil.`, true);
    })
    .catch((e) => console.warn('apelido', e));
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
    st.textId = null;
    st.mode = st.roomId && st.roomServerId === view ? 'stage' : 'chat';
    B.ensureGeral(view).catch((e) => console.warn('geral', e));
    if (st.botUnsub) st.botUnsub();
    st.bot = null;
    st.botServer = view;
    st.botUnsub = B.watchBot(view, (b) => {
      if (st.botServer !== view) return;
      st.bot = b;
      renderBotBar();
      renderSidebar();
      updateMusicModal();
    });
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
    cam: st.cam,
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

// TURN (repetidor) vem do site na Vercel; guarda por 6h. Sem ele, só conexão direta.
const TURN_URL = 'https://especial-cacamba.vercel.app/api/turn';
let turnCache = { at: 0, list: [] };
async function fetchTurn() {
  if (Date.now() - turnCache.at < 6 * 3600_000 && turnCache.list.length) return turnCache.list;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch(TURN_URL, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    const j = await r.json();
    turnCache = { at: Date.now(), list: Array.isArray(j.iceServers) ? j.iceServers : [] };
  } catch (e) {
    console.warn('turn', e);
  }
  return turnCache.list;
}

function iceServers(extra = []) {
  const list = [...extra,
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
    mic.onDeviceFixed = (id) => {
      S.inputDevice = id;
      saveSettings();
    };
    mic.onVoiceInfo = (i) => {
      if (!S.vozF0 || Math.abs(12 * Math.log2(i.userF0 / S.vozF0)) > 0.5) {
        S.vozF0 = Math.round(i.userF0);
        saveSettings();
      }
    };
    await mic.start();
    mic.setMuted(st.muted || st.deafened);
    checkVoiceError();
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
    iceServers: iceServers(await fetchTurn()),
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
      out.removeTrack(sid + ':bot');
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
  if (bot.amHost()) await bot.stop().catch(() => {});
  if (st.sharing) await stopShare(true);
  if (st.cam) await stopCam(true);
  if (mesh) mesh.closeAll();
  mesh = null;
  out.removeAll();
  st.remote.clear();
  st.conn = {};
  st.mode = 'chat';
  st.ping = {};
  st.roomId = null;
  st.roomServerId = null;
  st.focus = null;
  st.prevRoomSids = new Set();
  if (mic) {
    mic.destroy();
    mic = null;
  }
  if (st.presenceObj) await st.presenceObj.set({ roomId: null, serverId: null, sharing: false, cam: false });
  if (!silent) {
    blip('leave-self');
    renderMain();
  }
  setTimeout(maybeAutoInstall, 1500);
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
  } else if (role === 'bot') {
    out.addTrack(sid + ':bot', track, S.botVolume ?? 70);
  } else if (role === 'cam') {
    r.cam = track;
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

// ---------------------------------------------------------------- webcam
async function openCamStream() {
  const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  if (S.camDevice) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { ...base, deviceId: { exact: S.camDevice } }, audio: false });
    } catch (_) {
      // o ID mudou (outra porta USB): tenta achar pelo nome, senão usa a padrão
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const byLabel = devs.find((d) => d.kind === 'videoinput' && d.label && d.label === S.camDeviceLabel);
        if (byLabel) return await navigator.mediaDevices.getUserMedia({ video: { ...base, deviceId: { exact: byLabel.deviceId } }, audio: false });
      } catch (_) {}
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: base, audio: false });
}

async function startCam() {
  if (!st.roomId || !mesh || st.cam) return;
  let stream;
  try {
    stream = await openCamStream();
  } catch (e) {
    console.error(e);
    const msg =
      e && e.name === 'NotFoundError'
        ? 'Nenhuma webcam encontrada.'
        : e && e.name === 'NotReadableError'
          ? 'A webcam está sendo usada por outro programa.'
          : 'Não consegui abrir a webcam.';
    return toast(msg, true);
  }
  if (!st.roomId || !mesh) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = 'motion';
  vt.addEventListener('ended', () => stopCam());
  st.camStream = stream;
  st.cam = true;
  mesh.setCamTrack(vt);
  if (st.presenceObj) await st.presenceObj.set({ cam: true });
  renderStage();
  renderControls();
  renderSidebar();
}

async function stopCam(silent = false) {
  if (!st.cam) return;
  st.cam = false;
  if (st.camStream) st.camStream.getTracks().forEach((t) => t.stop());
  st.camStream = null;
  if (st.focus === 'p:' + st.sid) st.focus = null;
  if (mesh) mesh.setCamTrack(null);
  if (st.presenceObj) await st.presenceObj.set({ cam: false });
  if (!silent) {
    renderStage();
    renderControls();
    renderSidebar();
  }
}

// trocou a câmera nas configurações com ela ligada: troca na hora
async function switchCam() {
  if (!st.cam || !mesh) return;
  try {
    const stream = await openCamStream();
    const vt = stream.getVideoTracks()[0];
    vt.contentHint = 'motion';
    vt.addEventListener('ended', () => stopCam());
    if (st.camStream) st.camStream.getTracks().forEach((t) => t.stop());
    st.camStream = stream;
    mesh.setCamTrack(vt);
    renderStage();
  } catch (e) {
    console.error(e);
    toast('Não consegui trocar a webcam.', true);
  }
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
    out.playBuffer(buf, snd.volume ?? 100, snd.start || 0, snd.end || null);
    const el = $(`.sound[data-id="${id}"]`);
    if (el) {
      el.classList.add('playing');
      const len = (snd.end || buf.duration) - (snd.start || 0);
      setTimeout(() => el.classList.remove('playing'), Math.min(len * 1000, 4000));
    }
    if (fromName) sfxPop(`${fromName} tocou 🔊 ${snd.name}`);
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

// ---------------------------------------------------------------- soundboard (por servidor)
const sbServer = () => (st.view !== 'home' ? st.view : st.roomServerId || null);
const visibleSounds = () => {
  const sv = sbServer();
  return st.sounds.filter((x) => (x.serverId ? x.serverId === sv : true));
};

// capa embutida no MP3 (ID3v2 APIC), se tiver
function id3Cover(ab) {
  const b = new Uint8Array(ab);
  if (b.length < 20 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
  const ver = b[3];
  const syn = (o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
  const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const end = Math.min(10 + syn(6), b.length);
  let p = 10;
  if (b[5] & 0x40) p += ver === 4 ? syn(10) : u32(10) + 4;
  while (p + 10 < end) {
    const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fs = ver === 4 ? syn(p + 4) : u32(p + 4);
    const fe = Math.min(p + 10 + fs, end);
    if (id === 'APIC') {
      let q = p + 10;
      const enc = b[q++];
      let mime = '';
      while (q < fe && b[q]) mime += String.fromCharCode(b[q++]);
      q += 2; // fim do mime + tipo da imagem
      if (enc === 1 || enc === 2) {
        while (q + 1 < fe && !(b[q] === 0 && b[q + 1] === 0)) q += 2;
        q += 2;
      } else {
        while (q < fe && b[q]) q++;
        q++;
      }
      return q < fe ? new Blob([b.slice(q, fe)], { type: mime.includes('/') ? mime : 'image/jpeg' }) : null;
    }
    p += 10 + fs;
  }
  return null;
}

// imagem -> quadradinho JPEG (corte no centro)
async function squareThumb(blobOrUrl, size = 128) {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    if (typeof blobOrUrl !== 'string') URL.revokeObjectURL(url);
  }
}

const soundIcon = (snd) =>
  snd && snd.img ? `<img src="${esc(snd.img)}" alt=""/>` : `<span class="mp3">${icon('music', 'sm')}<i>MP3</i></span>`;

function drawWave(canvas, buf, start, end) {
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  g.clearRect(0, 0, W, H);
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / W));
  const a = (start / buf.duration) * W;
  const b = (end / buf.duration) * W;
  g.fillStyle = 'rgba(255,178,30,.12)';
  g.fillRect(a, 0, b - a, H);
  for (let x = 0; x < W; x++) {
    let mx = 0;
    for (let i = x * step, e = Math.min(data.length, i + step); i < e; i += 4) mx = Math.max(mx, Math.abs(data[i]));
    const h = Math.max(1, mx * H * 0.95);
    g.fillStyle = x >= a && x <= b ? '#ffb21e' : '#4e5058';
    g.fillRect(x, (H - h) / 2, 1, h);
  }
  g.fillStyle = '#fff';
  g.fillRect(a, 0, 2, H);
  g.fillRect(b - 2, 0, 2, H);
}

// janela de corte: escolhe o pedaço do áudio que toca (máx. 30 s)
function trimControls(buf, start, end) {
  const dur = buf.duration;
  start = Math.max(0, Math.min(start || 0, dur));
  end = end && end > start ? Math.min(end, dur) : Math.min(dur, start + 30);
  const html = `
    <div class="trim">
      <canvas id="tw" width="560" height="80"></canvas>
      <div class="field"><label>Começo: <b id="ts"></b></label><input type="range" id="tr-s" min="0" max="${dur.toFixed(2)}" step="0.05" value="${start}"/></div>
      <div class="field"><label>Fim: <b id="te"></b></label><input type="range" id="tr-e" min="0" max="${dur.toFixed(2)}" step="0.05" value="${end}"/></div>
      <div class="row"><button type="button" class="btn" id="tr-play">${icon('play', 'sm')} Ouvir o trecho</button><span class="muted" id="tlen"></span></div>
    </div>`;
  const bind = (root) => {
    const sI = $('#tr-s', root);
    const eI = $('#tr-e', root);
    const cv = $('#tw', root);
    const upd = (who) => {
      let a = +sI.value;
      let b = +eI.value;
      if (b <= a + 0.1) {
        if (who === 's') a = Math.max(0, b - 0.1);
        else b = Math.min(dur, a + 0.1);
      }
      if (b - a > 30) {
        if (who === 's') b = a + 30;
        else a = b - 30;
      }
      sI.value = a;
      eI.value = b;
      start = a;
      end = b;
      $('#ts', root).textContent = a.toFixed(1) + 's';
      $('#te', root).textContent = b.toFixed(1) + 's';
      $('#tlen', root).textContent = `Trecho de ${(b - a).toFixed(1)}s (de ${dur.toFixed(1)}s)`;
      drawWave(cv, buf, a, b);
    };
    sI.addEventListener('input', () => upd('s'));
    eI.addEventListener('input', () => upd('e'));
    $('#tr-play', root).addEventListener('click', () => {
      out.stopSounds();
      out.playBuffer(buf, 100, start, end);
    });
    upd('e');
  };
  return { html, bind, get: () => ({ start: +start.toFixed(2), end: +end.toFixed(2), full: start <= 0.01 && end >= dur - 0.01 }) };
}

function openUploadSound() {
  const sv = sbServer();
  if (!sv) return toast('Abre um servidor primeiro: os sons ficam salvos por servidor.', true);
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,.mp3,.wav,.ogg,.m4a';
  input.multiple = true;
  input.onchange = async () => {
    if (input.files.length > 1) return openBatchSounds(sv, [...input.files]);
    const file = input.files[0];
    if (!file) return;
    if (file.size > 700 * 1024) return toast('Arquivo muito grande (máx. 700 KB). Corta o áudio antes ou usa um MP3 menor.', true);
    let buf;
    const ab = await file.arrayBuffer();
    try {
      buf = await out.decode(ab.slice(0));
    } catch (_) {
      return toast('Formato de áudio não suportado.', true);
    }
    let img = null;
    try {
      const cover = id3Cover(ab);
      if (cover) img = await squareThumb(cover);
    } catch (_) {}
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const base = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
    const trim = trimControls(buf, 0, Math.min(buf.duration, 30));
    const svName = st.servers.find((x) => x.id === sv)?.name || '';
    const m = openModal(
      `
      <div class="modal-head"><h3>Novo som em ${esc(svName)}</h3><button class="ibtn" data-act="close">${icon('close')}</button></div>
      <form id="snd-form" class="modal-body">
        <div class="row" style="align-items:flex-start;gap:14px">
          <div class="snd-cover" id="snd-cover">${soundIcon({ img })}</div>
          <div class="grow">
            <div class="field"><label>Nome</label><input type="text" name="name" maxlength="40" required value="${esc(base)}"/></div>
            <div class="row"><button type="button" class="btn ghost" id="snd-img">${icon('image', 'sm')} Trocar imagem</button><button type="button" class="btn ghost" id="snd-img-x">Sem imagem</button></div>
          </div>
        </div>
        <div class="label">Pedaço que vai tocar</div>
        ${trim.html}
        <div class="field"><label>Volume do som: <span id="sv">100</span>%</label><input type="range" name="volume" min="10" max="200" value="100"/></div>
        <div class="hint">Fica salvo no servidor ${esc(svName)}: todo mundo de lá vê e pode tocar. ${(file.size / 1024).toFixed(0)} KB</div>
      </form>
      <div class="modal-foot"><button class="btn ghost" data-act="close">Cancelar</button><button class="btn primary" id="snd-save">${icon('upload', 'sm')} Enviar</button></div>`,
      { wide: true }
    );
    const f = $('#snd-form');
    trim.bind(m);
    const setImg = (v) => {
      img = v;
      $('#snd-cover').innerHTML = soundIcon({ img });
    };
    $('#snd-img').addEventListener('click', () => {
      const i2 = document.createElement('input');
      i2.type = 'file';
      i2.accept = 'image/*';
      i2.onchange = async () => i2.files[0] && setImg(await squareThumb(i2.files[0]).catch(() => img));
      i2.click();
    });
    $('#snd-img-x').addEventListener('click', () => setImg(null));
    f.volume.addEventListener('input', () => ($('#sv').textContent = f.volume.value));
    $('#snd-save').addEventListener('click', async (e) => {
      const d = Object.fromEntries(new FormData(f));
      if (!d.name.trim()) return;
      const t = trim.get();
      e.target.disabled = true;
      e.target.textContent = 'Enviando...';
      try {
        await B.uploadSound({
          uid: st.user.uid,
          name: d.name.trim(),
          emoji: '🔊',
          dataUrl,
          volume: +d.volume,
          serverId: sv,
          img,
          start: t.full ? 0 : t.start,
          end: t.full ? null : t.end,
        });
        out.stopSounds();
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

// vários sons de uma vez: cada um com nome e capa; os longos tocam os primeiros 30 s (dá pra cortar depois)
async function openBatchSounds(sv, files) {
  const svName = st.servers.find((x) => x.id === sv)?.name || '';
  const items = files.slice(0, 30).map((file) => ({ file, name: file.name.replace(/\.[^.]+$/, '').slice(0, 40), state: 'lendo' }));
  if (files.length > 30) toast('Máximo de 30 sons por vez: peguei os 30 primeiros.');
  const m = openModal(
    `<div class="modal-head"><h3>${items.length} sons novos em ${esc(svName)}</h3><button class="ibtn" data-act="close">${icon('close')}</button></div>
     <div class="modal-body"><div class="batch-list" id="batch-list"></div>
       <div class="hint">Dá pra mudar o nome de cada um aqui. No ✂ você escolhe o pedaço que toca de cada som (sem escolher, toca do começo, até 30 s).</div></div>
     <div class="modal-foot"><span class="muted grow" id="batch-sum"></span><button class="btn ghost" data-act="close">Cancelar</button><button class="btn primary" id="batch-save" disabled>${icon('upload', 'sm')} Enviar todos</button></div>`,
    { wide: true }
  );
  const list = $('#batch-list', m);
  const row = (it, i) => `
    <div class="batch-row ${it.state === 'erro' ? 'bad' : ''}" data-i="${i}">
      <div class="batch-cover">${soundIcon({ img: it.img })}</div>
      <input type="text" maxlength="40" value="${esc(it.name)}" data-bname="${i}" ${it.state === 'erro' || it.state === 'ok' ? 'disabled' : ''}/>
      <span class="batch-info">${
        it.state === 'lendo'
          ? 'Lendo...'
          : it.state === 'erro'
            ? esc(it.err)
            : it.state === 'enviando'
              ? 'Enviando...'
              : it.state === 'ok'
                ? '✓ Enviado'
                : it.cut
                  ? `trecho ${it.start.toFixed(1)}–${it.end.toFixed(1)}s`
                  : `${it.dur.toFixed(1)}s${it.dur > 30 ? ' (toca 30s)' : ''} · ${Math.round(it.file.size / 1024)} KB`
      }</span>
      <button class="ibtn ${openTrim === i ? 'on' : ''}" data-btrim="${i}" title="Escolher o trecho" ${it.state === 'pronto' ? '' : 'disabled'}>${icon('cut', 'sm')}</button>
      <button class="ibtn" data-bplay="${i}" title="Ouvir" ${it.buf ? '' : 'disabled'}>${icon('play', 'sm')}</button>
      <button class="ibtn" data-brm="${i}" title="Tirar da lista" ${it.state === 'ok' || it.state === 'enviando' ? 'disabled' : ''}>${icon('close', 'sm')}</button>
    </div>${openTrim === i && it.buf ? `<div class="batch-trim" id="batch-trim"></div>` : ''}`;
  let openTrim = -1;
  const draw = () => {
    list.innerHTML = items.map((it, i) => (it.removed ? '' : row(it, i))).join('');
    // editor de trecho do som aberto (um por vez)
    const box = $('#batch-trim', list);
    if (box && openTrim >= 0) {
      const it = items[openTrim];
      const tc = trimControls(it.buf, it.start || 0, it.end || Math.min(it.dur, 30));
      box.innerHTML = tc.html + `<div class="row" style="justify-content:flex-end;margin-top:6px"><button type="button" class="btn ghost" data-btrim-reset="1">Som inteiro</button><button type="button" class="btn primary" data-btrim-ok="1">Pronto</button></div>`;
      tc.bind(box);
      const save = () => {
        const t = tc.get();
        it.start = t.start;
        it.end = t.end;
        it.cut = !t.full;
        const info = list.querySelector(`.batch-row[data-i="${openTrim}"] .batch-info`);
        if (info) info.textContent = it.cut ? `trecho ${it.start.toFixed(1)}–${it.end.toFixed(1)}s` : `${it.dur.toFixed(1)}s`;
      };
      box.querySelectorAll('input[type=range]').forEach((r) => r.addEventListener('input', save));
      save();
    }
    const ready = items.filter((it) => !it.removed && it.state === 'pronto');
    const btn = $('#batch-save', m);
    if (btn) btn.disabled = !ready.length || items.some((it) => it.state === 'lendo' || it.state === 'enviando');
    const sum = $('#batch-sum', m);
    if (sum) sum.textContent = `${ready.length} pronto(s) pra enviar`;
  };
  draw();
  list.addEventListener('input', (e) => {
    const i = e.target.dataset.bname;
    if (i != null) items[+i].name = e.target.value;
  });
  list.addEventListener('click', (e) => {
    const tb = e.target.closest('[data-btrim]');
    if (tb) {
      out.stopSounds();
      openTrim = openTrim === +tb.dataset.btrim ? -1 : +tb.dataset.btrim;
      return draw();
    }
    if (e.target.closest('[data-btrim-ok]')) {
      out.stopSounds();
      openTrim = -1;
      return draw();
    }
    if (e.target.closest('[data-btrim-reset]')) {
      const it = items[openTrim];
      it.start = 0;
      it.end = Math.min(it.dur, 30);
      it.cut = false;
      return draw();
    }
    const pl = e.target.closest('[data-bplay]');
    const rm = e.target.closest('[data-brm]');
    if (pl) {
      const it = items[+pl.dataset.bplay];
      out.stopSounds();
      out.playBuffer(it.buf, 100, it.start || 0, it.end || Math.min(it.dur, 30));
    }
    if (rm) {
      items[+rm.dataset.brm].removed = true;
      draw();
    }
  });
  // lê os arquivos um por um (decodifica, acha a capa)
  for (const it of items) {
    if (it.file.size > 700 * 1024) {
      Object.assign(it, { state: 'erro', err: 'Maior que 700 KB' });
      draw();
      continue;
    }
    try {
      const ab = await it.file.arrayBuffer();
      it.buf = await out.decode(ab.slice(0));
      it.dur = it.buf.duration;
      try {
        const cover = id3Cover(ab);
        if (cover) it.img = await squareThumb(cover);
      } catch (_) {}
      it.dataUrl = await readAsDataURL(it.file);
      it.state = 'pronto';
    } catch (_) {
      Object.assign(it, { state: 'erro', err: 'Formato não suportado' });
    }
    if (!document.body.contains(list)) return; // fechou a janela
    draw();
  }
  $('#batch-save', m).addEventListener('click', async () => {
    out.stopSounds();
    let ok = 0;
    for (const it of items) {
      if (it.removed || it.state !== 'pronto') continue;
      it.state = 'enviando';
      draw();
      try {
        await B.uploadSound({
          uid: st.user.uid,
          name: (it.name.trim() || 'Som').slice(0, 40),
          emoji: '🔊',
          dataUrl: it.dataUrl,
          volume: 100,
          serverId: sv,
          img: it.img || null,
          start: it.cut ? it.start : 0,
          end: it.cut ? it.end : it.dur > 30 ? 30 : null,
        });
        it.state = 'ok';
        ok++;
      } catch (err) {
        console.error(err);
        Object.assign(it, { state: 'erro', err: 'Falhou: ' + B.friendlyError(err) });
      }
      draw();
    }
    toast(`${ok} som(ns) adicionado(s)!`);
    if (items.every((it) => it.removed || it.state === 'ok')) closeModal();
  });
}

async function openTrimSound(id) {
  const snd = st.sounds.find((x) => x.id === id);
  if (!snd) return;
  let buf;
  try {
    buf = await loadSound(id);
  } catch (_) {
    return toast('Não consegui abrir esse som.', true);
  }
  const trim = trimControls(buf, snd.start || 0, snd.end || buf.duration);
  const m = openModal(
    `<div class="modal-head"><h3>Cortar "${esc(snd.name)}"</h3><button class="ibtn" data-act="close">${icon('close')}</button></div>
     <div class="modal-body">${trim.html}</div>
     <div class="modal-foot"><button class="btn ghost" data-act="close">Cancelar</button><button class="btn primary" id="trim-save">Salvar corte</button></div>`,
    { wide: true }
  );
  trim.bind(m);
  $('#trim-save').addEventListener('click', async () => {
    const t = trim.get();
    await B.updateSound(id, { start: t.full ? 0 : t.start, end: t.full ? null : t.end }).catch((e) => toast(B.friendlyError(e), true));
    out.stopSounds();
    closeModal();
    toast('Corte salvo!');
  });
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
      <div id="botbar"></div>
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
  renderBotBar();
  renderUpdate();
}

// sem foto: primeira e última letra da primeira palavra ("Caçamba dos Cria" -> "CA")
const serverInitials = (name) => {
  const w = (name || '?').trim().split(/\s+/)[0] || '?';
  const chars = [...w];
  return (chars[0] + (chars.length > 1 ? chars[chars.length - 1] : '')).toUpperCase();
};
const serverIcon = (sv) =>
  sv.icon
    ? `<img class="srv-img" src="${esc(sv.icon)}" alt=""/>`
    : `<span class="srv-stripes"><span>${esc(serverInitials(sv.name))}</span></span>`;

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
          ${serverIcon(sv)}${st.roomServerId === sv.id ? '<i class="dot"></i>' : ''}</button>`
      )
      .join('')}
    <button class="rail-btn add" data-act="add-server" title="Criar ou entrar num servidor">${icon('plus')}</button>`;
}

function flags(p) {
  return `<span class="flags">${p.sharing ? '<span class="live">AO VIVO</span>' : ''}${p.cam ? icon('cam', 'sm') : ''}${p.deafened ? icon('headsetOff', 'sm') : p.muted ? icon('micOff', 'sm') : ''}</span>`;
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
        ${friends.map((m) => `<div class="rm" data-uid="${m.id}">${avatar(m.name, m.color, '', '', m.id)}<span class="rm-who"><span class="ellipsis">${esc(m.name)}</span>${m.title ? `<small class="ellipsis">${esc(m.title)}</small>` : ''}</span><span class="flags"><i class="status ${on.has(m.id) ? 'on' : ''}"></i></span></div>`).join('') || '<div class="hint" style="padding:0 8px">Adicione a galera na aba Adicionar amigo.</div>'}
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
      <div class="rooms-title"><span class="label">Canais de texto</span><button data-act="add-text" title="Criar canal de texto">${icon('plus', 'sm')}</button></div>
      ${textRooms()
        .map((r) => `<div class="room text ${st.mode === 'chat' && currentText()?.id === r.id ? 'on' : ''}" data-act="open-text" data-room="${r.id}">${icon('hash', 'sm')}<span class="ellipsis">${esc(r.name)}</span></div>`)
        .join('')}
      <div class="rooms-title"><span class="label">Salas de voz</span><button data-act="add-room" title="Criar sala">${icon('plus', 'sm')}</button></div>
      ${voiceRooms()
        .map((r) => {
          const ms = roomMembers(r.id);
          return `<div class="room ${st.roomId === r.id && st.mode === 'stage' ? 'on' : ''} ${st.roomId === r.id ? 'joined' : ''}" data-act="join" data-room="${r.id}">${icon('voice', 'sm')}<span class="ellipsis">${esc(r.name)}</span>${ms.length ? `<span class="count">${ms.length}</span>` : ''}<button class="room-chat ${st.mode === 'chat' && currentText()?.id === r.id ? 'on' : ''}" data-act="open-text" data-room="${r.id}" title="Chat do canal ${esc(r.name)}">${icon('chat', 'sm')}</button></div>
          ${ms.length ? `<div class="room-members">${ms.map((p) => `<div class="rm" data-sid="${p.sid}">${avatar(p.name, p.color, p.sid, '', p.uid)}<span class="ellipsis">${esc(p.name)}</span>${flags(p)}</div>`).join('')}${isBotActive(st.bot) && st.bot.roomId === r.id ? `<div class="rm bot-rm" title="Botão direito: volume e controles do bot"><div class="avatar bot-av">${icon('music', 'sm')}</div><span class="ellipsis">Caçamba Bot</span><span class="bot-tag">BOT</span></div>` : ''}</div>` : ''}`;
        })
        .join('')}
    </div>
    <div class="online-list">
      <div class="label" style="margin-top:10px">Membros — ${svMembers.length}</div>
      ${svMembers.map((m) => `<div class="rm ${on.has(m.id) ? '' : 'offline'}" data-uid="${m.id}">${avatar(m.name, m.color, '', '', m.id)}<span class="rm-who"><span class="ellipsis">${esc(m.name)}${sv.ownerId === m.id ? ' 👑' : ''}</span>${m.title ? `<small class="ellipsis">${esc(m.title)}</small>` : ''}</span><span class="flags"><i class="status ${on.has(m.id) ? 'on' : ''}"></i></span></div>`).join('')}
    </div>`;
}

function renderUserPanel() {
  const el = $('#userpanel');
  if (!el || !st.me) return;
  const m = st.muted || st.deafened;
  el.innerHTML = `
    ${avatar(st.me.name, st.me.color, st.sid, '', st.user.uid)}
    <div class="who"><b class="ellipsis">${esc(st.me.name)}</b><small class="ellipsis">${st.roomId ? 'Em chamada' : esc(st.me.title || 'Online')}</small></div>
    <button class="ibtn ${m ? 'off' : ''}" data-act="mute" title="Mutar (Ctrl+Shift+M)">${icon(m ? 'micOff' : 'mic')}</button>
    <button class="ibtn ${st.deafened ? 'off' : ''}" data-act="deafen" title="Desativar áudio (Ctrl+Shift+D)">${icon(st.deafened ? 'headsetOff' : 'headset')}</button>
    <button class="ibtn" data-act="settings" title="Configurações">${icon('gear')}</button>`;
  const cb = $('#callbar');
  if (cb) {
    const sv = st.servers.find((x) => x.id === st.roomServerId);
    cb.innerHTML = st.roomId
      ? `<div class="callbar"><div class="grow"><b>Voz conectada</b><small class="ellipsis">${esc(st.roomName)} / ${esc(sv ? sv.name : '')}</small></div>
         <button class="ibtn ${S.voiceFilter ? 'fx-on' : ''}" data-act="voice-fx" title="${S.voiceFilter ? 'Filtro de voz: ' + esc(voiceName(S.voiceFilter)) : 'Filtros de voz'}">${icon('fx')}</button>
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
  const ch = st.mode === 'chat' ? currentText() : null;
  if (ch) {
    el.innerHTML = `${icon(isText(ch) ? 'hash' : 'voice')}<h2>${esc(ch.name)}</h2><span class="muted" style="font-size:12px">${ch.fixed ? 'Canal geral do servidor' : isText(ch) ? 'Canal de texto' : 'Chat do canal de voz'}</span><div class="grow"></div>
      <button class="btn ghost" data-act="music">${icon('music', 'sm')} Música</button>
      ${st.roomId ? `<button class="btn ghost" data-act="go-call">${icon('voice', 'sm')} Voltar pra chamada</button>` : ''}
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
  const failed = peers.some((s) => s === 'failed' || s === 'disconnected');
  const waiting = peers.length && peers.every((s) => s === 'new');
  const n = roomMembers(st.roomId).length;
  el.innerHTML = `${icon('voice')}<h2>${esc(room.name)}</h2>
    <span class="conn ${connecting ? 'warn' : ''}">${connecting ? (failed ? `Rede bloqueou a conexão com ${connecting}, tentando de novo...` : waiting ? `Esperando resposta de ${connecting}...` : `Conectando com ${connecting}...`) : 'Voz conectada'} • ${n} na sala</span>
    <div class="grow"></div>
    <button class="btn ghost" data-act="toggle-sb">${icon('sound', 'sm')} Soundboard</button>`;
}

function renderHome(el) {
  const on = onlineUids();
  const friendIds = new Set(st.me.friends || []);
  const card = (m, actions) => `<div class="friend" data-uid="${m.id}">${avatar(m.name, m.color, '', '', m.id)}<div class="grow"><b>${esc(m.name)}</b><small class="muted">${on.has(m.id) ? 'Online' : 'Offline'}${m.title ? ` · ${esc(m.title)}` : ''}</small></div>${actions}</div>`;
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
  if (!inCallHere() || st.mode !== 'stage') {
    el.innerHTML = '';
    return;
  }
  const m = st.muted || st.deafened;
  el.innerHTML = `
    <button class="cbtn ${m ? 'off' : ''}" data-act="mute" title="Ctrl+Shift+M">${icon(m ? 'micOff' : 'mic')}</button>
    <button class="cbtn ${st.deafened ? 'off' : ''}" data-act="deafen" title="Ctrl+Shift+D">${icon(st.deafened ? 'headsetOff' : 'headset')}</button>
 <button class="cbtn ${S.voiceFilter || st.showVoices ? 'on' : ''}" data-act="voice-fx" title="Filtros de voz">${icon('fx')}</button>
    <button class="cbtn ${st.cam ? 'on' : ''}" data-act="cam" title="${st.cam ? 'Desligar câmera' : 'Ligar câmera'}">${icon(st.cam ? 'cam' : 'camOff')}</button>
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
    el.innerHTML = `<video class="cam" autoplay playsinline muted></video><div class="av"></div><div class="tag"></div><span class="ping"></span>`;
  }
  return el;
}

// ---------------------------------------------------------------- canais de texto
const isText = (r) => r.type === 'text';
const textRooms = () => st.rooms.filter(isText);
const voiceRooms = () => st.rooms.filter((r) => !isText(r));
function currentText() {
  const list = textRooms();
  return st.rooms.find((r) => r.id === st.textId) || list.find((r) => r.fixed) || list[0] || null;
}

function stopChat() {
  if (st.msgUnsub) st.msgUnsub();
  st.msgUnsub = null;
  st.msgCh = null;
  st.msgs = [];
}

function renderChat(el) {
  const ch = currentText();
  if (st.msgCh !== ch.id) {
    stopChat();
    st.msgCh = ch.id;
    st.msgUnsub = B.watchMessages(ch.id, (list) => {
      if (st.msgCh !== ch.id) return;
      st.msgs = list;
      renderMessages();
    });
  }
  const box = el.querySelector('.chat');
  if (box && box.dataset.ch === ch.id) return; // já está montado: não apaga o que a pessoa está digitando
  el.innerHTML = `<div class="chat" data-ch="${ch.id}">
    <div class="msgs" id="msgs"><div class="hint" style="padding:20px">Carregando...</div></div>
    <div class="pending-files" id="pending-files"></div>
    <form class="composer" id="composer">
      <button class="ibtn" type="button" data-act="attach" title="Anexar imagem ou arquivo">${icon('attach')}</button>
      <textarea id="msg-input" rows="1" maxlength="2000" placeholder="Conversar em ${isText(ch) ? '#' : '🔊 '}${esc(ch.name)}  ·  /ajuda pros comandos do bot"></textarea>
      <button class="ibtn" type="button" data-act="music" title="Bot de música">${icon('music')}</button>
      <button class="ibtn" type="submit" data-act="send-msg" title="Enviar (Enter)">${icon('send')}</button>
    </form>
  </div>`;
  const ta = el.querySelector('#msg-input');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  });
  el.querySelector('#composer').addEventListener('submit', (e) => e.preventDefault());
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  const chatEl = el.querySelector('.chat');
  chatEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    chatEl.classList.add('drop');
  });
  chatEl.addEventListener('dragleave', (e) => {
    if (!chatEl.contains(e.relatedTarget)) chatEl.classList.remove('drop');
  });
  chatEl.addEventListener('drop', (e) => {
    e.preventDefault();
    chatEl.classList.remove('drop');
    addFiles([...(e.dataTransfer?.files || [])]);
  });
  st.pendingFiles = [];
  renderPending();
  renderMessages();
  setTimeout(() => ta.focus(), 0);
}

// links: com http(s)://, www., ou só domínio (site.com.br, algo.app, x.me/abc...) viram botão que abre o navegador
const TLDS = 'com|br|net|org|me|app|io|gg|tv|dev|xyz|co|info|online|site|store|link|ly|to|be|us|uk|pt|ai|so|fm|live|games|club|shop|blog|page|edu|gov|win|fun|top|art|pro|biz|cc|ws|in|es|fr|de|it|jp|ar|cl|mx';
const LINK_RE = new RegExp(String.raw`\b((?:https?:\/\/|www\.)[^\s<]+|(?:[a-z0-9-]+\.)+(?:${TLDS})\b(?:\/[^\s<]*)?)`, 'gi');
const linkify = (text) =>
  esc(text).replace(LINK_RE, (m, _g, at, all) => {
    if (all[at - 1] === '@') return m; // e-mail, não link
    const trail = (m.match(/[.,!?;:)\]]+$/) || [''])[0];
    const u = trail ? m.slice(0, -trail.length) : m;
    if (/@/.test(u)) return m;
    const href = /^https?:\/\//i.test(u) ? u : 'https://' + u;
    return `<a href="#" data-act="open-link" data-url="${href}" title="${href}">${u}</a>${trail}`;
  });
const richText = (text) =>
  linkify(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
const fmtTime = (t) => {
  const d = new Date(t);
  const now = new Date();
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `hoje às ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `ontem às ${hm}`;
  return `${d.toLocaleDateString('pt-BR')} ${hm}`;
};

function renderMessages() {
  const box = $('#msgs');
  if (!box) return;
  const ch = currentText();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (!st.msgs.length) {
    box.innerHTML = `<div class="chat-empty">${icon('hash')}<h3>Bem-vindo ao #${esc(ch ? ch.name : '')}</h3><p>Ninguém falou nada ainda. Manda a primeira!</p></div>`;
    return;
  }
  let html = '';
  let prev = null;
  const eph = st.ephemeral.filter((e) => e.ch === ch.id);
  const all = [...st.msgs, ...eph.map((e) => ({ ...e, eph: true, bot: true, id: '' }))].sort((a, b) => a.time - b.time);
  // conversa do bot (respostas + comandos digitados) fica recolhida: só a última aparece
  const isBotTalk = (m) => !m.eph && (m.bot || (!m.files?.length && m.text && !!parseCommand(m.text)));
  const hidden = new Set();
  const runHead = new Map(); // índice da última msg do bloco -> { key, count, open }
  for (let i = 0; i < all.length; ) {
    if (!isBotTalk(all[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < all.length && isBotTalk(all[j + 1])) j++;
    if (j > i) {
      const key = all[i].id || String(all[i].time);
      const open = st.botRunsOpen.has(key);
      if (!open) for (let k = i; k < j; k++) hidden.add(k);
      runHead.set(open ? i : j, { key, count: j - i, open });
    }
    i = j + 1;
  }
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (hidden.has(i)) continue;
    const run = runHead.get(i);
    if (run) {
      html += `<button class="bot-more" data-act="bot-more" data-key="${esc(run.key)}">${icon('music', 'sm')}<span>${
        run.open ? '▾ Esconder a conversa com o bot' : `▸ ${run.count} ${run.count === 1 ? 'mensagem anterior' : 'mensagens anteriores'} do bot`
      }</span></button>`;
      prev = null;
    }
    const who = m.bot ? 'bot' : m.uid;
    const grouped = prev && prev.who === who && !m.eph && !prev.eph && m.time - prev.time < 5 * 60_000;
    const mem = m.bot ? null : st.members.get(m.uid);
    const name = m.bot ? 'Caçamba Bot' : mem?.name || m.name;
    const color = m.bot ? '#ffb21e' : mem?.color || m.color;
    const body = `${m.text ? `<div class="mtext">${richText(m.text)}</div>` : ''}${filesHtml(m)}${m.eph ? '<div class="eph-note">Só você vê isso</div>' : ''}`;
    const av = m.bot ? `<div class="avatar bot-av">${icon('music', 'sm')}</div>` : avatar(name, color, '', '', m.uid);
    const tag = m.bot ? '<span class="bot-tag">BOT</span>' : '';
    html += grouped
      ? `<div class="msg cont" data-id="${m.id}" data-uid="${m.uid}"><span class="mt">${new Date(m.time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>${body}</div>`
      : `<div class="msg ${m.eph ? 'eph' : ''}" ${m.id ? `data-id="${m.id}"` : ''} data-uid="${m.uid || ''}">${av}<div class="mbody"><div class="mhead"><b style="color:${esc(color || 'var(--text)')}">${esc(name)}</b>${tag}<span class="mt">${fmtTime(m.time)}</span></div>${body}</div></div>`;
    prev = { ...m, who };
  }
  box.innerHTML = html;
  hydrateAttachments(box);
  if (nearBottom || box.dataset.first !== '1') {
    box.scrollTop = box.scrollHeight;
    box.dataset.first = '1';
  }
}

function addEph(chId, text) {
  st.ephemeral.push({ ch: chId, text, time: Date.now(), uid: '' });
  if (st.ephemeral.length > 30) st.ephemeral.shift();
  renderMessages();
  const box = $('#msgs');
  if (box) box.scrollTop = box.scrollHeight;
}

async function sendChat() {
  const ta = $('#msg-input');
  const ch = currentText();
  if (!ta || !ch) return;
  const text = ta.value.trim();
  const files = st.pendingFiles.slice();
  if (!text && !files.length) return;
  if (files.some((f) => f.busy)) return toast('Espera o anexo terminar de preparar.');
  const me = { uid: st.user.uid, name: st.me.name, color: st.me.color };
  ta.value = '';
  ta.style.height = 'auto';
  const cmd = !files.length && parseCommand(text);
  if (cmd) {
    if (cmd.type !== 'help') B.sendMessage(ch.id, me, text).catch(() => {});
    try {
      await bot.command(cmd, { serverId: st.view, channel: ch, eph: (t) => addEph(ch.id, t) });
    } catch (e) {
      console.error(e);
      addEph(ch.id, 'Deu ruim no comando: ' + (e.message || e));
    }
    return;
  }
  st.pendingFiles = [];
  renderPending();
  try {
    const metas = [];
    for (const f of files) {
      const id = await B.uploadAttachment({ serverId: st.view, roomId: ch.id, uid: st.user.uid, name: f.name, type: f.type, size: f.size, data: f.data });
      attCache.set(id, Promise.resolve({ data: f.data, name: f.name, type: f.type }));
      metas.push({ id, name: f.name, type: f.type, size: f.size, w: f.w || 0, h: f.h || 0, img: !!f.isImg });
    }
    await B.sendMessage(ch.id, me, text, metas.length ? { files: metas } : {});
    const box = $('#msgs');
    if (box) box.scrollTop = box.scrollHeight;
  } catch (e) {
    console.error(e);
    ta.value = text;
    st.pendingFiles = files;
    renderPending();
    toast('Não consegui mandar a mensagem.', true);
  }
}

// ---------------------------------------------------------------- anexos
const attCache = new Map(); // id -> Promise<{data,name,type}>
const getAtt = (id) => {
  if (!attCache.has(id)) {
    const p = B.getAttachment(id);
    p.catch(() => attCache.delete(id));
    attCache.set(id, p);
  }
  return attCache.get(id);
};
const fmtSize = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

function filesHtml(m) {
  if (!m.files || !m.files.length) return '';
  return `<div class="atts">${m.files
    .map((f) =>
      f.img
        ? `<button class="att-img" data-act="att-view" data-id="${esc(f.id)}" style="aspect-ratio:${f.w && f.h ? `${f.w}/${f.h}` : '4/3'};width:${Math.min(400, f.w || 400)}px"><img data-att="${esc(f.id)}" alt="${esc(f.name)}"/></button>`
        : `<div class="att-file">${icon('file')}<div class="grow"><b class="ellipsis">${esc(f.name)}</b><small>${fmtSize(f.size || 0)}</small></div><button class="ibtn" data-act="att-download" data-id="${esc(f.id)}" title="Baixar">${icon('download', 'sm')}</button></div>`
    )
    .join('')}</div>`;
}

function hydrateAttachments(box) {
  $$('img[data-att]', box).forEach((img) => {
    getAtt(img.dataset.att)
      .then((a) => {
        if (a && a.data) img.src = a.data;
        else img.closest('.att-img')?.classList.add('gone');
      })
      .catch(() => img.closest('.att-img')?.classList.add('gone'));
  });
}

async function downloadAtt(id) {
  const a = await getAtt(id).catch(() => null);
  if (!a || !a.data) return toast('Esse anexo não existe mais.', true);
  const link = document.createElement('a');
  link.href = a.data;
  link.download = a.name || 'arquivo';
  link.click();
}

async function viewAtt(id) {
  const a = await getAtt(id).catch(() => null);
  if (!a || !a.data) return;
  openModal(
    `<div class="lightbox"><img src="${a.data}" alt=""/><div class="row"><span class="muted ellipsis">${esc(a.name || '')}</span><div class="grow"></div><button class="btn" data-act="att-download" data-id="${esc(id)}">${icon('download', 'sm')} Baixar</button><button class="btn ghost" data-act="close">Fechar</button></div></div>`,
    { raw: true }
  );
}

const readAsDataURL = (file) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
const MAX_ATT = 700 * 1024;

// imagem grande vira JPEG menor (até 1600 px); GIF pequeno vai como está (animado)
async function prepareFile(file) {
  const isImg = /^image\/(png|jpe?g|webp|gif|bmp)$/i.test(file.type);
  if (isImg) {
    if (/gif/i.test(file.type) && file.size <= MAX_ATT) {
      const data = await readAsDataURL(file);
      const dims = await new Promise((res) => {
        const im = new Image();
        im.onload = () => res([im.naturalWidth, im.naturalHeight]);
        im.onerror = () => res([0, 0]);
        im.src = data;
      });
      return { name: file.name, type: file.type, size: file.size, data, isImg: true, w: dims[0], h: dims[1] };
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = url;
      });
      for (const [max, q] of [[1600, 0.82], [1280, 0.72], [960, 0.65], [720, 0.6]]) {
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * k);
        const h = Math.round(img.naturalHeight * k);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        const data = c.toDataURL('image/jpeg', q);
        if (data.length * 0.75 <= MAX_ATT) return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg', size: Math.round(data.length * 0.75), data, isImg: true, w, h };
      }
      throw new Error('grande');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (file.size > MAX_ATT) throw Object.assign(new Error('grande'), { big: true });
  return { name: file.name, type: file.type || 'application/octet-stream', size: file.size, data: await readAsDataURL(file), isImg: false };
}

async function addFiles(files) {
  for (const file of files) {
    if (st.pendingFiles.length >= 6) {
      toast('Máximo de 6 anexos por mensagem.');
      break;
    }
    const slot = { name: file.name, busy: true };
    st.pendingFiles.push(slot);
    renderPending();
    try {
      Object.assign(slot, await prepareFile(file), { busy: false });
    } catch (e) {
      st.pendingFiles = st.pendingFiles.filter((x) => x !== slot);
      toast(e.big ? `"${file.name}" é grande demais (máx. 700 KB pra arquivos; imagens são diminuídas sozinhas).` : `Não consegui anexar "${file.name}".`, true);
    }
    renderPending();
  }
  $('#msg-input')?.focus();
}

function renderPending() {
  const el = $('#pending-files');
  if (!el) return;
  el.innerHTML = st.pendingFiles
    .map(
      (f, i) =>
        `<div class="pf">${f.busy ? '<span class="pf-spin"></span>' : f.isImg ? `<img src="${f.data}" alt=""/>` : icon('file')}<span class="ellipsis">${esc(f.name)}</span><button class="ibtn" data-act="unattach" data-i="${i}" title="Tirar">${icon('close', 'sm')}</button></div>`
    )
    .join('');
}

function pickAttachments() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => addFiles([...input.files]);
  input.click();
}

// ---------------------------------------------------------------- bot de música (tela)
const botHere = () => (st.view !== 'home' && st.botServer === st.view && isBotActive(st.bot) ? st.bot : null);
const botPos = (b) => Math.max(0, ((b.paused ? b.pausedAt : Date.now()) - b.startedAt) / 1000);

function renderBotBar() {
  const el = $('#botbar');
  if (!el) return;
  const b = botHere();
  if (!b || !b.now) {
    el.className = '';
    el.innerHTML = '';
    return;
  }
  const room = st.rooms.find((r) => r.id === b.roomId);
  el.className = 'botbar';
  el.innerHTML = `<img src="${esc(b.now.thumb)}" alt=""/>
    <div class="bb-info"><b class="ellipsis">${esc(b.now.title)}</b>
      <small>🔊 ${esc(room ? room.name : '')} · ${b.ad ? 'anúncio do YouTube...' : `<span id="bb-pos">${fmtDur(botPos(b))}</span> / ${fmtDur(b.now.duration)}`} · ${b.queue.length} na fila${b.paused ? ' · pausado' : ''}</small>
      <div class="bb-prog"><i id="bb-fill"></i></div></div>
    <button class="ibtn" data-act="bot-ctl" data-c="${b.paused ? 'resume' : 'pause'}" title="${b.paused ? 'Continuar' : 'Pausar'}">${icon(b.paused ? 'play' : 'pause')}</button>
    <button class="ibtn" data-act="bot-ctl" data-c="skip" title="Pular">${icon('skip')}</button>
    <button class="ibtn" data-act="bot-ctl" data-c="stop" title="Parar e tirar o bot">${icon('stop')}</button>
    <button class="btn ghost" data-act="music">Fila</button>`;
  tickBotBar();
}
function tickBotBar() {
  const b = botHere();
  if (!b || !b.now) return;
  const pos = botPos(b);
  const p = $('#bb-pos');
  if (p) p.textContent = fmtDur(pos);
  const f = $('#bb-fill');
  if (f) f.style.width = b.now.duration ? Math.min(100, (pos / b.now.duration) * 100) + '%' : '0';
  const mp = $('#mus-pos');
  if (mp) mp.textContent = fmtDur(pos);
}
setInterval(tickBotBar, 1000);

function botCmd(cmd) {
  const ch = st.mode === 'chat' ? currentText() : null;
  return bot.command(cmd, { serverId: st.view, channel: ch, eph: (t) => (ch ? addEph(ch.id, t) : toast(t.replace(/[*`]/g, ''))) }).catch((e) => toast('Erro: ' + e.message, true));
}

function openMusicModal() {
  if (st.view === 'home') return toast('Abre um servidor pra usar o bot.');
  openModal(
    `<div class="modal-head"><h3>${icon('music')} Bot de música</h3><button class="ibtn" data-act="close">${icon('close')}</button></div>
     <div class="modal-body music">
       <form id="mus-search" class="row"><input type="text" name="q" placeholder="Nome da música ou link do YouTube" autocomplete="off"/><button class="btn primary" type="submit">Buscar</button></form>
       <div id="mus-results"></div>
       <div id="mus-now"></div>
       <div class="row" style="margin-top:12px"><span class="muted" style="font-size:12px;white-space:nowrap">Volume da música pra mim</span><input type="range" min="0" max="150" value="${S.botVolume ?? 70}" data-botvol style="flex:1"/></div>
       <div class="hint">Também dá pra digitar no chat: <b>/play nome</b>, <b>/pular</b>, <b>/pausar</b>, <b>/parar</b>, <b>/fila</b> (/ajuda mostra todos). O bot entra no canal de voz de quem pediu.</div>
     </div>`,
    { wide: true }
  );
  const f = $('#mus-search');
  f.q.focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = f.q.value.trim();
    if (!q) return;
    $('#mus-results').innerHTML = '<div class="hint" style="padding:10px">Procurando no YouTube...</div>';
    try {
      st.musResults = await bridge.bot.search(q, 8);
    } catch (err) {
      console.error(err);
      st.musResults = [];
      $('#mus-results').innerHTML = '<div class="hint" style="padding:10px">A busca falhou. Tenta de novo.</div>';
      return;
    }
    $('#mus-results').innerHTML = st.musResults.length
      ? st.musResults
          .map(
            (r, i) => `<div class="mus-item"><img src="${esc(r.thumb)}" alt=""/><div class="grow"><b class="ellipsis">${esc(r.title)}</b><small class="muted">${esc(r.author)} · ${fmtDur(r.duration)}</small></div>
          <button class="btn" data-act="mus-play" data-i="${i}">${icon('play', 'sm')} Tocar</button><button class="btn ghost" data-act="mus-next" data-i="${i}" title="Tocar logo depois da atual">Próxima</button></div>`
          )
          .join('')
      : '<div class="hint" style="padding:10px">Nada encontrado.</div>';
  });
  updateMusicModal();
}

function updateMusicModal() {
  const el = $('#mus-now');
  if (!el) return;
  const b = botHere();
  if (!b || !b.now) {
    el.innerHTML = `<div class="hint" style="padding:10px 0">O bot não tá tocando agora. Busca uma música aí em cima: ele entra no seu canal de voz${st.roomId && st.roomServerId === st.view ? '' : ' (entra num canal de voz antes)'}.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="label">Tocando agora</div>
    <div class="mus-item now"><img src="${esc(b.now.thumb)}" alt=""/><div class="grow"><b class="ellipsis">${esc(b.now.title)}</b><small class="muted"><span id="mus-pos">${fmtDur(botPos(b))}</span> / ${fmtDur(b.now.duration)} · ${b.now.by === 'autoplay' ? 'autoplay' : 'pedido por ' + esc(b.now.by)}</small></div>
      <button class="ibtn" data-act="bot-ctl" data-c="${b.paused ? 'resume' : 'pause'}">${icon(b.paused ? 'play' : 'pause')}</button>
      <button class="ibtn" data-act="bot-ctl" data-c="skip" title="Pular">${icon('skip')}</button>
      <button class="ibtn" data-act="bot-ctl" data-c="stop" title="Parar e tirar o bot">${icon('stop')}</button></div>
    <div class="row" style="margin:8px 0">
      <div class="label" style="margin:0">Fila (${b.queue.length})</div><div class="grow"></div>
      <button class="btn ghost ${b.autoplay ? 'on' : ''}" data-act="bot-ctl" data-c="autoplay" title="Tocar músicas parecidas quando a fila acabar">${icon('repeat', 'sm')} Autoplay ${b.autoplay ? 'ligado' : 'desligado'}</button>
      <button class="btn ghost" data-act="bot-ctl" data-c="shuffle">${icon('shuffle', 'sm')} Embaralhar</button>
      <button class="btn ghost" data-act="bot-ctl" data-c="clear">Limpar</button>
    </div>
    <div class="mus-queue">${
      b.queue
        .map(
          (q, i) => `<div class="mus-item small"><span class="qn">${i + 1}</span><img src="${esc(q.thumb)}" alt=""/><div class="grow"><b class="ellipsis">${esc(q.title)}</b><small class="muted">${fmtDur(q.duration)} · ${esc(q.by)}</small></div><button class="ibtn" data-act="bot-ctl" data-c="remove" data-arg="${i + 1}" title="Tirar da fila">${icon('close', 'sm')}</button></div>`
        )
        .join('') || '<div class="hint">Fila vazia.' + (b.autoplay ? ' Quando acabar, o autoplay escolhe músicas parecidas.' : '') + '</div>'
    }</div>`;
}

function msgMenu(e, id) {
  e.preventDefault();
  const m = st.msgs.find((x) => x.id === id);
  const ch = currentText();
  if (!m || !ch) return;
  const sv = currentServer();
  const canDelete = m.uid === st.user.uid || sv?.ownerId === st.user.uid;
  const c = openCtx(
    e.clientX,
    e.clientY,
    `<button class="item" data-x="copy">Copiar texto</button>${canDelete ? '<button class="item danger" data-x="del">Apagar mensagem</button>' : ''}`
  );
  c.addEventListener('click', (ev) => {
    const x = ev.target.dataset.x;
    closeCtx();
    if (x === 'copy') navigator.clipboard.writeText(m.text).then(() => toast('Copiado!'));
    if (x === 'del') B.deleteMessage(ch.id, id).catch(() => toast('Não deu pra apagar.', true));
  });
}

function renderStage() {
  const el = $('#stage');
  if (!el) return;
  if (st.showVoices) {
    tileEls.clear();
    stageSig = '';
    stopChat();
    return renderVoices(el);
  }
  if (st.view === 'home') {
    tileEls.clear();
    stageSig = '';
    return renderHome(el);
  }
  if ((!inCallHere() || st.mode === 'chat') && currentText()) {
    tileEls.clear();
    stageSig = '';
    return renderChat(el);
  }
  stopChat();
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
    people.unshift({ sid: st.sid, uid: st.user.uid, name: st.me.name, color: st.me.color, muted: st.muted || st.deafened, deafened: st.deafened, sharing: st.sharing, cam: st.cam });
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
    const avHtml = avatar(p.name, p.color, '', '', p.uid);
    if (t._av !== avHtml) {
      t.querySelector('.av').innerHTML = avHtml;
      t._av = avHtml;
    }
    t.querySelector('.tag').innerHTML = `${p.deafened ? icon('headsetOff') : p.muted ? icon('micOff') : ''}<span class="ellipsis">${esc(p.name)}${me ? ' (você)' : ''}</span>`;
    t.querySelector('.ping').textContent = !me && st.ping[p.sid] != null ? `${Math.round(st.ping[p.sid] * 1000)} ms` : '';
    // webcam: o vídeo toma o lugar da foto
    const camOn = me ? st.cam : !!p.cam;
    const camTrack = camOn ? (me ? st.camStream && st.camStream.getVideoTracks()[0] : st.remote.get(p.sid)?.cam) : null;
    const cv = t.querySelector('video.cam');
    t.classList.toggle('has-cam', !!camTrack);
    cv.classList.toggle('mirror', me);
    if (camTrack && cv._tid !== camTrack.id) {
      cv.srcObject = new MediaStream([camTrack]);
      cv._tid = camTrack.id;
      cv.play().catch(() => {});
    } else if (!camTrack && cv._tid) {
      cv.srcObject = null;
      cv._tid = null;
    }
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
        !sbServer()
          ? `<div class="sb-empty">Abre um servidor pra ver os sons dele.</div>`
          : visibleSounds()
              .map(
                (s) =>
                  `<button class="sound" data-act="sound" data-id="${s.id}" title="${esc(s.name)}: botão direito pra opções"><span class="em">${soundIcon(s)}</span><span class="nm">${esc(s.name)}</span></button>`
              )
              .join('') || `<div class="sb-empty">Nenhum som neste servidor ainda.<br/>Sobe o primeiro aí embaixo!</div>`
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

function updateText(u) {
  if (!u) return '';
  switch (u.state) {
    case 'checking': return 'Procurando atualizações...';
    case 'available': return `Atualização ${u.version} encontrada. Baixando...`;
    case 'downloading': return `Baixando atualização${u.version ? ' ' + u.version : ''}... ${Math.round(u.percent || 0)}%`;
    case 'ready': return `Versão ${u.version} pronta pra instalar.`;
    case 'latest': return `Você está na versão mais nova (${u.current}).`;
    case 'error': return 'Não deu pra procurar atualização agora (sem internet?).';
    case 'dev': return `Modo desenvolvimento (v${u.current}): atualização só no app instalado.`;
    default: return '';
  }
}

function renderUpdate() {
  const u = st.update;
  const el = $('#update-slot');
  if (el) {
    if (u && (u.state === 'available' || u.state === 'downloading')) {
      el.innerHTML = `<div class="update-bar dl">${esc(updateText(u))}<span class="upbar"><i style="width:${Math.round(u.percent || 0)}%"></i></span></div>`;
    } else if (u && u.state === 'ready') {
      el.innerHTML = `<div class="update-bar">Versão ${esc(u.version)} baixada! <button data-act="install-update">Reiniciar e atualizar agora</button><small>(atualiza sozinho quando você sair da chamada)</small></div>`;
    } else el.innerHTML = '';
  }
  const about = $('#update-status');
  if (about) about.textContent = updateText(u);
}

let autoInstallTimer = null;
function maybeAutoInstall() {
  const u = st.update;
  if (!u || u.state !== 'ready' || st.roomId || autoInstallTimer) return;
  // fora de chamada: avisa e reinicia sozinho
  let n = 5;
  const show = () =>
    openModal(`
      <div class="modal-head"><h3>Atualizando o app</h3></div>
      <div class="modal-body"><p>A versão <b>${esc(u.version)}</b> foi baixada. O app vai reiniciar em <b>${n}</b> segundos.</p></div>
      <div class="modal-foot"><button class="btn ghost" data-act="cancel-update">Agora não</button><button class="btn primary" data-act="install-update">Atualizar agora</button></div>`);
  show();
  autoInstallTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      clearInterval(autoInstallTimer);
      bridge.installUpdate();
    } else if ($('[data-act="cancel-update"]')) show();
  }, 1000);
}

bridge.onUpdate((info) => {
  st.update = info;
  renderUpdate();
  maybeAutoInstall();
});
bridge.updateState().then((info) => {
  if (info) {
    st.update = info;
    renderUpdate();
    maybeAutoInstall();
  }
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
  let cams = [];
  if (tab === 'voice') {
    if (!mic) {
      // abre o mic só pra testar (sem enviar a ninguém)
      await ensureMic();
    }
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      inputs = devs.filter((d) => d.kind === 'audioinput');
      outputs = devs.filter((d) => d.kind === 'audiooutput');
      cams = devs.filter((d) => d.kind === 'videoinput');
    } catch (_) {}
  }
  const version = await bridge.version();
  const sw = (key, title, desc) =>
    `<div class="toggle"><div class="t"><b>${title}</b><small>${desc}</small></div><button class="switch ${S[key] ? 'on' : ''}" data-set-bool="${key}"></button></div>`;
  const opt = (list, cur) =>
    list
      .map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || (d.deviceId === 'default' ? 'Padrão' : 'Dispositivo'))}</option>`)
      .join('');

  const saveBar = `<div class="save-bar"><span class="muted">As mudanças já valem na hora e ficam guardadas neste PC.</span><button class="btn primary" data-act="save-settings">Salvar</button></div>`;
  const sections = {
    voice: `
      <h2>Voz e áudio</h2>
      <div class="two">
        <div><div class="label">Microfone</div><select data-set="inputDevice">${opt(inputs, S.inputDevice)}</select></div>
        <div><div class="label">Alto-falante / fone</div><select data-set="outputDevice">${opt(outputs, S.outputDevice)}</select></div>
        <div><div class="label">Webcam</div><select data-set="camDevice"><option value="" ${!S.camDevice ? 'selected' : ''}>Padrão do Windows</option>${cams.length ? cams.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === S.camDevice ? 'selected' : ''}>${esc(d.label || 'Câmera ' + (i + 1))}</option>`).join('') : ''}</select></div>
        <div class="hint" style="align-self:end">${cams.length ? 'A câmera liga pelo botão de câmera na chamada.' : 'Nenhuma webcam encontrada neste PC.'}</div>
        <div><div class="label">Volume do microfone — <span data-show="inputVolume">${S.inputVolume}</span>%</div><input type="range" min="0" max="200" value="${S.inputVolume}" data-set-num="inputVolume"/></div>
        <div><div class="label">Volume da saída — <span data-show="outputVolume">${S.outputVolume}</span>%</div><input type="range" min="0" max="200" value="${S.outputVolume}" data-set-num="outputVolume"/></div>
      </div>
      <div class="label">Teste do microfone</div>
      <div class="meter" id="mic-meter"><i></i><b style="left:${((S.gateThreshold + 80) / 80) * 100}%"></b></div>
      <div class="hint">Fala alguma coisa: a barra verde mostra seu volume. A linha laranja é o limite do filtro de ruído.</div>
      <div class="toggle"><div class="t"><b>Ouvir meu microfone</b><small>Escuta sua própria voz (já com o filtro de ruído) pra testar. Use fone, senão dá microfonia. Ninguém mais escuta.</small></div>
        <button class="switch ${mic && mic.monitoring ? 'on' : ''}" data-act="toggle-monitor"></button></div>
      <div class="label">Processamento de voz</div>
      <div class="hint" style="margin-bottom:4px">A supressão inteligente já vem ligada. O resto vem desligado pra voz sair limpa: liga só se precisar.</div>
      ${sw('aiNoise', 'Supressão de ruído inteligente (IA) — recomendado', 'Tira teclado, mouse, ventilador e barulho de fundo, até enquanto você fala. Funciona sozinho, sem ajustar nada.')}
      ${sw('noiseSuppression', 'Supressão de ruído do Windows/Chromium', 'Filtro básico extra. Normalmente não precisa com a de IA ligada.')}
      ${sw('echoCancellation', 'Cancelamento de eco', 'Evita que seus amigos se escutem pelo seu microfone.')}
      ${sw('autoGainControl', 'Ganho automático', 'Ajusta seu volume sozinho (desliga se seu volume ficar oscilando).')}
      ${sw('gateEnabled', 'Filtro de ruído (noise gate)', 'Limite fixo escolhido por você. Desligado, a supressão inteligente já usa um filtro automático que ignora teclas e cliques.')}
      <div class="label">Sensibilidade do filtro — <span data-show="gateThreshold">${S.gateThreshold}</span> dB</div>
      <input type="range" min="-80" max="-10" value="${S.gateThreshold}" data-set-num="gateThreshold"/>
      <div class="label">Outros</div>
      ${sw('uiSounds', 'Sons de entrada/saída e mute', 'Bipes quando alguém entra, sai ou você muta.')}
      ${saveBar}`,
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
      <div class="toggle"><div class="t"><b>Tela cheia</b></div><span class="kbd">F11</span></div>
      <div class="toggle"><div class="t"><b>Sair do foco / fechar janela</b></div><span class="kbd">Esc</span></div>
      <div class="label">Janela</div>
      ${sw('startFullscreen', 'Abrir o app em tela cheia', 'Já começa ocupando a tela toda.')}
      ${saveBar}`,
    account: `
      <h2>Minha conta</h2>
      <div class="row profile-head" style="margin:16px 0">${avatar(st.me.name, st.me.color, '', 'big', st.user.uid)}<div class="grow"><b>${esc(st.me.name)}</b>${st.me.title ? `<div class="ptitle">${esc(st.me.title)}</div>` : ''}<div class="muted">${esc(st.user.email)}</div></div></div>
      <div class="label">Foto de perfil</div>
      <div class="row"><button class="btn" data-act="pick-photo">Trocar foto</button>${st.me.photo ? '<button class="btn ghost" data-act="remove-photo">Remover foto</button>' : ''}</div>
      <div class="label">Apelido</div>
      <div class="row"><input type="text" id="nick" maxlength="32" value="${esc(st.me.name)}"/><button class="btn" data-act="save-nick">Salvar</button></div>
      <div class="label">Título</div>
      <div class="hint" style="margin-bottom:6px">Aparece embaixo do seu apelido. Escreve o que quiser (ou deixa vazio).</div>
      <div class="row"><input type="text" id="ptitle" maxlength="60" value="${esc(st.me.title || '')}" placeholder="Ex.: o rei da resenha"/><button class="btn" data-act="save-title">Salvar</button></div>
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
      <div class="label">Atualizações</div>
      <p class="muted">O app procura atualização sozinho toda vez que abre (e a cada 30 minutos), baixa e reinicia quando você não está em chamada.</p>
      <div class="row"><button class="btn primary" data-act="check-update">Procurar atualização agora</button>${st.update && st.update.state === 'ready' ? '<button class="btn" data-act="install-update">Reiniciar e atualizar</button>' : ''}</div>
      <p id="update-status" class="hint" style="font-size:13px">${esc(updateText(st.update))}</p>`,
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
      if (t.tagName === 'SELECT' && t.dataset.set.endsWith('Device')) {
        S[t.dataset.set + 'Label'] = t.selectedOptions[0] ? t.selectedOptions[0].textContent : '';
        saveSettings();
      }
      if (t.dataset.set === 'inputDevice' && mic) await mic.update({ ...S });
      if (t.dataset.set === 'outputDevice') await applyOutputDevice();
      if (t.dataset.set === 'camDevice') await switchCam();
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
    if (k === 'startFullscreen') bridge.setFullscreen(S[k]);
    if (mic) await mic.update({ ...S });
  });

  if (tab === 'voice') {
    const bar = $('#mic-meter i', m);
    const loop = () => {
      if (!$('#mic-meter')) return;
      if (bar && mic) {
        bar.style.width = mic.level * 100 + '%';
        bar.style.opacity = mic.speaking || !(S.gateEnabled || S.aiNoise) ? 1 : 0.35;
      }
      meterRaf = requestAnimationFrame(loop);
    };
    loop();
  }
}

function onSettingsClosed() {
  if (mic && mic.monitoring) mic.setMonitor(false);
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
      ${friends.map((m) => `<div class="friend">${avatar(m.name, m.color, '', '', m.id)}<div class="grow"><b>${esc(m.name)}</b></div><button class="btn" data-act="send-invite" data-uid="${m.id}" data-server="${sv.id}">Convidar</button></div>`).join('') || '<div class="hint" style="margin-bottom:14px">Todos os seus amigos já estão aqui (ou adicione amigos na tela inicial).</div>'}
    </div>`);
}

function inviteFriendPicker(uid) {
  const m = st.members.get(uid);
  const list = st.servers.filter((sv) => !(sv.members || []).includes(uid));
  openModal(`
    <div class="modal-head"><h3>Chamar ${esc(m ? m.name : '')} pra qual servidor?</h3><button class="ibtn" data-act="close">${icon('close')}</button></div>
    <div class="modal-body">
      ${list.map((sv) => `<div class="friend"><span class="srv-mini">${serverIcon(sv)}</span><div class="grow"><b>${esc(sv.name)}</b></div><button class="btn" data-act="send-invite" data-uid="${uid}" data-server="${sv.id}">Convidar</button></div>`).join('') || '<div class="hint" style="margin-bottom:14px">Ele já está em todos os seus servidores.</div>'}
    </div>`);
}

// escolhe uma imagem, recorta quadrada 160x160 e salva como JPEG pequeno (~15 KB)
function pickServerIcon(serverId) {
  pickImage(
    160,
    async (data) => {
      await B.setServerIcon(serverId, data);
      toast('Foto do servidor trocada!');
    },
    { title: 'Foto do servidor' }
  );
}

// escolhe uma imagem, recorta quadrada (size x size) e entrega um JPEG pequeno em data URL
function pickImage(size, onData, { round = false, title = 'Ajustar imagem', after = null } = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    let img;
    const url = URL.createObjectURL(file);
    try {
      img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('formato'));
        im.src = url;
      });
    } catch (e) {
      URL.revokeObjectURL(url);
      return toast('Esse formato de imagem não abriu. Tenta JPG, PNG, WEBP ou GIF.', true);
    }
    cropImage(img, url, size, { round, title, after }, onData);
  };
  input.click();
}

// janela de recorte: arrasta pra posicionar, roda/slider pra zoom, grade de 3x3 pra ajudar
function cropImage(img, url, size, { round, title, after }, onData) {
  const V = 320;
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const minS = V / Math.min(W, H);
  let s = minS;
  let x = (V - W * s) / 2;
  let y = (V - H * s) / 2;
  const m = openModal(`
    <div class="modal-head"><h3>${esc(title)}</h3><button class="ibtn" data-act="crop-cancel">${icon('close')}</button></div>
    <div class="crop-wrap">
      <div class="crop-view ${round ? 'round' : ''}" style="width:${V}px;height:${V}px"><img src="${url}" alt="" draggable="false"/><div class="crop-grid"></div></div>
      <div class="row crop-zoom"><span class="muted">−</span><input type="range" min="100" max="400" value="100" id="crop-z"/><span class="muted">+</span></div>
      <div class="hint">Arrasta a imagem pra escolher o pedaço. Use a rodinha do mouse ou a barra pra dar zoom.</div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" data-act="crop-cancel">Cancelar</button><button class="btn primary" data-act="crop-save">Salvar</button></div>
    </div>`);
  const view = m.querySelector('.crop-view');
  const im = view.querySelector('img');
  const z = m.querySelector('#crop-z');
  const clamp = () => {
    x = Math.min(0, Math.max(V - W * s, x));
    y = Math.min(0, Math.max(V - H * s, y));
  };
  const draw = () => {
    clamp();
    im.style.width = W * s + 'px';
    im.style.height = H * s + 'px';
    im.style.transform = `translate(${x}px, ${y}px)`;
  };
  const zoomTo = (ns, cx = V / 2, cy = V / 2) => {
    ns = Math.max(minS, Math.min(minS * 4, ns));
    x = cx - ((cx - x) * ns) / s;
    y = cy - ((cy - y) * ns) / s;
    s = ns;
    z.value = Math.round((s / minS) * 100);
    draw();
  };
  draw();
  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    drag = { px: e.clientX, py: e.clientY, x, y };
    view.setPointerCapture(e.pointerId);
    view.classList.add('drag');
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag) return;
    x = drag.x + e.clientX - drag.px;
    y = drag.y + e.clientY - drag.py;
    draw();
  });
  const end = () => {
    drag = null;
    view.classList.remove('drag');
  };
  view.addEventListener('pointerup', end);
  view.addEventListener('pointercancel', end);
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = view.getBoundingClientRect();
    zoomTo(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  z.addEventListener('input', () => zoomTo((minS * z.value) / 100));
  const finish = () => {
    URL.revokeObjectURL(url);
    closeModal();
    if (after) after();
  };
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'crop-cancel') {
      e.stopPropagation();
      finish();
    }
    if (b.dataset.act === 'crop-save') {
      e.stopPropagation();
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.fillStyle = '#111214';
      g.fillRect(0, 0, size, size);
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, -x / s, -y / s, V / s, V / s, 0, 0, size, size);
      const data = c.toDataURL('image/jpeg', 0.88);
      b.disabled = true;
      try {
        await onData(data);
        finish();
      } catch (err) {
        console.error(err);
        b.disabled = false;
        toast(err && err.code === 'permission-denied' ? 'O servidor recusou salvar. Fecha e abre o app de novo e tenta outra vez.' : 'Não consegui salvar a imagem.', true);
      }
    }
  });
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
     ${owner ? `<button class="item" data-x="icon">Trocar foto do servidor</button>${sv.icon ? '<button class="item" data-x="icon-remove">Remover foto</button>' : ''}` : ''}
     ${owner ? '<button class="item" data-x="rename">Renomear servidor</button><button class="item" data-x="code">Gerar novo código</button><button class="item danger" data-x="delete">Excluir servidor</button>' : '<button class="item danger" data-x="leave">Sair do servidor</button>'}`
  );
  c.addEventListener('click', async (ev) => {
    const x = ev.target.dataset.x;
    if (!x) return;
    closeCtx();
    if (x === 'invite') openInviteModal();
    if (x === 'room') promptText('Nova sala', '', (v) => B.createRoom(sv.id, v, st.rooms.length + 1));
    if (x === 'rename') promptText('Renomear servidor', sv.name, (v) => B.renameServer(sv.id, v));
    if (x === 'icon') pickServerIcon(sv.id);
    if (x === 'icon-remove') B.setServerIcon(sv.id, null).then(() => toast('Foto removida.'));
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
// filtros de voz: um clique e já sai com o efeito (todo mundo da call escuta)
const VOICE_FX = [
  { id: '', name: 'Voz normal', desc: 'Sem filtro' },
  { id: 'autotune', name: 'Autotune', desc: 'Estilo trap do Autotune Igão' },
];
// vozes com IA: catálogo publicado pelo Estúdio de Vozes (release "vozes" do GitHub)
const vz = { estado: null, catalogo: null, carregando: false, prog: {}, erro: '', ligando: '' };
const vozesApi = () => window.cacamba && window.cacamba.vozes;
const fmtMB = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1).replace('.', ',') + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB');
const errMsg = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
function voiceName(id) {
  const f = VOICE_FX.find((x) => x.id === id);
  if (f) return f.name;
  const v = id && id.startsWith('ai:') && vz.catalogo && vz.catalogo.vozes.find((x) => x.id === id.slice(3));
  return v ? v.nome : id && id.startsWith('ai:') ? 'Voz com IA' : 'Voz normal';
}
async function loadVozes(forcar = false) {
  const api = vozesApi();
  if (!api || vz.carregando) return;
  vz.carregando = true;
  vz.erro = '';
  if (st.showVoices) renderStage();
  try {
    const [e, c] = await Promise.all([api.estado(), api.catalogo(forcar)]);
    vz.estado = e;
    vz.catalogo = c;
    if (forcar) toast(c.vozes.length ? `Vozes atualizadas: ${c.vozes.length} disponíve${c.vozes.length === 1 ? 'l' : 'is'}` : 'Ainda não tem nenhuma voz publicada');
  } catch (e) {
    vz.erro = 'Não consegui buscar as vozes. Confere a internet.';
  }
  vz.carregando = false;
  if (st.showVoices) renderStage();
}
let vozProgT = 0;
if (vozesApi()) {
  vozesApi().onProgresso((d) => {
    vz.prog[d.tipo === 'motor' ? 'motor' : d.id] = d.p;
    const now = performance.now();
    if (now - vozProgT > 250 && st.showVoices) {
      vozProgT = now;
      renderStage();
    }
  });
}
function checkVoiceError() {
  if (mic && mic.filterError) {
    toast(`A voz com IA não ligou: ${mic.filterError}`, true);
    mic.filterError = '';
    S.voiceFilter = '';
    saveSettings();
    mic.update({ ...S });
    renderUserPanel();
    renderControls();
    if (st.showVoices) renderStage();
  }
}
async function setVoiceFilter(id) {
  if (id.startsWith('ai:')) {
    vz.ligando = id;
    if (st.showVoices) renderStage();
    toast('Carregando a voz…');
  }
  S.voiceFilter = id;
  saveSettings();
  if (!mic) await ensureMic();
  if (mic) await mic.update({ ...S });
  vz.ligando = '';
  renderUserPanel();
  renderControls();
  if (mic && mic.filterError) return checkVoiceError();
  if (id.startsWith('ai:') && mic && mic.filter && mic.filter.gpu === false) toast('Sem placa de vídeo compatível: a voz roda no processador e pode engasgar.', true);
  toast(id ? `Voz ligada: ${voiceName(id)}` : 'Voz normal de volta');
}
// primeira vez: instala o motor (uma vez só), depois baixa a voz e já liga
async function getAiVoice(id) {
  const api = vozesApi();
  if (!api || !vz.estado) return;
  const v = vz.catalogo && vz.catalogo.vozes.find((x) => x.id === id);
  if (!v || vz.prog[id] != null || vz.prog.motor != null) return;
  if (!vz.estado.motor) {
    const m = openModal(`<div class="modal-head"><h3>${icon('fx')} Vozes com IA</h3><button class="ibtn" data-act="close">${icon('close')}</button></div>
      <p>Na primeira vez o Caçamba baixa o <b>motor de vozes</b> (${fmtMB(vz.estado.tamanhoMotor)}, uma vez só). Depois disso cada voz é só um clique.</p>
      <p class="muted">Ele roda aqui no seu PC usando a placa de vídeo. Não precisa configurar nada.</p>
      <div class="modal-foot"><button class="btn ghost" id="vz-no">Agora não</button><button class="btn primary" id="vz-ok">${icon('download', 'sm')} Baixar e usar "${esc(v.nome)}"</button></div>`);
    const ok = await new Promise((r) => {
      $('#vz-ok', m).onclick = () => r(true);
      $('#vz-no', m).onclick = () => r(false);
      const obs = new MutationObserver(() => {
        if (!modalRoot.contains(m)) {
          obs.disconnect();
          r(false);
        }
      });
      obs.observe(modalRoot, { childList: true });
    });
    closeModal();
    if (!ok) return;
    vz.prog.motor = 0;
    renderStage();
    try {
      await api.instalarMotor();
      vz.estado.motor = true;
    } catch (e) {
      delete vz.prog.motor;
      renderStage();
      return toast('Não deu pra baixar o motor: ' + errMsg(e), true);
    }
    delete vz.prog.motor;
  }
  vz.prog[id] = 0;
  renderStage();
  try {
    const info = await api.baixar(id);
    vz.estado.baixadas[id] = info;
  } catch (e) {
    delete vz.prog[id];
    renderStage();
    return toast('Não deu pra baixar a voz: ' + errMsg(e), true);
  }
  delete vz.prog[id];
  await setVoiceFilter('ai:' + id);
  if (st.showVoices) renderStage();
}
async function removeAiVoice(id) {
  const v = vz.catalogo && vz.catalogo.vozes.find((x) => x.id === id);
  if (!confirm(`Apagar "${v ? v.nome : id}" do seu PC? Dá pra baixar de novo depois.`)) return;
  if (S.voiceFilter === 'ai:' + id) await setVoiceFilter('');
  await vozesApi().apagar(id);
  delete vz.estado.baixadas[id];
  renderStage();
}
// tela de vozes (área principal): cartões com foto; sem foto = cartão genérico com o nome
function voiceCard(f) {
  const on = S.voiceFilter === f.id;
  const pic = f.img
    ? `<img src="${esc(f.img)}" alt=""/>`
    : `<div class="vc-generic" style="--h:${[...f.name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360}">${f.id ? icon('fx') : icon('mic')}<b>${esc(f.name)}</b></div>`;
  const badge = on ? `<span class="vc-check">${icon('check', 'sm')}</span>` : '';
  let over = '';
  if (f.prog != null) over = `<div class="vc-over"><b>${Math.floor(f.prog * 100)}%</b><small>${f.progLabel}</small><div class="vc-bar"><i style="width:${(f.prog * 100).toFixed(1)}%"></i></div></div>`;
  else if (f.loading) over = `<div class="vc-over"><small>Carregando…</small></div>`;
  else if (f.download) over = `<div class="vc-over dl">${icon('download')}<small>Baixar · ${f.download}</small></div>`;
  const del = f.removable ? `<span class="vc-del" data-act="voz-apagar" data-id="${esc(f.vid)}" title="Apagar do PC">${icon('close', 'sm')}</span>` : '';
  return `<button class="vcard ${on ? 'on' : ''}" data-act="${f.act || 'pick-voice'}" data-id="${esc(f.act ? f.vid : f.id)}" title="${esc(f.name)}">
    <div class="vc-pic">${pic}${badge}${over}${del}</div>
    <span class="vc-name ellipsis">${esc(f.name)}</span>${f.desc ? `<small class="ellipsis">${esc(f.desc)}</small>` : ''}</button>`;
}
function aiCards() {
  if (!vz.catalogo || !vz.estado) return [];
  return vz.catalogo.vozes.map((v) => {
    const baixada = !!vz.estado.baixadas[v.id];
    const id = 'ai:' + v.id;
    const c = { id, vid: v.id, name: v.nome, desc: v.desc || '', img: v.fotoUrl || '' };
    if (vz.prog[v.id] != null) Object.assign(c, { prog: vz.prog[v.id], progLabel: 'Baixando a voz', act: 'noop' });
    else if (vz.prog.motor != null && !baixada) Object.assign(c, { prog: vz.prog.motor, progLabel: 'Baixando o motor', act: 'noop' });
    else if (vz.ligando === id) Object.assign(c, { loading: true, act: 'noop' });
    else if (!baixada) Object.assign(c, { act: 'voz-baixar', download: fmtMB(v.modelo.tamanho + (vz.estado.motor ? 0 : vz.estado.tamanhoMotor)) });
    else c.removable = true;
    return c;
  });
}
function renderVoices(el) {
  if (!vz.catalogo && !vz.carregando && !vz.erro) loadVozes();
  const q = (st.voiceQuery || '').toLowerCase();
  const match = (f) => !q || f.name.toLowerCase().includes(q);
  const fx = VOICE_FX.filter(match);
  const ai = aiCards().filter(match);
  let aiBody;
  if (!vozesApi()) aiBody = '';
  else if (vz.erro) aiBody = `<div class="hint">${esc(vz.erro)}</div>`;
  else if (!vz.catalogo) aiBody = `<div class="hint">Buscando vozes…</div>`;
  else if (!vz.catalogo.vozes.length) aiBody = `<div class="hint">Nenhuma voz com IA publicada ainda. Quando sair uma nova, clica em <b>Atualizar vozes</b>.</div>`;
  else aiBody = `<div class="vgrid">${ai.map(voiceCard).join('') || '<div class="hint">Nenhuma voz com esse nome.</div>'}</div>`;
  el.innerHTML = `<div class="voices">
    <div class="voices-head">
      <div class="grow"><h2>${icon('fx')} Filtros de voz</h2><small class="muted">Agora: <b>${esc(voiceName(S.voiceFilter))}</b>${st.roomId ? ' · todo mundo da call ouve' : ' · entra numa call pra usar'}</small></div>
      <input type="search" id="voice-q" placeholder="Procurar voz" value="${esc(st.voiceQuery || '')}"/>
      <button class="btn ${mic && mic.monitoring ? 'primary' : 'ghost'}" data-act="voices-monitor" title="Ouvir minha própria voz no fone">${icon('headset', 'sm')} ${mic && mic.monitoring ? 'Me ouvindo' : 'Me ouvir'}</button>
      <button class="ibtn" data-act="voices-close" title="Fechar">${icon('close')}</button>
    </div>
    <h4 class="vsec">Na hora</h4>
    <div class="vgrid">${fx.map(voiceCard).join('') || '<div class="hint">Nenhum filtro com esse nome.</div>'}</div>
    ${vozesApi() ? `<div class="vsec-row"><h4 class="vsec">Vozes com IA</h4><button class="btn ghost sm" data-act="vozes-atualizar" ${vz.carregando ? 'disabled' : ''}>${icon('download', 'sm')} ${vz.carregando ? 'Buscando…' : 'Atualizar vozes'}</button></div>` : ''}
    ${aiBody}
    <div class="hint" style="margin-top:12px">Use fone pra se ouvir sem microfonia. A voz escolhida fica salva até você trocar.</div>
  </div>`;
  const qi = $('#voice-q', el);
  qi.addEventListener('input', () => {
    st.voiceQuery = qi.value;
    const pos = qi.selectionStart;
    renderVoices(el);
    const n = $('#voice-q', el);
    n.focus();
    n.setSelectionRange(pos, pos);
  });
}

function voiceFxMenu(x, y) {
  const c = openCtx(
    x,
    y,
    `<div class="ctx-title">${icon('fx', 'sm')} Filtros de voz</div>
     ${VOICE_FX.map((f) => `<button class="item ${S.voiceFilter === f.id ? 'on' : ''}" data-fx="${f.id}">${S.voiceFilter === f.id ? '✓ ' : ''}${f.name}</button>`).join('')}
     <div class="ctx-sep"></div>
     <button class="item" data-fx-mon="1">${mic && mic.monitoring ? '✓ ' : ''}Me ouvir (retorno no fone)</button>
     <div class="ctx-sub">Use fone pra não dar microfonia.</div>`
  );
  // sobe o menu pra cima do botão
  const h = c.getBoundingClientRect().height;
  c.style.top = Math.max(8, y - h) + 'px';
  c.addEventListener('click', async (ev) => {
    const f = ev.target.closest('[data-fx]');
    if (f) {
      closeCtx();
      return setVoiceFilter(f.dataset.fx);
    }
    if (ev.target.closest('[data-fx-mon]')) {
      closeCtx();
      if (!mic) await ensureMic();
      if (mic) await mic.setMonitor(!mic.monitoring, S.outputDevice);
      toast(mic && mic.monitoring ? 'Retorno ligado: você está se ouvindo.' : 'Retorno desligado.');
    }
  });
}

// botão direito no Caçamba Bot: volume dele só pra mim + controles
function botMenu(e) {
  const b = botHere();
  if (!b) return;
  e.preventDefault();
  const vol = S.botVolume ?? 70;
  const c = openCtx(
    e.clientX,
    e.clientY,
    `<div class="ctx-title">🎵 Caçamba Bot</div>
     ${b.now ? `<div class="ctx-sub ellipsis">${esc(b.now.title)}</div>` : ''}
     <div class="ctx-range"><small><span>Volume da música pra mim</span><span id="bv">${vol}%</span></small>
     <input type="range" min="0" max="150" value="${vol}" id="bv-range"/></div>
     <button class="item" data-x="mute">${vol === 0 ? 'Desmutar o bot pra mim' : 'Mutar o bot pra mim'}</button>
     <button class="item" data-x="reset">Volume padrão (70%)</button>
     <div class="ctx-sep"></div>
     <button class="item" data-x="${b.paused ? 'resume' : 'pause'}">${b.paused ? 'Continuar' : 'Pausar'}</button>
     <button class="item" data-x="skip">Pular música</button>
     <button class="item" data-x="queue">Ver fila / pedir música</button>
     <button class="item danger" data-x="stop">Parar e tirar o bot</button>`
  );
  const apply = (v) => {
    if (v > 0) S.botVolumeLast = v;
    S.botVolume = v;
    saveSettings();
    bot.setListenVolume(v);
    $('#bv', c).textContent = v + '%';
    $('#bv-range', c).value = v;
    const mv = $('[data-botvol]');
    if (mv) mv.value = v;
  };
  $('#bv-range', c).addEventListener('input', (ev) => apply(+ev.target.value));
  c.addEventListener('click', (ev) => {
    const x = ev.target.dataset.x;
    if (!x) return;
    if (x === 'mute') apply(vol === 0 ? S.botVolumeLast || 70 : 0);
    else if (x === 'reset') apply(70);
    else if (x === 'queue') openMusicModal();
    else botCmd({ type: x, arg: '' });
    closeCtx();
  });
}

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
  if (r.fixed) return toast('O #geral é fixo: não dá pra renomear nem apagar.');
  const txt = r.type === 'text';
  const c = openCtx(
    e.clientX,
    e.clientY,
    `<div class="ctx-title">${txt ? '#' : ''}${esc(r.name)}</div>
     <button class="item" data-x="rename">Renomear ${txt ? 'canal' : 'sala'}</button>
     <button class="item danger" data-x="delete">Excluir ${txt ? 'canal' : 'sala'}</button>`
  );
  c.addEventListener('click', async (ev) => {
    const x = ev.target.dataset.x;
    closeCtx();
    if (x === 'rename') promptText(txt ? 'Renomear canal' : 'Renomear sala', r.name, (v) => B.renameRoom(roomId, txt ? B.channelName(v) : v));
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
    `<div class="ctx-title">${esc(s.name)}</div>
     <div class="ctx-range"><small><span>Volume do som</span><span id="sv2">${s.volume ?? 100}%</span></small>
     <input type="range" min="10" max="200" value="${s.volume ?? 100}" id="sv-range"/></div>
     <button class="item" data-x="preview">Ouvir só eu</button>
     <button class="item" data-x="rename">Renomear</button>
     <button class="item" data-x="img">Trocar imagem</button>${s.img ? '<button class="item" data-x="img-x">Tirar imagem</button>' : ''}
     <button class="item" data-x="trim">Cortar áudio</button>
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
    if (x === 'img') pickImage(128, (data) => B.updateSound(id, { img: data }).then(() => toast('Imagem do som trocada!')), { title: 'Imagem do som' });
    if (x === 'img-x') B.updateSound(id, { img: null });
    if (x === 'trim') openTrimSound(id);
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
    const tile = e.target.closest('.tile.screen, .tile.has-cam');
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
      if (e.target === b && !b.querySelector('.crop-view')) {
        closeModal();
        onSettingsClosed();
      }
      break;
    case 'close':
      closeModal();
      onSettingsClosed();
      break;
    case 'join':
      st.mode = 'stage';
      if (st.roomId === b.dataset.room) {
        st.focus = null;
        renderSidebar();
        renderHead();
        renderStage();
        renderControls();
      } else joinRoom(b.dataset.room);
      break;
    case 'open-text':
      st.textId = b.dataset.room;
      st.mode = 'chat';
      renderSidebar();
      renderHead();
      renderStage();
      renderControls();
      break;
    case 'add-text':
      promptText('Novo canal de texto', '', (v) => B.createTextChannel(st.view, v, textRooms().length + 1));
      break;
    case 'send-msg':
      sendChat();
      break;
    case 'attach':
      pickAttachments();
      break;
    case 'bot-more': {
      const k = b.dataset.key;
      if (st.botRunsOpen.has(k)) st.botRunsOpen.delete(k);
      else st.botRunsOpen.add(k);
      const box = $('#msgs');
      const keep = box ? box.scrollHeight - box.scrollTop : 0;
      renderMessages();
      if (box) box.scrollTop = box.scrollHeight - keep;
      break;
    }
    case 'unattach':
      st.pendingFiles.splice(+b.dataset.i, 1);
      renderPending();
      break;
    case 'att-view':
      viewAtt(b.dataset.id);
      break;
    case 'att-download':
      downloadAtt(b.dataset.id);
      break;
    case 'music':
      openMusicModal();
      break;
    case 'mus-play':
    case 'mus-next': {
      const r = st.musResults[+b.dataset.i];
      if (r) botCmd({ type: a === 'mus-next' ? 'next' : 'play', item: r }).then(() => toast(`Pedido: ${r.title}`));
      break;
    }
    case 'bot-ctl':
      botCmd({ type: b.dataset.c, arg: b.dataset.arg || '' });
      break;
    case 'open-link':
      bridge.openExternal(b.dataset.url);
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
    case 'cam':
      if (st.cam) stopCam();
      else startCam();
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
      if (st.roomServerId) {
        if (st.view !== st.roomServerId) setView(st.roomServerId);
        st.mode = 'stage';
        renderSidebar();
        renderHead();
        renderStage();
        renderControls();
      }
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
      try {
        st.me.name = await B.changeNick(st.user.uid, st.me.name, v);
        st.presenceObj.set({ name: st.me.name });
        toast('Apelido salvo!');
      } catch (err) {
        toast(B.friendlyError(err), true);
      }
      break;
    }
    case 'save-title': {
      const v = $('#ptitle').value.trim().slice(0, 60);
      try {
        await B.updateMember(st.user.uid, { title: v });
        st.me.title = v;
        toast(v ? 'Título salvo!' : 'Título removido.');
        openSettings('account');
        renderUserPanel();
      } catch (err) {
        toast(B.friendlyError(err), true);
      }
      break;
    }
    case 'pick-photo':
      pickImage(
        256,
        async (data) => {
          await B.updateMember(st.user.uid, { photo: data });
          st.me.photo = data;
          toast('Foto de perfil trocada!');
          renderUserPanel();
        },
        { round: true, title: 'Foto de perfil', after: () => openSettings('account') }
      );
      break;
    case 'remove-photo':
      await B.updateMember(st.user.uid, { photo: null }).catch(() => {});
      st.me.photo = null;
      toast('Foto removida.');
      openSettings('account');
      renderUserPanel();
      break;
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
      const sEl = $('#update-status');
      if (sEl) sEl.textContent = 'Procurando atualizações...';
      const r = await bridge.checkUpdate();
      b.disabled = false;
      if (r) {
        st.update = r;
        renderUpdate();
        maybeAutoInstall();
      }
      break;
    }
    case 'cancel-update':
      clearInterval(autoInstallTimer);
      closeModal();
      toast('Beleza. Atualiza sozinho quando você fechar o app.');
      break;
    case 'win-min':
      bridge.minimize?.();
      break;
    case 'win-close':
      bridge.close?.();
      break;
    case 'fullscreen-app':
      isFullscreen = await bridge.setFullscreen();
      renderFsButton();
      break;
    case 'voice-fx':
      st.showVoices = !st.showVoices;
      renderHead();
      renderStage();
      renderControls();
      break;
    case 'voices-close':
      st.showVoices = false;
      renderHead();
      renderStage();
      renderControls();
      break;
    case 'pick-voice':
      if (b.dataset.id !== S.voiceFilter || !b.dataset.id) setVoiceFilter(b.dataset.id).then(() => st.showVoices && renderStage());
      break;
    case 'voz-baixar':
      getAiVoice(b.dataset.id);
      break;
    case 'voz-apagar':
      removeAiVoice(b.dataset.id);
      break;
    case 'vozes-atualizar':
      loadVozes(true);
      break;
    case 'voices-monitor':
      if (!mic) await ensureMic();
      if (mic) await mic.setMonitor(!mic.monitoring, S.outputDevice);
      renderStage();
      break;
    case 'toggle-monitor': {
      if (!mic) await ensureMic();
      if (!mic) break;
      await mic.setMonitor(!mic.monitoring, S.outputDevice);
      b.classList.toggle('on', mic.monitoring);
      break;
    }
    case 'save-settings': {
      // regrava tudo, guarda o nome dos dispositivos e reaplica
      const inSel = $('[data-set="inputDevice"]');
      const outSel = $('[data-set="outputDevice"]');
      if (inSel) {
        S.inputDevice = inSel.value;
        S.inputDeviceLabel = inSel.selectedOptions[0]?.textContent || '';
      }
      if (outSel) {
        S.outputDevice = outSel.value;
        S.outputDeviceLabel = outSel.selectedOptions[0]?.textContent || '';
      }
      saveSettings();
      if (mic) await mic.update({ ...S });
      await applyOutputDevice();
      const ok = (() => {
        try {
          return JSON.parse(localStorage.getItem('cacamba.settings')).inputDevice === S.inputDevice;
        } catch (_) {
          return false;
        }
      })();
      toast(ok ? 'Configurações salvas!' : 'Não consegui salvar neste PC.', !ok);
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

document.addEventListener('input', (e) => {
  if (e.target.matches && e.target.matches('[data-botvol]')) {
    S.botVolume = +e.target.value;
    saveSettings();
    bot.setListenVolume(S.botVolume);
  }
});

document.addEventListener('contextmenu', (e) => {
  const snd = e.target.closest('.sound');
  if (snd) return soundMenu(e, snd.dataset.id);
  const msg = e.target.closest('.msg[data-id]');
  if (msg) return msgMenu(e, msg.dataset.id);
  if (e.target.closest('.bot-rm, #botbar')) return botMenu(e);
  const room = e.target.closest('.room');
  if (room) return roomMenu(e, room.dataset.room);
  const who = e.target.closest('[data-sid]');
  if (who) return personMenu(e, who.dataset.sid);
});

// destrava o áudio no primeiro clique
document.addEventListener('pointerdown', () => out.resume(), { once: true });
