/** Ajan adaptorleri icin ortak surec calistirma yardimcilari. */
import { spawn } from 'node:child_process';
import type { AgentId, AgentRunResult, FailureKind } from '../../shared/types';

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Sureci stdin uzerinden beslemek icin. */
  stdin?: string;
  onChunk?: (chunk: string) => void;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  raw: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

/**
 * Bir komutu calistirir, cikti akisini onChunk'a aktarir ve tamamini biriktirir.
 * Zaman asiminda once SIGTERM, 3 sn sonra SIGKILL gonderir.
 */
export function runProcess(
  command: string,
  args: string[],
  opts: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let raw = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d: string) => {
      stdout += d;
      raw += d;
      opts.onChunk?.(d);
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
      raw += d;
      opts.onChunk?.(d);
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout,
        stderr,
        raw,
        exitCode,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (err) => {
      raw += `\n[spawn hatasi] ${err.message}\n`;
      stderr += `\n${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

export function failure(
  agent: AgentId,
  message: string,
  raw = '',
  kind: FailureKind = 'unavailable',
): AgentRunResult {
  return {
    agent, ok: false, text: '', raw, exitCode: null,
    durationMs: 0, error: message, failureKind: kind,
  };
}
