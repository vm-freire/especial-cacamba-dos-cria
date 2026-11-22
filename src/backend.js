// Firebase: contas, salas, presença, sinalização WebRTC e soundboard
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  browserLocalPersistence,
  setPersistence,
} from 'firebase/auth';
import {
  initializeFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  collection,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  writeBatch,
  getDocs,
  arrayUnion,
  arrayRemove,
  limit,
  orderBy,
} from 'firebase/firestore';
import { firebaseConfig } from './firebase-config.js';

const fbApp = initializeApp(firebaseConfig);
export const auth = getAuth(fbApp);
setPersistence(auth, browserLocalPersistence).catch(() => {});
const db = initializeFirestore(fbApp, { ignoreUndefinedProperties: true });

const COLORS = ['#f0b232', '#5865f2', '#23a55a', '#eb459e', '#ed4245', '#3ba5c9', '#e67e22', '#9b59b6'];
export const PRESENCE_STALE_MS = 75_000;

const ERR = {
  'auth/email-already-in-use': 'Esse e-mail já tem conta. Vai em "Entrar".',
  'auth/invalid-email': 'E-mail inválido.',
  'auth/weak-password': 'Senha fraca: use pelo menos 6 caracteres.',
  'auth/invalid-credential': 'E-mail ou senha errados.',
  'auth/wrong-password': 'E-mail ou senha errados.',
  'auth/user-not-found': 'E-mail ou senha errados.',
  'auth/too-many-requests': 'Muitas tentativas. Espera um pouco e tenta de novo.',
  'auth/network-request-failed': 'Sem conexão com o servidor.',
  'permission-denied': 'Sem permissão para isso.',
};
export const friendlyError = (e) =>
  ERR[e && e.code] || (e && String(e.code || '').startsWith('nick/') && e.message) || (e && e.message) || String(e);

// ---------------- Contas ----------------
export function onAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

// ---- apelidos únicos: cada apelido (minúsculo) é um documento em /usernames
export const nickKey = (name) => name.trim().toLowerCase();
function checkNick(name) {
  const nick = (name || '').trim();
  if (nick.length < 2) throw Object.assign(new Error('O apelido precisa ter pelo menos 2 letras.'), { code: 'nick/short' });
  if (nick.length > 32) throw Object.assign(new Error('O apelido pode ter no máximo 32 caracteres.'), { code: 'nick/long' });
  if (/[\/]/.test(nick) || /^\.+$/.test(nick) || /^__.*__$/.test(nick))
    throw Object.assign(new Error('O apelido não pode ter "/" nem ser só pontos.'), { code: 'nick/invalid' });
  return nick;
}
const NICK_TAKEN = () => Object.assign(new Error('Esse apelido já está em uso. Escolhe outro.'), { code: 'nick/taken' });

export async function isNickTaken(name, myUid = null) {
  const snap = await getDoc(doc(db, 'usernames', nickKey(name)));
  return snap.exists() && snap.data().uid !== myUid;
}

export async function register({ name, email, password }) {
  const nick = checkNick(name);
  if (await isNickTaken(nick)) throw NICK_TAKEN();
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  try {
    await completeProfile(cred.user, nick);
  } catch (e) {
    // alguém pegou o apelido no mesmo segundo: desfaz a conta
    await cred.user.delete().catch(() => {});
    throw e;
  }
  return cred.user;
}

export async function completeProfile(user, name) {
  const nick = checkNick(name);
  if (await isNickTaken(nick, user.uid)) throw NICK_TAKEN();
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const b = writeBatch(db);
  b.set(doc(db, 'usernames', nickKey(nick)), { uid: user.uid });
  b.set(doc(db, 'members', user.uid), {
    name: nick,
    nameLower: nickKey(nick),
    color,
    friends: [],
    createdAt: serverTimestamp(),
  });
  try {
    await b.commit();
  } catch (e) {
    if (e.code === 'permission-denied') throw NICK_TAKEN();
    throw e;
  }
  await updateProfile(user, { displayName: nick }).catch(() => {});
}

// contas antigas (antes do apelido único) não têm o registro do apelido: sem ele o Firebase recusa
// qualquer mudança no perfil (foto, título, cor). Cria o registro se o apelido estiver livre.
export async function ensureNickClaim(uid, name) {
  if (!name) return 'ok';
  const key = nickKey(name);
  const snap = await getDoc(doc(db, 'usernames', key));
  if (snap.exists()) return snap.data().uid === uid ? 'ok' : 'taken';
  const b = writeBatch(db);
  b.set(doc(db, 'usernames', key), { uid });
  b.update(doc(db, 'members', uid), { nameLower: key });
  await b.commit();
  return 'fixed';
}

export async function changeNick(uid, oldName, newName) {
  const nick = checkNick(newName);
  if (nickKey(nick) === nickKey(oldName || '')) {
    await updateDoc(doc(db, 'members', uid), { name: nick, nameLower: nickKey(nick) });
    return nick;
  }
  if (await isNickTaken(nick, uid)) throw NICK_TAKEN();
  const b = writeBatch(db);
  b.set(doc(db, 'usernames', nickKey(nick)), { uid });
  if (oldName) {
    const old = await getDoc(doc(db, 'usernames', nickKey(oldName)));
    if (old.exists() && old.data().uid === uid) b.delete(old.ref);
  }
  b.update(doc(db, 'members', uid), { name: nick, nameLower: nickKey(nick) });
  try {
    await b.commit();
  } catch (e) {
    if (e.code === 'permission-denied') throw NICK_TAKEN();
    throw e;
  }
  if (auth.currentUser) updateProfile(auth.currentUser, { displayName: nick }).catch(() => {});
  return nick;
}

export async function login(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  return cred.user;
}

export const logout = () => signOut(auth);

export async function getMember(uid) {
  const snap = await getDoc(doc(db, 'members', uid));
  return snap.exists() ? { id: uid, ...snap.data() } : null;
}

export async function updateMember(uid, data) {
  await updateDoc(doc(db, 'members', uid), data);
}

export function watchMembers(cb) {
  return onSnapshot(collection(db, 'members'), (snap) => {
    const map = new Map();
    snap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
    cb(map);
  });
}

// ---------------- Amigos ----------------
export const addFriend = (myUid, uid) => updateDoc(doc(db, 'members', myUid), { friends: arrayUnion(uid) });
export const removeFriend = (myUid, uid) => updateDoc(doc(db, 'members', myUid), { friends: arrayRemove(uid) });

// ---------------- Notificações (convites) ----------------
export const notify = (n) => addDoc(collection(db, 'notifications'), { ...n, at: serverTimestamp() });
export const dismissNotification = (id) => deleteDoc(doc(db, 'notifications', id));
export function watchNotifications(uid, cb) {
  return onSnapshot(query(collection(db, 'notifications'), where('to', '==', uid)), (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0));
    cb(list, snap.docChanges().filter((c) => c.type === 'added' && !snap.metadata.hasPendingWrites).map((c) => ({ id: c.doc.id, ...c.doc.data() })));
  });
}

// ---------------- Servidores ----------------
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const SERVER_COLORS = ['#ffb21e', '#5865f2', '#23a55a', '#eb459e', '#ed4245', '#3ba5c9', '#e67e22', '#9b59b6'];
const DEFAULT_ROOMS = ['Geral', 'Jogatina', 'Resenha', 'AFK'];

export function watchMyServers(uid, cb) {
  return onSnapshot(query(collection(db, 'servers'), where('members', 'array-contains', uid)), (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
    cb(list);
  });
}

export async function createServer(name, uid) {
  const ref = doc(collection(db, 'servers'));
  await setDoc(ref, {
    name: name.slice(0, 40),
    ownerId: uid,
    members: [uid],
    code: newCode(),
    color: SERVER_COLORS[Math.floor(Math.random() * SERVER_COLORS.length)],
    createdAt: serverTimestamp(),
  });
  const b = writeBatch(db);
  b.set(doc(db, 'rooms', geralId(ref.id)), GERAL(ref.id));
  DEFAULT_ROOMS.forEach((r, i) => b.set(doc(collection(db, 'rooms')), { serverId: ref.id, name: r, order: i + 1 }));
  await b.commit();
  return ref.id;
}

// ---- canais de texto: todo servidor tem um #geral fixo (id previsível, não dá pra apagar)
const geralId = (serverId) => `${serverId}_geral`;
const GERAL = (serverId) => ({ serverId, name: 'geral', type: 'text', fixed: true, order: 0 });
export async function ensureGeral(serverId) {
  const ref = doc(db, 'rooms', geralId(serverId));
  const snap = await getDoc(ref);
  if (!snap.exists()) await setDoc(ref, GERAL(serverId));
}
export const createTextChannel = (serverId, name, order) =>
  addDoc(collection(db, 'rooms'), { serverId, name: channelName(name), type: 'text', order });
export const channelName = (name) =>
  name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 40) || 'canal';

export function watchMessages(roomId, cb) {
  const q = query(collection(db, 'rooms', roomId, 'messages'), orderBy('ts', 'desc'), limit(150));
  return onSnapshot(
    q,
    (snap) => {
      const list = [];
      snap.forEach((d) => {
        const m = d.data({ serverTimestamps: 'estimate' });
        list.push({ id: d.id, ...m, time: m.ts?.toMillis?.() || m.at || Date.now() });
      });
      cb(list.reverse());
    },
    (e) => console.error('mensagens', e)
  );
}
export const sendMessage = (roomId, me, text, extra = {}) =>
  addDoc(collection(db, 'rooms', roomId, 'messages'), {
    uid: me.uid,
    name: me.name,
    color: me.color || null,
    text: (text || '').slice(0, 2000),
    at: Date.now(),
    ts: serverTimestamp(),
    ...extra,
  });

// ---- anexos (imagens e arquivos pequenos): o conteúdo fica num documento próprio (até ~700 KB)
export async function uploadAttachment({ serverId, roomId, uid, name, type, size, data }) {
  const ref = await addDoc(collection(db, 'attachments'), { serverId, roomId, uid, name: name.slice(0, 120), type: type || '', size, data, at: Date.now() });
  return ref.id;
}
export async function getAttachment(id) {
  const snap = await getDoc(doc(db, 'attachments', id));
  return snap.exists() ? snap.data() : null;
}

// ---- bot de música: estado em /bots/{servidor}, pedidos em /bots/{servidor}/cmds
export function watchBot(serverId, cb) {
  return onSnapshot(doc(db, 'bots', serverId), (snap) => cb(snap.exists() ? snap.data() : null), () => cb(null));
}
export const setBot = (serverId, data) => setDoc(doc(db, 'bots', serverId), data);
export const updateBot = (serverId, data) => updateDoc(doc(db, 'bots', serverId), data);
export const clearBot = (serverId) => deleteDoc(doc(db, 'bots', serverId));
export const sendBotCmd = (serverId, cmd) => addDoc(collection(db, 'bots', serverId, 'cmds'), { ...cmd, at: Date.now() });
export function watchBotCmds(serverId, cb) {
  return onSnapshot(collection(db, 'bots', serverId, 'cmds'), (snap) => {
    const list = [];
    snap.docChanges().forEach((c) => c.type === 'added' && list.push({ id: c.doc.id, ...c.doc.data() }));
    list.sort((a, b) => (a.at || 0) - (b.at || 0));
    if (list.length) cb(list);
  });
}
export const deleteBotCmd = (serverId, id) => deleteDoc(doc(db, 'bots', serverId, 'cmds', id));
export const deleteMessage = (roomId, id) => deleteDoc(doc(db, 'rooms', roomId, 'messages', id));

export async function findServerByCode(code) {
  const snap = await getDocs(query(collection(db, 'servers'), where('code', '==', code.trim().toUpperCase()), limit(1)));
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

export const joinServer = (serverId, uid) => updateDoc(doc(db, 'servers', serverId), { members: arrayUnion(uid) });
export const leaveServer = (serverId, uid) => updateDoc(doc(db, 'servers', serverId), { members: arrayRemove(uid) });
export const setServerIcon = (id, icon) => updateDoc(doc(db, 'servers', id), { icon: icon || null });
export const renameServer = (id, name) => updateDoc(doc(db, 'servers', id), { name: name.slice(0, 40) });
export const resetServerCode = (id) => updateDoc(doc(db, 'servers', id), { code: newCode() });
export async function deleteServer(id) {
  const rooms = await getDocs(query(collection(db, 'rooms'), where('serverId', '==', id)));
  const b = writeBatch(db);
  rooms.forEach((r) => b.delete(r.ref));
  b.delete(doc(db, 'servers', id)); // junto no mesmo lote: o #geral só pode sumir se o servidor sumir junto
  await b.commit();
}

// ---------------- Salas ----------------
export function watchRooms(serverId, cb) {
  return onSnapshot(query(collection(db, 'rooms'), where('serverId', '==', serverId)), (snap) => {
    const rooms = [];
    snap.forEach((d) => rooms.push({ id: d.id, ...d.data() }));
    rooms.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
    cb(rooms);
  });
}

export const createRoom = (serverId, name, order) =>
  addDoc(collection(db, 'rooms'), { serverId, name: name.slice(0, 40), order });
export const renameRoom = (id, name) => updateDoc(doc(db, 'rooms', id), { name: name.slice(0, 40) });
export const deleteRoom = (id) => deleteDoc(doc(db, 'rooms', id));

// ---------------- Presença ----------------
export class Presence {
  constructor(sid, uid) {
    this.sid = sid;
    this.uid = uid;
    this.ref = doc(db, 'presence', sid);
    this.state = {};
    this.timer = null;
  }

  async start(state) {
    this.state = { ...state, uid: this.uid };
    await setDoc(this.ref, { ...this.state, at: Date.now(), ts: serverTimestamp() });
    this.timer = setInterval(() => this.beat(), 25_000);
  }

  beat() {
    updateDoc(this.ref, { at: Date.now(), ts: serverTimestamp() }).catch(() =>
      setDoc(this.ref, { ...this.state, at: Date.now(), ts: serverTimestamp() }).catch(() => {})
    );
  }

  async set(patch) {
    Object.assign(this.state, patch);
    await updateDoc(this.ref, { ...patch, at: Date.now() }).catch(() =>
      setDoc(this.ref, { ...this.state, at: Date.now(), ts: serverTimestamp() }).catch(() => {})
    );
  }

  async stop() {
    clearInterval(this.timer);
    await deleteDoc(this.ref).catch(() => {});
  }
}

export function watchPresence(cb) {
  return onSnapshot(collection(db, 'presence'), (snap) => {
    const list = [];
    const now = Date.now();
    snap.forEach((d) => {
      const p = { sid: d.id, ...d.data() };
      // relógios diferentes: usa o timestamp do servidor quando disponível
      const at = p.ts && p.ts.toMillis ? Math.max(p.ts.toMillis(), p.at || 0) : p.at || 0;
      if (now - at < PRESENCE_STALE_MS) list.push(p);
      else if (now - at > 10 * 60_000) deleteDoc(d.ref).catch(() => {}); // limpa fantasmas
    });
    cb(list);
  });
}

// ---------------- Sinalização WebRTC ----------------
export function sendSignal(from, to, data) {
  return addDoc(collection(db, 'signals'), {
    from,
    to,
    data: JSON.stringify(data),
    at: serverTimestamp(),
  }).catch((e) => console.error('signal send', e));
}

export function watchSignals(mySid, cb) {
  return onSnapshot(query(collection(db, 'signals'), where('to', '==', mySid)), (snap) => {
    const added = snap
      .docChanges()
      .filter((c) => c.type === 'added')
      .map((c) => c.doc);
    added.sort((a, b) => {
      const ta = a.data().at ? a.data().at.toMillis() : Infinity;
      const tb = b.data().at ? b.data().at.toMillis() : Infinity;
      return ta - tb;
    });
    for (const d of added) {
      const v = d.data();
      try {
        cb(v.from, JSON.parse(v.data));
      } catch (e) {
        console.error(e);
      }
      deleteDoc(d.ref).catch(() => {});
    }
  });
}

// ---------------- Soundboard ----------------
export function watchSounds(cb) {
  return onSnapshot(collection(db, 'sounds'), (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
    cb(list);
  });
}

export async function uploadSound({ uid, name, emoji, dataUrl, volume, serverId, img, start, end }) {
  const dataRef = await addDoc(collection(db, 'soundData'), { data: dataUrl });
  await setDoc(doc(db, 'sounds', dataRef.id), {
    uid,
    name: name.slice(0, 40),
    emoji: emoji || '🔊',
    volume: volume ?? 100,
    serverId: serverId || null,
    img: img || null,
    start: start || 0,
    end: end || null,
    createdAt: serverTimestamp(),
  });
  return dataRef.id;
}

export async function getSoundData(id) {
  const snap = await getDoc(doc(db, 'soundData', id));
  return snap.exists() ? snap.data().data : null;
}

export async function deleteSound(id) {
  await deleteDoc(doc(db, 'sounds', id));
  await deleteDoc(doc(db, 'soundData', id)).catch(() => {});
}

export const updateSound = (id, data) => updateDoc(doc(db, 'sounds', id), data);

