// Estúdio de Vozes — processo principal.
// Testa uma voz (mesmo motor e mesmo caminho do Caçamba) e publica no release "vozes" do GitHub.
// Só funciona no PC de quem tem acesso de escrita ao repositório (usa o gh já logado).
import { app, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as vozes from '../src/main/vozes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// mesmo lugar do app (o motor baixado lá serve aqui também)
vozes.setBase(path.join(app.getPath('appData'), 'Especial Caçamba dos Cria', 'vozes'));
const TMP = path.join(os.tmpdir(), 'estudio-vozes');
fs.mkdirSync(TMP, { recursive: true });

let win = null;
// uma janela só: clicar no atalho de novo traz a que já está aberta pra frente
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'Estúdio de Vozes',
    backgroundColor: '#15161b',
    icon: path.join(here, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(here, 'index.html'));
  win.once('ready-to-show', () => win.focus());
  win.webContents.session.setPermissionRequestHandler((_wc, p, cb) => cb(p === 'media'));
});
app.on('window-all-closed', () => app.quit());

const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);

// ---------- servidor (Vercel): confere a senha e sobe no GitHub. Aqui não fica chave nenhuma. ----------
const API = 'https://especial-cacamba.vercel.app/api/vozes';
const PEDACO = 4000000; // limite de upload da Vercel é 4,5 MB
const fSenha = () => path.join(app.getPath('userData'), 'senha.bin');
function lerSenha() {
  try {
    const b = fs.readFileSync(fSenha());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : '';
  } catch (_) {
    return '';
  }
}
function guardarSenha(s) {
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(fSenha(), safeStorage.encryptString(s));
}
async function api(acao, params = {}, body = null, senha = lerSenha()) {
  const q = new URLSearchParams({ acao, ...params });
  let last;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(`${API}?${q}`, {
        method: 'POST',
        headers: { 'x-senha': senha, 'Content-Type': 'application/octet-stream' },
        body: body || '',
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) throw Object.assign(new Error('senha errada'), { fatal: true });
      if (!r.ok) throw Object.assign(new Error(j.erro || `servidor ${r.status}`), { fatal: r.status < 500 });
      return j;
    } catch (e) {
      last = e;
      if (e.fatal) break;
      await new Promise((r) => setTimeout(r, 1500 * (t + 1)));
    }
  }
  throw last;
}

async function lerCatalogo() {
  const r = await fetch(vozes.RELEASE_URL + 'voices.json?t=' + Date.now(), { redirect: 'follow' });
  if (r.status === 404) return { versao: 1, vozes: [] };
  if (!r.ok) throw new Error('não consegui ler o catálogo (' + r.status + ')');
  return r.json();
}

// sobe um arquivo em pedaços: nome.p0, nome.p1, ...
async function subirArquivo(nome, buf, onProg) {
  const partes = Math.max(1, Math.ceil(buf.length / PEDACO));
  for (let i = 0; i < partes; i++) {
    await api('enviar', { nome: `${nome}.p${i}` }, buf.subarray(i * PEDACO, (i + 1) * PEDACO));
    if (onProg) onProg((i + 1) / partes);
  }
  return partes;
}

ipcMain.handle('estado', async () => ({ motor: vozes.motorInstalado(), tamanhoMotor: vozes.MOTOR_TAMANHO, temSenha: !!lerSenha() }));

ipcMain.handle('senha', async (_e, s) => {
  await api('ping', {}, null, String(s));
  guardarSenha(String(s));
  return true;
});

ipcMain.handle('instalarMotor', () => vozes.instalarMotor((p) => send('prog', { tipo: 'motor', p })));

ipcMain.handle('catalogo', async () => {
  const c = await lerCatalogo();
  // fotos pra mostrar na lista (mesmo jeito que o app baixa)
  for (const v of c.vozes || []) {
    if (!v.foto) continue;
    try {
      const urls = v.foto.partes ? Array.from({ length: v.foto.partes }, (_, i) => vozes.RELEASE_URL + v.foto.arquivo + '.p' + i) : [vozes.RELEASE_URL + v.foto.arquivo];
      const bufs = [];
      for (const u of urls) bufs.push(Buffer.from(await (await fetch(u, { redirect: 'follow' })).arrayBuffer()));
      v.fotoUrl = 'data:image/jpeg;base64,' + Buffer.concat(bufs).toString('base64');
    } catch (_) {}
  }
  return c;
});

ipcMain.handle('escolherArquivo', async (_e, tipo) => {
  const filtros = {
    modelo: [{ name: 'Modelo de voz (RVC)', extensions: ['onnx', 'pth'] }],
    audio: [{ name: 'Áudio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a'] }],
    foto: [{ name: 'Imagem', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  }[tipo];
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: filtros });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  const out = { path: p, nome: path.basename(p), tamanho: fs.statSync(p).size };
  if (tipo !== 'modelo') out.bytes = fs.readFileSync(p);
  return out;
});

// ---------- modelo ----------
let carregado = ''; // caminho do modelo carregado no motor
async function prepararModelo(p) {
  if (!fs.existsSync(p)) throw new Error('arquivo do modelo sumiu');
  if (fs.statSync(p).size > 400e6) throw new Error('modelo grande demais (máx. 400 MB)');
  const e = await vozes.getEngine();
  if (carregado !== p) {
    const r = await e.loadVoice(p);
    carregado = p;
    return { ...r, gpu: e.gpu };
  }
  return { sr: e.voice.sr, gpu: e.gpu, kind: e.voice.kind };
}

ipcMain.handle('carregarModelo', async (_e, p) => {
  let onnx = p;
  if (/\.pth$/i.test(p)) {
    send('prog', { tipo: 'pth', msg: 'Convertendo .pth para .onnx (1 a 3 minutos)…' });
    onnx = await pthParaOnnx(p);
  }
  const r = await prepararModelo(onnx);
  return { ...r, onnx, tamanho: fs.statSync(onnx).size };
});

// áudio 16 kHz (vem da página) -> voz convertida 48 kHz, pelo mesmo caminho do tempo real
ipcMain.handle('testar', async (_e, { modelo, audio16, tom, f0 }) => {
  await prepararModelo(modelo);
  const e = await vozes.getEngine();
  const a16 = new Float32Array(audio16);
  const t = performance.now();
  // tom de quem gravou medido antes, pra o clipe inteiro já sair no tom certo (no app ele aprende em ~2 s de fala)
  const userF0 = Number(f0) ? await e.medianF0(a16) : 0;
  const r = await e.convertWhole(a16, { tran: Number(tom) || 0, f0Target: Number(f0) || 0, userF0 });
  return { audio: r.audio, tran: r.tran, userF0: Math.round(r.userF0 || 0), ms: Math.round(performance.now() - t), segundos: a16.length / 16000 };
});

ipcMain.handle('medianaF0', async (_e, audio16) => {
  const e = await vozes.getEngine();
  return Math.round(await e.medianF0(new Float32Array(audio16)));
});

// ---------- .pth -> .onnx (usa o w-okada instalado só neste PC, ligado só durante a conversão) ----------
const VC_DIR = path.join(os.homedir(), 'VoiceChanger', 'app', 'MMVCServerSIO');
async function pthParaOnnx(pth) {
  const exe = path.join(VC_DIR, 'MMVCServerSIO.exe');
  if (!fs.existsSync(exe)) throw new Error('pra converter .pth precisa do conversor em ' + VC_DIR + ' (ou exporte o .onnx no Colab)');
  // sem abrir a janela própria dele
  const nativo = path.join(VC_DIR, 'voice-changer-native-client.exe');
  if (fs.existsSync(nativo)) fs.renameSync(nativo, nativo + '.desligado');
  // essa versão sempre escuta na 18888 (o processo do servidor ignora o -p)
  const port = 18888;
  const pre = 'pretrain/';
  const args = ['-p', String(port), '--https', 'false', '--model_dir', 'model_dir', '--samples', 'samples.json', '--logLevel', 'error',
    '--content_vec_500', pre + 'checkpoint_best_legacy_500.pt', '--content_vec_500_onnx', pre + 'content_vec_500.onnx', '--content_vec_500_onnx_on', 'true',
    '--hubert_base', pre + 'hubert_base.pt', '--hubert_base_jp', pre + 'rinna_hubert_base_jp.pt', '--hubert_soft', pre + 'hubert/hubert-soft-0d54a1f4.pt',
    '--nsf_hifigan', pre + 'nsf_hifigan/model', '--crepe_onnx_full', pre + 'crepe_onnx_full.onnx', '--crepe_onnx_tiny', pre + 'crepe_onnx_tiny.onnx', '--rmvpe', pre + 'rmvpe.pt'];
  const proc = spawn(exe, args, { cwd: VC_DIR, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  const matar = () => {
    try {
      spawn('taskkill', ['/IM', 'MMVCServerSIO.exe', '/T', '/F'], { windowsHide: true });
    } catch (_) {}
  };
  try {
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > 240000) throw new Error('o conversor não ligou');
      if (proc.exitCode != null) throw new Error('o conversor fechou: ' + log.slice(-300));
      try {
        const r = await fetch(url + '/info');
        if (r.ok) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    const nome = 'estudio_' + Date.now() + '.pth';
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(pth)]), nome + '_0');
    fd.append('filename', nome + '_0');
    let r = await fetch(url + '/upload_file', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('upload no conversor falhou');
    const fc = new FormData();
    fc.append('filename', nome);
    fc.append('filenameChunkNum', '1');
    r = await fetch(url + '/concat_uploaded_file', { method: 'POST', body: fc });
    if (!r.ok) throw new Error('upload no conversor falhou (juntar)');
    const slot = 0;
    const fl = new FormData();
    fl.append('slot', String(slot));
    fl.append('isHalf', 'false');
    fl.append('params', JSON.stringify({ voiceChangerType: 'RVC', slot, isSampleMode: false, sampleId: '', files: [{ name: nome, kind: 'rvcModel', dir: '' }], params: {} }));
    r = await fetch(url + '/load_model', { method: 'POST', body: fl });
    if (!r.ok) throw new Error('o conversor não aceitou o modelo');
    const fu = new FormData();
    fu.append('key', 'modelSlotIndex');
    fu.append('val', String(slot));
    await fetch(url + '/update_settings', { method: 'POST', body: fu });
    r = await fetch(url + '/onnx');
    const info = await r.json().catch(() => null);
    if (!info || info.status !== 'ok' || !info.path) throw new Error('a conversão pra .onnx falhou (o .pth é de RVC?)');
    const dl = await fetch(url + info.path.replace(/\\/g, '/').replace(/^([^/])/, '/$1'));
    if (!dl.ok) throw new Error('não consegui pegar o .onnx convertido');
    const out = path.join(TMP, path.basename(pth).replace(/\.pth$/i, '') + '.onnx');
    fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
    return out;
  } finally {
    matar();
  }
}

// ---------- publicar ----------
const slug = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'voz';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

ipcMain.handle('publicar', async (_e, d) => {
  if (!lerSenha()) throw new Error('falta a senha de publicação');
  const cat = await lerCatalogo();
  cat.versao = 1;
  cat.vozes = cat.vozes || [];
  let id = d.id;
  if (!id) {
    id = slug(d.nome);
    let n = 2;
    while (cat.vozes.some((v) => v.id === id)) id = slug(d.nome).slice(0, 36) + '-' + n++;
  }
  const antiga = cat.vozes.find((v) => v.id === id);
  const voz = {
    id,
    nome: String(d.nome).trim().slice(0, 40),
    desc: String(d.desc || '').trim().slice(0, 80),
    tom: Math.max(-24, Math.min(24, Math.round(Number(d.tom) || 0))),
    f0: Math.round(Number(d.f0) || 0),
    modelo: antiga ? antiga.modelo : null,
    foto: antiga ? antiga.foto : null,
    atualizado: new Date().toISOString(),
  };
  // nomes com pedaço do hash: arquivo novo nunca pisa no antigo enquanto alguém baixa
  if (d.modelo) {
    await prepararModelo(d.modelo); // confere que o motor abre antes de mandar pra todo mundo
    const buf = fs.readFileSync(d.modelo);
    const h = sha(buf);
    const nome = `${id}-${h.slice(0, 8)}.onnx`;
    send('prog', { tipo: 'pub', msg: 'Enviando o modelo…', p: 0 });
    const partes = await subirArquivo(nome, buf, (p) => send('prog', { tipo: 'pub', msg: 'Enviando o modelo…', p }));
    voz.modelo = { arquivo: nome, partes, tamanho: buf.length, sha256: h };
  }
  if (!voz.modelo) throw new Error('falta o modelo da voz');
  if (d.foto) {
    const buf = Buffer.from(d.foto);
    const h = sha(buf);
    const nome = `${id}-${h.slice(0, 8)}.jpg`;
    const partes = await subirArquivo(nome, buf);
    voz.foto = { arquivo: nome, partes, sha256: h };
  } else if (d.semFoto) voz.foto = null;
  if (antiga) cat.vozes[cat.vozes.indexOf(antiga)] = voz;
  else cat.vozes.push(voz);
  send('prog', { tipo: 'pub', msg: 'Atualizando o catálogo…', p: 1 });
  // catálogo por último: ninguém vê a voz antes dos arquivos estarem lá
  await api('catalogo', {}, Buffer.from(JSON.stringify(cat)));
  // limpa os arquivos antigos que não são mais usados
  if (antiga) {
    for (const [a, n] of [[antiga.modelo, voz.modelo], [antiga.foto, voz.foto]]) {
      if (a && (!n || a.arquivo !== n.arquivo)) await api('apagar', { nome: a.arquivo }).catch(() => {});
    }
  }
  return voz;
});

ipcMain.handle('apagar', async (_e, id) => {
  const cat = await lerCatalogo();
  const v = (cat.vozes || []).find((x) => x.id === id);
  if (!v) return;
  cat.vozes = cat.vozes.filter((x) => x.id !== id);
  await api('catalogo', {}, Buffer.from(JSON.stringify(cat)));
  for (const a of [v.modelo, v.foto].filter(Boolean)) await api('apagar', { nome: a.arquivo }).catch(() => {});
});
