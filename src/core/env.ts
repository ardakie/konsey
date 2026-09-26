/**
 * Calistirma ortami: PATH, komut bulma ve platforma gore surec baslatma.
 *
 * Paketlenmis bir Mac uygulamasi Finder'dan acildiginda kabugun PATH'ini
 * gormez (yalnizca /usr/bin:/bin:/usr/sbin:/sbin). npm, Homebrew, bun,
 * nvm ile kurulan CLI'lar ve onlarin ihtiyac duydugu `node` bu yuzden
 * bulunamaz. Burada kullanicinin giris kabugundan gercek PATH okunur ve
 * bilinen kurulum klasorleri eklenir.
 *
 * Windows'ta npm kurulumlari `.cmd` sarmalayicisi uretir; Node bunlari
 * kabuksuz calistiramaz. Sarmalayicinin gosterdigi betik dogrudan node ile
 * calistirilir, boylece istem metni cmd.exe'nin kurallarina takilmaz.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOME = os.homedir();
export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

function extraDirs(): string[] {
  if (IS_WIN) {
    const appData = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData', 'Local');
    return [
      path.join(appData, 'npm'),
      path.join(HOME, '.local', 'bin'),
      path.join(HOME, '.bun', 'bin'),
      path.join(HOME, '.cargo', 'bin'),
      path.join(HOME, 'scoop', 'shims'),
      path.join(local, 'pnpm'),
      path.join(local, 'Volta', 'bin'),
      path.join(local, 'Programs', 'nodejs'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd'),
    ];
  }
  const dirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(HOME, '.local', 'bin'),
    path.join(HOME, '.npm-global', 'bin'),
    path.join(HOME, '.bun', 'bin'),
    path.join(HOME, '.volta', 'bin'),
    path.join(HOME, '.cargo', 'bin'),
    path.join(HOME, '.deno', 'bin'),
    path.join(HOME, '.opencode', 'bin'),
    path.join(HOME, 'Library', 'pnpm'),
    path.join(HOME, 'bin'),
  ];
  // nvm: en yeni surumun bin klasoru.
  try {
    const root = path.join(HOME, '.nvm', 'versions', 'node');
    const versions = readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) dirs.push(path.join(root, v, 'bin'));
  } catch {
    /* nvm yok */
  }
  return dirs;
}

function mergePath(...lists: (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const dir of String(list ?? '').split(path.delimiter)) {
      const key = IS_WIN ? dir.toLowerCase() : dir;
      if (!dir || seen.has(key)) continue;
      seen.add(key);
      out.push(dir);
    }
  }
  return out.join(path.delimiter);
}

/** Giris kabugunun PATH'i. Kabuk yavas ya da bozuksa sessizce vazgecilir. */
function loginShellPath(): Promise<string | null> {
  if (IS_WIN) return Promise.resolve(null);
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  const marker = '__KONSEY_PATH__';
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], {
      timeout: 6000,
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true' },
    }, (_err, stdout) => {
      const match = String(stdout ?? '').match(new RegExp(`${marker}(.*)${marker}`));
      resolve(match ? match[1] : null);
    });
  });
}

let pathReady: Promise<void> | null = null;

/** PATH'i bir kez zenginlestirir; tum komut aramalari bunu bekler. */
export function ensurePath(): Promise<void> {
  pathReady ??= (async () => {
    const shellPath = await loginShellPath();
    process.env.PATH = mergePath(shellPath ?? undefined, process.env.PATH, extraDirs().filter((d) => existsSync(d)).join(path.delimiter));
  })();
  return pathReady;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Komutu PATH'te arar (Windows'ta .exe/.cmd uzantilariyla). */
export async function which(bin: string): Promise<string | null> {
  await ensurePath();
  if (path.isAbsolute(bin)) return isFile(bin) ? bin : null;
  const exts = IS_WIN
    ? ['.exe', '.cmd', '.bat', '.com', '']
    : [''];
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) if (c && isFile(c)) return c;
  return null;
}

/**
 * npm'in `.cmd` sarmalayicisinin calistirdigi betik. Bicim:
 *   "%_prog%"  "%dp0%\node_modules\paket\cli.js" %*
 */
function npmShimTarget(cmdFile: string): string | null {
  try {
    const text = readFileSync(cmdFile, 'utf8');
    const match = text.match(/"%(?:~?dp0)%\\([^"]+?\.(?:c?js|mjs))"/i);
    if (!match) return null;
    const target = path.join(path.dirname(cmdFile), match[1]);
    return existsSync(target) ? target : null;
  } catch {
    return null;
  }
}

export interface Launch {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}

/** Windows'ta kabuk icin arguman tirnaklama (yalnizca bayrak/yol gibi kisa degerler icin). */
function quoteCmd(arg: string): string {
  if (/^[\w\-.:/\\=@,]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Bir komutun platformda gercekten nasil baslatilacagini cozer. */
export async function resolveLaunch(command: string, args: string[]): Promise<Launch> {
  if (!IS_WIN || !/\.(cmd|bat)$/i.test(command)) return { command, args };
  const script = npmShimTarget(command);
  if (script) {
    const node = await which('node');
    if (node) return { command: node, args: [script, ...args] };
    // Sistemde node yoksa Electron'un kendi Node'u kullanilir.
    return { command: process.execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { command: quoteCmd(command), args: args.map(quoteCmd), shell: true };
}

/** Surec agacini sonlandirir (Windows'ta alt surecler de). */
export function killTree(pid: number | undefined, force = false): void {
  if (!pid) return;
  if (IS_WIN) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    /* zaten kapanmis */
  }
}

/**
 * Kullanicinin terminalinde bir komut acar (CLI kurulumu ya da girisi icin).
 * Komut kullanicinin gozu onunde calisir; Konsey ciktisini okumaz.
 */
export function openInTerminal(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (IS_MAC) {
      const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      execFile('/usr/bin/osascript', [
        '-e', 'tell application "Terminal" to activate',
        '-e', `tell application "Terminal" to do script "${escaped}"`,
      ], (err) => resolve(!err));
    } else if (IS_WIN) {
      const child = spawn('cmd.exe', ['/c', 'start', '"Konsey"', 'cmd.exe', '/k', command], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      });
      child.on('error', () => resolve(false));
      child.unref();
      resolve(true);
    } else {
      const child = spawn('x-terminal-emulator', ['-e', 'bash', '-lc', `${command}; exec bash`], { detached: true, stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.unref();
      resolve(true);
    }
  });
}
