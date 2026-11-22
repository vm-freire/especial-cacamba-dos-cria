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
export const friendlyError = (e) => ERR[e && e.code] || (e && e.message) || String(e);

// ---------------- Contas ----------------
export function onAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export async function register({ name, email, password }) {
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  await completeProfile(cred.user, name);
  return cred.user;
}

export async function completeProfile(user, name) {
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const nick = name.trim().slice(0, 32);
  await setDoc(doc(db, 'members', user.uid), {
    name: nick,
    nameLower: nick.toLowerCase(),
    color,
    friends: [],
    createdAt: serverTimestamp(),
  });
  await updateProfile(user, { displayName: nick }).catch(() => {});
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
  if (data.name) data.nameLower = data.name.toLowerCase();
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
  DEFAULT_ROOMS.forEach((r, i) => b.set(doc(collection(db, 'rooms')), { serverId: ref.id, name: r, order: i + 1 }));
  await b.commit();
  return ref.id;
}

export async function findServerByCode(code) {
  const snap = await getDocs(query(collection(db, 'servers'), where('code', '==', code.trim().toUpperCase()), limit(1)));
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

export const joinServer = (serverId, uid) => updateDoc(doc(db, 'servers', serverId), { members: arrayUnion(uid) });
export const leaveServer = (serverId, uid) => updateDoc(doc(db, 'servers', serverId), { members: arrayRemove(uid) });
export const renameServer = (id, name) => updateDoc(doc(db, 'servers', id), { name: name.slice(0, 40) });
export const resetServerCode = (id) => updateDoc(doc(db, 'servers', id), { code: newCode() });
export async function deleteServer(id) {
  const rooms = await getDocs(query(collection(db, 'rooms'), where('serverId', '==', id)));
  const b = writeBatch(db);
  rooms.forEach((r) => b.delete(r.ref));
  await b.commit().catch(() => {});
  await deleteDoc(doc(db, 'servers', id));
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

export async function uploadSound({ uid, name, emoji, dataUrl, volume }) {
  const dataRef = await addDoc(collection(db, 'soundData'), { data: dataUrl });
  await setDoc(doc(db, 'sounds', dataRef.id), {
    uid,
    name: name.slice(0, 40),
    emoji: emoji || '🔊',
    volume: volume ?? 100,
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

