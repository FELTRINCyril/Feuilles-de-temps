import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, dialog, shell, powerMonitor } from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_DEV = process.argv.includes('--dev');
const PORT = 3001;

const POPUP_WIDTH = 340;
const POPUP_HEIGHT = 420;

let mainWindow = null;
let popupWindow = null;
let tray = null;

function frontendUrl(hash = '') {
  if (IS_DEV) return `http://localhost:5173/${hash}`;
  return `http://localhost:${PORT}/${hash}`;
}

// ── Update notifier (notify-only, unsigned build) ───────────────────────────
// The app is distributed as an unsigned .dmg, so there is no in-app auto-update
// (electron-updater needs a signed build to install). Instead, on launch and
// once a day we query the repo's latest GitHub release; if it is newer than the
// running version we tell the renderer to show a dismissable "vX available —
// Download" banner that opens the release page. Reading public releases needs
// no signing and no token.
const UPDATE_REPO = 'kreaddis-julien/Feuilles-de-temps';

function isNewerVersion(remote, current) {
  const a = String(remote).split('.').map(n => parseInt(n, 10) || 0);
  const b = String(current).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: `/repos/${UPDATE_REPO}/releases/latest`,
      headers: { 'User-Agent': 'feuilles-de-temps-app', 'Accept': 'application/vnd.github+json' },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// Query the latest release and compare it to the running version. Returns a
// structured result used both by the automatic notifier and the manual
// "check for updates" button in Settings.
async function getUpdateStatus() {
  const rel = await fetchLatestRelease();
  const tag = rel && rel.tag_name;
  if (!tag) throw new Error('no tag in latest release');
  const remote = String(tag).replace(/^v/, '');
  return {
    available: isNewerVersion(remote, app.getVersion()),
    version: remote,
    current: app.getVersion(),
    url: rel.html_url,
  };
}

// Push the "update available" banner to the renderer if a newer release exists.
function notifyIfAvailable(status) {
  if (status.available && mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[update-check] newer release available: v${status.version}`);
    mainWindow.webContents.send('updater-event', 'update-available', {
      version: status.version,
      url: status.url,
    });
  }
}

async function checkForUpdateNotification() {
  try {
    notifyIfAvailable(await getUpdateStatus());
  } catch (e) {
    console.warn('[update-check] ' + (e && e.message ? e.message : String(e)));
  }
}

// ── Embedded server (replaces the Tauri sidecar binary) ────────────────────

async function startServer() {
  const { createApp } = await import('./server-bundle.mjs');

  // Same directory the old Tauri app used (appId com.timesheet.tracker),
  // so existing timesheet data is picked up as-is.
  const dataDir = IS_DEV
    ? path.join(__dirname, '../data')
    : path.join(app.getPath('appData'), 'com.timesheet.tracker');
  fs.mkdirSync(dataDir, { recursive: true });

  const staticDir = IS_DEV ? undefined : path.join(__dirname, '../client/dist');
  const server = createApp(dataDir, { staticDir });

  await new Promise((resolve, reject) => {
    server.listen(PORT, '127.0.0.1', resolve).on('error', reject);
  });
  console.log(`Server running on http://127.0.0.1:${PORT} (data: ${dataDir})`);
}

// ── Timer maintenance (sleep, lock, midnight, crash recovery) ───────────────
// A running timer must never count time that was not worked. The server owns the
// rules (see server/src/routes/system.ts); the main process just tells it what
// macOS is doing.

const HEARTBEAT_MS = 30 * 1000;

let heartbeatTimer = null;
let midnightTimer = null;

function callApi(apiPath, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: apiPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(payload);
  });
}

// Tell every window to reload its data after we changed timers behind its back.
function broadcastSync() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('system-sync');
  }
}

async function maintenance(apiPath, body, describe) {
  try {
    const result = await callApi(apiPath, body);
    if (describe) console.log(`[timers] ${describe(result)}`);
    broadcastSync();
    return result;
  } catch (e) {
    console.warn(`[timers] ${apiPath} failed: ${e && e.message ? e.message : String(e)}`);
    return null;
  }
}

const pauseTimers = (reason) =>
  maintenance('/api/system/suspend', { reason }, (r) => `${reason}: ${r.paused} timer(s) paused`);

const resumeTimers = () =>
  maintenance('/api/system/resume', {}, (r) => `resume: ${r.resumed} resumed, ${r.stillPaused} left paused`);

const rolloverTimers = () =>
  maintenance('/api/system/rollover', {}, (r) => `midnight: ${r.splits.length} day(s) split`);

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  // Records "the app was alive at T" so a crash can be recovered without
  // counting the downtime as worked time.
  heartbeatTimer = setInterval(() => {
    callApi('/api/system/heartbeat').catch(() => {});
  }, HEARTBEAT_MS);
  callApi('/api/system/heartbeat').catch(() => {});
}

// Fire a few seconds after the next midnight, then every night.
function scheduleMidnight() {
  clearTimeout(midnightTimer);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 10, 0);
  midnightTimer = setTimeout(async () => {
    await rolloverTimers();
    scheduleMidnight();
  }, Math.max(1000, next.getTime() - now.getTime()));
}

function watchPowerEvents() {
  powerMonitor.on('suspend', () => pauseTimers('suspend'));
  powerMonitor.on('lock-screen', () => pauseTimers('lock'));
  powerMonitor.on('resume', async () => {
    await resumeTimers();
    // Waking up may also mean a day boundary was crossed while asleep, and the
    // midnight timeout never fired.
    await rolloverTimers();
    scheduleMidnight();
  });
  powerMonitor.on('unlock-screen', () => resumeTimers());
}

// ── Windows ─────────────────────────────────────────────────────────────────

// Renderer windows may only display the local frontend
function hardenWebContents(win) {
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost:')) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: 'Gestionnaire de feuilles de temps',
    width: 1024,
    height: 768,
    maxWidth: 1024,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  });
  hardenWebContents(mainWindow);
  mainWindow.loadURL(frontendUrl());
  // Tray app: closing the window hides it instead of quitting
  mainWindow.on('close', (e) => {
    if (!app.isQuittingForReal) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createPopupWindow() {
  popupWindow = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    fullscreenable: false,
    // NSPanel non-activant (comme l'ancien tauri_nspanel) : la popup
    // s'affiche au-dessus des apps plein ecran sans activer Tempo,
    // donc sans changer de space (meme mecanisme que la popup batterie).
    type: 'panel',
    hiddenInMissionControl: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      // This hidden window drives the clock shown in the menu bar. Chromium would
      // otherwise throttle its 1 s tick down to once a minute once it is hidden.
      backgroundThrottling: false,
    },
  });
  // Visible on all spaces, above the menu bar, without stealing focus disruptively
  popupWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popupWindow.setAlwaysOnTop(true, 'pop-up-menu');
  hardenWebContents(popupWindow);
  popupWindow.loadURL(frontendUrl('#/tray-popup'));
  // Hide when it loses focus (replaces the NSPanel delegate)
  popupWindow.on('blur', () => popupWindow.hide());
  popupWindow.on('hide', () => {
    stopPopupFocusWatch();
    destroyClickCatcher();
  });
  popupWindow.on('close', (e) => {
    if (!app.isQuittingForReal) {
      e.preventDefault();
      popupWindow.hide();
    }
  });
}

// On macOS the 'blur' event is unreliable for non-activating panels
// (clicks on the desktop or the menu bar never fire it). Poll the focus
// state while the popup is visible: once it has been key and loses it,
// hide it - same behaviour as the Notification Center popover.
let popupFocusPoll = null;

function startPopupFocusWatch() {
  stopPopupFocusWatch();
  let everFocused = false;
  popupFocusPoll = setInterval(() => {
    if (!popupWindow || popupWindow.isDestroyed() || !popupWindow.isVisible()) {
      stopPopupFocusWatch();
      return;
    }
    if (popupWindow.isFocused()) {
      everFocused = true;
      return;
    }
    if (everFocused) {
      popupWindow.hide();
      stopPopupFocusWatch();
    }
  }, 250);
}

function stopPopupFocusWatch() {
  if (popupFocusPoll) {
    clearInterval(popupFocusPoll);
    popupFocusPoll = null;
  }
}

// Clicking the desktop gives key focus to no window at all, so neither
// 'blur' nor the focus watch can see it. While the popup is open, an
// invisible full-screen "click catcher" sits just below it: any click
// outside the popup lands on it and closes the popup (same UX as the
// Notification Center popover).
let catcherWindow = null;

function showClickCatcher() {
  destroyClickCatcher();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  catcherWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    type: 'panel',
    hiddenInMissionControl: true,
  });
  catcherWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  catcherWindow.setAlwaysOnTop(true, 'pop-up-menu');
  // Background alpha 0.01: visually invisible but still receives clicks
  // (macOS lets clicks pass through fully transparent pixels)
  catcherWindow.loadURL(
    'data:text/html,<body style="margin:0;width:100vw;height:100vh;background:rgba(0,0,0,0.01)" onmousedown="window.close()"></body>'
  );
  catcherWindow.on('closed', () => {
    catcherWindow = null;
    if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
  });
  catcherWindow.showInactive();
  // Creating a panel window can flip the app to accessory mode; keep the dock icon
  if (app.dock && !app.dock.isVisible()) app.dock.show();
}

function destroyClickCatcher() {
  if (catcherWindow && !catcherWindow.isDestroyed()) {
    catcherWindow.removeAllListeners('closed');
    catcherWindow.close();
  }
  catcherWindow = null;
}

function togglePopup(trayBounds) {
  if (!popupWindow) return;
  if (popupWindow.isVisible()) {
    popupWindow.hide();
    return;
  }
  if (trayBounds && trayBounds.width > 0) {
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - POPUP_WIDTH / 2);
    const y = Math.round(trayBounds.y + trayBounds.height + 4);
    // Keep the popup inside the screen
    const maxX = display.workArea.x + display.workArea.width - POPUP_WIDTH - 8;
    x = Math.min(Math.max(x, display.workArea.x + 8), maxX);
    popupWindow.setPosition(x, y, false);
  }
  showClickCatcher();
  popupWindow.show();
  popupWindow.focus();
  startPopupFocusWatch();
}

// ── Tray ─────────────────────────────────────────────────────────────────────

async function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Ouvrir',
      click: () => {
        if (!mainWindow) createMainWindow();
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: 'Quitter',
      click: () => {
        app.isQuittingForReal = true;
        app.quit();
      },
    },
  ]);
}

async function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icons/tray-icon@2x.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  // No setContextMenu here: on macOS it would open the menu on every click.
  // Left click toggles the popup; right click opens the menu explicitly.
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', (_event, bounds) => togglePopup(bounds));
  tray.on('right-click', async () => {
    tray.popUpContextMenu(await buildTrayMenu());
  });
}

// ── IPC (replaces Tauri commands) ───────────────────────────────────────────

ipcMain.on('set-tray-title', (_event, title) => {
  if (tray) tray.setTitle(title ? ` ${title}` : '');
});

ipcMain.on('close-tray-popup', () => {
  if (popupWindow) popupWindow.hide();
});

ipcMain.on('open-main-window', () => {
  if (popupWindow) popupWindow.hide();
  if (!mainWindow) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
});

// Current app version, for display in Settings.
ipcMain.handle('get-app-version', () => app.getVersion());

// Manual "check for updates" from Settings. Returns the status so the UI can
// show explicit feedback (up to date / new version / error); also fires the
// banner if a newer release exists.
ipcMain.handle('updater-check', async () => {
  try {
    const status = await getUpdateStatus();
    notifyIfAvailable(status);
    return { ok: true, ...status };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // 404 = the repo has no published release yet. That's not an error, there
    // is simply nothing to update to.
    if (msg === 'HTTP 404') {
      return { ok: true, available: false, noRelease: true, current: app.getVersion() };
    }
    return { ok: false, error: msg, current: app.getVersion() };
  }
});

// Open the release page in the default browser. Restricted to GitHub https URLs
// so a compromised renderer can't turn this into an arbitrary-URL opener.
ipcMain.on('open-external', (_event, url) => {
  if (typeof url === 'string' && /^https:\/\/github\.com\//.test(url)) {
    shell.openExternal(url);
  }
});

// ── App lifecycle ────────────────────────────────────────────────────────────

app.isQuittingForReal = false;

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    console.error('Server failed to start:', err);
    dialog.showErrorBox('Gestionnaire de feuilles de temps', `Le serveur local n'a pas pu demarrer (port ${PORT} occupe ?)\n\n${err.message}`);
    app.exit(1);
    return;
  }

  // Before anything is displayed: close segments left open by a crash or a
  // forced quit (at the last heartbeat, not at now), then split any timer that
  // crossed midnight while the app was down.
  await maintenance('/api/system/recover', {}, (r) => `recover: ${r.recovered} orphan segment(s) closed`);
  await rolloverTimers();
  startHeartbeat();
  scheduleMidnight();
  watchPowerEvents();

  createMainWindow();
  createPopupWindow();
  await createTray();

  // Creating 'panel' windows flips the activation policy to accessory
  // (no dock icon). Re-assert the dock icon after they exist.
  if (app.dock) await app.dock.show();

  // Autostart at login (replaces tauri-plugin-autostart)
  if (!IS_DEV) {
    app.setLoginItemSettings({ openAtLogin: true });
    // Update notifier: check shortly after launch, then once a day. Dev builds
    // don't nag (they'd always look "behind" the latest release).
    setTimeout(checkForUpdateNotification, 10000);
    setInterval(checkForUpdateNotification, 24 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (!mainWindow) createMainWindow();
    mainWindow.show();
  });
});

// Tray app: keep running when all windows are closed
app.on('window-all-closed', () => {});

// Quitting stops the clock: a timer must not keep counting while the app is
// closed. The quit is deferred until the pause has actually been written.
let quitCleanupDone = false;

app.on('before-quit', (event) => {
  app.isQuittingForReal = true;
  if (quitCleanupDone) return;
  event.preventDefault();
  clearInterval(heartbeatTimer);
  clearTimeout(midnightTimer);
  pauseTimers('quit').finally(() => {
    quitCleanupDone = true;
    app.quit();
  });
});
