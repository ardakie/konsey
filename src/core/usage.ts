/**
 * Kullanim ve limit takibi: ~/.konsey/usage.json
 *
 * Iki ayri bilgi tutulur:
 *   1. Konsey'in kendi sayaci: hangi ajan bugun/toplamda kac cagri ve token harcadi.
 *   2. Hesap limit pencereleri: Claude CLI'nin rate_limit_event'i ve Codex'in
 *      oturum kayitlarindaki rate_limits alanindan okunan 5 saatlik/haftalik yuzdeler.
 *
 * Kullanici her ajan icin "limitin en fazla %X'ini kullan" diyebilir. Olculen
 * kullanim bu payi gectiginde ajan kilitlenir; Konsey isi baska ajana verir.
 */
import { open, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { L } from '../shared/i18n';
import type {
  AgentId,
  AgentProfile,
  AgentQuota,
  AgentUsageTotals,
  ProviderConfig,
  UsageWindow,
} from '../shared/types';

const DIR = process.env.KONSEY_HOME ?? path.join(os.homedir(), '.konsey');
const FILE = path.join(DIR, 'usage.json');

/** Limiti bilinmeyen saglayicilar icin varsayilan gunluk butce. */
export const DEFAULT_PROVIDER_DAILY_TOKENS = 2_000_000;
/** Antigravity limit bildirmez; Konsey kendi tur sayisini gunluk butceye oranlar. */
export const DEFAULT_ANTIGRAVITY_DAILY_TURNS = 40;
export const DEFAULT_CLI_DAILY_TURNS = 60;

interface Counter {
  calls: number;
  tokens: number;
  costUsd: number;
  durationMs: number;
}

interface UsageFile {
  days: Record<string, Record<string, Counter>>;
  total: Record<string, Counter>;
  limits: Record<string, { windows: UsageWindow[]; observedAt: number }>;
}

const empty = (): Counter => ({ calls: 0, tokens: 0, costUsd: 0, durationMs: 0 });

let cache: UsageFile | null = null;
let writing: Promise<void> = Promise.resolve();

export function dayKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function load(): Promise<UsageFile> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8')) as Partial<UsageFile>;
    cache = { days: parsed.days ?? {}, total: parsed.total ?? {}, limits: parsed.limits ?? {} };
  } catch {
    cache = { days: {}, total: {}, limits: {} };
  }
  return cache;
}

function persist(data: UsageFile): Promise<void> {
  // Son 14 gun yeterli; dosya sonsuz buyumesin.
  const keep = Object.keys(data.days).sort().slice(-14);
  data.days = Object.fromEntries(keep.map((k) => [k, data.days[k]]));
  writing = writing
    .then(async () => {
      await mkdir(DIR, { recursive: true });
      await writeFile(FILE, JSON.stringify(data, null, 2), 'utf8');
    })
    .catch(() => {});
  return writing;
}

export async function recordUsage(
  agent: AgentId,
  call: { tokens?: number; costUsd?: number; durationMs?: number },
): Promise<void> {
  const data = await load();
  const day = (data.days[dayKey()] ??= {});
  for (const bucket of [(day[agent] ??= empty()), (data.total[agent] ??= empty())]) {
    bucket.calls += 1;
    bucket.tokens += call.tokens ?? 0;
    bucket.costUsd += call.costUsd ?? 0;
    bucket.durationMs += call.durationMs ?? 0;
  }
  await persist(data);
}

export async function recordLimits(agent: AgentId, windows: UsageWindow[]): Promise<void> {
  if (!windows.length) return;
  const data = await load();
  data.limits[agent] = { windows, observedAt: Date.now() };
  await persist(data);
}

export async function usageTotals(agents: AgentId[]): Promise<AgentUsageTotals[]> {
  const data = await load();
  const today = data.days[dayKey()] ?? {};
  return agents.map((agent) => ({
    agent,
    today: { ...empty(), ...today[agent] },
    total: { ...empty(), ...data.total[agent] },
  }));
}

/** Claude stream-json'daki rate_limit_event'i pencere listesine cevirir. */
export function claudeWindowsFromEvent(info: any): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const unified = info?.unifiedWindows ?? {};
  const labels: Record<string, { key: UsageWindow['key']; label: string }> = {
    five_hour: { key: 'five_hour', label: '5 saatlik' },
    seven_day: { key: 'seven_day', label: 'Haftalık' },
  };
  for (const [name, value] of Object.entries(unified) as [string, any][]) {
    const meta = labels[name];
    if (!meta || typeof value?.utilization !== 'number') continue;
    windows.push({
      key: meta.key,
      label: meta.label,
      usedPercent: Math.round(value.utilization * 1000) / 10,
      resetsAt: typeof value.resetsAt === 'number' ? value.resetsAt * 1000 : undefined,
    });
  }
  // Eski surumler yalnizca durum bildirir: reddedildiyse pencere doludur.
  if (!windows.length && info?.status === 'rejected') {
    const meta = labels[info.rateLimitType] ?? labels.five_hour;
    windows.push({
      key: meta.key,
      label: meta.label,
      usedPercent: 100,
      resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : undefined,
    });
  }
  return windows;
}

/** Codex'in oturum kayitlarindaki en guncel rate_limits gozlemini okur. */
export async function readCodexWindows(): Promise<{ windows: UsageWindow[]; observedAt: number } | null> {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth < 0) return;
    for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(dir, item.name);
      if (item.isDirectory()) await walk(target, depth - 1);
      else if (item.name.endsWith('.jsonl')) files.push(target);
    }
  };
  await walk(root, 4);
  const withTime = await Promise.all(
    files.map(async (file) => ({ file, info: await stat(file).catch(() => null) })),
  );
  const recent = withTime
    .filter((f): f is { file: string; info: NonNullable<typeof f.info> } => !!f.info)
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
    .slice(0, 12);

  let best: { windows: UsageWindow[]; observedAt: number } | null = null;
  for (const { file, info } of recent) {
    const bytes = Math.min(info.size, 1024 * 1024);
    if (!bytes) continue;
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      await handle.read(buffer, 0, bytes, info.size - bytes);
      for (const line of buffer.toString('utf8').split('\n')) {
        if (!line.includes('"rate_limits"')) continue;
        try {
          const entry = JSON.parse(line);
          const limits = entry.payload?.rate_limits ?? entry.rate_limits;
          if (!limits || (limits.limit_id && limits.limit_id !== 'codex')) continue;
          const observedAt = Date.parse(entry.timestamp) || info.mtimeMs;
          if (best && best.observedAt >= observedAt) continue;
          const windows: UsageWindow[] = [];
          if (limits.primary) {
            windows.push({
              key: 'five_hour',
              label: '5 saatlik',
              usedPercent: Number(limits.primary.used_percent ?? 0),
              resetsAt: limits.primary.resets_at ? Number(limits.primary.resets_at) * 1000 : undefined,
            });
          }
          if (limits.secondary) {
            windows.push({
              key: 'seven_day',
              label: 'Haftalık',
              usedPercent: Number(limits.secondary.used_percent ?? 0),
              resetsAt: limits.secondary.resets_at ? Number(limits.secondary.resets_at) * 1000 : undefined,
            });
          }
          if (windows.length) best = { windows, observedAt };
        } catch {
          /* yarim satir */
        }
      }
    } finally {
      await handle.close();
    }
  }
  return best;
}

/** Sifirlanma zamani gecmis pencere artik bos sayilir. */
function freshen(windows: UsageWindow[], now: number): UsageWindow[] {
  return windows.map((w) => (w.resetsAt && w.resetsAt <= now ? { ...w, usedPercent: 0 } : w));
}

export function clampCap(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 100;
}

/** Kilit: kullanim, izin verilen payi gectiyse. Pay %100 ise yalnizca dolu pencere kilitler. */
export function buildQuota(
  agent: AgentId,
  windows: UsageWindow[],
  capPercent: number,
  source: AgentQuota['source'],
  observedAt?: number,
): AgentQuota {
  const used = windows.length ? Math.max(...windows.map((w) => w.usedPercent)) : null;
  const blocking = windows.filter((w) => w.usedPercent >= capPercent);
  const capped = used !== null && blocking.length > 0;
  const unlocksAt = capped
    ? Math.max(...blocking.map((w) => w.resetsAt ?? 0)) || undefined
    : undefined;
  return { agent, windows, usedPercent: used, capPercent, capped, source, observedAt, unlocksAt };
}

/** Butun ajanlarin limit durumunu hesaplar. */
export async function computeQuotas(
  profiles: AgentProfile[],
  providers: ProviderConfig[],
  now = Date.now(),
): Promise<AgentQuota[]> {
  const data = await load();
  const today = data.days[dayKey(now)] ?? {};
  const quotas: AgentQuota[] = [];

  for (const profile of profiles) {
    const cap = clampCap(profile.usageCapPercent ?? 100);
    if (profile.agent === 'claude') {
      const observed = data.limits.claude;
      quotas.push(observed
        ? buildQuota('claude', freshen(observed.windows, now), cap, 'cli', observed.observedAt)
        : buildQuota('claude', [], cap, 'unknown'));
    } else if (profile.agent === 'codex') {
      const fromLog = await readCodexWindows();
      const stored = data.limits.codex;
      const observed = fromLog && (!stored || fromLog.observedAt >= stored.observedAt) ? fromLog : stored;
      quotas.push(observed
        ? buildQuota('codex', freshen(observed.windows, now), cap, 'log', observed.observedAt)
        : buildQuota('codex', [], cap, 'unknown'));
    } else if (profile.agent === 'antigravity') {
      const budget = Math.max(1, profile.dailyTurnBudget ?? DEFAULT_ANTIGRAVITY_DAILY_TURNS);
      const calls = today.antigravity?.calls ?? 0;
      quotas.push(buildQuota('antigravity', [dailyWindow(calls / budget, now)], cap, 'local', now));
    } else if (profile.agent.startsWith('cli:')) {
      // Ek CLI'lar limit bildirmez; Konsey kendi gunluk tur butcesini sayar.
      const budget = Math.max(1, profile.dailyTurnBudget ?? DEFAULT_CLI_DAILY_TURNS);
      const calls = today[profile.agent]?.calls ?? 0;
      quotas.push(buildQuota(profile.agent, [dailyWindow(calls / budget, now)], cap, 'local', now));
    }
  }

  for (const provider of providers) {
    const agent = `provider:${provider.slug}` as AgentId;
    const budget = Math.max(1, provider.dailyTokenBudget ?? DEFAULT_PROVIDER_DAILY_TOKENS);
    const tokens = today[agent]?.tokens ?? 0;
    quotas.push(buildQuota(
      agent,
      [dailyWindow(tokens / budget, now)],
      clampCap(provider.usageCapPercent ?? 100),
      'local',
      now,
    ));
  }
  return quotas;
}

function dailyWindow(ratio: number, now: number): UsageWindow {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return {
    key: 'daily',
    label: L('Günlük bütçe', 'Daily budget'),
    usedPercent: Math.round(Math.min(1, ratio) * 1000) / 10,
    resetsAt: midnight.getTime(),
  };
}

/** Testler icin: bellekteki onbellegi sifirlar. */
export function __resetUsageCache(value?: UsageFile): void {
  cache = value ?? null;
}
