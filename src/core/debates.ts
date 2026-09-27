/**
 * Tartis modu: bir fikri ajanlara tartistirir, Konsey karar notu yazar.
 *
 * Tartisma bir projeye bagli olabilir ya da hic proje olmadan (serbest fikir)
 * acilabilir. Acilis turunda ajanlar birbirini gormeden, kendi rolleriyle
 * (mimar, elestirmen, kullanici sesi, pragmatist) konusur; sonraki turlarda
 * birbirine cevap verir. Her tur dizisinin sonunda moderator ajan karari,
 * ilk surumu, riskleri ve ilk adimlari tek bir notta toplar.
 *
 * Tartisma turlari da sohbet gibi SALT OKUNURDUR. "Projeye donustur" secilen
 * yere bir klasor ve tartisma dosyasi acar; kod isi her zaman gorev akisindan
 * (izole worktree) gecer.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveIntegration } from './integrations';
import { agentLabel } from './adapters';
import { talkTurn } from './chat';
import { prepareRepo } from './git';
import { computeQuotas } from './usage';
import type {
  AgentId,
  AgentProfile,
  Debate,
  DebateMessage,
  DebateRole,
  DebateSummary,
  KonseyEvent,
  ProviderConfig,
} from '../shared/types';
import { L, locale, replyLanguage } from '../shared/i18n';
import { assignRoles, roleBrief, roleName, slugify } from '../shared/debate';

export { assignRoles, slugify };

const home = () => process.env.KONSEY_HOME ?? path.join(os.homedir(), '.konsey');
const dir = () => path.join(home(), 'debates');
/** Projesiz tartismalarda ajanlarin calistigi bos klasor; ev dizinini taramazlar. */
const room = () => path.join(home(), 'debate-room');

const HISTORY = 28;

// ---------------------------------------------------------------- depo

const cache = new Map<string, Debate>();
/** Konusma surerken silinen tartisma turun sonunda yeniden yazilmasin. */
const deleted = new Set<string>();
let writing: Promise<void> = Promise.resolve();

function fileFor(id: string): string {
  if (!/^[a-z0-9-]{8,64}$/i.test(id)) throw new Error(L('Geçersiz tartışma kimliği.', 'Invalid discussion id.'));
  return path.join(dir(), `${id}.json`);
}

export async function getDebate(id: string): Promise<Debate | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const debate = JSON.parse(await readFile(fileFor(id), 'utf8')) as Debate;
    // Uygulama kapanirken yarida kalan turlar bekler gorunmesin.
    debate.busy = undefined;
    for (const m of debate.messages) {
      if (!m.pending) continue;
      m.pending = false;
      if (!m.text.trim()) {
        m.kind = 'error';
        m.text = L('Yarıda kaldı.', 'Interrupted.');
      }
    }
    cache.set(id, debate);
    return debate;
  } catch {
    return null;
  }
}

async function save(debate: Debate): Promise<void> {
  if (deleted.has(debate.id)) return;
  debate.updatedAt = Date.now();
  cache.set(debate.id, debate);
  const file = fileFor(debate.id);
  const body = JSON.stringify(debate);
  writing = writing
    .then(async () => {
      await mkdir(dir(), { recursive: true });
      await writeFile(file, body, 'utf8');
    })
    .catch(() => {});
  return writing;
}

export function summaryOf(debate: Debate): DebateSummary {
  return {
    id: debate.id,
    title: debate.title,
    projectDir: debate.projectDir,
    updatedAt: debate.updatedAt,
    score: debate.summary?.score,
    busy: debate.busy,
    converted: Boolean(debate.converted),
  };
}

const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);

/** Serbest fikirler ve (secildiyse) bu projeye ait tartismalar; en yenisi basta. */
export async function listDebates(projectDir: string | null): Promise<DebateSummary[]> {
  const names = await readdir(dir()).catch(() => [] as string[]);
  const list: DebateSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const debate = await getDebate(name.slice(0, -5)).catch(() => null);
    if (!debate) continue;
    if (debate.projectDir && !(projectDir && same(debate.projectDir, projectDir))) continue;
    list.push(summaryOf(debate));
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDebate(id: string): Promise<void> {
  deleted.add(id);
  cache.delete(id);
  await writing;
  await rm(fileFor(id), { force: true });
}

function titleFrom(topic: string): string {
  const line = topic.trim().split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 77).trimEnd()}…` : line || L('Adsız fikir', 'Untitled idea');
}

export async function createDebate(topic: string, projectDir: string | null): Promise<Debate> {
  const text = topic.trim();
  if (!text) throw new Error(L('Tartışılacak fikri yaz.', 'Write the idea to discuss.'));
  const now = Date.now();
  const debate: Debate = {
    id: randomUUID(),
    title: titleFrom(text),
    topic: text,
    projectDir,
    createdAt: now,
    updatedAt: now,
    messages: [{ id: randomUUID(), from: 'user', text, at: now, round: 0, kind: 'user' }],
  };
  await save(debate);
  return debate;
}

export async function renameDebate(id: string, title: string): Promise<Debate | null> {
  const debate = await getDebate(id);
  if (!debate || !title.trim()) return debate;
  debate.title = title.trim().slice(0, 80);
  await save(debate);
  return debate;
}

// ---------------------------------------------------------------- roller ve istemler

function lastRound(debate: Debate): number {
  return debate.messages.reduce((max, m) => Math.max(max, m.round), 0);
}

interface Talk {
  profiles: AgentProfile[];
  providers: ProviderConfig[];
  integrations?: ActiveIntegration[];
  coordinator?: AgentId | null;
  signal?: AbortSignal;
  emit: (event: KonseyEvent) => void;
}

function speakerName(from: DebateMessage['from'], role: DebateRole | undefined, talk: Talk): string {
  if (from === 'user') return 'Kullanıcı';
  if (from === 'orchestrator') return 'Konsey';
  const label = agentLabel(from, talk.providers, talk.profiles);
  return role ? `${label} (${roleName(role)})` : label;
}

function transcript(debate: Debate, talk: Talk): string {
  return debate.messages
    .filter((m) => !m.pending && m.kind !== 'error' && m.text.trim())
    .slice(1)
    .slice(-HISTORY)
    .map((m) => `${speakerName(m.from, m.role, talk)}: ${m.text.trim().slice(0, 2500)}`)
    .join('\n\n');
}

async function context(debate: Debate, agent: AgentId): Promise<string> {
  if (!debate.projectDir) {
    return 'Bu serbest bir fikir tartışması; henüz bir proje ya da kod yok. Dosya okumana gerek yok.';
  }
  if (!agent.startsWith('provider:')) {
    return `Tartışma şu yazılım projesiyle ilgili: ${debate.projectDir}. Gerekirse proje dosyalarını okuyabilirsin.`;
  }
  const names = await readdir(debate.projectDir).catch(() => [] as string[]);
  const listing = names.filter((n) => !n.startsWith('.') && n !== 'node_modules').slice(0, 40).join(', ') || '(boş)';
  return `Tartışma şu yazılım projesiyle ilgili: ${debate.projectDir}. Kök içeriği: ${listing}. Dosya okuyamazsın; bu bilgiye ve konuşmaya dayan.`;
}

async function roundPrompt(debate: Debate, agent: AgentId, round: number, talk: Talk): Promise<string> {
  const label = agentLabel(agent, talk.providers, talk.profiles);
  const role = debate.roles?.[agent] ?? 'all';
  const history = transcript(debate, talk);
  const opening = round === 1;
  // Kullanici onceki turdan sonra yazdiysa bu turdaki her ajan once ona cevap verir.
  const lastUser = debate.messages.findLastIndex((m, i) => i > 0 && m.from === 'user');
  const lastPrevious = debate.messages.findLastIndex((m) => m.from !== 'user' && m.round < round);
  const userJustSpoke = !opening && lastUser > lastPrevious;

  return `Sen ${label} adlı yapay zekâ ajanısın. Konsey adlı uygulamada diğer ajanlarla bir fikri tartışıyorsunuz. Amaç fikri dürüstçe değerlendirmek ve yapılacaksa en iyi hâline getirmek.
${await context(debate, agent)}
Bu bir TARTIŞMA turudur: hiçbir dosyayı oluşturma, değiştirme veya silme; komut çalıştırıp bir şey kurma.
Rolün: ${roleName(role)}. ${roleBrief(role)}
${opening
    ? 'Bu açılış turu: fikri kendi rolünün gözüyle, diğerlerini görmeden değerlendir.'
    : 'Diğerlerinin söylediklerini oku. Katıldığın yeri kısaca belirt, katılmadığın yere gerekçeyle itiraz et, yeni bir şey ekle. Tekrar etme; ortak bir karara yaklaşmaya çalış.'}
${userJustSpoke ? 'Kullanıcı az önce araya girdi; önce onun söylediğine cevap ver.' : ''}
Kısa ve somut yaz: en fazla 150 kelime, gerekirse madde işaretleri. Adını ya da rolünü başa yazma.
${replyLanguage()} Markdown kullanabilirsin.

FİKİR:
${debate.topic.slice(0, 6000)}
${!opening && history ? `\nTARTIŞMA:\n${history}\n` : ''}
Şimdi ${label} olarak yaz:`;
}

function summaryTemplate(): string {
  return [
    `## ${L('Karar', 'Verdict')}`,
    L('Tek paragraf: yapmaya değer mi, hangi koşulla? Paragrafın sonuna "Puan: X/10" yaz.', 'One paragraph: is it worth building, and under what conditions? End the paragraph with "Score: X/10".'),
    `## ${L('Önerilen ilk sürüm', 'Suggested first version')}`,
    L('3-6 madde: ilk sürümde neler olmalı.', '3-6 bullets: what the first version should include.'),
    `## ${L('Teknik yaklaşım', 'Technical approach')}`,
    L('2-5 madde: teknoloji, mimari, önemli seçimler.', '2-5 bullets: technology, architecture, key choices.'),
    `## ${L('Riskler', 'Risks')}`,
    L('2-5 madde.', '2-5 bullets.'),
    `## ${L('Açık sorular', 'Open questions')}`,
    L('Kullanıcıya sorulması gerekenler (yoksa "Yok").', 'What still needs to be asked of the user (or "None").'),
    `## ${L('İlk adımlar', 'First steps')}`,
    L('Numaralı 3-5 adım.', '3-5 numbered steps.'),
  ].join('\n');
}

async function summaryPrompt(debate: Debate, agent: AgentId, talk: Talk): Promise<string> {
  return `Sen Konsey'in moderatörüsün. Aşağıdaki fikir tartışmasını tarafsızca toparla ve bir karar notu yaz. Ajanların ortak noktalarını ve ayrıldıkları yerleri dikkate al; kendi fikrini değil tartışmanın sonucunu yaz.
${await context(debate, agent)}
Hiçbir dosyayı değiştirme, komut çalıştırma.
${replyLanguage()}
Yalnızca aşağıdaki Markdown şablonunu doldur, başka bir şey ekleme:

${summaryTemplate()}

En son satıra yalnızca şunu yaz: ${L('Ad', 'Name')}: <${L('proje için kısa, küçük harfli, tireli klasör adı (örn. akilli-market-listesi)', 'a short, lowercase, hyphenated folder name for the project (e.g. smart-grocery-list)')}>

FİKİR:
${debate.topic.slice(0, 6000)}

TARTIŞMA:
${transcript(debate, talk)}`;
}

/** Ozet metninden puani ve onerilen klasor adini ayirir. */
export function parseSummary(text: string): { text: string; score?: number; name?: string } {
  let body = text.trim();
  let name: string | undefined;
  const nameLine = body.match(/^\s*(?:\*\*)?(?:Ad|Name|Proje adı|Project name)(?:\*\*)?\s*:\s*`?([a-z0-9][a-z0-9-]{1,60})`?\s*$/im);
  if (nameLine) {
    name = nameLine[1].replace(/-+$/, '');
    body = body.replace(nameLine[0], '').trim();
  }
  const scoreMatch = body.match(/(?:Puan|Score)\s*:?\s*\**\s*(\d+(?:[.,]\d+)?)\s*\/\s*10/i);
  const score = scoreMatch ? Math.max(0, Math.min(10, Number(scoreMatch[1].replace(',', '.')))) : undefined;
  return { text: body, score: Number.isFinite(score) ? score : undefined, name };
}

// ---------------------------------------------------------------- turlar

function speakersOf(talk: Talk): AgentId[] {
  return [
    ...talk.profiles.filter((p) => p.enabled).map((p) => p.agent),
    ...talk.providers.filter((p) => p.enabled).map((p) => `provider:${p.slug}` as AgentId),
  ];
}

/** Karar notunu yazacak ajan: secili koordinator, yoksa en guclu CLI. */
export function pickModerator(speakers: AgentId[], coordinator?: AgentId | null): AgentId[] {
  const order = [
    ...(coordinator && speakers.includes(coordinator) ? [coordinator] : []),
    ...(['claude', 'codex'] as AgentId[]).filter((a) => speakers.includes(a)),
    ...speakers.filter((a) => a.startsWith('cli:')),
    ...speakers,
  ];
  return [...new Set(order)];
}

async function workDir(debate: Debate): Promise<string> {
  if (debate.projectDir) {
    const info = await stat(debate.projectDir).catch(() => null);
    if (info?.isDirectory()) return debate.projectDir;
  }
  await mkdir(room(), { recursive: true });
  return room();
}

function publish(debate: Debate, talk: Talk): void {
  if (deleted.has(debate.id)) return;
  talk.emit({ type: 'debate:updated', debate: structuredClone(debate) });
}

async function note(debate: Debate, talk: Talk, text: string): Promise<void> {
  debate.messages.push({ id: randomUUID(), from: 'orchestrator', text, at: Date.now(), round: lastRound(debate), kind: 'error' });
  await save(debate);
  publish(debate, talk);
}

async function speak(debate: Debate, agent: AgentId, round: number, prompt: string, cwd: string, talk: Talk): Promise<boolean> {
  const message: DebateMessage = {
    id: randomUUID(),
    from: agent,
    text: '',
    at: Date.now(),
    round,
    role: debate.roles?.[agent],
    kind: 'say',
    pending: true,
  };
  debate.messages.push(message);
  await save(debate);
  publish(debate, talk);

  const turn = await talkTurn({
    agent,
    prompt,
    cwd,
    signal: talk.signal,
    profiles: talk.profiles,
    providers: talk.providers,
    integrations: talk.integrations,
    onLive: (text) => talk.emit({ type: 'debate:delta', debateId: debate.id, id: message.id, from: agent, text }),
  });
  message.pending = false;
  message.text = turn.text;
  message.kind = turn.ok ? 'say' : 'error';
  message.at = Date.now();
  await save(debate);
  publish(debate, talk);
  return turn.ok;
}

async function summarize(debate: Debate, speakers: AgentId[], cwd: string, talk: Talk): Promise<void> {
  debate.busy = 'summary';
  await save(debate);
  publish(debate, talk);
  // Moderator cevap veremezse (limit, hata) siradaki ajan dener.
  for (const agent of pickModerator(speakers, talk.coordinator).slice(0, 2)) {
    if (talk.signal?.aborted) return;
    const turn = await talkTurn({
      agent,
      prompt: await summaryPrompt(debate, agent, talk),
      cwd,
      signal: talk.signal,
      profiles: talk.profiles,
      providers: talk.providers,
      integrations: talk.integrations,
      onLive: (text) => talk.emit({ type: 'debate:delta', debateId: debate.id, id: 'summary', from: agent, text }),
    });
    if (turn.cancelled) return;
    if (turn.ok && turn.text.trim()) {
      const parsed = parseSummary(turn.text);
      debate.summary = { text: parsed.text, at: Date.now(), by: agent, score: parsed.score, name: parsed.name ?? debate.summary?.name };
      await save(debate);
      publish(debate, talk);
      return;
    }
  }
  await note(debate, talk, L('Karar notu yazılamadı. “Özetle”ye basarak yeniden deneyebilirsin.', 'The decision note could not be written. Press “Summarize” to try again.'));
}

export interface AdvanceOptions extends Talk {
  /** Kac tur konusulacak (0: yalnizca ozet). */
  rounds: number;
  summarize: boolean;
}

/** Tartismayi ilerletir: turlar sirasinda her mesaj aninda yayinlanir. */
export async function advanceDebate(id: string, opts: AdvanceOptions): Promise<void> {
  const debate = await getDebate(id);
  if (!debate) throw new Error(L('Tartışma bulunamadı.', 'Discussion not found.'));
  if (debate.busy) throw new Error(L('Bu tartışma zaten sürüyor.', 'This discussion is already running.'));

  const quotas = await computeQuotas(opts.profiles, opts.providers).catch(() => []);
  const capped = new Set(quotas.filter((q) => q.capped).map((q) => q.agent));
  const speakers = speakersOf(opts).filter((a) => !capped.has(a));
  if (!speakers.length) {
    await note(debate, opts, capped.size
      ? L('Açık ajanların kullanım payı dolu. Ayarlardan payı artırabilir ya da başka bir ajanı açabilirsin.', 'The open agents have used up their share. Raise the share in settings or turn on another agent.')
      : L('Konuşabilecek açık ajan yok. Soldan bir ajanı aç ya da “Nasıl çalışır?”dan ajan bağla.', 'No open agent can talk. Turn one on in the sidebar or connect one from “How it works”.'));
    return;
  }

  debate.roles = assignRoles(debate.roles, speakers);
  debate.busy = 'round';
  await save(debate);
  publish(debate, opts);

  try {
    const cwd = await workDir(debate);
    for (let i = 0; i < opts.rounds; i++) {
      if (opts.signal?.aborted) break;
      const round = lastRound(debate) + 1;
      if (round === 1) {
        // Acilis: ajanlar birbirinden etkilenmeden, ayni anda konusur.
        const prompts = await Promise.all(speakers.map((a) => roundPrompt(debate, a, round, opts)));
        await Promise.all(speakers.map((a, n) => speak(debate, a, round, prompts[n], cwd, opts)));
      } else {
        for (const agent of speakers) {
          if (opts.signal?.aborted) break;
          await speak(debate, agent, round, await roundPrompt(debate, agent, round, opts), cwd, opts);
        }
      }
    }
    const spoken = debate.messages.some((m) => m.kind === 'say' && m.text.trim());
    if (opts.summarize && spoken && !opts.signal?.aborted) await summarize(debate, speakers, cwd, opts);
  } finally {
    debate.busy = undefined;
    await save(debate);
    publish(debate, opts);
    const refreshed = await computeQuotas(opts.profiles, opts.providers).catch(() => null);
    if (refreshed) opts.emit({ type: 'quota:updated', quotas: refreshed });
  }
}

/** Kullanici tartismaya katilir; ajanlar bir tur cevap verir, not guncellenir. */
export async function postToDebate(id: string, text: string): Promise<Debate> {
  const debate = await getDebate(id);
  if (!debate) throw new Error(L('Tartışma bulunamadı.', 'Discussion not found.'));
  if (debate.busy) throw new Error(L('Ajanlar hâlâ konuşuyor; bitince yaz ya da durdur.', 'The agents are still talking; write when they finish or stop them.'));
  debate.messages.push({ id: randomUUID(), from: 'user', text: text.trim(), at: Date.now(), round: lastRound(debate), kind: 'user' });
  await save(debate);
  return debate;
}

// ---------------------------------------------------------------- projeye donusturme

/** Var olan ve dolu bir klasorun ustune yazilmaz; -2, -3 eklenir. */
export async function freeDir(parent: string, name: string): Promise<string> {
  const base = slugify(name);
  for (let n = 1; n < 100; n++) {
    const candidate = path.join(parent, n === 1 ? base : `${base}-${n}`);
    const entries = await readdir(candidate).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : ['?']));
    if (entries === null || entries.filter((e) => e !== '.DS_Store').length === 0) return candidate;
  }
  return path.join(parent, `${base}-${randomUUID().slice(0, 6)}`);
}

async function freeFile(file: string): Promise<string> {
  const ext = path.extname(file);
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? file : `${file.slice(0, -ext.length)}-${n}${ext}`;
    if (!(await stat(candidate).catch(() => null))) return candidate;
  }
  return file;
}

function participants(debate: Debate, talk: Pick<Talk, 'profiles' | 'providers'>): string {
  const agents = [...new Set(debate.messages.filter((m) => m.kind === 'say').map((m) => m.from))];
  return agents.map((a) => agentLabel(a as AgentId, talk.providers, talk.profiles)).join(', ');
}

/** Tartisma dosyasi: fikir, kullanicinin notu, karar notu ve tam dokum. */
export function debateMarkdown(debate: Debate, details: string, talk: Pick<Talk, 'profiles' | 'providers'>): string {
  const when = new Date().toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
  const lines: string[] = [
    `# ${debate.title}`,
    '',
    `> ${L('Konsey tartışması', 'Konsey discussion')} · ${when}${participants(debate, talk) ? ` · ${participants(debate, talk)}` : ''}`,
    '',
    `## ${L('Fikir', 'Idea')}`,
    '',
    debate.topic,
    '',
  ];
  if (details.trim()) lines.push(`## ${L('Kullanıcının notu', 'Notes from the user')}`, '', details.trim(), '');
  if (debate.summary) lines.push(`# ${L('Karar notu', 'Decision note')}`, '', debate.summary.text, '');
  lines.push('---', '', `## ${L('Tartışma dökümü', 'Discussion transcript')}`, '');
  let round = -1;
  for (const m of debate.messages.slice(1)) {
    if (m.kind === 'error' || m.pending || !m.text.trim()) continue;
    if (m.from !== 'user' && m.round !== round) {
      round = m.round;
      lines.push(`### ${L(`${round}. tur`, `Round ${round}`)}`, '');
    }
    const who = m.from === 'user'
      ? L('Kullanıcı', 'User')
      : `${agentLabel(m.from as AgentId, talk.providers, talk.profiles)}${m.role ? ` · ${roleName(m.role)}` : ''}`;
    lines.push(`**${who}**`, '', m.text.trim(), '');
  }
  return `${lines.join('\n').trim()}\n`;
}

/** Gorev istemi: ilk satir baslik olur (gorev listesinde gorunur). */
export function conversionPrompt(debate: Debate, opts: { details: string; file: string; isNew: boolean }): string {
  const decision = debate.summary?.text
    ?? debate.messages
      .filter((m) => m.kind === 'say' && m.text.trim())
      .slice(-6)
      .map((m) => `- ${m.text.trim().replace(/\s+/g, ' ').slice(0, 700)}`)
      .join('\n');
  const parts = [
    debate.title,
    '',
    ...(opts.details.trim() ? [`${L('Kullanıcının notu', 'Notes from the user')}:`, opts.details.trim(), ''] : []),
    debate.summary
      ? L('Bu fikir Konsey’de ajanlarla tartışıldı. Karar notu:', 'This idea was discussed by the agents in Konsey. Decision note:')
      : L('Bu fikir Konsey’de ajanlarla tartışıldı. Öne çıkanlar:', 'This idea was discussed by the agents in Konsey. Highlights:'),
    decision,
    '',
    L(`Tartışmanın tamamı: ${opts.file}`, `Full discussion: ${opts.file}`),
    '',
    opts.isNew
      ? L(
          'Klasör yeni açıldı. Bu fikrin ilk çalışır sürümünü kur: karar notundaki “Önerilen ilk sürüm” maddelerini yap, README.md dosyasında nasıl kurulup çalıştırılacağını anlat. Kullanıcının notu karar notuyla çelişirse kullanıcının notu geçerlidir.',
          'The folder is new. Build the first working version of this idea: implement the “Suggested first version” items from the decision note and explain in README.md how to install and run it. If the user’s notes conflict with the decision note, the user’s notes win.',
        )
      : L(
          'Karar notundaki planı bu projeye uygula; önce “Önerilen ilk sürüm” ve “İlk adımlar”a odaklan. Kullanıcının notu karar notuyla çelişirse kullanıcının notu geçerlidir.',
          'Apply the plan from the decision note to this project, starting with the “Suggested first version” and “First steps”. If the user’s notes conflict with the decision note, the user’s notes win.',
        ),
  ];
  return parts.join('\n').trim();
}

export interface ConvertOptions {
  /** Serbest fikirde yeni klasorun olusturulacagi ust klasor. */
  parentDir?: string;
  /** Serbest fikirde klasor adi. */
  name?: string;
  details: string;
  profiles: AgentProfile[];
  providers: ProviderConfig[];
  emit: (event: KonseyEvent) => void;
}

/**
 * Tartismayi isler hale getirir: serbest fikirde secilen yere yeni klasor ve
 * KONSEY.md acilip git deposu hazirlanir; projeye bagli tartismada dosya
 * docs/konsey/ altina yazilir. Gorevi arayuz baslatir.
 */
export async function convertDebate(id: string, opts: ConvertOptions): Promise<{ projectDir: string; file: string; prompt: string; isNew: boolean }> {
  const debate = await getDebate(id);
  if (!debate) throw new Error(L('Tartışma bulunamadı.', 'Discussion not found.'));
  if (debate.busy) throw new Error(L('Ajanlar hâlâ konuşuyor; bitmesini bekle ya da durdur.', 'The agents are still talking; wait for them or stop them.'));

  const isNew = !debate.projectDir;
  let projectDir: string;
  let file: string;
  if (isNew) {
    if (!opts.parentDir) throw new Error(L('Projenin açılacağı yeri seç.', 'Choose where to create the project.'));
    projectDir = await freeDir(opts.parentDir, opts.name?.trim() || debate.summary?.name || debate.title);
    await mkdir(projectDir, { recursive: true });
    file = path.join(projectDir, 'KONSEY.md');
  } else {
    projectDir = debate.projectDir!;
    const info = await stat(projectDir).catch(() => null);
    if (!info?.isDirectory()) throw new Error(L(`Proje klasörü bulunamadı: ${projectDir}`, `Project folder not found: ${projectDir}`));
    const docs = path.join(projectDir, 'docs', 'konsey');
    await mkdir(docs, { recursive: true });
    file = await freeFile(path.join(docs, `${slugify(debate.summary?.name || debate.title)}.md`));
  }

  await writeFile(file, debateMarkdown(debate, opts.details, opts), 'utf8');
  // Yeni klasor ilk commit'le hazirlanir; KONSEY.md boylece ajanlarin kopyalarinda da olur.
  if (isNew) await prepareRepo(projectDir).catch(() => null);

  debate.converted = { projectDir, file, at: Date.now() };
  await save(debate);
  opts.emit({ type: 'debate:updated', debate: structuredClone(debate) });

  const relative = path.relative(projectDir, file).split(path.sep).join('/');
  return { projectDir, file, isNew, prompt: conversionPrompt(debate, { details: opts.details, file: relative, isNew }) };
}
