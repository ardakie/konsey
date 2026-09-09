/**
 * Kalici ayarlar: ~/.konsey/config.json
 *
 * Bu dosyada API anahtari TUTULMAZ; anahtarlar Keychain'dedir (bkz. secrets.ts).
 * Burada yalnizca hangi saglayicinin var oldugu, adresi ve modeli tutulur.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentId, AgentProfile, ProviderConfig } from '../shared/types';
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
}

export const DEFAULT_CONFIG: KonseyConfig = {
  profiles: DEFAULT_PROFILES,
  providers: [],
  coordinator: null,
  reviewer: null,
  recentProjects: [],
};

export async function loadConfig(): Promise<KonseyConfig> {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8')) as Partial<KonseyConfig>;
    return {
      profiles: parsed.profiles?.length ? parsed.profiles : DEFAULT_PROFILES,
      providers: parsed.providers ?? [],
      coordinator: parsed.coordinator ?? null,
      reviewer: parsed.reviewer ?? null,
      recentProjects: parsed.recentProjects ?? [],
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
