/**
 * Konsey — Electron ana sureci.
 *
 * Tum ajan calistirma isi burada, ana surecte olur; arayuz yalnizca IPC
 * uzerinden komut gonderir ve olay akisini dinler.
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { checkAvailability } from '../src/core/discovery';
import { Orchestrator } from '../src/core/orchestrator';
import { loadConfig, saveConfig, type KonseyConfig } from '../src/core/config';
import { setSecret, deleteSecret, hasSecret } from '../src/core/secrets';
import { listModels } from '../src/core/providers/client';
import { isGitRepo } from '../src/core/git';
import type { KonseyEvent, ProviderConfig } from '../src/shared/types';
import { registerPreview } from './preview';

let mainWindow: BrowserWindow | null = null;
registerPreview(() => mainWindow);

/** Ayni anda tek bir calisma; iptal edebilmek icin kontrolcusu saklanir. */
let activeRun: { orchestrator: Orchestrator; controller: AbortController } | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#14161a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // KONSEY_DEBUG=1 ile arayuz konsolu terminale aktarilir; hata ayiklama icin.
  if (process.env.KONSEY_DEBUG) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['LOG', 'WARN', 'ERROR', 'DEBUG'][level] ?? 'LOG';
      console.log(`[renderer:${tag}] ${message} (${sourceId}:${line})`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log(`[renderer:FAIL] ${code} ${desc}`);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[renderer] yuklendi');
    });
  }
  mainWindow.loadFile(path.join(__dirname, '../ui/index.html'));

  // Dis baglantilar uygulama penceresinde degil, varsayilan tarayicida acilir.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(event: KonseyEvent): void {
  mainWindow?.webContents.send('konsey:event', event);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  activeRun?.controller.abort();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- IPC

ipcMain.handle('konsey:availability', async (_e, preferWorkspace?: string) => {
  const config = await loadConfig();
  const builtins = await checkAvailability(preferWorkspace);

  // Saglayicilar icin "kullanilabilir" olcutu: Keychain'de anahtarinin olmasi.
  const providers = await Promise.all(
    config.providers.map(async (p) => ({
      agent: `provider:${p.slug}`,
      available: p.enabled && (await hasSecret(p.slug)),
      detail: !(await hasSecret(p.slug))
        ? 'API anahtari Keychain’de yok.'
        : !p.enabled
          ? 'Kapali.'
          : `${p.baseUrl} · ${p.model}`,
      target: p.baseUrl,
    })),
  );

  return [...builtins, ...providers];
});

ipcMain.handle('konsey:config:load', async (): Promise<KonseyConfig> => loadConfig());

ipcMain.handle('konsey:config:save', async (_e, config: KonseyConfig) => {
  await saveConfig(config);
  return true;
});

ipcMain.handle(
  'konsey:provider:setKey',
  async (_e, slug: string, apiKey: string) => {
    if (apiKey) await setSecret(slug, apiKey);
    else await deleteSecret(slug);
    return true;
  },
);

ipcMain.handle('konsey:provider:hasKey', async (_e, slug: string) => hasSecret(slug));

ipcMain.handle(
  'konsey:provider:test',
  async (_e, provider: ProviderConfig, apiKey?: string) => {
    const key = apiKey || (await import('../src/core/secrets')).getSecret(provider.slug);
    const resolved = typeof key === 'string' ? key : await key;
    if (!resolved) return { ok: false, models: [], error: 'API anahtari yok.' };
    return listModels(provider.baseUrl, resolved);
  },
);

ipcMain.handle('konsey:pickProject', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Proje klasorunu sec',
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const dir = res.filePaths[0];
  return { dir, isGit: await isGitRepo(dir) };
});

type ImageAttachment = { path: string; name: string; dataUrl: string };
const IMAGE_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

async function loadImages(paths: string[]): Promise<ImageAttachment[]> {
  const unique = [...new Set(paths)].slice(0, 8);
  const result: ImageAttachment[] = [];
  for (const imagePath of unique) {
    const extension = path.extname(imagePath).toLowerCase();
    const mime = IMAGE_MIMES[extension];
    if (!mime) continue;
    const info = await stat(imagePath);
    if (!info.isFile() || info.size > 20 * 1024 * 1024) continue;
    const bytes = await readFile(imagePath);
    result.push({
      path: imagePath,
      name: path.basename(imagePath),
      dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
    });
  }
  return result;
}

ipcMain.handle('konsey:images:pick', async () => {
  const opts: Electron.OpenDialogOptions = {
    title: 'Konsey sohbetine görsel ekle',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Görseller', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  };
  const res = await (mainWindow
    ? dialog.showOpenDialog(mainWindow, opts)
    : dialog.showOpenDialog(opts));
  return res.canceled ? [] : loadImages(res.filePaths);
});

ipcMain.handle('konsey:images:fromPaths', async (_e, paths: string[]) =>
  loadImages(Array.isArray(paths) ? paths : []),
);

ipcMain.handle(
  'konsey:images:save',
  async (_e, input: { name?: string; mime: string; bytes: ArrayBuffer }) => {
    const mimeEntry = Object.entries(IMAGE_MIMES).find(([, mime]) => mime === input.mime);
    const bytes = Buffer.from(input.bytes);
    if (!mimeEntry || bytes.byteLength > 20 * 1024 * 1024) throw new Error('Desteklenmeyen veya çok büyük görsel.');
    const dir = path.join(app.getPath('temp'), 'konsey-attachments');
    await mkdir(dir, { recursive: true });
    const imagePath = path.join(dir, `${randomUUID()}${mimeEntry[0]}`);
    await writeFile(imagePath, bytes);
    const [saved] = await loadImages([imagePath]);
    return { ...saved, name: input.name || saved.name };
  },
);

ipcMain.handle('konsey:openPath', async (_e, target: string) => {
  await shell.openPath(target);
});

ipcMain.handle(
  'konsey:run:start',
  async (_e, args: { projectDir: string; prompt: string }) => {
    if (activeRun) return { ok: false, error: 'Zaten calisan bir gorev var.' };

    const config = await loadConfig();
    const orchestrator = new Orchestrator();
    const controller = new AbortController();
    activeRun = { orchestrator, controller };

    const unsubscribe = orchestrator.bus.on((event) => send(event));

    try {
      const record = await orchestrator.start({
        projectDir: args.projectDir,
        prompt: args.prompt,
        profiles: config.profiles,
        providers: config.providers,
        coordinator: config.coordinator ?? undefined,
        reviewer: config.reviewer ?? undefined,
        signal: controller.signal,
      });

      // Son kullanilan projeler listesini guncelle.
      const recent = [args.projectDir, ...config.recentProjects.filter((p) => p !== args.projectDir)];
      await saveConfig({ ...config, recentProjects: recent.slice(0, 10) });

      return { ok: true, record };
    } finally {
      unsubscribe();
      activeRun = null;
    }
  },
);

ipcMain.handle('konsey:run:cancel', async () => {
  activeRun?.controller.abort();
  return true;
});
