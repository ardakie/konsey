/**
 * Tartis modu (arayuz): yeni tartisma ekrani, tartisma akisi, karar notu ve
 * "Projeye donustur" penceresi. Tartismalar ana alanda acilir; alttaki yazma
 * kutusu tartisma modunda fikri ya da kullanicinin araya girisini alir.
 */
import type { Debate, DebateMessage, RunMode } from '../../src/shared/types';
import { assignRoles, roleName, slugify } from '../../src/shared/debate';
import { L } from '../../src/shared/i18n';
import { api } from './api';
import {
  closeDebate,
  debateAction,
  draftTask,
  openDebate,
  pickProject,
  removeDebate,
  saveConfig,
  startRun,
  useProject,
} from './actions';
import { autosize, basename, clock, h, icon, md, relTime, tildify, toast } from './dom';
import { openGuide } from './guide';
import { fixButton } from './setup';
import { agents, avatar, invalidate, labelFor, MODES, readiness, state } from './state';

const $ = (id: string) => document.getElementById(id)!;

function fmtScore(score: number): string {
  return `${Number.isInteger(score) ? score : score.toFixed(1)}/10`;
}

function scoreTone(score?: number): string {
  if (score === undefined) return 'neutral';
  return score >= 7 ? '' : score >= 5 ? 'warn' : 'bad';
}

// --------------------------------------------------------------- kenar cubugu

export function debateItems(): Node[] {
  if (!state.debates.length) {
    return [h('li', { class: 'sb-empty' }, L('Henüz tartışma yok. Bir fikrini ajanlara tartıştır.', 'No discussions yet. Put an idea up for debate.'))];
  }
  return state.debates.slice(0, 60).map((d) => h('li', { 'data-key': d.id }, h('button', {
    class: `run-item ${state.debateId === d.id ? 'is-on' : ''}`,
    type: 'button',
    title: d.projectDir ? `${d.title} · ${basename(d.projectDir)}` : `${d.title} · ${L('serbest fikir', 'free idea')}`,
    on: { click: () => void openDebate(d.id) },
  },
    h('span', { class: `debate-mark ${d.projectDir ? '' : 'is-idea'}` }, icon(d.projectDir ? 'debate' : 'bulb')),
    h('span', { class: 'run-item-text' }, d.title),
    d.busy
      ? h('span', { class: 'dot live' })
      : d.converted
        ? h('span', { class: 'debate-done', title: L('Projeye dönüştü', 'Turned into a project') }, icon('check'))
        : d.score !== undefined
          ? h('span', { class: `debate-score ${scoreTone(d.score)}` }, fmtScore(d.score))
          : h('span', { class: 'run-item-time' }, relTime(d.updatedAt)),
  )));
}

// --------------------------------------------------------------- yeni tartisma

function fillPrompt(text: string): void {
  const area = document.getElementById('prompt') as HTMLTextAreaElement | null;
  if (!area) return;
  area.value = text;
  area.dispatchEvent(new Event('input'));
  area.focus();
}

const DEPTHS: { value: number; label: () => string; sub: () => string }[] = [
  { value: 1, label: () => L('Hızlı', 'Quick'), sub: () => L('1 tur', '1 round') },
  { value: 2, label: () => L('Normal', 'Normal'), sub: () => L('2 tur', '2 rounds') },
  { value: 3, label: () => L('Derin', 'Deep'), sub: () => L('3 tur', '3 rounds') },
];

function examples(scope: 'project' | 'free'): { title: string; text: string }[] {
  return scope === 'project'
    ? [
        { title: L('Sıradaki özellik', 'Next feature'), text: L('Bu projeye eklenecek en değerli özellik ne olmalı?', 'What is the most valuable feature to add to this project next?') },
        { title: L('Mimari', 'Architecture'), text: L('Bu projenin mimarisi büyümeye hazır mı? Neyi şimdi değiştirmeliyiz?', 'Is this project’s architecture ready to grow? What should we change now?') },
        { title: L('Kalite', 'Quality'), text: L('Test ve hata yönetimi stratejimiz yeterli mi? En büyük risk nerede?', 'Are our testing and error handling good enough? Where is the biggest risk?') },
        { title: L('Sadeleştirme', 'Simplify'), text: L('Bu projede gereksiz karmaşık olan ne var, nasıl sadeleştiririz?', 'What in this project is needlessly complex, and how do we simplify it?') },
      ]
    : [
        { title: L('Esnaf uygulaması', 'Local shop app'), text: L('Mahalle esnafının WhatsApp yerine kullanacağı basit bir sipariş uygulaması', 'A simple ordering app that neighbourhood shops could use instead of WhatsApp') },
        { title: L('Bütçe takibi', 'Budget tracker'), text: L('Harcamaları fotoğraftan okuyup kategorize eden kişisel bütçe uygulaması', 'A personal budget app that reads receipts from photos and categorises spending') },
        { title: L('Çalışma planlayıcı', 'Study planner'), text: L('Öğrencilerin sınav tarihlerine göre otomatik çalışma planı çıkaran bir uygulama', 'An app that builds a study plan automatically from a student’s exam dates') },
        { title: L('Geliştirici aracı', 'Developer tool'), text: L('Bir kod deposundaki eski bağımlılıkları bulup güvenle güncelleyen komut satırı aracı', 'A command-line tool that finds outdated dependencies in a repo and updates them safely') },
      ];
}

function newView(): HTMLElement {
  const ready = agents().filter((a) => readiness(a).ok);
  const roles = assignRoles(undefined, ready.map((a) => a.id));
  const depth = state.config.ui.debateDepth ?? 2;
  const scope = state.project ? state.debateScope : 'free';
  const setScope = (next: 'project' | 'free') => {
    state.debateScope = next;
    invalidate('flow', 'composer', 'topbar');
  };

  const scopeSeg = h('div', { class: 'seg' },
    h('button', {
      class: `seg-btn ${scope === 'project' ? 'is-on' : ''}`,
      type: 'button',
      title: state.project ? tildify(state.project.dir) : L('Önce bir proje seç', 'Pick a project first'),
      on: { click: () => (state.project ? setScope('project') : void pickProject().then(() => state.project && setScope('project'))) },
    }, icon('folder'), state.project ? L(`Bu proje: ${basename(state.project.dir)}`, `This project: ${basename(state.project.dir)}`) : L('Proje seç…', 'Pick a project…')),
    h('button', {
      class: `seg-btn ${scope === 'free' ? 'is-on' : ''}`,
      type: 'button',
      title: L('Proje olmadan, sadece fikir', 'No project, just an idea'),
      on: { click: () => setScope('free') },
    }, icon('bulb'), L('Serbest fikir', 'Free idea')),
  );

  const depthSeg = h('div', { class: 'seg' }, ...DEPTHS.map((d) => h('button', {
    class: `seg-btn ${depth === d.value ? 'is-on' : ''}`,
    type: 'button',
    on: {
      click: () => {
        state.config.ui.debateDepth = d.value;
        void saveConfig();
        invalidate('flow');
      },
    },
  }, d.label(), h('small', null, ` · ${d.sub()}`))));

  const cast = ready.length
    ? h('div', { class: 'team' }, ...ready.map((a) => h('span', { class: 'team-chip' }, avatar(a.id, 'sm'), a.label, h('small', null, roleName(roles[a.id] ?? 'all')))))
    : h('div', { class: 'debate-empty-cast' },
        h('span', { class: 'muted' }, L('Konuşabilecek hazır ajan yok.', 'No agent is ready to talk.')),
        h('button', { class: 'btn ink', type: 'button', on: { click: openGuide } }, icon('plus'), L('Ajan bağla', 'Connect agents')));

  const row = (label: string, control: Node) => h('div', { class: 'debate-opt' }, h('span', { class: 'debate-opt-label' }, label), control);

  return h('div', { class: 'hero debate-new', 'data-key': 'debate-new' },
    h('div', { class: 'eyebrow', style: { justifyContent: 'flex-start', color: 'var(--accent)' } }, L('Tartış', 'Debate')),
    h('h1', { class: 'display' }, L('Bir fikri ajanlara', 'Put an idea'), h('br'), L('tartıştır.', 'up for debate.')),
    h('p', { class: 'hero-sub' }, L(
      'Ajanlar farklı rollerle fikri değerlendirir ve birbirine itiraz eder; Konsey sonunda puanlı bir karar notu yazar. Beğenirsen tek tıkla projeye dönüştürürsün. Tartışma hiçbir dosyayı değiştirmez.',
      'The agents weigh the idea from different roles and push back on each other; Konsey then writes a scored decision note. If you like it, turn it into a project with one click. A discussion never changes any files.',
    )),
    h('div', { class: 'debate-opts glass' },
      row(L('Konu', 'Scope'), scopeSeg),
      row(L('Derinlik', 'Depth'), depthSeg),
      row(L('Katılanlar', 'Cast'), cast),
    ),
    h('div', { class: 'suggestions' }, ...examples(scope).map((ex) => h('button', {
      class: 'suggestion glass',
      type: 'button',
      on: { click: () => fillPrompt(ex.text) },
    }, h('span', { class: 'suggestion-title' }, ex.title), h('span', { class: 'suggestion-sub' }, ex.text)))),
  );
}

// --------------------------------------------------------------- tartisma akisi

function message(m: DebateMessage): HTMLElement {
  if (m.from === 'user') {
    return h('div', { class: 'bubble-user', 'data-key': m.id }, m.text);
  }
  const live = state.debateLive.get(m.id)?.text;
  const body = m.pending
    ? live
      ? h('div', { class: 'msg-text shimmer' }, live.replace(/^_|_$/g, ''))
      : h('span', { class: 'typing' }, h('i'), h('i'), h('i'))
    : h('div', { class: 'msg-text' }, m.kind === 'say' ? md(m.text) : m.text);
  return h('div', { class: `msg debate-msg ${m.kind === 'error' ? 'error' : ''}`, 'data-key': m.id },
    avatar(m.from, 'sm', Boolean(m.pending)),
    h('div', { style: { minWidth: '0' } },
      h('div', { class: 'msg-head' },
        h('span', { class: 'msg-name' }, labelFor(m.from)),
        m.role ? h('span', { class: `role-chip role-${m.role}` }, roleName(m.role)) : null,
        h('span', { class: 'msg-time' }, clock(m.at)),
      ),
      body,
      !m.pending && m.kind === 'error' ? fixButton(m.text, String(m.from)) : null,
    ),
  );
}

function divider(round: number): HTMLElement {
  return h('div', { class: 'round-divider', 'data-key': `r-${round}` },
    h('span', null, round === 1
      ? L('1. tur · açılış — ajanlar birbirini görmeden konuşur', 'Round 1 · opening — agents speak without seeing each other')
      : L(`${round}. tur · karşılıklı`, `Round ${round} · rebuttal`)));
}

/** Karar notundaki "Acik sorular" bolumu (donusturme penceresinde gosterilir). */
function openQuestions(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,3}\s*(açık sorular|open questions)/i.test(l.trim()));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line.trim())) break;
    const item = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (item && !/^(yok|none)\.?$/i.test(item)) items.push(item);
  }
  return items.slice(0, 6);
}

function verdict(d: Debate): HTMLElement | null {
  const writing = d.busy === 'summary';
  const live = writing ? state.debateLive.get(`summary:${d.id}`) : undefined;
  const spoken = d.messages.some((m) => m.kind === 'say' && m.text.trim());
  const convertLabel = d.projectDir ? L('Göreve dönüştür', 'Turn into a task') : L('Projeye dönüştür', 'Turn into a project');

  if (!d.summary && !writing) {
    if (!spoken || d.busy) return null;
    return h('div', { class: 'result glass debate-verdict is-empty', 'data-key': 'verdict' },
      h('div', { class: 'result-head' },
        h('span', { class: 'result-icon neutral' }, icon('scale')),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { class: 'result-title' }, L('Henüz karar notu yok', 'No decision note yet')),
          h('div', { class: 'result-sub' }, L('Konsey tartışmayı toparlayıp puanlasın ya da olduğu gibi dönüştür.', 'Let Konsey wrap up and score the discussion, or convert it as it is.')),
        ),
      ),
      h('div', { class: 'result-actions' },
        h('button', { class: 'btn ink', type: 'button', on: { click: () => void debateAction('summarize') } }, icon('scale'), L('Özetle', 'Summarize')),
        h('button', { class: 'btn', type: 'button', on: { click: () => void openConvert(d) } }, icon('play'), convertLabel),
      ),
    );
  }

  const summary = d.summary;
  const by = writing ? live?.from : summary?.by;
  return h('div', { class: `result glass debate-verdict ${writing ? 'is-writing' : ''}`, 'data-key': 'verdict' },
    h('div', { class: 'result-head' },
      h('span', { class: 'result-icon' }, icon('scale')),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { class: 'result-title' }, L('Karar notu', 'Decision note')),
        h('div', { class: 'result-sub' }, writing
          ? L(`${by ? labelFor(by) : 'Konsey'} tartışmayı toparlıyor…`, `${by ? labelFor(by) : 'Konsey'} is wrapping up the discussion…`)
          : L(`${labelFor(summary!.by)} yazdı · ${clock(summary!.at)}`, `Written by ${labelFor(summary!.by)} · ${clock(summary!.at)}`)),
      ),
      !writing && summary?.score !== undefined
        ? h('span', { class: `score-pill ${scoreTone(summary.score)}`, title: L('Ajanların ortak puanı', 'The agents’ overall score') }, fmtScore(summary.score))
        : null,
    ),
    writing
      ? live?.text
        ? h('div', { class: 'msg-text shimmer' }, live.text.replace(/^_|_$/g, ''))
        : h('span', { class: 'typing' }, h('i'), h('i'), h('i'))
      : h('div', { class: 'verdict-body' }, md(summary!.text)),
    !writing && !d.busy
      ? h('div', { class: 'result-actions' },
          h('button', { class: 'btn ink', type: 'button', on: { click: () => void openConvert(d) } }, icon('play'), convertLabel),
          h('button', {
            class: 'btn',
            type: 'button',
            on: {
              click: () => {
                void navigator.clipboard.writeText(summary!.text);
                toast(L('Karar notu kopyalandı', 'Decision note copied'), 1400);
              },
            },
          }, icon('copy'), L('Kopyala', 'Copy')),
        )
      : null,
  );
}

function convertedCard(d: Debate): HTMLElement | null {
  if (!d.converted) return null;
  const { projectDir, file } = d.converted;
  return h('div', { class: 'hero-card glass debate-converted', 'data-key': 'converted' },
    h('span', { class: 'hero-card-icon' }, icon('check')),
    h('div', { class: 'hero-card-body' },
      h('div', { class: 'hero-card-title' }, d.projectDir ? L('Göreve dönüştürüldü', 'Turned into a task') : L('Projeye dönüştürüldü', 'Turned into a project')),
      h('div', { class: 'hero-card-sub' }, tildify(file)),
    ),
    h('button', { class: 'btn', type: 'button', on: { click: () => void api.openPath(file) } }, icon('external'), L('Dosyayı aç', 'Open file')),
    h('button', {
      class: 'btn ink',
      type: 'button',
      on: {
        click: async () => {
          await useProject(projectDir);
          closeDebate();
        },
      },
    }, icon('folder'), L('Projeye git', 'Go to project')),
  );
}

function header(d: Debate): HTMLElement {
  // Kullanici basligi duzenlerken akan cizimler yazdigini ezmesin.
  const focused = document.activeElement as HTMLElement | null;
  const editing = focused?.classList.contains('debate-title') ? focused.textContent ?? '' : null;
  const title = h('div', {
    class: 'debate-title',
    contenteditable: 'plaintext-only',
    spellcheck: 'false',
    title: L('Başlığı değiştirmek için tıkla', 'Click to rename'),
    on: {
      keydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          (event.currentTarget as HTMLElement).blur();
        }
      },
      blur: (event: FocusEvent) => {
        const text = (event.currentTarget as HTMLElement).textContent?.trim() ?? '';
        if (text && text !== d.title) void api.renameDebate(d.id, text);
        else (event.currentTarget as HTMLElement).textContent = d.title;
      },
    },
  }, editing ?? d.title);

  const cast = Object.entries(d.roles ?? {});
  const busy = Boolean(d.busy);
  return h('div', { class: 'debate-head glass', 'data-key': `head-${d.id}` },
    h('div', { class: 'debate-head-main' },
      h('div', { class: 'debate-kicker' },
        icon(d.projectDir ? 'folder' : 'bulb'),
        h('span', null, d.projectDir ? basename(d.projectDir) : L('Serbest fikir', 'Free idea')),
        h('span', { class: 'muted' }, `· ${relTime(d.createdAt)}`),
      ),
      title,
      cast.length
        ? h('div', { class: 'debate-cast' }, ...cast.map(([agent, role]) => h('span', { class: 'cast-chip', title: roleName(role) },
            avatar(agent, 'xs', d.messages.some((m) => m.pending && m.from === agent)), labelFor(agent), h('small', null, roleName(role)))))
        : null,
    ),
    h('div', { class: 'debate-head-actions' },
      busy
        ? h('button', { class: 'btn', type: 'button', on: { click: () => void api.cancelDebate(d.id) } }, icon('stop'), L('Durdur', 'Stop'))
        : h('button', {
            class: 'btn',
            type: 'button',
            title: L('Ajanlar birbirine bir tur daha cevap verir, karar notu güncellenir.', 'The agents answer each other once more and the decision note is updated.'),
            on: { click: () => void debateAction('round') },
          }, icon('refresh'), L('Bir tur daha', 'One more round')),
      h('button', {
        class: 'icon-btn',
        type: 'button',
        title: L('Tartışmayı sil', 'Delete discussion'),
        on: {
          click: () => {
            if (confirm(L(`“${d.title}” tartışması silinsin mi?`, `Delete the discussion “${d.title}”?`))) void removeDebate(d.id);
          },
        },
      }, icon('trash')),
    ),
  );
}

function debateNodes(d: Debate): Node[] {
  const nodes: Node[] = [header(d), h('div', { class: 'bubble-user', 'data-key': 'topic' }, d.topic)];
  let round = -1;
  for (const m of d.messages.slice(1)) {
    if (m.from !== 'user' && m.from !== 'orchestrator' && m.round !== round) {
      round = m.round;
      nodes.push(divider(round));
    }
    nodes.push(message(m));
  }
  const card = verdict(d);
  if (card) nodes.push(card);
  const converted = convertedCard(d);
  if (converted) nodes.push(converted);
  return nodes;
}

/** Ana alanin tartisma icerigi (flow.ts cagirir). */
export function debateContent(): Node[] {
  if (state.debateId === 'new') return [newView()];
  return state.debate ? debateNodes(state.debate) : [];
}

// --------------------------------------------------------------- projeye donusturme

interface ConvertForm {
  debate: Debate;
  parent: string;
  name: string;
  details: string;
  mode: RunMode;
}

let form: ConvertForm | null = null;
const dialog = () => $('convert') as HTMLDialogElement;

function join(parent: string, child: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${sep}${child}`;
}

function target(f: ConvertForm): string {
  if (f.debate.projectDir) {
    return join(join(join(f.debate.projectDir, 'docs'), 'konsey'), `${slugify(f.debate.summary?.name || f.debate.title)}.md`);
  }
  return join(join(f.parent, slugify(f.name || f.debate.title)), 'KONSEY.md');
}

function renderConvert(): void {
  if (!form) return;
  const f = form;
  const isNew = !f.debate.projectDir;
  $('convert-title').textContent = isNew ? L('Projeye dönüştür', 'Turn into a project') : L('Göreve dönüştür', 'Turn into a task');
  $('convert-go').textContent = isNew ? L('Oluştur ve başlat', 'Create and start') : L('Görevi başlat', 'Start the task');

  const preview = h('div', { class: 'convert-preview' }, icon(isNew ? 'folder-plus' : 'folder'), h('code', null, tildify(target(f))));
  const nameInput = h('input', {
    value: f.name,
    placeholder: slugify(f.debate.title),
    spellcheck: 'false',
    on: {
      input: (event: Event) => {
        f.name = (event.target as HTMLInputElement).value;
        preview.querySelector('code')!.textContent = tildify(target(f));
      },
    },
  }) as HTMLInputElement;

  const details = h('textarea', {
    class: 'convert-details',
    rows: '5',
    placeholder: L(
      'Olmazsa olmazlar, teknoloji tercihi, hedef platform, tasarım, açık sorulara cevapların… (isteğe bağlı)',
      'Must-haves, tech preferences, target platform, design, answers to the open questions… (optional)',
    ),
    on: {
      input: (event: Event) => {
        f.details = (event.target as HTMLTextAreaElement).value;
        autosize(event.target as HTMLTextAreaElement, 260);
      },
    },
  }) as HTMLTextAreaElement;
  details.value = f.details;

  const questions = openQuestions(f.debate.summary?.text ?? '');
  const body = $('convert-body');
  const children: (HTMLElement | null)[] = [
    h('p', { class: 'set-intro' }, isNew
      ? L(
          'Seçtiğin yerde yeni bir klasör açılır; tartışma ve karar notu içine KONSEY.md olarak yazılır. Sonra Konsey bu fikrin ilk sürümünü kurmaya başlar.',
          'A new folder is created where you choose; the discussion and decision note are written into it as KONSEY.md. Konsey then starts building the first version.',
        )
      : L(
          'Tartışma projenin docs/konsey klasörüne dosya olarak yazılır; Konsey karar notundaki plan üzerinde çalışmaya başlar.',
          'The discussion is saved as a file under docs/konsey in the project; Konsey starts working on the plan from the decision note.',
        )),
    isNew
      ? h('div', { class: 'field-row' },
          h('label', { class: 'field' }, L('Proje adı', 'Project name'), nameInput),
          h('div', { class: 'field' }, L('Konum', 'Location'),
            h('div', { class: 'path-pick' },
              h('span', { class: 'path-text', title: f.parent }, tildify(f.parent)),
              h('button', {
                class: 'btn',
                type: 'button',
                on: {
                  click: async () => {
                    const picked = await api.pickFolder(f.parent);
                    if (picked) {
                      f.parent = picked;
                      renderConvert();
                    }
                  },
                },
              }, L('Değiştir…', 'Change…')),
            ),
          ),
        )
      : null,
    preview,
    questions.length
      ? h('div', { class: 'convert-questions' },
          h('div', { class: 'convert-questions-title' }, icon('alert'), L('Ajanların açık soruları — cevaplarını aşağıya yazabilirsin:', 'Open questions from the agents — you can answer them below:')),
          h('ul', null, ...questions.map((q) => h('li', null, q))),
        )
      : null,
    h('label', { class: 'field' }, L('Ek detaylar', 'Extra details'), details),
    h('div', { class: 'field' }, L('Çalışma modu', 'Work mode'),
      h('div', { class: 'seg seg-sm convert-modes' }, ...MODES.map((m) => h('button', {
        class: `seg-btn ${f.mode === m.key ? 'is-on' : ''}`,
        type: 'button',
        title: m.sub,
        on: {
          click: () => {
            f.mode = m.key;
            renderConvert();
          },
        },
      }, m.label))),
    ),
    state.running
      ? h('div', { class: 'convert-note' }, icon('alert'), L(
          'Şu an bir görev çalışıyor. Proje hazırlanır, iş istemi yazma kutusuna konur; görev bitince gönderirsin.',
          'A task is running right now. The project is prepared and the request is placed in the composer; send it when the task finishes.',
        ))
      : null,
  ];
  body.replaceChildren(...children.filter((node): node is HTMLElement => node !== null));
  requestAnimationFrame(() => autosize(details, 260));
}

export async function openConvert(debate: Debate): Promise<void> {
  if (debate.busy) {
    toast(L('Ajanlar hâlâ konuşuyor; bitmesini bekle ya da durdur.', 'The agents are still talking; wait for them or stop them.'));
    return;
  }
  const parent = debate.projectDir ? '' : await api.defaultProjectsDir();
  form = {
    debate,
    parent,
    name: debate.summary?.name ?? slugify(debate.title),
    details: '',
    mode: state.config.ui.mode,
  };
  renderConvert();
  ($('convert-go') as HTMLButtonElement).disabled = false;
  if (!dialog().open) dialog().showModal();
  requestAnimationFrame(() => (document.querySelector('.convert-details') as HTMLTextAreaElement | null)?.focus());
}

async function submitConvert(): Promise<void> {
  if (!form) return;
  const f = form;
  const isNew = !f.debate.projectDir;
  const go = $('convert-go') as HTMLButtonElement;
  go.disabled = true;
  const res = await api.convertDebate({
    id: f.debate.id,
    parentDir: isNew ? f.parent : undefined,
    name: isNew ? f.name : undefined,
    details: f.details,
  });
  if (!res.ok || !res.projectDir || !res.prompt) {
    go.disabled = false;
    toast(res.error ?? L('Dönüştürülemedi.', 'Could not convert.'), 6000);
    return;
  }
  if (isNew) {
    state.config.ui.projectsDir = f.parent;
    void saveConfig();
  }
  dialog().close();
  form = null;

  await useProject(res.projectDir);
  closeDebate();
  if (state.running) {
    draftTask(res.prompt);
    toast(L('Proje hazır. Çalışan görev bitince “Gönder”e bas.', 'The project is ready. Press “Send” when the running task finishes.'), 6000);
    return;
  }
  const ok = await startRun(res.prompt, f.mode);
  if (ok) {
    toast(isNew
      ? L(`${basename(res.projectDir)} oluşturuldu · Konsey işe başladı`, `${basename(res.projectDir)} created · Konsey is on it`)
      : L('Görev başladı', 'Task started'), 4000);
  } else {
    draftTask(res.prompt);
  }
}

export function setupDebate(): void {
  $('convert-close').addEventListener('click', () => dialog().close());
  $('convert-cancel').addEventListener('click', () => dialog().close());
  $('convert-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void submitConvert();
  });
  dialog().addEventListener('close', () => {
    form = null;
  });
}
