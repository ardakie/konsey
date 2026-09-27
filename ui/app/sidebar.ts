/** Kenar cubugu: proje secici, gorev gecmisi ve ac/kapa anahtarli ajan listesi. */
import { api } from './api';
import { newDebate, newTask, openChat, openRun, pickProject, refreshAgents, refreshQuotas, toggleAgent, useProject } from './actions';
import { basename, h, icon, morph, relTime, tildify } from './dom';
import { agents, avatar, invalidate, readiness, register, state } from './state';
import { L } from '../../src/shared/i18n';
import { debateItems } from './debate';

const $ = (id: string) => document.getElementById(id)!;

function renderProject(): void {
  $('project-name').textContent = state.project ? basename(state.project.dir) : L('Proje seç', 'Pick a project');
  $('project-path').textContent = state.project ? tildify(state.project.dir) : L('Klasör seçilmedi', 'No folder selected');
}

function closeMenu(): void {
  $('project-menu').hidden = true;
}

function openProjectMenu(): void {
  const menu = $('project-menu');
  if (!menu.hidden) return closeMenu();
  menu.replaceChildren();
  const recent = state.config.recentProjects.slice(0, 8);
  for (const dir of recent) {
    const on = state.project?.dir === dir;
    menu.append(h('button', {
      class: `menu-item ${on ? 'is-on' : ''}`,
      type: 'button',
      on: { click: () => { closeMenu(); void useProject(dir); } },
    },
      icon('folder'),
      h('span', { class: 'menu-item-body' },
        h('span', { class: 'menu-item-title' }, basename(dir)),
        h('span', { class: 'menu-item-sub' }, tildify(dir)),
      ),
      on ? h('span', { class: 'check' }, icon('check')) : null,
    ));
  }
  if (recent.length) menu.append(h('div', { class: 'menu-sep' }));
  menu.append(h('button', {
    class: 'menu-item',
    type: 'button',
    on: { click: () => { closeMenu(); void pickProject(); } },
  }, icon('folder-plus'), h('span', { class: 'menu-item-body' }, h('span', { class: 'menu-item-title' }, L('Klasör seç…', 'Choose a folder…')), h('span', { class: 'menu-item-sub' }, L('Düz bir klasör de olur; Konsey hazırlar.', 'A plain folder works too; Konsey will set it up.')))));
  if (state.project) {
    menu.append(h('button', {
      class: 'menu-item',
      type: 'button',
      on: { click: () => { closeMenu(); void api.openPath(state.project!.dir); } },
    }, icon('external'), h('span', { class: 'menu-item-body' }, h('span', { class: 'menu-item-title' }, L('Finder’da aç', 'Open in Finder')))));
  }
  menu.hidden = false;
}

function renderRuns(): void {
  const list = $('run-list');
  const nodes: Node[] = [];
  const items = [...state.runs];
  if (state.live && !items.some((r) => r.id === state.live!.record.id)) {
    const r = state.live.record;
    items.unshift({ id: r.id, projectDir: r.projectDir, prompt: r.prompt, phase: r.phase, strategy: r.strategy, startedAt: r.startedAt });
  }
  if (!state.project) {
    morph(list, [h('li', { class: 'sb-empty' }, L('Önce bir proje klasörü seç.', 'Pick a project folder first.'))]);
    return;
  }
  if (!items.length) {
    morph(list, [h('li', { class: 'sb-empty' }, L('Henüz görev yok. İlk işi aşağıdan ver.', 'No tasks yet. Give the first one below.'))]);
    return;
  }
  for (const run of items.slice(0, 60)) {
    const live = state.running && state.live?.record.id === run.id;
    const tone = live ? 'live' : run.phase === 'done' ? 'ok' : run.phase === 'failed' ? 'bad' : 'idle';
    const title = run.prompt.split('\n')[0].trim() || L('Görsel görevi', 'Image task');
    nodes.push(h('li', { 'data-key': run.id }, h('button', {
      class: `run-item ${state.debateId === null && state.selectedRunId === run.id ? 'is-on' : ''}`,
      type: 'button',
      title,
      on: { click: () => void openRun(run.id) },
    },
      h('span', { class: `dot ${tone}` }),
      h('span', { class: 'run-item-text' }, title),
      h('span', { class: 'run-item-time' }, live ? L('şimdi', 'now') : relTime(run.startedAt)),
    )));
  }
  morph(list, nodes);
}

function meter(used: number | null | undefined, cap: number): HTMLElement {
  const value = Math.max(0, Math.min(100, used ?? 0));
  const tone = used !== null && used !== undefined && used >= cap ? 'bad' : used !== null && used !== undefined && used >= cap * 0.8 ? 'warn' : '';
  const node = h('div', { class: 'meter' },
    h('div', { class: `meter-fill ${tone}`, style: { width: `${value}%` } }),
  );
  if (cap < 100) node.append(h('div', { class: 'meter-cap', style: { left: `calc(${cap}% - 1px)` }, title: L(`İzin verilen pay: %${cap}`, `Allowed share: ${cap}%`) }));
  return node;
}

function renderAgents(): void {
  const list = $('agent-list');
  const nodes: Node[] = [];
  for (const agent of agents()) {
    const ready = readiness(agent);
    const working = state.running && state.live?.record.tasks.some((t) => t.assignedTo === agent.id && t.status === 'running');
    const toggle = h('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-checked': String(agent.enabled),
      title: agent.enabled
        ? L(`${agent.label}: açık — kapatmak için tıkla`, `${agent.label}: on — click to turn off`)
        : L(`${agent.label}: kapalı — açmak için tıkla`, `${agent.label}: off — click to turn on`),
      on: {
        click: (event: MouseEvent) => {
          event.stopPropagation();
          toggleAgent(agent.id);
        },
      },
    });
    const unread = state.unread.has(agent.id);
    nodes.push(h('li', {
      'data-key': agent.id,
      class: `agent-row ${agent.enabled ? '' : 'is-off'}`,
      title: L(`${agent.label} ile birebir konuş`, `Chat one-on-one with ${agent.label}`),
      on: { click: () => openChat(agent.id) },
    },
      avatar(agent.id, 'sm', Boolean(working)),
      h('div', { class: 'agent-row-body' },
        h('div', { class: 'agent-row-name' }, agent.label, unread ? h('span', { class: 'dot ok' }) : null),
        h('div', { class: `agent-row-sub ${ready.tone}` }, working ? L('Çalışıyor…', 'Working…') : ready.text),
        agent.enabled && agent.quota?.usedPercent !== null && agent.quota?.usedPercent !== undefined
          ? meter(agent.quota.usedPercent, agent.quota.capPercent)
          : null,
      ),
      toggle,
    ));
  }
  morph(list, nodes);
}

export function renderSidebar(): void {
  renderProject();
  morph($('debate-list'), debateItems());
  $('new-debate').classList.toggle('is-on', state.debateId === 'new');
  renderRuns();
  renderAgents();
}

export function setupSidebar(): void {
  register('sidebar', renderSidebar);
  $('new-task').addEventListener('click', newTask);
  $('new-debate').addEventListener('click', () => newDebate());
  $('project-switcher').addEventListener('click', (event) => {
    event.stopPropagation();
    openProjectMenu();
  });
  document.addEventListener('click', (event) => {
    if (!$('project-menu').contains(event.target as Node)) closeMenu();
  });
  $('refresh-agents').addEventListener('click', async () => {
    await Promise.all([refreshAgents(), refreshQuotas(true)]);
  });
  invalidate('sidebar');
}
