/**
 * Uc ajanin makinede nasil calistirilacagini runtime'da kesfeder.
 *
 * Claude ve Codex sabit ikili dosyalar. Antigravity ise calisan IDE'nin
 * icindeki language server'a baglaniyor; adresi ve CSRF token'i her IDE
 * yeniden baslatildiginda degistigi icin her calistirmada process
 * argumanlarindan yeniden okunmali.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentAvailability, AgentProfile } from '../shared/types';
import { findCliBinary } from './clis';
import { L, locale } from '../shared/i18n';
import { ensurePath, firstExisting, IS_MAC, IS_WIN, which } from './env';

const execFileAsync = promisify(execFile);

const HOME = os.homedir();

/** Codex CLI; Mac'te ChatGPT/Codex uygulamasinin icinde de gelir. */
const CODEX_CANDIDATES = IS_WIN
  ? [path.join(HOME, '.codex', 'bin', 'codex.exe')]
  : [
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      path.join(HOME, '.codex/bin/codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ];

const CLAUDE_CANDIDATES = IS_WIN
  ? [path.join(HOME, '.local', 'bin', 'claude.exe'), path.join(HOME, '.claude', 'local', 'claude.exe')]
  : [
      path.join(HOME, '.local/bin/claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      path.join(HOME, '.claude/local/claude'),
    ];

/** agentapi, language server'a "agentapi" alt komutuyla giden ince bir sh sarmalayici. */
const AGENTAPI_CANDIDATES = [
  path.join(HOME, '.gemini/antigravity/bin/agentapi'),
  path.join(HOME, '.gemini/antigravity-ide/bin/agentapi'),
];

interface ClaudeQuotaState {
  retryAt: number;
  retryHint: string;
  eventAt: number;
}

function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return epochMs(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseClaudeQuotaLine(line: string, fileMtime: number): ClaudeQuotaState | null {
  try {
    const entry = JSON.parse(line) as Record<string, any>;
    const limits = entry.quotaLimits as Record<string, unknown> | undefined;
    const rejected = limits?.status === 'rejected' || entry.error === 'rate_limit' || entry.apiErrorStatus === 429;
    if (!rejected) return null;
    const retryAt = epochMs(limits?.resetsAt ?? entry.resetsAt);
    if (!retryAt) return null;
    const eventAt = epochMs(entry.timestamp) ?? fileMtime;
    const reset = new Date(retryAt).toLocaleString(locale(), {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    return { retryAt, retryHint: L(`${reset} tarihinde yenilenir`, `resets ${reset}`), eventAt };
  } catch {
    return null;
  }
}

/**
 * Claude Code kota bilgisini kendi yerel JSONL oturum kayitlarindan okur.
 * CLI'nin var olmasi hesabin o anda is kabul edebildigi anlamina gelmez.
 */
async function detectClaudeQuota(now = Date.now()): Promise<ClaudeQuotaState | null> {
  const root = path.join(HOME, '.claude', 'projects');
  try {
    const projectDirs = await readdir(root, { withFileTypes: true });
    const files: { file: string; mtime: number; size: number }[] = [];
    for (const project of projectDirs) {
      if (!project.isDirectory()) continue;
      const dir = path.join(root, project.name);
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, item.name);
        const info = await stat(file);
        files.push({ file, mtime: info.mtimeMs, size: info.size });
      }
    }

    files.sort((a, b) => b.mtime - a.mtime);
    let newest: ClaudeQuotaState | null = null;
    for (const candidate of files.slice(0, 24)) {
      const bytes = Math.min(candidate.size, 2 * 1024 * 1024);
      if (!bytes) continue;
      const handle = await open(candidate.file, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        await handle.read(buffer, 0, bytes, candidate.size - bytes);
        const lines = buffer.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const quota = parseClaudeQuotaLine(lines[i], candidate.mtime);
          if (quota && (!newest || quota.eventAt > newest.eventAt)) newest = quota;
        }
      } finally {
        await handle.close();
      }
    }
    return newest && newest.retryAt > now ? newest : null;
  } catch {
    // Kayit klasoru olmayabilir veya okunamayabilir; bu durumda CLI kesfi yeterlidir.
    return null;
  }
}

interface CodexLimitObservation extends ClaudeQuotaState {
  exhausted: boolean;
}

function parseCodexLimitLine(line: string, fileMtime: number): CodexLimitObservation | null {
  try {
    const entry = JSON.parse(line) as Record<string, any>;
    const limits = entry.payload?.rate_limits as Record<string, any> | undefined;
    if (!limits || limits.limit_id !== 'codex') return null;
    const primaryUsed = Number(limits.primary?.used_percent ?? 0);
    const secondaryUsed = Number(limits.secondary?.used_percent ?? 0);
    const exhausted = primaryUsed >= 100 || secondaryUsed >= 100 || !!limits.rate_limit_reached_type;
    const resetCandidates = [
      primaryUsed >= 100 || limits.rate_limit_reached_type ? epochMs(limits.primary?.resets_at) : undefined,
      secondaryUsed >= 100 ? epochMs(limits.secondary?.resets_at) : undefined,
    ].filter((value): value is number => value !== undefined);
    const retryAt = resetCandidates.length ? Math.max(...resetCandidates) : 0;
    const eventAt = epochMs(entry.timestamp) ?? fileMtime;
    const reset = retryAt
      ? new Date(retryAt).toLocaleString(locale(), {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      : L('bilinmeyen zamanda', 'at an unknown time');
    return { exhausted, retryAt, retryHint: L(`${reset} tarihinde yenilenir`, `resets ${reset}`), eventAt };
  } catch {
    return null;
  }
}

async function collectJsonl(dir: string, depth: number, output: string[]): Promise<void> {
  if (depth < 0) return;
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, item.name);
    if (item.isDirectory()) await collectJsonl(target, depth - 1, output);
    else if (item.isFile() && item.name.endsWith('.jsonl')) output.push(target);
  }
}

/** Codex'in token_count olaylarindaki resmi limit penceresini okur. */
async function detectCodexQuota(now = Date.now()): Promise<ClaudeQuotaState | null> {
  const files: string[] = [];
  try {
    await collectJsonl(path.join(HOME, '.codex', 'sessions'), 4, files);
    const candidates = await Promise.all(files.map(async (file) => {
      const info = await stat(file);
      return { file, mtime: info.mtimeMs, size: info.size };
    }));
    candidates.sort((a, b) => b.mtime - a.mtime);
    let newest: CodexLimitObservation | null = null;
    for (const candidate of candidates.slice(0, 24)) {
      const bytes = Math.min(candidate.size, 1024 * 1024);
      if (!bytes) continue;
      const handle = await open(candidate.file, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        await handle.read(buffer, 0, bytes, candidate.size - bytes);
        for (const line of buffer.toString('utf8').split('\n')) {
          const observed = parseCodexLimitLine(line, candidate.mtime);
          if (observed && (!newest || observed.eventAt > newest.eventAt)) newest = observed;
        }
      } finally {
        await handle.close();
      }
    }
    return newest?.exhausted && newest.retryAt > now ? newest : null;
  } catch {
    return null;
  }
}

export async function findClaude(): Promise<string | null> {
  await ensurePath();
  return (await which('claude')) ?? firstExisting(CLAUDE_CANDIDATES);
}

export async function findCodex(): Promise<string | null> {
  await ensurePath();
  return (await which('codex')) ?? firstExisting(CODEX_CANDIDATES);
}

export function findAgentApi(): string | null {
  return firstExisting(AGENTAPI_CANDIDATES);
}

/** Calisan bir Antigravity language server'indan cikarilan baglanti bilgisi. */
export interface AntigravitySession {
  /** ANTIGRAVITY_LS_ADDRESS icin 127.0.0.1:PORT */
  lsAddress: string;
  csrfToken: string;
  /** IDE'nin acik oldugu klasorden turetilen kimlik, or. file_Users_x_Projects_y */
  projectId: string;
  /** projectId'den geri cozulen klasor yolu (tahmini). */
  workspaceHint: string;
  pid: number;
  agentApiPath: string;
}

interface LsProcess {
  pid: number;
  csrfToken: string;
  workspaceId: string;
  /** Sunucunun geldigi uygulama: 'app' (Antigravity, projeleri tutar) ya da 'ide'. */
  kind: 'app' | 'ide';
}

/**
 * Her sunucu kendi uygulamasinin agentapi sarmalayicisiyla konusur. Antigravity
 * uygulamasinin sunucusu (Resources/bin/language_server) proje deposunu tutar;
 * IDE pencerelerinin sunuculari (language_server_macos_*) tutmaz ve konusma
 * acma istegini "projectsStore is nil" diye reddeder.
 */
function agentApiFor(kind: 'app' | 'ide'): string | null {
  return firstExisting(kind === 'app'
    ? [path.join(HOME, '.gemini/antigravity/bin/agentapi')]
    : [path.join(HOME, '.gemini/antigravity-ide/bin/agentapi')]);
}

/** `ps` ciktisindan calisan language server'lari ve argumanlarini ayiklar. */
async function listLanguageServers(): Promise<LsProcess[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('/bin/ps', ['-ax', '-o', 'pid=,command='], {
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return [];
  }

  const out: LsProcess[] = [];
  for (const line of stdout.split('\n')) {
    const isIde = line.includes('language_server_macos') && /antigravity/i.test(line);
    const isApp = line.includes('/Antigravity.app/Contents/Resources/bin/language_server');
    if (!isIde && !isApp) continue;
    // Argumanlari bosluga gore ayirmak yeterli: bizi ilgilendiren degerlerde bosluk yok.
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[0]);
    if (!Number.isFinite(pid)) continue;

    const argValue = (flag: string): string | null => {
      const i = parts.indexOf(flag);
      return i >= 0 && i + 1 < parts.length ? parts[i + 1] : null;
    };

    const csrfToken = argValue('--csrf_token');
    // IDE'de klasor acik degilse --workspace_id olmaz; ajan sunucusu yine de calisir.
    const workspaceId = argValue('--workspace_id') ?? '';
    if (!csrfToken) continue;
    out.push({ pid, csrfToken, workspaceId, kind: isApp ? 'app' : 'ide' });
  }
  return out;
}

/** Bir pid'in dinledigi TCP portlarini kucukten buyuge dondurur. */
async function listeningPorts(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', [
      '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-P', '-n',
    ]);
    const ports = new Set<number>();
    for (const line of stdout.split('\n').slice(1)) {
      const m = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** file_Users_arda_Desktop_dating_20app -> /Users/arda/Desktop/dating app */
export function workspaceIdToPath(workspaceId: string): string {
  const body = workspaceId
    .replace(/^file_/, '')
    // Antigravity boslugu `_20` olarak kodluyor. Genel hex cozme kullanma:
    // `_Desktop` gibi normal bir yol parcasi `_De` ile baslayabilir.
    .replace(/_20/g, ' ');
  return '/' + body.split('_').join('/');
}

/**
 * agentapi'yi verilen adrese karsi deneyerek dogru portu bulur.
 * Language server birden fazla port dinliyor; yalnizca biri gRPC ajan portu.
 */
async function probePort(
  agentApiPath: string,
  port: number,
  csrfToken: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      agentApiPath,
      ['get-conversation-metadata', '__konsey_probe__'],
      {
        env: {
          ...process.env,
          ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
          ANTIGRAVITY_CSRF_TOKEN: csrfToken,
        },
        timeout: 8000,
      },
    );
    // Dogru port, sahte id icin "trajectory not found" der; yanlis port baglanti hatasi verir.
    return stdout.includes('trajectory not found') || stdout.includes('"response"') && !stdout.includes('Unavailable');
  } catch (err) {
    const out = String((err as { stdout?: string }).stdout ?? '');
    return out.includes('trajectory not found');
  }
}

/**
 * Antigravity oturumunu kesfeder. `preferWorkspace` verilirse o klasore bagli
 * language server tercih edilir (worktree izolasyonu icin gerekli).
 */
export async function discoverAntigravity(
  preferWorkspace?: string,
): Promise<AntigravitySession | null> {
  return (await discoverAntigravitySessions(preferWorkspace, 1))[0] ?? null;
}

/**
 * Calisan tum Antigravity language server'lari. Her IDE penceresinin kendi
 * sunucusu vardir; klasorsuz pencerenin sunucusu proje tutmadigi icin
 * konusma acamayabilir, bu yuzden cagiran taraf siradakini deneyebilir.
 */
export async function discoverAntigravitySessions(
  preferWorkspace?: string,
  limit = Infinity,
): Promise<AntigravitySession[]> {
  const servers = await listLanguageServers();
  if (servers.length === 0) return [];

  // Once projeleri tutan Antigravity uygulamasi; IDE'lerde istenen klasore bagli
  // sunucu one, klasorsuz sunucular sona.
  const want = preferWorkspace ? path.resolve(preferWorkspace) : null;
  const rank = (srv: LsProcess) =>
    srv.kind === 'app' ? 0 : want && workspaceIdToPath(srv.workspaceId) === want ? 1 : srv.workspaceId ? 2 : 3;
  const ordered = [...servers].sort((a, b) => rank(a) - rank(b));

  const out: AntigravitySession[] = [];
  for (const srv of ordered) {
    if (out.length >= limit) break;
    const agentApiPath = agentApiFor(srv.kind);
    if (!agentApiPath) continue;
    const ports = await listeningPorts(srv.pid);
    for (const port of ports) {
      if (await probePort(agentApiPath, port, srv.csrfToken)) {
        out.push({
          lsAddress: `127.0.0.1:${port}`,
          csrfToken: srv.csrfToken,
          projectId: srv.workspaceId,
          workspaceHint: srv.workspaceId ? workspaceIdToPath(srv.workspaceId) : '',
          pid: srv.pid,
          agentApiPath,
        });
        break;
      }
    }
  }
  return out;
}

/** Bir klasoru Antigravity IDE'de acar (yeni pencere). Worktree izolasyonu icin. */
export async function openInAntigravity(dir: string): Promise<boolean> {
  const cli = [
    '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide',
    '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity',
  ].find((p) => existsSync(p));
  if (!cli) return false;
  try {
    await execFileAsync(cli, ['-n', dir], { timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

/** Ek CLI ajanlarinin durumu (Gemini CLI, Cursor Agent, ozel CLI...). */
async function cliAvailability(profiles: AgentProfile[]): Promise<AgentAvailability[]> {
  return Promise.all(profiles.filter((p) => p.agent.startsWith('cli:') && p.cli).map(async (p) => {
    const bin = await findCliBinary(p.cli!);
    return {
      agent: p.agent,
      available: !!bin,
      detail: bin
        ? L(`Bulundu: ${bin}`, `Found: ${bin}`)
        : L(`${p.label} bulunamadı. Kurulu mu?`, `${p.label} was not found. Is it installed?`),
      target: bin ?? undefined,
    };
  }));
}

export async function checkAvailability(preferWorkspace?: string, profiles: AgentProfile[] = []): Promise<AgentAvailability[]> {
  await ensurePath();
  const [claude, codex, claudeQuota, codexQuota, clis] = await Promise.all([
    findClaude(),
    findCodex(),
    detectClaudeQuota(),
    detectCodexQuota(),
    cliAvailability(profiles),
  ]);
  // Antigravity'nin yerel ajan sunucusuna yalnizca macOS'ta baglanilabiliyor.
  const ag = IS_MAC ? await discoverAntigravity(preferWorkspace) : null;
  const agInstalled = IS_MAC
    ? ['/Applications/Antigravity.app', '/Applications/Antigravity IDE.app'].find((p) => existsSync(p))
    : undefined;

  return [
    {
      agent: 'claude',
      available: !!claude && !claudeQuota,
      detail: claudeQuota
        ? L(`Token limiti doldu · ${claudeQuota.retryHint}`, `Token limit reached · ${claudeQuota.retryHint}`)
        : claude
          ? L(`CLI bulundu: ${claude}`, `CLI found: ${claude}`)
          : L('Claude Code kurulu değil.', 'Claude Code is not installed.'),
      target: claude ?? undefined,
      failureKind: claudeQuota ? 'quota' : undefined,
      retryAt: claudeQuota?.retryAt,
      retryHint: claudeQuota?.retryHint,
    },
    {
      agent: 'codex',
      available: !!codex && !codexQuota,
      detail: codexQuota
        ? L(`Token limiti doldu · ${codexQuota.retryHint}`, `Token limit reached · ${codexQuota.retryHint}`)
        : codex
          ? L(`CLI bulundu: ${codex}`, `CLI found: ${codex}`)
          : L('Codex CLI kurulu değil.', 'Codex CLI is not installed.'),
      target: codex ?? undefined,
      failureKind: codexQuota ? 'quota' : undefined,
      retryAt: codexQuota?.retryAt,
      retryHint: codexQuota?.retryHint,
    },
    {
      agent: 'antigravity',
      // Uygulama kapaliysa Konsey gorev aninda arka planda acar; kurulu olmasi yeter.
      available: !!ag || (!!agInstalled && !!findAgentApi()),
      detail: !IS_MAC
        ? L('Antigravity şimdilik yalnızca macOS’ta destekleniyor.', 'Antigravity is currently supported on macOS only.')
        : ag
          ? ag.agentApiPath.includes('antigravity-ide')
            ? L('IDE sunucusu açık · görevde Antigravity uygulaması da açılır', 'IDE server running · the Antigravity app opens during tasks')
            : L('Antigravity hazır', 'Antigravity ready')
          : agInstalled && findAgentApi()
            ? L('Kapalı · gerektiğinde Konsey arka planda açar', 'Closed · Konsey opens it in the background when needed')
            : L('Antigravity kurulu değil.', 'Antigravity is not installed.'),
      target: ag?.lsAddress,
    },
    ...clis,
  ];
}
