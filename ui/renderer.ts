/**
 * Konsey arayuzu — giris noktasi.
 *
 * Durum ana surecte tutulur; burada gelen olaylar arayuz durumuna islenir ve
 * ilgili bolumler yeniden cizilir. Node API'lerine erisim yok, her sey
 * window.konsey koprusunden gecer.
 */
import { PixelOffice, type AgentActivity } from './pixel/office';
import { setupPreview } from './preview';
import { api, isDesktop } from './app/api';
import {
  loadChats,
  newDebate,
  newTask,
  refreshDebates,
  refreshAgents,
  refreshQuotas,
  refreshRuns,
  upsertMessage,
  useProject,
} from './app/actions';
import { setupChat, liveText } from './app/chat';
import { setupComposer } from './app/composer';
import { hydrateIcons, toast } from './app/dom';
import { charIndexFor } from './app/heads';
import { setupFlow } from './app/flow';
import { setupDebate } from './app/debate';
import { openSettings, setupSettings } from './app/settings';
import { openGuide, setupGuide } from './app/guide';
import { applyStaticLocale } from './app/locale';
import { loadSetup, setupChecks } from './app/setup';
import { renderSidebar, setupSidebar } from './app/sidebar';
import { agents, invalidate, metaFor, register, state } from './app/state';
import type { RunPhase } from '../src/shared/types';
import { L, locale } from '../src/shared/i18n';

const $ = (id: string) => document.getElementById(id)!;

if (!isDesktop) document.body.classList.add('web-preview');
applyStaticLocale();
hydrateIcons();
setupPreview();
setupSidebar();
setupFlow();
setupChat();
setupComposer();
setupSettings();
setupGuide();
setupDebate();

// --------------------------------------------------------------- ust cubuk ve gorunum

const office = new PixelOffice($('office') as HTMLCanvasElement, 'assets/');
let officeReady = false;

function renderTopbar(): void {
  if (state.debateId !== null) {
    const d = state.debate;
    $('thread-title').textContent = d ? d.title : L('Yeni tartışma', 'New discussion');
    $('thread-meta').textContent = d
      ? d.projectDir ? L(`Tartışma · ${d.projectDir.split(/[\\/]/).pop()}`, `Discussion · ${d.projectDir.split(/[\\/]/).pop()}`) : L('Tartışma · serbest fikir', 'Discussion · free idea')
      : '';
  }
  const run = state.debateId !== null ? undefined : state.selectedRunId
    ? state.live?.record.id === state.selectedRunId ? state.live.record : state.viewed?.record
    : null;
  if (state.debateId === null) $('thread-title').textContent = run ? run.prompt.split('\n')[0].slice(0, 90) || L('Görev', 'Task') : L('Yeni görev', 'New task');
  if (state.debateId === null) $('thread-meta').textContent = run ? new Date(run.startedAt).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const open = state.config.ui.officeOpen !== false;
  $('office-toggle').classList.toggle('is-on', open);
  $('office-toggle').setAttribute('aria-pressed', String(open));
  $('office-view').hidden = !open;
  if (open) {
    office.start();
    fitOffice();
  } else office.stop();
}
register('topbar', renderTopbar);

function fitOffice(): void {
  if (!officeReady) return;
  // Serit yuksekligi sahneden gelir; yalnizca ust sinir verilir.
  office.setFillWidth(true);
  office.setMaxHeight(Math.min(250, Math.max(130, window.innerHeight * 0.28)));
}

function toggleOffice(): void {
  state.config.ui.officeOpen = state.config.ui.officeOpen === false;
  void api.saveConfig(state.config);
  invalidate('topbar');
}
$('office-toggle').addEventListener('click', toggleOffice);

let officeSignature = '';
function syncOfficeAgents(): void {
  if (!officeReady) return;
  const list = agents().filter((a) => a.enabled);
  // Yalnizca ajan kadrosu ya da uyku durumu degistiginde sahne guncellenir.
  const signature = list.map((a) => `${a.id}:${a.available}:${Boolean(a.quota?.capped || state.sleeping.has(a.id))}`).join('|');
  if (signature === officeSignature) return;
  officeSignature = signature;
  const slugs = state.config.providers.map((p) => p.slug);
  office.setAgents(list.map((a) => ({
    id: a.id,
    label: a.label,
    color: metaFor(a.id).color,
    charIndex: charIndexFor(a.id, slugs) ?? undefined,
  })));
  for (const a of list) {
    const sleep = state.sleeping.get(a.id);
    if (sleep || a.quota?.capped) office.setSleeping(a.id, sleep?.retryAt ?? a.quota?.unlocksAt, undefined);
    else if (!a.available) office.setActivity(a.id, 'offline');
    else office.setOnline(a.id);
  }
}

function activityForPhase(phase: RunPhase): AgentActivity {
  if (phase === 'planning' || phase === 'claiming' || phase === 'arbitrating') return 'meeting';
  return phase === 'executing' ? 'working' : 'reading';
}

// --------------------------------------------------------------- olaylar

let flowTimer = 0;
/** Etkinlik olaylari cok sik gelir; akis en fazla saniyede dort kez cizilir. */
function flowSoon(): void {
  if (flowTimer) return;
  flowTimer = window.setTimeout(() => {
    flowTimer = 0;
    invalidate('flow');
  }, 250);
}

api.onEvent((event) => {
  switch (event.type) {
    case 'run:started':
      state.running = true;
      state.live = { record: event.run, activity: [], phase: event.run.phase };
      state.selectedRunId = event.run.id;
      office.enterOffice();
      invalidate('flow', 'sidebar', 'topbar', 'composer');
      break;

    case 'run:phase':
      if (state.live?.record.id === event.runId) state.live.phase = event.phase;
      if (['planning', 'claiming', 'arbitrating'].includes(event.phase)) office.setTeamActivity('meeting');
      invalidate('flow', 'composer');
      break;

    case 'run:updated':
      if (state.live?.record.id === event.run.id) state.live.record = event.run;
      else if (state.viewed?.record.id === event.run.id) state.viewed.record = event.run;
      for (const task of event.run.tasks) {
        if (!task.assignedTo) continue;
        if (task.status === 'running') office.setActivity(task.assignedTo, 'working');
        else if (task.status === 'failed') office.setActivity(task.assignedTo, 'blocked');
      }
      flowSoon();
      invalidate('sidebar');
      break;

    case 'run:finished': {
      state.running = false;
      if (state.live?.record.id === event.run.id) {
        state.live.record = event.run;
        state.live.phase = event.run.phase;
      }
      office.setTeamActivity('done');
      for (const task of event.run.tasks) {
        if (task.assignedTo) office.setActivity(task.assignedTo, task.status === 'succeeded' ? 'done' : 'blocked');
      }
      const ok = event.run.phase === 'done';
      toast(ok
        ? L(`Tamamlandı${event.run.applied?.ok ? ' · klasöre uygulandı' : ''}`, `Completed${event.run.applied?.ok ? ' · applied to folder' : ''}`)
        : event.run.phase === 'cancelled' ? L('Görev durduruldu', 'Task stopped') : L('Görev tamamlanamadı', 'Task could not be completed'));
      void refreshRuns();
      void refreshQuotas();
      void refreshAgents();
      // Oturum dusmesi gibi sorunlar karsilama kartina ve hazirlik listesine yansir.
      if (event.run.phase !== 'done') void loadSetup(true);
      invalidate('flow', 'sidebar', 'composer', 'topbar');
      break;
    }

    case 'agent:status':
      if (event.status === 'sleeping') {
        state.sleeping.set(event.agent, { retryAt: event.retryAt, reason: event.reason });
        office.setSleeping(event.agent, event.retryAt, event.retryHint);
      } else {
        state.sleeping.delete(event.agent);
        office.setAvailable(event.agent);
      }
      invalidate('sidebar', 'composer', 'chat');
      break;

    case 'activity':
      if (state.live?.record.id === event.runId) {
        state.live.activity.push({ agent: event.agent, text: event.text, tone: event.tone, at: event.at, phase: event.phase });
        if (state.live.activity.length > 1500) state.live.activity.splice(0, 300);
        flowSoon();
      }
      office.setActivity(event.agent, activityForPhase(state.live?.phase ?? 'executing'));
      office.pulse(event.agent);
      break;

    case 'log':
      if (event.level !== 'info' && state.live?.record.id === event.runId) {
        state.live.activity.push({ agent: event.agent, text: event.text, tone: event.level, at: event.at });
        flowSoon();
      }
      if (event.agent !== 'orchestrator' && event.level === 'error') office.setActivity(event.agent, 'blocked');
      break;

    case 'stream':
      office.pulse(event.agent);
      break;

    case 'chat:message':
      upsertMessage(event.message);
      break;

    case 'chat:delta':
      liveText.set(event.id, event.text);
      invalidate('chat');
      break;

    case 'chat:done':
      liveText.delete(event.message.id);
      if (event.message.kind === 'error') void loadSetup(true);
      upsertMessage(event.message);
      break;

    case 'debate:updated': {
      const d = event.debate;
      const item = { id: d.id, title: d.title, projectDir: d.projectDir, updatedAt: d.updatedAt, score: d.summary?.score, busy: d.busy, converted: Boolean(d.converted) };
      const index = state.debates.findIndex((x) => x.id === d.id);
      if (index >= 0) state.debates[index] = item;
      else if (!d.projectDir || d.projectDir === state.project?.dir) state.debates.unshift(item);
      state.debates.sort((a, b) => b.updatedAt - a.updatedAt);
      if (state.debate?.id === d.id) state.debate = d;
      for (const m of d.messages) if (!m.pending) state.debateLive.delete(m.id);
      if (d.busy !== 'summary') state.debateLive.delete(`summary:${d.id}`);
      // Ofiste tartisanlar toplanti masasina gecer; bir gorev calisiyorsa sahneye dokunulmaz.
      if (officeReady && !state.running) {
        const speaking = new Set(d.messages.filter((m) => m.pending).map((m) => String(m.from)));
        for (const agent of Object.keys(d.roles ?? {})) {
          if (state.sleeping.has(agent)) continue;
          if (d.busy) office.setActivity(agent, speaking.has(agent) ? 'thinking' : 'meeting');
          else office.setOnline(agent);
        }
      }
      invalidate('flow', 'sidebar', 'composer', 'topbar');
      break;
    }

    case 'debate:delta':
      // Karar notu akisi tartisma basina ayri tutulur; iki tartisma ayni anda yazabilir.
      state.debateLive.set(event.id === 'summary' ? `summary:${event.debateId}` : event.id, { from: event.from, text: event.text });
      if (officeReady) office.pulse(event.from);
      if (state.debate?.id === event.debateId) flowSoon();
      break;

    case 'quota:updated':
      state.quotas = event.quotas;
      invalidate('sidebar', 'composer', 'settings', 'chat');
      break;
  }
});

// --------------------------------------------------------------- klavye

document.addEventListener('keydown', (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    newTask();
  } else if (mod && event.key === ',') {
    event.preventDefault();
    openSettings();
  } else if (mod && event.key.toLowerCase() === 'j') {
    event.preventDefault();
    state.config.ui.chatOpen = !state.config.ui.chatOpen;
    void api.saveConfig(state.config);
    invalidate('chat');
  } else if (mod && !event.shiftKey && event.key.toLowerCase() === 'd') {
    event.preventDefault();
    newDebate();
  } else if (mod && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    toggleOffice();
  }
});

// --------------------------------------------------------------- baslangic

(async () => {
  state.config = await api.loadConfig();
  if (isDesktop && state.config.ui.theme !== 'system') void api.setTheme(state.config.ui.theme);
  invalidate('sidebar', 'flow', 'chat', 'composer', 'topbar');

  const recent = state.config.recentProjects[0];
  void api.system().then((info) => {
    state.system = info;
    invalidate('flow');
  }).catch(() => {});

  // Yeni surum varsa kenar cubugunda indirme baglantisi gorunur.
  if (isDesktop && state.config.ui.updateCheck !== false) {
    void api.checkUpdate().then((info) => {
      if (!info.available || !info.latest) return;
      $('update-text').textContent = L(`Yeni sürüm ${info.latest} · İndir`, `New version ${info.latest} · Download`);
      $('update-pill').hidden = false;
      $('update-pill').addEventListener('click', () => void api.openDownloads());
    }).catch(() => {});
  }

  // Hazirlik denetimi; kullanici Ayarlar'dan donunce eksikler yeniden denetlenir.
  void loadSetup();
  window.addEventListener('focus', () => {
    if (setupChecks().some((c) => c.state !== 'ok')) void loadSetup(true);
  });

  // Ilk acilista kisa tanitim ve ajan baglama paneli.
  if (!state.config.ui.onboarded) openGuide();

  if (recent) {
    try {
      await useProject(recent);
    } catch {
      state.project = null;
    }
  } else {
    await Promise.all([loadChats(), refreshAgents(), refreshDebates()]);
  }

  try {
    await office.load();
    officeReady = true;
    if (state.config.ui.officeOpen !== false) office.start();
    syncOfficeAgents();
    fitOffice();
    window.addEventListener('resize', fitOffice);
  } catch (err) {
    console.warn(L('Ofis görselleri yüklenemedi', 'Could not load office assets'), err);
  }

  await refreshQuotas();
  syncOfficeAgents();

  // Ajan listesi degistikce ofis sahnesi de guncellenir.
  register('sidebar', () => {
    renderSidebar();
    syncOfficeAgents();
  });

  // Uyku/limit sayaclari: sure dolunca kullanici yenilemeye basmadan acilir.
  window.setInterval(() => {
    const expired = [...state.sleeping.entries()].filter(([, s]) => s.retryAt && s.retryAt <= Date.now());
    for (const [agent] of expired) {
      state.sleeping.delete(agent);
      office.setAvailable(agent);
    }
    if (expired.length) void refreshAgents();
  }, 15_000);
  window.setInterval(() => void refreshQuotas(), 5 * 60_000);
})();
