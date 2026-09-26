import { BrowserWindow, WebContentsView, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L } from '../src/shared/i18n';
const exec = promisify(execFile);

export function registerPreview(getWindow: () => BrowserWindow | null): void {
  let view: WebContentsView | undefined;
  const devices = async () => {
    const { stdout } = await exec('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
    return Object.values(JSON.parse(stdout).devices).flat() as { udid: string; name: string; state: string }[];
  };
  const validDevice = async (id: string) => {
    const device = (await devices()).find(d => d.udid === id);
    if (!device) throw new Error(L('Cihaz bulunamadı.', 'Device not found.'));
    return device;
  };
  ipcMain.handle('preview:browser', async (event, action: string, value?: any) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents) throw new Error(L('Geçersiz pencere', 'Invalid window'));
    if (!view) {
      view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:konsey-browser' } });
      view.setVisible(false);
      view.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', (e, url) => { if (!/^https?:\/\//.test(url)) e.preventDefault(); });
      win.contentView.addChildView(view);
      win.once('closed', () => { view?.webContents.close(); view = undefined; });
    }
    if (action === 'bounds') {
      const b = value;
      if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return;
      view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) });
      view.setVisible(b.width > 0 && b.height > 0);
    }
    if (action === 'go') {
      const url = new URL(value.includes('://') ? value : `http://${value}`);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(L('HTTP veya HTTPS adresi gir.', 'Enter an HTTP or HTTPS address.'));
      await view.webContents.loadURL(url.toString());
    }
    if (action === 'back' && view.webContents.canGoBack()) view.webContents.goBack();
    if (action === 'forward' && view.webContents.canGoForward()) view.webContents.goForward();
    if (action === 'reload') view.webContents.reload();
    return view.webContents.getURL();
  });
  ipcMain.handle('preview:simulator', async (event, action: string, id?: string) => {
    if (event.sender !== getWindow()?.webContents) throw new Error(L('Geçersiz pencere', 'Invalid window'));
    if (action === 'list') return devices();
    const device = await validDevice(id ?? '');
    if (action === 'boot') {
      if (device.state !== 'Booted') await exec('/usr/bin/xcrun', ['simctl', 'boot', device.udid]);
      await exec('/usr/bin/open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', device.udid]);
      return true;
    }
    if (action === 'screen') {
      if (device.state !== 'Booted') return null;
      const dir = await mkdtemp(join(tmpdir(), 'konsey-sim-'));
      try {
        const file = join(dir, 'screen.png');
        await exec('/usr/bin/xcrun', ['simctl', 'io', device.udid, 'screenshot', file]);
        return `data:image/png;base64,${(await readFile(file)).toString('base64')}`;
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });
}
