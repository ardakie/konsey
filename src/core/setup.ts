/**
 * Hazirlik listesi: Konsey'in calismasi icin gereken her sey tek yerde,
 * durumu ve tek tikla cozumuyle.
 *
 *   - git (zorunlu), Node.js (npm ile kurulan CLI'lar icin)
 *   - Claude/Codex oturumu (CLI'larin kendi sessiz durum komutlariyla)
 *   - macOS: Terminal'i acma izni (kurulum/giris icin), proje klasoru erisimi
 *
 * Sorulmadan yapilabilenler (git kimligi gibi) Konsey'in kendisi halleder;
 * isletim sisteminin onay istedigi seyler tek dugmeyle o onay penceresini acar.
 * Kullanici bir kez reddettiyse dogru Ayarlar sayfasi acilir.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { L } from '../shared/i18n';
import { IS_MAC, IS_WIN, which } from './env';
import { findClaude, findCodex } from './discovery';

const execFileAsync = promisify(execFile);

export type CheckState = 'ok' | 'missing' | 'denied' | 'unknown';

export interface SetupCheck {
  id: string;
  title: string;
  detail: string;
  state: CheckState;
  /** Zorunlu mu (yoksa bazi ozellikler calismaz ama uygulama calisir). */
  required: boolean;
  /** Tek tikla cozum: dugme metni ve eylem kimligi. */
  action?: { label: string; id: string };
}

/** macOS Ayarlar sayfalari. */
export const SETTINGS_URL = {
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  files: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
};

/** Onceki denemelerden ogrenilen durumlar (uygulama acik kaldigi surece). */
const learned = new Map<string, CheckState>();

export function remember(id: string, state: CheckState): void {
  learned.set(id, state);
}

async function loginState(agent: 'claude' | 'codex'): Promise<CheckState | null> {
  const bin = agent === 'claude' ? await findClaude() : await findCodex();
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(bin, agent === 'claude' ? ['auth', 'status'] : ['login', 'status'], { timeout: 15_000, windowsHide: true });
    if (agent === 'claude') {
      try {
        return JSON.parse(stdout).loggedIn ? 'ok' : 'missing';
      } catch {
        return /logged in/i.test(stdout) ? 'ok' : 'unknown';
      }
    }
    return /logged in/i.test(stdout) ? 'ok' : 'missing';
  } catch (error) {
    const out = `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`;
    return /not logged in|no credentials|login required|unauthenticated/i.test(out) ? 'missing' : 'unknown';
  }
}

/** Klasor okunabiliyor mu; macOS gizlilik korumasi reddederse 'denied'. */
export async function folderAccess(dir: string): Promise<CheckState> {
  try {
    await readdir(dir);
    return 'ok';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES' ? 'denied' : 'unknown';
  }
}

export async function runChecks(projectDir?: string | null): Promise<SetupCheck[]> {
  const [git, node, claudeLogin, codexLogin] = await Promise.all([
    which('git'),
    which('node'),
    loginState('claude'),
    loginState('codex'),
  ]);
  const checks: SetupCheck[] = [];

  checks.push({
    id: 'git',
    title: 'Git',
    required: true,
    state: git ? 'ok' : 'missing',
    detail: git
      ? L('Kurulu. Her ajan kendi git kopyasında çalışır.', 'Installed. Each agent works in its own git copy.')
      : L('Gerekli: ajanların işini ayrı kopyalarda tutmak için.', 'Required: it keeps each agent’s work in a separate copy.'),
    action: git ? undefined : { id: 'install-git', label: L('Git’i kur', 'Install git') },
  });

  checks.push({
    id: 'node',
    title: 'Node.js',
    required: false,
    state: node ? 'ok' : 'missing',
    detail: node
      ? L('Kurulu. npm ile gelen CLI’lar (Codex, Gemini…) çalışabilir.', 'Installed. CLIs that come through npm (Codex, Gemini…) can run.')
      : L('Codex, Gemini CLI gibi npm ile kurulan ajanlar için gerekir.', 'Needed for agents installed with npm, such as Codex and Gemini CLI.'),
    action: node ? undefined : { id: 'install-node', label: L('Node.js’i kur', 'Install Node.js') },
  });

  for (const [agent, label, state] of [['claude', 'Claude Code', claudeLogin], ['codex', 'Codex', codexLogin]] as const) {
    if (state === null) continue;
    const effective = learned.get(`login-${agent}`) === 'missing' && state !== 'ok' ? 'missing' : state;
    checks.push({
      id: `login-${agent}`,
      title: L(`${label} oturumu`, `${label} sign-in`),
      required: false,
      state: effective,
      detail: effective === 'ok'
        ? L('Hesabın bağlı.', 'Your account is connected.')
        : effective === 'missing'
          ? L('Giriş yapılmamış; bu ajan iş alamaz.', 'Not signed in; this agent cannot take work.')
          : L('Oturum durumu okunamadı.', 'Could not read the sign-in state.'),
      action: effective === 'ok' ? undefined : { id: `login-${agent}`, label: L('Giriş yap', 'Sign in') },
    });
  }

  if (IS_MAC) {
    const terminal = learned.get('terminal') ?? 'unknown';
    checks.push({
      id: 'terminal',
      title: L('Terminal’i açma izni', 'Permission to open Terminal'),
      required: false,
      state: terminal,
      detail: terminal === 'ok'
        ? L('Verildi. Kurulum ve giriş komutları tek tıkla Terminal’de açılır.', 'Granted. Install and sign-in commands open in Terminal with one click.')
        : terminal === 'denied'
          ? L('Reddedilmiş. Ayarlar’da Konsey için Terminal’i aç.', 'Denied. Turn on Terminal for Konsey in Settings.')
          : L('Kurulum ve giriş komutlarını Terminal’de açabilmek için macOS bir kez sorar.', 'macOS asks once so install and sign-in commands can open in Terminal.'),
      action: terminal === 'ok'
        ? undefined
        : terminal === 'denied'
          ? { id: 'open-automation', label: L('Ayarları aç', 'Open Settings') }
          : { id: 'grant-terminal', label: L('İzin ver', 'Allow') },
    });

    if (projectDir) {
      const access = await folderAccess(projectDir);
      checks.push({
        id: 'folder',
        title: L('Proje klasörüne erişim', 'Access to the project folder'),
        required: true,
        state: access,
        detail: access === 'ok'
          ? L('Konsey ve ajanlar klasörü okuyup yazabilir.', 'Konsey and its agents can read and write the folder.')
          : L(`macOS “${path.basename(projectDir)}” klasörüne erişimi engelliyor. Ayarlar’da Konsey’e Dosyalar ve Klasörler izni ver.`, `macOS blocks access to “${path.basename(projectDir)}”. Give Konsey Files and Folders access in Settings.`),
        action: access === 'ok' ? undefined : { id: 'open-files', label: L('Ayarları aç', 'Open Settings') },
      });
    }
  }
  return checks;
}

/** Terminal'e zararsiz bir AppleScript: izin yoksa macOS onay penceresini gosterir. */
export async function grantTerminal(): Promise<CheckState> {
  if (!IS_MAC) return 'ok';
  try {
    await execFileAsync('/usr/bin/osascript', ['-e', 'tell application "Terminal" to get name'], { timeout: 60_000 });
    remember('terminal', 'ok');
    return 'ok';
  } catch (error) {
    // -1743: kullanici izin vermedi (ya da daha once reddetti).
    const denied = /-1743|not allowed|not authori[sz]ed/i.test(String((error as Error).message) + String((error as { stderr?: string }).stderr ?? ''));
    remember('terminal', denied ? 'denied' : 'unknown');
    return denied ? 'denied' : 'unknown';
  }
}

/** Git kurulumu: macOS'ta Apple'in kendi kurulum penceresi, Windows'ta winget. */
export async function installGit(openInTerminal: (cmd: string) => Promise<boolean>, openUrl: (url: string) => Promise<void>): Promise<boolean> {
  if (IS_MAC) {
    try {
      await execFileAsync('/usr/bin/xcode-select', ['--install']);
      return true;
    } catch {
      await openUrl('https://git-scm.com/download/mac');
      return true;
    }
  }
  if (IS_WIN && (await which('winget'))) return openInTerminal('winget install --id Git.Git -e --source winget');
  await openUrl('https://git-scm.com/downloads');
  return true;
}

export async function installNode(openInTerminal: (cmd: string) => Promise<boolean>, openUrl: (url: string) => Promise<void>): Promise<boolean> {
  if (IS_MAC && (await which('brew'))) return openInTerminal('brew install node');
  if (IS_WIN && (await which('winget'))) return openInTerminal('winget install --id OpenJS.NodeJS.LTS -e --source winget');
  await openUrl('https://nodejs.org/en/download');
  return true;
}

/** Hata metninden kullaniciya sunulacak tek tikla cozum. */
export function fixForError(text: string, agent?: string): { id: string; label: string } | null {
  if (/operation not permitted|EPERM/i.test(text)) return { id: 'open-files', label: L('Klasör izni ver', 'Grant folder access') };
  if (/-1743|not allowed to send apple events/i.test(text)) return { id: 'open-automation', label: L('Terminal iznini aç', 'Allow Terminal') };
  if ((agent === 'claude' || agent === 'codex') && /log ?in|oturum|sign in|unauthori[sz]ed|401|credentials/i.test(text)) {
    return { id: `login-${agent}`, label: L('Giriş yap', 'Sign in') };
  }
  if (/git: command not found|spawn git ENOENT|'git' is not recognized/i.test(text)) return { id: 'install-git', label: L('Git’i kur', 'Install git') };
  return null;
}

