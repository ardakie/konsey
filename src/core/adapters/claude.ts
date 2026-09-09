/**
 * Claude Code adaptoru.
 *
 * `claude -p` resmi non-interactive moddur; abonelik oturumunu kullanir,
 * API anahtari gerektirmez. stream-json ciktisi ile canli akis alinir.
 */
import { runProcess, failure } from './base';
import { classifyFailure } from './failures';
import { findClaude } from '../discovery';
import type { AgentRunRequest, AgentRunResult } from '../../shared/types';

/** stream-json satirlarindan gorunur metni ve sonuc ozetini ayiklar. */
function parseStreamJson(stdout: string): { text: string; resultText: string | null } {
  let assistantText = '';
  let resultText: string | null = null;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') assistantText += block.text;
      }
    } else if (ev.type === 'result') {
      if (typeof ev.result === 'string') resultText = ev.result;
    }
  }
  return { text: assistantText, resultText };
}

export async function runClaude(req: AgentRunRequest): Promise<AgentRunResult> {
  const bin = await findClaude();
  if (!bin) return failure('claude', 'claude CLI bulunamadi.');

  const args = [
    '-p',
    req.prompt,
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

  const res = await runProcess(bin, args, {
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    onChunk: req.onChunk,
  });

  const { text, resultText } = parseStreamJson(res.stdout);
  const finalText = (resultText ?? text).trim();
  const ok = res.exitCode === 0 && !res.timedOut && !res.aborted && finalText.length > 0;

  if (ok) {
    return {
      agent: 'claude', ok: true, text: finalText, raw: res.raw,
      exitCode: res.exitCode, durationMs: res.durationMs,
    };
  }

  // Kota ve oturum hatalari, calismayi tumden bozmamasi icin ayirt edilir.
  const classified = classifyFailure(finalText + '\n' + res.raw);
  const kind = res.timedOut ? 'timeout' : res.aborted ? 'cancelled' : classified.kind;

  return {
    agent: 'claude', ok: false, text: finalText, raw: res.raw,
    exitCode: res.exitCode, durationMs: res.durationMs,
    error: res.timedOut
      ? 'Zaman asimi'
      : res.aborted
        ? 'Iptal edildi'
        : finalText || `claude cikis kodu ${res.exitCode}`,
    failureKind: kind,
    retryHint: classified.retryHint,
  };
}
