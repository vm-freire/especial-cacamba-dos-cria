// Especial Caçamba dos Cria — processo principal (Electron)
const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  session,
  globalShortcut,
  shell,
  Menu,
  Tray,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');

let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (_) {
  /* sem auto-update em dev */
}

// --- Otimizações para chamada / transmissão rodando em segundo plano (enquanto joga)
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('enable-features', 'WebRtcAllowH264HardwareEncodingWin,PlatformHEVCEncoderSupport');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (process.platform === 'win32') app.setAppUserModelId('com.cacambadoscria.app');

// Perfil separado (para testar 2 contas no mesmo PC): CACAMBA_PROFILE=2
if (process.env.CACAMBA_PROFILE) app.setPath('userData', app.getPath('userData') + '-' + process.env.CACAMBA_PROFILE);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let pendingShare = null;
let tray = null;
let quitting = false; // só fecha de verdade pelo "Sair" da bandeja (ou atualização / desligar o PC)

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#111214',
    title: 'Especial Caçamba dos Cria',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#111214', symbolColor: '#b5bac1', height: 34 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Links externos abrem no navegador
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) {
      win.webContents.toggleDevTools();
    }
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
    }
  });
  // X não fecha: esconde e continua rodando na bandeja (a chamada segue)
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    trayHintOnce();
  });
  win.on('session-end', () => (quitting = true));
  win.on('enter-full-screen', () => send('fullscreen', true));
  win.on('leave-full-screen', () => send('fullscreen', false));
}

// em tela cheia o Windows esconde os botões da janela: o app desenha os dele
ipcMain.handle('win:minimize', () => win && win.minimize());
ipcMain.handle('win:close', () => win && win.close());
ipcMain.handle('win:isFullscreen', () => !!(win && win.isFullScreen()));

ipcMain.handle('win:fullscreen', (_e, on) => {
  if (!win) return false;
  win.setFullScreen(on === undefined ? !win.isFullScreen() : !!on);
  return win.isFullScreen();
});

function setupMedia() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'speaker-selection', 'fullscreen'].includes(permission));
  });
  ses.setPermissionCheckHandler(() => true);

  // getDisplayMedia() no renderer -> usa a fonte escolhida no seletor do app
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sel = pendingShare;
    pendingShare = null;
    if (!sel) return callback({});
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const src = sources.find((s) => s.id === sel.id);
      if (!src) return callback({});
      if (sel.audio && process.platform === 'win32') callback({ video: src, audio: 'loopback' });
      else callback({ video: src });
    } catch (err) {
      console.error(err);
      callback({});
    }
  });
}

ipcMain.handle('screen:sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 384, height: 216 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((s) => s.name !== 'Especial Caçamba dos Cria')
    .map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen') ? 'screen' : 'window',
      thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
});

ipcMain.handle('screen:select', (_e, sel) => {
  pendingShare = sel;
  return true;
});

ipcMain.handle('app:version', () => app.getVersion());
// ---------------------------------------------------------------- bot de música
// O som vem do player do próprio YouTube, numa janela escondida e muda; o app captura só o áudio
// dela (captura de aba) e manda pra chamada. A busca usa dist/ytsearch.cjs.
let botWin = null;
let ytsearch = null;
const yts = () => (ytsearch = ytsearch || require('./dist/ytsearch.cjs'));

// Conta do YouTube do bot: o login fica salvo só neste PC (partição persist:musicbot).
// Com Premium, o que o bot toca por este PC vem sem anúncio. A senha é digitada na página do Google; o app não vê.
const UA_CHROME = () => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
let botSesPronta = false;
function botSession() {
  const ses = session.fromPartition('persist:musicbot');
  if (!botSesPronta) {
    ses.setUserAgent(UA_CHROME()); // o Google recusa login em navegador "Electron"
    botSesPronta = true;
  }
  return ses;
}
let botRecarregar = false; // depois de entrar/sair, a próxima música abre a página do zero (com a conta nova)
async function botLogado() {
  const c = await botSession().cookies.get({ domain: 'youtube.com' }).catch(() => []);
  return c.some((x) => x.name === 'LOGIN_INFO' || x.name === 'SAPISID' || x.name === '__Secure-3PAPISID');
}
// Login: o Google recusa login dentro de apps, então abre o Chrome/Edge de verdade com um perfil SEPARADO
// (não mexe no navegador normal da pessoa). Depois do login, lê só os cookies do Google/YouTube
// pela porta de depuração local, copia pro bot e fecha essa janela. A senha nunca passa pelo app.
const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=' + encodeURIComponent('https://www.youtube.com/signin?action_handle_signin=true&next=%2F');
// depois do login o Google manda pra um vídeo conhecido: o título da janela ("Me at the zoo - YouTube")
// avisa que terminou (a própria tela de login também se chama "YouTube", então não serve)
const VIDEO_FIM = 'jNQXAC9IVRw';
const LOGIN_URL_EXT = 'https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=' + encodeURIComponent(`https://www.youtube.com/signin?action_handle_signin=true&next=${encodeURIComponent('/watch?v=' + VIDEO_FIM)}`);
const TITULO_FIM = /Me at the zoo/i;
function acharNavegador() {
  const env = process.env;
  const lista = [
    path.join(env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ];
  return lista.find((p) => p && fs.existsSync(p)) || null;
}
// conversa com o navegador pelo protocolo de depuração (só na máquina, 127.0.0.1)
function cdp(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('timeout')); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== 1) return;
      clearTimeout(t);
      try { ws.close(); } catch (_) {}
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    };
    ws.onerror = () => { clearTimeout(t); reject(new Error('ws')); };
  });
}
const COOKIE_YT = (c) => /(^|\.)(youtube\.com|google\.com)$/.test(c.domain.replace(/^\./, ''));
async function importarCookies(lista) {
  const ses = botSession();
  const same = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' };
  for (const c of lista.filter(COOKIE_YT)) {
    const host = c.domain.replace(/^\./, '');
    const ck = { url: `https://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: same[c.sameSite] || 'unspecified' };
    if (!c.name.startsWith('__Host-') && c.domain.startsWith('.')) ck.domain = c.domain;
    if (!c.session && c.expires > 0) ck.expirationDate = c.expires;
    await ses.cookies.set(ck).catch((e) => console.warn('cookie', c.name, e.message));
  }
  await ses.cookies.flushStore().catch(() => {});
}
let loginProc = null;
function loginExterno(exe) {
  const dir = path.join(app.getPath('userData'), 'yt-login');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { spawn, execFile } = require('child_process');
  const base = [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-sync'];
  // 1) Chrome normal, SEM depuração (o Google recusa login com ela ligada)
  const proc = spawn(exe, [...base, '--autoplay-policy=user-gesture-required', '--new-window', LOGIN_URL_EXT], { windowsHide: false, stdio: 'ignore' });
  loginProc = proc;
  const titulo = () =>
    new Promise((res) =>
      execFile('tasklist', ['/v', '/fo', 'csv', '/nh', '/fi', `PID eq ${proc.pid}`], { windowsHide: true, timeout: 8000 }, (e, out) => res(e ? '' : (String(out).match(/"([^"]*)"\s*$/m) || [])[1] || ''))
    );
  const esperarSair = (p, ms) => new Promise((res) => { if (p.exitCode !== null) return res(); const t = setTimeout(res, ms); p.once('exit', () => { clearTimeout(t); res(); }); });
  return new Promise((resolve) => {
    let fim = false;
    const acabar = async (ok) => {
      if (fim) return;
      fim = true;
      clearInterval(timer);
      loginProc = null;
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 4000); // apaga o perfil temporário
      botRecarregar = true;
      if (win && !win.isDestroyed()) win.focus();
      resolve(ok || (await botLogado()));
    };
    // 2) depois do login: reabre o MESMO perfil escondido, com depuração, só pra ler os cookies
    const lerSessao = async () => {
      const df = path.join(dir, 'DevToolsActivePort');
      fs.rmSync(df, { force: true });
      const h = spawn(exe, [...base, '--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
      try {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 750));
          try {
            const porta = fs.readFileSync(df, 'utf8').split(/\r?\n/)[0].trim();
            const ver = await (await fetch(`http://127.0.0.1:${porta}/json/version`)).json();
            const { cookies } = await cdp(ver.webSocketDebuggerUrl, 'Storage.getCookies');
            const logado = cookies.some((c) => /youtube\.com$/.test(c.domain) && (c.name === 'LOGIN_INFO' || c.name === 'SAPISID' || c.name === '__Secure-3PAPISID'));
            if (logado) await importarCookies(cookies);
            await cdp(ver.webSocketDebuggerUrl, 'Browser.close').catch(() => {});
            return logado;
          } catch (_) {}
        }
        return false;
      } finally {
        await esperarSair(h, 3000);
        try { process.kill(h.pid); } catch (_) {}
      }
    };
    let lendo = false;
    const inicio = Date.now();
    const timer = setInterval(async () => {
      if (lendo) return;
      if (Date.now() - inicio > 10 * 60_000) {
        try { process.kill(proc.pid); } catch (_) {}
        return acabar(false);
      }
      const saiu = proc.exitCode !== null;
      // chegou no vídeo = login feito: fecha a janela com calma (pra gravar os cookies)
      const t = saiu ? '' : await titulo();
      if (!saiu && !TITULO_FIM.test(t)) return;
      lendo = true;
      if (!saiu) {
        await new Promise((r) => setTimeout(r, 2500));
        execFile('taskkill', ['/PID', String(proc.pid)], { windowsHide: true }, () => {});
        await esperarSair(proc, 8000);
        try { process.kill(proc.pid); } catch (_) {}
      }
      acabar(await lerSessao().catch(() => false));
    }, 2000);
  });
}
let loginWin = null;
ipcMain.handle('bot:conta', () => botLogado());
ipcMain.handle('bot:login', () => {
  if (loginProc || (loginWin && !loginWin.isDestroyed())) {
    if (loginWin && !loginWin.isDestroyed()) loginWin.focus();
    return null;
  }
  botSession();
  const exe = acharNavegador();
  if (exe) return loginExterno(exe);
  // sem Chrome/Edge: tenta dentro do app
  return new Promise((resolve) => {
    loginWin = new BrowserWindow({
      parent: win || undefined,
      width: 480,
      height: 720,
      title: 'Entrar no YouTube',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { partition: 'persist:musicbot', contextIsolation: true, sandbox: true },
    });
    const w = loginWin;
    w.webContents.setUserAgent(UA_CHROME());
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) w.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    w.webContents.on('did-navigate', async (_e, url) => {
      if (/^https:\/\/(www|m)\.youtube\.com\//.test(url) && (await botLogado()) && !w.isDestroyed()) w.close();
    });
    w.on('closed', async () => {
      loginWin = null;
      botRecarregar = true;
      resolve(await botLogado());
    });
    w.loadURL(LOGIN_URL).catch(() => {});
  });
});
ipcMain.handle('bot:sair', async () => {
  await botSession().clearStorageData().catch(() => {});
  botRecarregar = true;
  return false;
});

function ensureBotWin() {
  if (botWin && !botWin.isDestroyed()) return botWin;
  botSession();
  botWin = new BrowserWindow({
    show: false,
    width: 640,
    height: 400,
    webPreferences: {
      partition: 'persist:musicbot',
      preload: path.join(__dirname, 'bot-preload.js'),
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  botWin.webContents.setUserAgent(UA_CHROME());
  const ses = botWin.webContents.session;
  // nega tudo pro YouTube; só deixa o próprio app (file://) capturar o áudio dessa janela
  ses.setPermissionRequestHandler((_wc, p, cb, d) => cb(p === 'display-capture' && String((d && d.securityOrigin) || '').startsWith('file://')));
  botWin.webContents.setAudioMuted(true); // não toca no PC duas vezes: o som sai pela captura
  botWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  botWin.on('closed', () => {
    botWin = null;
    send('bot-state', { gone: true });
  });
  return botWin;
}

async function botLoad(id) {
  const w = ensureBotWin();
  const url = 'https://www.youtube.com/watch?v=' + id;
  w.webContents.send('botwin:ctl', { type: 'reset' });
  const cur = w.webContents.getURL();
  const recarregar = botRecarregar;
  botRecarregar = false;
  if (!recarregar && /youtube\.com\/watch/.test(cur)) {
    const ok = await w.webContents
      .executeJavaScript(`(()=>{const p=document.querySelector('#movie_player'); if(!p||!p.loadVideoById) return false; p.loadVideoById(${JSON.stringify(id)}); return true})()`)
      .catch(() => false);
    if (ok) return lowQuality(w);
  }
  await w.loadURL(url).catch(() => {});
  lowQuality(w);
}

// o vídeo nem aparece: pede a menor qualidade pra gastar pouca internet/PC
function lowQuality(w) {
  let n = 0;
  const tick = () => {
    if (!w || w.isDestroyed() || n++ > 10) return;
    w.webContents
      .executeJavaScript(`(()=>{const p=document.querySelector('#movie_player'); if(p&&p.setPlaybackQualityRange){p.setPlaybackQualityRange('tiny','tiny'); return true} return false})()`)
      .then((ok) => !ok && setTimeout(tick, 1000))
      .catch(() => setTimeout(tick, 1000));
  };
  setTimeout(tick, 1500);
}

ipcMain.handle('bot:open', () => {
  const w = ensureBotWin();
  if (!w.webContents.getURL()) w.loadURL('about:blank').catch(() => {});
  return w.webContents.getMediaSourceId(win.webContents);
});
ipcMain.handle('bot:play', (_e, id) => (/^[\w-]{11}$/.test(id) ? botLoad(id) : null));
ipcMain.handle('bot:ctl', (_e, c) => {
  if (botWin && !botWin.isDestroyed()) botWin.webContents.send('botwin:ctl', c);
});
ipcMain.handle('bot:close', () => {
  if (botWin && !botWin.isDestroyed()) botWin.destroy();
  botWin = null;
});
ipcMain.handle('bot:search', (_e, q, n) => yts().search(String(q).slice(0, 200), n));
ipcMain.handle('bot:related', (_e, id) => yts().related(id));
ipcMain.on('botwin:state', (e, s) => {
  if (botWin && e.sender === botWin.webContents) send('bot-state', s);
});

// --- Vozes com IA (modelos rodando aqui mesmo, pela placa de vídeo)
let vozesMod = null;
const voz = () => {
  if (!vozesMod) {
    vozesMod = require('./dist/vozes.cjs');
    vozesMod.setBase(path.join(app.getPath('userData'), 'vozes'));
  }
  return vozesMod;
};
const vozProg = (tipo, id) => (p) => win && !win.isDestroyed() && win.webContents.send('vozes-prog', { tipo, id, p });
ipcMain.handle('vozes:estado', () => ({ motor: voz().motorInstalado(), tamanhoMotor: voz().MOTOR_TAMANHO, baixadas: voz().vozesBaixadas() }));
ipcMain.handle('vozes:catalogo', (_e, forcar) => voz().lerCatalogo(!!forcar));
ipcMain.handle('vozes:instalarMotor', () => voz().instalarMotor(vozProg('motor')));
ipcMain.handle('vozes:baixar', (_e, id) => voz().baixarVoz(String(id), vozProg('voz', String(id))));
ipcMain.handle('vozes:apagar', (_e, id) => voz().apagarVoz(String(id)));
ipcMain.handle('vozes:iniciar', (_e, id, opts) => voz().iniciar(String(id), { userF0: Number(opts && opts.userF0) || 0 }));
ipcMain.handle('vozes:processar', (_e, buf) => voz().processar(buf));
ipcMain.handle('vozes:info', () => (vozesMod ? vozesMod.info() : null));
ipcMain.handle('vozes:parar', () => (vozesMod ? vozesMod.parar() : null));

// ---------------- O que estou jogando ----------------
// A cada 15 s lê a lista de programas abertos (tasklist) e reconhece jogos pelo nome do .exe.
// Só o NOME do jogo sai do PC; navegador aparece como "No navegador", nunca o site/título.
const JOGOS = {
  'valorant-win64-shipping.exe': 'Valorant', 'cs2.exe': 'Counter-Strike 2', 'league of legends.exe': 'League of Legends',
  'fortniteclient-win64-shipping.exe': 'Fortnite', 'gta5.exe': 'GTA V', 'gta5_enhanced.exe': 'GTA V', 'playgtav.exe': 'GTA V',
  'robloxplayerbeta.exe': 'Roblox', 'rocketleague.exe': 'Rocket League', 'r5apex.exe': 'Apex Legends', 'r5apex_dx12.exe': 'Apex Legends',
  'overwatch.exe': 'Overwatch 2', 'dota2.exe': 'Dota 2', 'eldenring.exe': 'Elden Ring', 'fc25.exe': 'EA Sports FC 25', 'fc26.exe': 'EA Sports FC 26',
  'cod.exe': 'Call of Duty', 'tslgame.exe': 'PUBG', 'rainbowsix.exe': 'Rainbow Six Siege', 'rainbowsix_be.exe': 'Rainbow Six Siege',
  'deadbydaylight-win64-shipping.exe': 'Dead by Daylight', 'among us.exe': 'Among Us', 'marvel-win64-shipping.exe': 'Marvel Rivals',
  'rdr2.exe': 'Red Dead Redemption 2', 'cyberpunk2077.exe': 'Cyberpunk 2077', 'stardew valley.exe': 'Stardew Valley', 'terraria.exe': 'Terraria',
  'rustclient.exe': 'Rust', 'warframe.x64.exe': 'Warframe', 'destiny2.exe': 'Destiny 2', 'palworld-win64-shipping.exe': 'Palworld',
  'helldivers2.exe': 'Helldivers 2', 'thefinals.exe': 'The Finals', 'brawlhalla.exe': 'Brawlhalla', 'forzahorizon5.exe': 'Forza Horizon 5',
  'wow.exe': 'World of Warcraft', 'hearthstone.exe': 'Hearthstone', 'osu!.exe': 'osu!', 'geometrydash.exe': 'Geometry Dash',
  'repo.exe': 'R.E.P.O.', 'lethal company.exe': 'Lethal Company', 'phasmophobia.exe': 'Phasmophobia', 'escapefromtarkov.exe': 'Escape from Tarkov',
  'minecraft.windows.exe': 'Minecraft', 'minecraftlauncher.exe': 'Minecraft', 'eafc24.exe': 'EA Sports FC 24', 'sotgame.exe': 'Sea of Thieves',
  'witcher3.exe': 'The Witcher 3', 'hogwartslegacy.exe': 'Hogwarts Legacy', 'nba2k25.exe': 'NBA 2K25', 'nba2k26.exe': 'NBA 2K26',
};
const JANELA_OCULTA = /^(N\/A|N\/D|OleMainThreadWndName|MSCTFIME UI|Default IME|GDI\+ Window.*|\.NET-Broadcast.*)$/;
const NAVEGADORES = new Set(['chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'brave.exe', 'vivaldi.exe']);
const { execFile } = require('child_process');
const listar = (args) =>
  new Promise((res) => execFile('tasklist', args, { windowsHide: true, timeout: 10000, maxBuffer: 8 << 20 }, (e, out) => res(e ? '' : String(out))));
const csv = (line) => (line.match(/"([^"]*)"/g) || []).map((x) => x.slice(1, -1));
let atividade = null; // { nome, tipo: 'jogo'|'navegador', desde }
let atividadeTimer = null;
async function detectarAtividade() {
  const out = await listar(['/fo', 'csv', '/nh']);
  if (!out) return;
  const exes = new Set(out.split(/\r?\n/).map((l) => (csv(l)[0] || '').toLowerCase()).filter(Boolean));
  let achou = null;
  for (const exe of exes) if (JOGOS[exe]) { achou = { nome: JOGOS[exe], tipo: 'jogo' }; break; }
  if (!achou) {
    // navegador só conta se tiver uma janela aberta (o título é lido aqui e descartado)
    for (const exe of exes) {
      if (!NAVEGADORES.has(exe)) continue;
      const v = await listar(['/v', '/fo', 'csv', '/nh', '/fi', `IMAGENAME eq ${exe}`]);
      if (v.split(/\r?\n/).some((l) => { const t = csv(l).pop(); return t && !JANELA_OCULTA.test(t); })) { achou = { nome: 'No navegador', tipo: 'navegador' }; break; }
    }
  }
  const antes = atividade;
  if (!achou) atividade = null;
  else if (!antes || antes.nome !== achou.nome) atividade = { ...achou, desde: Date.now() };
  if ((antes && antes.nome) !== (atividade && atividade.nome)) send('atividade', atividade);
}
ipcMain.handle('atividade:ligar', (_e, on) => {
  clearInterval(atividadeTimer);
  atividadeTimer = null;
  if (on && process.platform === 'win32') {
    atividadeTimer = setInterval(() => detectarAtividade().catch(() => {}), 15000);
    detectarAtividade().catch(() => {});
  } else atividade = null;
  return atividade;
});
ipcMain.handle('atividade:get', () => atividade);

ipcMain.handle('app:open', (_e, url) => {
  if (/^https?:/.test(url)) shell.openExternal(url);
});
ipcMain.handle('update:install', () => {
  if (autoUpdater) setImmediate(() => autoUpdater.quitAndInstall(true, true));
});
ipcMain.handle('update:state', () => updateState);
ipcMain.handle('update:check', async () => {
  if (!autoUpdater || !app.isPackaged) return { state: 'dev', current: app.getVersion() };
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    setUpdate({ state: 'error', message: String(e.message || e) });
  }
  return updateState;
});

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function setupShortcuts() {
  // Atalhos globais (funcionam com o jogo em foco)
  globalShortcut.register('CommandOrControl+Shift+M', () => send('shortcut', 'mute'));
  globalShortcut.register('CommandOrControl+Shift+D', () => send('shortcut', 'deafen'));
}

// Atualização automática: procura ao abrir o app e a cada 30 min; baixa sozinho.
let updateState = { state: 'idle', current: app.getVersion() };
function setUpdate(patch) {
  updateState = { ...updateState, ...patch, current: app.getVersion() };
  send('update', updateState);
}
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) {
    updateState = { state: 'dev', current: app.getVersion() };
    return;
  }
  autoUpdater.autoDownload = true;
  // baixa o instalador inteiro (o modo "só a diferença" faz muitos pedacinhos e às vezes trava perto do fim)
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => setUpdate({ state: 'available', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'latest' }));
  autoUpdater.on('download-progress', (p) => setUpdate({ state: 'downloading', percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => setUpdate({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (e) => setUpdate({ state: 'error', message: String((e && e.message) || e) }));
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => {
    if (updateState.state !== 'downloading' && updateState.state !== 'ready') autoUpdater.checkForUpdates().catch(() => {});
  }, 1000 * 60 * 30);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function setupTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Especial Caçamba dos Cria');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir', click: showWindow },
      { type: 'separator' },
      { label: 'Mutar / desmutar microfone', click: () => send('shortcut', 'mute') },
      { label: 'Desativar / ativar áudio', click: () => send('shortcut', 'deafen') },
      { type: 'separator' },
      { label: 'Sair', click: () => { quitting = true; app.quit(); } },
    ])
  );
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// avisa (só na primeira vez) que o app continua aberto lá na bandeja
function trayHintOnce() {
  const flag = path.join(app.getPath('userData'), 'tray-hint');
  if (fs.existsSync(flag) || !tray || process.platform !== 'win32') return;
  try {
    fs.writeFileSync(flag, '1');
  } catch (_) {}
  tray.displayBalloon({
    title: 'Ainda tô aqui!',
    content: 'O Caçamba continua rodando perto do relógio. Pra fechar de vez: botão direito no ícone → Sair.',
    iconType: 'info',
  });
}

app.on('second-instance', showWindow);
app.on('before-quit', () => (quitting = true));

app.whenReady().then(() => {
  setupMedia();
  createWindow();
  setupTray();
  setupShortcuts();
  setupUpdater();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
