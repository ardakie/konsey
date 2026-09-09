/**
 * Konsey orkestratoru.
 *
 * Akis:
 *   1. PLAN      — bir ajan istegi bagimsiz gorevlere boler
 *   2. CLAIM     — her ajan hangi gorevleri ustlendigini bildirir
 *   3. ARBITRATE — cakisan talepleri hakem cozer, her gorev tek sahibe baglanir
 *   4. EXECUTE   — ajanlar kendi git worktree'lerinde PARALEL calisir
 *   5. MERGE     — dallar tek entegrasyon dalinda birlestirilir
 *   6. REVIEW    — calismaya katilmayan (ya da en uygun) bir ajan sonucu denetler
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';

import { runAgent, agentLabel } from './adapters';
import { remedyFor, retryHintToTimestamp } from './adapters/failures';
import { EventBus } from './bus';
import { extractJson } from './json';
import {
  createWorkspace,
  commitWorkspace,
  currentBranch,
  diffSummary,
  headCommit,
  integrationDir,
  isGitRepo,
  mergeAll,
} from './git';
import {
  DEFAULT_PROFILES,
  arbitrationPrompt,
  claimPrompt,
  executionPrompt,
  plannerPrompt,
  reviewPrompt,
} from './prompts';
import type {
  AgentId,
  AgentProfile,
  AgentRunResult,
  ClaimResponse,
  ProviderConfig,
  RunPhase,
  RunRecord,
  Task,
  TaskComplexity,
  ModelSelection,
} from '../shared/types';

export interface OrchestratorOptions {
  projectDir: string;
  prompt: string;
  profiles?: AgentProfile[];
  /** Planlama, hakemlik ve inceleme gibi koordinasyon turlarini yapan ajan. */
  coordinator?: AgentId;
  /** Birlesik sonucu denetleyen ajan. Belirtilmezse en az is yapan secilir. */
  reviewer?: AgentId;
  /** Gorev yurutme icin ajan basina zaman siniri. */
  executeTimeoutMs?: number;
  /** Koordinasyon turlari icin zaman siniri. */
  coordinateTimeoutMs?: number;
  /** true ise merge sonrasi worktree'ler silinmez (inceleme icin). */
  keepWorktrees?: boolean;
  /** Kullanicinin kendi API anahtariyla ekledigi saglayicilar. */
  providers?: ProviderConfig[];
  signal?: AbortSignal;
}

const DEFAULTS = {
  executeTimeoutMs: 25 * 60 * 1000,
  coordinateTimeoutMs: 8 * 60 * 1000,
};

/** Yeni Orchestrator nesneleri arasinda (uygulama acik kaldigi surece) kota uykusunu korur. */
const COOLDOWNS = new Map<AgentId, { reason: string; retryAt?: number; retryHint?: string }>();

export class Orchestrator {
  readonly bus = new EventBus();
  private run: RunRecord | null = null;
  private providers: ProviderConfig[] = [];
  /** Kota/oturum nedeniyle bu calisma boyunca devre disi kalan ajanlar. */
  private downed = new Map<AgentId, { reason: string; retryAt?: number; retryHint?: string }>();

  private log(agent: AgentId | 'orchestrator', text: string, level: 'info' | 'warn' | 'error' = 'info') {
    this.bus.emit({
      type: 'log',
      runId: this.run?.id ?? '-',
      agent,
      level,
      text,
      at: Date.now(),
    });
  }

  private setPhase(phase: RunPhase) {
    if (!this.run) return;
    this.run.phase = phase;
    this.bus.emit({ type: 'run:phase', runId: this.run.id, phase });
    this.bus.emit({ type: 'run:updated', run: structuredClone(this.run) });
  }

  private touch() {
    if (this.run) this.bus.emit({ type: 'run:updated', run: structuredClone(this.run) });
  }

  /** Ajana tek bir tur calistirir ve ciktisini arayuze akitir. */
  private async ask(
    agent: AgentId,
    prompt: string,
    opts: { cwd: string; allowWrite: boolean; timeoutMs: number; signal?: AbortSignal; selection?: ModelSelection },
  ): Promise<AgentRunResult> {
    const runId = this.run?.id ?? '-';
    if (opts.selection?.model) {
      this.log(agent, `Model: ${opts.selection.model}${opts.selection.effort ? ` · ${opts.selection.effort}` : ''}`);
    }
    return runAgent({
      runId,
      agent,
      cwd: opts.cwd,
      prompt,
      allowWrite: opts.allowWrite,
      ...opts.selection,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onChunk: (chunk) => this.bus.emit({ type: 'stream', runId, agent, chunk, at: Date.now() }),
    }, { providers: this.providers });
  }

  /**
   * Kota dolmasi ya da oturum dusmesi kalici bir durumdur: ayni ajani bu
   * calismada tekrar denemek anlamsiz. Ajan isaretlenir ve isi dagitilir.
   */
  private noteFailure(agent: AgentId, res: AgentRunResult): boolean {
    if (!res.failureKind || !['quota', 'auth', 'unavailable', 'timeout'].includes(res.failureKind)) return false;
    if (this.downed.has(agent)) return true;
    const remedy = remedyFor(agent, res.failureKind, res.retryHint);
    const retryAt = res.failureKind === 'quota' ? retryHintToTimestamp(res.retryHint) : undefined;
    this.downed.set(agent, { reason: remedy, retryAt, retryHint: res.retryHint });
    if (res.failureKind === 'quota') COOLDOWNS.set(agent, { reason: remedy, retryAt, retryHint: res.retryHint });
    this.log(agent, `Devre disi birakildi — ${remedy}`, 'warn');
    if (res.failureKind === 'quota') {
      this.bus.emit({
        type: 'agent:status', runId: this.run?.id ?? '-', agent, status: 'sleeping',
        reason: remedy, retryAt, retryHint: res.retryHint,
      });
    }
    return true;
  }

  /** Pahali modeller yalnizca gercekten zor/riski yuksek turlarda kullanilir. */
  private modelFor(agent: AgentId, complexity: TaskComplexity, role: 'plan' | 'claim' | 'execute' | 'review'): ModelSelection {
    if (agent === 'claude') {
      const effort = complexity === 'critical' ? 'high' : role === 'claim' ? 'medium' : 'medium';
      return { model: 'opus', effort, fallbackModels: ['sonnet'] };
    }
    if (agent === 'codex') {
      const useAstra = complexity === 'critical' && role !== 'claim';
      return {
        model: useAstra ? 'gpt-6-astra' : 'gpt-5.6-sol',
        effort: complexity === 'low' ? 'medium' : 'high',
      };
    }
    if (agent === 'antigravity') {
      return complexity === 'low'
        ? { model: 'flash', effort: 'medium', fallbackModels: ['flash_lite'] }
        : { model: 'pro', effort: complexity === 'critical' ? 'high' : 'medium', fallbackModels: ['flash', 'flash_lite'] };
    }
    return { effort: complexity === 'critical' ? 'high' : 'medium' };
  }

  private requestComplexity(prompt: string): TaskComplexity {
    const hard = /\b(security|guvenlik|mimari|architecture|migration|veri kaybi|data loss|concurrency|odeme|payment|auth)\b/i.test(prompt);
    if (hard && prompt.length > 500) return 'critical';
    if (hard || prompt.length > 900) return 'high';
    return prompt.length > 240 ? 'medium' : 'low';
  }

  private healthy(agents: AgentId[]): AgentId[] {
    for (const [agent, state] of this.downed) {
      if (state.retryAt && state.retryAt <= Date.now()) {
        this.downed.delete(agent);
        COOLDOWNS.delete(agent);
        this.bus.emit({ type: 'agent:status', runId: this.run?.id ?? '-', agent, status: 'available' });
      }
    }
    return agents.filter((a) => !this.downed.has(a));
  }

  /** Planlayiciya verilecek kisa proje ozeti: kok dosyalar ve varsa README basligi. */
  private async projectContext(projectDir: string): Promise<string> {
    const lines: string[] = [`Proje dizini: ${projectDir}`];
    try {
      const entries = await readdir(projectDir, { withFileTypes: true });
      const names = entries
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .slice(0, 40)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      lines.push(`Kok icerigi: ${names.join(', ')}`);
    } catch {
      lines.push('Kok icerigi okunamadi.');
    }
    const branch = await currentBranch(projectDir);
    if (branch) lines.push(`Aktif dal: ${branch}`);
    return lines.join('\n');
  }

  async start(opts: OrchestratorOptions): Promise<RunRecord> {
    const profiles = opts.profiles ?? DEFAULT_PROFILES;
    this.providers = opts.providers ?? [];
    this.downed.clear();
    for (const [agent, state] of COOLDOWNS) {
      if (!state.retryAt || state.retryAt > Date.now()) this.downed.set(agent, state);
      else COOLDOWNS.delete(agent);
    }

    // Hazir ajanlar + kullanicinin kendi saglayicilari birlikte havuz olusturur.
    const providerProfiles: AgentProfile[] = this.providers
      .filter((p) => p.enabled)
      .map((p) => ({
        agent: `provider:${p.slug}` as AgentId,
        label: p.label,
        strengths: p.strengths,
        enabled: true,
      }));
    const allProfiles = [...profiles, ...providerProfiles];

    // Kod yazamayan saglayicilar gorev havuzuna girmez, yalnizca koordinasyon yapar.
    const enabled = allProfiles
      .filter((p) => p.enabled)
      .map((p) => p.agent)
      .filter((a) => {
        const prov = this.providers.find((p) => `provider:${p.slug}` === a);
        return !prov || prov.canWriteCode;
      });
    // Koordinator kod yazmaz; kod yazamayan bir saglayici da bu rolu ustlenebilir.
    const coordinationPool = allProfiles.filter((p) => p.enabled).map((p) => p.agent);
    const coordinator =
      opts.coordinator ?? (coordinationPool.includes('claude') ? 'claude' : coordinationPool[0]);
    const execTimeout = opts.executeTimeoutMs ?? DEFAULTS.executeTimeoutMs;
    const coordTimeout = opts.coordinateTimeoutMs ?? DEFAULTS.coordinateTimeoutMs;
    const overallComplexity = this.requestComplexity(opts.prompt);

    const runId = randomUUID().slice(0, 8);
    const run: RunRecord = {
      id: runId,
      projectDir: opts.projectDir,
      prompt: opts.prompt,
      phase: 'planning',
      startedAt: Date.now(),
      baseBranch: null,
      baseCommit: null,
      integrationBranch: null,
      tasks: [],
      claims: [],
      workspaces: [],
      merges: [],
    };
    this.run = run;
    this.bus.emit({ type: 'run:started', run: structuredClone(run) });
    for (const [agent, state] of this.downed) {
      this.bus.emit({
        type: 'agent:status', runId, agent, status: 'sleeping', reason: state.reason,
        retryAt: state.retryAt, retryHint: state.retryHint,
      });
    }

    try {
      if (enabled.length === 0) throw new Error('Etkin ajan yok.');
      if (!(await isGitRepo(opts.projectDir))) {
        throw new Error(
          `${opts.projectDir} bir git deposu degil. Izole calisma icin git gerekli (git init yeterli).`,
        );
      }

      run.baseBranch = await currentBranch(opts.projectDir);
      run.baseCommit = await headCommit(opts.projectDir);
      if (!run.baseCommit) {
        throw new Error('Depoda hic commit yok. En az bir commit gerekli.');
      }

      const context = await this.projectContext(opts.projectDir);

      // ---------- 1. PLAN ----------
      // Koordinator duserse (kota/oturum) sonraki uygun ajan devralir.
      let activeCoordinator = coordinator;
      let plan: { summary?: string; tasks?: any[] } | null = null;
      for (const candidate of [coordinator, ...coordinationPool.filter((a) => a !== coordinator)]) {
        if (this.downed.has(candidate)) continue;
        this.log('orchestrator', `Plan hazirlaniyor (${agentLabel(candidate, this.providers)})...`);
        const res = await this.ask(candidate, plannerPrompt(opts.prompt, allProfiles, context), {
          cwd: opts.projectDir,
          allowWrite: false,
          timeoutMs: coordTimeout,
          signal: opts.signal,
          selection: this.modelFor(candidate, overallComplexity, 'plan'),
        });
        if (res.ok) {
          const parsed = extractJson<{ summary?: string; tasks?: any[] }>(res.text);
          if (parsed?.tasks?.length) {
            activeCoordinator = candidate;
            plan = parsed;
            break;
          }
          this.log(candidate, 'Plan JSON olarak okunamadi; siradaki koordinator deneniyor.', 'warn');
          continue;
        }
        this.noteFailure(candidate, res);
        this.log(candidate, `Planlama basarisiz: ${res.error ?? 'bos cevap'}`, 'warn');
      }
      if (!plan?.tasks?.length) throw new Error('Hicbir ajan gecerli plan uretemedi. Kota ve oturumlari kontrol edin.');

      run.tasks = plan.tasks.map((t, i) => ({
        id: String(t.id ?? `t${i + 1}`),
        title: String(t.title ?? 'Isimsiz gorev'),
        detail: String(t.detail ?? ''),
        scope: Array.isArray(t.scope) ? t.scope.map(String) : [],
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
        complexity: ['low', 'medium', 'high', 'critical'].includes(t.complexity)
          ? t.complexity as TaskComplexity
          : overallComplexity,
        requiresVisual: Boolean(t.requiresVisual),
        suggestedAgent: enabled.includes(t.suggestedAgent) ? (t.suggestedAgent as AgentId) : null,
        assignedTo: null,
        status: 'pending',
      }));
      this.log('orchestrator', `${run.tasks.length} gorev planlandi: ${plan.summary ?? ''}`);
      this.touch();

      // ---------- 2. CLAIM ----------
      this.setPhase('claiming');
      this.log('orchestrator', 'Ajanlar gorevleri paylasiyor...');
      const claimants = this.healthy(enabled);
      const claimResults = await Promise.all(
        claimants.map(async (agent): Promise<ClaimResponse> => {
          const res = await this.ask(agent, claimPrompt(agent, run.tasks, context), {
            cwd: opts.projectDir,
            allowWrite: false,
            timeoutMs: coordTimeout,
            signal: opts.signal,
            selection: this.modelFor(agent, 'low', 'claim'),
          });
          if (!res.ok) this.noteFailure(agent, res);
          const parsed = extractJson<{ claims?: any[]; declines?: any[] }>(res.text);
          return {
            agent,
            offers: (parsed?.claims ?? []).map((c) => ({
              taskId: String(c.taskId ?? ''),
              confidence: Number(c.confidence ?? 0),
              rationale: String(c.rationale ?? ''),
            })).filter((c) => c.taskId),
            declines: (parsed?.declines ?? []).map((d) => ({
              taskId: String(d.taskId ?? ''),
              reason: String(d.reason ?? ''),
            })).filter((d) => d.taskId),
            raw: res.text,
          };
        }),
      );
      run.claims = claimResults;
      for (const c of claimResults) {
        this.log(c.agent, `Talep: ${c.offers.map((o) => `${o.taskId}(${o.confidence})`).join(', ') || 'yok'}`);
      }
      this.touch();

      // ---------- 3. ARBITRATE ----------
      this.setPhase('arbitrating');
      const claimsText = claimResults
        .map((c) => {
          const offers = c.offers.map((o) => `  ${o.taskId}: guven ${o.confidence} — ${o.rationale}`).join('\n');
          const declines = c.declines.map((d) => `  ${d.taskId}: RED — ${d.reason}`).join('\n');
          return `${c.agent}:\n${offers || '  (talep yok)'}\n${declines}`;
        })
        .join('\n\n');

      const assignable = this.healthy(enabled);
      if (assignable.length === 0) {
        throw new Error('Tum ajanlar devre disi (kota/oturum). Calisma yapilamiyor.');
      }

      let arb: { assignments?: any[] } | null = null;
      for (const candidate of [activeCoordinator, ...coordinationPool.filter((a) => a !== activeCoordinator)]) {
        if (this.downed.has(candidate)) continue;
        const arbRes = await this.ask(candidate, arbitrationPrompt(run.tasks, claimsText, allProfiles), {
          cwd: opts.projectDir, allowWrite: false, timeoutMs: coordTimeout, signal: opts.signal,
          selection: this.modelFor(candidate, overallComplexity, 'plan'),
        });
        const parsed = arbRes.ok ? extractJson<{ assignments?: any[] }>(arbRes.text) : null;
        if (parsed?.assignments?.length) {
          arb = parsed;
          activeCoordinator = candidate;
          break;
        }
        this.noteFailure(candidate, arbRes);
        this.log(candidate, 'Hakemlik cevabi kullanilamadi; siradaki ajan deneniyor.', 'warn');
      }

      for (const t of run.tasks) {
        const a = arb?.assignments?.find((x) => String(x.taskId) === t.id);
        const chosen = a && assignable.includes(a.agent) ? (a.agent as AgentId) : null;
        t.assignedTo = chosen ?? this.fallbackAssign(t, claimResults, assignable);
        t.status = 'claimed';
      }
      this.assertBalanced(run.tasks, assignable);
      for (const t of run.tasks) this.log('orchestrator', `${t.id} -> ${t.assignedTo}: ${t.title}`);
      this.touch();

      // ---------- 4. EXECUTE ----------
      this.setPhase('executing');
      const working = assignable.filter((a) => run.tasks.some((t) => t.assignedTo === a));

      for (const agent of working) {
        const ws = await createWorkspace(opts.projectDir, runId, agent, run.baseCommit);
        run.workspaces.push(ws);
        this.log(
          agent,
          ws.isMainTree
            ? 'UYARI: izole worktree acilamadi, ana agacta calisilacak.'
            : `Calisma kopyasi: ${ws.dir} (dal ${ws.branch})`,
          ws.isMainTree ? 'warn' : 'info',
        );
      }
      this.touch();

      const execResults = await Promise.all(
        working.map((agent) => this.executeAgent(run, agent, runId, execTimeout, opts.signal)),
      );

      // Kota/oturum nedeniyle dusen ajanlarin isini, gerekirse A -> B -> C
      // seklinde tum saglam adaylar bitene kadar devret.
      while (true) {
        const orphaned = run.tasks.filter(
          (t) => t.status === 'failed' && t.assignedTo && this.downed.has(t.assignedTo),
        );
        if (orphaned.length === 0) break;
        const rescuers = this.healthy(assignable);
        if (rescuers.length === 0) {
          this.log('orchestrator', `${orphaned.length} gorev sahipsiz kaldi; devralacak ajan yok.`, 'warn');
          break;
        } else {
          this.log(
            'orchestrator',
            `${orphaned.length} gorev devrediliyor: ${rescuers.map((a) => agentLabel(a, this.providers)).join(', ')}`,
            'warn',
          );
          // Claim guveni ve uzmanlik sirasi korunur; down olan rota secilemez.
          orphaned.forEach((task) => {
            task.assignedTo = this.fallbackAssign(task, claimResults, rescuers);
            task.status = 'claimed';
            task.error = undefined;
          });
          this.touch();

          const retryAgents = [...new Set(orphaned.map((t) => t.assignedTo!))];
          for (const agent of retryAgents) {
            if (!run.workspaces.some((w) => w.agent === agent)) {
              const ws = await createWorkspace(opts.projectDir, runId, agent, run.baseCommit);
              run.workspaces.push(ws);
            }
          }
          const retryResults = await Promise.all(
            retryAgents.map((agent) =>
              this.executeAgent(run, agent, runId, execTimeout, opts.signal, orphaned),
            ),
          );
          execResults.push(...retryResults);
        }
      }

      // ---------- 5. MERGE ----------
      this.setPhase('merging');
      const merge = await mergeAll(opts.projectDir, runId, run.baseCommit, run.workspaces);
      run.integrationBranch = merge.integrationBranch;
      run.merges = merge.outcomes;
      if (merge.error) this.log('orchestrator', merge.error, 'error');
      for (const m of merge.outcomes) {
        this.log(
          m.agent,
          m.status === 'merged'
            ? 'Birlestirildi.'
            : m.status === 'conflict'
              ? `CATISMA: ${m.conflictFiles.join(', ')}`
              : `Birlestirme atlandi (${m.status}).`,
          m.status === 'conflict' ? 'warn' : 'info',
        );
      }
      this.touch();

      // ---------- 6. REVIEW ----------
      this.setPhase('reviewing');
      const reviewCandidates = this.healthy(coordinationPool);
      const reviewer =
        (opts.reviewer && !this.downed.has(opts.reviewer) ? opts.reviewer : null) ??
        (reviewCandidates.length ? this.pickReviewer(reviewCandidates, run.tasks) : null);
      if (!reviewer) {
        this.log('orchestrator', 'Inceleme yapilamadi: tum ajanlar devre disi.', 'warn');
      }
      const intDir = integrationDir(opts.projectDir, runId);
      const reviewCwd = existsSync(intDir) ? intDir : opts.projectDir;
      const stat = await diffSummary(reviewCwd, run.baseCommit);

      const summaries = execResults
        .map(({ agent, res }) => `--- ${agent} ---\n${res.text.slice(0, 2500) || '(cevap yok)'}`)
        .join('\n\n');
      const conflicts = merge.outcomes.filter((m) => m.status === 'conflict');
      const conflictNote = conflicts.length
        ? `\nDIKKAT: Su ajanlarin calismasi CATISMA nedeniyle birlestirilemedi: ${conflicts
            .map((c) => `${c.agent} (${c.conflictFiles.join(', ')})`)
            .join('; ')}. Bu degisiklikler asagidaki diff'te YOK.`
        : '';

      if (reviewer) {
        const orderedReviewers = [reviewer, ...reviewCandidates.filter((a) => a !== reviewer)];
        for (const candidate of orderedReviewers) {
          if (this.downed.has(candidate)) continue;
          this.log('orchestrator', `Inceleme: ${agentLabel(candidate, this.providers)}`);
          const revRes = await this.ask(candidate, reviewPrompt(run.tasks, stat, summaries, conflictNote), {
            cwd: reviewCwd, allowWrite: false, timeoutMs: coordTimeout, signal: opts.signal,
            selection: this.modelFor(candidate, overallComplexity, 'review'),
          });
          const rev = revRes.ok
            ? extractJson<{ verdict?: string; summary?: string; findings?: string[] }>(revRes.text)
            : null;
          if (rev?.verdict === 'approved' || rev?.verdict === 'changes-requested') {
            run.review = {
              reviewer: candidate,
              verdict: rev.verdict,
              summary: rev.summary ?? revRes.text.slice(0, 1000),
              findings: Array.isArray(rev.findings) ? rev.findings.map(String) : [],
              raw: revRes.text,
            };
            break;
          }
          this.noteFailure(candidate, revRes);
          this.log(candidate, 'Inceleme cevabi kullanilamadi; siradaki ajan deneniyor.', 'warn');
        }
      }

      run.phase = 'done';
      run.endedAt = Date.now();
      this.bus.emit({ type: 'run:finished', run: structuredClone(run) });
      return run;
    } catch (err) {
      run.phase = opts.signal?.aborted ? 'cancelled' : 'failed';
      run.error = err instanceof Error ? err.message : String(err);
      run.endedAt = Date.now();
      this.log('orchestrator', run.error, 'error');
      this.bus.emit({ type: 'run:finished', run: structuredClone(run) });
      return run;
    }
  }

  /**
   * Bir ajanin kendi worktree'sinde ustlendigi gorevleri calistirir ve
   * sonucu tek commit'e alir. `only` verilirse yalnizca o gorevler calisir
   * (devredilen isler icin).
   */
  private async executeAgent(
    run: RunRecord,
    agent: AgentId,
    runId: string,
    timeoutMs: number,
    signal?: AbortSignal,
    only?: Task[],
  ): Promise<{ agent: AgentId; res: AgentRunResult }> {
    const mine = (only ?? run.tasks).filter((t) => t.assignedTo === agent);
    const ws = run.workspaces.find((w) => w.agent === agent)!;

    for (const t of mine) t.status = 'running';
    this.touch();

    const res = await this.ask(agent, executionPrompt(agent, mine, run.tasks), {
      cwd: ws.dir,
      allowWrite: true,
      timeoutMs,
      signal,
      selection: this.modelFor(
        agent,
        mine.some((t) => t.complexity === 'critical')
          ? 'critical'
          : mine.some((t) => t.complexity === 'high') ? 'high' : mine.some((t) => t.complexity === 'medium') ? 'medium' : 'low',
        'execute',
      ),
    });

    if (!res.ok) this.noteFailure(agent, res);

    for (const t of mine) {
      t.status = res.ok ? 'succeeded' : 'failed';
      t.result = res.ok ? res.text.slice(0, 4000) : undefined;
      t.error = res.ok ? undefined : (res.error ?? 'Bilinmeyen hata');
    }
    this.log(
      agent,
      res.ok
        ? `Tamamlandi (${Math.round(res.durationMs / 1000)} sn)`
        : `Basarisiz: ${res.error}`,
      res.ok ? 'info' : 'error',
    );
    this.touch();

    // Kota/timeout aninda yarim kalmis dosyalari entegrasyon dalina tasima.
    if (res.ok) {
      const commit = await commitWorkspace(
        ws,
        `Konsey ${runId}: ${agent} — ${mine.map((t) => t.id).join(', ')}`,
      );
      if (commit.error) this.log(agent, `Commit uyarisi: ${commit.error}`, 'warn');
      else if (!commit.committed) this.log(agent, 'Degisiklik uretilmedi.', 'warn');
    } else {
      this.log(agent, 'Basarisiz turun kismi degisiklikleri commit edilmedi.', 'warn');
    }

    return { agent, res };
  }

  /** Hakem bir gorevi atlamissa: en yuksek guveni veren ajan, o da yoksa en az yuklu ajan. */
  private fallbackAssign(task: Task, claims: ClaimResponse[], enabled: AgentId[]): AgentId {
    let best: { agent: AgentId; confidence: number } | null = null;
    for (const c of claims) {
      if (!enabled.includes(c.agent)) continue;
      const offer = c.offers.find((o) => o.taskId === task.id);
      if (offer && (!best || offer.confidence > best.confidence)) {
        best = { agent: c.agent, confidence: offer.confidence };
      }
    }
    if (best) return best.agent;
    if (task.suggestedAgent && enabled.includes(task.suggestedAgent)) return task.suggestedAgent;
    return enabled[0];
  }

  /** Tek bir ajana yigilmayi engellemek icin fazla yuku bos ajanlara dagitir. */
  private assertBalanced(tasks: Task[], enabled: AgentId[]): void {
    if (enabled.length < 2 || tasks.length < enabled.length) return;
    const load = new Map<AgentId, Task[]>(enabled.map((a) => [a, []]));
    for (const t of tasks) if (t.assignedTo) load.get(t.assignedTo)?.push(t);

    const maxPerAgent = Math.ceil(tasks.length / enabled.length) + 1;
    for (const [agent, list] of load) {
      while (list.length > maxPerAgent) {
        const idle = [...load.entries()].sort((a, b) => a[1].length - b[1].length)[0];
        if (!idle || idle[0] === agent || idle[1].length >= list.length - 1) break;
        const moved = list.pop()!;
        moved.assignedTo = idle[0];
        idle[1].push(moved);
      }
    }
  }

  /** Inceleyici olarak en az gorev ustlenen ajani sec; boylece kendi isini denetlemez. */
  private pickReviewer(enabled: AgentId[], tasks: Task[]): AgentId {
    const counts = enabled.map((a) => ({ a, n: tasks.filter((t) => t.assignedTo === a).length }));
    counts.sort((x, y) => x.n - y.n);
    return counts[0].a;
  }
}
