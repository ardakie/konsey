/** Arayuz eylemleri: ana surece gider, durumu gunceller, ilgili bolumleri yeniler. */
import { loadSetup } from './setup';
import type { AgentId, ChatMessage, RunMode } from '../../src/shared/types';
import { api } from './api';
import { basename, toast } from './dom';
import { invalidate, labelFor, saveConfigSoon, setAgentEnabled, state, type Thread } from './state';
import { L } from '../../src/shared/i18n';

export async function saveConfig(): Promise<void> {
  await saveConfigSoon((config) => api.saveConfig(config));
}

export async function refreshAgents(): Promise<void> {
  const list = await api.availability(state.project?.dir);
  state.availability = list;
  // Ana surec yeni kurulan CLI'lari ayarlara ekler; arayuzdeki kopya da guncellenir.
  if (list.some((a) => a.agent.startsWith('cli:') && !state.config.profiles.some((p) => p.agent === a.agent))) {
    state.config.profiles = (await api.loadConfig()).profiles;
  }
  for (const a of list) {
    if (a.failureKind === 'quota') state.sleeping.set(a.agent, { retryAt: a.retryAt, reason: a.detail });
    else {
      const sleep = state.sleeping.get(a.agent);
      if (sleep?.retryAt && sleep.retryAt <= Date.now()) state.sleeping.delete(a.agent);
    }
  }
  invalidate('sidebar', 'composer', 'chat', 'settings', 'flow');
}

export async function refreshQuotas(refresh = false): Promise<void> {
  const [quotas, usage] = await Promise.all([api.quotas(refresh), api.usage()]);
  state.quotas = quotas;
  state.usage = usage;
  invalidate('sidebar', 'composer', 'chat', 'settings', 'flow');
}

export async function refreshRuns(): Promise<void> {
  state.runs = state.project ? await api.listRuns(state.project.dir) : [];
  invalidate('sidebar');
}

export async function loadChats(): Promise<void> {
  state.chats = await api.loadChats(state.project?.dir ?? null);
  invalidate('chat');
}

export async function useProject(dir: string): Promise<void> {
  state.project = await api.selectProject(dir);
  // Baska projeye ait acik tartisma kapanir; serbest fikirler acik kalir.
  if (state.debate?.projectDir && state.debate.projectDir !== dir) closeDebate();
  state.config.recentProjects = [dir, ...state.config.recentProjects.filter((p) => p !== dir)].slice(0, 12);
  if (!state.running) state.selectedRunId = null;
  state.viewed = null;
  await Promise.all([refreshRuns(), loadChats(), refreshAgents(), refreshDebates()]);
  // Klasor izni gibi proje ozelindeki denetimler yenilenir.
  void loadSetup(true);
  invalidate('sidebar', 'flow', 'topbar', 'composer', 'chat');
}

export async function pickProject(): Promise<void> {
  const picked = await api.pickProject();
  if (!picked) return;
  await useProject(picked.dir);
  toast(L(
    `${basename(picked.dir)} seçildi${picked.isGit ? '' : ' · ilk görevde otomatik hazırlanacak'}`,
    `${basename(picked.dir)} selected${picked.isGit ? '' : ' · will be set up automatically on the first task'}`,
  ));
}

export async function prepareProject(): Promise<void> {
  if (!state.project) return;
  const result = await api.prepareProject(state.project.dir);
  toast(result.message);
  state.project = await api.describeProject(state.project.dir);
  invalidate('flow', 'sidebar');
}

export function toggleAgent(id: AgentId, enabled?: boolean): void {
  const current = state.config.profiles.find((p) => p.agent === id)?.enabled
    ?? state.config.providers.find((p) => `provider:${p.slug}` === id)?.enabled
    ?? false;
  const next = enabled ?? !current;
  setAgentEnabled(id, next);
  invalidate('sidebar', 'composer', 'chat', 'settings', 'flow');
  void saveConfig();
  toast(L(`${labelFor(id)} ${next ? 'açıldı' : 'kapatıldı'}`, `${labelFor(id)} ${next ? 'turned on' : 'turned off'}`), 1800);
}

export function newTask(): void {
  closeDebate();
  state.selectedRunId = null;
  state.view = 'flow';
  invalidate('flow', 'sidebar', 'topbar');
  requestAnimationFrame(() => (document.getElementById('prompt') as HTMLTextAreaElement | null)?.focus());
}

export async function openRun(id: string): Promise<void> {
  closeDebate();
  state.selectedRunId = id;
  state.view = 'flow';
  if (state.live?.record.id !== id) {
    const stored = await api.getRun(id);
    if (!stored) {
      toast(L('Görev kaydı bulunamadı.', 'Task record not found.'));
      return;
    }
    state.viewed = stored;
  }
  invalidate('flow', 'sidebar', 'topbar');
}

export async function deleteRun(id: string): Promise<void> {
  await api.deleteRun(id);
  if (state.selectedRunId === id) state.selectedRunId = null;
  await refreshRuns();
  invalidate('flow');
}

export async function applyRun(id: string): Promise<void> {
  const result = await api.applyRun(id);
  toast(result.message);
  const stored = await api.getRun(id);
  if (stored) {
    if (state.viewed?.record.id === id) state.viewed = stored;
    if (state.live?.record.id === id) state.live.record = stored.record;
  }
  await refreshRuns();
  invalidate('flow');
}

export function setMode(mode: RunMode): void {
  state.config.ui.mode = mode;
  invalidate('composer');
  void saveConfig();
}

export async function startRun(prompt: string, mode: RunMode = state.config.ui.mode): Promise<boolean> {
  if (!state.project) {
    await pickProject();
    if (!state.project) return false;
  }
  if (state.running) {
    toast(L('Zaten çalışan bir görev var.', 'A task is already running.'));
    return false;
  }
  const attachmentText = state.attachments.length
    ? `\n\nEkli görseller (yerel dosya yolları):\n${state.attachments.map((item) => `- ${item.path}`).join('\n')}`
    : '';
  const fullPrompt = `${prompt || L('Ekli görselleri incele.', 'Review the attached images.')}${attachmentText}`;
  state.running = true;
  state.attachments = [];
  invalidate('composer');
  const res = await api.startRun({ projectDir: state.project!.dir, prompt: fullPrompt, mode });
  if (!res.ok) {
    state.running = false;
    toast(res.error ?? L('Görev başlatılamadı.', 'Could not start the task.'));
    invalidate('composer', 'flow');
    return false;
  }
  return true;
}

export function openChat(thread: Thread): void {
  state.chatThread = thread;
  state.sidePane = 'chat';
  state.unread.delete(thread);
  if (!state.config.ui.chatOpen) {
    state.config.ui.chatOpen = true;
    void saveConfig();
  }
  invalidate('chat', 'topbar', 'sidebar');
  requestAnimationFrame(() => (document.getElementById('chat-input') as HTMLTextAreaElement | null)?.focus());
}

export async function sendChat(text: string): Promise<void> {
  const thread = state.chatThread;
  if (!text.trim() || state.chatBusy.has(thread)) return;
  state.chatBusy.add(thread);
  invalidate('chat');
  const res = await api.sendChat({ projectDir: state.project?.dir ?? null, thread, text });
  state.chatBusy.delete(thread);
  if (!res.ok) toast(res.error ?? L('Mesaj gönderilemedi.', 'Could not send the message.'));
  invalidate('chat');
  void refreshQuotas();
}

export function upsertMessage(message: ChatMessage): void {
  const list = (state.chats[message.thread] ??= []);
  const index = list.findIndex((m) => m.id === message.id);
  if (index >= 0) list[index] = message;
  else list.push(message);
  if (message.thread !== state.chatThread || !state.config.ui.chatOpen || state.sidePane !== 'chat') {
    if (message.from !== 'user' && !message.pending) state.unread.add(message.thread);
  }
  invalidate('chat');
}

export async function clearChat(): Promise<void> {
  await api.clearChat(state.project?.dir ?? null, state.chatThread);
  delete state.chats[state.chatThread];
  invalidate('chat');
}

export function draftTask(text: string): void {
  const area = document.getElementById('prompt') as HTMLTextAreaElement | null;
  closeDebate();
  state.selectedRunId = null;
  invalidate('flow', 'sidebar', 'topbar');
  if (area) {
    area.value = text;
    area.dispatchEvent(new Event('input'));
    area.focus();
  }
}

// --------------------------------------------------------------- tartismalar

export async function refreshDebates(): Promise<void> {
  state.debates = await api.listDebates(state.project?.dir ?? null).catch(() => []);
  invalidate('sidebar');
}

function focusPrompt(): void {
  requestAnimationFrame(() => (document.getElementById('prompt') as HTMLTextAreaElement | null)?.focus());
}

/** Yeni tartisma ekrani; yazma kutusu fikri alir. */
export function newDebate(scope?: 'project' | 'free'): void {
  state.debateId = 'new';
  state.debate = null;
  state.debateScope = scope ?? (state.project ? state.debateScope : 'free');
  if (!state.project) state.debateScope = 'free';
  invalidate('flow', 'sidebar', 'topbar', 'composer');
  focusPrompt();
}

export async function openDebate(id: string): Promise<void> {
  const debate = await api.getDebate(id);
  if (!debate) {
    toast(L('Tartışma bulunamadı.', 'Discussion not found.'));
    await refreshDebates();
    return;
  }
  state.debateId = id;
  state.debate = debate;
  invalidate('flow', 'sidebar', 'topbar', 'composer');
}

export function closeDebate(): void {
  if (!state.debateId) return;
  state.debateId = null;
  state.debate = null;
  invalidate('flow', 'sidebar', 'topbar', 'composer');
}

export function debateBusy(): boolean {
  return Boolean(state.debate?.busy);
}

/** Yeni tartisma baslatir ya da acik tartismaya kullanici olarak katilir. */
export async function submitDebate(text: string): Promise<boolean> {
  if (state.debateId === 'new') {
    const projectDir = state.debateScope === 'project' ? state.project?.dir ?? null : null;
    const res = await api.startDebate({ topic: text, projectDir, depth: state.config.ui.debateDepth ?? 2 });
    if (!res.ok || !res.debate) {
      toast(res.error ?? L('Tartışma başlatılamadı.', 'Could not start the discussion.'));
      return false;
    }
    state.debateId = res.debate.id;
    state.debate = res.debate;
    await refreshDebates();
    invalidate('flow', 'composer', 'topbar');
    return true;
  }
  if (!state.debate) return false;
  const res = await api.sayDebate(state.debate.id, text);
  if (!res.ok) toast(res.error ?? L('Mesaj gönderilemedi.', 'Could not send the message.'));
  return res.ok;
}

export async function debateAction(action: 'round' | 'summarize'): Promise<void> {
  if (!state.debate) return;
  const res = action === 'round' ? await api.roundDebate(state.debate.id) : await api.summarizeDebate(state.debate.id);
  if (!res.ok) toast(res.error ?? L('Başlatılamadı.', 'Could not start.'));
}

export async function removeDebate(id: string): Promise<void> {
  await api.deleteDebate(id);
  if (state.debateId === id) closeDebate();
  await refreshDebates();
}
