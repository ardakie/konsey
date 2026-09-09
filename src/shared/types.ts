/** Konsey — ortak tip tanimlari (hem ana surec hem arayuz kullanir). */

/** Kendi launcher'i olan, dosya duzenleyebilen hazir ajanlar. */
export type BuiltinAgentId = 'claude' | 'codex' | 'antigravity';

/**
 * Kullanicinin kendi API anahtariyla ekledigi OpenAI uyumlu saglayicilar.
 * Kimlikleri `provider:<slug>` bicimindedir; boylece hazir ajanlarla
 * ayni tip icinde tasinabilir ama karistirilamaz.
 */
export type ProviderAgentId = `provider:${string}`;

export type AgentId = BuiltinAgentId | ProviderAgentId;

export const BUILTIN_AGENTS: BuiltinAgentId[] = ['claude', 'codex', 'antigravity'];

export function isProviderAgent(id: AgentId): id is ProviderAgentId {
  return id.startsWith('provider:');
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

export interface RunRecord {
  id: string;
  projectDir: string;
  prompt: string;
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
  review?: ReviewOutcome;
  error?: string;
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
  | { type: 'stream'; runId: string; agent: AgentId; chunk: string; at: number };

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
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

/** Basarisizligin turu; kota/oturum hatalari calismayi tumden bozmamali. */
export type FailureKind = 'auth' | 'quota' | 'timeout' | 'cancelled' | 'unavailable' | 'other';

export interface AgentRunResult {
  agent: AgentId;
  ok: boolean;
  /** Ajanin son metinsel cevabi (varsa ayiklanmis). */
  text: string;
  /** Ham stdout+stderr. */
  raw: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
  failureKind?: FailureKind;
  /** Kota hatalarinda, ayristirilabildiyse yeniden denenebilecek zaman. */
  retryHint?: string;
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

export interface AgentProfile {
  agent: AgentId;
  label: string;
  /** Planlayiciya verilen "bu ajan neyde iyi" tanimi. Kullanici duzenleyebilir. */
  strengths: string;
  enabled: boolean;
  /** Bagil maliyet; gorev dagitiminda ucuz ajanlar oncelenir. */
  costTier?: CostTier;
}
