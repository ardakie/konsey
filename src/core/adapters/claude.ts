/**
 * Claude Code adaptoru.
 *
 * `claude -p` resmi non-interactive moddur; abonelik oturumunu kullanir,
 * API anahtari gerektirmez. stream-json ciktisi ile canli akis alinir.
 */
import { runProcess, failure } from './base';
import { classifyFailure } from './failures';
import { findClaude } from '../discovery';
import { claudeWindowsFromEvent } from '../usage';
import { L } from '../../shared/i18n';
import type { AgentRunRequest, AgentRunResult, UsageWindow } from '../../shared/types';

/** stream-json satirlarindan gorunur metni ve sonuc ozetini ayiklar. */
export function parseStreamJson(stdout: string): {
  text: string;
  resultText: string | null;
  usage?: AgentRunResult['usage'];
  limits?: UsageWindow[];
} {
  let assistantText = '';
  let resultText: string | null = null;
  let usage: AgentRunResult['usage'];
  let limits: UsageWindow[] | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
      const windows = claudeWindowsFromEvent(ev.rate_limit_info);
      if (windows.length) limits = windows;
    } else if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') assistantText += block.text;
      }
    } else if (ev.type === 'result') {
      if (typeof ev.result === 'string') resultText = ev.result;
      const u = ev.usage ?? ev.modelUsage;
      if (u) {
        const cacheWrite = Number(u.cache_creation_input_tokens ?? 0);
        const inputTokens = Number(u.input_tokens ?? u.inputTokens ?? 0) + cacheWrite;
        const outputTokens = Number(u.output_tokens ?? u.outputTokens ?? 0);
        usage = {
          inputTokens,
          outputTokens,
          cachedInputTokens: Number(u.cache_read_input_tokens ?? u.cachedInputTokens ?? 0),
          totalTokens: inputTokens + outputTokens,
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
        };
      }
    }
  }
  return { text: assistantText, resultText, usage, limits };
}

export async function runClaude(req: AgentRunRequest): Promise<AgentRunResult> {
  const bin = await findClaude();
  if (!bin) return failure('claude', L('claude CLI bulunamadı.', 'claude CLI was not found.'));

  // Istem stdin'den verilir: Windows'ta komut satiri 32 bin karakterle sinirli.
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    // Yazma izni: gorev yurutmede duzenlemeler otomatik kabul edilir,
    // analiz/plan turlarinda ajan hicbir sey degistiremez.
    '--permission-mode', req.allowWrite ? 'acceptEdits' : 'plan',
    '--add-dir', req.cwd,
  ];

  if (req.model) args.push('--model', req.model);
  if (req.effort) args.push('--effort', req.effort);
  if (req.fallbackModels?.length) args.push('--fallback-model', req.fallbackModels.join(','));
  // Sohbet turlari hizli olmali: kullanicinin MCP sunuculari ve beceri listesi yuklenmez.
  if (req.lean) args.push('--strict-mcp-config', '--disable-slash-commands');

  const res = await runProcess(bin, args, {
    cwd: req.cwd,
    stdin: req.prompt,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    onChunk: req.onChunk,
  });

  const { text, resultText, usage, limits } = parseStreamJson(res.stdout);
  const finalText = (resultText ?? text).trim();
  const ok = res.exitCode === 0 && !res.timedOut && !res.aborted && finalText.length > 0;

  if (ok) {
    return {
      agent: 'claude', ok: true, text: finalText, raw: res.raw,
      exitCode: res.exitCode, durationMs: res.durationMs, usage, limits,
    };
  }

  // Kota ve oturum hatalari, calismayi tumden bozmamasi icin ayirt edilir.
  const classified = classifyFailure(finalText + '\n' + res.raw);
  const kind = res.timedOut ? 'timeout' : res.aborted ? 'cancelled' : classified.kind;

  return {
    agent: 'claude', ok: false, text: finalText, raw: res.raw,
    exitCode: res.exitCode, durationMs: res.durationMs,
    error: res.timedOut
      ? L('Zaman aşımı', 'Timed out')
      : res.aborted
        ? L('İptal edildi', 'Cancelled')
        : finalText || L(`claude çıkış kodu ${res.exitCode}`, `claude exited with code ${res.exitCode}`),
    failureKind: kind,
    retryHint: classified.retryHint,
    usage,
    limits,
  };
}
