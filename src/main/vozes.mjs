// Vozes com IA no processo principal: catálogo, downloads (com conferência de hash) e conversão em tempo real.
// Tudo fica em <userData>/vozes. Nada de servidor: o modelo roda aqui dentro com onnxruntime (placa de vídeo).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { RvcEngine, RvcStream, HOP48 } from './rvc-core.mjs';

const REPO = 'vm-freire/especial-cacamba-dos-cria';
const TAG = 'vozes';
export const RELEASE_URL = `https://github.com/${REPO}/releases/download/${TAG}/`;

// motor fixo no código (não vem do catálogo): só roda o que foi conferido aqui
const MOTOR = {
  runtime: {
    nome: 'vozes-runtime-win-x64.zip',
    url: RELEASE_URL + 'vozes-runtime-win-x64.zip',
    tamanho: 69253120,
    sha256: '9e02c3e7c42bbae0a5d1c06aa7e64e2a7103dd0ad064a82a384017446c32e338',
  },
  contentVec: {
    nome: 'content_vec_500.onnx',
    url: 'https://huggingface.co/wok000/weights_gpl/resolve/main/content-vec/contentvec-f.onnx',
    tamanho: 378550151,
    sha256: '4b31ed3d95a568fab7952de923ff7f7d3d17128ea6fce69f665509d24c3156db',
  },
  rmvpe: {
    nome: 'rmvpe.onnx',
    url: 'https://huggingface.co/wok000/weights_gpl/resolve/main/rmvpe/rmvpe_20231006.onnx',
    tamanho: 362003174,
    sha256: '84f0586308e36157f75b77c8591bf636d6719c0c4ba95f8faf3df479e7566219',
  },
};
export const MOTOR_TAMANHO = MOTOR.runtime.tamanho + MOTOR.contentVec.tamanho + MOTOR.rmvpe.tamanho;
const MOTOR_VERSAO = 1;

let base = '';
export function setBase(dir) {
  base = dir;
}
const dirMotor = () => path.join(base, 'motor');
const dirModelos = () => path.join(base, 'modelos');
const safeId = (id) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(String(id || ''));

function readJson(f, def) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return def;
  }
}

// ---------- estado ----------
export function motorInstalado() {
  const m = readJson(path.join(dirMotor(), 'ok.json'), null);
  return !!(m && m.versao === MOTOR_VERSAO);
}

export function vozesBaixadas() {
  const out = {};
  try {
    for (const id of fs.readdirSync(dirModelos())) {
      const info = readJson(path.join(dirModelos(), id, 'voz.json'), null);
      if (info && safeId(id)) out[id] = info;
    }
  } catch (_) {}
  return out;
}

// ---------- downloads ----------
// baixa uma URL ou uma lista (pedaços do mesmo arquivo, em ordem) e confere o hash do arquivo inteiro
async function baixar(urls, destino, { tamanho, sha256 }, onProg, signal) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const tmp = destino + '.part';
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let got = 0;
  try {
    for (const url of [].concat(urls)) {
      const res = await fetch(url, { signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`download falhou (${res.status})`);
      for await (const chunk of res.body) {
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (onProg) onProg(got);
        if (tamanho && got > tamanho) throw new Error('arquivo maior que o esperado');
      }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  const h = hash.digest('hex');
  if (tamanho && got !== tamanho && !sha256) throw new Error('download incompleto');
  if (sha256 && h !== sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error('arquivo baixado veio diferente do esperado (conferência falhou)');
  }
  fs.renameSync(tmp, destino);
}

function hashArquivo(f) {
  return new Promise((r, j) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(f).on('data', (d) => h.update(d)).on('end', () => r(h.digest('hex'))).on('error', j);
  });
}

function extrairZip(zip, dest) {
  return new Promise((r, j) => {
    fs.mkdirSync(dest, { recursive: true });
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const p = spawn(tar, ['-xf', zip, '-C', dest], { windowsHide: true });
    p.on('error', j);
    p.on('exit', (c) => (c === 0 ? r() : j(new Error('não consegui extrair o motor'))));
  });
}

// arquivo do catálogo -> URLs (o Estúdio sobe em pedaços de 4 MB: nome.p0, nome.p1, ...)
const urlsDe = (a) => (a.partes ? Array.from({ length: a.partes }, (_, i) => RELEASE_URL + a.arquivo + '.p' + i) : RELEASE_URL + a.arquivo);
const ARQ_OK = /^[\w.-]+$/;

let instalando = null;
/** instala o motor (uma vez só): ~770 MB */
export function instalarMotor(onProg) {
  if (instalando) return instalando;
  instalando = (async () => {
    const d = dirMotor();
    fs.mkdirSync(d, { recursive: true });
    const livre = fs.statfsSync ? (() => { const s = fs.statfsSync(d); return s.bavail * s.bsize; })() : Infinity;
    if (livre < MOTOR_TAMANHO + 300e6) throw new Error(`falta espaço no disco: precisa de ${Math.ceil((MOTOR_TAMANHO + 300e6) / 1e9)} GB livres`);
    const partes = [MOTOR.runtime, MOTOR.contentVec, MOTOR.rmvpe];
    let feito = 0;
    for (const p of partes) {
      const dest = path.join(d, p.nome);
      const pronto = fs.existsSync(dest) && fs.statSync(dest).size === p.tamanho && (await hashArquivo(dest)) === p.sha256;
      if (!pronto) await baixar(p.url, dest, p, (n) => onProg && onProg((feito + n) / MOTOR_TAMANHO));
      feito += p.tamanho;
      onProg && onProg(feito / MOTOR_TAMANHO);
    }
    fs.rmSync(path.join(d, 'node_modules'), { recursive: true, force: true });
    await extrairZip(path.join(d, MOTOR.runtime.nome), d);
    fs.rmSync(path.join(d, MOTOR.runtime.nome), { force: true });
    fs.writeFileSync(path.join(d, 'ok.json'), JSON.stringify({ versao: MOTOR_VERSAO }));
    return true;
  })().finally(() => {
    instalando = null;
  });
  return instalando;
}

// ---------- catálogo ----------
let catalogo = null;
export async function lerCatalogo(forcar = false) {
  const cache = path.join(base, 'voices.json');
  if (catalogo && !forcar) return catalogo;
  try {
    const res = await fetch(RELEASE_URL + 'voices.json?t=' + Date.now(), { redirect: 'follow' });
    if (res.status === 404) catalogo = { vozes: [] };
    else {
      if (!res.ok) throw new Error('catálogo ' + res.status);
      catalogo = await res.json();
    }
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(catalogo));
  } catch (e) {
    catalogo = readJson(cache, null);
    if (!catalogo) throw e;
  }
  catalogo.vozes = (catalogo.vozes || []).filter((v) => safeId(v.id) && v.modelo && ARQ_OK.test(v.modelo.arquivo) && /^[0-9a-f]{64}$/.test(v.modelo.sha256 || ''));
  // fotos: baixa pra uma pasta local e manda como data URL (a página não acessa o GitHub direto)
  const fotos = path.join(base, 'fotos');
  fs.mkdirSync(fotos, { recursive: true });
  await Promise.all(
    catalogo.vozes.map(async (v) => {
      if (!v.foto || !/^[\w.-]+\.(png|jpe?g|webp)$/i.test(v.foto.arquivo)) return;
      const f = path.join(fotos, v.foto.arquivo);
      try {
        if (!fs.existsSync(f) || (v.foto.sha256 && (await hashArquivo(f)) !== v.foto.sha256)) {
          await baixar(urlsDe(v.foto), f, { tamanho: 8e6, sha256: v.foto.sha256 });
        }
        const ext = path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg');
        v.fotoUrl = `data:image/${ext};base64,` + fs.readFileSync(f).toString('base64');
      } catch (_) {}
    }),
  );
  return catalogo;
}

const baixandoVoz = new Map();
export function baixarVoz(id, onProg) {
  if (baixandoVoz.has(id)) return baixandoVoz.get(id);
  const job = (async () => {
    const cat = await lerCatalogo();
    const v = cat.vozes.find((x) => x.id === id);
    if (!v) throw new Error('voz não encontrada no catálogo');
    const d = path.join(dirModelos(), id);
    const dest = path.join(d, 'modelo.onnx');
    await baixar(urlsDe(v.modelo), dest, { tamanho: v.modelo.tamanho, sha256: v.modelo.sha256 }, (n) => onProg && onProg(n / (v.modelo.tamanho || 1)));
    const info = { id, nome: v.nome, tom: Number(v.tom) || 0, f0: Number(v.f0) || 0, sha256: v.modelo.sha256 };
    fs.writeFileSync(path.join(d, 'voz.json'), JSON.stringify(info));
    return info;
  })().finally(() => baixandoVoz.delete(id));
  baixandoVoz.set(id, job);
  return job;
}

export async function apagarVoz(id) {
  if (!safeId(id)) return;
  if (ativo && ativo.id === id) await parar();
  fs.rmSync(path.join(dirModelos(), id), { recursive: true, force: true });
}

// ---------- conversão ----------
let engine = null;
let engineLoading = null;
let ativo = null; // { id, stream }

export async function getEngine() {
  if (engine) return engine;
  if (!engineLoading) {
    engineLoading = (async () => {
      const req = createRequire(path.join(dirMotor(), 'index.js'));
      const ort = req('onnxruntime-node');
      ort.env.logLevel = 'error';
      const e = new RvcEngine(ort, {
        contentVec: path.join(dirMotor(), MOTOR.contentVec.nome),
        rmvpe: path.join(dirMotor(), MOTOR.rmvpe.nome),
      });
      await e.init();
      engine = e;
      return e;
    })().finally(() => {
      engineLoading = null;
    });
  }
  return engineLoading;
}

/** liga a voz: carrega motor + modelo. userF0 = tom médio de quem fala (aprendido antes) */
export async function iniciar(id, { userF0 = 0 } = {}) {
  if (!safeId(id)) throw new Error('voz inválida');
  if (!motorInstalado()) throw new Error('motor não instalado');
  const info = vozesBaixadas()[id];
  if (!info) throw new Error('voz não baixada');
  const e = await getEngine();
  if (!ativo || ativo.id !== id) {
    const r = await e.loadVoice(path.join(dirModelos(), id, 'modelo.onnx'));
    ativo = { id, stream: null, sr: r.sr };
  }
  ativo.stream = new RvcStream(e, { tran: info.tom, f0Target: info.f0, userF0 });
  ativo.fila = 0;
  return { gpu: e.gpu, sr: ativo.sr, hop: HOP48 };
}

/** um pedaço de 8160 amostras (48 kHz) */
export async function processar(buf) {
  if (!ativo || !ativo.stream) return null;
  const x = buf instanceof Float32Array ? buf : new Float32Array(buf);
  if (x.length !== HOP48) return null;
  // um de cada vez (a emenda depende do pedaço anterior); se acumular, descarta pra não criar atraso
  const a = ativo;
  const st = a.stream;
  if ((a.fila || 0) >= 2) return null;
  a.fila = (a.fila || 0) + 1;
  const run = (a.chain || Promise.resolve()).then(async () => {
    const t = performance.now();
    try {
      return await st.process(x);
    } finally {
      a.ms = performance.now() - t;
      a.fila--;
    }
  });
  a.chain = run.catch(() => {});
  return run;
}

export function info() {
  if (!ativo || !ativo.stream) return null;
  return { id: ativo.id, tran: ativo.stream.tran, userF0: ativo.stream.userF0, ms: ativo.ms || 0, gpu: engine && engine.gpu };
}

export async function parar() {
  if (ativo) ativo.stream = null;
}
