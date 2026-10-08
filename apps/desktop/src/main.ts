import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { ServerProcess, type ServerInfo } from './server.ts';
import { loadSettings, saveSettings, serverEnvironment, type Settings } from './settings.ts';

import { Updater } from './updater.ts';

// Electron's module is CommonJS without static exports, so it cannot be imported by name.
const { BrowserWindow, Menu, Tray, app, dialog, nativeImage, shell } = electron;

// The layout is the same in the source tree and in the installed application: this file is
// apps/desktop/dist/main.js, beside apps/server/dist, apps/web/dist and apps/server/vendor.
const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const SERVER_SCRIPT = here('../../server/dist/index.js');
const WEB_ROOT = here('../../web/dist');
const FT4222_DLL = here('../../server/vendor/LibFT4222-64.dll');
const STATIC = here('../static/');

// The same data folder (%APPDATA%\RadioBench) whether installed or run from the source tree.
app.setName('RadioBench');
const userData = app.getPath('userData');
const SETTINGS_FILE = join(userData, 'settings.json');
const LOG_FILE = join(userData, 'logs', 'server.log');
const DESKTOP_LOG_FILE = join(userData, 'logs', 'desktop.log');
const CERT_DIR = join(userData, 'certs');

/** The application's own log, beside the server's: updates, settings changes, and failures. */
function log(line: string): void {
  try {
    mkdirSync(join(userData, 'logs'), { recursive: true });
    appendFileSync(DESKTOP_LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Nowhere to write: so be it.
  }
}

process.on('uncaughtException', (error) => {
  log(`uncaught: ${error.stack ?? error.message}`);
  dialog.showErrorBox(
    'RadioBench',
    `Something went wrong:\n\n${error.message}\n\nSee ${DESKTOP_LOG_FILE}`,
  );
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  log(`unhandled: ${error}`);
});

// One RadioBench at a time: a second start just brings the window of the first one up, or,
// started as "RadioBench --quit", stops the first one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--quit')) app.quit();
    else showWindow();
  });
  void run();
}

let settings: Settings;
let server: ServerProcess;
let updater: Updater;
let tray: Electron.Tray | null = null;
let window: Electron.BrowserWindow | null = null;
let quitting = false;

async function run(): Promise<void> {
  await app.whenReady();
  log(`RadioBench ${app.getVersion()} starting; data in ${userData}`);
  settings = loadSettings(SETTINGS_FILE);
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ['--hidden'] });

  server = new ServerProcess({
    executable: process.execPath,
    script: SERVER_SCRIPT,
    args: [],
    env: environment(),
    logFile: LOG_FILE,
    onChange: reflect,
  });
  updater = new Updater(log);

  tray = new Tray(nativeImage.createFromPath(join(STATIC, 'tray.png')));
  tray.setToolTip(`RadioBench ${app.getVersion()}`);
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  rebuildMenu();

  server.start();
  updater.start();
  if (!process.argv.includes('--hidden')) showWindow();

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void server.stop().then(() => app.quit());
  });
  // Closing the last window keeps RadioBench in the tray, serving the LAN.
  app.on('window-all-closed', () => undefined);
}

/** The address the window opens the panel at. */
function localUrl(): string {
  return `http://127.0.0.1:${settings.httpPort}/`;
}

function showWindow(): void {
  if (window) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 700,
    minHeight: 500,
    title: 'RadioBench',
    icon: join(STATIC, 'icon.png'),
    backgroundColor: '#101114',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true },
  });
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  window.on('closed', () => (window = null));
  // Links out of the panel (none today) open in the browser, not in this window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  loadPage(server.getInfo());
}

/** Shows the panel once the server is up, and what is happening until then. */
function loadPage(info: ServerInfo): void {
  if (!window) return;
  if (info.status === 'running') {
    const current = window.webContents.getURL();
    if (!current.startsWith(localUrl())) void window.loadURL(localUrl());
    return;
  }
  const params = new URLSearchParams({ status: info.status, log: info.recent.join('\n') });
  void window.loadFile(join(STATIC, 'loading.html'), { search: params.toString() });
}

function reflect(info: ServerInfo): void {
  loadPage(info);
  rebuildMenu();
  tray?.setToolTip(
    info.status === 'running'
      ? `RadioBench ${app.getVersion()} · ${info.urls.http[0] ?? ''}`
      : `RadioBench ${app.getVersion()} · server ${info.status}`,
  );
}

function rebuildMenu(): void {
  const info = server.getInfo();
  const addresses: Electron.MenuItemConstructorOptions[] = [...info.urls.http, ...info.urls.https]
    .filter((url) => !url.includes('localhost'))
    .map((url) => ({ label: url, click: () => void shell.openExternal(url) }));
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Open RadioBench', click: () => showWindow() },
    {
      label: 'Open in browser',
      enabled: info.status === 'running',
      click: () => void shell.openExternal(localUrl()),
    },
    {
      label: 'Addresses on the LAN',
      enabled: addresses.length > 0,
      submenu: addresses.length > 0 ? addresses : [{ label: 'None yet', enabled: false }],
    },
    { type: 'separator' },
    {
      label: 'Allow transmitting',
      type: 'checkbox',
      checked: settings.allowTransmit,
      click: (item) => void setTransmit(item.checked),
    },
    {
      label: 'Simulated radio',
      type: 'checkbox',
      checked: settings.catPort === 'sim',
      click: (item) => void change({ catPort: item.checked ? 'sim' : 'auto' }),
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: settings.openAtLogin,
      click: (item) => {
        settings = { ...settings, openAtLogin: item.checked };
        saveSettings(SETTINGS_FILE, settings);
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
      },
    },
    { type: 'separator' },
    { label: 'Settings file…', click: () => void openSettingsFile() },
    { label: 'Restart server', click: () => void server.restart() },
    { label: 'Show log', click: () => void shell.openPath(LOG_FILE) },
    { label: 'Check for updates…', click: () => void updater.check(true) },
    { label: 'About RadioBench', click: () => void about() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ];
  tray?.setContextMenu(Menu.buildFromTemplate(template));
}

/** Applies changed settings: saved, and the server started again with them. */
async function change(changes: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...changes };
  saveSettings(SETTINGS_FILE, settings);
  log(`settings changed: ${JSON.stringify(changes)}; restarting the server`);
  await server.restart(environment());
}

function environment(): Record<string, string> {
  return serverEnvironment(settings, {
    webRoot: WEB_ROOT,
    certDir: CERT_DIR,
    ft4222Dll: FT4222_DLL,
  });
}

async function setTransmit(on: boolean): Promise<void> {
  if (on) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'RadioBench',
      message: 'Allow browsers to put the radio on the air?',
      detail:
        'With this on, anyone who can open RadioBench on your network can key the transmitter: MOX, VOX, antenna tuning, CW and voice memories, and microphone audio. The radio needs an antenna or a dummy load.',
      buttons: ['Allow', 'Keep off'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) {
      rebuildMenu();
      return;
    }
  }
  await change({ allowTransmit: on });
}

async function openSettingsFile(): Promise<void> {
  if (!existsSync(SETTINGS_FILE)) saveSettings(SETTINGS_FILE, settings);
  await shell.openPath(SETTINGS_FILE);
  await dialog.showMessageBox({
    type: 'info',
    title: 'RadioBench',
    message: 'Settings are read when the server starts.',
    detail: `After saving the file, choose "Restart server" in the tray menu.\n\n${SETTINGS_FILE}`,
  });
}

async function about(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'About RadioBench',
    message: `RadioBench ${app.getVersion()}`,
    detail:
      'PC and LAN front panel for the Yaesu FT-710.\n\n' +
      'Free software under the GNU General Public License v3. FT8/FT4 decoding by ft8ts, a port of WSJT-X. ' +
      'The spectrum scope is read through FTDI’s LibFT4222, distributed under FTDI’s driver licence terms.',
    buttons: ['Project page', 'Close'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) void shell.openExternal('https://github.com/thornthunder/RadioBench');
}
