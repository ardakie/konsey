/**
 * Konsey — Electron ana sureci.
 *
 * Tum ajan calistirma isi burada, ana surecte olur; arayuz yalnizca IPC
 * uzerinden komut gonderir ve olay akisini dinler.
 */
import { LANG } from './bootstrap';
import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } from 'electron';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { checkAvailability } from '../src/core/discovery';
import { Orchestrator } from '../src/core/orchestrator';
import { loadConfig, saveConfig, type KonseyConfig } from '../src/core/config';
import { setSecret, deleteSecret, hasSecret, getSecret } from '../src/core/secrets';
import { listModels } from '../src/core/providers/client';
import { applyIntegration, headCommit, isGitRepo, prepareRepo } from '../src/core/git';
import { computeQuotas, recordLimits, usageTotals } from '../src/core/usage';
import { clearThread, loadChats, postUserMessage, putMessage, sendChat } from '../src/core/chat';
import { advanceDebate, convertDebate, createDebate, deleteDebate, getDebate, listDebates, postToDebate, renameDebate } from '../src/core/debates';
import { deleteRun, listRuns, loadRun, saveRun, type ActivityLine } from '../src/core/runs';
import { runAgent } from '../src/core/adapters';
import { CLI_PRESETS, detectInstalledClis, presetFor, profileForPreset } from '../src/core/clis';
import { IS_MAC, IS_WIN, openInTerminal, which } from '../src/core/env';
import { L } from '../src/shared/i18n';
import type { AgentId, KonseyEvent, ProviderConfig, RunMode } from '../src/shared/types';
import { registerPreview } from './preview';
import { registerUpdates } from './updates';
import { grantTerminal, installGit, installNode, remember, runChecks, SETTINGS_URL } from '../src/core/setup';
import { INTEGRATIONS, integrationDef, resolveIntegrations, secretAccount } from '../src/core/integrations';
import { runSmoke, SMOKE } from './smoke';

let mainWindow: BrowserWindow | null = null;
registerPreview(() => mainWindow);
registerUpdates();

/** Ayni anda tek bir calisma; iptal edebilmek icin kontrolcusu saklanir. */
let activeRun: { orchestrator: Orchestrator; controller: AbortController } | null = null;
/** Sohbet turlari: konu basina bir kontrolcu. */
const activeChats = new Map<string, AbortController>();
/** Tartisma turlari: tartisma basina bir kontrolcu. */
const activeDebates = new Map<string, AbortController>();

function overlayColors(dark: boolean) {
  return { color: dark ? '#1B1C20' : '#F6F6F4', symbolColor: dark ? '#E8E8EA' : '#1C1D21', height: 44 };
}

// Windows'ta sistem dugmelerinin rengi temayla birlikte degisir.
nativeTheme.on('updated', () => {
  if (!IS_MAC && mainWindow) mainWindow.setTitleBarOverlay(overlayColors(nativeTheme.shouldUseDarkColors));
});

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    ...(IS_MAC
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 18, y: 18 },
          // Kenar cubugu macOS'un gercek buzlu cam malzemesini gosterir (Codex gibi).
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
      : {
          // Windows/Linux: cercevesiz pencere, sistem dugmeleri sag ustte.
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: overlayColors(dark),
          backgroundColor: dark ? '#17181C' : '#F4F4F2',
        }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Duman testinde pencere arkada kalsa da arayuz cizilmeye devam etsin.
      backgroundThrottling: !SMOKE,
      additionalArguments: [`--konsey-lang=${LANG}`, `--konsey-platform=${process.platform}`],
    },
  });
  if (!IS_MAC) mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (SMOKE) runSmoke(mainWindow);

  // KONSEY_DEBUG=1 ile arayuz konsolu terminale aktarilir; hata ayiklama icin.
  if (process.env.KONSEY_DEBUG) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['LOG', 'WARN', 'ERROR', 'DEBUG'][level] ?? 'LOG';
      console.log(`[renderer:${tag}] ${message} (${sourceId}:${line})`);
    });
  }
  mainWindow.loadFile(path.join(__dirname, '../ui/index.html'));

  // Dis baglantilar uygulama penceresinde degil, varsayilan tarayicida acilir.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
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
  for (const controller of activeChats.values()) controller.abort();
  for (const controller of activeDebates.values()) controller.abort();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- yardimci

/** Saglayicinin anahtari Keychain'de ya da ortam degiskeninde var mi. */
async function providerReady(provider: ProviderConfig): Promise<boolean> {
  return (await hasSecret(provider.slug)) || Boolean(process.env[`${provider.slug.toUpperCase()}_API_KEY`]);
}

/** Calismaya/sohbete girecek profiller: kullanicinin actiklari ve makinede bulunanlar. */
/** Kesif (ozellikle Antigravity port taramasi) birkac saniye surer; kisa sure onbellekte tutulur. */
let availabilityCache: { key: string; at: number; value: Awaited<ReturnType<typeof checkAvailability>> } | null = null;
async function cachedAvailability(projectDir?: string | null, fresh = false) {
  const config = await loadConfig();
  const key = `${projectDir ?? ''}|${config.profiles.map((p) => p.agent).join(',')}`;
  if (!fresh && availabilityCache && availabilityCache.key === key && Date.now() - availabilityCache.at < 30_000) {
    return availabilityCache.value;
  }
  const value = await checkAvailability(projectDir ?? undefined, config.profiles);
  availabilityCache = { key, at: Date.now(), value };
  return value;
}

async function runnableAgents(config: KonseyConfig, projectDir?: string | null) {
  const availability = await cachedAvailability(projectDir);
  const available = new Set(availability.filter((a) => a.available).map((a) => a.agent));
  const profiles = config.profiles.map((profile) => ({
    ...profile,
    enabled: profile.enabled && available.has(profile.agent),
  }));
  const providers = await Promise.all(config.providers.map(async (provider) => ({
    ...provider,
    enabled: provider.enabled && (await providerReady(provider)),
  })));
  return { profiles, providers };
}

/** Claude limit yuzdesini ogrenmenin tek yolu bir CLI turu: en ucuz modelle tek kelime. */
let claudeProbe: Promise<void> | null = null;
function probeClaude(): Promise<void> {
  claudeProbe ??= (async () => {
    const result = await runAgent({
      runId: 'probe',
      agent: 'claude',
      cwd: app.getPath('temp'),
      prompt: "Sadece 'ok' yaz.",
      allowWrite: false,
      lean: true,
      model: 'haiku',
      timeoutMs: 60_000,
    });
    if (result.limits?.length) await recordLimits('claude', result.limits);
  })().finally(() => {
    claudeProbe = null;
  });
  return claudeProbe;
}

async function currentQuotas(refresh = false) {
  const config = await loadConfig();
  let quotas = await computeQuotas(config.profiles, config.providers);
  const claude = quotas.find((q) => q.agent === 'claude');
  const claudeOn = config.profiles.find((p) => p.agent === 'claude')?.enabled;
  const stale = !claude?.observedAt || Date.now() - claude.observedAt > 30 * 60 * 1000;
  if (claudeOn && (refresh || stale)) {
    await probeClaude().catch(() => {});
    quotas = await computeQuotas(config.profiles, config.providers);
  }
  return quotas;
}

// ---------------------------------------------------------------- IPC: ajanlar

/**
 * Makinede bulunan hazir CLI'lari ajan listesine ekler. Kullanicinin
 * kaldirdigi bir CLI tekrar eklenmez.
 */
async function syncDetectedClis(): Promise<boolean> {
  const found = await detectInstalledClis();
  const config = await loadConfig();
  const dismissed = new Set(config.dismissedClis ?? []);
  const missing = found.filter(({ preset }) =>
    !dismissed.has(preset.id) && !config.profiles.some((p) => p.agent === `cli:${preset.id}`));
  if (!missing.length) return false;
  config.profiles.push(...missing.map(({ preset }) => profileForPreset(preset)));
  await saveConfig(config);
  return true;
}

ipcMain.handle('konsey:availability', async (_e, preferWorkspace?: string) => {
  await syncDetectedClis().catch(() => false);
  const config = await loadConfig();
  const builtins = await cachedAvailability(preferWorkspace, true);

  // Saglayicilar icin "kullanilabilir" olcutu: Keychain'de anahtarinin olmasi.
  const providers = await Promise.all(
    config.providers.map(async (p) => {
      const ready = await providerReady(p);
      return {
        agent: `provider:${p.slug}`,
        available: ready,
        detail: ready ? `${p.model}` : L('API anahtarı kayıtlı değil.', 'No API key saved.'),
        target: p.baseUrl,
      };
    }),
  );
  return [...builtins, ...providers];
});

/** Kurulum ve giris komutlari: hazir ajanlar ve CLI sablonlari. */
interface ConnectInfo {
  id: string;
  label: string;
  install: string | null;
  login: string | null;
  docs: string;
  needsNode: boolean;
}

function connectInfo(id: string): ConnectInfo | null {
  if (id === 'claude') {
    return {
      id, label: 'Claude Code',
      install: IS_WIN
        ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"'
        : 'curl -fsSL https://claude.ai/install.sh | bash',
      login: 'claude',
      docs: 'https://docs.claude.com/en/docs/claude-code/setup',
      needsNode: false,
    };
  }
  if (id === 'codex') {
    return {
      id, label: 'Codex CLI',
      install: 'npm install -g @openai/codex',
      login: 'codex login',
      docs: 'https://developers.openai.com/codex/cli',
      needsNode: true,
    };
  }
  if (id === 'antigravity') {
    return { id, label: 'Antigravity', install: null, login: null, docs: 'https://antigravity.google/download', needsNode: false };
  }
  const preset = presetFor(id.replace(/^cli:/, ''));
  if (!preset) return null;
  return {
    id: `cli:${preset.id}`,
    label: preset.label,
    install: preset.install,
    login: preset.login,
    docs: preset.docs,
    needsNode: preset.install.startsWith('npm '),
  };
}

ipcMain.handle('konsey:system', async () => ({
  platform: process.platform,
  lang: LANG,
  version: app.getVersion(),
  git: Boolean(await which('git')),
  node: Boolean(await which('node')),
}));

/** Kurulabilir tum ajanlar (hazir uclu + CLI sablonlari) ve kurulu olup olmadiklari. */
ipcMain.handle('konsey:connect:list', async () => {
  const [availability, installed] = await Promise.all([cachedAvailability(null, true), detectInstalledClis()]);
  const builtin = ['claude', 'codex', ...(IS_MAC ? ['antigravity'] : [])].map((id) => ({
    ...connectInfo(id)!,
    installed: Boolean(availability.find((a) => a.agent === id)?.target) || (id === 'antigravity' && Boolean(availability.find((a) => a.agent === id)?.available)),
  }));
  const clis = CLI_PRESETS.map((preset) => ({
    ...connectInfo(preset.id)!,
    installed: installed.some((f) => f.preset.id === preset.id),
  }));
  return [...builtin, ...clis];
});

/** Kurulum ya da giris komutunu kullanicinin terminalinde acar. */
ipcMain.handle('konsey:connect:run', async (_e, id: string, action: 'install' | 'login') => {
  const info = connectInfo(String(id));
  if (!info) return { ok: false, error: L('Bilinmeyen ajan.', 'Unknown agent.') };
  const command = action === 'install' ? info.install : info.login;
  if (!command) {
    await shell.openExternal(info.docs);
    return { ok: true, opened: 'docs' };
  }
  if (action === 'install' && info.needsNode && !(await which('npm'))) {
    await shell.openExternal('https://nodejs.org/en/download');
    return { ok: false, error: L('Önce Node.js kurulmalı; indirme sayfası açıldı.', 'Node.js is required first; the download page was opened.') };
  }
  const ok = await openInTerminal(command);
  if (ok) {
    remember('terminal', 'ok');
    return { ok: true };
  }
  // macOS Terminal iznini reddettiyse kullaniciya dogru ayar sayfasi sunulur.
  const terminal = IS_MAC ? await grantTerminal() : 'unknown';
  if (terminal === 'ok' && (await openInTerminal(command))) return { ok: true };
  return {
    ok: false,
    fix: terminal === 'denied' ? 'open-automation' : undefined,
    error: terminal === 'denied'
      ? L('macOS, Konsey’in Terminal’i açmasına izin vermiyor. “Ayarları aç”a bas, Konsey’in yanındaki Terminal’i aç.', 'macOS does not let Konsey open Terminal. Press “Open Settings” and turn on Terminal next to Konsey.')
      : L('Terminal açılamadı. Komutu kendin çalıştır:', 'Could not open a terminal. Run this command yourself:') + ` ${command}`,
  };
});

// ---------------------------------------------------------------- IPC: hazirlik ve izinler

ipcMain.handle('konsey:setup:checks', async (_e, projectDir?: string | null) => runChecks(projectDir ?? null));

/** Tek tikla cozum: izin penceresini acar, kurulumu baslatir ya da Ayarlar'i acar. */
ipcMain.handle('konsey:setup:fix', async (_e, id: string) => {
  const openUrl = async (url: string) => {
    await shell.openExternal(url);
  };
  switch (String(id)) {
    case 'grant-terminal':
      return { ok: (await grantTerminal()) === 'ok' };
    case 'open-automation':
      await openUrl(SETTINGS_URL.automation);
      return { ok: true };
    case 'open-files':
      await openUrl(SETTINGS_URL.files);
      return { ok: true };
    case 'install-git':
      return { ok: await installGit(openInTerminal, openUrl) };
    case 'install-node':
      return { ok: await installNode(openInTerminal, openUrl) };
    case 'login-claude':
    case 'login-codex': {
      const info = connectInfo(String(id).slice('login-'.length));
      if (!info?.login) return { ok: false };
      const ok = await openInTerminal(info.login);
      if (!ok && IS_MAC && (await grantTerminal()) === 'denied') {
        await openUrl(SETTINGS_URL.automation);
        return { ok: false, error: L('Önce Konsey’e Terminal izni ver.', 'First allow Konsey to use Terminal.') };
      }
      return { ok };
    }
    default:
      return { ok: false };
  }
});

ipcMain.handle('konsey:openExternal', async (_e, url: string) => {
  if (/^https:\/\//.test(String(url))) await shell.openExternal(url);
  return true;
});

/** Dil degisince tum metinler yeniden olussun diye uygulama yeniden baslar. */
ipcMain.handle('konsey:relaunch', async () => {
  app.relaunch();
  app.exit(0);
});

// ---------------------------------------------------------------- IPC: entegrasyonlar

/** Servis listesi, bagli olup olmadiklari (token degeri arayuze hic gitmez). */
ipcMain.handle('konsey:integrations:list', async () => {
  const config = await loadConfig();
  const known = await Promise.all(INTEGRATIONS.map(async (def) => {
    const cfg = config.integrations.find((i) => i.id === def.id);
    return {
      id: def.id,
      label: def.label,
      blurb: def.blurb(),
      tokenUrl: def.tokenUrl,
      tokenHint: def.tokenHint,
      supportsReadOnly: def.readOnly,
      readOnly: def.readOnly && cfg?.readOnly !== false,
      enabled: Boolean(cfg?.enabled),
      hasToken: await hasSecret(secretAccount(def.id)),
      engines: def.server('', true).type === 'http' ? ['claude', 'codex'] : ['claude'],
      custom: false,
    };
  }));
  const custom = await Promise.all(config.integrations.filter((i) => i.id.startsWith('custom-')).map(async (cfg) => ({
    id: cfg.id,
    label: cfg.label ?? cfg.id,
    blurb: cfg.url ?? '',
    tokenUrl: '',
    tokenHint: '',
    supportsReadOnly: false,
    readOnly: false,
    enabled: cfg.enabled,
    hasToken: await hasSecret(secretAccount(cfg.id)),
    engines: ['claude', 'codex'],
    custom: true,
  })));
  return [...known, ...custom];
});

/** Baglar ya da gunceller. Token bos gelirse mevcut token korunur. */
ipcMain.handle('konsey:integrations:save', async (_e, input: { id: string; token?: string; readOnly?: boolean; enabled?: boolean; label?: string; url?: string }) => {
  const id = String(input.id);
  const custom = id.startsWith('custom-');
  if (!custom && !integrationDef(id)) return { ok: false, error: L('Bilinmeyen servis.', 'Unknown service.') };
  if (custom && !/^https:\/\//.test(String(input.url ?? ''))) return { ok: false, error: L('Adres https:// ile başlamalı.', 'The address must start with https://.') };
  if (input.token) await setSecret(secretAccount(id), input.token.trim());
  if (!custom && !(await hasSecret(secretAccount(id)))) return { ok: false, error: L('Token gerekli.', 'A token is required.') };
  const config = await loadConfig();
  const current = config.integrations.find((i) => i.id === id);
  const next = {
    ...(current ?? { id, enabled: true }),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
    ...(custom ? { label: input.label ?? current?.label ?? id, url: input.url ?? current?.url } : {}),
  };
  config.integrations = [...config.integrations.filter((i) => i.id !== id), next];
  await saveConfig(config);
  return { ok: true };
});

ipcMain.handle('konsey:integrations:remove', async (_e, id: string) => {
  await deleteSecret(secretAccount(String(id)));
  const config = await loadConfig();
  config.integrations = config.integrations.filter((i) => i.id !== id);
  await saveConfig(config);
  return true;
});

/** Token'i servisin kendi API'sine hafif bir istekle dener. */
ipcMain.handle('konsey:integrations:test', async (_e, id: string, token?: string) => {
  const def = integrationDef(String(id));
  if (!def) return { ok: true, detail: L('Özel sunucu: ajan ilk kullanımda bağlanır.', 'Custom server: agents connect on first use.') };
  const value = token?.trim() || (await getSecret(secretAccount(def.id)));
  if (!value) return { ok: false, detail: L('Token yok.', 'No token.') };
  return def.test(value);
});

ipcMain.handle('konsey:quotas', async (_e, refresh?: boolean) => currentQuotas(Boolean(refresh)));

ipcMain.handle('konsey:usage', async () => {
  const config = await loadConfig();
  const agents = [
    ...config.profiles.map((p) => p.agent),
    ...config.providers.map((p) => `provider:${p.slug}` as AgentId),
  ];
  return usageTotals(agents);
});

ipcMain.handle('konsey:config:load', async (): Promise<KonseyConfig> => loadConfig());

ipcMain.handle('konsey:config:save', async (_e, config: KonseyConfig) => {
  await saveConfig(config);
  return true;
});

ipcMain.handle('konsey:theme', (_e, theme: 'system' | 'light' | 'dark') => {
  nativeTheme.themeSource = theme;
  return true;
});

ipcMain.handle('konsey:provider:setKey', async (_e, slug: string, apiKey: string) => {
  if (apiKey) await setSecret(slug, apiKey);
  else await deleteSecret(slug);
  return true;
});

ipcMain.handle('konsey:provider:hasKey', async (_e, slug: string) => hasSecret(slug));

ipcMain.handle('konsey:provider:test', async (_e, provider: ProviderConfig, apiKey?: string) => {
  const resolved = apiKey || (await getSecret(provider.slug));
  if (!resolved) return { ok: false, models: [], error: L('API anahtarı yok.', 'No API key.') };
  return listModels(provider.baseUrl, resolved);
});

// ---------------------------------------------------------------- IPC: proje

async function describeProject(dir: string) {
  const isGit = await isGitRepo(dir);
  return { dir, isGit, hasCommit: isGit && Boolean(await headCommit(dir)) };
}

ipcMain.handle('konsey:pickProject', async () => {
  const opts: Electron.OpenDialogOptions = {
    properties: ['openDirectory', 'createDirectory'],
    title: L('Proje klasörünü seç', 'Choose project folder'),
    buttonLabel: L('Seç', 'Choose'),
  };
  const res = await (mainWindow ? dialog.showOpenDialog(mainWindow, opts) : dialog.showOpenDialog(opts));
  if (res.canceled || res.filePaths.length === 0) return null;
  const dir = res.filePaths[0];
  const config = await loadConfig();
  await saveConfig({ ...config, recentProjects: [dir, ...config.recentProjects.filter((p) => p !== dir)].slice(0, 12) });
  return describeProject(dir);
});

ipcMain.handle('konsey:project:describe', async (_e, dir: string) => describeProject(dir));

ipcMain.handle('konsey:project:prepare', async (_e, dir: string) => prepareRepo(dir));

ipcMain.handle('konsey:project:select', async (_e, dir: string) => {
  const config = await loadConfig();
  await saveConfig({ ...config, recentProjects: [dir, ...config.recentProjects.filter((p) => p !== dir)].slice(0, 12) });
  return describeProject(dir);
});

ipcMain.handle('konsey:openPath', async (_e, target: string) => {
  await shell.openPath(target);
});

ipcMain.handle('konsey:reveal', async (_e, target: string) => {
  shell.showItemInFolder(target);
});

// ---------------------------------------------------------------- IPC: gorseller

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
    title: L('Görsel ekle', 'Add image'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: L('Görseller', 'Images'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  };
  const res = await (mainWindow ? dialog.showOpenDialog(mainWindow, opts) : dialog.showOpenDialog(opts));
  return res.canceled ? [] : loadImages(res.filePaths);
});

ipcMain.handle('konsey:images:fromPaths', async (_e, paths: string[]) =>
  loadImages(Array.isArray(paths) ? paths : []),
);

ipcMain.handle('konsey:images:save', async (_e, input: { name?: string; mime: string; bytes: ArrayBuffer }) => {
  const mimeEntry = Object.entries(IMAGE_MIMES).find(([, mime]) => mime === input.mime);
  const bytes = Buffer.from(input.bytes);
  if (!mimeEntry || bytes.byteLength > 20 * 1024 * 1024) throw new Error(L('Desteklenmeyen veya çok büyük görsel.', 'Unsupported or too large image.'));
  const dir = path.join(app.getPath('temp'), 'konsey-attachments');
  await mkdir(dir, { recursive: true });
  const imagePath = path.join(dir, `${randomUUID()}${mimeEntry[0]}`);
  await writeFile(imagePath, bytes);
  const [saved] = await loadImages([imagePath]);
  return { ...saved, name: input.name || saved.name };
});

// ---------------------------------------------------------------- IPC: sohbet

ipcMain.handle('konsey:chat:load', async (_e, projectDir: string | null) => loadChats(projectDir ?? null));

ipcMain.handle('konsey:chat:clear', async (_e, projectDir: string | null, thread: string) => {
  await clearThread(projectDir ?? null, thread);
  return true;
});

ipcMain.handle(
  'konsey:chat:send',
  async (_e, args: { projectDir: string | null; thread: 'council' | AgentId; text: string }) => {
    const text = String(args.text ?? '').trim();
    if (!text) return { ok: false, error: L('Boş mesaj.', 'Empty message.') };
    if (activeChats.has(args.thread)) return { ok: false, error: L('Bu sohbette cevap bekleniyor.', 'Already waiting for a reply in this chat.') };
    const controller = new AbortController();
    activeChats.set(args.thread, controller);
    try {
      await postUserMessage(args.projectDir ?? null, args.thread, text, send);
      const config = await loadConfig();
      const { profiles, providers } = await runnableAgents(config, args.projectDir);
      await sendChat({
        userAlreadyPosted: true,
        projectDir: args.projectDir ?? null,
        thread: args.thread,
        text,
        profiles,
        providers,
        integrations: await resolveIntegrations(config.integrations, getSecret),
        signal: controller.signal,
        emit: send,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    } finally {
      activeChats.delete(args.thread);
    }
  },
);

ipcMain.handle('konsey:chat:cancel', async (_e, thread: string) => {
  activeChats.get(thread)?.abort();
  return true;
});

// ---------------------------------------------------------------- IPC: tartismalar

/**
 * Turlar arka planda ilerler; IPC hemen doner, mesajlar olay olarak akar.
 * Ayni tartismada ayni anda tek islem calisir.
 */
async function runDebate(id: string, rounds: number, summarize: boolean): Promise<{ ok: boolean; error?: string }> {
  const debate = await getDebate(id);
  if (!debate) return { ok: false, error: L('Tartışma bulunamadı.', 'Discussion not found.') };
  if (activeDebates.has(id) || debate.busy) return { ok: false, error: L('Ajanlar hâlâ konuşuyor.', 'The agents are still talking.') };
  const controller = new AbortController();
  activeDebates.set(id, controller);
  void (async () => {
    try {
      const config = await loadConfig();
      const { profiles, providers } = await runnableAgents(config, debate.projectDir);
      await advanceDebate(id, {
        rounds,
        summarize,
        profiles,
        providers,
        integrations: debate.projectDir ? await resolveIntegrations(config.integrations, getSecret) : [],
        coordinator: config.coordinator,
        signal: controller.signal,
        emit: send,
      });
    } catch (error) {
      console.warn('[debate]', (error as Error).message);
    } finally {
      activeDebates.delete(id);
    }
  })();
  return { ok: true };
}

const clampDepth = (depth: unknown) => Math.max(1, Math.min(3, Math.round(Number(depth) || 2)));

ipcMain.handle('konsey:debates:list', async (_e, projectDir: string | null) => listDebates(projectDir ?? null));
ipcMain.handle('konsey:debates:get', async (_e, id: string) => {
  const debate = await getDebate(String(id)).catch(() => null);
  return debate ? structuredClone(debate) : null;
});

ipcMain.handle('konsey:debates:start', async (_e, args: { topic: string; projectDir: string | null; depth?: number }) => {
  try {
    const debate = await createDebate(String(args.topic ?? ''), args.projectDir || null);
    const res = await runDebate(debate.id, clampDepth(args.depth), true);
    return { ...res, debate: structuredClone(await getDebate(debate.id)) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
});

ipcMain.handle('konsey:debates:say', async (_e, id: string, text: string) => {
  if (!String(text ?? '').trim()) return { ok: false, error: L('Boş mesaj.', 'Empty message.') };
  if (activeDebates.has(id)) return { ok: false, error: L('Ajanlar hâlâ konuşuyor; bitince yaz ya da durdur.', 'The agents are still talking; write when they finish or stop them.') };
  try {
    const debate = await postToDebate(id, String(text));
    send({ type: 'debate:updated', debate: structuredClone(debate) });
    return runDebate(id, 1, true);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
});

ipcMain.handle('konsey:debates:round', async (_e, id: string) => runDebate(id, 1, true));
ipcMain.handle('konsey:debates:summarize', async (_e, id: string) => runDebate(id, 0, true));

ipcMain.handle('konsey:debates:cancel', async (_e, id: string) => {
  activeDebates.get(id)?.abort();
  return true;
});

ipcMain.handle('konsey:debates:delete', async (_e, id: string) => {
  activeDebates.get(id)?.abort();
  await deleteDebate(id);
  return true;
});

ipcMain.handle('konsey:debates:rename', async (_e, id: string, title: string) => {
  const debate = await renameDebate(id, String(title ?? ''));
  if (debate) send({ type: 'debate:updated', debate: structuredClone(debate) });
  return debate ? structuredClone(debate) : null;
});

ipcMain.handle('konsey:debates:convert', async (_e, args: { id: string; parentDir?: string; name?: string; details?: string }) => {
  if (activeDebates.has(args.id)) return { ok: false, error: L('Ajanlar hâlâ konuşuyor; bitmesini bekle ya da durdur.', 'The agents are still talking; wait for them or stop them.') };
  try {
    const config = await loadConfig();
    const result = await convertDebate(args.id, {
      parentDir: args.parentDir,
      name: args.name,
      details: String(args.details ?? ''),
      profiles: config.profiles,
      providers: config.providers,
      emit: send,
    });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
});

ipcMain.handle('konsey:pickFolder', async (_e, defaultPath?: string) => {
  const opts: Electron.OpenDialogOptions = {
    properties: ['openDirectory', 'createDirectory'],
    title: L('Projenin açılacağı yeri seç', 'Choose where to create the project'),
    buttonLabel: L('Seç', 'Choose'),
    defaultPath: defaultPath || undefined,
  };
  const res = await (mainWindow ? dialog.showOpenDialog(mainWindow, opts) : dialog.showOpenDialog(opts));
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

/** Yeni projeler icin varsayilan yer: son secilen, yoksa son projenin yani, yoksa Belgeler/Konsey. */
ipcMain.handle('konsey:projectsDir', async () => {
  const config = await loadConfig();
  const candidates = [
    config.ui.projectsDir,
    config.recentProjects[0] ? path.dirname(config.recentProjects[0]) : undefined,
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => null))?.isDirectory()) return candidate;
  }
  return path.join(app.getPath('documents'), 'Konsey');
});

// ---------------------------------------------------------------- IPC: gorevler

ipcMain.handle('konsey:runs:list', async (_e, projectDir?: string | null) => listRuns(projectDir ?? null));
ipcMain.handle('konsey:runs:get', async (_e, id: string) => loadRun(id));
ipcMain.handle('konsey:runs:delete', async (_e, id: string) => {
  await deleteRun(id);
  return true;
});

ipcMain.handle('konsey:runs:apply', async (_e, id: string) => {
  const stored = await loadRun(id);
  if (!stored?.record.integrationBranch) return { ok: false, message: L('Bu görevin uygulanacak bir dalı yok.', 'This run has no branch to apply.') };
  const result = await applyIntegration(stored.record.projectDir, stored.record.integrationBranch);
  stored.record.applied = { ...result, at: Date.now() };
  await saveRun(stored);
  send({ type: 'run:updated', run: stored.record });
  return result;
});

ipcMain.handle(
  'konsey:run:start',
  async (_e, args: { projectDir: string; prompt: string; mode?: RunMode }) => {
    if (activeRun) return { ok: false, error: L('Zaten çalışan bir görev var.', 'A run is already in progress.') };

    const config = await loadConfig();
    const { profiles, providers } = await runnableAgents(config, args.projectDir);
    const orchestrator = new Orchestrator();
    const controller = new AbortController();
    activeRun = { orchestrator, controller };

    // Etkinlik satirlari ve ajan notlari gorev kaydiyla birlikte saklanir.
    const activity: ActivityLine[] = [];
    const unsubscribe = orchestrator.bus.on((event) => {
      send(event);
      if (event.type === 'activity') {
        activity.push({ agent: event.agent, text: event.text, tone: event.tone, at: event.at, phase: event.phase });
      } else if (event.type === 'log' && event.level !== 'info') {
        activity.push({ agent: event.agent, text: event.text, tone: event.level, at: event.at });
      } else if (event.type === 'chat:message') {
        void putMessage(args.projectDir, event.message);
      }
    });

    try {
      const record = await orchestrator.start({
        projectDir: args.projectDir,
        prompt: args.prompt,
        profiles,
        providers,
        integrations: await resolveIntegrations(config.integrations, getSecret),
        quotaProfiles: config.profiles,
        mode: args.mode ?? 'auto',
        autoApply: config.autoApply,
        coordinator: config.coordinator ?? undefined,
        reviewer: config.reviewer ?? undefined,
        signal: controller.signal,
      });
      await saveRun({ record, activity });

      const latest = await loadConfig();
      const recent = [args.projectDir, ...latest.recentProjects.filter((p) => p !== args.projectDir)];
      await saveConfig({ ...latest, recentProjects: recent.slice(0, 12) });
      send({ type: 'quota:updated', quotas: await computeQuotas(latest.profiles, latest.providers) });
      return { ok: true, record };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
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
