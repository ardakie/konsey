/**
 * Calisma gecmisi: ~/.konsey/runs/<id>.json
 *
 * Kenar cubugundaki gorev listesi buradan beslenir; eski bir gorev acildiginda
 * plani, sonuclari ve ajanlarin etkinlik satirlari yeniden gosterilir.
 */
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunRecord } from '../shared/types';

const DIR = path.join(process.env.KONSEY_HOME ?? path.join(os.homedir(), '.konsey'), 'runs');
const KEEP = 200;

export interface ActivityLine {
  agent: string;
  text: string;
  tone: 'say' | 'tool' | 'think' | 'warn' | 'error';
  at: number;
  phase?: string;
}

export interface StoredRun {
  record: RunRecord;
  activity: ActivityLine[];
}

export interface RunSummary {
  id: string;
  projectDir: string;
  prompt: string;
  phase: RunRecord['phase'];
  strategy: RunRecord['strategy'];
  startedAt: number;
  endedAt?: number;
  applied?: boolean;
}

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9-]/g, '');

export async function saveRun(stored: StoredRun): Promise<void> {
  await mkdir(DIR, { recursive: true });
  // Etkinlik gecmisi sinirli tutulur; ham cikti zaten kaydedilmez.
  const activity = stored.activity.slice(-600);
  await writeFile(path.join(DIR, `${safeId(stored.record.id)}.json`), JSON.stringify({ ...stored, activity }), 'utf8');
}

export async function loadRun(id: string): Promise<StoredRun | null> {
  try {
    return JSON.parse(await readFile(path.join(DIR, `${safeId(id)}.json`), 'utf8')) as StoredRun;
  } catch {
    return null;
  }
}

export async function deleteRun(id: string): Promise<void> {
  await rm(path.join(DIR, `${safeId(id)}.json`), { force: true });
}

export async function listRuns(projectDir?: string | null): Promise<RunSummary[]> {
  let files: string[] = [];
  try {
    files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const file of files) {
    try {
      const { record } = JSON.parse(await readFile(path.join(DIR, file), 'utf8')) as StoredRun;
      if (projectDir && path.resolve(record.projectDir) !== path.resolve(projectDir)) continue;
      out.push({
        id: record.id,
        projectDir: record.projectDir,
        prompt: record.prompt,
        phase: record.phase,
        strategy: record.strategy,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        applied: record.applied?.ok,
      });
    } catch {
      /* bozuk kayit atlanir */
    }
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  if (out.length > KEEP && !projectDir) {
    for (const old of out.slice(KEEP)) await deleteRun(old.id);
  }
  return out.slice(0, KEEP);
}
