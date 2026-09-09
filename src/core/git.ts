/**
 * Git islemleri: her ajana izole bir worktree acar, sonunda hepsini
 * tek bir entegrasyon dalinda birlestirir.
 *
 * Izolasyonun sebebi: uc ajan ayni anda ayni dosyaya yazarsa birbirinin
 * degisikligini ezer. Ayri worktree'lerde calisip sonunda merge etmek,
 * catismalari gorunur ve cozulebilir kilar.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { AgentId, AgentWorkspace, MergeOutcome } from '../shared/types';

const execFileAsync = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

export async function currentBranch(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.stdout.trim() : null;
}

export async function headCommit(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', 'HEAD']);
  return r.ok ? r.stdout.trim() : null;
}

export async function hasUncommittedChanges(dir: string): Promise<boolean> {
  const r = await git(dir, ['status', '--porcelain']);
  return r.ok && r.stdout.trim().length > 0;
}

/** Worktree'ler proje disina, kardes bir .konsey-worktrees klasorune acilir. */
export function worktreeRoot(projectDir: string): string {
  return path.join(path.dirname(projectDir), `.konsey-worktrees-${path.basename(projectDir)}`);
}

export function branchName(runId: string, agent: AgentId): string {
  return `konsey/${runId}/${agent}`;
}

/**
 * Ajan icin izole worktree olusturur. Basarisiz olursa (or. git repo degil)
 * ana calisma agacina duser; bu durumda esitlik korunmaz ve seri calisilmalidir.
 */
export async function createWorkspace(
  projectDir: string,
  runId: string,
  agent: AgentId,
  baseCommit: string,
): Promise<AgentWorkspace> {
  const root = worktreeRoot(projectDir);
  const dir = path.join(root, `${runId}-${agent}`);
  const branch = branchName(runId, agent);

  const r = await git(projectDir, ['worktree', 'add', '-b', branch, dir, baseCommit]);
  if (!r.ok) {
    return { agent, dir: projectDir, branch: null, isMainTree: true };
  }
  return { agent, dir, branch, isMainTree: false };
}

/** Ajanin worktree'de biraktigi degisiklikleri tek bir commit'e alir. */
export async function commitWorkspace(
  ws: AgentWorkspace,
  message: string,
): Promise<{ committed: boolean; commit: string | null; error?: string }> {
  if (ws.isMainTree) return { committed: false, commit: null, error: 'Ana agac; commit atlandi.' };

  const add = await git(ws.dir, ['add', '-A']);
  if (!add.ok) return { committed: false, commit: null, error: add.stderr };

  const status = await git(ws.dir, ['status', '--porcelain']);
  if (status.stdout.trim().length === 0) return { committed: false, commit: null };

  const commit = await git(ws.dir, [
    'commit',
    '-m', message,
    '--author', 'Konsey <konsey@localhost>',
    '--no-verify',
  ]);
  if (!commit.ok) return { committed: false, commit: null, error: commit.stderr };

  const head = await headCommit(ws.dir);
  return { committed: true, commit: head };
}

/** Catisan dosyalarin listesini dondurur. */
async function conflictFiles(dir: string): Promise<string[]> {
  const r = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
  return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Entegrasyon dalini olusturup her ajanin dalini sirayla birlestirir.
 * Catisma cikarsa merge geri alinir ve catisan dosyalar rapor edilir;
 * boylece kismi/bozuk bir agac birakilmaz.
 */
export async function mergeAll(
  projectDir: string,
  runId: string,
  baseCommit: string,
  workspaces: AgentWorkspace[],
): Promise<{ integrationBranch: string; outcomes: MergeOutcome[]; error?: string }> {
  const integrationBranch = `konsey/${runId}/integration`;
  const outcomes: MergeOutcome[] = [];

  const create = await git(projectDir, ['branch', integrationBranch, baseCommit]);
  if (!create.ok) {
    return { integrationBranch, outcomes, error: `Entegrasyon dali olusturulamadi: ${create.stderr}` };
  }

  // Birlestirme, ana calisma agacini bozmamak icin ayri bir worktree'de yapilir.
  const intDir = path.join(worktreeRoot(projectDir), `${runId}-integration`);
  const add = await git(projectDir, ['worktree', 'add', intDir, integrationBranch]);
  if (!add.ok) {
    return { integrationBranch, outcomes, error: `Entegrasyon worktree'si acilamadi: ${add.stderr}` };
  }

  for (const ws of workspaces) {
    if (!ws.branch || ws.isMainTree) {
      outcomes.push({ agent: ws.agent, branch: ws.branch, status: 'skipped', conflictFiles: [] });
      continue;
    }

    const ahead = await git(intDir, ['rev-list', '--count', `${baseCommit}..${ws.branch}`]);
    if (ahead.ok && ahead.stdout.trim() === '0') {
      outcomes.push({ agent: ws.agent, branch: ws.branch, status: 'empty', conflictFiles: [] });
      continue;
    }

    const merge = await git(intDir, [
      'merge', '--no-ff', ws.branch,
      '-m', `Konsey: ${ws.agent} calismasini birlestir`,
    ]);

    if (merge.ok) {
      outcomes.push({
        agent: ws.agent,
        branch: ws.branch,
        status: 'merged',
        conflictFiles: [],
        commit: (await headCommit(intDir)) ?? undefined,
      });
      continue;
    }

    const conflicts = await conflictFiles(intDir);
    await git(intDir, ['merge', '--abort']);
    outcomes.push({
      agent: ws.agent,
      branch: ws.branch,
      status: 'conflict',
      conflictFiles: conflicts,
      message: merge.stderr.slice(0, 800),
    });
  }

  return { integrationBranch, outcomes };
}

export function integrationDir(projectDir: string, runId: string): string {
  return path.join(worktreeRoot(projectDir), `${runId}-integration`);
}

/** Calisma sonrasi worktree'leri kaldirir. Dallar incelenebilsin diye durur. */
export async function cleanupWorktrees(
  projectDir: string,
  workspaces: AgentWorkspace[],
  runId: string,
): Promise<void> {
  for (const ws of workspaces) {
    if (ws.isMainTree || !existsSync(ws.dir)) continue;
    await git(projectDir, ['worktree', 'remove', '--force', ws.dir]);
  }
  const intDir = integrationDir(projectDir, runId);
  if (existsSync(intDir)) {
    await git(projectDir, ['worktree', 'remove', '--force', intDir]);
  }
  await git(projectDir, ['worktree', 'prune']);
}

/** Bir dalin base'e gore ozet diff'i; inceleme turuna girdi olur. */
export async function diffSummary(dir: string, baseCommit: string): Promise<string> {
  const stat = await git(dir, ['diff', '--stat', `${baseCommit}..HEAD`]);
  return stat.ok ? stat.stdout.trim() : '';
}
