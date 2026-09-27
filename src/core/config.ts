/**
 * Kalici ayarlar: ~/.konsey/config.json
 *
 * Bu dosyada API anahtari TUTULMAZ; anahtarlar Keychain'dedir (bkz. secrets.ts).
 * Burada yalnizca hangi saglayicinin var oldugu, adresi ve modeli tutulur.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentId, AgentProfile, IntegrationConfig, ProviderConfig } from '../shared/types';
import { DEFAULT_PROFILES } from './prompts';

const DIR = path.join(os.homedir(), '.konsey');
const FILE = path.join(DIR, 'config.json');

export interface KonseyConfig {
  profiles: AgentProfile[];
  providers: ProviderConfig[];
  /** Planlama ve hakemlik turlarini yapan ajan. */
  coordinator: AgentId | null;
  /** Birlesik sonucu denetleyen ajan. */
  reviewer: AgentId | null;
  /** Son kullanilan proje dizinleri. */
  recentProjects: string[];
  /** Basarili is sonucu proje klasorune otomatik uygulansin mi. */
  autoApply: boolean;
  /** Kullanicinin listeden kaldirdigi CLI sablonlari; otomatik kesif bunlari geri eklemez. */
  dismissedClis: string[];
  /** Bagli servisler (GitHub, Sentry...). Token'lar guvenli depodadir. */
  integrations: IntegrationConfig[];
  /** Arayuz tercihleri. */
  ui: {
    theme: 'system' | 'light' | 'dark';
    mode: 'auto' | 'fast' | 'expert' | 'council';
    chatOpen: boolean;
    officeOpen: boolean;
    /** Arayuz dili; 'system' isletim sisteminin dilini izler. */
    language: 'system' | 'tr' | 'en';
    /** "Nasil calisir" tanitimi gosterildi mi. */
    onboarded: boolean;
    /** Acilista GitHub'dan yeni surum denetimi (yalnizca surum numarasi okunur). */
    updateCheck: boolean;
    /** Tartismalarin kac turla baslayacagi (1-3). */
    debateDepth?: number;
    /** Fikirden donusen yeni projelerin acildigi son klasor. */
    projectsDir?: string;
  };
}

export const DEFAULT_CONFIG: KonseyConfig = {
  profiles: DEFAULT_PROFILES,
  providers: [],
  coordinator: null,
  reviewer: null,
  recentProjects: [],
  autoApply: true,
  dismissedClis: [],
  integrations: [],
  ui: { theme: 'system', mode: 'auto', chatOpen: true, officeOpen: true, language: 'system', onboarded: false, updateCheck: true },
};

/** Kayitli profillerde eksik kalan hazir ajanlari varsayilanlarla tamamlar. */
function mergeProfiles(saved: AgentProfile[] | undefined): AgentProfile[] {
  const list = saved?.length ? saved : DEFAULT_PROFILES;
  const merged = DEFAULT_PROFILES.map((def) => ({ ...def, ...(list.find((p) => p.agent === def.agent) ?? {}) }));
  return [...merged, ...list.filter((p) => !DEFAULT_PROFILES.some((d) => d.agent === p.agent))];
}

export async function loadConfig(): Promise<KonseyConfig> {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8')) as Partial<KonseyConfig>;
    return {
      profiles: mergeProfiles(parsed.profiles),
      providers: parsed.providers ?? [],
      coordinator: parsed.coordinator ?? null,
      reviewer: parsed.reviewer ?? null,
      recentProjects: parsed.recentProjects ?? [],
      autoApply: parsed.autoApply ?? true,
      dismissedClis: parsed.dismissedClis ?? [],
      integrations: parsed.integrations ?? [],
      ui: { ...DEFAULT_CONFIG.ui, ...(parsed.ui ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export async function saveConfig(config: KonseyConfig): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(config, null, 2), 'utf8');
}

export function configPath(): string {
  return FILE;
}

/** Saglayici tanimini agent id'sinden bulur. */
export function findProvider(config: KonseyConfig, agent: AgentId): ProviderConfig | null {
  if (!agent.startsWith('provider:')) return null;
  const slug = agent.slice('provider:'.length);
  return config.providers.find((p) => p.slug === slug) ?? null;
}
