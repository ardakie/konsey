/** Alt yazma kutusu: istek, calisma modu, katilacak ajanlar ve gorsel ekleri. */
import { api, type ImageAttachment } from './api';
import { setMode, startRun, toggleAgent } from './actions';
import { autosize, h, icon, morph, toast } from './dom';
import { agents, avatar, invalidate, MODES, PHASE_LABEL, readiness, register, state } from './state';
import { L } from '../../src/shared/i18n';

const $ = (id: string) => document.getElementById(id)!;

function renderAttachments(): void {
  const box = $('attachments');
  box.replaceChildren();
  box.hidden = state.attachments.length === 0;
  state.attachments.forEach((attachment, index) => {
    box.append(h('div', { class: 'attachment', title: attachment.name },
      h('img', { src: attachment.dataUrl, alt: attachment.name }),
      h('button', {
        type: 'button',
        title: L(`${attachment.name} görselini kaldır`, `Remove ${attachment.name}`),
        on: {
          click: () => {
            state.attachments.splice(index, 1);
            invalidate('composer');
          },
        },
      }, '×'),
    ));
  });
}

function addAttachments(next: ImageAttachment[]): void {
  const known = new Set(state.attachments.map((item) => item.path));
  for (const item of next) {
    if (!known.has(item.path) && state.attachments.length < 8) {
      state.attachments.push(item);
      known.add(item.path);
    }
  }
  invalidate('composer');
}

function renderModeMenu(): void {
  const menu = $('mode-menu');
  menu.replaceChildren();
  for (const mode of MODES) {
    const on = state.config.ui.mode === mode.key;
    menu.append(h('button', {
      class: `menu-item ${on ? 'is-on' : ''}`,
      type: 'button',
      role: 'menuitemradio',
      'aria-checked': String(on),
      on: {
        click: (event: MouseEvent) => {
          event.stopPropagation();
          menu.hidden = true;
          setMode(mode.key);
        },
      },
    },
      h('span', { class: 'menu-item-body' },
        h('span', { class: 'menu-item-title' }, mode.label),
        h('span', { class: 'menu-item-sub', style: { whiteSpace: 'normal' } }, mode.sub),
      ),
      on ? h('span', { class: 'check' }, icon('check')) : null,
    ));
  }
}

function renderAgents(): void {
  const box = $('composer-agents');
  const nodes: Node[] = [];
  for (const agent of agents()) {
    const ready = readiness(agent);
    const capped = agent.enabled && !ready.ok;
    nodes.push(h('button', {
      'data-key': agent.id,
      class: `agent-toggle ${agent.enabled ? '' : 'is-off'} ${capped ? 'is-capped' : ''}`,
      type: 'button',
      title: `${agent.label} — ${agent.enabled ? ready.text : L('kapalı', 'off')}. ${L('Tıkla:', 'Click:')} ${agent.enabled ? L('bu işlerden çıkar', 'remove from this task') : L('işlere kat', 'add to this task')}`,
      'aria-pressed': String(agent.enabled),
      on: { click: () => toggleAgent(agent.id) },
    }, avatar(agent.id, 'sm')));
  }
  morph(box, nodes);
}

export function renderComposer(): void {
  renderAttachments();
  renderAgents();
  const mode = MODES.find((m) => m.key === state.config.ui.mode) ?? MODES[0];
  $('mode-label').textContent = mode.label;
  renderModeMenu();

  const prompt = $('prompt') as HTMLTextAreaElement;
  const hasText = prompt.value.trim().length > 0 || state.attachments.length > 0;
  ($('start-run') as HTMLButtonElement).disabled = state.running || !hasText;
  $('start-run').hidden = state.running;
  $('cancel-run').hidden = !state.running;

  const ready = agents().filter((a) => readiness(a).ok);
  $('status-line').textContent = state.running
    ? `${PHASE_LABEL[state.live?.phase ?? 'planning']}…`
    : !state.project
      ? L('Önce bir klasör seç', 'Pick a folder first')
      : ready.length
        ? L(`${ready.map((a) => a.label).join(' · ')} hazır`, `${ready.map((a) => a.label).join(' · ')} ready`)
        : L('Hazır ajan yok — soldan birini aç', 'No agent ready — turn one on from the sidebar');
  prompt.placeholder = state.running
    ? L('Konsey çalışıyor… Bu arada sağdaki masada konuşabilirsin.', 'Konsey is working… you can chat on the right meanwhile.')
    : state.project
      ? L('Konsey’e bir iş ver… (Enter gönderir, Shift+Enter yeni satır)', 'Give Konsey a task… (Enter sends, Shift+Enter for a new line)')
      : L('Önce bir proje klasörü seç, sonra işi yaz…', 'Pick a project folder first, then write the task…');
}

export function setupComposer(): void {
  register('composer', renderComposer);
  const prompt = $('prompt') as HTMLTextAreaElement;
  const form = $('composer') as HTMLFormElement;

  prompt.addEventListener('input', () => {
    autosize(prompt, 220);
    invalidate('composer');
  });
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = prompt.value.trim();
    if ((!text && !state.attachments.length) || state.running) return;
    const previous = prompt.value;
    prompt.value = '';
    autosize(prompt, 220);
    const ok = await startRun(text);
    if (!ok && !state.running) {
      prompt.value = previous;
      autosize(prompt, 220);
    }
    invalidate('composer');
  });

  $('cancel-run').addEventListener('click', () => {
    void api.cancelRun();
    toast(L('Durduruluyor…', 'Stopping…'), 1500);
  });

  $('attach-images').addEventListener('click', async () => {
    try {
      addAttachments(await api.pickImages());
    } catch (error) {
      toast(L(`Görsel eklenemedi: ${(error as Error).message}`, `Couldn’t add image: ${(error as Error).message}`));
    }
  });

  $('mode-button').addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = $('mode-menu');
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (event) => {
    const target = event.target as Node;
    if (!$('mode-menu').contains(target) && !$('mode-button').contains(target)) $('mode-menu').hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $('mode-menu').hidden = true;
      $('project-menu').hidden = true;
    }
  });

  let dragDepth = 0;
  form.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    form.classList.add('is-dragging');
  });
  form.addEventListener('dragover', (event) => event.preventDefault());
  form.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) form.classList.remove('is-dragging');
  });
  form.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    form.classList.remove('is-dragging');
    const paths = Array.from(event.dataTransfer?.files ?? []).map((file) => api.filePath(file)).filter(Boolean);
    if (paths.length) addAttachments(await api.imagesFromPaths(paths));
  });

  prompt.addEventListener('paste', async (event) => {
    const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    for (const file of images.slice(0, 8 - state.attachments.length)) {
      const imagePath = api.filePath(file);
      if (imagePath) addAttachments(await api.imagesFromPaths([imagePath]));
      else addAttachments([await api.saveImage({ name: file.name, mime: file.type, bytes: await file.arrayBuffer() })]);
    }
  });

  invalidate('composer');
}
