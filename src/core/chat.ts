/**
 * Sohbet: kullanici ajanlarla birebir ya da Konsey masasinda hep birlikte konusur.
 *
 * Sohbet turlari SALT OKUNUR calisir: ajan proje dosyalarini okuyabilir ama
 * degistiremez. Kod degisikligi her zaman izole worktree akisindan (gorev) gecer.
 *
 * Masada ajanlar sirayla konusur; her biri kendinden oncekilerin soylediklerini
 * gorur ve kisaca katilir ya da itiraz eder. Boylece fikir alisverisi olusur.
 */
import type { ActiveIntegration } from './integrations';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAgent, agentLabel } from './adapters';
import { createActivityParser } from './activity';
import { computeQuotas, recordLimits, recordUsage } from './usage';
import type {
  AgentId,
  AgentProfile,
  ChatMessage,
  KonseyEvent,
  ModelSelection,
  ProviderConfig,
} from '../shared/types';
import { L, replyLanguage } from '../shared/i18n';

const DIR = path.join(process.env.KONSEY_HOME ?? path.join(os.homedir(), '.konsey'), 'chats');
const MAX_PER_THREAD = 300;
const HISTORY_TURNS = 14;

type Store = Record<string, ChatMessage[]>;

function fileFor(projectDir: string | null): string {
  const key = projectDir ? createHash('sha1').update(path.resolve(projectDir)).digest('hex').slice(0, 16) : 'global';
  return path.join(DIR, `${key}.json`);
}

const stores = new Map<string, Store>();
let writing: Promise<void> = Promise.resolve();

export async function loadChats(projectDir: string | null): Promise<Store> {
  const file = fileFor(projectDir);
  const cached = stores.get(file);
  if (cached) return cached;
  let store: Store = {};
  try {
    store = JSON.parse(await readFile(file, 'utf8')) as Store;
  } catch {
    store = {};
  }
  // Uygulama kapanirken yarim kalmis mesajlar bekler gorunmesin.
  for (const messages of Object.values(store)) for (const m of messages) if (m.pending) m.pending = false;
  stores.set(file, store);
  return store;
}

async function saveChats(projectDir: string | null): Promise<void> {
  const file = fileFor(projectDir);
  const store = stores.get(file);
  if (!store) return;
  writing = writing
    .then(async () => {
      await mkdir(DIR, { recursive: true });
      await writeFile(file, JSON.stringify(store), 'utf8');
    })
    .catch(() => {});
  return writing;
}

/** Mesaji depoya ekler ya da ayni kimlikliyi gunceller. */
export async function putMessage(projectDir: string | null, message: ChatMessage): Promise<void> {
  const store = await loadChats(projectDir);
  const list = (store[message.thread] ??= []);
  const index = list.findIndex((m) => m.id === message.id);
  if (index >= 0) list[index] = message;
  else list.push(message);
  if (list.length > MAX_PER_THREAD) list.splice(0, list.length - MAX_PER_THREAD);
  await saveChats(projectDir);
}

export async function clearThread(projectDir: string | null, thread: string): Promise<void> {
  const store = await loadChats(projectDir);
  delete store[thread];
  await saveChats(projectDir);
}

/** Sohbet icin hizli ve ucuz model secimi; derin muhakeme gorev akisina birakilir. */
function chatModel(agent: AgentId): ModelSelection {
  if (agent === 'claude') return { model: 'sonnet', effort: 'low' };
  if (agent === 'codex') return { effort: 'low' };
  if (agent === 'antigravity') return { model: 'flash', fallbackModels: ['flash_lite'] };
  return {};
}

function speaker(from: ChatMessage['from'], providers: ProviderConfig[]): string {
  if (from === 'user') return 'Kullanıcı';
  if (from === 'orchestrator') return 'Konsey';
  return agentLabel(from, providers);
}

function chatPrompt(opts: {
  agent: AgentId;
  label: string;
  others: string[];
  projectDir: string | null;
  history: ChatMessage[];
  providers: ProviderConfig[];
  council: boolean;
  listing?: string;
}): string {
  const transcript = opts.history
    .filter((m) => !m.pending && m.text.trim())
    .slice(-HISTORY_TURNS)
    .map((m) => `${speaker(m.from, opts.providers)}: ${m.text.trim().slice(0, 1500)}`)
    .join('\n\n');

  const role = opts.council
    ? `Şu an bir masa toplantısındasın. Masada senden başka ${opts.others.join(', ') || 'kimse'} var.
Diğerlerinin söylediklerini oku; katılıyorsan kısaca ekle, katılmıyorsan nedenini söyle, tekrar etme.
En fazla 3-4 cümle yaz. Adını yazma, doğrudan konuş.`
    : `Kullanıcı seninle birebir konuşuyor. Net, yardımsever ve kısa cevap ver; gerekiyorsa kod örneği ver.`;

  return `Sen ${opts.label} adlı yapay zekâ ajanısın. Konsey adlı bir masaüstü uygulamasında diğer ajanlarla birlikte kullanıcının yazılım projesinde çalışıyorsun.
${opts.projectDir ? `Proje klasörü: ${opts.projectDir}.${opts.listing ? ` Kök içeriği: ${opts.listing}.` : ''} ${opts.agent.startsWith('provider:') ? 'Dosya okuyamazsın; yalnızca bu bilgiye ve konuşmaya dayan.' : 'Gerekirse dosyaları okuyabilirsin.'}` : 'Henüz bir proje seçilmedi.'}
Bu bir SOHBET turudur: hiçbir dosyayı oluşturma, değiştirme veya silme; komut çalıştırıp bir şey kurma.
Kod yazılması gerekiyorsa bunu öner; kullanıcı "Göreve dönüştür" ile işi başlatır.
${replyLanguage()} Markdown kullanabilirsin.
${role}

KONUŞMA:
${transcript}

Şimdi ${opts.label} olarak cevap ver:`;
}

export interface ChatRequest {
  projectDir: string | null;
  thread: 'council' | AgentId;
  text: string;
  profiles: AgentProfile[];
  providers: ProviderConfig[];
  /** Bagli servisler; sohbette de ajanlar bunlara bakabilir. */
  integrations?: ActiveIntegration[];
  signal?: AbortSignal;
  emit: (event: KonseyEvent) => void;
  /** Kullanici mesaji onceden kaydedilip yayinlandiysa tekrar eklenmez. */
  userAlreadyPosted?: boolean;
}

/** Kullanici mesajini hemen kaydeder ve arayuze yollar (ajan kesfi beklenmeden). */
export async function postUserMessage(
  projectDir: string | null,
  thread: ChatMessage['thread'],
  text: string,
  emit: (event: KonseyEvent) => void,
): Promise<void> {
  const message: ChatMessage = { id: randomUUID(), thread, from: 'user', text, at: Date.now(), kind: 'chat' };
  await putMessage(projectDir, message);
  emit({ type: 'chat:message', message });
}

/** Kullanici mesajini kaydeder, ilgili ajan(lar)in cevaplarini sirayla uretir. */
export async function sendChat(req: ChatRequest): Promise<void> {
  const store = await loadChats(req.projectDir);
  if (!req.userAlreadyPosted) await postUserMessage(req.projectDir, req.thread, req.text, req.emit);

  const enabled = [
    ...req.profiles.filter((p) => p.enabled).map((p) => p.agent),
    ...req.providers.filter((p) => p.enabled).map((p) => `provider:${p.slug}` as AgentId),
  ];
  const speakers = req.thread === 'council' ? enabled : [req.thread as AgentId];
  const quotas = await computeQuotas(req.profiles, req.providers).catch(() => []);
  // Dosya okuyamayan saglayicilar icin kok klasorun kisa listesi.
  let listing = '';
  if (req.projectDir) {
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(req.projectDir).catch(() => [] as string[]);
    listing = names.filter((n) => !n.startsWith('.') && n !== 'node_modules').slice(0, 40).join(', ') || '(boş)';
  }
  const labels = speakers.map((a) => agentLabel(a, req.providers, req.profiles));

  for (const agent of speakers) {
    if (req.signal?.aborted) break;
    const label = agentLabel(agent, req.providers, req.profiles);
    const quota = quotas.find((q) => q.agent === agent);
    const id = randomUUID();
    const base: ChatMessage = { id, thread: req.thread, from: agent, text: '', at: Date.now(), kind: 'chat' };

    if (quota?.capped) {
      const note: ChatMessage = {
        ...base,
        kind: 'error',
        text: L(
          `Kullanım payım doldu (%${quota.usedPercent} / izin verilen %${quota.capPercent}). Ayarlardan payımı artırırsan konuşabilirim.`,
          `My usage share is full (%${quota.usedPercent} / allowed %${quota.capPercent}). I can talk again if you raise my share in settings.`,
        ),
      };
      await putMessage(req.projectDir, note);
      req.emit({ type: 'chat:done', message: note });
      if (req.thread !== 'council') return;
      continue;
    }

    const pending: ChatMessage = { ...base, pending: true };
    await putMessage(req.projectDir, pending);
    req.emit({ type: 'chat:message', message: pending });

    const history = store[req.thread] ?? [];
    const prompt = chatPrompt({
      agent,
      label,
      others: labels.filter((l) => l !== label),
      projectDir: req.projectDir,
      history,
      providers: req.providers,
      council: req.thread === 'council',
      listing,
    });

    const parse = createActivityParser(agent);
    let live = '';
    const result = await runAgent({
      runId: `chat-${id.slice(0, 6)}`,
      agent,
      cwd: req.projectDir ?? os.homedir(),
      prompt,
      allowWrite: false,
      lean: true,
      timeoutMs: 4 * 60 * 1000,
      signal: req.signal,
      ...chatModel(agent),
      onChunk: (chunk) => {
        for (const item of parse(chunk)) {
          live = item.tone === 'say' ? item.text : live || `${item.text}…`;
          req.emit({ type: 'chat:delta', id, thread: req.thread, text: item.tone === 'say' ? item.text : `_${item.text}…_` });
        }
      },
    }, { providers: req.providers, profiles: req.profiles, integrations: req.integrations });

    // Hic calismadan donen (bulunamadi, pay dolu) cagrilar kullanima sayilmaz.
    if (result.ok || result.usage || result.durationMs > 0) {
      await recordUsage(agent, {
        tokens: result.usage?.totalTokens,
        costUsd: result.usage?.costUsd,
        durationMs: result.durationMs,
      }).catch(() => {});
    }
    if (result.limits?.length) await recordLimits(agent, result.limits).catch(() => {});

    const final: ChatMessage = result.ok
      ? { ...base, text: result.text.trim(), at: Date.now() }
      : {
          ...base,
          kind: 'error',
          at: Date.now(),
          text: result.failureKind === 'cancelled'
            ? L('Durduruldu.', 'Stopped.')
            : L(`Cevap veremedim: ${(result.error ?? 'bilinmeyen hata').slice(0, 400)}`, `I couldn't respond: ${(result.error ?? 'unknown error').slice(0, 400)}`),
        };
    if (!final.text) final.text = live || L('(boş cevap)', '(empty response)');
    await putMessage(req.projectDir, final);
    req.emit({ type: 'chat:done', message: final });
  }

  const refreshed = await computeQuotas(req.profiles, req.providers).catch(() => null);
  if (refreshed) req.emit({ type: 'quota:updated', quotas: refreshed });
}

/** Calisma sirasinda uretilen ajan notlari da Konsey masasi gecmisine yazilir. */
export async function recordRunNote(projectDir: string, message: ChatMessage): Promise<void> {
  await putMessage(projectDir, message);
}
