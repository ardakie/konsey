/**
 * Antigravity adaptoru.
 *
 * Antigravity'nin resmi bir headless CLI'si yok; ancak uygulamanin icindeki
 * language server "agentapi" adli dokumante edilmemis bir gRPC yuzeyi aciyor:
 *
 *   agentapi new-conversation [--model=...] <prompt>   -> konusma baslatir
 *   agentapi get-conversation-metadata <id>            -> ust bilgi
 *   agentapi send-message <id> <content>               -> devam mesaji
 *
 * Bu yuzey konusmanin ciktisini dondurmuyor. Buna karsilik ajan, calisirken
 * her adimi su dosyaya JSONL olarak yaziyor:
 *   ~/.gemini/<app>/brain/<conversation_id>/.system_generated/logs/transcript.jsonl
 * Adaptor bu dosyayi izleyerek hem canli akisi hem de bitis sinyalini alir.
 *
 * DIKKAT: Bu arayuz resmi degildir ve bir Antigravity guncellemesiyle
 * degisebilir. Kirildiginda yalnizca bu dosya guncellenmelidir.
 */
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { runProcess, failure } from './base';
import { classifyFailure } from './failures';
import { discoverAntigravity, type AntigravitySession } from '../discovery';
import type { AgentRunRequest, AgentRunResult } from '../../shared/types';

const HOME = os.homedir();
const CACHE_DIR = path.join(HOME, '.konsey');
const PROJECT_CACHE = path.join(CACHE_DIR, 'ag-projects.json');

export type AntigravityModel = 'flash_lite' | 'flash' | 'pro';

function agEnv(session: AntigravitySession, projectId: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: session.lsAddress,
    ANTIGRAVITY_CSRF_TOKEN: session.csrfToken,
    ANTIGRAVITY_PROJECT_ID: projectId,
  };
}

/** agentapi ciktisi her zaman tek bir JSON nesnesi dondurur. */
function parseAgentApi(stdout: string): { response?: any; error?: string } {
  const start = stdout.indexOf('{');
  if (start < 0) return { error: `Beklenmeyen cikti: ${stdout.slice(0, 200)}` };
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return { error: `JSON ayristirilamadi: ${stdout.slice(0, 200)}` };
  }
}

async function loadProjectCache(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(PROJECT_CACHE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveProjectCache(cache: Record<string, string>): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(PROJECT_CACHE, JSON.stringify(cache, null, 2), 'utf8');
}

/** Antigravity'nin brain klasoru; hangi uygulamanin LS'ine bagliysak o. */
function brainRoot(session: AntigravitySession): string {
  const isIde = session.agentApiPath.includes('antigravity-ide');
  return path.join(HOME, '.gemini', isIde ? 'antigravity-ide' : 'antigravity', 'brain');
}

function conversationsRoot(session: AntigravitySession): string {
  const isIde = session.agentApiPath.includes('antigravity-ide');
  return path.join(HOME, '.gemini', isIde ? 'antigravity-ide' : 'antigravity', 'conversations');
}

/**
 * Bir calisma dizini icin Antigravity proje kimligini (UUID) cozer.
 *
 * Sunucu, proje kimligi olmadan konusma baslatmayi reddediyor. Kimlik hicbir
 * dosyada duz metin tutulmadigi icin, ayni klasorde acilmis onceki
 * konusmalarin ust bilgisinden geri okunur ve onbellege alinir.
 */
export async function resolveProjectId(
  session: AntigravitySession,
  workspaceDir: string,
  maxScan = 40,
): Promise<string | null> {
  const key = path.resolve(workspaceDir);
  const cache = await loadProjectCache();
  if (cache[key]) return cache[key];

  const convDir = conversationsRoot(session);
  if (!existsSync(convDir)) return null;

  const { readdir, stat } = await import('node:fs/promises');
  const entries = await readdir(convDir).catch(() => [] as string[]);
  const ids = entries
    .filter((f) => f.endsWith('.pb') || f.endsWith('.db'))
    .map((f) => f.replace(/\.(pb|db)$/, ''));

  // En yeni konusmalar once taranir; aranan klasore ait olan ilk eslesme yeter.
  const withTime = await Promise.all(
    ids.map(async (id) => {
      const p = path.join(convDir, `${id}.db`);
      const q = existsSync(p) ? p : path.join(convDir, `${id}.pb`);
      const s = await stat(q).catch(() => null);
      return { id, mtime: s?.mtimeMs ?? 0 };
    }),
  );
  withTime.sort((a, b) => b.mtime - a.mtime);

  const wantUri = 'file://' + encodeURI(key);
  for (const { id } of withTime.slice(0, maxScan)) {
    const res = await runProcess(
      session.agentApiPath,
      ['get-conversation-metadata', id],
      { cwd: workspaceDir, env: agEnv(session, '00000000-0000-0000-0000-000000000000'), timeoutMs: 10000 },
    );
    const parsed = parseAgentApi(res.stdout);
    const meta = parsed.response?.conversationMetadata?.metadata;
    if (!meta) continue;
    const uris: string[] = meta.workspaceUris ?? [];
    const projectId: string = meta.projectId ?? '';
    if (!projectId) continue;
    if (uris.some((u) => u === wantUri || decodeURI(u) === 'file://' + key)) {
      cache[key] = projectId;
      await saveProjectCache(cache);
      return projectId;
    }
  }
  return null;
}

interface TranscriptEntry {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
}

function transcriptPath(session: AntigravitySession, conversationId: string): string {
  return path.join(
    brainRoot(session),
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
}

async function readTranscript(file: string): Promise<TranscriptEntry[]> {
  try {
    const text = await readFile(file, 'utf8');
    const out: TranscriptEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* yarim yazilmis son satir; sonraki turda okunur */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Ajanin kullaniciya donuk metin cevaplari PLANNER_RESPONSE adimlarindadir. */
function visibleText(entries: TranscriptEntry[]): string[] {
  return entries
    .filter((e) => e.source === 'MODEL' && e.type === 'PLANNER_RESPONSE' && typeof e.content === 'string')
    .map((e) => e.content as string);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Konusma bitene kadar transcript'i izler.
 * Bitis olcutu: calisan adim kalmamasi VE dosyanin `quietMs` boyunca degismemesi.
 */
async function waitForCompletion(
  file: string,
  opts: { timeoutMs: number; quietMs: number; signal?: AbortSignal; onChunk?: (s: string) => void },
): Promise<{ text: string; timedOut: boolean; aborted: boolean }> {
  const deadline = Date.now() + opts.timeoutMs;
  let emitted = 0;
  let lastChangeAt = Date.now();
  let lastLen = 0;
  let lastTexts: string[] = [];

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      return { text: lastTexts.join('\n\n'), timedOut: false, aborted: true };
    }

    const entries = await readTranscript(file);
    const texts = visibleText(entries);

    if (entries.length !== lastLen) {
      lastLen = entries.length;
      lastChangeAt = Date.now();
    }
    for (let i = emitted; i < texts.length; i++) opts.onChunk?.(texts[i] + '\n');
    emitted = texts.length;
    lastTexts = texts;

    const running = entries.some((e) => e.status === 'RUNNING');
    const quiet = Date.now() - lastChangeAt > opts.quietMs;
    if (entries.length > 0 && !running && quiet) {
      return { text: texts.at(-1) ?? '', timedOut: false, aborted: false };
    }
    await sleep(1500);
  }
  return { text: lastTexts.at(-1) ?? '', timedOut: true, aborted: false };
}

export interface AntigravityRunRequest extends AgentRunRequest {
  model?: AntigravityModel;
}

export async function runAntigravity(req: AntigravityRunRequest): Promise<AgentRunResult> {
  const gitDir = path.join(req.cwd, '.git');
  if (!existsSync(gitDir)) {
    try {
      execSync('git init', { cwd: req.cwd, stdio: 'ignore' });
    } catch (e) {
      // sessizce devam et
    }
  }

  const session = await discoverAntigravity(req.cwd);
  if (!session) {
    return failure(
      'antigravity',
      'Antigravity language server bulunamadi. Antigravity uygulamasi acik olmali.',
    );
  }

  const projectId = await resolveProjectId(session, req.cwd);
  if (!projectId) {
    return failure(
      'antigravity',
      `Bu klasor icin Antigravity proje kimligi cozulemedi: ${req.cwd}. ` +
        'Klasoru bir kez Antigravity uygulamasinda acip bir konusma baslatin; ' +
        'kimlik sonrasinda onbellege alinir.',
    );
  }

  const env = agEnv(session, projectId);
  const model: AntigravityModel = req.model ?? 'pro';

  // Antigravity yazma iznini bayrakla ayarlamiyor; sinir prompt ile bildirilir.
  const guard = req.allowWrite
    ? ''
    : '\n\nONEMLI: Bu bir analiz turudur. Hicbir dosyayi olusturma, degistirme veya silme. Sadece oku ve cevapla.';

  const started = Date.now();
  const startRes = await runProcess(
    session.agentApiPath,
    ['new-conversation', `--model=${model}`, '--title=Konsey', req.prompt + guard],
    { cwd: req.cwd, env, timeoutMs: 60000, signal: req.signal },
  );

  const parsed = parseAgentApi(startRes.stdout);
  if (parsed.error) {
    const classified = classifyFailure(startRes.raw + '\n' + parsed.error);
    return {
      agent: 'antigravity',
      ok: false,
      text: '',
      raw: startRes.raw,
      exitCode: startRes.exitCode,
      durationMs: Date.now() - started,
      error: parsed.error,
      failureKind: classified.kind,
      retryHint: classified.retryHint,
    };
  }

  const conversationId: string | undefined =
    parsed.response?.conversationId ?? parsed.response?.conversation_id ?? parsed.response?.id;
  if (!conversationId) {
    return {
      agent: 'antigravity',
      ok: false,
      text: '',
      raw: startRes.raw,
      exitCode: startRes.exitCode,
      durationMs: Date.now() - started,
      error: `Konusma kimligi alinamadi: ${startRes.stdout.slice(0, 300)}`,
    };
  }

  const file = transcriptPath(session, conversationId);
  const done = await waitForCompletion(file, {
    timeoutMs: req.timeoutMs,
    quietMs: 20000,
    signal: req.signal,
    onChunk: req.onChunk,
  });

  const classified = classifyFailure(done.text + '\n' + startRes.raw);
  return {
    agent: 'antigravity',
    ok: !done.timedOut && !done.aborted && done.text.trim().length > 0,
    text: done.text.trim(),
    raw: startRes.raw + '\n[transcript] ' + file,
    exitCode: 0,
    durationMs: Date.now() - started,
    error: done.timedOut ? 'Zaman asimi' : done.aborted ? 'Iptal edildi' : undefined,
    failureKind: done.timedOut ? 'timeout' : done.aborted ? 'cancelled' : classified.kind,
    retryHint: classified.retryHint,
  };
}
