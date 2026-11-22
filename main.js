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

function ensureBotWin() {
  if (botWin && !botWin.isDestroyed()) return botWin;
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
  if (/youtube\.com\/watch/.test(cur)) {
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
