import { runClaude } from './claude';
import { runCodex } from './codex';
import { runAntigravity } from './antigravity';
import { runProviderAgent, runProviderText } from '../providers/agent';
import { cliSlug, presetFor, runCliAgent } from '../clis';
import { integrationNote, type ActiveIntegration } from '../integrations';
import { L } from '../../shared/i18n';
import { getSecret } from '../secrets';
import { failure } from './base';
import type {
  AgentId,
  AgentProfile,
  AgentRunRequest,
  AgentRunResult,
  ProviderConfig,
} from '../../shared/types';
import { isCliAgent, isProviderAgent, providerSlug } from '../../shared/types';

export interface RunContext {
  /** Kullanicinin ekledigi saglayicilar; provider:* ajanlari icin gerekli. */
  providers?: ProviderConfig[];
  /** Ajan profilleri; cli:* ajanlarinin calistirma tanimi buradadir. */
  profiles?: AgentProfile[];
  /** Kullanicinin bagladigi servisler; Claude ve Codex'e MCP olarak verilir. */
  integrations?: ActiveIntegration[];
}

export async function runAgent(
  req: AgentRunRequest,
  ctx: RunContext = {},
): Promise<AgentRunResult> {
  if (isCliAgent(req.agent)) {
    return runCliAgent(req, ctx.profiles?.find((p) => p.agent === req.agent));
  }

  if (isProviderAgent(req.agent)) {
    const slug = providerSlug(req.agent);
    const provider = ctx.providers?.find((p) => p.slug === slug);
    if (!provider) {
      return failure(req.agent, L(`Sağlayıcı tanımı bulunamadı: ${slug}`, `Provider definition not found: ${slug}`));
    }

    const apiKey = await getSecret(provider.slug) || process.env[`${provider.slug.toUpperCase()}_API_KEY`];
    if (!apiKey) {
      const res = failure(req.agent, L(`${provider.label} için API anahtarı kayıtlı değil.`, `No API key saved for ${provider.label}.`));
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
    case 'codex': {
      const integrations = ctx.integrations ?? [];
      const note = integrationNote(integrations, req.agent);
      const withNote = note ? { ...req, prompt: `${req.prompt}\n\n${note}` } : req;
      return req.agent === 'claude' ? runClaude(withNote, integrations) : runCodex(withNote, integrations);
    }
    case 'antigravity':
      // Antigravity'de bir modelin kotasi doldugunda ayni uygulamanin daha
      // ucuz modeline gec; ancak hepsi tukendiyse ajan seviyesinde fallback yapilsin.
      let lastAntigravityResult: AgentRunResult | null = null;
      for (const model of [req.model ?? 'pro', ...(req.fallbackModels ?? [])]) {
        const result = await runAntigravity({ ...req, model: model as 'pro' | 'flash' | 'flash_lite' });
        lastAntigravityResult = result;
        if (result.ok || result.failureKind !== 'quota') return result;
        req.onChunk?.(L(`\n[Konsey] ${model} kotası doldu; sıradaki Antigravity modeli deneniyor.\n`, `\n[Konsey] ${model} quota is full; trying the next Antigravity model.\n`));
      }
      return lastAntigravityResult!;
    default:
      return failure(req.agent, L(`Bilinmeyen ajan: ${req.agent}`, `Unknown agent: ${req.agent}`));
  }
}

const BUILTIN_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export function agentLabel(agent: AgentId, providers: ProviderConfig[] = [], profiles: AgentProfile[] = []): string {
  if (isCliAgent(agent)) {
    return profiles.find((p) => p.agent === agent)?.label ?? presetFor(cliSlug(agent))?.label ?? cliSlug(agent);
  }
  if (isProviderAgent(agent)) {
    const slug = providerSlug(agent);
    return providers.find((p) => p.slug === slug)?.label ?? slug;
  }
  return BUILTIN_LABELS[agent] ?? agent;
}

/** Geriye donuk kolaylik: hazir ajanlarin etiketleri. */
export const AGENT_LABEL = BUILTIN_LABELS;
