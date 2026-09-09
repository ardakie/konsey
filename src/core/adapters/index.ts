import { runClaude } from './claude';
import { runCodex } from './codex';
import { runAntigravity } from './antigravity';
import { runProviderAgent, runProviderText } from '../providers/agent';
import { getSecret } from '../secrets';
import { failure } from './base';
import type {
  AgentId,
  AgentRunRequest,
  AgentRunResult,
  ProviderConfig,
} from '../../shared/types';
import { isProviderAgent, providerSlug } from '../../shared/types';

export interface RunContext {
  /** Kullanicinin ekledigi saglayicilar; provider:* ajanlari icin gerekli. */
  providers?: ProviderConfig[];
}

export async function runAgent(
  req: AgentRunRequest,
  ctx: RunContext = {},
): Promise<AgentRunResult> {
  if (isProviderAgent(req.agent)) {
    const slug = providerSlug(req.agent);
    const provider = ctx.providers?.find((p) => p.slug === slug);
    if (!provider) {
      return failure(req.agent, `Saglayici tanimi bulunamadi: ${slug}`);
    }

    const apiKey = await getSecret(provider.slug) || process.env[`${provider.slug.toUpperCase()}_API_KEY`];
    if (!apiKey) {
      const res = failure(req.agent, `${provider.label} icin API anahtari Keychain'de yok.`);
      res.failureKind = 'auth';
      return res;
    }

    const common = {
      provider,
      apiKey,
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onChunk: req.onChunk,
    };

    // Salt okunur turlar tek atislik metin cagrisiyla cok daha ucuz.
    return req.allowWrite
      ? runProviderAgent({ ...common, allowWrite: true })
      : runProviderText(common);
  }

  switch (req.agent) {
    case 'claude':
      return runClaude(req);
    case 'codex':
      return runCodex(req);
    case 'antigravity':
      // Antigravity'de bir modelin kotasi doldugunda ayni uygulamanin daha
      // ucuz modeline gec; ancak hepsi tukendiyse ajan seviyesinde fallback yapilsin.
      let lastAntigravityResult: AgentRunResult | null = null;
      for (const model of [req.model ?? 'pro', ...(req.fallbackModels ?? [])]) {
        const result = await runAntigravity({ ...req, model: model as 'pro' | 'flash' | 'flash_lite' });
        lastAntigravityResult = result;
        if (result.ok || result.failureKind !== 'quota') return result;
        req.onChunk?.(`\n[Konsey] ${model} kotasi doldu; siradaki Antigravity modeli deneniyor.\n`);
      }
      return lastAntigravityResult!;
    default:
      return failure(req.agent, `Bilinmeyen ajan: ${req.agent}`);
  }
}

const BUILTIN_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export function agentLabel(agent: AgentId, providers: ProviderConfig[] = []): string {
  if (isProviderAgent(agent)) {
    const slug = providerSlug(agent);
    return providers.find((p) => p.slug === slug)?.label ?? slug;
  }
  return BUILTIN_LABELS[agent] ?? agent;
}

/** Geriye donuk kolaylik: hazir ajanlarin etiketleri. */
export const AGENT_LABEL = BUILTIN_LABELS;
