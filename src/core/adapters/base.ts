/** Ajan adaptorleri icin ortak surec calistirma yardimcilari. */
import { spawn } from 'node:child_process';
import { killTree, resolveLaunch } from '../env';
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
  return resolveLaunch(command, args).then((launch) => new Promise<SpawnResult>((resolve) => {
    const startedAt = Date.now();
    if (opts.signal?.aborted) {
      resolve({
        stdout: '', stderr: '', raw: '', exitCode: null,
        timedOut: false, aborted: true, durationMs: 0,
      });
      return;
    }
    const child = spawn(launch.command, launch.args, {
      cwd: opts.cwd,
      env: { ...(opts.env ?? process.env), ...(launch.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: launch.shell,
      windowsHide: true,
    });
    const stop = () => {
      killTree(child.pid);
      setTimeout(() => killTree(child.pid, true), 3000).unref();
    };

    let stdout = '';
    let stderr = '';
    let raw = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      stop();
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

    // Kapanmis bir stdin'e yazmak surec hatasi firlatmasin.
    child.stdin.on('error', () => {});
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();

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
  }));
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
