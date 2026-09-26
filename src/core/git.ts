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
import { rmdir } from 'node:fs/promises';
import * as path from 'node:path';
import { L } from '../shared/i18n';
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
  const safeAgent = agent.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `konsey/${runId}/${safeAgent || 'agent'}`;
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
  const safeAgent = agent.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const dir = path.join(root, `${runId}-${safeAgent || 'agent'}`);
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
  if (ws.isMainTree) return { committed: false, commit: null, error: L('Ana ağaç; commit atlandı.', 'Main tree; commit skipped.') };

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
    return { integrationBranch, outcomes, error: L(`Entegrasyon dalı oluşturulamadı: ${create.stderr}`, `Could not create the integration branch: ${create.stderr}`) };
  }

  // Birlestirme, ana calisma agacini bozmamak icin ayri bir worktree'de yapilir.
  const intDir = path.join(worktreeRoot(projectDir), `${runId}-integration`);
  const add = await git(projectDir, ['worktree', 'add', intDir, integrationBranch]);
  if (!add.ok) {
    return { integrationBranch, outcomes, error: L(`Entegrasyon worktree'si açılamadı: ${add.stderr}`, `Could not open the integration worktree: ${add.stderr}`) };
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
  // Bos kalan kardes klasoru de kaldir; masaustunde iz birakmasin.
  await rmdir(worktreeRoot(projectDir)).catch(() => {});
}

/** Bir dalin base'e gore ozet diff'i; inceleme turuna girdi olur. */
export async function diffSummary(dir: string, baseCommit: string): Promise<string> {
  const stat = await git(dir, ['diff', '--stat', `${baseCommit}..HEAD`]);
  return stat.ok ? stat.stdout.trim() : '';
}

/** Kullanicinin git kimligi yoksa commit'ler bu kimlikle atilir. */
const IDENTITY = ['-c', 'user.name=Konsey', '-c', 'user.email=konsey@localhost'];

/**
 * Duz bir klasoru Konsey'e hazirlar: git deposu degilse `git init`, hic commit
 * yoksa mevcut dosyalarla (bos olsa bile) ilk commit. Ajanlar izole worktree'lerde
 * calisabilsin diye gereklidir; kullanici icin tek tik ya da otomatik.
 */
export async function prepareRepo(dir: string): Promise<{ ok: boolean; created: boolean; message: string }> {
  let created = false;
  if (!(await isGitRepo(dir))) {
    const init = await git(dir, ['init', '-b', 'main']);
    if (!init.ok) {
      const legacy = await git(dir, ['init']);
      if (!legacy.ok) return { ok: false, created, message: L(`git init başarısız: ${legacy.stderr.trim()}`, `git init failed: ${legacy.stderr.trim()}`) };
    }
    created = true;
  }
  if (!(await headCommit(dir))) {
    await git(dir, ['add', '-A']);
    const commit = await git(dir, [
      ...IDENTITY, 'commit', '--allow-empty', '--no-verify', '-m', 'Konsey: başlangıç',
    ]);
    if (!commit.ok) return { ok: false, created, message: L(`İlk commit atılamadı: ${commit.stderr.trim()}`, `Initial commit could not be created: ${commit.stderr.trim()}`) };
    created = true;
  }
  return { ok: true, created, message: created ? L('Klasör git deposu olarak hazırlandı.', 'Folder was set up as a git repository.') : L('Depo hazır.', 'Repository is ready.') };
}

/**
 * Entegrasyon dalini kullanicinin calisma agacina uygular. Taban degismediyse
 * hizli ileri sarma yapilir; degistiyse normal birlestirme denenir, catisma
 * cikarsa geri alinir ve hic bir sey bozulmaz.
 */
export async function applyIntegration(
  projectDir: string,
  integrationBranch: string,
): Promise<{ ok: boolean; message: string }> {
  const exists = await git(projectDir, ['rev-parse', '--verify', integrationBranch]);
  if (!exists.ok) return { ok: false, message: L('Entegrasyon dalı bulunamadı.', 'Integration branch not found.') };

  const ff = await git(projectDir, [...IDENTITY, 'merge', '--ff-only', integrationBranch]);
  if (ff.ok) return { ok: true, message: L('Değişiklikler proje klasörüne uygulandı.', 'Changes were applied to the project folder.') };

  const merge = await git(projectDir, [
    ...IDENTITY, 'merge', '--no-ff', '--no-verify', '-m', `Konsey: ${integrationBranch} uygulandı`, integrationBranch,
  ]);
  if (merge.ok) return { ok: true, message: L('Değişiklikler mevcut çalışmanla birleştirilerek uygulandı.', 'Changes were merged and applied into your current work.') };

  await git(projectDir, ['merge', '--abort']);
  const reason = `${merge.stderr}\n${ff.stderr}`;
  if (/would be overwritten|local changes/i.test(reason)) {
    return { ok: false, message: L('Klasörde kaydedilmemiş değişiklikler aynı dosyalara dokunuyor. Önce onları commit et ya da geri al.', 'Uncommitted changes in the folder touch the same files. Commit or revert them first.') };
  }
  return { ok: false, message: L(`Uygulanamadı: ${reason.trim().split('\n')[0] || 'birleştirme çatışması'}`, `Could not apply: ${reason.trim().split('\n')[0] || 'merge conflict'}`) };
}

/** Degisen dosya listesi (base..dal). */
export async function changedFiles(dir: string, baseCommit: string, ref = 'HEAD'): Promise<string[]> {
  const r = await git(dir, ['diff', '--name-only', `${baseCommit}..${ref}`]);
  return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Inceleyicinin gercek kodu gorebilmesi icin birlesik fark (patch). Yalnizca metin
 * uretebilen saglayicilar dosya okuyamaz; bu fark onlarin tek kanitidir.
 */
export async function diffPatch(dir: string, baseCommit: string, maxChars = 40_000): Promise<string> {
  const patch = await git(dir, ['diff', '--no-color', '--unified=3', `${baseCommit}..HEAD`]);
  if (!patch.ok) return '';
  const text = patch.stdout.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[fark ${text.length - maxChars} karakter kirpildi]` : text;
}
