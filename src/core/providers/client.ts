/**
 * OpenAI uyumlu /v1/chat/completions istemcisi.
 *
 * Node'un global fetch'i (undici) bazi sunucularla TLS kayit duzeyinde
 * hata veriyor ("packet length too long"), oysa ayni sunucu `https` modulu
 * ve openssl ile sorunsuz calisiyor. Bu yuzden dogrudan `https` kullanilir.
 */
import * as https from 'node:https';
import * as http from 'node:http';
import { URL } from 'node:url';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
  name?: string;
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: any[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  ok: boolean;
  status: number;
  content: string;
  toolCalls: any[];
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: string;
  raw: string;
}

function joinUrl(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}${suffix}`;
}

export function requestJson(
  urlStr: string,
  method: 'GET' | 'POST',
  apiKey: string,
  payload: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'http:' ? http : https;
    const data = payload ? JSON.stringify(payload) : null;

    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(data));
    }

    const req = mod.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method,
        servername: url.hostname,
        headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );

    const onAbort = () => {
      req.destroy();
      resolve({ status: 0, body: 'Iptal edildi' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', (e) => resolve({ status: 0, body: `Baglanti hatasi: ${e.message}` }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, body: 'Zaman asimi' });
    });

    if (data) req.write(data);
    req.end();
  });
}

/** Gecici sayilan ve yeniden denenmesi anlamli olan durumlar. */
function isTransient(status: number, error?: string): boolean {
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  if (status === 0 && error) {
    // TLS/soket duzeyi kesintiler: bazi sunucularda dususuk oranda gorulur.
    return /EPROTO|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|packet length|Zaman asimi|Baglanti hatasi/i.test(error);
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tek bir sohbet cagrisi; gecici hatalarda ustel bekleyisle yeniden dener.
 *
 * Bazi self-hosted proxy'ler istegin dortte ucunde 502 dondurebiliyor
 * ("upstream gorunur metin uretmeden butceyi tuketti"). Yeniden deneme
 * olmadan bu tur bir uc pratikte kullanilamaz.
 */
export async function chat(opts: ChatOptions & { retries?: number }): Promise<ChatResult> {
  const retries = opts.retries ?? 3;
  let last: ChatResult | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) break;
    const res = await chatOnce(opts);
    if (res.ok) return res;
    last = res;
    if (!isTransient(res.status, res.error) || attempt === retries) break;
    await sleep(Math.min(8000, 800 * 2 ** attempt));
  }

  return (
    last ?? {
      ok: false, status: 0, content: '', toolCalls: [], finishReason: null,
      error: 'Istek yapilamadi', raw: '',
    }
  );
}

async function chatOnce(opts: ChatOptions): Promise<ChatResult> {
  const url = joinUrl(opts.baseUrl, '/chat/completions');
  const payload: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 8000,
  };
  if (opts.temperature !== undefined) payload.temperature = opts.temperature;
  if (opts.tools?.length) {
    payload.tools = opts.tools;
    payload.tool_choice = 'auto';
  }

  const { status, body } = await requestJson(
    url,
    'POST',
    opts.apiKey,
    payload,
    opts.timeoutMs ?? 300000,
    opts.signal,
  );

  if (status === 0) {
    return { ok: false, status, content: '', toolCalls: [], finishReason: null, error: body, raw: body };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      status,
      content: '',
      toolCalls: [],
      finishReason: null,
      error: `JSON ayristirilamadi (HTTP ${status})`,
      raw: body.slice(0, 2000),
    };
  }

  if (status >= 400 || parsed.error) {
    const msg = parsed?.error?.message ?? `HTTP ${status}`;
    return { ok: false, status, content: '', toolCalls: [], finishReason: null, error: msg, raw: body.slice(0, 2000) };
  }

  const choice = parsed.choices?.[0];
  const message = choice?.message ?? {};
  return {
    ok: true,
    status,
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    finishReason: choice?.finish_reason ?? null,
    usage: parsed.usage,
    raw: body.slice(0, 4000),
  };
}

/** Saglayicinin sundugu model kimliklerini listeler. */
export async function listModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 30000,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const { status, body } = await requestJson(`${base}/models`, 'GET', apiKey, null, timeoutMs);
  if (status === 0) return { ok: false, models: [], error: body };
  try {
    const parsed = JSON.parse(body);
    if (status >= 400 || parsed.error) {
      return { ok: false, models: [], error: parsed?.error?.message ?? `HTTP ${status}` };
    }
    const models = (parsed.data ?? []).map((m: any) => String(m.id)).filter(Boolean);
    return { ok: true, models };
  } catch {
    return { ok: false, models: [], error: `Model listesi okunamadi (HTTP ${status})` };
  }
}
