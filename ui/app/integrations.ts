/**
 * Ayarlar → Entegrasyonlar: GitHub, Supabase, Sentry, Stripe, PostHog,
 * Notion ve ozel MCP sunuculari. Kullanici token'i bir kez girer; token
 * sistemin guvenli deposuna gider ve arayuze bir daha gelmez.
 */
import { L } from '../../src/shared/i18n';
import { api, type IntegrationEntry } from './api';
import { h, icon, toast } from './dom';
import { invalidate } from './state';

let entries: IntegrationEntry[] | null = null;
let loading = false;

async function load(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    entries = await api.integrations();
  } catch {
    entries = [];
  } finally {
    loading = false;
    invalidate('settings');
  }
}

function engineNote(entry: IntegrationEntry): string {
  return entry.engines.includes('codex')
    ? L('Claude ve Codex kullanır', 'Used by Claude and Codex')
    : L('Claude kullanır', 'Used by Claude');
}

function card(entry: IntegrationEntry): HTMLElement {
  const connected = entry.enabled && entry.hasToken || entry.custom && entry.enabled;
  const token = h('input', { type: 'password', placeholder: entry.hasToken ? L('Kayıtlı · değiştirmek için yeni token yaz', 'Saved · type a new token to replace') : entry.tokenHint || 'token' }) as HTMLInputElement;
  const result = h('span', { class: 'form-result' });
  let readOnly = entry.readOnly;
  const readOnlySwitch = entry.supportsReadOnly
    ? h('button', {
        class: 'switch',
        type: 'button',
        role: 'switch',
        'aria-checked': String(readOnly),
        'aria-label': L('Salt okunur', 'Read-only'),
        on: {
          click: async (event: MouseEvent) => {
            readOnly = !readOnly;
            (event.currentTarget as HTMLElement).setAttribute('aria-checked', String(readOnly));
            if (entry.hasToken) {
              await api.saveIntegration({ id: entry.id, readOnly });
              void load();
            }
          },
        },
      })
    : null;

  const save = async () => {
    result.className = 'form-result';
    result.textContent = L('Deneniyor…', 'Testing…');
    if (token.value.trim()) {
      const test = await api.testIntegration(entry.id, token.value.trim());
      if (!test.ok) {
        result.className = 'form-result bad';
        result.textContent = test.detail;
        return;
      }
    }
    const res = await api.saveIntegration({ id: entry.id, token: token.value.trim() || undefined, readOnly, enabled: true });
    if (!res.ok) {
      result.className = 'form-result bad';
      result.textContent = res.error ?? '';
      return;
    }
    toast(L(`${entry.label} bağlandı`, `${entry.label} connected`), 1800);
    void load();
  };

  return h('div', { class: `set-card integration ${connected ? '' : 'is-off'}`, 'data-key': `int-${entry.id}` },
    h('div', { class: 'set-card-head' },
      h('span', { class: 'int-mark' }, entry.label.slice(0, 1)),
      h('div', { style: { minWidth: '0' } },
        h('div', { class: 'set-card-title' }, entry.label,
          connected ? h('span', { class: 'connect-ok', style: { marginLeft: '8px' } }, icon('check'), L('Bağlı', 'Connected')) : null),
        h('div', { class: 'set-card-sub' }, `${entry.blurb} · ${engineNote(entry)}`),
      ),
      entry.hasToken || entry.custom
        ? h('button', {
            class: 'switch',
            type: 'button',
            role: 'switch',
            'aria-checked': String(entry.enabled),
            'aria-label': L(`${entry.label} açık/kapalı`, `${entry.label} on/off`),
            on: {
              click: async () => {
                await api.saveIntegration({ id: entry.id, enabled: !entry.enabled });
                void load();
              },
            },
          })
        : null,
    ),
    entry.custom
      ? null
      : h('div', { class: 'field-row' },
          h('label', { class: 'field' }, L('Token', 'Token'), token),
          readOnlySwitch
            ? h('label', { class: 'inline-field', style: { alignSelf: 'end' } }, readOnlySwitch, L('Salt okunur', 'Read-only'))
            : null,
        ),
    h('div', { class: 'set-actions' },
      result,
      entry.tokenUrl
        ? h('button', { class: 'btn ghost', type: 'button', on: { click: () => void api.openExternal(entry.tokenUrl) } }, icon('external'), L('Token al', 'Get a token'))
        : null,
      entry.hasToken
        ? h('button', {
            class: 'btn',
            type: 'button',
            on: {
              click: async () => {
                const test = await api.testIntegration(entry.id);
                result.className = `form-result ${test.ok ? 'ok' : 'bad'}`;
                result.textContent = test.detail;
              },
            },
          }, L('Test et', 'Test'))
        : null,
      entry.hasToken || entry.custom
        ? h('button', {
            class: 'btn danger',
            type: 'button',
            on: {
              click: async () => {
                if (!confirm(L(`${entry.label} bağlantısı ve token’ı kaldırılsın mı?`, `Remove the ${entry.label} connection and its token?`))) return;
                await api.removeIntegration(entry.id);
                void load();
              },
            },
          }, icon('trash'), L('Kaldır', 'Remove'))
        : null,
      entry.custom ? null : h('button', { class: 'btn ink', type: 'button', on: { click: () => void save() } }, icon('plus'), entry.hasToken ? L('Kaydet', 'Save') : L('Bağla', 'Connect')),
    ),
  );
}

function customForm(): HTMLElement {
  const name = h('input', { placeholder: 'Linear' }) as HTMLInputElement;
  const url = h('input', { placeholder: 'https://mcp.example.com/mcp' }) as HTMLInputElement;
  const token = h('input', { type: 'password', placeholder: L('İsteğe bağlı', 'Optional') }) as HTMLInputElement;
  const result = h('span', { class: 'form-result' });
  return h('details', { class: 'set-card custom-cli', 'data-key': 'int-custom' },
    h('summary', null, icon('plus'), L('Özel MCP sunucusu ekle', 'Add a custom MCP server')),
    h('div', { class: 'small muted' }, L(
      'Uzak (HTTP) bir MCP sunucusu. Token verirsen “Authorization: Bearer” başlığıyla gönderilir.',
      'A remote (HTTP) MCP server. If you give a token it is sent as an “Authorization: Bearer” header.',
    )),
    h('div', { class: 'field-row' }, h('label', { class: 'field' }, L('Ad', 'Name'), name), h('label', { class: 'field' }, 'URL', url)),
    h('label', { class: 'field' }, 'Token', token),
    h('div', { class: 'set-actions' },
      result,
      h('button', {
        class: 'btn ink',
        type: 'button',
        on: {
          click: async () => {
            const label = name.value.trim();
            const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
            if (!label || !slug) {
              result.className = 'form-result bad';
              result.textContent = L('Ad gerekli.', 'A name is required.');
              return;
            }
            const res = await api.saveIntegration({ id: `custom-${slug}`, label, url: url.value.trim(), token: token.value.trim() || undefined, enabled: true });
            if (!res.ok) {
              result.className = 'form-result bad';
              result.textContent = res.error ?? '';
              return;
            }
            toast(L(`${label} eklendi`, `${label} added`), 1800);
            void load();
          },
        },
      }, icon('plus'), L('Ekle', 'Add')),
    ),
  );
}

export function integrationsTab(body: HTMLElement): void {
  if (!entries) void load();
  body.append(h('p', { class: 'set-intro', 'data-key': 'int-intro' }, L(
    'Servisleri bir kez bağla; ajanlar işi gerektirdiğinde bu servislere kendileri bakar: “Sentry’deki son hataları incele ve düzelt”, “GitHub’daki açık issue’ları özetle” gibi. Token’lar sistemin güvenli deposunda durur, ayar dosyasına yazılmaz. GitHub ve Supabase varsayılan olarak salt okunur bağlanır.',
    'Connect services once; agents look at them on their own when the work needs it — “check the latest Sentry errors and fix them”, “summarize the open GitHub issues”. Tokens are kept in the system’s secure storage, never in the settings file. GitHub and Supabase connect read-only by default.',
  )));
  if (!entries) {
    body.append(h('div', { class: 'small muted', 'data-key': 'int-loading' }, L('Yükleniyor…', 'Loading…')));
    return;
  }
  for (const entry of entries) body.append(card(entry));
  body.append(customForm());
}
