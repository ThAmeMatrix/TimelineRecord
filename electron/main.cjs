'use strict';

/**
 * 桌面版（Electron）主进程。
 * - 正式运行：内置本地服务托管 dist/index.html（单文件构建），并自带跨域代理；
 * - 开发运行（electron . --dev）：直接连 vite 开发服务器 http://localhost:5173
 *   （或 TL_DEV_URL 指定的地址），享受热更新。
 * - 原生文件对话框：保存 / 打开 JSON 走系统对话框，记住位置后 Ctrl+S 直接覆盖。
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { startServer } = require('./server.cjs');

const DIST_FILE = path.join(__dirname, '..', 'dist', 'index.html');
const DEV = process.argv.includes('--dev');
const DEV_URL = process.env.TL_DEV_URL || 'http://localhost:5173';
const JSON_FILTERS = [{ name: '时间轴数据（JSON）', extensions: ['json'] }];

app.setName('TimelineRecord');

/** 记住的保存位置：首次保存后 Ctrl+S 直接覆盖同一个文件 */
let lastFile = null;
let mainWindow = null;
let appUrl = null;

async function writeText(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/* ------------------------------ 原生文件对话框 ------------------------------ */

ipcMain.handle('desktop:save', async (event, opts = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const saveAs = Boolean(opts.saveAs);
  let file = saveAs ? null : lastFile;
  if (!file) {
    const picked = await dialog.showSaveDialog(win, {
      title: '保存时间轴数据',
      defaultPath: opts.name || 'timeline.json',
      filters: JSON_FILTERS,
      properties: ['showOverwriteConfirmation'],
    });
    if (picked.canceled || !picked.filePath) return null;
    file = picked.filePath;
  }
  await writeText(file, String(opts.text ?? ''));
  lastFile = file;
  return { path: file, name: path.basename(file) };
});

ipcMain.handle('desktop:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const picked = await dialog.showOpenDialog(win, {
    title: '打开时间轴数据',
    filters: JSON_FILTERS,
    properties: ['openFile'],
  });
  if (picked.canceled || !picked.filePaths.length) return null;
  const file = picked.filePaths[0];
  const text = await fsp.readFile(file, 'utf8');
  lastFile = file;
  return { path: file, name: path.basename(file), text };
});

ipcMain.handle('desktop:fileName', async () => (lastFile ? path.basename(lastFile) : null));

ipcMain.handle('desktop:unbind', async () => {
  lastFile = null;
});

ipcMain.handle('desktop:info', async () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

/* ------------------------------ 窗口 ------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: '时间轴记录',
    backgroundColor: '#0c0e13',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // 应用里的外链交给系统浏览器，不要在 Electron 里开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  mainWindow.loadURL(appUrl);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const menuTemplate = [
  {
    label: '文件',
    submenu: [{ label: '退出', role: 'quit' }],
  },
  {
    label: '编辑',
    submenu: [
      { label: '撤销', role: 'undo' },
      { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' },
      { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' },
      { label: '全选', role: 'selectAll' },
    ],
  },
  {
    label: '视图',
    submenu: [
      { label: '重新加载', role: 'reload' },
      { label: '开发者工具', role: 'toggleDevTools' },
      { type: 'separator' },
      { label: '实际大小', role: 'resetZoom' },
      { label: '放大', role: 'zoomIn' },
      { label: '缩小', role: 'zoomOut' },
      { type: 'separator' },
      { label: '全屏', role: 'togglefullscreen' },
    ],
  },
  {
    label: '窗口',
    submenu: [
      { label: '最小化', role: 'minimize' },
      { label: '关闭', role: 'close' },
    ],
  },
];

async function boot() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  if (DEV) {
    appUrl = DEV_URL;
  } else {
    if (!fs.existsSync(DIST_FILE)) {
      dialog.showErrorBox('缺少构建产物', `没有找到 ${DIST_FILE}\n请先运行 npm run build（或 npm run desktop）`);
      app.quit();
      return;
    }
    const s = await startServer(DIST_FILE);
    appUrl = s.url;
  }
  createWindow();
}

/* ------------------------------ 生命周期 ------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox('启动失败', String(err && err.message ? err.message : err));
    app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && appUrl) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
