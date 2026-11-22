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
} = require('electron');
const path = require('path');

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

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  setupMedia();
  createWindow();
  setupShortcuts();
  setupUpdater();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
