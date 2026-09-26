/**
 * Orta alan: Claude'daki is akisi gibi adim adim ilerleyen bir zaman cizelgesi.
 * Plan → (paylasim → hakem) → calisma → birlestirme/kalite → inceleme → sonuc.
 */
import type { RunPhase, RunRecord, Task } from '../../src/shared/types';
import { api, type ActivityLine } from './api';
import { applyRun, draftTask, openChat, pickProject, prepareProject } from './actions';
import { basename, duration, h, icon, md, morph, tildify, tokens } from './dom';
import { L } from '../../src/shared/i18n';
import { openGuide } from './guide';
import {
  agents,
  avatar,
  currentRun,
  invalidate,
  labelFor,
  PHASE_LABEL,
  readiness,
  register,
  state,
  STRATEGY_LABEL,
} from './state';

const $ = (id: string) => document.getElementById(id)!;

type StepKey = 'planning' | 'claiming' | 'arbitrating' | 'executing' | 'merging' | 'reviewing';
const STEPS: { key: StepKey; title: string; icon: string; councilOnly?: boolean }[] = [
  { key: 'planning', title: L('Planlama', 'Planning'), icon: 'list' },
  { key: 'claiming', title: L('Görev paylaşımı', 'Task claiming'), icon: 'users', councilOnly: true },
  { key: 'arbitrating', title: L('Hakem kararı', 'Arbiter decision'), icon: 'scale', councilOnly: true },
  { key: 'executing', title: L('Çalışma', 'Working'), icon: 'code' },
  { key: 'merging', title: L('Birleştirme ve kalite kapısı', 'Merge and quality gate'), icon: 'merge' },
  { key: 'reviewing', title: L('Bağımsız inceleme', 'Independent review'), icon: 'eye' },
];
const ORDER: RunPhase[] = ['planning', 'claiming', 'arbitrating', 'executing', 'merging', 'reviewing', 'done'];

/** Kayittaki verilerden calismanin nereye kadar ilerledigini cikarir (gecmis kayitlar icin). */
function reachedIndex(record: RunRecord, livePhase?: RunPhase): number {
  if (livePhase && ORDER.includes(livePhase)) return ORDER.indexOf(livePhase);
  if (record.phase === 'done') return ORDER.length - 1;
  if (record.review) return ORDER.indexOf('reviewing');
  if (record.validation || record.merges.length) return ORDER.indexOf('merging');
  if (record.tasks.some((t) => ['running', 'succeeded', 'failed'].includes(t.status))) return ORDER.indexOf('executing');
  if (record.tasks.some((t) => t.assignedTo)) return ORDER.indexOf('arbitrating');
  if (record.tasks.length) return ORDER.indexOf('claiming');
  return 0;
}

function stepState(key: StepKey, record: RunRecord, live: boolean, livePhase?: RunPhase): 'done' | 'active' | 'pending' | 'failed' {
  const reached = reachedIndex(record, live ? livePhase : undefined);
  const index = ORDER.indexOf(key);
  if (record.phase === 'done') return 'done';
  if (index < reached) return 'done';
  if (index === reached) {
    if (live) return 'active';
    return record.phase === 'failed' || record.phase === 'cancelled' ? 'failed' : 'done';
  }
  return 'pending';
}

function taskState(task: Task): HTMLElement {
  if (task.status === 'running') return h('span', { class: 'task-state run' }, h('span', { class: 'spinner' }));
  if (task.status === 'succeeded') return h('span', { class: 'task-state ok' }, icon('check'));
  if (task.status === 'failed') return h('span', { class: 'task-state bad' }, icon('alert'));
  return h('span', { class: 'task-state wait' }, h('span', { class: 'dot idle' }));
}

const ROLE_VERB: Record<string, string> = {
  plan: L('planlıyor', 'planning'),
  claim: L('görevlere bakıyor', 'looking at tasks'),
  execute: L('çalışıyor', 'working'),
  review: L('inceliyor', 'reviewing'),
  repair: L('onarıyor', 'repairing'),
};

const COMPLEXITY: Record<string, string> = {
  low: L('kolay', 'easy'),
  medium: L('orta', 'medium'),
  high: L('zor', 'hard'),
  critical: L('kritik', 'critical'),
};

function taskRow(task: Task): HTMLElement {
  const owner = task.assignedTo ?? task.suggestedAgent;
  return h('div', { class: 'task' },
    taskState(task),
    h('div', { style: { minWidth: '0' } },
      h('div', { class: 'task-title' }, task.title),
      task.error
        ? h('div', { class: 'task-error' }, task.error)
        : task.detail && task.detail !== task.title
          ? h('div', { class: 'task-detail' }, task.detail.split('Ekli görseller')[0])
          : null,
    ),
    h('div', { class: 'task-owner' },
      h('span', { class: `badge ${task.complexity === 'critical' || task.complexity === 'high' ? 'warn' : 'neutral'}` }, COMPLEXITY[task.complexity] ?? task.complexity),
      owner ? avatar(owner, 'xs') : null,
      owner ? labelFor(owner) : L('atanmadı', 'unassigned'),
    ),
  );
}

function lane(record: RunRecord, agent: string, lines: ActivityLine[], live: boolean): HTMLElement {
  const key = `${record.id}:${agent}`;
  const running = live && record.tasks.some((t) => t.assignedTo === agent && t.status === 'running');
  const open = state.openLanes.has(key) || (running && !state.closedLanes.has(key));
  const last = [...lines].reverse().find((l) => l.tone !== 'think') ?? lines.at(-1);
  const mine = record.tasks.filter((t) => t.assignedTo === agent);
  const status = mine.some((t) => t.status === 'running')
    ? L('çalışıyor', 'working')
    : mine.length && mine.every((t) => t.status === 'succeeded')
      ? L('bitti', 'done')
      : mine.some((t) => t.status === 'failed')
        ? L('takıldı', 'stuck')
        : '';

  const body = h('div', { class: 'lane-body', 'data-lane': key });
  if (open) {
    for (const line of lines.slice(-120)) body.append(h('div', { class: `act ${line.tone}` }, line.text));
    if (!lines.length) body.append(h('div', { class: 'act think' }, L('Henüz çıktı yok…', 'No output yet…')));
  }
  const node = h('div', { class: `lane ${open ? 'is-open' : ''}` },
    h('button', {
      class: 'lane-head',
      type: 'button',
      on: {
        click: () => {
          if (open) {
            state.openLanes.delete(key);
            state.closedLanes.add(key);
          } else {
            state.openLanes.add(key);
            state.closedLanes.delete(key);
          }
          invalidate('flow');
        },
      },
    },
      h('span', { class: 'chev' }, icon('chevron-right')),
      avatar(agent, 'sm', running),
      h('span', { class: 'lane-name' }, labelFor(agent)),
      h('span', { class: `lane-now ${running ? 'shimmer' : ''}` }, last?.text ?? (running ? L('Başlıyor…', 'Starting…') : status)),
      h('span', { class: 'lane-count' }, status || L(`${lines.length} adım`, `${lines.length} steps`)),
    ),
    open ? body : null,
  );
  return node;
}

function stepContent(key: StepKey, record: RunRecord, activity: ActivityLine[], live: boolean): HTMLElement | null {
  const box = h('div', { class: 'step-content' });
  switch (key) {
    case 'planning': {
      if (!record.tasks.length) return null;
      for (const task of record.tasks) box.append(taskRow(task));
      return box;
    }
    case 'claiming': {
      if (!record.claims.length) return null;
      for (const claim of record.claims) {
        const offers = claim.offers.map((o) => `${record.tasks.find((t) => t.id === o.taskId)?.title ?? o.taskId} (${o.confidence})`);
        box.append(h('div', { class: 'kv' }, avatar(claim.agent, 'xs'), h('b', null, labelFor(claim.agent)), offers.join(' · ') || L('talep yok', 'no claim')));
      }
      return box;
    }
    case 'arbitrating': {
      const owners = new Map<string, number>();
      for (const t of record.tasks) if (t.assignedTo) owners.set(t.assignedTo, (owners.get(t.assignedTo) ?? 0) + 1);
      if (!owners.size) return null;
      box.append(h('div', { class: 'kv' }, ...[...owners].map(([agent, count]) => h('span', { class: 'task-owner' }, avatar(agent, 'xs'), `${labelFor(agent)} · ${L(`${count} görev`, `${count} task${count === 1 ? "" : "s"}`)}`))));
      return box;
    }
    case 'executing': {
      const workers = [...new Set([
        ...record.workspaces.map((w) => w.agent as string),
        ...record.tasks.filter((t) => t.assignedTo && t.status !== 'pending' && t.status !== 'claimed').map((t) => t.assignedTo as string),
      ])];
      if (!workers.length) return null;
      // Serit yalnizca calisma asamasinin ciktisini gosterir (plan/talep JSON'lari degil).
      for (const agent of workers) box.append(lane(record, agent, activity.filter((a) => a.agent === agent && (!a.phase || a.phase === 'executing')), live));
      return box;
    }
    case 'merging': {
      if (!record.merges.length && !record.validation) return null;
      const merged = record.merges.filter((m) => m.status === 'merged').length;
      const conflicts = record.merges.filter((m) => m.status === 'conflict');
      if (record.merges.length) {
        box.append(h('div', { class: 'kv' },
          h('span', null, L(`${merged} dal birleştirildi`, `${merged} branches merged`)),
          conflicts.length ? h('span', { class: 'badge bad' }, L(`${conflicts.length} çatışma`, `${conflicts.length} conflicts`)) : null,
        ));
        for (const c of conflicts) box.append(h('div', { class: 'task-error' }, `${labelFor(c.agent)}: ${c.conflictFiles.join(', ')}`));
      }
      if (record.validation) {
        if (!record.validation.commands.length) {
          box.append(h('div', { class: 'kv' }, icon('shield'), record.validation.summary));
        }
        for (const cmd of record.validation.commands) {
          box.append(h('details', { class: 'out' },
            h('summary', null,
              h('span', { class: `task-state ${cmd.ok ? 'ok' : 'bad'}` }, icon(cmd.ok ? 'check' : 'alert')),
              h('span', { class: 'check-row' }, cmd.command),
              h('span', { class: 'muted' }, duration(cmd.durationMs)),
            ),
            h('pre', { class: 'out-text' }, cmd.output.slice(-6000) || L('(çıktı yok)', '(no output)')),
          ));
        }
      }
      return box;
    }
    case 'reviewing': {
      if (!record.review) return null;
      const r = record.review;
      box.append(h('div', { class: 'kv' },
        avatar(r.reviewer, 'xs'),
        h('b', null, labelFor(r.reviewer)),
        h('span', { class: `badge ${r.verdict === 'approved' ? '' : r.verdict === 'changes-requested' ? 'warn' : 'neutral'}` },
          r.verdict === 'approved' ? L('Onayladı', 'Approved') : r.verdict === 'changes-requested' ? L('Düzeltme istedi', 'Requested changes') : L('Belirsiz', 'Unclear')),
      ));
      box.append(md(r.summary));
      if (r.findings.length) box.append(h('ul', { class: 'findings' }, ...r.findings.map((f) => h('li', null, f))));
      return box;
    }
  }
}

function stepSub(key: StepKey, record: RunRecord): string {
  switch (key) {
    case 'planning': {
      const route = `${STRATEGY_LABEL[record.strategy] ?? record.strategy}${record.routeReason ? ` — ${record.routeReason}` : ''}`;
      return record.tasks.length ? `${L(`${record.tasks.length} görev`, `${record.tasks.length} task${record.tasks.length === 1 ? "" : "s"}`)} · ${record.summary ?? route}` : route;
    }
    case 'executing': {
      const done = record.tasks.filter((t) => t.status === 'succeeded').length;
      return record.tasks.length ? L(`${done}/${record.tasks.length} görev tamam · her ajan kendi izole kopyasında`, `${done}/${record.tasks.length} tasks done · each agent works in its own isolated copy`) : '';
    }
    case 'merging':
      return record.validation ? record.validation.summary : L('Dallar tek entegrasyon dalında birleşir, testler çalışır.', 'Branches merge into a single integration branch, tests run.');
    case 'reviewing':
      return record.review ? '' : L('İşe katılmayan bir ajan sonucu denetler.', 'An agent that did not take part in the work checks the result.');
    default:
      return '';
  }
}

function workflow(record: RunRecord, activity: ActivityLine[], live: boolean): HTMLElement {
  const elapsed = (record.endedAt ?? Date.now()) - record.startedAt;
  const phase = live ? state.live?.phase ?? record.phase : record.phase;
  const steps = h('ol', { class: 'steps' });
  for (const step of STEPS) {
    if (step.councilOnly && record.strategy !== 'council') continue;
    const status = stepState(step.key, record, live, phase);
    let content = status === 'pending' ? null : stepContent(step.key, record, activity, live);
    // Etkin adimda o an model turu yuruten ajanlar: "GLM inceliyor… 42 sn".
    if (status === 'active' && record.active?.length && step.key !== 'executing') {
      const busy = h('div', { class: 'kv', 'data-key': 'busy' }, ...record.active.map((entry) =>
        h('span', { class: 'task-owner' }, avatar(entry.agent, 'xs', true), h('span', { class: 'shimmer' }, `${labelFor(entry.agent)} ${ROLE_VERB[entry.role] ?? L('çalışıyor', 'working')}…`)),
      ));
      content = content ? (content.prepend(busy), content) : h('div', { class: 'step-content' }, busy);
    }
    const sub = status === 'pending' ? '' : stepSub(step.key, record);
    steps.append(h('li', { class: `step is-${status}` },
      h('span', { class: 'step-icon' }, status === 'done' ? icon('check') : status === 'failed' ? icon('x') : icon(step.icon)),
      h('div', { class: 'step-body' },
        h('div', { class: 'step-title' }, step.title, status === 'active' ? h('span', { class: 'badge' }, PHASE_LABEL[phase] ?? phase) : null),
        sub ? h('div', { class: 'step-sub' }, sub) : null,
        content,
      ),
    ));
  }
  return h('section', { class: 'workflow glass', 'data-key': `wf-${record.id}` },
    h('div', { class: 'wf-head' },
      h('span', { class: 'wf-title' }, L('İş akışı', 'Workflow')),
      h('span', { class: 'badge neutral' }, STRATEGY_LABEL[record.strategy] ?? record.strategy),
      h('span', { class: 'wf-meta', id: 'wf-elapsed' }, `${live ? PHASE_LABEL[phase] ?? '' : PHASE_LABEL[record.phase]} · ${duration(elapsed)}`),
    ),
    steps,
  );
}

function usageTable(record: RunRecord): HTMLElement | null {
  if (!record.usage.length) return null;
  const byAgent = new Map<string, { calls: number; tokens: number; ms: number; cost: number }>();
  for (const call of record.usage) {
    const entry = byAgent.get(call.agent) ?? { calls: 0, tokens: 0, ms: 0, cost: 0 };
    entry.calls += 1;
    entry.tokens += call.totalTokens ?? 0;
    entry.ms += call.durationMs;
    entry.cost += call.costUsd ?? 0;
    byAgent.set(call.agent, entry);
  }
  const grid = h('div', { class: 'usage-table' },
    h('span', { class: 'head' }), h('span', { class: 'head' }, L('Ajan', 'Agent')), h('span', { class: 'head num' }, L('Çağrı', 'Calls')), h('span', { class: 'head num' }, 'Token'), h('span', { class: 'head num' }, L('Süre', 'Duration')),
  );
  for (const [agent, u] of byAgent) {
    grid.append(avatar(agent, 'xs'), h('span', null, labelFor(agent)), h('span', { class: 'num' }, String(u.calls)), h('span', { class: 'num' }, tokens(u.tokens)), h('span', { class: 'num' }, duration(u.ms)));
  }
  return h('details', { class: 'out' }, h('summary', null, icon('gauge'), L(`Kim ne kadar kullandı · ${record.usage.length} model çağrısı`, `Usage by agent · ${record.usage.length} model calls`)), h('div', { style: { marginTop: '8px' } }, grid));
}

function resultCard(record: RunRecord): HTMLElement | null {
  if (!record.endedAt) return null;
  const done = record.phase === 'done';
  const cancelled = record.phase === 'cancelled';
  const actions = h('div', { class: 'result-actions' });
  if (done && record.applied?.ok) {
    actions.append(h('button', { class: 'btn ink', type: 'button', on: { click: () => void api.openPath(record.projectDir) } }, icon('folder'), L('Klasörü aç', 'Open folder')));
  }
  if (record.integrationBranch && !record.applied?.ok) {
    actions.append(h('button', {
      class: `btn ${done ? 'ink' : ''}`,
      type: 'button',
      title: done ? L('Değişiklikleri proje klasörüne uygula', 'Apply the changes to the project folder') : L('Kalite kapısı kalsa da değişiklikleri uygula', 'Apply the changes even though the quality gate failed'),
      on: { click: () => void applyRun(record.id) },
    }, icon('merge'), done ? L('Klasöre uygula', 'Apply to folder') : L('Yine de uygula', 'Apply anyway')));
  }
  if (!done) {
    actions.append(h('button', { class: 'btn', type: 'button', on: { click: () => draftTask(record.prompt) } }, icon('refresh'), L('Yeniden dene', 'Retry')));
    if (/pay|kullanım/i.test(record.error ?? '')) {
      actions.append(h('button', { class: 'btn', type: 'button', on: { click: () => document.getElementById('open-settings')?.click() } }, icon('gauge'), L('Limit ayarları', 'Limit settings')));
    }
  }
  actions.append(h('button', { class: 'btn ghost', type: 'button', on: { click: () => openChat('council') } }, icon('message'), L('Masada konuş', 'Talk at the table')));

  const sub = done
    ? record.applied?.message ?? (record.integrationBranch ? L(`Değişiklikler ${record.integrationBranch} dalında hazır.`, `Changes are ready on the ${record.integrationBranch} branch.`) : L('Değişiklik gerekmedi.', 'No changes were needed.'))
    : cancelled ? L('Görevi durdurdun.', 'You stopped the task.') : record.error ?? L('Bilinmeyen hata.', 'Unknown error.');
  return h('section', { class: 'result glass', 'data-key': `res-${record.id}` },
    h('div', { class: 'result-head' },
      h('span', { class: `result-icon ${done ? '' : cancelled ? 'neutral' : 'bad'}` }, icon(done ? 'check' : cancelled ? 'stop' : 'alert')),
      h('div', null,
        h('div', { class: 'result-title' }, done ? L('Tamamlandı', 'Done') : cancelled ? L('Durduruldu', 'Stopped') : L('Tamamlanamadı', 'Failed')),
        h('div', { class: 'result-sub' }, sub),
      ),
    ),
    record.diffStat ? h('div', { class: 'files' }, record.diffStat) : null,
    usageTable(record),
    actions,
  );
}

const SUGGESTIONS = [
  {
    title: L('Küçük bir web uygulaması', 'A small web app'),
    sub: L('Yapılacaklar listesi: HTML, CSS, JS, localStorage.', 'A to-do list: HTML, CSS, JS, localStorage.'),
    prompt: L(
      'Bu klasörde tek sayfalık, şık bir yapılacaklar (to-do) uygulaması yap: index.html, style.css, app.js. Görev ekleme, tamamlama, silme ve localStorage ile kalıcılık olsun.',
      'Build a single-page, polished to-do app in this folder: index.html, style.css, app.js. Support adding, completing, and deleting tasks, with persistence via localStorage.',
    ),
  },
  {
    title: L('README yaz', 'Write a README'),
    sub: L('Projeyi okuyup kurulum ve kullanım anlatsın.', 'Read the project and explain setup and usage.'),
    prompt: L(
      'Projeyi incele ve kurulum, kullanım ve klasör yapısını anlatan net bir README.md yaz.',
      'Examine the project and write a clear README.md covering setup, usage, and folder structure.',
    ),
  },
  {
    title: L('Hataları bul ve düzelt', 'Find and fix bugs'),
    sub: L('Testleri çalıştırıp kırmızıları yeşile çevirsin.', 'Run the tests and turn the failing ones green.'),
    prompt: L(
      'Projenin testlerini ve derlemesini çalıştır, bulduğun hataları düzelt ve neyi neden değiştirdiğini özetle.',
      'Run the project\'s tests and build, fix any errors you find, and summarize what you changed and why.',
    ),
  },
  {
    title: L('Masada fikir al', 'Get ideas at the table'),
    sub: L('Kod yazmadan önce ajanlar tartışsın.', 'Let the agents discuss before writing any code.'),
    chat: L(
      'Bu projeye bakıp en değerli üç iyileştirmeyi önerir misiniz? Birbirinize katılıp katılmadığınızı da söyleyin.',
      'Could you look at this project and suggest the three most valuable improvements? Also say whether you agree or disagree with each other.',
    ),
  },
];

function hero(): HTMLElement {
  const project = state.project;
  const team = h('div', { class: 'team' });
  for (const agent of agents()) {
    const ready = readiness(agent);
    team.append(h('button', {
      class: `team-chip ${ready.ok ? '' : 'is-off'}`,
      type: 'button',
      title: L(`${agent.label} ile konuş`, `Talk to ${agent.label}`),
      on: { click: () => openChat(agent.id) },
    }, avatar(agent.id, 'sm'), agent.label, h('small', null, ready.text)));
  }

  const projectCard = project
    ? h('div', { class: 'hero-card glass' },
        h('span', { class: 'hero-card-icon' }, icon('folder')),
        h('div', { class: 'hero-card-body' },
          h('div', { class: 'hero-card-title' }, basename(project.dir)),
          h('div', { class: 'hero-card-sub' }, project.hasCommit
            ? tildify(project.dir)
            : L('Düz klasör — ilk görevde git deposu olarak otomatik hazırlanır.', 'Plain folder — set up automatically as a git repo on the first task.')),
        ),
        !project.hasCommit
          ? h('button', { class: 'btn', type: 'button', on: { click: () => void prepareProject() } }, icon('sparkles'), L('Şimdi hazırla', 'Set up now'))
          : h('button', { class: 'btn ghost', type: 'button', on: { click: () => void api.openPath(project.dir) } }, icon('external'), 'Finder'),
      )
    : h('button', { class: 'hero-card glass', type: 'button', style: { border: '0', textAlign: 'left' }, on: { click: () => void pickProject() } },
        h('span', { class: 'hero-card-icon' }, icon('folder-plus')),
        h('div', { class: 'hero-card-body' },
          h('div', { class: 'hero-card-title' }, L('Bir proje klasörü seç', 'Choose a project folder')),
          h('div', { class: 'hero-card-sub' }, L('Boş ya da düz bir klasör de olur; Konsey gerisini hazırlar.', 'An empty or plain folder is fine; Konsey sets up the rest.')),
        ),
        h('span', { class: 'btn ink' }, L('Klasör seç', 'Choose folder')),
      );

  // Kurulum eksikleri: git yoksa is baslayamaz, hic ajan yoksa kimse calismaz.
  const notices: HTMLElement[] = [];
  if (state.system && !state.system.git) {
    notices.push(h('div', { class: 'hero-card glass notice-bad' },
      h('span', { class: 'hero-card-icon' }, icon('alert')),
      h('div', { class: 'hero-card-body' },
        h('div', { class: 'hero-card-title' }, L('Git kurulu değil', 'Git is not installed')),
        h('div', { class: 'hero-card-sub' }, state.system.platform === 'darwin'
          ? L('Konsey ajanların işini ayrı kopyalarda tutmak için git kullanır. Terminalde “xcode-select --install” çalıştır ya da git’i indir.', 'Konsey uses git to keep each agent’s work in its own copy. Run “xcode-select --install” in Terminal or download git.')
          : L('Konsey ajanların işini ayrı kopyalarda tutmak için git kullanır. Git for Windows’u kurup Konsey’i yeniden aç.', 'Konsey uses git to keep each agent’s work in its own copy. Install Git for Windows, then reopen Konsey.')),
      ),
      h('button', { class: 'btn ink', type: 'button', on: { click: () => void api.openExternal('https://git-scm.com/downloads') } }, icon('external'), L('Git’i indir', 'Get git')),
    ));
  }
  if (state.availability.length && !agents().some((a) => a.enabled && a.available)) {
    notices.push(h('div', { class: 'hero-card glass notice-warn' },
      h('span', { class: 'hero-card-icon' }, icon('users')),
      h('div', { class: 'hero-card-body' },
        h('div', { class: 'hero-card-title' }, L('Henüz bağlı ajan yok', 'No agents connected yet')),
        h('div', { class: 'hero-card-sub' }, L('Claude Code, Codex, Gemini CLI gibi bir kodlama CLI’ı kur ya da ayarlardan bir API sağlayıcısı ekle.', 'Install a coding CLI such as Claude Code, Codex or Gemini CLI, or add an API provider in settings.')),
      ),
      h('button', { class: 'btn ink', type: 'button', on: { click: openGuide } }, icon('plus'), L('Ajan bağla', 'Connect agents')),
    ));
  }

  const suggestions = h('div', { class: 'suggestions' });
  for (const s of SUGGESTIONS) {
    suggestions.append(h('button', {
      class: 'suggestion glass',
      type: 'button',
      on: {
        click: () => {
          if (s.chat) {
            openChat('council');
            const input = document.getElementById('chat-input') as HTMLTextAreaElement;
            input.value = s.chat;
            input.dispatchEvent(new Event('input'));
            input.focus();
          } else draftTask(s.prompt!);
        },
      },
    }, h('span', { class: 'suggestion-title' }, s.title), h('span', { class: 'suggestion-sub' }, s.sub)));
  }

  const hour = new Date().getHours();
  const greet = hour < 6
    ? L('İyi geceler', 'Good night')
    : hour < 12
      ? L('Günaydın', 'Good morning')
      : hour < 18
        ? L('İyi günler', 'Good afternoon')
        : L('İyi akşamlar', 'Good evening');
  return h('div', { class: 'hero', 'data-key': 'hero' },
    h('div', { class: 'eyebrow', style: { justifyContent: 'flex-start', color: 'var(--accent)' } }, 'Konsey'),
    h('h1', { class: 'display' }, `${greet}.`, h('br'), L('Bugün ne inşa edelim?', 'What should we build today?')),
    ...notices,
    projectCard,
    team,
    suggestions,
  );
}

let lastKey = '';

export function renderFlow(): void {
  const scroller = $('flow-scroll');
  const flow = $('flow');
  const run = currentRun();
  const key = run ? run.record.id : 'hero';
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const previousTop = scroller.scrollTop;

  // Acik seritler en alttaysa yeni satir gelince alta yapisik kalir.
  const stuck = new Set<string>();
  flow.querySelectorAll<HTMLElement>('.lane-body').forEach((body) => {
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 30) stuck.add(body.dataset.lane ?? '');
  });

  const nodes: Node[] = [];
  if (!run) {
    nodes.push(hero());
  } else {
    const prompt = run.record.prompt.split('\n\nEkli görseller')[0];
    const images = (run.record.prompt.match(/^- .+$/gm) ?? []).length;
    nodes.push(h('div', { class: 'bubble-user', 'data-key': `u-${run.record.id}` }, prompt, images ? h('div', { class: 'small', style: { opacity: '0.7', marginTop: '4px' } }, L(`＋ ${images} görsel`, `+ ${images} image${images === 1 ? '' : 's'}`)) : null));
    nodes.push(workflow(run.record, run.activity, run.live));
    const result = resultCard(run.record);
    if (result) nodes.push(result);
  }
  morph(flow, nodes);
  flow.querySelectorAll<HTMLElement>('.lane-body').forEach((body) => {
    if (stuck.has(body.dataset.lane ?? '') || !body.dataset.seen) body.scrollTop = body.scrollHeight;
    body.dataset.seen = '1';
  });

  if (key !== lastKey) {
    scroller.scrollTop = run && run.live ? scroller.scrollHeight : 0;
  } else if (nearBottom && run) {
    scroller.scrollTop = scroller.scrollHeight;
  } else {
    scroller.scrollTop = previousTop;
  }
  lastKey = key;
}

/** Sayac: calisma suresi her saniye guncellenir, butun akis yeniden cizilmez. */
function tick(): void {
  const run = currentRun();
  const node = document.getElementById('wf-elapsed');
  if (!run || !node || !run.live) return;
  const phase = state.live?.phase ?? run.record.phase;
  node.textContent = `${PHASE_LABEL[phase] ?? ''} · ${duration(Date.now() - run.record.startedAt)}`;
}

export function setupFlow(): void {
  register('flow', renderFlow);
  window.setInterval(tick, 1000);
  invalidate('flow');
}
