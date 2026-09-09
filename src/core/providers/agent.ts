/**
 * Ham bir sohbet modelini dosya duzenleyebilen bir ajana cevirir.
 *
 * Claude Code, Codex ve Antigravity kendi arac dongulerine sahip; ham bir
 * /v1/chat/completions ucu ise yalnizca metin uretir. Bu modul, model ile
 * dosya sistemi arasina kucuk bir dongu koyar: model her turda tek bir
 * eylem JSON'u yazar, biz calistirip sonucu geri veririz.
 *
 * Arac cagirma (tool calling) yerine duz metin protokolu kullaniliyor;
 * boylece tool desteklemeyen uyumlu proxy'lerde de calisir.
 *
 * GUVENLIK: Tum dosya yollari calisma dizinine hapsedilir. `run` eylemi
 * yalnizca yazma izni verilen turlarda ve yalnizca ajanin kendi izole
 * worktree'sinde calisir.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { chat, type ChatMessage } from './client';
import { extractJson } from '../json';
import type { AgentId, AgentRunResult, ProviderConfig } from '../../shared/types';

const execFileAsync = promisify(execFile);

const MAX_STEPS = 40;
const MAX_FILE_CHARS = 120_000;
const MAX_OUTPUT_CHARS = 8_000;

interface Action {
  action: string;
  path?: string;
  content?: string;
  command?: string;
  summary?: string;
  pattern?: string;
}

/** Tum yollari calisma dizinine hapseder; disari cikan istekler reddedilir. */
function confine(cwd: string, p: string): string | null {
  const resolved = path.resolve(cwd, p);
  const root = path.resolve(cwd);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

function clip(text: string, max: number): string {
  return text.length > max
    ? text.slice(0, max) + `\n...[${text.length - max} karakter kirpildi]`
    : text;
}

function systemPrompt(cwd: string, allowWrite: boolean): string {
  const writeTools = allowWrite
    ? `
- {"action":"write_file","path":"gorece/yol","content":"dosyanin TAM yeni icerigi"}
- {"action":"run","command":"kabuk komutu"}`
    : '\n(Bu tur SALT OKUNUR: write_file ve run kullanamazsin.)';

  return `Sen bir yazilim gelistirme ajanisin. Calisma dizinin: ${cwd}
Bu dizinin disina CIKAMAZSIN. Tum yollar bu dizine goredir.

Her yanitinda TAM OLARAK BIR eylem JSON'u yazacaksin, baska hicbir sey yazmayacaksin.
Kullanilabilir eylemler:

- {"action":"list_dir","path":"."}
- {"action":"read_file","path":"gorece/yol"}
- {"action":"grep","pattern":"aranan metin"}${writeTools}
- {"action":"finish","summary":"ne yaptigini ozetle"}

Kurallar:
- write_file dosyanin TAMAMINI yazar. Once read_file ile oku, sonra tam icerigi yaz.
- Isin bitince mutlaka finish gonder.
- Emin olmadigin dosyayi once oku, tahmin etme.
- En fazla ${MAX_STEPS} adimin var; verimli calis.

Simdi ilk eylemini yaz.`;
}

async function doList(cwd: string, rel: string): Promise<string> {
  const dir = confine(cwd, rel || '.');
  if (!dir) return 'HATA: yol calisma dizininin disinda.';
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const names = entries
      .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return names.length ? names.join('\n') : '(bos dizin)';
  } catch (e) {
    return `HATA: ${(e as Error).message}`;
  }
}

async function doRead(cwd: string, rel: string): Promise<string> {
  const file = confine(cwd, rel);
  if (!file) return 'HATA: yol calisma dizininin disinda.';
  try {
    const s = await stat(file);
    if (s.isDirectory()) return 'HATA: bu bir dizin, list_dir kullan.';
    return clip(await readFile(file, 'utf8'), MAX_FILE_CHARS);
  } catch (e) {
    return `HATA: ${(e as Error).message}`;
  }
}

async function doWrite(cwd: string, rel: string, content: string): Promise<string> {
  const file = confine(cwd, rel);
  if (!file) return 'HATA: yol calisma dizininin disinda.';
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    return `OK: ${rel} yazildi (${content.length} karakter).`;
  } catch (e) {
    return `HATA: ${(e as Error).message}`;
  }
}

async function doGrep(cwd: string, pattern: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/grep',
      ['-rn', '--exclude-dir=node_modules', '--exclude-dir=.git', '-m', '50', pattern, '.'],
      { cwd, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
    );
    return clip(stdout || '(eslesme yok)', MAX_OUTPUT_CHARS);
  } catch (e) {
    // grep eslesme bulamazsa 1 ile ciker; bu bir hata degil.
    const out = String((e as { stdout?: string }).stdout ?? '');
    return out ? clip(out, MAX_OUTPUT_CHARS) : '(eslesme yok)';
  }
}

async function doRun(cwd: string, command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
      cwd,
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return clip(`[cikis 0]\n${stdout}${stderr}`, MAX_OUTPUT_CHARS);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    return clip(
      `[cikis ${err.code ?? '?'}]\n${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`,
      MAX_OUTPUT_CHARS,
    );
  }
}

export interface ProviderAgentRequest {
  provider: ProviderConfig;
  apiKey: string;
  cwd: string;
  prompt: string;
  allowWrite: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

/** Cok adimli ajan dongusu: modele dosya sistemi erisimi verir. */
export async function runProviderAgent(req: ProviderAgentRequest): Promise<AgentRunResult> {
  const agentId = `provider:${req.provider.slug}` as AgentId;
  const started = Date.now();
  const deadline = started + req.timeoutMs;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(req.cwd, req.allowWrite) },
    { role: 'user', content: req.prompt },
  ];

  let rawLog = '';
  let lastText = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    if (req.signal?.aborted) {
      return {
        agent: agentId, ok: false, text: lastText, raw: rawLog, exitCode: null,
        durationMs: Date.now() - started, error: 'Iptal edildi', failureKind: 'cancelled',
      };
    }
    if (Date.now() > deadline) {
      return {
        agent: agentId, ok: false, text: lastText, raw: rawLog, exitCode: null,
        durationMs: Date.now() - started, error: 'Zaman asimi', failureKind: 'timeout',
      };
    }

    req.onChunk?.(`\n--- adim ${step + 1} (Yanıt bekleniyor...) ---\n`);

    const res = await chat({
      baseUrl: req.provider.baseUrl,
      apiKey: req.apiKey,
      model: req.provider.model,
      messages,
      maxTokens: req.provider.maxTokens,
      timeoutMs: Math.max(30000, Math.min(300000, deadline - Date.now())),
      signal: req.signal,
    });

    if (!res.ok) {
      return {
        agent: agentId, ok: false, text: lastText, raw: rawLog + '\n' + res.raw, exitCode: null,
        durationMs: Date.now() - started, error: res.error ?? 'Saglayici hatasi', failureKind: 'other',
      };
    }

    lastText = res.content;
    rawLog += `\n--- adim ${step + 1} ---\n${res.content}`;
    req.onChunk?.(res.content + '\n');
    messages.push({ role: 'assistant', content: res.content });

    const action = extractJson<Action>(res.content);
    if (!action?.action) {
      messages.push({
        role: 'user',
        content: "Eylem JSON'u okunamadi. Yalnizca tek bir JSON nesnesi yaz, aciklama ekleme.",
      });
      continue;
    }

    if (action.action === 'finish') {
      return {
        agent: agentId, ok: true, text: action.summary ?? res.content, raw: rawLog,
        exitCode: 0, durationMs: Date.now() - started,
      };
    }

    let observation: string;
    switch (action.action) {
      case 'list_dir':
        observation = await doList(req.cwd, action.path ?? '.');
        break;
      case 'read_file':
        observation = action.path ? await doRead(req.cwd, action.path) : 'HATA: path eksik.';
        break;
      case 'grep':
        observation = action.pattern ? await doGrep(req.cwd, action.pattern) : 'HATA: pattern eksik.';
        break;
      case 'write_file':
        observation = !req.allowWrite
          ? 'HATA: bu tur salt okunur, yazma yapamazsin.'
          : action.path === undefined || action.content === undefined
            ? 'HATA: path veya content eksik.'
            : await doWrite(req.cwd, action.path, action.content);
        break;
      case 'run':
        observation = !req.allowWrite
          ? 'HATA: bu tur salt okunur, komut calistiramazsin.'
          : action.command
            ? await doRun(req.cwd, action.command)
            : 'HATA: command eksik.';
        break;
      default:
        observation = `HATA: bilinmeyen eylem "${action.action}".`;
    }

    rawLog += `\n[sonuc] ${observation.slice(0, 500)}`;
    messages.push({ role: 'user', content: `Eylem sonucu:\n${observation}` });
  }

  return {
    agent: agentId, ok: false, text: lastText, raw: rawLog, exitCode: null,
    durationMs: Date.now() - started,
    error: `Adim siniri asildi (${MAX_STEPS}). Ajan finish gondermedi.`,
    failureKind: 'other',
  };
}

/** Koordinasyon turlari (plan, hakemlik, inceleme) icin tek atislik metin cagrisi. */
export async function runProviderText(
  req: Omit<ProviderAgentRequest, 'allowWrite'>,
): Promise<AgentRunResult> {
  const agentId = `provider:${req.provider.slug}` as AgentId;
  const started = Date.now();

  req.onChunk?.('[Düşünüyor / API yanıtı bekleniyor...]\n');

  const res = await chat({
    baseUrl: req.provider.baseUrl,
    apiKey: req.apiKey,
    model: req.provider.model,
    messages: [{ role: 'user', content: req.prompt }],
    maxTokens: req.provider.maxTokens,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
  });

  req.onChunk?.(res.content);
  return {
    agent: agentId,
    ok: res.ok && res.content.trim().length > 0,
    text: res.content.trim(),
    raw: res.raw,
    exitCode: res.ok ? 0 : null,
    durationMs: Date.now() - started,
    error: res.ok ? undefined : res.error,
    failureKind: res.ok ? undefined : 'other',
  };
}
