/** Konsey — ortak tip tanimlari (hem ana surec hem arayuz kullanir). */

/** Kendi launcher'i olan, dosya duzenleyebilen hazir ajanlar. */
export type BuiltinAgentId = 'claude' | 'codex' | 'antigravity';

/**
 * Kullanicinin kendi API anahtariyla ekledigi OpenAI uyumlu saglayicilar.
 * Kimlikleri `provider:<slug>` bicimindedir; boylece hazir ajanlarla
 * ayni tip icinde tasinabilir ama karistirilamaz.
 */
export type ProviderAgentId = `provider:${string}`;

/**
 * Makinede kurulu ek kodlama CLI'lari (Gemini CLI, Cursor Agent, Copilot...)
 * ya da kullanicinin kendi tanimladigi CLI. Kimlik `cli:<slug>`.
 */
export type CliAgentId = `cli:${string}`;

export type AgentId = BuiltinAgentId | ProviderAgentId | CliAgentId;

export const BUILTIN_AGENTS: BuiltinAgentId[] = ['claude', 'codex', 'antigravity'];

export function isProviderAgent(id: AgentId): id is ProviderAgentId {
  return id.startsWith('provider:');
}

export function isCliAgent(id: string): id is CliAgentId {
  return id.startsWith('cli:');
}

export function providerSlug(id: ProviderAgentId): string {
  return id.slice('provider:'.length);
}

/** Kullanicinin ekledigi OpenAI uyumlu saglayici tanimi. Anahtar burada TUTULMAZ. */
/**
 * Bir ajani calistirmanin bagil maliyeti. Gorev dagitimi bunu okur:
 * basit isler en ucuz ajana gider, pahali abonelikler zor isler icin saklanir.
 *
 * - cheap    : kullanicinin kendi API anahtari (or. DeepSeek uclari)
 * - standard : maliyeti orta, kotasi genis abonelik
 * - premium  : pahali abonelik modeli (Claude Opus, Codex Astra)
 */
export type CostTier = 'cheap' | 'standard' | 'premium';

export const COST_ORDER: Record<CostTier, number> = { cheap: 0, standard: 1, premium: 2 };

export interface ProviderConfig {
  /** Kisa kimlik, or. "orfi". Agent id'si `provider:<slug>` olur. */
  slug: string;
  label: string;
  /** or. https://host:9443/v1 */
  baseUrl: string;
  model: string;
  /** Ajanin guclu yanlari; planlayici ve hakem bunu okur. */
  strengths: string;
  enabled: boolean;
  /**
   * Kod yazma turlarinda da kullanilsin mi. false ise yalnizca koordinasyon
   * (planlama, hakemlik, inceleme) turlarinda gorevlendirilir.
   */
  canWriteCode: boolean;
  /** Bagil maliyet. Belirtilmezse "cheap" kabul edilir: bunlar kullanicinin kendi anahtarlaridir. */
  costTier?: CostTier;
  /** Istek basina uretim siniri. */
  maxTokens: number;
  /** Konsey'in bu saglayicida harcayabilecegi gunluk token butcesi (limit). */
  dailyTokenBudget?: number;
  /** Limitin yuzde kacinin kullanilabilecegi (1-100). */
  usageCapPercent?: number;
}

export type RunPhase =
  | 'idle'
  | 'planning'
  | 'claiming'
  | 'arbitrating'
  | 'executing'
  | 'merging'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TaskComplexity = 'low' | 'medium' | 'high' | 'critical';
export type RunStrategy = 'fast' | 'expert' | 'council';
/** Kullanicinin sectigi calisma modu; auto rotayi istege gore Konsey secer. */
export type RunMode = 'auto' | RunStrategy;
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Tek bir ajan cagrisinda kullanilacak model politikasi. */
export interface ModelSelection {
  model?: string;
  effort?: ReasoningEffort;
  /** Ayni urunun daha ucuz modelleri; adaptor destekliyorsa sirayla dener. */
  fallbackModels?: string[];
}

/** Planlayicinin urettigi tek bir is birimi. */
export interface Task {
  id: string;
  title: string;
  detail: string;
  /** Gorevin dokunmasi beklenen dosya/dizin yollari (proje koku baz alinir). */
  scope: string[];
  /** Bu gorevin baslamasi icin tamamlanmasi gereken gorev id'leri. */
  dependsOn: string[];
  /** Model maliyetini ve muhakeme seviyesini belirleyen planlayici sinifi. */
  complexity: TaskComplexity;
  /** Raster/illustrasyon gibi ChatGPT gorsel araci gerektiren is. */
  requiresVisual: boolean;
  /** Planlayicinin onerdigi ajan; claim turunda degisebilir. */
  suggestedAgent: AgentId | null;
  /** Claim turu sonunda kesinlesen sahip. */
  assignedTo: AgentId | null;
  status: 'pending' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'skipped';
  /** Ajanin gorevi tamamladiktan sonra dondugu ozet. */
  result?: string;
  error?: string;
}

/** Bir ajanin claim turunda verdigi cevap. */
export interface ClaimOffer {
  taskId: string;
  /** 0-100. Ajanin bu gorevi ne kadar sahiplendigi. */
  confidence: number;
  rationale: string;
}

export interface ClaimResponse {
  agent: AgentId;
  offers: ClaimOffer[];
  /** Ajanin ustlenmek istemedigi gorevler icin gerekce. */
  declines: { taskId: string; reason: string }[];
  raw: string;
}

export interface AgentWorkspace {
  agent: AgentId;
  /** Ajanin uzerinde calistigi dizin (worktree ya da ana agac). */
  dir: string;
  branch: string | null;
  /** true ise ana calisma agacinda calisiyor, izole degil. */
  isMainTree: boolean;
}

export interface MergeOutcome {
  agent: AgentId;
  branch: string | null;
  status: 'merged' | 'conflict' | 'empty' | 'skipped' | 'failed';
  conflictFiles: string[];
  commit?: string;
  message?: string;
}

export interface ReviewOutcome {
  reviewer: AgentId;
  verdict: 'approved' | 'changes-requested' | 'unknown';
  summary: string;
  findings: string[];
  raw: string;
}

export interface ValidationOutcome {
  ok: boolean;
  commands: { command: string; ok: boolean; output: string; durationMs: number }[];
  summary: string;
}

export interface AgentUsage {
  agent: AgentId;
  role: 'plan' | 'claim' | 'execute' | 'review' | 'repair';
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs: number;
}

export interface RunRecord {
  id: string;
  projectDir: string;
  prompt: string;
  /** fast=DeepSeek ilk cozum, expert=tek guclu ajan, council=paralel ekip. */
  strategy: RunStrategy;
  phase: RunPhase;
  startedAt: number;
  endedAt?: number;
  baseBranch: string | null;
  baseCommit: string | null;
  integrationBranch: string | null;
  tasks: Task[];
  claims: ClaimResponse[];
  workspaces: AgentWorkspace[];
  merges: MergeOutcome[];
  /** Entegrasyon dalinda calistirilan otomatik kalite kontrolleri. */
  validation?: ValidationOutcome;
  /** Her model turunun olculebildigi kadariyla kullanim kaydi. */
  usage: AgentUsage[];
  review?: ReviewOutcome;
  error?: string;
  /** Planlayicinin tek cumlelik ozeti. */
  summary?: string;
  /** Rota seciminin gerekcesi. */
  routeReason?: string;
  /** Degisen dosyalarin ozeti (git diff --stat). */
  diffStat?: string;
  /** Su an model turu yuruten ajanlar ve rolleri (arayuzde "kim ne yapiyor"). */
  active?: { agent: AgentId; role: AgentUsage['role']; since: number }[];
  /** Sonucun kullanicinin proje klasorune uygulanma durumu. */
  applied?: { ok: boolean; message: string; at: number };
}

/** Arayuze akan olaylar. */
export type KonseyEvent =
  | { type: 'run:started'; run: RunRecord }
  | { type: 'run:phase'; runId: string; phase: RunPhase }
  | { type: 'run:updated'; run: RunRecord }
  | { type: 'run:finished'; run: RunRecord }
  | {
      type: 'agent:status';
      runId: string;
      agent: AgentId;
      status: 'sleeping' | 'available';
      reason?: string;
      retryAt?: number;
      retryHint?: string;
    }
  | { type: 'log'; runId: string; agent: AgentId | 'orchestrator'; level: 'info' | 'warn' | 'error'; text: string; at: number }
  | { type: 'stream'; runId: string; agent: AgentId; chunk: string; at: number }
  /** Ham ciktidan ayiklanmis, insan okur tek satirlik etkinlik (dosya yazdi, komut calistirdi...). */
  | { type: 'activity'; runId: string; agent: AgentId; text: string; tone: 'say' | 'tool' | 'think'; at: number; phase?: RunPhase }
  | { type: 'chat:message'; message: ChatMessage }
  | { type: 'chat:delta'; id: string; thread: ChatMessage['thread']; text: string }
  | { type: 'chat:done'; message: ChatMessage }
  | { type: 'quota:updated'; quotas: AgentQuota[] };

/** Ajan calistirma istegi. */
export interface AgentRunRequest {
  runId: string;
  agent: AgentId;
  cwd: string;
  prompt: string;
  /** Ajanin dosya yazmasina izin verilsin mi. false ise sadece okuma/analiz. */
  allowWrite: boolean;
  /** Orkestratorun rol ve zorluga gore sectigi model. */
  model?: string;
  effort?: ReasoningEffort;
  fallbackModels?: string[];
  /** Milisaniye. Asilirsa surec sonlandirilir. */
  timeoutMs: number;
  /** Sohbet gibi hafif turlar: ek araclar/MCP yuklenmez. */
  lean?: boolean;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

/** Basarisizligin turu; kota/oturum hatalari calismayi tumden bozmamali. */
export type FailureKind = 'auth' | 'quota' | 'capped' | 'timeout' | 'cancelled' | 'unavailable' | 'other';

export interface AgentRunResult {
  agent: AgentId;
  ok: boolean;
  /** Ajanin son metinsel cevabi (varsa ayiklanmis). */
  text: string;
  /** Ham stdout+stderr. */
  raw: string;
  exitCode: number | null;
  durationMs: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  error?: string;
  failureKind?: FailureKind;
  /** Kota hatalarinda, ayristirilabildiyse yeniden denenebilecek zaman. */
  retryHint?: string;
  /** CLI'nin bildirdigi guncel hesap limiti kullanimi (Claude rate_limit_event). */
  limits?: UsageWindow[];
}

/** Bir hesap limit penceresi: 5 saatlik, haftalik ya da Konsey'in gunluk butcesi. */
export interface UsageWindow {
  key: 'five_hour' | 'seven_day' | 'daily';
  label: string;
  /** 0-100 */
  usedPercent: number;
  resetsAt?: number;
}

/** Ajanin limit durumu ve kullanicinin izin verdigi pay. */
export interface AgentQuota {
  agent: AgentId;
  windows: UsageWindow[];
  /** Pencerelerin en yuksegi. Bilinmiyorsa null. */
  usedPercent: number | null;
  /** Kullanicinin izin verdigi azami kullanim yuzdesi (1-100). */
  capPercent: number;
  /** usedPercent >= capPercent: Konsey bu ajani cagirmaz. */
  capped: boolean;
  /** Limitin kaynagi: CLI olayi, yerel oturum kaydi ya da Konsey'in kendi sayaci. */
  source: 'cli' | 'log' | 'local' | 'unknown';
  /** Olcum zamani. */
  observedAt?: number;
  /** Kilit kalkacagi en erken zaman. */
  unlocksAt?: number;
}

/** Konsey'in kendi tuttugu kullanim sayaci (bugun ve toplam). */
export interface AgentUsageTotals {
  agent: AgentId;
  today: { calls: number; tokens: number; costUsd: number; durationMs: number };
  total: { calls: number; tokens: number; costUsd: number; durationMs: number };
}

/** Sohbet mesaji: Konsey masasi ya da bir ajanla birebir konusma. */
export interface ChatMessage {
  id: string;
  /** 'council' ya da birebir konusulan ajan. */
  thread: 'council' | AgentId;
  from: AgentId | 'user' | 'orchestrator';
  text: string;
  at: number;
  /** chat: serbest konusma; run: calisma sirasinda ajanlarin kendi aralarindaki notlari. */
  kind: 'chat' | 'run' | 'error';
  runId?: string;
  pending?: boolean;
}

export interface AgentAvailability {
  agent: AgentId;
  available: boolean;
  detail: string;
  /** Kullanilacak calistirici yol / adres. */
  target?: string;
  /** Kullanilamiyorsa sebebin turu. */
  failureKind?: FailureKind;
  retryHint?: string;
  /** Kota yenilenme zamani biliniyorsa Unix milisaniye. */
  retryAt?: number;
}

/** Ayarlardaki bir entegrasyon (GitHub, Sentry...). Token burada TUTULMAZ. */
export interface IntegrationConfig {
  /** Hazir servis kimligi (github, sentry...) ya da custom-<ad>. */
  id: string;
  enabled: boolean;
  /** Destekleyen servislerde salt okunur baglanti (varsayilan acik). */
  readOnly?: boolean;
  /** Ozel MCP sunucusu: gorunen ad ve adres. */
  label?: string;
  url?: string;
}

/** Ek CLI ajaninin nasil calistirilacagi. */
export interface CliAgentConfig {
  /** Hazir sablon kimligi (gemini, cursor, copilot...). Yoksa ozel CLI. */
  preset?: string;
  /** Ozel CLI: komut adi ya da tam yolu. */
  command?: string;
  /**
   * Ozel CLI: arguman satiri. {prompt} istemin, {model} modelin yeridir.
   * {prompt} yoksa istem stdin'den verilir.
   */
  args?: string;
  /** Istege bagli model adi. */
  model?: string;
}

export interface AgentProfile {
  agent: AgentId;
  label: string;
  /** Planlayiciya verilen "bu ajan neyde iyi" tanimi. Kullanici duzenleyebilir. */
  strengths: string;
  enabled: boolean;
  /** Bagil maliyet; gorev dagitiminda ucuz ajanlar oncelenir. */
  costTier?: CostTier;
  /** Hesap limitinin yuzde kacinin Konsey tarafindan kullanilabilecegi (1-100). */
  usageCapPercent?: number;
  /** Limiti bilinmeyen ajanlar icin gunluk tur butcesi (Antigravity, ek CLI'lar). */
  dailyTurnBudget?: number;
  /** Ek CLI ajanlari icin calistirma tanimi. */
  cli?: CliAgentConfig;
}
