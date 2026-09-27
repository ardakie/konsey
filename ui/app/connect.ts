/**
 * Ajan baglama paneli: hangi CLI'larin kurulu oldugunu gosterir; kurulu
 * olmayanlar tek tikla terminalde kurulur, kurulu olanlarda hesaba giris
 * acilir. Kullanici kendi CLI'ini da komutuyla ekleyebilir.
 */
import type { AgentProfile } from '../../src/shared/types';
import { L } from '../../src/shared/i18n';
import { api, type ConnectEntry } from './api';
import { refreshAgents, refreshQuotas } from './actions';
import { h, icon, toast } from './dom';
import { avatar, invalidate, state } from './state';
import { runFix } from './setup';

let entries: ConnectEntry[] | null = null;
let loading: Promise<void> | null = null;

/** Kurulu CLI listesini (yeniden) okur. */
export function loadConnect(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = api.connectList()
    .then((list) => {
      entries = list;
    })
    .catch(() => {
      entries = [];
    })
    .finally(() => {
      loading = null;
      invalidate('settings', 'guide');
    });
  return loading;
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(L('Komut kopyalandı', 'Command copied'), 1500);
  } catch {
    toast(text, 6000);
  }
}

async function run(entry: ConnectEntry, action: 'install' | 'login'): Promise<void> {
  const res = await api.connectRun(entry.id, action);
  if (!res.ok) {
    toast(res.error ?? L('Açılamadı', 'Could not open'), 8000);
    // Izin reddedildiyse dogru Ayarlar sayfasi kendiliginden acilir.
    if (res.fix) void runFix(res.fix);
    return;
  }
  if (res.opened === 'docs') return;
  toast(action === 'install'
    ? L(`${entry.label} kurulumu terminalde başladı. Bitince “Yeniden tara”ya bas.`, `${entry.label} is installing in the terminal. Press “Rescan” when it finishes.`)
    : L(`${entry.label} girişi terminalde açıldı. Hesabınla giriş yapıp terminali kapatabilirsin.`, `${entry.label} sign-in opened in the terminal. Sign in, then close the terminal.`), 6000);
}

function row(entry: ConnectEntry): HTMLElement {
  const command = entry.installed ? entry.login : entry.install;
  return h('div', { class: `connect-row ${entry.installed ? 'is-ready' : ''}`, 'data-key': `c-${entry.id}` },
    avatar(entry.id, 'sm'),
    h('div', { class: 'connect-text' },
      h('div', { class: 'connect-name' }, entry.label),
      h('div', { class: 'connect-sub' },
        entry.installed
          ? h('span', { class: 'connect-ok' }, icon('check'), L('Kurulu', 'Installed'))
          : L('Kurulu değil', 'Not installed'),
        command ? h('code', null, command) : null,
      ),
    ),
    h('div', { class: 'connect-actions' },
      command
        ? h('button', { class: 'icon-btn xs', type: 'button', title: L('Komutu kopyala', 'Copy command'), on: { click: () => void copy(command) } }, icon('copy'))
        : null,
      h('button', { class: 'icon-btn xs', type: 'button', title: L('Belgeler', 'Docs'), on: { click: () => void api.openExternal(entry.docs) } }, icon('external')),
      entry.installed
        ? entry.login
          ? h('button', { class: 'btn', type: 'button', on: { click: () => void run(entry, 'login') } }, icon('key'), L('Giriş yap', 'Sign in'))
          : null
        : h('button', { class: 'btn ink', type: 'button', on: { click: () => void run(entry, 'install') } },
            icon('play'), entry.install ? L('Kur', 'Install') : L('İndir', 'Download')),
    ),
  );
}

/** Kurulu ve kurulabilir ajanlarin listesi. */
export function connectPanel(opts: { compact?: boolean } = {}): HTMLElement {
  if (!entries) void loadConnect();
  const list = entries ?? [];
  const installed = list.filter((e) => e.installed);
  const others = list.filter((e) => !e.installed);
  const shown = opts.compact ? [...installed, ...others.slice(0, Math.max(0, 5 - installed.length))] : [...installed, ...others];

  return h('div', { class: 'set-card connect', 'data-key': 'connect' },
    h('div', { class: 'row-between' },
      h('div', null,
        h('div', { class: 'set-card-title' }, L('Ajanları bağla', 'Connect agents')),
        h('div', { class: 'set-card-sub' }, L(
          'Konsey bilgisayarındaki kodlama CLI’larını kendiliğinden bulur. Kurulu olmayanı “Kur” ile terminalde kurabilir, sonra “Giriş yap” ile kendi hesabını bağlayabilirsin.',
          'Konsey finds the coding CLIs on your computer automatically. Install missing ones with “Install”, then link your own account with “Sign in”.',
        )),
      ),
      h('button', {
        class: 'btn',
        type: 'button',
        on: {
          click: async (event: MouseEvent) => {
            const button = event.currentTarget as HTMLButtonElement;
            button.disabled = true;
            await Promise.all([loadConnect(true), refreshAgents()]);
            await refreshQuotas();
            button.disabled = false;
            toast(L('Ajanlar yeniden tarandı', 'Agents rescanned'), 1500);
          },
        },
      }, icon('refresh'), L('Yeniden tara', 'Rescan')),
    ),
    entries === null
      ? h('div', { class: 'small muted' }, L('Taranıyor…', 'Scanning…'))
      : h('div', { class: 'connect-list' }, ...shown.map(row)),
    opts.compact ? null : customCliForm(),
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'cli';
}

/** Kullanicinin kendi CLI'i: komut ve arguman satiri. */
function customCliForm(): HTMLElement {
  const name = h('input', { placeholder: 'My Agent' }) as HTMLInputElement;
  const command = h('input', { placeholder: 'my-agent' }) as HTMLInputElement;
  const args = h('input', { placeholder: 'run --yes {prompt}' }) as HTMLInputElement;
  const result = h('span', { class: 'form-result' });
  const field = (label: string, input: HTMLElement) => h('label', { class: 'field' }, label, input);

  return h('details', { class: 'custom-cli' },
    h('summary', null, icon('plus'), L('Kendi CLI’ını ekle', 'Add your own CLI')),
    h('div', { class: 'small muted' }, L(
      'Etkileşimsiz çalışabilen her komut olur. Argümanlarda {prompt} istemin yeridir; yoksa istem stdin’den verilir. {model} isteğe bağlıdır.',
      'Any command that can run non-interactively works. {prompt} marks where the prompt goes in the arguments; without it the prompt is sent on stdin. {model} is optional.',
    )),
    h('div', { class: 'field-row' }, field(L('Ad', 'Name'), name), field(L('Komut', 'Command'), command)),
    field(L('Argümanlar', 'Arguments'), args),
    h('div', { class: 'set-actions' },
      result,
      h('button', {
        class: 'btn ink',
        type: 'button',
        on: {
          click: async () => {
            const label = name.value.trim();
            const cmd = command.value.trim();
            if (!label || !cmd) {
              result.className = 'form-result bad';
              result.textContent = L('Ad ve komut gerekli.', 'Name and command are required.');
              return;
            }
            let id = `cli:custom-${slug(label)}`;
            let n = 2;
            while (state.config.profiles.some((p) => p.agent === id)) id = `cli:custom-${slug(label)}-${n++}`;
            const profile: AgentProfile = {
              agent: id as AgentProfile['agent'],
              label,
              strengths: L('Genel kodlama işleri.', 'General coding tasks.'),
              enabled: true,
              costTier: 'standard',
              cli: { command: cmd, args: args.value.trim() },
            };
            state.config.profiles = [...state.config.profiles, profile];
            await api.saveConfig(state.config);
            await Promise.all([refreshAgents(), refreshQuotas()]);
            name.value = command.value = args.value = '';
            result.className = 'form-result ok';
            result.textContent = L(`${label} eklendi.`, `${label} added.`);
            invalidate('settings');
          },
        },
      }, icon('plus'), L('Ekle', 'Add')),
    ),
  );
}

/** Ek CLI ajanini listeden kaldirir; otomatik kesif onu geri eklemez. */
export async function removeCliAgent(id: string): Promise<void> {
  state.config.profiles = state.config.profiles.filter((p) => p.agent !== id);
  const preset = id.startsWith('cli:') && !id.startsWith('cli:custom-') ? id.slice(4) : null;
  if (preset) state.config.dismissedClis = [...new Set([...(state.config.dismissedClis ?? []), preset])];
  await api.saveConfig(state.config);
  await Promise.all([refreshAgents(), refreshQuotas()]);
  invalidate('settings', 'sidebar', 'composer', 'chat');
}
