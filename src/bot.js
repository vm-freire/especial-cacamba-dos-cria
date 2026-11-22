// Bot de música do Caçamba.
// Quem chama o bot vira o "anfitrião": o app dele abre o player do YouTube escondido, captura só o
// áudio e manda pra todo mundo da sala pelo canal [3] da chamada. Qualquer um da sala manda pedidos
// (/play, /pular...), que viram documentos em /bots/{servidor}/cmds; o anfitrião executa e publica o
// estado em /bots/{servidor} (tocando agora, fila, pausa) pra todo mundo ver.

const ACTIVE_MS = 45_000;
export const isBotActive = (b) => !!b && Date.now() - (b.at || 0) < ACTIVE_MS;

export const fmtDur = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

const ALIASES = {
  play: ['play', 'p', 'tocar', 'toca', 'musica', 'música'],
  next: ['proxima', 'próxima', 'playnext', 'pn'],
  skip: ['skip', 's', 'pular', 'pula', 'next'],
  pause: ['pause', 'pausar', 'pausa'],
  resume: ['resume', 'continuar', 'continua', 'despausar', 'voltar'],
  stop: ['stop', 'parar', 'para', 'sair', 'leave', 'dc', 'tchau'],
  queue: ['fila', 'queue', 'q', 'lista'],
  remove: ['remover', 'remove', 'rm', 'tirar'],
  clear: ['limpar', 'clear'],
  autoplay: ['autoplay', 'auto'],
  volume: ['volume', 'vol'],
  shuffle: ['embaralhar', 'shuffle', 'aleatorio', 'aleatório'],
  now: ['np', 'tocando', 'agora'],
  help: ['ajuda', 'help', 'comandos', 'h'],
};
const CMD_OF = {};
for (const [k, list] of Object.entries(ALIASES)) for (const a of list) CMD_OF[a] = k;

export const HELP = [
  '**Comandos do bot de música** (no #geral ou no chat do canal de voz):',
  '`/play nome ou link`: toca ou põe na fila (YouTube)',
  '`/proxima nome`: põe pra tocar logo depois da atual',
  '`/pular`, `/pausar`, `/continuar`, `/parar` (o bot sai)',
  '`/fila`, `/remover 2`, `/limpar`, `/embaralhar`',
  '`/volume 50`, `/autoplay` (liga/desliga músicas parecidas quando a fila acaba)',
  'Ou clica no botão 🎵 Música, sem digitar nada.',
].join('\n');

export function parseCommand(text) {
  const m = String(text).trim().match(/^[/!]([^\s]+)\s*([\s\S]*)$/);
  if (!m) return null;
  const type = CMD_OF[m[1].toLowerCase()];
  return type ? { type, arg: m[2].trim() } : null;
}

export function createMusicBot(ctx) {
  const { B, bridge, out, st, S, getMesh, onChange, roomName } = ctx;
  let host = null;
  let chain = Promise.resolve();

  const amHost = (serverId) => !!host && (!serverId || host.serverId === serverId);

  async function save(patch) {
    if (!host) return;
    Object.assign(host.state, patch);
    await B.updateBot(host.serverId, patch).catch((e) => console.warn('bot save', e));
  }

  function reply(ch, text) {
    const chId = ch || host?.state.lastCh;
    if (!chId) return;
    B.sendMessage(chId, { uid: st.user.uid, name: 'Caçamba Bot', color: '#ffb21e' }, text, { bot: true }).catch(() => {});
  }

  async function start(serverId, roomId) {
    if (host) await stop(true);
    const sourceId = await bridge.bot.open();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: sourceId } },
      video: false,
    });
    const c = out.ctx;
    const src = c.createMediaStreamSource(stream);
    const gain = c.createGain();
    gain.gain.value = 0.7;
    const dest = c.createMediaStreamDestination();
    src.connect(gain);
    gain.connect(dest);
    const track = dest.stream.getAudioTracks()[0];
    host = {
      serverId,
      stream,
      src,
      gain,
      track,
      lastProgressSave: 0,
      loadingSince: 0,
      state: {
        roomId,
        hostSid: st.sid,
        hostUid: st.user.uid,
        hostName: st.me.name,
        at: Date.now(),
        now: null,
        queue: [],
        paused: false,
        startedAt: 0,
        pausedAt: 0,
        ad: false,
        autoplay: true,
        volume: 70,
        history: [],
        lastCh: null,
      },
    };
    getMesh()?.setBotTrack(track);
    out.addTrack('bot:me', track, S.botVolume ?? 70);
    await B.setBot(serverId, host.state);
    host.cmdUnsub = B.watchBotCmds(serverId, (list) => list.forEach((cmd) => (chain = chain.then(() => run(cmd)).catch((e) => console.error('bot cmd', e)))));
    host.hb = setInterval(() => {
      save({ at: Date.now() });
      // travou carregando (vídeo bloqueado, sem internet): pula
      // (anúncio e pausa não contam como "travado")
      if (host && host.loadingSince && !host.state.ad && !host.state.paused && Date.now() - host.loadingSince > 25_000) {
        reply(null, `⚠️ "${host.state.now?.title || 'música'}" não carregou. Pulando...`);
        playNext();
      }
    }, 10_000);
    onChange();
  }

  async function stop(silent = false) {
    if (!host) return;
    const h = host;
    host = null;
    clearInterval(h.hb);
    h.cmdUnsub?.();
    bridge.bot.close().catch(() => {});
    h.stream.getTracks().forEach((t) => t.stop());
    try {
      h.src.disconnect();
      h.gain.disconnect();
    } catch (_) {}
    getMesh()?.setBotTrack(null);
    out.removeTrack('bot:me');
    if (!silent && h.state.lastCh) {
      B.sendMessage(h.state.lastCh, { uid: st.user.uid, name: 'Caçamba Bot', color: '#ffb21e' }, '👋 Saí do canal.', { bot: true }).catch(() => {});
    }
    await B.clearBot(h.serverId).catch(() => {});
    onChange();
  }

  async function resolve(q) {
    const list = await bridge.bot.search(q, 1);
    return list && list[0];
  }

  async function run(c) {
    if (!host) return;
    B.deleteBotCmd(host.serverId, c.id).catch(() => {});
    if (c.ch) host.state.lastCh = c.ch;
    const s = host.state;
    const by = c.by || 'alguém';
    switch (c.type) {
      case 'play':
      case 'next': {
        let item = c.item;
        if (!item) {
          try {
            item = await resolve(c.arg);
          } catch (e) {
            console.error(e);
            return reply(c.ch, `⚠️ A busca no YouTube falhou agora. Tenta de novo.`);
          }
        }
        if (!item) return reply(c.ch, `Não achei nada pra "${c.arg}".`);
        item = { id: item.id, title: item.title, author: item.author || '', duration: item.duration || 0, thumb: item.thumb || '', by };
        if (c.type === 'next') s.queue.unshift(item);
        else s.queue.push(item);
        if (!s.now) return playNext();
        await save({ queue: s.queue, lastCh: s.lastCh });
        return reply(c.ch, `➕ Na fila (#${c.type === 'next' ? 1 : s.queue.length}): **${item.title}** (${fmtDur(item.duration)}), pedido por ${by}`);
      }
      case 'skip':
        if (!s.now) return reply(c.ch, 'Não tem nada tocando.');
        reply(c.ch, `⏭️ ${by} pulou **${s.now.title}**.`);
        return playNext();
      case 'pause':
        if (!s.now || s.paused) return;
        bridge.bot.ctl({ type: 'pause' });
        await save({ paused: true, pausedAt: Date.now() });
        return reply(c.ch, `⏸️ Pausado por ${by}.`);
      case 'resume':
        if (!s.now || !s.paused) return;
        bridge.bot.ctl({ type: 'resume' });
        await save({ paused: false, startedAt: s.startedAt + (Date.now() - s.pausedAt) });
        return reply(c.ch, `▶️ Voltou a tocar (${by}).`);
      case 'stop':
        return stop();
      case 'remove': {
        const n = parseInt(c.arg, 10);
        if (!n || n < 1 || n > s.queue.length) return reply(c.ch, `Número inválido. A fila tem ${s.queue.length} música(s).`);
        const [rm] = s.queue.splice(n - 1, 1);
        await save({ queue: s.queue });
        return reply(c.ch, `🗑️ Tirei **${rm.title}** da fila.`);
      }
      case 'clear':
        await save({ queue: [] });
        return reply(c.ch, '🧹 Fila limpa.');
      case 'shuffle':
        for (let i = s.queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [s.queue[i], s.queue[j]] = [s.queue[j], s.queue[i]];
        }
        await save({ queue: s.queue });
        return reply(c.ch, '🔀 Fila embaralhada.');
      case 'autoplay':
        await save({ autoplay: !s.autoplay });
        return reply(c.ch, s.autoplay ? '🔁 Autoplay ligado: quando a fila acabar, toco músicas parecidas.' : '⏹️ Autoplay desligado.');
      case 'volume': {
        const v = Math.max(0, Math.min(150, parseInt(c.arg, 10)));
        if (isNaN(v)) return reply(c.ch, `Volume do bot: ${s.volume}%. Use /volume 0 a 150.`);
        host.gain.gain.setTargetAtTime(v / 100, out.ctx.currentTime, 0.05);
        await save({ volume: v });
        return reply(c.ch, `🔊 Volume do bot: ${v}%.`);
      }
      case 'queue': {
        if (!s.now && !s.queue.length) return reply(c.ch, 'A fila tá vazia.');
        const lines = [];
        if (s.now) lines.push(`🎶 Agora: **${s.now.title}** (${fmtDur(s.now.duration)})`);
        s.queue.slice(0, 15).forEach((q, i) => lines.push(`${i + 1}. ${q.title} (${fmtDur(q.duration)}), ${q.by}`));
        if (s.queue.length > 15) lines.push(`...e mais ${s.queue.length - 15}`);
        return reply(c.ch, lines.join('\n'));
      }
      case 'now':
        return reply(c.ch, s.now ? `🎶 Tocando: **${s.now.title}**` : 'Nada tocando.');
    }
  }

  async function playNext() {
    if (!host) return;
    const s = host.state;
    let next = s.queue.shift();
    if (!next && s.autoplay && s.now) {
      try {
        const rel = await bridge.bot.related(s.now.id);
        const recent = new Set(s.history.slice(-40));
        const pick = rel.find((r) => !recent.has(r.id));
        if (pick) next = { ...pick, by: 'autoplay' };
      } catch (e) {
        console.warn('related', e);
      }
    }
    if (!host) return;
    if (!next) {
      reply(null, '✅ A fila acabou.');
      return stop(true).then(() => null);
    }
    const history = [...s.history, next.id].slice(-50);
    host.loadingSince = Date.now();
    await save({ now: next, queue: s.queue, history, paused: false, pausedAt: 0, startedAt: Date.now(), ad: false });
    bridge.bot.play(next.id).catch(() => {});
    reply(null, `🎶 Tocando agora: **${next.title}** (${fmtDur(next.duration)})${next.by === 'autoplay' ? ' · autoplay' : `, pedido por ${next.by}`}`);
  }

  bridge.bot?.onState((p) => {
    if (!host) return;
    const s = host.state;
    if (p.gone) return stop(true);
    if (p.error && s.now) {
      reply(null, `⚠️ Não deu pra tocar **${s.now.title}** (${p.error}). Pulando...`);
      return playNext();
    }
    if (p.ended && s.now) return playNext();
    if (p.ad !== s.ad) save({ ad: p.ad });
    if (p.ad && host.loadingSince) host.loadingSince = Date.now(); // anúncio: zera o relógio do "travou"
    if (!s.now || p.ad) return;
    if (p.t > 0.5) host.loadingSince = 0;
    // mantém a barra de progresso de todo mundo certinha
    if (!s.paused && p.t > 0) {
      const startedAt = Date.now() - p.t * 1000;
      const patch = {};
      if (Math.abs(startedAt - s.startedAt) > 2500) patch.startedAt = startedAt;
      if (p.d && !s.now.duration) patch.now = { ...s.now, duration: Math.round(p.d) };
      if (Object.keys(patch).length && Date.now() - host.lastProgressSave > 3000) {
        host.lastProgressSave = Date.now();
        save(patch);
      }
    }
  });

  // pedido de qualquer pessoa (digitado ou pelos botões). channel = canal onde foi pedido.
  async function command(cmd, { serverId, channel, eph }) {
    const bot = st.bot && st.botServer === serverId ? st.bot : null;
    const active = isBotActive(bot) || amHost(serverId);
    if (cmd.type === 'help') return eph(HELP);
    const chId = channel ? channel.id : null;
    if (cmd.type === 'play' || cmd.type === 'next') {
      if (!cmd.item && !cmd.arg) return eph('Fala o nome da música: `/play nome da música` (ou cola o link).');
      const voice = channel && channel.type !== 'text' ? channel.id : null;
      const target = voice || (st.roomId && st.roomServerId === serverId ? st.roomId : null);
      if (!target) return eph('Entra num canal de voz primeiro (ou manda o comando no chat do canal de voz).');
      if (active && bot && bot.roomId !== target) return eph(`O bot já tá tocando em 🔊 ${roomName(bot.roomId)}. Usa /parar lá primeiro.`);
      if (!active) {
        if (st.roomId !== target) return eph(`Entra no canal 🔊 ${roomName(target)} pra chamar o bot.`);
        try {
          await start(serverId, target);
        } catch (e) {
          console.error('bot start', e);
          return eph('Não consegui ligar o bot neste PC. 😕');
        }
      }
    } else if (!active) {
      return eph('O bot não tá tocando. Use `/play nome da música`.');
    }
    await B.sendBotCmd(serverId, { type: cmd.type, arg: cmd.arg || '', item: cmd.item || null, by: st.me.name, ch: chId });
  }

  return {
    command,
    stop,
    amHost,
    hostServer: () => host?.serverId || null,
    hostRoom: () => host?.state.roomId || null,
    setListenVolume(v) {
      out.setVolumeWhere((k) => k === 'bot:me' || k.endsWith(':bot'), v);
    },
  };
}
