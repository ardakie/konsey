/**
 * Sag panel: Konsey masasi (tum ajanlar sirayla konusur, is notlari da buraya duser)
 * ve her ajanla birebir sohbet.
 */
import { fixButton } from './setup';
import type { ChatMessage } from '../../src/shared/types';
import { api } from './api';
import { clearChat, draftTask, openChat, sendChat } from './actions';
import { autosize, clock, h, md, morph, toast } from './dom';
import { agents, avatar, invalidate, labelFor, readiness, register, state, type Thread } from './state';
import { L } from '../../src/shared/i18n';

const $ = (id: string) => document.getElementById(id)!;
/** Akan cevaplarin anlik metni (chat:delta). */
export const liveText = new Map<string, string>();

function renderTabs(): void {
  const tabs = $('chat-tabs');
  const nodes: Node[] = [];
  const all = agents();
  const councilAvatar = h('span', { class: 'avatar-stack' }, ...all.filter((a) => a.enabled).slice(0, 3).map((a) => avatar(a.id, 'xs')));
  const make = (thread: Thread, face: HTMLElement, name: string, off = false) =>
    h('button', {
      class: `chat-tab ${state.chatThread === thread ? 'is-on' : ''} ${off ? 'is-off' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': String(state.chatThread === thread),
      title: thread === 'council' ? L('Konsey masası: tüm açık ajanlar', 'Konsey table: all open agents') : L(`${name} ile birebir`, `One-on-one with ${name}`),
      on: { click: () => openChat(thread) },
    }, face, h('span', { class: 'chat-tab-name' }, name), state.unread.has(thread) ? h('span', { class: 'unread' }) : null);

  nodes.push(make('council', councilAvatar.childElementCount ? councilAvatar : avatar('orchestrator', 'sm'), L('Masa', 'Table')));
  for (const agent of all) {
    nodes.push(make(agent.id, avatar(agent.id, 'sm', state.chatBusy.has(agent.id)), agent.label, !readiness(agent).ok));
  }
  morph(tabs, nodes);
}

function renderIntro(): void {
  const intro = $('chat-intro');
  if (state.chatThread === 'council') {
    const active = agents().filter((a) => readiness(a).ok);
    intro.textContent = active.length
      ? L(
          `${active.map((a) => a.label).join(', ')} sırayla cevap verir. Görev sırasındaki notları da burada görürsün.`,
          `${active.map((a) => a.label).join(', ')} take turns answering. Notes from tasks in progress show up here too.`,
        )
      : L('Masada konuşabilecek açık ajan yok. Soldan bir ajanı aç.', 'No open agent is available to talk at the table. Open one on the left.');
  } else {
    const agent = agents().find((a) => a.id === state.chatThread);
    const ready = agent ? readiness(agent) : null;
    intro.textContent = agent
      ? L(`${agent.label} ile birebir · dosyaları okuyabilir, değiştirmez · ${ready?.text ?? ''}`, `One-on-one with ${agent.label} · can read files, won't change them · ${ready?.text ?? ''}`)
      : '';
  }
}

function message(m: ChatMessage, threadMessages: ChatMessage[]): HTMLElement {
  if (m.from === 'user') {
    return h('div', { class: 'msg user', 'data-key': m.id }, h('div', { class: 'msg-text' }, m.text));
  }
  const pendingText = liveText.get(m.id);
  const text = m.pending
    ? pendingText
      ? h('div', { class: 'msg-text shimmer' }, pendingText.replace(/^_|_$/g, ''))
      : h('span', { class: 'typing' }, h('i'), h('i'), h('i'))
    : h('div', { class: 'msg-text' }, m.kind === 'chat' ? md(m.text) : m.text);

  const actions = !m.pending && m.kind === 'chat' && m.from !== 'orchestrator'
    ? h('div', { class: 'msg-actions' },
        h('button', {
          class: 'msg-action',
          type: 'button',
          on: {
            click: () => {
              void navigator.clipboard.writeText(m.text);
              toast(L('Kopyalandı', 'Copied'), 1200);
            },
          },
        }, L('Kopyala', 'Copy')),
        h('button', {
          class: 'msg-action',
          type: 'button',
          title: L('Bu öneriyi Konsey görevine çevir', 'Turn this suggestion into a Konsey task'),
          on: {
            click: () => {
              const index = threadMessages.indexOf(m);
              const question = [...threadMessages.slice(0, index)].reverse().find((x) => x.from === 'user');
              draftTask(`${question?.text ?? ''}\n\n${L(`${labelFor(m.from)} önerisi:`, `${labelFor(m.from)}'s suggestion:`)}\n${m.text}`.trim());
            },
          },
        }, L('Göreve dönüştür', 'Turn into task')),
        state.chatThread === 'council'
          ? h('button', { class: 'msg-action', type: 'button', on: { click: () => openChat(m.from as Thread) } }, L('Birebir sor', 'Ask one-on-one'))
          : null,
      )
    : null;

  return h('div', { class: `msg ${m.kind}`, 'data-key': m.id },
    avatar(m.from, 'sm', Boolean(m.pending)),
    h('div', { style: { minWidth: '0' } },
      h('div', { class: 'msg-head' },
        h('span', { class: 'msg-name' }, labelFor(m.from)),
        h('span', { class: 'msg-time' }, clock(m.at)),
        m.kind === 'run' ? h('span', { class: 'msg-tag' }, L('iş notu', 'work note')) : null,
      ),
      text,
      actions,
      // Hata mesajlarinin altinda tek tikla cozum (giris yap, izin ver...).
      !m.pending && m.kind !== 'chat' ? fixButton(m.text, String(m.from)) : null,
    ),
  );
}

function empty(): HTMLElement {
  const council = state.chatThread === 'council';
  const faces = council
    ? agents().filter((a) => a.enabled).slice(0, 4).map((a) => avatar(a.id))
    : [avatar(state.chatThread, 'lg')];
  return h('div', { class: 'chat-empty', 'data-key': `empty-${state.chatThread}` },
    h('span', { class: 'avatar-stack' }, ...faces),
    h('div', { class: 'chat-empty-title' }, council ? L('Konsey masası', 'Konsey table') : L(`${labelFor(state.chatThread)} ile konuş`, `Talk to ${labelFor(state.chatThread)}`)),
    h('div', { class: 'small' }, council
      ? L('Bir soru sor ya da bir fikir at; açık ajanlar sırayla cevaplar, birbirlerine katılır ya da itiraz eder.', 'Ask a question or toss out an idea; open agents take turns answering, agreeing or pushing back on each other.')
      : L('Kod hakkında soru sor, fikir al. Yazdırmak istediğin bir şey olursa “Göreve dönüştür” de.', 'Ask about the code, get ideas. If something is worth writing, hit "Turn into task".')),
  );
}

export function renderChat(): void {
  const stage = document.querySelector('.stage')!;
  stage.classList.toggle('chat-closed', !state.config.ui.chatOpen);
  $('chat-toggle').classList.toggle('is-on', state.config.ui.chatOpen);

  $('side-chat').classList.toggle('is-on', state.sidePane === 'chat');
  $('side-preview').classList.toggle('is-on', state.sidePane === 'preview');
  $('chat-pane').hidden = state.sidePane !== 'chat';
  $('preview-panel').hidden = state.sidePane !== 'preview';
  $('chat-clear').hidden = state.sidePane !== 'chat';

  renderTabs();
  renderIntro();

  const scroller = $('chat-scroll');
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const list = $('chat-messages');
  const messages = state.chats[state.chatThread] ?? [];
  morph(list, messages.length ? messages.slice(-160).map((m) => message(m, messages)) : [empty()]);
  if (nearBottom || lastThread !== state.chatThread) scroller.scrollTop = scroller.scrollHeight;
  lastThread = state.chatThread;

  const busy = state.chatBusy.has(state.chatThread);
  $('chat-stop').hidden = !busy;
  $('chat-send').hidden = busy;
  const input = $('chat-input') as HTMLTextAreaElement;
  input.placeholder = state.chatThread === 'council' ? L('Masaya yaz…', 'Write to the table…') : L(`${labelFor(state.chatThread)}’a sor…`, `Ask ${labelFor(state.chatThread)}…`);
}
let lastThread = '';

export function setupChat(): void {
  register('chat', renderChat);
  const input = $('chat-input') as HTMLTextAreaElement;
  input.addEventListener('input', () => autosize(input, 140));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      ($('chat-form') as HTMLFormElement).requestSubmit();
    }
  });
  $('chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize(input, 140);
    void sendChat(text);
  });
  $('chat-stop').addEventListener('click', () => void api.cancelChat(state.chatThread));
  $('chat-clear').addEventListener('click', () => {
    if ((state.chats[state.chatThread] ?? []).length && confirm(L('Bu sohbetin geçmişi silinsin mi?', 'Delete this chat history?'))) void clearChat();
  });
  $('chat-toggle').addEventListener('click', () => {
    state.config.ui.chatOpen = !state.config.ui.chatOpen;
    void api.saveConfig(state.config);
    invalidate('chat');
  });
  $('side-chat').addEventListener('click', () => {
    state.sidePane = 'chat';
    state.unread.delete(state.chatThread);
    invalidate('chat');
  });
  $('side-preview').addEventListener('click', () => {
    state.sidePane = 'preview';
    invalidate('chat');
  });
  invalidate('chat');
}
