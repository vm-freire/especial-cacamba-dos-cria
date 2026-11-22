// Busca no YouTube pro bot de música (roda no processo principal, empacotado em dist/ytsearch.cjs).
// Só busca título/duração/relacionados: o áudio toca no player do próprio YouTube, numa janela escondida.
import vm from 'node:vm';
import { Innertube, Platform, UniversalCache } from 'youtubei.js';

// se a biblioteca precisar rodar algum código do YouTube, roda isolado (sem acesso a nada do PC)
Platform.shim.eval = async (data, env) => {
  const props = [];
  if (env.n) props.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
  return vm.runInNewContext(`(function(){${data.output}\nreturn { ${props.join(', ')} }})()`, {}, { timeout: 5000 });
};

let yt = null;
async function client() {
  if (!yt) yt = Innertube.create({ cache: new UniversalCache(false), generate_session_locally: true, lang: 'pt', location: 'BR' });
  try {
    return await yt;
  } catch (e) {
    yt = null;
    throw e;
  }
}

export function videoIdOf(q) {
  const m = String(q).match(/(?:youtu\.be\/|[?&]v=|shorts\/|embed\/|live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const text = (t) => (t && (t.text ?? t.toString?.())) || '';

export async function search(q, n = 8) {
  const y = await client();
  const id = videoIdOf(q);
  if (id) {
    const info = await y.getBasicInfo(id);
    const b = info.basic_info || {};
    return [{ id, title: b.title || 'Vídeo', author: b.author || '', duration: b.duration || 0, thumb: thumb(id) }];
  }
  const r = await y.search(q, { type: 'video' });
  return (r.videos || [])
    .filter((v) => v.id && (v.duration?.seconds || 0) > 0)
    .slice(0, n)
    .map((v) => ({ id: v.id, title: text(v.title), author: v.author?.name || '', duration: v.duration?.seconds || 0, thumb: thumb(v.id) }));
}

// músicas parecidas pra continuar tocando quando a fila acaba
export async function related(id, n = 12) {
  const y = await client();
  const info = await y.getInfo(id);
  const out = [];
  for (const x of info.watch_next_feed || []) {
    const vid = x.id || x.video_id || x.content_id;
    if (!vid || !/^[\w-]{11}$/.test(vid) || out.find((o) => o.id === vid)) continue;
    const title = text(x.title) || text(x.metadata?.title);
    if (!title) continue;
    const secs = x.duration?.seconds || 0;
    if (secs && secs > 15 * 60) continue; // pula vídeos longos (lives, mixes de 1h)
    out.push({ id: vid, title, author: x.author?.name || '', duration: secs, thumb: thumb(vid) });
    if (out.length >= n) break;
  }
  return out;
}
