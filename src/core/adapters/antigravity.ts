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
import { readFile, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { runProcess, failure } from './base';
import { classifyFailure } from './failures';
import { discoverAntigravity, discoverAntigravitySessions, type AntigravitySession } from '../discovery';
import { L } from '../../shared/i18n';
import type { AgentRunRequest, AgentRunResult } from '../../shared/types';

const HOME = os.homedir();
const CACHE_DIR = process.env.KONSEY_HOME ?? path.join(HOME, '.konsey');
const PROJECT_CACHE = path.join(CACHE_DIR, 'ag-projects.json');
const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type AntigravityModel = 'flash_lite' | 'flash' | 'pro';

/** projectId null: kimlik gonderilmez (proje deposu olmayan sunucular kimligi reddeder). */
function agEnv(session: AntigravitySession, projectId: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: session.lsAddress,
    ANTIGRAVITY_CSRF_TOKEN: session.csrfToken,
  };
  if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
  else delete env.ANTIGRAVITY_PROJECT_ID;
  return env;
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

/**
 * Proje kimligi onbellegi.
 *   folders:       klasor -> proje kimligi (dogrulanmis eslesmeler)
 *   conversations: konusma -> {proje, klasorler}; ust bilgi degismedigi icin bir kez okunur
 *   borrow:        baska bir klasorun kimligiyle acilan konusmanin calisma klasorune
 *                  baglanip baglanmadigi (tek seferlik deneme sonucu)
 */
interface ProjectCache {
  version: 2;
  folders: Record<string, string>;
  conversations: Record<string, { projectId: string; uris: string[] }>;
  borrow?: { ok: boolean; checkedAt: number };
  /** Konsey'in olusturdugu Antigravity projeleri (temizlik icin). */
  created?: string[];
  /** Ana proje klasoru -> worktree'lerin baglandigi "(Konsey)" projesi. */
  workProjects?: Record<string, string>;
}

async function loadProjectCache(): Promise<ProjectCache> {
  try {
    const raw = JSON.parse(await readFile(PROJECT_CACHE, 'utf8'));
    if (raw?.version === 2) return raw as ProjectCache;
    // Eski bicim: duz klasor -> kimlik haritasi.
    return { version: 2, folders: raw ?? {}, conversations: {} };
  } catch {
    return { version: 2, folders: {}, conversations: {} };
  }
}

async function saveProjectCache(cache: ProjectCache): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(PROJECT_CACHE, JSON.stringify(cache, null, 2), 'utf8');
}

/**
 * agentapi surumleri cevabi farkli sarmalarda dondurur (or. IDE: {conversationId},
 * uygulama: {newConversation: {...}}). Kimlik, ic ice nesnelerde adina gore aranir.
 */
export function findConversationId(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 5) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ['conversationId', 'conversation_id', 'cascadeId', 'cascade_id', 'trajectoryId', 'trajectory_id']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string;
  }
  for (const child of Object.values(obj)) {
    const found = findConversationId(child, depth + 1);
    if (found) return found;
  }
  return typeof obj.id === 'string' && depth > 0 ? obj.id : undefined;
}

/** Cevapta kimlik yoksa: baslatma anindan sonra olusan en yeni konusma klasoru. */
async function newestConversationSince(session: AntigravitySession, since: number): Promise<string | undefined> {
  for (let i = 0; i < 8; i++) {
    const root = brainRoot(session);
    const names = await readdir(root).catch(() => [] as string[]);
    let best: { id: string; t: number } | undefined;
    for (const id of names) {
      const st = await stat(path.join(root, id)).catch(() => null);
      const t = st ? Math.max(st.birthtimeMs || 0, st.ctimeMs) : 0;
      if (t >= since - 1000 && (!best || t > best.t)) best = { id, t };
    }
    if (best) return best.id;
    await sleep(1000);
  }
  return undefined;
}

/** Ust bilgi (projectId + workspaceUris) iceren ilk ic nesne. */
export function findMetadata(value: unknown, depth = 0): { projectId: string; uris: string[] } | null {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.projectId === 'string' && obj.projectId) {
    const uris = Array.isArray(obj.workspaceUris) ? obj.workspaceUris.map(String) : [];
    return { projectId: obj.projectId, uris };
  }
  for (const child of Object.values(obj)) {
    const found = findMetadata(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Antigravity uygulamasinin agentapi'si yalnizca --model bayragini tanir; --title IDE'ye ozgu. */
function titleArgs(session: AntigravitySession, title: string): string[] {
  return session.agentApiPath.includes('antigravity-ide') ? [`--title=${title}`] : [];
}

/** Antigravity'nin veri klasoru; hangi uygulamanin LS'ine bagliysak o. */
function dataRoot(session: AntigravitySession): string {
  const isIde = session.agentApiPath.includes('antigravity-ide');
  return path.join(HOME, '.gemini', isIde ? 'antigravity-ide' : 'antigravity');
}

function brainRoot(session: AntigravitySession): string {
  return path.join(dataRoot(session), 'brain');
}

function conversationsRoot(session: AntigravitySession): string {
  return path.join(dataRoot(session), 'conversations');
}

export function urisInclude(uris: string[], dir: string): boolean {
  const want = path.resolve(dir);
  return uris.some((u) => {
    try {
      return path.resolve(decodeURI(u.replace(/^file:\/\//, ''))) === want;
    } catch {
      return false;
    }
  });
}

async function conversationMetadata(
  session: AntigravitySession,
  conversationId: string,
  cwd: string,
): Promise<{ projectId: string; uris: string[] } | null> {
  const res = await runProcess(
    session.agentApiPath,
    ['get-conversation-metadata', conversationId],
    { cwd, env: agEnv(session, '00000000-0000-0000-0000-000000000000'), timeoutMs: 10000 },
  );
  return findMetadata(parseAgentApi(res.stdout).response);
}

/**
 * Yerel konusmalarin ust bilgisini (en yeniden eskiye) onbellege alir.
 * Ilk taramadan sonra yalnizca yeni konusmalar sorulur.
 */
async function scanConversations(
  sessions: AntigravitySession[],
  cache: ProjectCache,
  cwd: string,
  maxNew = 120,
): Promise<{ id: string; mtime: number }[]> {
  // Iki uygulamanin (Antigravity ve IDE) kayitlari birlikte taranir; bir konusmanin
  // ust bilgisini onu taniyan sunucu verir, bu yuzden sunucular sirayla sorulur.
  const roots = [...new Set([
    path.join(HOME, '.gemini', 'antigravity', 'conversations'),
    path.join(HOME, '.gemini', 'antigravity-ide', 'conversations'),
    ...sessions.map(conversationsRoot),
  ])];
  const found: { id: string; mtime: number }[] = [];
  for (const convDir of roots) {
    const entries = await readdir(convDir).catch(() => [] as string[]);
    const ids = [...new Set(entries.filter((f) => /\.(pb|db)$/.test(f)).map((f) => f.replace(/\.(pb|db)$/, '')))];
    for (const id of ids) {
      const db = path.join(convDir, `${id}.db`);
      const st = await stat(existsSync(db) ? db : path.join(convDir, `${id}.pb`)).catch(() => null);
      found.push({ id, mtime: st?.mtimeMs ?? 0 });
    }
  }
  found.sort((x, y) => y.mtime - x.mtime);

  let asked = 0;
  for (const { id } of found) {
    if (cache.conversations[id]) continue;
    const failedAt = UNKNOWN_CONVERSATIONS.get(id);
    if (failedAt && Date.now() - failedAt < 10 * 60_000) continue;
    if (asked++ >= maxNew) break;
    let meta: { projectId: string; uris: string[] } | null = null;
    for (const session of sessions) {
      meta = await conversationMetadata(session, id, cwd);
      if (meta) break;
    }
    if (meta) cache.conversations[id] = meta;
    else UNKNOWN_CONVERSATIONS.set(id, Date.now());
  }
  return found;
}

/** Hicbir sunucunun tanimadigi konusmalar; her aramada yeniden sorulmaz. */
const UNKNOWN_CONVERSATIONS = new Map<string, number>();

/**
 * Antigravity projeleri ~/.gemini/config/projects/<kimlik>.json dosyalarinda durur:
 *   { id, name, projectResources: { resources: [{ folderUri }] }, settings }
 * Bir klasorun projesi bu kayittan dogrudan okunur; yoksa ayni bicimde olusturulur.
 */
const PROJECTS_DIR = path.join(HOME, '.gemini', 'config', 'projects');

interface ProjectRecord {
  id: string;
  name?: string;
  projectResources?: { resources?: { folderUri?: string }[] };
  settings?: Record<string, unknown>;
}

async function readProjects(): Promise<{ file: string; record: ProjectRecord; mtime: number }[]> {
  const names = await readdir(PROJECTS_DIR).catch(() => [] as string[]);
  const out: { file: string; record: ProjectRecord; mtime: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(PROJECTS_DIR, name);
    try {
      const record = JSON.parse(await readFile(file, 'utf8')) as ProjectRecord;
      const st = await stat(file);
      if (record?.id) out.push({ file, record, mtime: st.mtimeMs });
    } catch {
      /* bozuk kayit atlanir */
    }
  }
  return out;
}

function projectFolders(record: ProjectRecord): string[] {
  return (record.projectResources?.resources ?? []).map((r) => r.folderUri ?? '').filter(Boolean);
}

/** Klasoru iceren Antigravity projesi (kayittan). */
export async function projectForFolder(dir: string): Promise<string | null> {
  const want = path.resolve(dir);
  for (const { record } of await readProjects()) {
    if (urisInclude(projectFolders(record), want)) return record.id;
  }
  return null;
}

/**
 * Klasor icin Antigravity projesi olusturur. Izin ayarlari kullanicinin en son
 * duzenledigi projeden kopyalanir; Konsey hicbir izni kendiliginden genisletmez.
 */
export async function createProject(dir: string, name = path.basename(dir)): Promise<string> {
  const projects = await readProjects();
  projects.sort((a, b) => b.mtime - a.mtime);
  const settings = projects[0]?.record.settings ?? {
    fileAccessPolicy: 'AGENT_SETTING_POLICY_ASK',
    internetPolicy: 'AGENT_SETTING_POLICY_ASK',
    autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF',
    artifactReviewMode: 'ARTIFACT_REVIEW_MODE_ALWAYS',
  };
  const id = randomUUID();
  const record: ProjectRecord = {
    id,
    name,
    projectResources: { resources: [{ folderUri: 'file://' + encodeURI(path.resolve(dir)) }] },
    settings,
  };
  await mkdir(PROJECTS_DIR, { recursive: true });
  await writeFile(path.join(PROJECTS_DIR, `${id}.json`), JSON.stringify(record, null, 2), 'utf8');
  const cache = await loadProjectCache();
  cache.created = [...new Set([...(cache.created ?? []), id])];
  cache.folders[path.resolve(dir)] = id;
  await saveProjectCache(cache);
  return id;
}

async function updateProjectFolders(id: string, change: (folders: string[]) => string[]): Promise<boolean> {
  const file = path.join(PROJECTS_DIR, `${id}.json`);
  try {
    const record = JSON.parse(await readFile(file, 'utf8')) as ProjectRecord;
    const next = change(projectFolders(record));
    record.projectResources = { resources: next.map((folderUri) => ({ folderUri })) };
    await writeFile(file, JSON.stringify(record, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Worktree'ler her gorevde yeni bir klasor. Kullanicinin proje listesini
 * doldurmamak icin ana proje basina tek bir "(Konsey)" projesi tutulur; gorev
 * suresince worktree bu projeye eklenir, bitince cikarilir.
 */
async function attachWorktree(main: string, worktree: string): Promise<string> {
  const cache = await loadProjectCache();
  cache.workProjects ??= {};
  let id = cache.workProjects[main];
  if (!id || !existsSync(path.join(PROJECTS_DIR, `${id}.json`))) {
    id = await createProject(worktree, `${path.basename(main)} (Konsey)`);
    const fresh = await loadProjectCache();
    fresh.workProjects = { ...(fresh.workProjects ?? {}), [main]: id };
    delete fresh.folders[path.resolve(worktree)];
    await saveProjectCache(fresh);
    return id;
  }
  const uri = 'file://' + encodeURI(path.resolve(worktree));
  // Silinmis eski worktree'ler listeden dusulur.
  await updateProjectFolders(id, (folders) => [
    ...folders.filter((u) => u !== uri && existsSync(decodeURI(u.replace(/^file:\/\//, '')))),
    uri,
  ]);
  return id;
}

async function detachWorktree(id: string, worktree: string): Promise<void> {
  const uri = 'file://' + encodeURI(path.resolve(worktree));
  await updateProjectFolders(id, (folders) => folders.filter((u) => u !== uri));
}

/** Bir git worktree'sinin ait oldugu ana depo klasoru. */
async function mainRepoDir(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
    const common = stdout.trim();
    if (!common) return null;
    const main = path.dirname(common);
    return path.resolve(main) === path.resolve(dir) ? null : main;
  } catch {
    return null;
  }
}

export interface ResolvedProject {
  projectId: string;
  /** Kimligin gercekten ait oldugu klasor; null: baska bir klasorden odunc. */
  folder: string | null;
}

/**
 * Bir calisma dizini icin Antigravity proje kimligini (UUID) cozer.
 *
 * Sunucu, proje kimligi olmadan konusma baslatmayi reddediyor ve kimlik hicbir
 * dosyada duz metin tutulmuyor; ayni klasorde acilmis konusmalarin ust
 * bilgisinden geri okunur. Sirasiyla: klasorun kendisi, worktree ise ana depo,
 * son olarak en yeni konusmanin kimligi (odunc; kullanmadan once dogrulanir).
 */
export async function resolveProjectId(
  sessions: AntigravitySession[],
  workspaceDir: string,
): Promise<ResolvedProject | null> {
  const key = path.resolve(workspaceDir);
  const registered = await projectForFolder(key);
  if (registered) return { projectId: registered, folder: key };
  const cache = await loadProjectCache();
  if (cache.folders[key]) return { projectId: cache.folders[key], folder: key };

  const main = await mainRepoDir(key);
  if (main && cache.folders[main]) return { projectId: cache.folders[main], folder: main };

  const ordered = await scanConversations(sessions, cache, key);
  let found: ResolvedProject | null = null;
  for (const want of [key, main]) {
    if (!want || found) continue;
    for (const { id } of ordered) {
      const meta = cache.conversations[id];
      if (meta && urisInclude(meta.uris, want)) {
        cache.folders[want] = meta.projectId;
        found = { projectId: meta.projectId, folder: want };
        break;
      }
    }
  }
  if (!found) {
    const recent = ordered.map(({ id }) => cache.conversations[id]).find(Boolean);
    if (recent) found = { projectId: recent.projectId, folder: null };
  }
  await saveProjectCache(cache);
  return found;
}

/**
 * Baska bir klasorun kimligiyle acilan konusma, agentapi'nin calistirildigi
 * klasore mi baglaniyor? Tek seferlik, dosyaya dokunmayan kisa bir konusmayla
 * denenir ve sonuc onbellege alinir. Baglanmiyorsa odunc kimlik hic kullanilmaz;
 * aksi halde ajan yanlis klasorde calisabilirdi.
 */
async function borrowBindsToCwd(
  session: AntigravitySession,
  projectId: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; reason?: string }> {
  const cache = await loadProjectCache();
  if (cache.borrow) return { ok: cache.borrow.ok, reason: cache.borrow.ok ? undefined : 'onceki deneme: kimlik klasore baglanmadi' };

  const probeStarted = Date.now();
  const res = await runProcess(
    session.agentApiPath,
    ['new-conversation', '--model=flash_lite', ...titleArgs(session, 'Konsey baglanti denemesi'),
      'Yalnizca TAMAM yaz. Hicbir dosyayi okuma, olusturma veya degistirme.'],
    { cwd, env: agEnv(session, projectId), timeoutMs: 60000, signal },
  );
  const parsed = parseAgentApi(res.stdout);
  const response = parsed.response;
  const conversationId = findConversationId(response) ??
    (response && !parsed.error ? await newestConversationSince(session, probeStarted) : undefined);
  // Baslatilamayan deneme kesin sonuc sayilmaz; onbellege yazilmaz.
  if (!conversationId) return { ok: false, reason: (parsed.error ?? res.raw ?? '').slice(0, 300) };

  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) {
    const meta = await conversationMetadata(session, conversationId, cwd);
    if (meta?.uris.length) {
      ok = urisInclude(meta.uris, cwd);
      break;
    }
    await sleep(1000);
  }
  cache.borrow = { ok, checkedAt: Date.now() };
  if (ok) cache.folders[path.resolve(cwd)] = projectId;
  await saveProjectCache(cache);
  return { ok, reason: ok ? undefined : 'yeni konusma baska bir klasore baglandi' };
}

/** Language server yoksa Antigravity IDE arka planda acilir ve hazir olmasi beklenir. */
async function ensureSession(cwd: string, signal?: AbortSignal): Promise<AntigravitySession | null> {
  const found = await discoverAntigravity(cwd);
  // IDE acik olsa bile konusmayi acabilen Antigravity uygulamasinin sunucusu gerekir.
  if (found && !found.agentApiPath.includes('antigravity-ide')) return found;
  // Projeleri tutan sunucu Antigravity uygulamasinda; IDE yalnizca yedek.
  const app = ['/Applications/Antigravity.app', '/Applications/Antigravity IDE.app'].find((p) => existsSync(p));
  if (!app) return found;
  try {
    await execFileAsync('/usr/bin/open', ['-g', '-a', app]);
  } catch {
    return found;
  }
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !signal?.aborted) {
    await sleep(2500);
    const session = await discoverAntigravity(cwd);
    if (session && !session.agentApiPath.includes('antigravity-ide')) return session;
  }
  return found ?? (await discoverAntigravity(cwd));
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

type StartAttempt =
  | { startRes: Awaited<ReturnType<typeof runProcess>>; parsed: { response?: any; error?: string } }
  | { fatal: string };

/**
 * Tek bir language server'da konusma acmayi dener:
 *   1) klasorun bilinen kimligi ya da hic kimlik (klasorsuz sunucu kimligi reddeder),
 *   2) sunucu kimlik isterse klasorun/ana deponun kimligi ya da dogrulanmis odunc kimlik.
 */
async function startOn(
  session: AntigravitySession,
  sessions: AntigravitySession[],
  req: AntigravityRunRequest,
  model: AntigravityModel,
  prompt: string,
): Promise<StartAttempt> {
  const start = (projectId: string | null, cwd: string) => runProcess(
    session.agentApiPath,
    ['new-conversation', `--model=${model}`, ...titleArgs(session, 'Konsey'), prompt],
    { cwd, env: agEnv(session, projectId), timeoutMs: 60000, signal: req.signal },
  );

  const cache = await loadProjectCache();
  const known = (await projectForFolder(req.cwd)) ?? cache.folders[path.resolve(req.cwd)] ?? null;
  let startRes = await start(known, req.cwd);
  let parsed = parseAgentApi(startRes.stdout);
  if (parsed.error && known && /projectsStore is nil/i.test(parsed.error)) {
    startRes = await start(null, req.cwd);
    parsed = parseAgentApi(startRes.stdout);
  }
  if (!parsed.error || known || !/project/i.test(parsed.error) || /projectsStore is nil/i.test(parsed.error)) {
    return { startRes, parsed };
  }

  const firstError = parsed.error;
  const resolved = await resolveProjectId(sessions, req.cwd);
  if (!resolved) return { fatal: `kimlik istendi ama bilinen konusma yok: ${firstError}` };
  let cwd = req.cwd;
  const exact = resolved.folder !== null && path.resolve(resolved.folder) === path.resolve(req.cwd);
  const borrow = exact ? { ok: true } : await borrowBindsToCwd(session, resolved.projectId, req.cwd, req.signal);
  if (!borrow.ok) {
    // Salt okunur turlar, kimligi bilinen ana depoda ayni kodu okuyarak yapilabilir;
    // yazma turu yanlis klasore gidebilecegi icin yapilmaz.
    if (!req.allowWrite && resolved.folder) cwd = resolved.folder;
    else return { fatal: `kimliksiz: ${firstError} · odunc: ${borrow.reason ?? '-'}` };
  }
  startRes = await start(resolved.projectId, cwd);
  parsed = parseAgentApi(startRes.stdout);
  if (parsed.error) parsed.error = `kimliksiz: ${firstError} · kimlikli: ${parsed.error}`;
  return { startRes, parsed };
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

  const first = await ensureSession(req.cwd, req.signal);
  if (!first) {
    return failure(
      'antigravity',
      L(
        'Antigravity language server bulunamadı. Antigravity IDE açılamadı ya da hazır olmadı.',
        'Antigravity language server was not found. Antigravity IDE could not be opened or was not ready.',
      ),
    );
  }
  const sessions = await discoverAntigravitySessions(req.cwd);
  if (!sessions.length) sessions.push(first);

  // Klasorun Antigravity projesi: kayitta varsa o, yoksa olusturulur. Worktree
  // ise ana projenin "(Konsey)" projesine gorev suresince eklenir.
  let attached: string | null = null;
  if (!(await projectForFolder(req.cwd))) {
    const main = await mainRepoDir(req.cwd);
    try {
      if (main) attached = await attachWorktree(main, req.cwd);
      else await createProject(req.cwd);
    } catch (err) {
      req.onChunk?.(L(`\n[Konsey] Antigravity projesi hazırlanamadı: ${String(err)}\n`, `\n[Konsey] Antigravity project could not be prepared: ${String(err)}\n`));
    }
  }
  try {
    return await runOnSessions(req, sessions, first);
  } finally {
    if (attached) await detachWorktree(attached, req.cwd).catch(() => {});
  }
}

async function runOnSessions(
  req: AntigravityRunRequest,
  sessions: AntigravitySession[],
  first: AntigravitySession,
): Promise<AgentRunResult> {
  const model: AntigravityModel = req.model ?? 'pro';
  // Antigravity yazma iznini bayrakla ayarlamiyor; sinir prompt ile bildirilir.
  // Calisma klasoru de acikca yazilir: konusma baska bir alana baglansa bile
  // ajan dosyalari dogru yere yazar.
  const guard = req.allowWrite
    ? `\n\nCALISMA KLASORU: ${req.cwd}\nTum dosya islemlerini yalnizca bu klasorde, mutlak yollarla yap.`
    : `\n\nCALISMA KLASORU: ${req.cwd}\nONEMLI: Bu bir analiz turudur. Hicbir dosyayi olusturma, degistirme veya silme. Sadece oku ve cevapla.`;

  const started = Date.now();
  const errors: string[] = [];
  let session = first;
  let startRes: Awaited<ReturnType<typeof runProcess>> | null = null;
  let parsed: { response?: any; error?: string } = {};

  // Her IDE penceresinin kendi language server'i var; biri konusma acamazsa
  // (or. klasorsuz pencere proje deposu tutmaz) siradaki denenir.
  for (const candidate of sessions) {
    const attempt = await startOn(candidate, sessions, req, model, req.prompt + guard);
    if ('fatal' in attempt) {
      errors.push(attempt.fatal);
      continue;
    }
    session = candidate;
    startRes = attempt.startRes;
    parsed = attempt.parsed;
    if (!parsed.error) break;
    errors.push(parsed.error);
  }

  if (!startRes || parsed.error) {
    const detail = [...new Set(errors)].join(' | ').slice(0, 1200);
    const classified = classifyFailure(detail);
    return {
      agent: 'antigravity',
      ok: false,
      text: '',
      raw: startRes?.raw ?? detail,
      exitCode: startRes?.exitCode ?? null,
      durationMs: Date.now() - started,
      error: L(
        `Antigravity konuşma açamadı (${sessions.length} sunucu denendi). ` +
          'Antigravity uygulamasının açık ve oturumunun açık olduğundan emin olun. ' +
          `Ayrıntı: ${detail}`,
        `Antigravity could not open a conversation (${sessions.length} server(s) tried). ` +
          'Make sure the Antigravity app is open and signed in. ' +
          `Detail: ${detail}`,
      ),
      failureKind: classified.kind,
      retryHint: classified.retryHint,
    };
  }

  const conversationId = findConversationId(parsed.response) ??
    (typeof parsed.response?.id === 'string' ? parsed.response.id : undefined) ??
    (await newestConversationSince(session, started));
  if (!conversationId) {
    return {
      agent: 'antigravity',
      ok: false,
      text: '',
      raw: startRes.raw,
      exitCode: startRes.exitCode,
      durationMs: Date.now() - started,
      error: L(`Konuşma kimliği alınamadı: ${startRes.stdout.slice(0, 300)}`, `Could not obtain a conversation id: ${startRes.stdout.slice(0, 300)}`),
    };
  }

  // Konusmanin bagli oldugu klasor: dogruysa kimlik kalici olarak ogrenilir.
  const meta = await conversationMetadata(session, conversationId, req.cwd).catch(() => null);
  if (meta?.uris.length) {
    if (urisInclude(meta.uris, req.cwd)) {
      const cache = await loadProjectCache();
      cache.folders[path.resolve(req.cwd)] = meta.projectId;
      cache.conversations[conversationId] = meta;
      await saveProjectCache(cache);
    } else {
      req.onChunk?.(L(
        `\n[Konsey] Antigravity konuşması başka bir çalışma alanına bağlandı; dosyalar mutlak yolla ${req.cwd} altına yazılacak.\n`,
        `\n[Konsey] The Antigravity conversation attached to a different workspace; files will be written under ${req.cwd} using absolute paths.\n`,
      ));
    }
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
    error: done.timedOut ? L('Zaman aşımı', 'Timed out') : done.aborted ? L('İptal edildi', 'Cancelled') : undefined,
    failureKind: done.timedOut ? 'timeout' : done.aborted ? 'cancelled' : classified.kind,
    retryHint: classified.retryHint,
  };
}
