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
import type { AgentRunRequest, AgentRunResult } from '../../shared/types';

/** JSONL olaylarindan ajanin urettigi metni toplar (son mesaj dosyasi yoksa yedek). */
function parseJsonl(stdout: string): string {
  let text = '';
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
    if (msg?.type === 'agent_message' && typeof msg.message === 'string') {
      text = msg.message;
    } else if (typeof msg?.last_agent_message === 'string') {
      text = msg.last_agent_message;
    }
  }
  return text;
}

export async function runCodex(req: AgentRunRequest): Promise<AgentRunResult> {
  const bin = await findCodex();
  if (!bin) return failure('codex', 'codex CLI bulunamadi.');

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

  if (req.model) args.push('--model', req.model);
  if (req.effort) args.push('-c', `model_reasoning_effort="${req.effort}"`);
  args.push(req.prompt);

  const res = await runProcess(bin, args, {
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    onChunk: req.onChunk,
  });

  let finalText = '';
  try {
    finalText = (await readFile(lastMessageFile, 'utf8')).trim();
  } catch {
    finalText = parseJsonl(res.stdout).trim();
  }
  await rm(tmp, { recursive: true, force: true }).catch(() => {});

  const ok = res.exitCode === 0 && !res.timedOut && !res.aborted && finalText.length > 0;
  if (ok) {
    return {
      agent: 'codex', ok: true, text: finalText, raw: res.raw,
      exitCode: res.exitCode, durationMs: res.durationMs,
    };
  }

  const classified = classifyFailure(res.raw);
  const kind = res.timedOut ? 'timeout' : res.aborted ? 'cancelled' : classified.kind;

  return {
    agent: 'codex', ok: false, text: finalText, raw: res.raw,
    exitCode: res.exitCode, durationMs: res.durationMs,
    error: res.timedOut
      ? 'Zaman asimi'
      : res.aborted
        ? 'Iptal edildi'
        : classified.kind === 'quota'
          ? 'Kota doldu'
          : `codex cikis kodu ${res.exitCode}`,
    failureKind: kind,
    retryHint: classified.retryHint,
  };
}
