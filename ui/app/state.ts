/**
 * Arayuz durumu ve cizim zamanlayicisi.
 *
 * Moduller birbirini dogrudan cagirmaz; durumu degistirip invalidate() der,
 * ilgili bolumler bir sonraki karede yeniden cizilir.
 */
import type {
  AgentAvailability,
  AgentId,
  AgentQuota,
  AgentUsageTotals,
  ChatMessage,
  RunMode,
  RunPhase,
  RunRecord,
} from '../../src/shared/types';
import type { ActivityLine, ImageAttachment, KonseyConfig, ProjectInfo, RunSummary, SystemInfo } from './api';
import { h } from './dom';
import { L, locale } from '../../src/shared/i18n';
import { charIndexFor, headFor } from './heads';

export type Part = 'sidebar' | 'flow' | 'chat' | 'composer' | 'settings' | 'topbar' | 'guide';
export type Thread = 'council' | AgentId;

export interface State {
  /** Isletim sistemi, git ve node durumu (kurulum uyarilari icin). */
  system: SystemInfo | null;
  config: KonseyConfig;
  project: ProjectInfo | null;
  availability: AgentAvailability[];
  quotas: AgentQuota[];
  usage: AgentUsageTotals[];
  runs: RunSummary[];
  /** null: yeni gorev ekrani. */
  selectedRunId: string | null;
  live: { record: RunRecord; activity: ActivityLine[]; phase: RunPhase } | null;
  viewed: { record: RunRecord; activity: ActivityLine[] } | null;
  running: boolean;
  chats: Record<string, ChatMessage[]>;
  chatThread: Thread;
  chatBusy: Set<string>;
  unread: Set<string>;
  sidePane: 'chat' | 'preview';
  view: 'flow' | 'office';
  attachments: ImageAttachment[];
  openLanes: Set<string>;
  closedLanes: Set<string>;
  settingsTab: 'agents' | 'providers' | 'general';
  /** Uyuyan (kota/pay dolu) ajanlar: ofis ve kenar cubugu icin. */
  sleeping: Map<string, { retryAt?: number; reason?: string }>;
}

export const state: State = {
  config: {
    profiles: [],
    providers: [],
    coordinator: null,
    reviewer: null,
    recentProjects: [],
    autoApply: true,
    ui: { theme: 'system', mode: 'auto', chatOpen: true },
  },
  project: null,
  availability: [],
  quotas: [],
  usage: [],
  runs: [],
  selectedRunId: null,
  live: null,
  viewed: null,
  running: false,
  chats: {},
  chatThread: 'council',
  chatBusy: new Set(),
  unread: new Set(),
  sidePane: 'chat',
  view: 'flow',
  attachments: [],
  openLanes: new Set(),
  closedLanes: new Set(),
  settingsTab: 'agents',
  sleeping: new Map(),
  system: null,
};

const renderers = new Map<Part, () => void>();
const dirty = new Set<Part>();
let frame = 0;

export function register(part: Part, render: () => void): void {
  renderers.set(part, render);
}

export function invalidate(...parts: Part[]): void {
  for (const part of parts) dirty.add(part);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const todo = [...dirty];
    dirty.clear();
    for (const part of todo) {
      try {
        renderers.get(part)?.();
      } catch (error) {
        console.error(`[${part}]`, error);
      }
    }
  });
}

// --------------------------------------------------------------- ajanlar

export interface AgentView {
  id: AgentId;
  label: string;
  color: string;
  glyph: string;
  enabled: boolean;
  available: boolean;
  detail: string;
  quota?: AgentQuota;
  kind: 'builtin' | 'provider' | 'cli';
}

const BUILTIN_META: Record<string, { label: string; color: string; glyph: string }> = {
  claude: { label: 'Claude', color: '#D97757', glyph: '✳' },
  codex: { label: 'Codex', color: '#6C63E8', glyph: '◈' },
  antigravity: { label: 'Antigravity', color: '#3B8BE6', glyph: '▲' },
};

/** Hazir CLI sablonlarinin marka renkleri (src/core/clis.ts ile ayni). */
const CLI_COLORS: Record<string, string> = {
  gemini: '#4C8DF6', cursor: '#9AA0AA', copilot: '#8E6BE8', opencode: '#E8A33A',
  qwen: '#6A5CF5', amp: '#F25C54', droid: '#E0773C', aider: '#3FA66B',
};

const PROVIDER_COLORS = ['#E0A030', '#D6649A', '#2FA88F', '#8A63D2', '#E2735A', '#4F9BC8'];

function hash(text: string): number {
  let value = 0;
  for (const ch of text) value = (value * 31 + ch.charCodeAt(0)) >>> 0;
  return value;
}

export function metaFor(agent: string): { label: string; color: string; glyph: string } {
  if (agent === 'orchestrator') return { label: 'Konsey', color: '#16171B', glyph: '✦' };
  if (agent === 'user') return { label: L('Sen', 'You'), color: '#8F929C', glyph: '•' };
  if (BUILTIN_META[agent]) return BUILTIN_META[agent];
  if (agent.startsWith('cli:')) {
    const slug = agent.slice(4);
    const label = state.config.profiles.find((p) => p.agent === agent)?.label ?? slug;
    return {
      label,
      color: CLI_COLORS[slug] ?? PROVIDER_COLORS[hash(slug) % PROVIDER_COLORS.length],
      glyph: (label.trim()[0] ?? '?').toLocaleUpperCase(locale()),
    };
  }
  const slug = agent.replace(/^provider:/, '');
  const provider = state.config.providers.find((p) => p.slug === slug);
  const label = provider?.label ?? slug;
  return {
    label,
    color: PROVIDER_COLORS[hash(slug) % PROVIDER_COLORS.length],
    glyph: (label.trim()[0] ?? '?').toLocaleUpperCase(locale()),
  };
}

export function labelFor(agent: string): string {
  return metaFor(agent).label;
}

export function agents(): AgentView[] {
  const list: AgentView[] = [];
  for (const profile of state.config.profiles) {
    const availability = state.availability.find((a) => a.agent === profile.agent);
    list.push({
      id: profile.agent,
      ...metaFor(profile.agent),
      enabled: profile.enabled,
      available: availability?.available ?? false,
      detail: availability?.detail ?? L('Kontrol ediliyor…', 'Checking…'),
      quota: state.quotas.find((q) => q.agent === profile.agent),
      kind: profile.agent.startsWith('cli:') ? 'cli' : 'builtin',
    });
  }
  for (const provider of state.config.providers) {
    const id = `provider:${provider.slug}` as AgentId;
    const availability = state.availability.find((a) => a.agent === id);
    list.push({
      id,
      ...metaFor(id),
      enabled: provider.enabled,
      available: availability?.available ?? false,
      detail: availability?.detail ?? provider.model,
      quota: state.quotas.find((q) => q.agent === id),
      kind: 'provider',
    });
  }
  return list;
}

/** Ajanin su an ise alinip alinamayacagi ve nedeni. */
export function readiness(agent: AgentView): { ok: boolean; text: string; tone: '' | 'warn' | 'bad' } {
  if (!agent.enabled) return { ok: false, text: L('Kapalı', 'Off'), tone: '' };
  if (!agent.available) return { ok: false, text: shortDetail(agent), tone: 'bad' };
  if (agent.quota?.capped) {
    return { ok: false, text: L(`Pay doldu · %${agent.quota.usedPercent} / %${agent.quota.capPercent}`, `Share used up · ${agent.quota.usedPercent}% / ${agent.quota.capPercent}%`), tone: 'warn' };
  }
  if (state.sleeping.has(agent.id)) return { ok: false, text: L('Kota uykusunda', 'Sleeping (quota)'), tone: 'warn' };
  const used = agent.quota?.usedPercent;
  if (used !== null && used !== undefined) {
    return { ok: true, text: L(`%${Math.round(used)} kullanıldı · pay %${agent.quota!.capPercent}`, `${Math.round(used)}% used · share ${agent.quota!.capPercent}%`), tone: '' };
  }
  return { ok: true, text: L('Hazır', 'Ready'), tone: '' };
}

function shortDetail(agent: AgentView): string {
  if (agent.kind === 'provider') return L('API anahtarı yok', 'No API key');
  return L('Kurulu değil', 'Not installed');
}

export function setAgentEnabled(id: AgentId, enabled: boolean): void {
  const profile = state.config.profiles.find((p) => p.agent === id);
  if (profile) profile.enabled = enabled;
  const provider = state.config.providers.find((p) => `provider:${p.slug}` === id);
  if (provider) provider.enabled = enabled;
}

export function avatar(agent: string, size: '' | 'sm' | 'xs' | 'lg' = '', live = false): HTMLElement {
  const meta = metaFor(agent);
  const head = headFor(charIndexFor(agent, state.config.providers.map((p) => p.slug)));
  const node = h('span', {
    class: `avatar ${size} ${agent === 'orchestrator' ? 'council' : ''} ${live ? 'live' : ''} ${head ? 'pixel' : ''}`,
    title: meta.label,
    'aria-hidden': 'true',
  }, head ? h('i', { class: 'avatar-head', style: { backgroundImage: `url(${head})` } }) : meta.glyph);
  node.style.setProperty('--c', meta.color);
  return node;
}

export const MODES: { key: RunMode; label: string; sub: string }[] = [
  { key: 'auto', label: L('Otomatik', 'Auto'), sub: L('İşin büyüklüğüne göre Konsey rotayı seçer.', 'Konsey picks the route based on the size of the job.') },
  { key: 'fast', label: L('Hızlı yol', 'Fast lane'), sub: L('Tek ucuz ajan (API sağlayıcı) doğrudan yapar.', 'A single cheap agent (API provider) does it directly.') },
  { key: 'expert', label: L('Uzman', 'Expert'), sub: L('Tek güçlü ajan yapar, başka biri kontrol eder.', 'One capable agent does it, another checks the work.') },
  { key: 'council', label: L('Konsey', 'Council'), sub: L('İş bölünür, ajanlar paralel çalışır, sonuç birleşir.', 'The work is split, agents run in parallel, results are merged.') },
];

export const STRATEGY_LABEL: Record<string, string> = {
  fast: L('Hızlı yol', 'Fast lane'),
  expert: L('Uzman', 'Expert'),
  council: L('Konsey', 'Council'),
};

export const PHASE_LABEL: Record<string, string> = {
  idle: L('Hazır', 'Ready'),
  planning: L('Planlanıyor', 'Planning'),
  claiming: L('Görevler paylaşılıyor', 'Tasks being claimed'),
  arbitrating: L('Hakem karar veriyor', 'Arbiter deciding'),
  executing: L('Ajanlar çalışıyor', 'Agents working'),
  merging: L('Birleştiriliyor', 'Merging'),
  reviewing: L('İnceleniyor', 'Reviewing'),
  done: L('Tamamlandı', 'Done'),
  failed: L('Tamamlanamadı', 'Failed'),
  cancelled: L('Durduruldu', 'Cancelled'),
};

/** Seçili gorevin gosterilecek kaydi: canli ya da gecmisten yuklenmis. */
export function currentRun(): { record: RunRecord; activity: ActivityLine[]; live: boolean } | null {
  if (state.live && state.selectedRunId === state.live.record.id) {
    return { record: state.live.record, activity: state.live.activity, live: state.running };
  }
  if (state.viewed && state.selectedRunId === state.viewed.record.id) {
    return { ...state.viewed, live: false };
  }
  return null;
}

export async function saveConfigSoon(save: (c: KonseyConfig) => Promise<unknown>): Promise<void> {
  window.clearTimeout(saveTimer);
  return new Promise((resolve) => {
    saveTimer = window.setTimeout(async () => {
      await save(state.config);
      resolve();
    }, 350);
  });
}
let saveTimer = 0;
