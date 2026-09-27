/**
 * Hazirlik listesi (arayuz): git, Node.js, ajan oturumlari ve macOS izinleri.
 * Her eksik maddenin yaninda tek dugmelik cozum vardir; hata mesajlari da ayni
 * cozumlere baglanir, kullanici hicbir zaman ne yapacagini bilmeden kalmaz.
 */
import { L } from '../../src/shared/i18n';
import { api, type SetupCheck } from './api';
import { h, icon, toast } from './dom';
import { invalidate, state } from './state';

let checks: SetupCheck[] | null = null;
let loading: Promise<void> | null = null;

export function setupChecks(): SetupCheck[] {
  return checks ?? [];
}

export function loadSetup(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = api.setupChecks(state.project?.dir ?? null)
    .then((list) => {
      checks = list;
    })
    .catch(() => {
      checks = [];
    })
    .finally(() => {
      loading = null;
      invalidate('settings', 'guide', 'flow', 'chat');
    });
  return loading;
}

const FIX_NOTE: Record<string, () => string> = {
  'grant-terminal': () => L('macOS birazdan izin soracak: “Tamam”a bas.', 'macOS will ask in a moment: press “OK”.'),
  'open-automation': () => L('Ayarlar açıldı: Konsey’in altındaki “Terminal”i aç.', 'Settings opened: turn on “Terminal” under Konsey.'),
  'open-files': () => L('Ayarlar açıldı: Konsey’e klasör erişimini aç, sonra Konsey’e geri dön.', 'Settings opened: turn on folder access for Konsey, then come back.'),
  'install-git': () => L('Git kurulumu başladı. Bitince Konsey’i yeniden aç.', 'Git installation started. Reopen Konsey when it finishes.'),
  'install-node': () => L('Node.js kurulumu başladı. Bitince “Yeniden tara”ya bas.', 'Node.js installation started. Press “Rescan” when it finishes.'),
  'login-claude': () => L('Terminal’de Claude açıldı: tarayıcıdaki girişi tamamla.', 'Claude opened in Terminal: finish the sign-in in your browser.'),
  'login-codex': () => L('Terminal’de Codex girişi açıldı: tarayıcıdaki girişi tamamla.', 'Codex sign-in opened in Terminal: finish it in your browser.'),
};

/** Tek tikla cozum; bittiginde liste yeniden denetlenir. */
export async function runFix(id: string): Promise<void> {
  const note = FIX_NOTE[id]?.();
  if (note) toast(note, 6000);
  const res = await api.setupFix(id);
  if (!res.ok && res.error) toast(res.error, 7000);
  // Kullanici izin penceresiyle ilgilenirken durum birkac kez yenilenir.
  for (const delay of [800, 4000, 12000]) window.setTimeout(() => void loadSetup(true), delay);
}

/** Hata metnine gore onerilen cozum (ana surecteki fixForError ile ayni kurallar). */
export function fixForError(text: string, agent?: string): { id: string; label: string } | null {
  if (/operation not permitted|EPERM/i.test(text)) return { id: 'open-files', label: L('Klasör izni ver', 'Grant folder access') };
  if (/-1743|not allowed to send apple events/i.test(text)) return { id: 'open-automation', label: L('Terminal iznini aç', 'Allow Terminal') };
  if ((agent === 'claude' || agent === 'codex') && /log ?in|oturum|giriş|sign in|unauthori[sz]ed|401|credentials/i.test(text)) {
    return { id: `login-${agent}`, label: L('Giriş yap', 'Sign in') };
  }
  if (/git: command not found|spawn git ENOENT|'git' is not recognized/i.test(text)) return { id: 'install-git', label: L('Git’i kur', 'Install git') };
  return null;
}

/** Hata mesajinin altina konacak cozum dugmesi (yoksa null). */
export function fixButton(text: string, agent?: string): HTMLElement | null {
  const fix = fixForError(text, agent);
  if (!fix) return null;
  return h('button', { class: 'btn fix-btn', type: 'button', on: { click: () => void runFix(fix.id) } }, icon('bolt'), fix.label);
}

function row(check: SetupCheck): HTMLElement {
  const tone = check.state === 'ok' ? 'ok' : check.state === 'unknown' ? 'wait' : check.required ? 'bad' : 'warn';
  return h('div', { class: `setup-row is-${tone}`, 'data-key': `s-${check.id}` },
    h('span', { class: 'setup-dot' }, icon(check.state === 'ok' ? 'check' : check.state === 'unknown' ? 'gauge' : 'alert')),
    h('div', { class: 'connect-text' },
      h('div', { class: 'connect-name' }, check.title, check.required && check.state !== 'ok' ? h('span', { class: 'setup-req' }, L('gerekli', 'required')) : null),
      h('div', { class: 'setup-detail' }, check.detail),
    ),
    check.action
      ? h('button', { class: `btn ${check.required ? 'ink' : ''}`, type: 'button', on: { click: () => void runFix(check.action!.id) } }, check.action.label)
      : null,
  );
}

/** Hazirlik karti: ayarlarda ve "Nasil calisir" icinde gosterilir. */
export function setupPanel(): HTMLElement {
  if (!checks) void loadSetup();
  const list = checks ?? [];
  const pending = list.filter((c) => c.state !== 'ok').length;
  return h('div', { class: 'set-card setup', 'data-key': 'setup' },
    h('div', { class: 'row-between' },
      h('div', null,
        h('div', { class: 'set-card-title' }, L('Hazırlık ve izinler', 'Setup & permissions')),
        h('div', { class: 'set-card-sub' }, checks === null
          ? L('Denetleniyor…', 'Checking…')
          : pending
            ? L(`${pending} madde bekliyor. Her birinin yanındaki düğme işi senin yerine başlatır.`, `${pending} item(s) waiting. The button next to each one does the work for you.`)
            : L('Her şey hazır.', 'Everything is ready.')),
      ),
      h('button', { class: 'btn', type: 'button', on: { click: () => void loadSetup(true) } }, icon('refresh'), L('Yeniden denetle', 'Check again')),
    ),
    h('div', { class: 'connect-list' }, ...list.map(row)),
  );
}

/** Karsilama ekrani icin: isi engelleyen ilk sorun. */
export function blockingIssue(): SetupCheck | null {
  const list = setupChecks();
  return list.find((c) => c.required && (c.state === 'missing' || c.state === 'denied'))
    ?? list.find((c) => c.id.startsWith('login-') && c.state === 'missing')
    ?? list.find((c) => c.id === 'terminal' && c.state === 'denied')
    ?? null;
}
