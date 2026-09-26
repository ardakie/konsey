/**
 * Codex adaptoru.
 *
 * CLI, ChatGPT.app paketinin icinde geliyor ve ChatGPT aboneligiyle
 * kimlik dogruluyor (~/.codex/auth.json). `codex exec` resmi non-interactive
 * moddur; --json ile olay akisi, -o ile son mesaj dosyaya yazilir.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runProcess, failure } from './base';
import { classifyFailure } from './failures';
import { findCodex } from '../discovery';
import { L } from '../../shared/i18n';
import type { AgentRunRequest, AgentRunResult } from '../../shared/types';

/** JSONL olaylarindan ajanin urettigi metni toplar (son mesaj dosyasi yoksa yedek). */
function parseJsonl(stdout: string): { text: string; usage?: AgentRunResult['usage'] } {
  let text = '';
  let usage: AgentRunResult['usage'];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const msg = ev?.msg ?? ev;
    if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
      text = ev.item.text;
    } else if (msg?.type === 'agent_message' && typeof msg.message === 'string') {
      text = msg.message;
    } else if (typeof msg?.last_agent_message === 'string') {
      text = msg.last_agent_message;
    }
    const u = msg?.usage ?? msg?.token_usage ?? msg?.total_token_usage ?? ev?.usage;
    if (u) {
      const inputTokens = Number(u.input_tokens ?? u.inputTokens ?? 0);
      const outputTokens = Number(u.output_tokens ?? u.outputTokens ?? 0);
      usage = {
        inputTokens,
        outputTokens,
        cachedInputTokens: Number(u.cached_input_tokens ?? u.cachedInputTokens ?? 0),
        totalTokens: Number(u.total_tokens ?? u.totalTokens ?? inputTokens + outputTokens),
      };
    }
  }
  return { text, usage };
}

/** Model bu hesapta yoksa (farkli abonelik/surum) CLI'nin varsayilan modeline dusulur. */
function modelUnavailable(raw: string): boolean {
  return /model[^\n]{0,80}(not (?:found|supported|available|exist)|does not exist|unsupported|unknown|invalid)|(?:unknown|unsupported|invalid) model/i.test(raw);
}

export async function runCodex(req: AgentRunRequest): Promise<AgentRunResult> {
  const bin = await findCodex();
  if (!bin) return failure('codex', L('codex CLI bulunamadı.', 'codex CLI was not found.'));
  const first = await runCodexOnce(req, bin, req.model);
  if (!first.ok && req.model && first.failureKind === 'other' && modelUnavailable(first.raw)) {
    req.onChunk?.(L(`\n[Konsey] ${req.model} bu hesapta yok; Codex'in varsayılan modeli kullanılıyor.\n`, `\n[Konsey] ${req.model} is not available on this account; using Codex's default model.\n`));
    return runCodexOnce(req, bin, undefined);
  }
  return first;
}

async function runCodexOnce(req: AgentRunRequest, bin: string, model: string | undefined): Promise<AgentRunResult> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'konsey-codex-'));
  const lastMessageFile = path.join(tmp, 'last.txt');

  const args = [
    'exec',
    '--json',
    '--cd', req.cwd,
    '--skip-git-repo-check',
    // Yazma izni: workspace-write ajanin yalnizca calisma dizinini
    // degistirmesine izin verir; analiz turlarinda read-only.
    '--sandbox', req.allowWrite ? 'workspace-write' : 'read-only',
    '--color', 'never',
    '-o', lastMessageFile,
  ];

  if (model) args.push('--model', model);
  if (req.effort) args.push('-c', `model_reasoning_effort="${req.effort}"`);
  // Sohbet turlari: kullanicinin MCP sunuculari baslatilmaz.
  if (req.lean) args.push('-c', 'mcp_servers={}');
  // Istem stdin'den verilir: Windows'ta komut satiri 32 bin karakterle sinirli.
  args.push('-');

  const res = await runProcess(bin, args, {
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    stdin: req.prompt,
    onChunk: req.onChunk,
  });

  let finalText = '';
  const parsed = parseJsonl(res.stdout);
  try {
    finalText = (await readFile(lastMessageFile, 'utf8')).trim();
  } catch {
    finalText = parsed.text.trim();
  }
  await rm(tmp, { recursive: true, force: true }).catch(() => {});

  const ok = res.exitCode === 0 && !res.timedOut && !res.aborted && finalText.length > 0;
  if (ok) {
    return {
      agent: 'codex', ok: true, text: finalText, raw: res.raw,
      exitCode: res.exitCode, durationMs: res.durationMs, usage: parsed.usage,
    };
  }

  const classified = classifyFailure(res.raw);
  const kind = res.timedOut ? 'timeout' : res.aborted ? 'cancelled' : classified.kind;

  return {
    agent: 'codex', ok: false, text: finalText, raw: res.raw,
    exitCode: res.exitCode, durationMs: res.durationMs,
    error: res.timedOut
      ? L('Zaman aşımı', 'Timed out')
      : res.aborted
        ? L('İptal edildi', 'Cancelled')
        : classified.kind === 'quota'
          ? L('Kota doldu', 'Quota exhausted')
          : L(`codex çıkış kodu ${res.exitCode}`, `codex exited with code ${res.exitCode}`),
    failureKind: kind,
    retryHint: classified.retryHint,
    usage: parsed.usage,
  };
}
