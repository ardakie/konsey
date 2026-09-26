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
import { enrichPromptWithImages } from './images';
import { validateProject } from './validate';
import { createActivityParser } from './activity';
import { computeQuotas, recordLimits, recordUsage } from './usage';
import {
  applyIntegration,
  changedFiles,
  cleanupWorktrees,
  prepareRepo,
  createWorkspace,
  commitWorkspace,
  currentBranch,
  diffSummary,
  diffPatch,
  headCommit,
  integrationDir,
  isGitRepo,
  mergeAll,
} from './git';
import {
  DEFAULT_PROFILES,
  tierOf,
  arbitrationPrompt,
  claimPrompt,
  executionPrompt,
  plannerPrompt,
  repairPrompt,
  reviewPrompt,
} from './prompts';
import { COST_ORDER } from '../shared/types';
import { L } from '../shared/i18n';
import type {
  AgentId,
  AgentProfile,
  CostTier,
  AgentRunResult,
  ClaimResponse,
  ProviderConfig,
  RunPhase,
  RunRecord,
  Task,
  TaskComplexity,
  RunStrategy,
  RunMode,
  ModelSelection,
  ChatMessage,
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
  /** Kullanicinin sectigi rota; 'auto' ya da bos ise Konsey secer. */
  mode?: RunMode;
  /** Basarili sonuc proje klasorune otomatik uygulansin mi. */
  autoApply?: boolean;
  /** Kullanim sinirlari (limitin %X'i) uygulanirken kullanilacak profiller. */
  quotaProfiles?: AgentProfile[];
  signal?: AbortSignal;
}

const DEFAULTS = {
  executeTimeoutMs: 25 * 60 * 1000,
  coordinateTimeoutMs: 8 * 60 * 1000,
};

export interface RouteDecision {
  strategy: RunStrategy;
  complexity: TaskComplexity;
  reason: string;
}

/**
 * Ucuzluk degil risk belirleyicidir. Kisa ve geri alinabilir degisiklikler
 * DeepSeek hizli yoluna; uzmanlik isteyen tek parca isler tek uzmana; farkli
 * alanlara bolunebilen/riskli isler konseye gider.
 */
export function routeRequest(prompt: string): RouteDecision {
  const request = prompt.split('Ekli görseller (yerel dosya yolları):')[0].trim();
  const normalized = request.toLocaleLowerCase('tr-TR').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ç/g, 'c').replace(/ö/g, 'o').replace(/ü/g, 'u');
  const critical = /\b(guvenlik|security|kimlik dogrulama|auth|kullanici girisi|giris sistemi|login|session management|oturum yonetimi|odeme|payment|veri kaybi|data loss|migration|migrasyon|sema|schema|concurrency|race condition|sifreleme|encryption)\b/;
  const architectural = /\b(mimari|architecture|bastan|yeniden tasarla|redesign|donustur|refactor|performans|performance|cok|crash|memory leak|uctan uca|ozellik ekle|ozelligi ekle|sistem kur|entegrasyon|backend|veritabani)\b/;
  const broadScope = /\b(tum uygulama(?:yi)?|butun proje(?:yi)?|komple uygulama|genel mimari|cok dosya)\b/;
  const visualJudgement = /\b(gorseldeki|ekran goruntus|isaretledigim|hizalama|yerlesim|tasarima gore)\b/;
  const separateItems = request.split(/\n\s*[-*]|[.!?]\s+|\b(?:ayrıca|ayrica|bir de|ve sonra)\b/gi)
    .filter((part) => part.trim().length > 12).length;

  if (critical.test(normalized)) {
    return { strategy: 'council', complexity: 'critical', reason: L('yüksek riskli güvenlik/veri alanı', 'high-risk security/data area') };
  }
  if (broadScope.test(normalized) || (architectural.test(normalized) && (request.length > 280 || separateItems >= 3)) || (separateItems >= 5 && request.length > 700) || request.length > 1400) {
    return { strategy: 'council', complexity: 'high', reason: L('birden fazla uzmanlık alanına bölünebilen geniş iş', 'broad work splittable across multiple specialties') };
  }
  if (architectural.test(normalized) || visualJudgement.test(normalized) || request.length > 650 || (separateItems >= 3 && request.length > 450)) {
    return { strategy: 'expert', complexity: 'medium', reason: L('tek güçlü ajan ve bağımsız kontrol gerektiren iş', 'work needing one strong agent and independent review') };
  }
  return { strategy: 'fast', complexity: 'low', reason: L('dar kapsamlı ve geri alınabilir değişiklik', 'narrow, reversible change') };
}

/** Yeni Orchestrator nesneleri arasinda (uygulama acik kaldigi surece) kota uykusunu korur. */
const COOLDOWNS = new Map<AgentId, { reason: string; retryAt?: number; retryHint?: string }>();

export class Orchestrator {
  readonly bus = new EventBus();
  private run: RunRecord | null = null;
  private providers: ProviderConfig[] = [];
  /** Etkin butun ajanlarin profili; maliyet katmani aramalarinda kullanilir. */
  private profileIndex = new Map<AgentId, AgentProfile>();
  /** Kota/oturum nedeniyle bu calisma boyunca devre disi kalan ajanlar. */
  private downed = new Map<AgentId, { reason: string; retryAt?: number; retryHint?: string }>();
  /** Ayni gorevi basarisiz olan ajana geri verip sonsuz devretme dongusunu engeller. */
  private attempts = new Map<string, Set<AgentId>>();
  /** Limit payi hesaplamasinda kullanilan profiller (kullanicinin % ayarlari). */
  private quotaProfiles: AgentProfile[] = [];

  /** Ajanlarin kendi aralarindaki kisa notlari Konsey sohbetine duser. */
  private say(from: ChatMessage['from'], text: string, kind: ChatMessage['kind'] = 'run') {
    this.bus.emit({
      type: 'chat:message',
      message: {
        id: randomUUID(),
        thread: 'council',
        from,
        text,
        at: Date.now(),
        kind,
        runId: this.run?.id,
      },
    });
  }

  private label(agent: AgentId): string {
    return agentLabel(agent, this.providers, [...this.profileIndex.values()]);
  }

  /** Kullanicinin izin verdigi limit payi dolduysa ajan cagrilmaz. */
  private async capState(agent: AgentId): Promise<{ capped: boolean; reason: string; unlocksAt?: number }> {
    if (!this.quotaProfiles.length && !this.providers.length) return { capped: false, reason: '' };
    try {
      const quotas = await computeQuotas(this.quotaProfiles, this.providers);
      this.bus.emit({ type: 'quota:updated', quotas });
      const quota = quotas.find((q) => q.agent === agent);
      if (!quota?.capped) return { capped: false, reason: '' };
      const window = quota.windows.find((w) => w.usedPercent >= quota.capPercent);
      return {
        capped: true,
        reason: L(
          `${window?.label ?? 'Limit'} kullanımı %${window?.usedPercent ?? quota.usedPercent} — izin verilen pay %${quota.capPercent}`,
          `${window?.label ?? 'Limit'} usage %${window?.usedPercent ?? quota.usedPercent} — allowed share %${quota.capPercent}`,
        ),
        unlocksAt: quota.unlocksAt,
      };
    } catch {
      return { capped: false, reason: '' };
    }
  }

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
    opts: {
      cwd: string;
      allowWrite: boolean;
      timeoutMs: number;
      role: 'plan' | 'claim' | 'execute' | 'review' | 'repair';
      signal?: AbortSignal;
      selection?: ModelSelection;
    },
  ): Promise<AgentRunResult> {
    const runId = this.run?.id ?? '-';
    if (opts.signal?.aborted) {
      return {
        agent, ok: false, text: '', raw: '', exitCode: null, durationMs: 0,
        error: L('Kullanıcı tarafından durduruldu.', 'Stopped by the user.'), failureKind: 'cancelled',
      };
    }
    const cap = await this.capState(agent);
    if (cap.capped) {
      return {
        agent, ok: false, text: '', raw: '', exitCode: null, durationMs: 0,
        error: L(`Kullanım payı doldu: ${cap.reason}.`, `Usage share full: ${cap.reason}.`), failureKind: 'capped',
        retryHint: cap.unlocksAt ? new Date(cap.unlocksAt).toISOString() : undefined,
      };
    }
    if (opts.selection?.model) {
      this.log(agent, `Model: ${opts.selection.model}${opts.selection.effort ? ` · ${opts.selection.effort}` : ''}`);
    }
    const parse = createActivityParser(agent);
    const activeEntry = { agent, role: opts.role, since: Date.now() };
    if (this.run) {
      this.run.active = [...(this.run.active ?? []), activeEntry];
      this.touch();
    }
    const result = await runAgent({
      runId,
      agent,
      cwd: opts.cwd,
      prompt,
      allowWrite: opts.allowWrite,
      ...opts.selection,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onChunk: (chunk) => {
        this.bus.emit({ type: 'stream', runId, agent, chunk, at: Date.now() });
        for (const item of parse(chunk)) {
          this.bus.emit({ type: 'activity', runId, agent, text: item.text, tone: item.tone, at: Date.now(), phase: this.run?.phase });
        }
      },
    }, { providers: this.providers, profiles: [...this.profileIndex.values()] });
    if (this.run) {
      this.run.active = (this.run.active ?? []).filter((entry) => entry !== activeEntry);
      this.touch();
    }
    // Hic calismadan donen (bulunamadi, pay dolu) cagrilar kullanima sayilmaz.
    if (result.ok || result.usage || result.durationMs > 0) {
      await recordUsage(agent, {
        tokens: result.usage?.totalTokens,
        costUsd: result.usage?.costUsd,
        durationMs: result.durationMs,
      }).catch(() => {});
    }
    if (result.limits?.length) await recordLimits(agent, result.limits).catch(() => {});
    this.run?.usage.push({
      agent,
      role: opts.role,
      model: opts.selection?.model,
      durationMs: result.durationMs,
      ...result.usage,
    });
    return result;
  }

  /**
   * Kota dolmasi ya da oturum dusmesi kalici bir durumdur: ayni ajani bu
   * calismada tekrar denemek anlamsiz. Ajan isaretlenir ve isi dagitilir.
   */
  private noteFailure(agent: AgentId, res: AgentRunResult): boolean {
    if (!res.failureKind || !['quota', 'capped', 'auth', 'unavailable', 'timeout'].includes(res.failureKind)) return false;
    if (this.downed.has(agent)) return true;
    if (res.failureKind === 'capped') {
      const retryAt = res.retryHint ? Date.parse(res.retryHint) || undefined : undefined;
      const reason = res.error ?? L('Kullanım payı doldu.', 'Usage share is full.');
      this.downed.set(agent, { reason, retryAt });
      this.log(agent, L(`Devre dışı — ${reason}`, `Disabled — ${reason}`), 'warn');
      this.say(agent, L(`${reason} Bu işte beni saymayın, payım bitti.`, `${reason} Don't count on me for this run, my share is used up.`));
      this.bus.emit({ type: 'agent:status', runId: this.run?.id ?? '-', agent, status: 'sleeping', reason, retryAt });
      return true;
    }
    const remedy = remedyFor(agent, res.failureKind, res.retryHint);
    const retryAt = res.failureKind === 'quota' ? retryHintToTimestamp(res.retryHint) : undefined;
    this.downed.set(agent, { reason: remedy, retryAt, retryHint: res.retryHint });
    if (res.failureKind === 'quota') COOLDOWNS.set(agent, { reason: remedy, retryAt, retryHint: res.retryHint });
    this.log(agent, L(`Devre dışı bırakıldı — ${remedy}`, `Disabled — ${remedy}`), 'warn');
    this.say(agent, res.failureKind === 'quota'
      ? L(`Kotam doldu${res.retryHint ? ` (${res.retryHint})` : ''}. İşimi başka birine devrediyorum.`, `My quota is used up${res.retryHint ? ` (${res.retryHint})` : ''}. Handing my work to someone else.`)
      : L(`Şu an çalışamıyorum: ${remedy}`, `I can't work right now: ${remedy}`));
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
    return routeRequest(prompt).complexity;
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
    this.quotaProfiles = opts.quotaProfiles ?? profiles;
    this.downed.clear();
    this.attempts.clear();
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
        costTier: p.costTier ?? 'cheap',
      }));
    const allProfiles = [...profiles, ...providerProfiles];
    this.profileIndex = new Map(allProfiles.map((p) => [p.agent, p]));

    // Kullanicinin izin verdigi limit payini asmis ajanlar bu calismaya hic alinmaz.
    const cappedAtStart: { agent: AgentId; reason: string; unlocksAt?: number }[] = [];
    for (const profile of allProfiles) {
      if (!profile.enabled) continue;
      const cap = await this.capState(profile.agent);
      if (cap.capped) {
        profile.enabled = false;
        cappedAtStart.push({ agent: profile.agent, reason: cap.reason, unlocksAt: cap.unlocksAt });
      }
    }

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
    const execTimeout = opts.executeTimeoutMs ?? DEFAULTS.executeTimeoutMs;
    const coordTimeout = opts.coordinateTimeoutMs ?? DEFAULTS.coordinateTimeoutMs;
    const autoRoute = routeRequest(opts.prompt);
    const route: RouteDecision = opts.mode && opts.mode !== 'auto'
      ? {
          strategy: opts.mode,
          complexity: opts.mode === 'fast' ? 'low' : opts.mode === 'expert' ? (autoRoute.complexity === 'low' ? 'medium' : autoRoute.complexity) : (autoRoute.complexity === 'critical' ? 'critical' : 'high'),
          reason: L('kullanıcı seçimi', 'user selection'),
        }
      : autoRoute;
    const overallComplexity = route.complexity;
    const preparedPrompt = await enrichPromptWithImages(opts.prompt);
    const cheapExecutors = enabled.filter((agent) => this.tier(agent) === 'cheap');
    const effectiveStrategy: RunStrategy = route.strategy === 'fast' && cheapExecutors.length === 0
      ? 'expert'
      : route.strategy;

    // Basit bir istek icin pahali bir modele plan yaptirmak bosa kota harciyor:
    // kucuk isleri en ucuz koordinator planlasin, agir isler Claude'a kalsin.
    const configuredCoordinator = opts.coordinator && coordinationPool.includes(opts.coordinator)
      ? opts.coordinator
      : null;
    const coordinator =
      configuredCoordinator ??
      (overallComplexity === 'low'
        ? this.cheapestOf(coordinationPool) ?? coordinationPool[0]
        : overallComplexity === 'medium' && coordinationPool.includes('codex')
          ? 'codex'
          : coordinationPool.includes('claude')
          ? 'claude'
          : coordinationPool[0]);

    const runId = randomUUID().slice(0, 8);
    const run: RunRecord = {
      id: runId,
      projectDir: opts.projectDir,
      prompt: opts.prompt,
      strategy: effectiveStrategy,
      phase: 'planning',
      startedAt: Date.now(),
      baseBranch: null,
      baseCommit: null,
      integrationBranch: null,
      tasks: [],
      claims: [],
      workspaces: [],
      merges: [],
      usage: [],
      routeReason: route.reason,
    };
    this.run = run;
    this.bus.emit({ type: 'run:started', run: structuredClone(run) });
    for (const capped of cappedAtStart) {
      this.log(capped.agent, L(`Bu çalışmada kullanılmıyor — ${capped.reason}.`, `Not used in this run — ${capped.reason}.`), 'warn');
      this.bus.emit({
        type: 'agent:status', runId, agent: capped.agent, status: 'sleeping',
        reason: capped.reason, retryAt: capped.unlocksAt,
      });
    }
    if (cappedAtStart.length) {
      this.say('orchestrator', L(
        `${cappedAtStart.map((c) => this.label(c.agent)).join(', ')} kullanım payını doldurduğu için bu işe katılmıyor.`,
        `${cappedAtStart.map((c) => this.label(c.agent)).join(', ')} isn't joining this run because its usage share is full.`,
      ));
    }
    for (const [agent, state] of this.downed) {
      this.bus.emit({
        type: 'agent:status', runId, agent, status: 'sleeping', reason: state.reason,
        retryAt: state.retryAt, retryHint: state.retryHint,
      });
    }

    try {
      if (enabled.length === 0) {
        throw new Error(cappedAtStart.length
          ? L('Tüm ajanlar kullanım payını doldurdu. Ayarlardan izin verilen yüzdeyi artırabilirsin.', 'All agents have used up their usage share. You can raise the allowed percentage in settings.')
          : L('Etkin ajan yok. Soldaki listeden en az bir ajanı aç.', 'No agent is enabled. Turn on at least one agent from the list on the left.'));
      }
      // Duz bir klasor secildiyse sessizce git deposuna cevrilir; ajanlar izole calisabilsin.
      if (!(await isGitRepo(opts.projectDir)) || !(await headCommit(opts.projectDir))) {
        const prepared = await prepareRepo(opts.projectDir);
        if (!prepared.ok) throw new Error(prepared.message);
        this.log('orchestrator', prepared.message);
      }

      run.baseBranch = await currentBranch(opts.projectDir);
      run.baseCommit = await headCommit(opts.projectDir);
      if (!run.baseCommit) {
        throw new Error(L('Depoda hiç commit yok. En az bir commit gerekli.', 'The repository has no commits. At least one commit is required.'));
      }

      const context = await this.projectContext(opts.projectDir);
      this.log('orchestrator', L(`Rota: ${effectiveStrategy.toUpperCase()} — ${route.reason}.`, `Route: ${effectiveStrategy.toUpperCase()} — ${route.reason}.`));

      // ---------- 1. PLAN ----------
      // Koordinator duserse (kota/oturum) sonraki uygun ajan devralir.
      let activeCoordinator = coordinator;
      let plan: { summary?: string; tasks?: any[] } | null = effectiveStrategy === 'fast'
        ? {
            summary: L('Hızlı yol: işi tek bir ucuz ajan doğrudan yapar', 'Fast path: a single cheap agent does the work directly'),
            tasks: [{
              id: 't1',
              title: opts.prompt.split('\n')[0].slice(0, 90) || L('Kullanıcı isteğini uygula', "Implement the user's request"),
              detail: preparedPrompt,
              scope: [],
              dependsOn: [],
              complexity: 'low',
              requiresVisual: false,
              suggestedAgent: cheapExecutors[0],
            }],
          }
        : null;
      if (effectiveStrategy === 'fast') {
        activeCoordinator = cheapExecutors[0]!;
        this.log('orchestrator', L(`İşi ilk yakalayan: ${this.label(activeCoordinator)}.`, `First to grab the work: ${this.label(activeCoordinator)}.`));
      }
      for (const candidate of plan ? [] : [coordinator, ...coordinationPool.filter((a) => a !== coordinator)]) {
        if (this.downed.has(candidate)) continue;
        this.log('orchestrator', L(`Plan hazırlanıyor (${this.label(candidate)})...`, `Preparing the plan (${this.label(candidate)})...`));
        const res = await this.ask(candidate, plannerPrompt(preparedPrompt, allProfiles, context), {
          cwd: opts.projectDir,
          allowWrite: false,
          timeoutMs: coordTimeout,
          role: 'plan',
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
          this.log(candidate, L('Plan JSON olarak okunamadı; sıradaki koordinatör deneniyor.', 'Plan could not be read as JSON; trying the next coordinator.'), 'warn');
          continue;
        }
        this.noteFailure(candidate, res);
        this.log(candidate, L(`Planlama başarısız: ${res.error ?? 'boş cevap'}`, `Planning failed: ${res.error ?? 'empty response'}`), 'warn');
      }
      if (!plan?.tasks?.length) throw new Error(L('Hiçbir ajan geçerli plan üretemedi. Kota ve oturumları kontrol edin.', 'No agent produced a valid plan. Check quotas and sessions.'));

      run.tasks = plan.tasks.map((t, i) => ({
        id: String(t.id ?? `t${i + 1}`),
        title: String(t.title ?? L('İsimsiz görev', 'Untitled task')),
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
      run.summary = plan.summary ? String(plan.summary) : undefined;
      this.log('orchestrator', L(`${run.tasks.length} görev planlandı: ${plan.summary ?? ''}`, `${run.tasks.length} tasks planned: ${plan.summary ?? ''}`));
      if (effectiveStrategy !== 'fast') {
        this.say(activeCoordinator, L(`Planı çıkardım: ${run.tasks.length} görev. ${run.summary ?? ''}`, `I made the plan: ${run.tasks.length} tasks. ${run.summary ?? ''}`).trim());
      }
      this.touch();

      // ---------- 2. CLAIM ----------
      this.setPhase('claiming');
      this.log('orchestrator', L('Ajanlar görevleri paylaşıyor...', 'Agents are splitting up the tasks...'));
      const routineOnly = effectiveStrategy === 'fast';
      const expertOnly = effectiveStrategy === 'expert';
      const claimants = routineOnly || expertOnly ? [] : this.claimCandidates(run.tasks, enabled, activeCoordinator);
      if (routineOnly) {
        this.log('orchestrator', L('Rutin rota: pahalı ajanlara görev talebi gönderilmiyor.', 'Routine route: no task requests are sent to expensive agents.'));
      } else if (expertOnly) {
        this.log('orchestrator', L('Uzman rota: konsey kurmadan en uygun güçlü ajan seçiliyor.', 'Expert route: picking the best-fit strong agent without convening the council.'));
      }
      const claimResults = await Promise.all(
        claimants.map(async (agent): Promise<ClaimResponse> => {
          const res = await this.ask(agent, claimPrompt(agent, run.tasks, context), {
            cwd: opts.projectDir,
            allowWrite: false,
            timeoutMs: coordTimeout,
            role: 'claim',
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
        this.log(c.agent, L(
          `Talep: ${c.offers.map((o) => `${o.taskId}(${o.confidence})`).join(', ') || 'yok'}`,
          `Request: ${c.offers.map((o) => `${o.taskId}(${o.confidence})`).join(', ') || 'none'}`,
        ));
        const best = [...c.offers].sort((a, b) => b.confidence - a.confidence)[0];
        if (best) {
          const title = run.tasks.find((t) => t.id === best.taskId)?.title ?? best.taskId;
          this.say(c.agent, L(`"${title}" bende olsun (güven ${best.confidence}). ${best.rationale}`, `Let me take "${title}" (confidence ${best.confidence}). ${best.rationale}`).trim());
        } else if (c.declines.length) {
          this.say(c.agent, L(`Bu turda bana uygun görev yok: ${c.declines[0].reason}`, `No task fits me this round: ${c.declines[0].reason}`));
        }
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
        throw new Error(L('Tüm ajanlar devre dışı (kota/oturum). Çalışma yapılamıyor.', 'All agents are disabled (quota/session). The run cannot proceed.'));
      }

      let arb: { assignments?: any[] } | null = null;
      if (!routineOnly && !expertOnly) {
        for (const candidate of [activeCoordinator, ...coordinationPool.filter((a) => a !== activeCoordinator)]) {
          if (this.downed.has(candidate)) continue;
          const arbRes = await this.ask(candidate, arbitrationPrompt(run.tasks, claimsText, allProfiles), {
            cwd: opts.projectDir, allowWrite: false, timeoutMs: coordTimeout, role: 'plan', signal: opts.signal,
            selection: this.modelFor(candidate, overallComplexity, 'plan'),
          });
          const parsed = arbRes.ok ? extractJson<{ assignments?: any[] }>(arbRes.text) : null;
          if (parsed?.assignments?.length) {
            arb = parsed;
            activeCoordinator = candidate;
            break;
          }
          this.noteFailure(candidate, arbRes);
          this.log(candidate, L('Hakemlik cevabı kullanılamadı; sıradaki ajan deneniyor.', "Arbitration response couldn't be used; trying the next agent."), 'warn');
        }
      }

      if (routineOnly) {
        this.assignRoutineTasks(run.tasks, assignable);
      } else if (expertOnly) {
        this.assignExpertTasks(run.tasks, assignable);
      } else {
        for (const t of run.tasks) {
          const a = arb?.assignments?.find((x) => String(x.taskId) === t.id);
          const chosen = a && assignable.includes(a.agent) ? (a.agent as AgentId) : null;
          t.assignedTo = chosen ?? this.fallbackAssign(t, claimResults, assignable);
          t.status = 'claimed';
        }
      }
      this.assertBalanced(run.tasks, assignable);
      this.enforceCostPolicy(run.tasks, assignable);
      this.enforceCapabilityPolicy(run.tasks, assignable);
      this.enforceDependencyOwnership(run.tasks);
      for (const t of run.tasks) this.log('orchestrator', `${t.id} -> ${t.assignedTo}: ${t.title}`);
      const byOwner = new Map<AgentId, string[]>();
      for (const t of run.tasks) if (t.assignedTo) byOwner.set(t.assignedTo, [...(byOwner.get(t.assignedTo) ?? []), t.title]);
      this.say('orchestrator', L(
        `Dağıtım: ${[...byOwner].map(([a, titles]) => `${this.label(a)} → ${titles.join(', ')}`).join(' · ')}`,
        `Assignment: ${[...byOwner].map(([a, titles]) => `${this.label(a)} → ${titles.join(', ')}`).join(' · ')}`,
      ));
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
            ? L('UYARI: izole worktree açılamadı, ana ağaçta çalışılacak.', 'WARNING: could not open an isolated worktree; working in the main tree instead.')
            : L(`Çalışma kopyası: ${ws.dir} (dal ${ws.branch})`, `Working copy: ${ws.dir} (branch ${ws.branch})`),
          ws.isMainTree ? 'warn' : 'info',
        );
      }
      this.touch();

      const execResults = await Promise.all(
        working.map((agent) => this.executeAgent(run, agent, runId, execTimeout, opts.signal)),
      );

      if (opts.signal?.aborted) throw new Error(L('Kullanıcı tarafından durduruldu.', 'Stopped by the user.'));

      // Kota/oturum nedeniyle dusen ajanlarin isini, gerekirse A -> B -> C
      // seklinde tum saglam adaylar bitene kadar devret.
      while (true) {
        if (opts.signal?.aborted) throw new Error(L('Kullanıcı tarafından durduruldu.', 'Stopped by the user.'));
        const orphaned = run.tasks.filter(
          (t) => t.status === 'failed' && t.assignedTo && (
            this.downed.has(t.assignedTo) || this.tier(t.assignedTo) === 'cheap'
          ),
        );
        if (orphaned.length === 0) break;
        const attemptedAgents = new Set(orphaned.flatMap((task) => [...(this.attempts.get(task.id) ?? [])]));
        const rescuers = this.healthy(assignable).filter((agent) => !attemptedAgents.has(agent));
        if (rescuers.length === 0) {
          this.log('orchestrator', L(`${orphaned.length} görev sahipsiz kaldı; devralacak ajan yok.`, `${orphaned.length} task(s) are orphaned; no agent left to take over.`), 'warn');
          break;
        } else {
          this.log(
            'orchestrator',
            L(
              `${orphaned.length} görev devrediliyor: ${rescuers.map((a) => this.label(a)).join(', ')}`,
              `Handing off ${orphaned.length} task(s) to: ${rescuers.map((a) => this.label(a)).join(', ')}`,
            ),
            'warn',
          );
          // Claim guveni ve uzmanlik sirasi korunur; down olan rota secilemez.
          orphaned.forEach((task) => {
            if (task.assignedTo && this.tier(task.assignedTo) === 'cheap') {
              const alternateCheap = rescuers.find((agent) => this.tier(agent) === 'cheap');
              if (alternateCheap) {
                task.assignedTo = alternateCheap;
              } else {
                this.assignExpertTasks([task], rescuers);
              }
            } else {
              task.assignedTo = this.fallbackAssign(task, claimResults, rescuers);
            }
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
            ? L('Birleştirildi.', 'Merged.')
            : m.status === 'conflict'
              ? L(`ÇATIŞMA: ${m.conflictFiles.join(', ')}`, `CONFLICT: ${m.conflictFiles.join(', ')}`)
              : L(`Birleştirme atlandı (${m.status}).`, `Merge skipped (${m.status}).`),
          m.status === 'conflict' ? 'warn' : 'info',
        );
      }
      this.touch();

      // Model ozetine guvenmeden, projenin kendi test/typecheck komutlarini calistir.
      const intDir = integrationDir(opts.projectDir, runId);
      const reviewCwd = existsSync(intDir) ? intDir : opts.projectDir;
      run.validation = await validateProject(reviewCwd);
      this.log(
        'orchestrator',
        L(`Kalite kapısı: ${run.validation.summary}`, `Quality gate: ${run.validation.summary}`),
        run.validation.ok ? 'info' : 'error',
      );
      this.touch();

      // ---------- 6. REVIEW ----------
      this.setPhase('reviewing');
      const reviewCandidates = this.healthy(coordinationPool);
      const reviewer =
        (opts.reviewer && reviewCandidates.includes(opts.reviewer) && !this.downed.has(opts.reviewer) ? opts.reviewer : null) ??
        (reviewCandidates.length
          ? this.pickReviewer(reviewCandidates, run.tasks, run.validation.ok && run.validation.commands.length > 0)
          : null);
      if (!reviewer) {
        this.log('orchestrator', L('İnceleme yapılamadı: tüm ajanlar devre dışı.', 'Review could not be done: all agents are disabled.'), 'warn');
      }
      const stat = await this.reviewEvidence(reviewCwd, run.baseCommit);

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
          this.log('orchestrator', L(`İnceleme: ${this.label(candidate)}`, `Review: ${this.label(candidate)}`));
          const revRes = await this.ask(candidate, reviewPrompt(run.tasks, stat, summaries, conflictNote, run.validation), {
            cwd: reviewCwd, allowWrite: false, timeoutMs: coordTimeout, role: 'review', signal: opts.signal,
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
            this.say(candidate, rev.verdict === 'approved'
              ? L(`İnceledim, onaylıyorum. ${run.review.summary.slice(0, 280)}`, `Reviewed, approving. ${run.review.summary.slice(0, 280)}`)
              : L(`Düzeltme gerekiyor: ${run.review.findings.slice(0, 2).join(' · ') || run.review.summary.slice(0, 200)}`, `Changes needed: ${run.review.findings.slice(0, 2).join(' · ') || run.review.summary.slice(0, 200)}`));
            break;
          }
          this.noteFailure(candidate, revRes);
          this.log(candidate, L('İnceleme cevabı kullanılamadı; sıradaki ajan deneniyor.', "Review response couldn't be used; trying the next agent."), 'warn');
        }
      }

      // Test veya inceleme kirmiziysa bir premium ajan entegrasyon dalinda tek
      // kontrollu onarim yapar; ardindan test ve bagimsiz inceleme tekrarlanir.
      if (!run.validation.ok || run.review?.verdict === 'changes-requested') {
        const fixer = this.pickFixer(this.healthy(enabled), overallComplexity, run.review?.reviewer);
        if (fixer) {
          this.log('orchestrator', L(`Kalite onarımı: ${this.label(fixer)}`, `Quality repair: ${this.label(fixer)}`), 'warn');
          const repair = await this.ask(
            fixer,
            repairPrompt(run.tasks, run.review?.findings ?? [], run.validation),
            {
              cwd: reviewCwd,
              allowWrite: true,
              timeoutMs: execTimeout,
              role: 'repair',
              signal: opts.signal,
              selection: this.modelFor(
                fixer,
                overallComplexity === 'critical' ? 'critical' : 'high',
                'execute',
              ),
            },
          );
          if (repair.ok) {
            const committed = await commitWorkspace(
              { agent: fixer, dir: reviewCwd, branch: run.integrationBranch, isMainTree: false },
              `Konsey ${runId}: kalite onarimi — ${fixer}`,
            );
            if (committed.error) this.log(fixer, L(`Onarım commit uyarısı: ${committed.error}`, `Repair commit warning: ${committed.error}`), 'warn');
            run.validation = await validateProject(reviewCwd);
            this.log(
              'orchestrator',
              L(`Onarım sonrası kalite kapısı: ${run.validation.summary}`, `Quality gate after repair: ${run.validation.summary}`),
              run.validation.ok ? 'info' : 'error',
            );

            const verifyCandidates = this.healthy(reviewCandidates).filter((agent) => agent !== fixer);
            const verifier = verifyCandidates[0] ?? this.healthy(reviewCandidates)[0];
            if (verifier) {
              const newStat = await this.reviewEvidence(reviewCwd, run.baseCommit);
              const verification = await this.ask(
                verifier,
                reviewPrompt(run.tasks, newStat, summaries, conflictNote, run.validation),
                {
                  cwd: reviewCwd,
                  allowWrite: false,
                  timeoutMs: coordTimeout,
                  role: 'review',
                  signal: opts.signal,
                  selection: this.modelFor(verifier, overallComplexity, 'review'),
                },
              );
              const parsed = verification.ok
                ? extractJson<{ verdict?: string; summary?: string; findings?: string[] }>(verification.text)
                : null;
              if (parsed?.verdict === 'approved' || parsed?.verdict === 'changes-requested') {
                run.review = {
                  reviewer: verifier,
                  verdict: parsed.verdict,
                  summary: parsed.summary ?? verification.text.slice(0, 1000),
                  findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
                  raw: verification.text,
                };
              }
            }
          } else {
            this.noteFailure(fixer, repair);
            this.log(fixer, L(`Kalite onarımı başarısız: ${repair.error ?? 'boş cevap'}`, `Quality repair failed: ${repair.error ?? 'empty response'}`), 'error');
          }
        }
      }

      const qualityFailed =
        run.tasks.some((task) => task.status !== 'succeeded') ||
        run.merges.some((mergeResult) => mergeResult.status === 'conflict' || mergeResult.status === 'failed') ||
        !run.validation?.ok ||
        run.review?.verdict === 'changes-requested';
      run.phase = qualityFailed ? 'failed' : 'done';
      if (qualityFailed) {
        run.error = run.tasks.some((task) => task.status !== 'succeeded')
          ? L('Bir veya daha fazla görev tamamlanamadı; entegrasyon dalı teslim edilmedi.', 'One or more tasks failed to complete; the integration branch was not delivered.')
          : run.merges.some((mergeResult) => mergeResult.status === 'conflict' || mergeResult.status === 'failed')
            ? L('Birleştirme çatışması çözülemedi; entegrasyon dalı teslim edilmedi.', 'Merge conflict could not be resolved; the integration branch was not delivered.')
            : !run.validation?.ok
              ? L('Otomatik kalite kapısı başarısız; entegrasyon dalı teslim edilmedi.', 'Automated quality gate failed; the integration branch was not delivered.')
              : L('Kod incelemesi değişiklik istedi; entegrasyon dalı teslim edilmedi.', 'Code review requested changes; the integration branch was not delivered.');
      }
      run.diffStat = (await diffSummary(reviewCwd, run.baseCommit)) || undefined;
      if (!qualityFailed && run.integrationBranch && opts.autoApply !== false) {
        const files = await changedFiles(opts.projectDir, run.baseCommit, run.integrationBranch);
        if (files.length) {
          const applied = await applyIntegration(opts.projectDir, run.integrationBranch);
          run.applied = { ...applied, at: Date.now() };
          this.log('orchestrator', applied.message, applied.ok ? 'info' : 'warn');
        }
      }
      if (!opts.keepWorktrees) await cleanupWorktrees(opts.projectDir, run.workspaces, runId).catch(() => {});
      this.say('orchestrator', qualityFailed
        ? L(`İş tamamlanamadı: ${run.error}`, `The run could not be completed: ${run.error}`)
        : run.applied?.ok
          ? L(`Bitti. ${run.applied.message}`, `Done. ${run.applied.message}`)
          : L('Bitti. Değişiklikler ayrı dalda hazır.', 'Done. Changes are ready on a separate branch.'));
      run.endedAt = Date.now();
      this.bus.emit({ type: 'run:finished', run: structuredClone(run) });
      return run;
    } catch (err) {
      run.phase = opts.signal?.aborted ? 'cancelled' : 'failed';
      run.error = err instanceof Error ? err.message : String(err);
      run.endedAt = Date.now();
      this.log('orchestrator', run.error, 'error');
      this.say('orchestrator', run.phase === 'cancelled' ? L('İş durduruldu.', 'Run stopped.') : L(`Hata: ${run.error}`, `Error: ${run.error}`), run.phase === 'cancelled' ? 'run' : 'error');
      if (!opts.keepWorktrees && run.workspaces.length) {
        await cleanupWorktrees(opts.projectDir, run.workspaces, runId).catch(() => {});
      }
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
    const mine = this.orderTasks((only ?? run.tasks).filter((t) => t.assignedTo === agent));
    for (const task of mine) {
      const attempts = this.attempts.get(task.id) ?? new Set<AgentId>();
      attempts.add(agent);
      this.attempts.set(task.id, attempts);
    }
    const ws = run.workspaces.find((w) => w.agent === agent)!;

    for (const t of mine) t.status = 'running';
    this.touch();

    const res = await this.ask(agent, executionPrompt(agent, mine, run.tasks), {
      cwd: ws.dir,
      allowWrite: true,
      timeoutMs,
      role: 'execute',
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
      t.error = res.ok ? undefined : (res.error ?? L('Bilinmeyen hata', 'Unknown error'));
    }
    this.log(
      agent,
      res.ok
        ? L(`Tamamlandı (${Math.round(res.durationMs / 1000)} sn)`, `Done (${Math.round(res.durationMs / 1000)}s)`)
        : L(`Başarısız: ${res.error}`, `Failed: ${res.error}`),
      res.ok ? 'info' : 'error',
    );
    if (res.ok) {
      const firstLine = res.text.split('\n').map((l) => l.trim()).find((l) => l.length > 3) ?? '';
      this.say(agent, L(`${mine.map((t) => t.title).join(', ')} tamam. ${firstLine.slice(0, 220)}`, `${mine.map((t) => t.title).join(', ')} done. ${firstLine.slice(0, 220)}`).trim());
    } else if (res.failureKind !== 'capped' && res.failureKind !== 'quota') {
      this.say(agent, L(`Takıldım: ${(res.error ?? 'bilinmeyen hata').slice(0, 200)}`, `I got stuck: ${(res.error ?? 'unknown error').slice(0, 200)}`), 'error');
    }
    this.touch();

    // Kota/timeout aninda yarim kalmis dosyalari entegrasyon dalina tasima.
    if (res.ok) {
      const commit = await commitWorkspace(
        ws,
        `Konsey ${runId}: ${agent} — ${mine.map((t) => t.id).join(', ')}`,
      );
      if (commit.error) this.log(agent, L(`Commit uyarısı: ${commit.error}`, `Commit warning: ${commit.error}`), 'warn');
      else if (!commit.committed) {
        this.log(agent, L('Değişiklik üretilmedi; görev tamamlanmış sayılmayacak.', 'No change was produced; the task will not count as completed.'), 'warn');
        res.ok = false;
        res.error = L('Ajan başarılı yanıt verdi fakat dosya değişikliği üretmedi.', 'The agent responded successfully but produced no file changes.');
        for (const task of mine) {
          task.status = 'failed';
          task.error = res.error;
        }
        this.touch();
      }
    } else {
      this.log(agent, L('Başarısız turun kısmi değişiklikleri commit edilmedi.', "The failed round's partial changes were not committed."), 'warn');
    }

    return { agent, res };
  }

  /** Inceleyiciye verilen kanit: degisiklik ozeti ve gercek kod farki. */
  private async reviewEvidence(dir: string, baseCommit: string): Promise<string> {
    const [stat, patch] = await Promise.all([diffSummary(dir, baseCommit), diffPatch(dir, baseCommit)]);
    return patch ? `${stat}\n\nKOD FARKI (git diff):\n${patch}` : stat;
  }

  /** Bir ajanin maliyet katmani. Profil yoksa saglayicilar ucuz, abonelikler pahali sayilir. */
  private tier(agent: AgentId): CostTier {
    const profile = this.profileIndex.get(agent);
    if (profile) return tierOf(profile);
    return agent.startsWith('provider:') ? 'cheap' : 'premium';
  }

  /** Verilen ajanlar icinde en ucuz olani; esitlikte yapilandirma sirasi belirler. */
  private cheapestOf(agents: AgentId[]): AgentId | null {
    const healthy = this.healthy(agents);
    if (healthy.length === 0) return null;
    return healthy.reduce((best, a) =>
      COST_ORDER[this.tier(a)] < COST_ORDER[this.tier(best)] ? a : best,
    );
  }

  /**
   * Her ajani her istekte konusturmak kalite getirmeden kota yakar. Orta riskte
   * ucuz/standart adaylar ile tek bir premium uzman yeterlidir; yuksek riskte
   * tum uzmanlar gorus verebilir. Plani yapan ajan ayni bilgiyi yeniden claim etmez.
   */
  private claimCandidates(tasks: Task[], enabled: AgentId[], coordinator: AgentId): AgentId[] {
    const healthy = this.healthy(enabled);
    const withoutCoordinator = healthy.filter((agent) => agent !== coordinator);
    const pool = withoutCoordinator.length ? withoutCoordinator : healthy;
    const highRisk = tasks.some(
      (task) => task.requiresVisual || task.complexity === 'high' || task.complexity === 'critical',
    );
    if (highRisk) return pool;

    const economical = pool.filter((agent) => this.tier(agent) !== 'premium');
    const suggestedPremium = pool.find(
      (agent) => this.tier(agent) === 'premium' && tasks.some((task) => task.suggestedAgent === agent),
    );
    const premium = suggestedPremium ?? pool.find((agent) => this.tier(agent) === 'premium');
    return [...economical, ...(premium ? [premium] : [])];
  }

  /** Tamamen rutin bir planda ikinci bir model-hakem turu yerine acik ve dengeli rota. */
  private assignRoutineTasks(tasks: Task[], enabled: AgentId[]): void {
    const healthy = this.healthy(enabled);
    const cheap = healthy.filter((agent) => this.tier(agent) === 'cheap');
    const candidates = cheap.length ? cheap : healthy;
    if (!candidates.length) return;
    tasks.forEach((task, index) => {
      task.assignedTo = candidates[index % candidates.length];
      task.status = 'claimed';
    });
  }

  /** Konsey gerektirmeyen fakat DeepSeek'e birakilmayacak isi tek dogru uzmana ver. */
  private assignExpertTasks(tasks: Task[], enabled: AgentId[]): void {
    const candidates = this.healthy(enabled);
    for (const task of tasks) {
      const description = `${task.title} ${task.detail}`;
      let chosen: AgentId | undefined;
      if (task.requiresVisual && candidates.includes('codex')) {
        chosen = 'codex';
      } else if (
        /\b(frontend|arayüz|arayuz|css|layout|responsive|tarayıcı|tarayici|simulator|ios)\b/i.test(description) &&
        candidates.includes('antigravity')
      ) {
        chosen = 'antigravity';
      } else if (
        /\b(mimari|architecture|refactor|iş mantığı|is mantigi|tasarım kararı|tasarim karari)\b/i.test(description) &&
        candidates.includes('claude')
      ) {
        chosen = 'claude';
      } else if (candidates.includes('codex')) {
        chosen = 'codex';
      } else if (task.suggestedAgent && candidates.includes(task.suggestedAgent)) {
        chosen = task.suggestedAgent;
      } else {
        chosen = candidates[0];
      }
      task.assignedTo = chosen ?? null;
      task.status = 'claimed';
    }
  }

  /**
   * Farkli worktree'ler birbirinin henuz birlesmemis sonucunu goremez. Bu nedenle
   * bagimli gorevleri ayni ajana sabitle; ajan isteminde topolojik sirayla verilirler.
   */
  private enforceDependencyOwnership(tasks: Task[]): void {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (let pass = 0; pass < tasks.length; pass++) {
      let changed = false;
      for (const task of tasks) {
        for (const dependencyId of task.dependsOn) {
          const dependency = byId.get(dependencyId);
          if (!dependency?.assignedTo || task.assignedTo === dependency.assignedTo) continue;
          this.log(
            'orchestrator',
            L(
              `${task.id}, bağımlı olduğu ${dependency.id} ile aynı ajana alındı (${dependency.assignedTo}).`,
              `${task.id} was moved to the same agent as its dependency ${dependency.id} (${dependency.assignedTo}).`,
            ),
          );
          task.assignedTo = dependency.assignedTo;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  private orderTasks(tasks: Task[]): Task[] {
    const pending = [...tasks];
    const result: Task[] = [];
    const ids = new Set(tasks.map((task) => task.id));
    while (pending.length) {
      const index = pending.findIndex((task) =>
        task.dependsOn.filter((id) => ids.has(id)).every((id) => result.some((done) => done.id === id)),
      );
      if (index < 0) return [...result, ...pending];
      result.push(pending.splice(index, 1)[0]);
    }
    return result;
  }

  private pickFixer(enabled: AgentId[], complexity: TaskComplexity, reviewer?: AgentId): AgentId | null {
    const candidates = enabled.filter((agent) => agent !== reviewer);
    const premium = candidates.filter((agent) => this.tier(agent) === 'premium');
    if (complexity === 'critical' && premium.includes('claude')) return 'claude';
    if (premium.includes('codex')) return 'codex';
    if (premium.includes('claude')) return 'claude';
    return candidates.find((agent) => this.tier(agent) === 'standard') ?? candidates[0] ?? reviewer ?? null;
  }

  /**
   * Maliyet politikasini kesin olarak uygular.
   *
   * Hakemlik bir dil modeli tarafindan yapiliyor ve model, "tek dosya olustur"
   * gibi onemsiz bir isi pahali bir aboneliğe verebiliyor. Bu, kotayi bosa
   * harciyor. Bu yuzden karar modele birakilmiyor: zorlugu "low" olan gorevler
   * uygun en ucuz ajanlara zorla dagitiliyor.
   *
   * Gorsel uretim gerektiren gorevler disarida birakiliyor; onlar yalnizca
   * belirli bir abonelikte yapilabiliyor.
   */
  private enforceCostPolicy(tasks: Task[], assignable: AgentId[]): void {
    const candidates = this.healthy(assignable)
      .filter((a) => this.tier(a) === 'cheap')
      .sort((a, b) => assignable.indexOf(a) - assignable.indexOf(b));
    if (candidates.length === 0) return;

    // Ucuz ajanlar arasinda sirayla dagit ki tek uce yigilmasin.
    let next = 0;
    for (const task of tasks) {
      if (task.complexity !== 'low' || task.requiresVisual) continue;
      if (!task.assignedTo || this.tier(task.assignedTo) === 'cheap') continue;

      const target = candidates[next % candidates.length];
      next++;
      this.log(
        'orchestrator',
        L(
          `${task.id} maliyet kuralı gereği ${this.label(task.assignedTo)} yerine ` +
            `${this.label(target)} ajanına verildi (zorluk: low).`,
          `${task.id} was reassigned from ${this.label(task.assignedTo)} to ` +
            `${this.label(target)} under the cost rule (complexity: low).`,
        ),
      );
      task.assignedTo = target;
    }
  }

  /** Gorsel aracina ihtiyac duyan gorevleri bu yetenege sahip Codex rotasinda tut. */
  private enforceCapabilityPolicy(tasks: Task[], assignable: AgentId[]): void {
    if (!assignable.includes('codex') || this.downed.has('codex')) return;
    for (const task of tasks) {
      if (!task.requiresVisual || task.assignedTo === 'codex') continue;
      this.log('orchestrator', L(`${task.id} görsel üretim yeteneği için Codex ajanına alındı.`, `${task.id} was moved to the Codex agent for its image-generation capability.`));
      task.assignedTo = 'codex';
    }
  }

  /** Hakem bir gorevi atlamissa: en yuksek guveni veren ajan, o da yoksa en az yuklu ajan. */
  private fallbackAssign(task: Task, claims: ClaimResponse[], enabled: AgentId[]): AgentId {
    // Basit isler icin talep puanina bakmadan dogrudan en ucuz ajana git.
    if (task.complexity === 'low' && !task.requiresVisual) {
      const cheap = this.cheapestOf(enabled);
      if (cheap && this.tier(cheap) === 'cheap') return cheap;
    }

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
  private pickReviewer(enabled: AgentId[], tasks: Task[], validationPassed = true): AgentId {
    const counts = enabled.map((a) => ({ a, n: tasks.filter((t) => t.assignedTo === a).length }));
    counts.sort((x, y) => x.n - y.n);

    // Riskli bir is veya kirmizi kalite kapisi, premium inceleyici gerektirir.
    if (!validationPassed || tasks.some((t) => t.complexity === 'high' || t.complexity === 'critical')) {
      const premium = counts.filter((c) => this.tier(c.a) === 'premium');
      if (premium.length) return premium[0].a;
    }

    // Butun isler basitse incelemeyi de pahali bir aboneliğe yaptirmanin anlami yok:
    // is yapmamis en ucuz ajani sec, yoksa en az yuklu olana dus.
    if (tasks.length > 0 && tasks.every((t) => t.complexity === 'low')) {
      const idle = counts.filter((c) => c.n === 0).map((c) => c.a);
      const cheap = this.cheapestOf(idle.length ? idle : enabled);
      if (cheap) return cheap;
    }
    return counts[0].a;
  }
}
