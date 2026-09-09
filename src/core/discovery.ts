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
import type { AgentAvailability } from '../shared/types';

const execFileAsync = promisify(execFile);

const HOME = os.homedir();

/** Codex CLI, ChatGPT.app paketinin icine gomulu geliyor. */
const CODEX_CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  path.join(HOME, '.codex/bin/codex'),
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
];

const CLAUDE_CANDIDATES = [
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  path.join(HOME, '.claude/local/claude'),
  path.join(HOME, '.local/bin/claude'),
];

/** agentapi, language server'a "agentapi" alt komutuyla giden ince bir sh sarmalayici. */
const AGENTAPI_CANDIDATES = [
  path.join(HOME, '.gemini/antigravity-ide/bin/agentapi'),
  path.join(HOME, '.gemini/antigravity/bin/agentapi'),
];

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

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
    const reset = new Date(retryAt).toLocaleString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    return { retryAt, retryHint: `${reset} tarihinde yenilenir`, eventAt };
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
      ? new Date(retryAt).toLocaleString('tr-TR', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      : 'bilinmeyen zamanda';
    return { exhausted, retryAt, retryHint: `${reset} tarihinde yenilenir`, eventAt };
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

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/which', [bin]);
    const p = stdout.trim();
    return p.length > 0 && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

export async function findClaude(): Promise<string | null> {
  return firstExisting(CLAUDE_CANDIDATES) ?? (await which('claude'));
}

export async function findCodex(): Promise<string | null> {
  return firstExisting(CODEX_CANDIDATES) ?? (await which('codex'));
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
    if (!line.includes('language_server_macos') || !line.includes('antigravity')) continue;
    // Argumanlari bosluga gore ayirmak yeterli: bizi ilgilendiren degerlerde bosluk yok.
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[0]);
    if (!Number.isFinite(pid)) continue;

    const argValue = (flag: string): string | null => {
      const i = parts.indexOf(flag);
      return i >= 0 && i + 1 < parts.length ? parts[i + 1] : null;
    };

    const csrfToken = argValue('--csrf_token');
    const workspaceId = argValue('--workspace_id');
    // --enable_lsp tasiyan surec, IDE'ye bagli asil ajan sunucusudur.
    if (!csrfToken || !workspaceId) continue;
    out.push({ pid, csrfToken, workspaceId });
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

/** file_Users_ardakie_Documents_Obsidian -> /Users/ardakie/Documents/Obsidian */
function workspaceIdToPath(workspaceId: string): string {
  const body = workspaceId.replace(/^file_/, '');
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
  const agentApiPath = findAgentApi();
  if (!agentApiPath) return null;

  const servers = await listLanguageServers();
  if (servers.length === 0) return null;

  // Istenen klasore bagli sunucu varsa onu one al.
  const ordered = [...servers].sort((a, b) => {
    if (!preferWorkspace) return 0;
    const want = path.resolve(preferWorkspace);
    const aMatch = workspaceIdToPath(a.workspaceId) === want ? 0 : 1;
    const bMatch = workspaceIdToPath(b.workspaceId) === want ? 0 : 1;
    return aMatch - bMatch;
  });

  for (const srv of ordered) {
    const ports = await listeningPorts(srv.pid);
    for (const port of ports) {
      if (await probePort(agentApiPath, port, srv.csrfToken)) {
        return {
          lsAddress: `127.0.0.1:${port}`,
          csrfToken: srv.csrfToken,
          projectId: srv.workspaceId,
          workspaceHint: workspaceIdToPath(srv.workspaceId),
          pid: srv.pid,
          agentApiPath,
        };
      }
    }
  }
  return null;
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

export async function checkAvailability(preferWorkspace?: string): Promise<AgentAvailability[]> {
  const [claude, codex, claudeQuota, codexQuota] = await Promise.all([
    findClaude(),
    findCodex(),
    detectClaudeQuota(),
    detectCodexQuota(),
  ]);
  const ag = await discoverAntigravity(preferWorkspace);

  return [
    {
      agent: 'claude',
      available: !!claude && !claudeQuota,
      detail: claudeQuota
        ? `Token limiti doldu · ${claudeQuota.retryHint}`
        : claude
          ? `CLI bulundu: ${claude}`
          : 'claude CLI bulunamadi. Claude Code kurulu mu?',
      target: claude ?? undefined,
      failureKind: claudeQuota ? 'quota' : undefined,
      retryAt: claudeQuota?.retryAt,
      retryHint: claudeQuota?.retryHint,
    },
    {
      agent: 'codex',
      available: !!codex && !codexQuota,
      detail: codexQuota
        ? `Token limiti doldu · ${codexQuota.retryHint}`
        : codex
          ? `CLI bulundu: ${codex}`
          : 'codex CLI bulunamadi. ChatGPT.app kurulu mu? (Resources/codex)',
      target: codex ?? undefined,
      failureKind: codexQuota ? 'quota' : undefined,
      retryAt: codexQuota?.retryAt,
      retryHint: codexQuota?.retryHint,
    },
    {
      agent: 'antigravity',
      available: !!ag,
      detail: ag
        ? preferWorkspace && path.resolve(ag.workspaceHint) === path.resolve(preferWorkspace)
          ? `agentapi hazır · seçili proje bağlı: ${ag.workspaceHint}`
          : preferWorkspace
            ? `agentapi hazır · IDE'nin açık alanı: ${ag.workspaceHint}; çalışma başlayınca seçili proje açılır.`
            : `agentapi hazır · IDE'nin açık alanı: ${ag.workspaceHint}`
        : findAgentApi()
          ? 'agentapi var ama calisan language server yok. Antigravity IDE acik olmali.'
          : 'agentapi bulunamadi (~/.gemini/antigravity-ide/bin/agentapi).',
      target: ag?.lsAddress,
    },
  ];
}
