// Publicação de vozes (usado só pelo Estúdio de Vozes).
// O Estúdio não guarda nenhuma chave: ele manda a senha, e quem sobe no GitHub é este servidor.
// Configure na Vercel (Settings → Environment Variables):
//   ESTUDIO_SENHA = a senha que você digita no Estúdio
//   GITHUB_TOKEN  = token "fine-grained" do GitHub só deste repositório, com permissão Contents: Read and write
// Arquivos ficam no release "vozes" do repositório, em pedaços de até 4 MB (limite da Vercel).
const crypto = require('crypto');

const REPO = 'vm-freire/especial-cacamba-dos-cria';
const TAG = 'vozes';
const NOME_OK = /^[a-z0-9][a-z0-9-]{0,60}\.(onnx|jpg)(\.p\d{1,3})?$/;

function senhaCerta(dada) {
  const certa = process.env.ESTUDIO_SENHA || '';
  if (!certa || !dada) return false;
  const a = crypto.createHash('sha256').update(String(dada)).digest();
  const b = crypto.createHash('sha256').update(certa).digest();
  return crypto.timingSafeEqual(a, b);
}

async function gh(path, opts = {}) {
  const r = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cacamba-estudio',
      ...(opts.headers || {}),
    },
  });
  return r;
}

async function release() {
  const r = await gh(`/repos/${REPO}/releases/tags/${TAG}`);
  if (!r.ok) throw new Error(`release ${TAG} não encontrado (${r.status})`);
  return r.json();
}

async function listarAssets(id) {
  const out = [];
  for (let page = 1; page < 20; page++) {
    const r = await gh(`/repos/${REPO}/releases/${id}/assets?per_page=100&page=${page}`);
    if (!r.ok) throw new Error('não consegui listar os arquivos');
    const a = await r.json();
    out.push(...a);
    if (a.length < 100) break;
  }
  return out;
}

async function subir(rel, nome, buf, tipo) {
  // troca se já existir
  const velho = (await listarAssets(rel.id)).find((a) => a.name === nome);
  if (velho) await gh(`/repos/${REPO}/releases/assets/${velho.id}`, { method: 'DELETE' });
  const r = await gh(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(nome)}`, {
    method: 'POST',
    headers: { 'Content-Type': tipo },
    body: buf,
  });
  if (!r.ok) throw new Error(`GitHub recusou ${nome} (${r.status})`);
}

function corpo(req) {
  return new Promise((resolve, reject) => {
    // a Vercel já entrega o corpo lido em req.body (Buffer pra octet-stream); senão lê o stream
    const b = req.body;
    if (Buffer.isBuffer(b)) return resolve(b);
    if (typeof b === 'string') return resolve(Buffer.from(b));
    if (b && typeof b === 'object') return resolve(Buffer.from(JSON.stringify(b)));
    const parts = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > 4.4e6) reject(new Error('pedaço grande demais'));
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });
  if (!process.env.GITHUB_TOKEN || !process.env.ESTUDIO_SENHA) return res.status(503).json({ erro: 'servidor sem configuração (ESTUDIO_SENHA / GITHUB_TOKEN na Vercel)' });
  if (!senhaCerta(req.headers['x-senha'])) {
    await new Promise((r) => setTimeout(r, 1200)); // atrasa quem tenta adivinhar
    return res.status(401).json({ erro: 'senha errada' });
  }
  const acao = String(req.query.acao || '');
  try {
    if (acao === 'ping') return res.status(200).json({ ok: true });
    const rel = await release();
    if (acao === 'enviar') {
      const nome = String(req.query.nome || '');
      if (!NOME_OK.test(nome)) return res.status(400).json({ erro: 'nome de arquivo inválido' });
      const buf = await corpo(req);
      if (!buf.length) return res.status(400).json({ erro: 'vazio' });
      await subir(rel, nome, buf, 'application/octet-stream');
      return res.status(200).json({ ok: true, bytes: buf.length });
    }
    if (acao === 'catalogo') {
      const buf = await corpo(req);
      const cat = JSON.parse(buf.toString('utf8'));
      if (!cat || !Array.isArray(cat.vozes)) return res.status(400).json({ erro: 'catálogo inválido' });
      await subir(rel, 'voices.json', Buffer.from(JSON.stringify(cat, null, 2)), 'application/json');
      return res.status(200).json({ ok: true });
    }
    if (acao === 'apagar') {
      // apaga um arquivo e todos os pedaços dele (nome.p0, nome.p1, ...)
      const nome = String(req.query.nome || '');
      if (!NOME_OK.test(nome)) return res.status(400).json({ erro: 'nome de arquivo inválido' });
      const alvo = (await listarAssets(rel.id)).filter((a) => a.name === nome || a.name.startsWith(nome + '.p'));
      for (const a of alvo) await gh(`/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true, apagados: alvo.length });
    }
    return res.status(400).json({ erro: 'ação desconhecida' });
  } catch (e) {
    return res.status(500).json({ erro: String((e && e.message) || e) });
  }
};

// recebe o corpo cru (pedaços binários do modelo)
module.exports.config = { api: { bodyParser: false } };
