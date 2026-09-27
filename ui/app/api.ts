/** Arayuzun ana surece acilan kopru tanimi. */
import type {
  AgentAvailability,
  AgentQuota,
  AgentUsageTotals,
  ChatMessage,
  KonseyEvent,
  ProviderConfig,
  AgentProfile,
  AgentId,
  RunMode,
  RunRecord,
} from '../../src/shared/types';
import { createMockApi } from '../devMock';

export interface ImageAttachment {
  path: string;
  name: string;
  dataUrl: string;
}

export interface KonseyConfig {
  profiles: AgentProfile[];
  providers: ProviderConfig[];
  coordinator: AgentId | null;
  reviewer: AgentId | null;
  recentProjects: string[];
  autoApply: boolean;
  dismissedClis?: string[];
  ui: {
    theme: 'system' | 'light' | 'dark';
    mode: RunMode;
    chatOpen: boolean;
    officeOpen?: boolean;
    language?: 'system' | 'tr' | 'en';
    onboarded?: boolean;
  };
}

export interface SystemInfo {
  platform: string;
  lang: 'tr' | 'en';
  version: string;
  git: boolean;
  node: boolean;
}

/** Hazirlik listesindeki bir madde (git, Node.js, oturum, macOS izni). */
export interface SetupCheck {
  id: string;
  title: string;
  detail: string;
  state: 'ok' | 'missing' | 'denied' | 'unknown';
  required: boolean;
  action?: { label: string; id: string };
}

/** Entegrasyon satiri; token degeri arayuze hic gelmez. */
export interface IntegrationEntry {
  id: string;
  label: string;
  blurb: string;
  tokenUrl: string;
  tokenHint: string;
  supportsReadOnly: boolean;
  readOnly: boolean;
  enabled: boolean;
  hasToken: boolean;
  engines: string[];
  custom: boolean;
}

/** Kurulabilir/baglanabilir bir ajan (hazir uclu ya da CLI sablonu). */
export interface ConnectEntry {
  id: string;
  label: string;
  install: string | null;
  login: string | null;
  docs: string;
  needsNode: boolean;
  installed: boolean;
}

export interface ProjectInfo {
  dir: string;
  isGit: boolean;
  hasCommit: boolean;
}

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

export interface KonseyApi {
  lang: string;
  platform: string;
  system(): Promise<SystemInfo>;
  connectList(): Promise<ConnectEntry[]>;
  connectRun(id: string, action: 'install' | 'login'): Promise<{ ok: boolean; error?: string; opened?: string; fix?: string }>;
  setupChecks(projectDir?: string | null): Promise<SetupCheck[]>;
  setupFix(id: string): Promise<{ ok: boolean; error?: string }>;
  openExternal(url: string): Promise<boolean>;
  relaunch(): Promise<void>;
  checkUpdate(): Promise<{ current: string; latest: string | null; available: boolean; url: string }>;
  openDownloads(): Promise<boolean>;
  integrations(): Promise<IntegrationEntry[]>;
  saveIntegration(input: { id: string; token?: string; readOnly?: boolean; enabled?: boolean; label?: string; url?: string }): Promise<{ ok: boolean; error?: string }>;
  removeIntegration(id: string): Promise<boolean>;
  testIntegration(id: string, token?: string): Promise<{ ok: boolean; detail: string }>;

  browser(action: string, value?: unknown): Promise<string | undefined>;
  simulator(action: string, id?: string): Promise<any>;

  availability(preferWorkspace?: string): Promise<AgentAvailability[]>;
  quotas(refresh?: boolean): Promise<AgentQuota[]>;
  usage(): Promise<AgentUsageTotals[]>;

  pickImages(): Promise<ImageAttachment[]>;
  imagesFromPaths(paths: string[]): Promise<ImageAttachment[]>;
  saveImage(input: { name?: string; mime: string; bytes: ArrayBuffer }): Promise<ImageAttachment>;
  filePath(file: File): string;

  loadConfig(): Promise<KonseyConfig>;
  saveConfig(config: KonseyConfig): Promise<boolean>;
  setTheme(theme: string): Promise<boolean>;

  setProviderKey(slug: string, apiKey: string): Promise<boolean>;
  hasProviderKey(slug: string): Promise<boolean>;
  testProvider(provider: unknown, apiKey?: string): Promise<{ ok: boolean; models: string[]; error?: string }>;

  pickProject(): Promise<ProjectInfo | null>;
  selectProject(dir: string): Promise<ProjectInfo>;
  describeProject(dir: string): Promise<ProjectInfo>;
  prepareProject(dir: string): Promise<{ ok: boolean; created: boolean; message: string }>;
  openPath(target: string): Promise<void>;
  reveal(target: string): Promise<void>;

  loadChats(projectDir: string | null): Promise<Record<string, ChatMessage[]>>;
  sendChat(args: { projectDir: string | null; thread: string; text: string }): Promise<{ ok: boolean; error?: string }>;
  cancelChat(thread: string): Promise<boolean>;
  clearChat(projectDir: string | null, thread: string): Promise<boolean>;

  listRuns(projectDir?: string | null): Promise<RunSummary[]>;
  getRun(id: string): Promise<StoredRun | null>;
  deleteRun(id: string): Promise<boolean>;
  applyRun(id: string): Promise<{ ok: boolean; message: string }>;

  startRun(args: { projectDir: string; prompt: string; mode?: RunMode }): Promise<{ ok: boolean; record?: RunRecord; error?: string }>;
  cancelRun(): Promise<boolean>;

  onEvent(handler: (event: KonseyEvent) => void): () => void;
}

declare global {
  interface Window {
    konsey?: KonseyApi;
  }
}

export const isDesktop = Boolean(window.konsey);

// Electron disinda (tarayicida) acildiginda arayuz sahte kopruyle calisir.
export const api: KonseyApi = window.konsey ?? createMockApi();
