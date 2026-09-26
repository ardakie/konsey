/**
 * "Nasil calisir" tanitimi: ilk acilista kendiliginden, sonra kenar
 * cubugundaki dugmeyle acilir. Dort adim ve ajan baglama paneli.
 */
import { L } from '../../src/shared/i18n';
import { api } from './api';
import { connectPanel, loadConnect } from './connect';
import { h, icon, morph } from './dom';
import { invalidate, register, state } from './state';

const $ = (id: string) => document.getElementById(id)!;
const dialog = () => $('guide') as HTMLDialogElement;

function steps(): { icon: string; title: string; text: string }[] {
  return [
    {
      icon: 'folder',
      title: L('Bir klasör seç', 'Pick a folder'),
      text: L(
        'Boş ya da mevcut bir proje klasörü. Git deposu değilse Konsey ilk işte kendisi hazırlar.',
        'An empty or existing project folder. If it is not a git repository, Konsey prepares it on the first task.',
      ),
    },
    {
      icon: 'users',
      title: L('Ajanlarını bağla', 'Connect your agents'),
      text: L(
        'Claude Code, Codex, Gemini CLI gibi kodlama CLI’ları kendi aboneliğinle çalışır. İstersen API anahtarıyla ucuz modeller de ekle.',
        'Coding CLIs such as Claude Code, Codex and Gemini CLI run on your own subscription. You can also add cheap models with an API key.',
      ),
    },
    {
      icon: 'route',
      title: L('İşi yaz', 'Describe the work'),
      text: L(
        'Konsey işi planlar ve parçalara böler; her parçayı yapabilecek en ucuz ajana verir. Her ajan kendi kopyasında çalışır, birbirinin işini bozmaz.',
        'Konsey plans the work and splits it up, giving each part to the cheapest agent that can do it. Every agent works in its own copy, so they never collide.',
      ),
    },
    {
      icon: 'shield',
      title: L('Test edilir, uygulanır', 'Tested, then applied'),
      text: L(
        'Parçalar birleşir, testler çalışır, başka bir ajan inceler. Sonuç geçerse klasörüne uygulanır; her adımı akışta ve piksel ofiste izlersin.',
        'The parts are merged, tests run and another agent reviews. If it passes, the result is applied to your folder; you can follow every step in the flow and the pixel office.',
      ),
    },
  ];
}

function render(): void {
  if (!dialog().open) return;
  const body = $('guide-body');
  const nodes: Node[] = [
    h('div', { class: 'guide-steps', 'data-key': 'steps' }, ...steps().map((step, i) =>
      h('div', { class: 'guide-step' },
        h('span', { class: 'guide-num' }, String(i + 1)),
        h('span', { class: 'guide-icon' }, icon(step.icon)),
        h('div', { class: 'guide-title' }, step.title),
        h('div', { class: 'guide-text' }, step.text),
      ))),
    h('div', { class: 'guide-notes', 'data-key': 'notes' },
      h('div', { class: 'guide-note' }, icon('message'), h('span', null,
        h('b', null, L('Sohbet: ', 'Chat: ')),
        L('Sağdaki panelde ajanlarla tek tek ya da hep birlikte masada konuşursun. Sohbet dosyalarını değiştirmez; kod işi için “Göreve dönüştür”.',
          'In the right panel you talk to agents one by one or all together at the table. Chat never changes your files; use “Turn into task” for code work.'))),
      h('div', { class: 'guide-note' }, icon('key'), h('span', null,
        h('b', null, L('Gizlilik: ', 'Privacy: ')),
        L('Konsey’in sunucusu yok. Her şey bilgisayarında çalışır; kodun yalnızca bağladığın yapay zekâ hizmetlerine gider.',
          'Konsey has no servers. Everything runs on your computer; your code only goes to the AI services you connect.'))),
    ),
    connectPanel({ compact: true }),
  ];
  morph(body, nodes);
}

export function openGuide(): void {
  if (!dialog().open) dialog().showModal();
  void loadConnect(true);
  invalidate('guide');
}

async function closeGuide(): Promise<void> {
  dialog().close();
  if (!state.config.ui.onboarded) {
    state.config.ui.onboarded = true;
    await api.saveConfig(state.config);
  }
}

export function setupGuide(): void {
  register('guide', render);
  $('guide-close').addEventListener('click', () => void closeGuide());
  $('guide-start').addEventListener('click', () => void closeGuide());
  $('open-guide').addEventListener('click', openGuide);
  dialog().addEventListener('cancel', () => void closeGuide());
}
