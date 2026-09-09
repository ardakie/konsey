/**
 * Konsey arayuzu.
 *
 * Durum ana surecte tutulur; burada yalnizca gelen olaylar ekrana yansitilir.
 * Node API'lerine erisim yok, her sey window.konsey koprusunden gecer.
 */
import { PixelOffice, type AgentActivity } from './pixel/office';
import { setupPreview } from './preview';
setupPreview();
import { createMockApi } from './devMock';
import type {
  AgentAvailability,
  AgentId,
  KonseyEvent,
  ProviderConfig,
  RunPhase,
  RunRecord,
} from '../src/shared/types';

interface KonseyApi {
  availability(preferWorkspace?: string): Promise<AgentAvailability[]>;
  pickImages(): Promise<ImageAttachment[]>;
  imagesFromPaths(paths: string[]): Promise<ImageAttachment[]>;
  saveImage(input: { name?: string; mime: string; bytes: ArrayBuffer }): Promise<ImageAttachment>;
  filePath(file: File): string;
  loadConfig(): Promise<any>;
  saveConfig(config: unknown): Promise<boolean>;
  setProviderKey(slug: string, apiKey: string): Promise<boolean>;
  hasProviderKey(slug: string): Promise<boolean>;
  testProvider(provider: unknown, apiKey?: string): Promise<{ ok: boolean; models: string[]; error?: string }>;
  pickProject(): Promise<{ dir: string; isGit: boolean } | null>;
  openPath(target: string): Promise<void>;
  startRun(args: { projectDir: string; prompt: string }): Promise<{ ok: boolean; record?: RunRecord; error?: string }>;
  cancelRun(): Promise<boolean>;
  onEvent(handler: (event: KonseyEvent) => void): () => void;
}

interface ImageAttachment {
  path: string;
  name: string;
  dataUrl: string;
}

declare global {
  interface Window {
    konsey: KonseyApi;
  }
}

// Electron disinda (tarayicida) acildiginda arayuz sahte koprüyle calisir.
const api: KonseyApi = window.konsey ?? createMockApi();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  main: $('main'),
  pickProject: $('pick-project'),
  projectPath: $('project-path'),
  projectWarning: $('project-warning'),
  refreshAgents: $('refresh-agents'),
  agentList: $('agent-list'),
  openSettings: $('open-settings'),
  phases: $('phases'),
  taskBoard: $('task-board'),
  reviewCard: $('review-card'),
  laneContainer: $('lane-container'),
  composer: $<HTMLFormElement>('composer'),
  attachments: $('attachments'),
  attachImages: $<HTMLButtonElement>('attach-images'),
  prompt: $<HTMLTextAreaElement>('prompt'),
  startRun: $<HTMLButtonElement>('start-run'),
  cancelRun: $<HTMLButtonElement>('cancel-run'),
  statusLine: $('status-line'),
  settings: $<HTMLDialogElement>('settings'),
  providerList: $('provider-list'),
  officeSection: $('office-section'),
  officeSplitter: $('office-splitter'),
};

let projectDir: string | null = null;
let running = false;
let config: any = { profiles: [], providers: [], recentProjects: [] };
let attachments: ImageAttachment[] = [];

/** Piksel ofis — ajanlarin ne yaptigini gorsel olarak gosterir. */
const office = new PixelOffice($<HTMLCanvasElement>('office'), 'assets/');
// Sahte kopruyle (tarayicida) calisirken sahneyi elle denetleyebilmek icin.
if (!window.konsey) (window as unknown as Record<string, unknown>).__office = office;
let officeReady = false;
/** Calismanin su anki asamasi; akis olaylarini dogru duruma cevirmek icin. */
let currentPhase: RunPhase = 'idle';
const sleepingAgents = new Map<string, { retryAt?: number; retryHint?: string; reason?: string }>();

// --------------------------------------------------------------- yardimci

const PHASES: { key: RunPhase; label: string }[] = [
  { key: 'planning', label: 'Plan' },
  { key: 'claiming', label: 'Paylaşım' },
  { key: 'arbitrating', label: 'Hakem' },
  { key: 'executing', label: 'Çalışma' },
  { key: 'merging', label: 'Birleştirme' },
  { key: 'reviewing', label: 'İnceleme' },
  { key: 'done', label: 'Bitti' },
];

const BUILTIN_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  orchestrator: 'Konsey',
};

function labelFor(agent: string): string {
  if (agent.startsWith('provider:')) {
    const slug = agent.slice('provider:'.length);
    return config.providers?.find((p: ProviderConfig) => p.slug === slug)?.label ?? slug;
  }
  return BUILTIN_LABELS[agent] ?? agent;
}

function agentClass(agent: string): string {
  return agent.startsWith('provider:') ? 'provider' : agent;
}

/** Ofisteki isim etiketleri arayuzdeki ajan renkleriyle ayni olmali. */
const AGENT_HEX: Record<string, string> = {
  claude: '#d97757',
  codex: '#4fb894',
  antigravity: '#6ea0e8',
};

function hexFor(agent: string): string {
  return AGENT_HEX[agent] ?? '#a98cdb';
}

function colorFor(agent: string): string {
  const map: Record<string, string> = {
    claude: 'var(--claude)',
    codex: 'var(--codex)',
    antigravity: 'var(--antigravity)',
    orchestrator: 'var(--ink-faint)',
  };
  return map[agent] ?? 'var(--provider)';
}

/** Metni her zaman textContent ile yaz; ajan ciktisi HTML olarak yorumlanmamali. */
function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --------------------------------------------------------------- ajanlar

async function refreshAgents(): Promise<void> {
  const list = await api.availability(projectDir ?? undefined);
  els.agentList.replaceChildren();

  // Uygulama yeni acilmis olsa bile yerel kota kesfi uyuyan ajani sahneye tasir.
  for (const a of list) {
    if (a.failureKind === 'quota') {
      sleepingAgents.set(a.agent, {
        retryAt: a.retryAt,
        retryHint: a.retryHint,
        reason: a.detail,
      });
    } else {
      const existing = sleepingAgents.get(a.agent);
      if (existing?.retryAt && existing.retryAt <= Date.now()) sleepingAgents.delete(a.agent);
    }
  }

  for (const a of list) {
    const sleep = sleepingAgents.get(a.agent);
    const item = el('li', `agent-item${sleep ? ' is-sleeping' : a.available ? '' : ' is-down'}`);
    const dot = el('span', `agent-dot ${sleep ? 'sleeping' : a.available ? 'ok' : 'down'}`);
    const body = el('div');
    body.append(
      el('div', 'agent-name', labelFor(a.agent)),
      el('div', 'agent-detail', sleep ? `Token uykusunda · ${sleep.retryHint ?? 'yenilenme zamanı bilinmiyor'}` : a.detail),
    );
    item.append(dot, body);
    els.agentList.append(item);
  }

  // Ofis sahnesi ayni listeden beslenir: kullanilamayan ajan masasina oturmaz.
  office.setAgents(
    list.map((a) => ({ id: a.agent, label: labelFor(a.agent), color: hexFor(a.agent) })),
  );
  for (const a of list) {
    const sleep = sleepingAgents.get(a.agent);
    if (sleep) office.setSleeping(a.agent, sleep.retryAt, sleep.retryHint);
    else if (!a.available) office.setActivity(a.agent, 'offline');
  }
}

// ------------------------------------------------------ ofis ayiricisi

const OFFICE_HEIGHT_KEY = 'konsey:office-height';
const MIN_OFFICE_HEIGHT = 180;
let officeHeight = Number(localStorage.getItem(OFFICE_HEIGHT_KEY)) || Math.round(window.innerHeight * 0.38);

function maxOfficeHeight(): number {
  // Alt gorev/akis bolumune her kosulda kullanilabilir bir alan birak.
  return Math.max(
    MIN_OFFICE_HEIGHT,
    els.main.clientHeight - els.phases.offsetHeight - els.composer.offsetHeight - 190,
  );
}

function applyOfficeHeight(value: number, persist = false): void {
  officeHeight = Math.round(Math.max(MIN_OFFICE_HEIGHT, Math.min(maxOfficeHeight(), value)));
  els.officeSection.style.height = `${officeHeight}px`;
  els.officeSplitter.setAttribute('aria-valuenow', String(officeHeight));
  els.officeSplitter.setAttribute('aria-valuemax', String(maxOfficeHeight()));
  office.setMaxHeight(Math.max(120, officeHeight - 58));
  if (persist) localStorage.setItem(OFFICE_HEIGHT_KEY, String(officeHeight));
}

function bindOfficeSplitter(): void {
  let dragging = false;
  let startY = 0;
  let startHeight = officeHeight;

  els.officeSplitter.addEventListener('mousedown', (event) => {
    dragging = true;
    startY = event.clientY;
    startHeight = officeHeight;
    els.officeSplitter.classList.add('is-dragging');
    document.body.classList.add('is-resizing-office');
    event.preventDefault();
  });
  document.addEventListener('mousemove', (event) => {
    if (dragging) applyOfficeHeight(startHeight + event.clientY - startY);
  });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    els.officeSplitter.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing-office');
    localStorage.setItem(OFFICE_HEIGHT_KEY, String(officeHeight));
  };
  document.addEventListener('mouseup', finish);
  window.addEventListener('blur', finish);
  els.officeSplitter.addEventListener('dragstart', (event) => event.preventDefault());
  els.officeSplitter.addEventListener('keydown', (event) => {
    let next: number | undefined;
    if (event.key === 'ArrowUp') next = officeHeight - 16;
    if (event.key === 'ArrowDown') next = officeHeight + 16;
    if (event.key === 'Home') next = MIN_OFFICE_HEIGHT;
    if (event.key === 'End') next = maxOfficeHeight();
    if (next === undefined) return;
    event.preventDefault();
    applyOfficeHeight(next, true);
  });
}

// ---------------------------------------------------------------- fazlar

function renderPhases(current: RunPhase): void {
  els.phases.replaceChildren();
  const currentIndex = PHASES.findIndex((p) => p.key === current);

  PHASES.forEach((phase, i) => {
    const done = currentIndex > i || current === 'done';
    const active = phase.key === current;
    const node = el('li', `phase${active ? ' active' : done ? ' done' : ''}`);
    node.append(el('span', '', done && !active ? '✓' : String(i + 1)), el('span', '', phase.label));
    els.phases.append(node);
  });
}

// -------------------------------------------------------------- gorevler

function renderTasks(run: RunRecord): void {
  els.taskBoard.replaceChildren();
  if (run.tasks.length === 0) {
    els.taskBoard.append(el('p', 'empty', 'Plan bekleniyor…'));
    return;
  }

  for (const task of run.tasks) {
    const owner = task.assignedTo ?? task.suggestedAgent;
    const card = el('div', `task-card ${owner ? agentClass(owner) : ''}`);

    const head = el('div', 'task-head');
    head.append(
      el('span', 'task-title', task.title),
      el('span', 'task-owner', owner ? labelFor(owner) : 'atanmadı'),
    );
    card.append(head);

    if (task.detail) card.append(el('div', 'task-detail', task.detail));
    if (task.scope.length) card.append(el('div', 'task-scope', task.scope.join('  ·  ')));

    const statusText: Record<string, string> = {
      pending: 'bekliyor',
      claimed: 'atandı',
      running: 'çalışıyor',
      succeeded: 'tamam',
      failed: 'başarısız',
      skipped: 'atlandı',
    };
    card.append(el('span', `task-status ${task.status}`, statusText[task.status] ?? task.status));
    if (task.error) card.append(el('div', 'task-detail', task.error));

    els.taskBoard.append(card);
  }
}

function renderReview(run: RunRecord): void {
  if (!run.review) {
    els.reviewCard.hidden = true;
    return;
  }
  const verdictText: Record<string, string> = {
    approved: 'Onaylandı',
    'changes-requested': 'Düzeltme isteniyor',
    unknown: 'Sonuç belirsiz',
  };

  els.reviewCard.replaceChildren();
  els.reviewCard.append(
    el('div', `review-verdict ${run.review.verdict}`, `${verdictText[run.review.verdict]} — ${labelFor(run.review.reviewer)}`),
    el('div', 'small', run.review.summary),
  );
  if (run.review.findings.length) {
    const ul = el('ul', 'review-findings');
    for (const f of run.review.findings) ul.append(el('li', '', f));
    els.reviewCard.append(ul);
  }
  els.reviewCard.hidden = false;
}

// -------------------------------------------------------------- seritler

const lanes = new Map<string, HTMLElement>();

function laneBody(agent: string): HTMLElement {
  const existing = lanes.get(agent);
  if (existing) return existing;

  if (lanes.size === 0) els.laneContainer.replaceChildren();

  const lane = el('div', 'lane');
  const head = el('div', 'lane-head');
  const swatch = el('span', 'lane-swatch');
  swatch.style.background = colorFor(agent);
  head.append(swatch, el('span', '', labelFor(agent)));

  const body = el('div', 'lane-body');
  lane.append(head, body);
  els.laneContainer.append(lane);
  lanes.set(agent, body);
  return body;
}

function appendLog(agent: string, text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const body = laneBody(agent);
  // Serit cok uzarsa bellegi ve cizimi korumak icin bastan kirp.
  if (body.childElementCount > 400) body.firstElementChild?.remove();

  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.append(el('div', `log-line ${level}`, text));
  if (atBottom) body.scrollTop = body.scrollHeight;
}

// ----------------------------------------------------------------- akis

/** Salt okunur turlarda ajan okur, yurutme turunda yazar. */
function activityForPhase(phase: RunPhase): AgentActivity {
  if (phase === 'planning' || phase === 'claiming' || phase === 'arbitrating') return 'meeting';
  return phase === 'executing' ? 'working' : 'reading';
}

/** Gorev durumlarini ofisteki karakterlere yansitir. */
function syncOfficeFromRun(run: RunRecord): void {
  for (const task of run.tasks) {
    if (!task.assignedTo) continue;
    if (task.status === 'running') office.setActivity(task.assignedTo, 'working');
    else if (task.status === 'failed') office.setActivity(task.assignedTo, 'blocked');
  }
}

function setRunning(state: boolean): void {
  running = state;
  els.startRun.disabled = state || !projectDir;
  els.cancelRun.hidden = !state;
  els.prompt.disabled = state;
  els.attachImages.disabled = state;
}

api.onEvent((event) => {
  switch (event.type) {
    case 'run:started':
      lanes.clear();
      els.laneContainer.replaceChildren();
      els.reviewCard.hidden = true;
      currentPhase = event.run.phase;
      renderPhases(event.run.phase);
      renderTasks(event.run);
      office.enterOffice();
      els.statusLine.textContent = `Çalışma ${event.run.id} başladı`;
      break;

    case 'run:phase':
      currentPhase = event.phase;
      renderPhases(event.phase);
      if (event.phase === 'planning' || event.phase === 'claiming' || event.phase === 'arbitrating') {
        office.setTeamActivity('meeting');
      }
      break;

    case 'run:updated':
      renderTasks(event.run);
      renderReview(event.run);
      syncOfficeFromRun(event.run);
      break;

    case 'run:finished': {
      renderPhases(event.run.phase);
      renderTasks(event.run);
      renderReview(event.run);
      setRunning(false);
      currentPhase = event.run.phase;
      office.setTeamActivity('done');
      for (const task of event.run.tasks) {
        if (!task.assignedTo) continue;
        office.setActivity(task.assignedTo, task.status === 'succeeded' ? 'done' : 'blocked');
      }

      const ok = event.run.phase === 'done';
      els.statusLine.textContent = ok
        ? `Bitti. Dal: ${event.run.integrationBranch ?? '—'}`
        : `Durum: ${event.run.phase}${event.run.error ? ' — ' + event.run.error : ''}`;
      void refreshAgents();
      break;
    }

    case 'agent:status':
      if (event.status === 'sleeping') {
        sleepingAgents.set(event.agent, {
          retryAt: event.retryAt,
          retryHint: event.retryHint,
          reason: event.reason,
        });
        office.setSleeping(event.agent, event.retryAt, event.retryHint);
        els.statusLine.textContent = `${labelFor(event.agent)} token uykusunda; işi sıradaki ajan devralıyor.`;
      } else {
        sleepingAgents.delete(event.agent);
        office.setAvailable(event.agent);
      }
      void refreshAgents();
      break;

    case 'log':
      appendLog(event.agent, event.text, event.level);
      // "Devre disi birakildi" gibi uyarilar ajani masada durdurur.
      if (event.agent !== 'orchestrator' && event.level === 'error') {
        office.setActivity(event.agent, 'blocked');
      }
      break;

    case 'stream':
      appendLog(event.agent, event.chunk.trimEnd());
      // Cikti akiyorsa ajan calisiyor demektir.
      office.setActivity(event.agent, activityForPhase(currentPhase));
      office.pulse(event.agent);
      break;
  }
});

// -------------------------------------------------------------- olaylar

els.pickProject.addEventListener('click', async () => {
  const picked = await api.pickProject();
  if (!picked) return;
  projectDir = picked.dir;
  els.projectPath.textContent = picked.dir;
  els.projectPath.classList.remove('muted');

  if (!picked.isGit) {
    els.projectWarning.textContent =
      'Bu klasör bir git deposu değil. Ajanların izole çalışması için gerekli — klasörde `git init` çalıştırın.';
    els.projectWarning.hidden = false;
  } else {
    els.projectWarning.hidden = true;
  }
  setRunning(false);
  void refreshAgents();
});

els.refreshAgents.addEventListener('click', () => void refreshAgents());

function renderAttachments(): void {
  els.attachments.replaceChildren();
  els.attachments.hidden = attachments.length === 0;
  attachments.forEach((attachment, index) => {
    const card = el('div', 'attachment');
    card.title = attachment.name;
    const image = document.createElement('img');
    image.src = attachment.dataUrl;
    image.alt = attachment.name;
    const remove = el('button', '', '×') as HTMLButtonElement;
    remove.type = 'button';
    remove.title = `${attachment.name} görselini kaldır`;
    remove.addEventListener('click', () => {
      attachments.splice(index, 1);
      renderAttachments();
    });
    card.append(image, remove);
    els.attachments.append(card);
  });
}

function addAttachments(next: ImageAttachment[]): void {
  const known = new Set(attachments.map((item) => item.path));
  for (const item of next) {
    if (!known.has(item.path) && attachments.length < 8) {
      attachments.push(item);
      known.add(item.path);
    }
  }
  renderAttachments();
}

els.attachImages.addEventListener('click', async () => {
  try {
    addAttachments(await api.pickImages());
  } catch (error) {
    els.statusLine.textContent = `Görsel eklenemedi: ${(error as Error).message}`;
  }
});

let dragDepth = 0;
els.composer.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  els.composer.classList.add('is-dragging');
});
els.composer.addEventListener('dragover', (event) => event.preventDefault());
els.composer.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.composer.classList.remove('is-dragging');
});
els.composer.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  els.composer.classList.remove('is-dragging');
  const paths = [...event.dataTransfer.files].map((file) => api.filePath(file)).filter(Boolean);
  if (paths.length) addAttachments(await api.imagesFromPaths(paths));
});

els.prompt.addEventListener('paste', async (event) => {
  const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
  if (!images.length) return;
  event.preventDefault();
  for (const file of images.slice(0, 8 - attachments.length)) {
    const imagePath = api.filePath(file);
    if (imagePath) addAttachments(await api.imagesFromPaths([imagePath]));
    else addAttachments([await api.saveImage({ name: file.name, mime: file.type, bytes: await file.arrayBuffer() })]);
  }
});

els.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = els.prompt.value.trim();
  if ((!prompt && attachments.length === 0) || !projectDir || running) return;

  const attachmentText = attachments.length
    ? `\n\nEkli görseller (yerel dosya yolları):\n${attachments.map((item) => `- ${item.path}`).join('\n')}`
    : '';
  const fullPrompt = `${prompt || 'Ekli görselleri incele.'}${attachmentText}`;

  setRunning(true);
  els.statusLine.textContent = 'Başlatılıyor…';
  const res = await api.startRun({ projectDir, prompt: fullPrompt });
  if (!res.ok) {
    els.statusLine.textContent = res.error ?? 'Başlatılamadı';
    setRunning(false);
  } else {
    attachments = [];
    renderAttachments();
  }
});

// Cmd+Enter ile gonder.
els.prompt.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

els.cancelRun.addEventListener('click', () => void api.cancelRun());

// -------------------------------------------------------------- ayarlar

function renderProviders(): void {
  els.providerList.replaceChildren();
  if (!config.providers?.length) {
    els.providerList.append(el('p', 'muted small', 'Henüz sağlayıcı eklenmedi.'));
    return;
  }

  for (const p of config.providers as ProviderConfig[]) {
    const row = el('div', 'provider-row');
    const info = el('div');
    info.append(
      el('div', '', p.label),
      el('div', 'muted small', `${p.model} · ${p.canWriteCode ? 'kod yazar' : 'yalnızca koordinasyon'}`),
    );

    const remove = el('button', 'btn small', 'Sil') as HTMLButtonElement;
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      config.providers = config.providers.filter((x: ProviderConfig) => x.slug !== p.slug);
      await api.setProviderKey(p.slug, '');
      await api.saveConfig(config);
      renderProviders();
      void refreshAgents();
    });

    row.append(info, remove);
    els.providerList.append(row);
  }
}

els.openSettings.addEventListener('click', () => {
  renderProviders();
  els.settings.showModal();
});

function readProviderForm(): ProviderConfig {
  return {
    slug: $<HTMLInputElement>('p-slug').value.trim(),
    label: $<HTMLInputElement>('p-label').value.trim(),
    baseUrl: $<HTMLInputElement>('p-url').value.trim(),
    model: $<HTMLInputElement>('p-model').value.trim(),
    strengths: $<HTMLInputElement>('p-strengths').value.trim() || 'Genel amaçlı',
    enabled: true,
    canWriteCode: $<HTMLInputElement>('p-write').checked,
    maxTokens: 8000,
  };
}

$('p-test').addEventListener('click', async () => {
  const result = $('p-result');
  const provider = readProviderForm();
  const key = $<HTMLInputElement>('p-key').value.trim();
  if (!provider.baseUrl || !key) {
    result.textContent = 'Base URL ve API anahtarı gerekli.';
    return;
  }
  result.textContent = 'Test ediliyor…';
  const res = await api.testProvider(provider, key);
  result.textContent = res.ok
    ? `Bağlandı. ${res.models.length} model bulundu${res.models.length ? ': ' + res.models.slice(0, 4).join(', ') : ''}`
    : `Başarısız: ${res.error}`;
});

$('p-add').addEventListener('click', async () => {
  const result = $('p-result');
  const provider = readProviderForm();
  const key = $<HTMLInputElement>('p-key').value.trim();

  if (!provider.slug || !provider.label || !provider.baseUrl || !provider.model) {
    result.textContent = 'Ad, kısa kimlik, Base URL ve model zorunlu.';
    return;
  }
  if (!/^[a-z0-9-]+$/.test(provider.slug)) {
    result.textContent = 'Kısa kimlik yalnızca küçük harf, rakam ve tire içerebilir.';
    return;
  }
  if (config.providers?.some((p: ProviderConfig) => p.slug === provider.slug)) {
    result.textContent = 'Bu kısa kimlik zaten kullanılıyor.';
    return;
  }

  if (key) await api.setProviderKey(provider.slug, key);
  config.providers = [...(config.providers ?? []), provider];
  await api.saveConfig(config);

  $<HTMLInputElement>('p-key').value = '';
  result.textContent = `${provider.label} eklendi.`;
  renderProviders();
  void refreshAgents();
});

// ------------------------------------------------------------ baslangic

(async () => {
  config = await api.loadConfig();
  renderPhases('idle');

  // Piksel varliklari yuklenmeden sahne cizilemez; hata olursa arayuz calismaya devam eder.
  try {
    await office.load();
    bindOfficeSplitter();
    applyOfficeHeight(officeHeight);
    window.addEventListener('resize', () => applyOfficeHeight(officeHeight));
    office.start();
    officeReady = true;
  } catch (err) {
    $('office-hint').textContent = `Ofis görselleri yüklenemedi: ${(err as Error).message}`;
  }

  await refreshAgents();

  // Sayaç sıfıra ulaştığında kullanıcı yenilemeye basmadan ajanı uyandır.
  window.setInterval(() => {
    const expired = [...sleepingAgents.entries()].filter(([, sleep]) => sleep.retryAt && sleep.retryAt <= Date.now());
    if (!expired.length) return;
    for (const [agent] of expired) {
      sleepingAgents.delete(agent);
      office.setAvailable(agent);
    }
    void refreshAgents();
  }, 15_000);

  if (config.recentProjects?.length) {
    projectDir = config.recentProjects[0];
    els.projectPath.textContent = projectDir;
    els.projectPath.classList.remove('muted');
  }
  setRunning(false);
})();
