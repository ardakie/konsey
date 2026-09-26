/**
 * Ayarlar: ajanlarin acik/kapali durumu, hesap limitinin yuzde kacinin
 * kullanilabilecegi, API saglayicilari ve genel tercihler.
 */
import type { AgentId, ProviderConfig } from '../../src/shared/types';
import { api } from './api';
import { refreshAgents, refreshQuotas, saveConfig, toggleAgent } from './actions';
import { h, icon, morph, toast, tokens, until } from './dom';
import { agents, avatar, invalidate, readiness, register, state, type AgentView } from './state';
import { connectPanel, removeCliAgent } from './connect';
import { L } from '../../src/shared/i18n';

const $ = (id: string) => document.getElementById(id)!;
const dialog = () => $('settings') as HTMLDialogElement;

const DEFAULT_PROVIDER_BUDGET = 2_000_000;
const DEFAULT_AG_TURNS = 40;

function capOf(agent: AgentView): number {
  const profile = state.config.profiles.find((p) => p.agent === agent.id);
  const provider = state.config.providers.find((p) => `provider:${p.slug}` === agent.id);
  return Math.round(profile?.usageCapPercent ?? provider?.usageCapPercent ?? 100);
}

function setCap(id: AgentId, value: number): void {
  const cap = Math.min(100, Math.max(1, Math.round(value)));
  const profile = state.config.profiles.find((p) => p.agent === id);
  if (profile) profile.usageCapPercent = cap;
  const provider = state.config.providers.find((p) => `provider:${p.slug}` === id);
  if (provider) provider.usageCapPercent = cap;
}

let quotaTimer = 0;
function persistCaps(): void {
  void saveConfig().then(() => {
    window.clearTimeout(quotaTimer);
    quotaTimer = window.setTimeout(() => void refreshQuotas(), 150);
  });
}

function windowLabel(key: 'five_hour' | 'seven_day' | 'daily'): string {
  if (key === 'five_hour') return L('5 saatlik', '5-hour');
  if (key === 'seven_day') return L('Haftalık', 'Weekly');
  return L('Günlük bütçe', 'Daily budget');
}

function windowCard(key: 'five_hour' | 'seven_day' | 'daily', used: number, cap: number, resetsAt?: number): HTMLElement {
  const tone = used >= cap ? 'bad' : used >= cap * 0.8 ? 'warn' : '';
  return h('div', { class: 'window' },
    h('div', { class: 'window-top' }, h('span', null, windowLabel(key)), h('b', null, `%${Math.round(used * 10) / 10}`)),
    h('div', { class: 'meter' },
      h('div', { class: `meter-fill ${tone}`, style: { width: `${Math.min(100, used)}%` } }),
      cap < 100 ? h('div', { class: 'meter-cap', style: { left: `calc(${cap}% - 1px)` } }) : null,
    ),
    h('div', { class: 'window-reset' }, resetsAt ? L(`Yenilenme: ${until(resetsAt)}`, `Resets: ${until(resetsAt)}`) : ''),
  );
}

function sourceNote(agent: AgentView): string {
  const source = agent.quota?.source;
  if (agent.id === 'claude') {
    return source === 'unknown'
      ? L('Claude limiti ilk çağrıda ölçülür.', 'The Claude limit is measured on the first call.')
      : L('Claude CLI’nin bildirdiği hesap limiti (5 saatlik ve haftalık).', 'Account limit reported by the Claude CLI (5-hour and weekly).');
  }
  if (agent.id === 'codex') {
    return source === 'unknown'
      ? L('Codex limiti ilk çağrıdan sonra görünür.', 'The Codex limit appears after the first call.')
      : L('Codex oturum kayıtlarındaki hesap limiti (5 saatlik ve haftalık).', 'Account limit from Codex session logs (5-hour and weekly).');
  }
  if (agent.id === 'antigravity') return L('Antigravity limit bildirmez; Konsey kendi günlük tur bütçesini sayar.', 'Antigravity does not report limits; Konsey counts its own daily turn budget.');
  if (agent.kind === 'cli') return L(`${agent.label} limit bildirmez; Konsey kendi günlük tur bütçesini sayar.`, `${agent.label} does not report limits; Konsey counts its own daily turn budget.`);
  return L('API sağlayıcıları limit bildirmez; Konsey kendi günlük token bütçesini sayar.', 'API providers do not report limits; Konsey counts its own daily token budget.');
}

function agentCard(agent: AgentView): HTMLElement {
  const cap = capOf(agent);
  const quota = agent.quota;
  const used = quota?.usedPercent ?? null;
  const ready = readiness(agent);
  const usage = state.usage.find((u) => u.agent === agent.id);

  const value = h('span', { class: 'cap-value' }, `%${cap}`);
  const slider = h('input', {
    type: 'range',
    min: '1',
    max: '100',
    step: '1',
    value: String(cap),
    'aria-label': L(`${agent.label} için izin verilen kullanım yüzdesi`, `Allowed usage percentage for ${agent.label}`),
  }) as HTMLInputElement;
  slider.style.setProperty('--p', `${cap}%`);
  const help = h('div', { class: 'cap-help' });
  const describe = (c: number) => {
    help.textContent = used === null
      ? L(`Konsey bu ajanın limitinin en fazla %${c}’ini kullanır.`, `Konsey uses at most ${c}% of this agent’s limit.`)
      : used >= c
        ? L(
            `Şu an %${used} kullanılmış — pay dolu, Konsey bu ajanı çağırmaz${quota?.unlocksAt ? ` (${until(quota.unlocksAt)} açılır)` : ''}.`,
            `${used}% used right now — share is full, Konsey won’t call this agent${quota?.unlocksAt ? ` (opens ${until(quota.unlocksAt)})` : ''}.`,
          )
        : L(
            `Şu an %${used} kullanılmış · Konsey’in kullanabileceği kalan pay: %${Math.round((c - used) * 10) / 10}.`,
            `${used}% used right now · remaining share Konsey can use: ${Math.round((c - used) * 10) / 10}%.`,
          );
  };
  describe(cap);
  slider.addEventListener('input', () => {
    const next = Number(slider.value);
    value.textContent = `%${next}`;
    slider.style.setProperty('--p', `${next}%`);
    setCap(agent.id, next);
    describe(next);
  });
  slider.addEventListener('change', persistCaps);

  const provider = state.config.providers.find((p) => `provider:${p.slug}` === agent.id);
  const profile = state.config.profiles.find((p) => p.agent === agent.id);
  let budget: HTMLElement | null = null;
  if (provider || agent.id === 'antigravity' || agent.kind === 'cli') {
    const input = h('input', {
      type: 'number',
      min: '1',
      value: String(provider ? provider.dailyTokenBudget ?? DEFAULT_PROVIDER_BUDGET : profile?.dailyTurnBudget ?? DEFAULT_AG_TURNS),
    }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const n = Math.max(1, Math.round(Number(input.value) || 1));
      if (provider) provider.dailyTokenBudget = n;
      else if (profile) profile.dailyTurnBudget = n;
      persistCaps();
    });
    budget = h('label', { class: 'inline-field' }, provider ? L('Günlük token limiti', 'Daily token limit') : L('Günlük tur limiti', 'Daily turn limit'), input);
  }

  const windows = quota?.windows.length
    ? h('div', { class: 'windows' }, ...quota.windows.map((w) => windowCard(w.key, w.usedPercent, cap, w.resetsAt)))
    : h('div', { class: 'small muted' }, L('Henüz ölçüm yok.', 'No measurement yet.'));

  return h('div', { class: `set-card ${agent.enabled ? '' : 'is-off'}` },
    h('div', { class: 'set-card-head' },
      avatar(agent.id, 'lg'),
      h('div', null,
        h('div', { class: 'set-card-title' }, agent.label),
        h('div', { class: 'set-card-sub' }, agent.available ? ready.text : agent.detail),
      ),
      h('button', {
        class: 'switch',
        type: 'button',
        role: 'switch',
        'aria-checked': String(agent.enabled),
        'aria-label': L(`${agent.label} açık/kapalı`, `${agent.label} on/off`),
        on: { click: () => toggleAgent(agent.id) },
      }),
    ),
    h('div', { class: 'cap-row' },
      h('span', { class: 'cap-label' }, L('Limitin en fazla ne kadarını kullansın?', 'How much of the limit should it use at most?')),
      value,
      slider,
      help,
    ),
    windows,
    h('div', { class: 'row-between' },
      h('div', { class: 'stats' },
        h('span', null, L('Bugün ', 'Today '), h('b', null, String(usage?.today.calls ?? 0)), L(' çağrı · ', ' calls · '), h('b', null, tokens(usage?.today.tokens ?? 0)), ' token'),
        h('span', null, L('Toplam ', 'Total '), h('b', null, String(usage?.total.calls ?? 0)), L(' çağrı · ', ' calls · '), h('b', null, tokens(usage?.total.tokens ?? 0)), ' token'),
        usage?.total.costUsd ? h('span', null, L('Liste fiyatıyla ≈ ', 'At list price ≈ '), h('b', null, `$${usage.total.costUsd.toFixed(2)}`)) : null,
      ),
      budget,
    ),
    h('div', { class: 'row-between' },
      h('div', { class: 'small muted' }, sourceNote(agent)),
      agent.kind === 'cli'
        ? h('button', {
            class: 'btn danger',
            type: 'button',
            on: {
              click: () => {
                if (confirm(L(`${agent.label} ajan listesinden kaldırılsın mı?`, `Remove ${agent.label} from the agent list?`))) void removeCliAgent(agent.id);
              },
            },
          }, icon('trash'), L('Kaldır', 'Remove'))
        : null,
    ),
  );
}

function agentsTab(body: HTMLElement): void {
  body.append(
    h('p', { class: 'set-intro' },
      L(
        'Her ajan için hesap limitinin en fazla yüzde kaçını Konsey’in kullanabileceğini seç. Kullanım bu payı geçince Konsey o ajanı çağırmaz; işi açık kalan diğer ajanlara verir. Kalan kısım senin kendi Claude/Codex kullanımına kalır.',
        'For each agent, choose the maximum percentage of the account limit Konsey may use. Once usage passes this share, Konsey stops calling that agent and hands the work to others left on. The rest stays for your own Claude/Codex usage.',
      )),
    h('div', { class: 'row-between' },
      h('div', { class: 'inline-field' },
        L('Hepsini ayarla:', 'Set all:'),
        ...[1, 25, 50, 80, 100].map((n) => h('button', {
          class: 'btn',
          type: 'button',
          on: {
            click: () => {
              for (const a of agents()) setCap(a.id, n);
              persistCaps();
              invalidate('settings');
              toast(L(`Tüm ajanlar için pay %${n}`, `${n}% share for all agents`), 1600);
            },
          },
        }, `%${n}`)),
      ),
      h('button', {
        class: 'btn',
        type: 'button',
        on: {
          click: async (event: MouseEvent) => {
            const button = event.currentTarget as HTMLButtonElement;
            button.disabled = true;
            button.lastChild!.textContent = L('Ölçülüyor…', 'Measuring…');
            await Promise.all([refreshQuotas(true), refreshAgents()]);
            toast(L('Limitler güncellendi', 'Limits updated'), 1500);
          },
        },
      }, icon('refresh'), L('Limitleri ölç', 'Measure limits')),
    ),
  );
  for (const agent of agents()) body.append(agentCard(agent));
  body.append(connectPanel());
}

function slugify(label: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' };
  return label
    .toLocaleLowerCase('tr-TR')
    .replace(/[çğıöşü]/g, (c) => map[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'saglayici';
}

function providersTab(body: HTMLElement): void {
  body.append(h('p', { class: 'set-intro' },
    L('OpenAI uyumlu kendi uçların (OpenRouter, DeepSeek, GLM…). Basit işler önce bu ucuz ajanlara gider. Anahtarlar sistemin güvenli deposunda saklanır, ayar dosyasına yazılmaz.', 'Your own OpenAI-compatible endpoints (OpenRouter, DeepSeek, GLM…). Simple work goes to these cheap agents first. Keys are kept in the system’s secure storage, never in the settings file.')));

  for (const provider of state.config.providers) {
    const id = `provider:${provider.slug}` as AgentId;
    const view = agents().find((a) => a.id === id);
    body.append(h('div', { class: 'set-card' },
      h('div', { class: 'set-card-head' },
        avatar(id, 'lg'),
        h('div', { style: { minWidth: '0' } },
          h('div', { class: 'set-card-title' }, provider.label),
          h('div', { class: 'set-card-sub' }, L(
            `${provider.model} · ${provider.canWriteCode ? 'kod yazar' : 'yalnızca planlama/inceleme'} · ${view?.available ? 'anahtar hazır' : 'anahtar yok'}`,
            `${provider.model} · ${provider.canWriteCode ? 'writes code' : 'planning/review only'} · ${view?.available ? 'key ready' : 'no key'}`,
          )),
        ),
        h('button', {
          class: 'switch',
          type: 'button',
          role: 'switch',
          'aria-checked': String(provider.enabled),
          on: { click: () => toggleAgent(id) },
        }),
      ),
      h('div', { class: 'set-actions' },
        h('span', { class: 'form-result' }, provider.baseUrl),
        h('button', {
          class: 'btn',
          type: 'button',
          on: {
            click: async () => {
              const res = await api.testProvider(provider);
              toast(res.ok ? L(`${provider.label} bağlandı · ${res.models.length} model`, `${provider.label} connected · ${res.models.length} models`) : `${provider.label}: ${res.error}`);
            },
          },
        }, L('Test et', 'Test')),
        h('button', {
          class: 'btn danger',
          type: 'button',
          on: {
            click: async () => {
              if (!confirm(L(`${provider.label} silinsin mi? Anahtarı da kaldırılır.`, `Delete ${provider.label}? Its key is removed too.`))) return;
              state.config.providers = state.config.providers.filter((p) => p.slug !== provider.slug);
              await api.setProviderKey(provider.slug, '');
              await api.saveConfig(state.config);
              await refreshAgents();
              invalidate('settings');
            },
          },
        }, icon('trash'), L('Sil', 'Delete')),
      ),
    ));
  }

  const field = (label: string, input: HTMLElement) => h('label', { class: 'field' }, label, input);
  const name = h('input', { placeholder: 'DeepSeek' }) as HTMLInputElement;
  const url = h('input', { placeholder: 'https://api.deepseek.com/v1' }) as HTMLInputElement;
  const model = h('input', { placeholder: 'deepseek-chat' }) as HTMLInputElement;
  const key = h('input', { type: 'password', placeholder: 'sk-…' }) as HTMLInputElement;
  const canWrite = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'true' });
  canWrite.addEventListener('click', () => canWrite.setAttribute('aria-checked', String(canWrite.getAttribute('aria-checked') !== 'true')));
  const result = h('span', { class: 'form-result' });

  const read = (): ProviderConfig => ({
    slug: slugify(name.value.trim()),
    label: name.value.trim(),
    baseUrl: url.value.trim(),
    model: model.value.trim(),
    strengths: L('Genel amaçlı, hızlı ve ucuz', 'General purpose, fast and cheap'),
    enabled: true,
    canWriteCode: canWrite.getAttribute('aria-checked') === 'true',
    maxTokens: 8000,
    usageCapPercent: 100,
    dailyTokenBudget: DEFAULT_PROVIDER_BUDGET,
  });

  body.append(h('div', { class: 'set-card' },
    h('div', { class: 'set-card-title' }, L('Yeni sağlayıcı ekle', 'Add new provider')),
    h('div', { class: 'field-row' }, field(L('Ad', 'Name'), name), field(L('Model', 'Model'), model)),
    field('Base URL', url),
    field(L('API anahtarı', 'API key'), key),
    h('label', { class: 'inline-field' }, canWrite, L('Kod da yazabilsin (kapalıysa yalnızca planlama ve inceleme yapar)', 'Also allowed to write code (off means planning and review only)')),
    h('div', { class: 'set-actions' },
      result,
      h('button', {
        class: 'btn',
        type: 'button',
        on: {
          click: async () => {
            const p = read();
            if (!p.baseUrl || !key.value.trim()) {
              result.className = 'form-result bad';
              result.textContent = L('Base URL ve API anahtarı gerekli.', 'Base URL and API key are required.');
              return;
            }
            result.className = 'form-result';
            result.textContent = L('Test ediliyor…', 'Testing…');
            const res = await api.testProvider(p, key.value.trim());
            result.className = `form-result ${res.ok ? 'ok' : 'bad'}`;
            result.textContent = res.ok
              ? L(`Bağlandı · ${res.models.length} model${res.models.length ? `: ${res.models.slice(0, 3).join(', ')}` : ''}`, `Connected · ${res.models.length} models${res.models.length ? `: ${res.models.slice(0, 3).join(', ')}` : ''}`)
              : L(`Başarısız: ${res.error}`, `Failed: ${res.error}`);
          },
        },
      }, L('Bağlantıyı test et', 'Test connection')),
      h('button', {
        class: 'btn ink',
        type: 'button',
        on: {
          click: async () => {
            const p = read();
            if (!p.label || !p.baseUrl || !p.model) {
              result.className = 'form-result bad';
              result.textContent = L('Ad, Base URL ve model zorunlu.', 'Name, Base URL and model are required.');
              return;
            }
            let slug = p.slug;
            let n = 2;
            while (state.config.providers.some((x) => x.slug === slug)) slug = `${p.slug}-${n++}`;
            p.slug = slug;
            if (key.value.trim()) await api.setProviderKey(slug, key.value.trim());
            state.config.providers = [...state.config.providers, p];
            await api.saveConfig(state.config);
            await Promise.all([refreshAgents(), refreshQuotas()]);
            toast(L(`${p.label} eklendi`, `${p.label} added`));
            invalidate('settings');
          },
        },
      }, icon('plus'), L('Ekle', 'Add')),
    ),
  ));
}

function generalTab(body: HTMLElement): void {
  const autoApply = h('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': String(state.config.autoApply),
    on: {
      click: () => {
        state.config.autoApply = !state.config.autoApply;
        void saveConfig();
        invalidate('settings');
      },
    },
  });

  const themes: { key: 'system' | 'light' | 'dark'; label: string }[] = [
    { key: 'system', label: L('Sistem', 'System') },
    { key: 'light', label: L('Açık', 'Light') },
    { key: 'dark', label: L('Koyu', 'Dark') },
  ];
  const theme = h('div', { class: 'seg seg-sm' }, ...themes.map((t) => h('button', {
    class: `seg-btn ${state.config.ui.theme === t.key ? 'is-on' : ''}`,
    type: 'button',
    on: {
      click: () => {
        state.config.ui.theme = t.key;
        void api.setTheme(t.key);
        void saveConfig();
        invalidate('settings');
      },
    },
  }, t.label)));

  const languages: { key: 'system' | 'tr' | 'en'; label: string }[] = [
    { key: 'system', label: L('Sistem', 'System') },
    { key: 'tr', label: 'Türkçe' },
    { key: 'en', label: 'English' },
  ];
  const current = state.config.ui.language ?? 'system';
  const language = h('div', { class: 'seg seg-sm' }, ...languages.map((l) => h('button', {
    class: `seg-btn ${current === l.key ? 'is-on' : ''}`,
    type: 'button',
    on: {
      click: async () => {
        if (current === l.key) return;
        state.config.ui.language = l.key;
        await api.saveConfig(state.config);
        // Tum metinler yeni dilde olussun diye uygulama yeniden baslar.
        await api.relaunch();
      },
    },
  }, l.label)));

  const options = [{ value: '', label: L('Otomatik (işe göre)', 'Automatic (by task)') }, ...agents().map((a) => ({ value: a.id, label: a.label }))];
  const select = (value: string | null, onChange: (v: AgentId | null) => void) => {
    const node = h('select', null, ...options.map((o) => h('option', { value: o.value, selected: o.value === (value ?? '') }, o.label))) as HTMLSelectElement;
    node.addEventListener('change', () => {
      onChange((node.value || null) as AgentId | null);
      void saveConfig();
    });
    return node;
  };

  body.append(
    h('div', { class: 'set-card' },
      h('div', { class: 'row-between' },
        h('div', null,
          h('div', { class: 'set-card-title' }, L('Sonucu klasöre otomatik uygula', 'Automatically apply the result to the folder')),
          h('div', { class: 'set-card-sub' }, L('Testler ve inceleme geçince ajanların işi doğrudan proje klasörüne işlenir. Kapalıysa ayrı dalda bekler, “Klasöre uygula” ile alırsın.', 'Once tests and review pass, the agents’ work is applied straight to the project folder. If off, it waits on a separate branch — use “Apply to folder” to pull it in.')),
        ),
        autoApply,
      ),
    ),
    h('div', { class: 'set-card' },
      h('div', { class: 'row-between' }, h('div', { class: 'set-card-title' }, L('Görünüm', 'Appearance')), theme),
    ),
    h('div', { class: 'set-card' },
      h('div', { class: 'row-between' },
        h('div', null,
          h('div', { class: 'set-card-title' }, L('Dil', 'Language')),
          h('div', { class: 'set-card-sub' }, L('Sistem seçiliyken bilgisayarın dili Türkçe ise Türkçe, değilse İngilizce kullanılır. Değişince uygulama yeniden başlar.', 'With System, Turkish is used when your computer is set to Turkish, otherwise English. The app restarts when you change it.')),
        ),
        language,
      ),
    ),
    h('div', { class: 'set-card' },
      h('div', { class: 'set-card-title' }, L('Roller', 'Roles')),
      h('div', { class: 'field-row' },
        h('label', { class: 'field' }, L('Planlayan / hakem', 'Planner / arbiter'), select(state.config.coordinator, (v) => (state.config.coordinator = v))),
        h('label', { class: 'field' }, L('İnceleyen', 'Reviewer'), select(state.config.reviewer, (v) => (state.config.reviewer = v))),
      ),
      h('div', { class: 'small muted' }, L('Otomatik seçimde basit işleri ucuz ajanlar planlar; zor işlerde Claude/Codex devreye girer.', 'With automatic selection, cheap agents plan simple work; Claude/Codex step in for hard tasks.')),
    ),
    h('div', { class: 'small muted' }, api.platform === 'darwin'
      ? L('Ayarlar ~/.konsey/config.json dosyasında, API anahtarları macOS Keychain’de tutulur.', 'Settings live in ~/.konsey/config.json; API keys are kept in the macOS Keychain.')
      : L('Ayarlar ~/.konsey/config.json dosyasında, API anahtarları sistemin şifreli deposunda tutulur.', 'Settings live in ~/.konsey/config.json; API keys are encrypted with the system’s secure storage.')),
  );
}

export function renderSettings(): void {
  if (!dialog().open) return;
  document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]').forEach((button) => {
    button.classList.toggle('is-on', button.dataset.settingsTab === state.settingsTab);
  });
  const body = $('settings-body');
  const next = h('div');
  if (state.settingsTab === 'agents') agentsTab(next);
  else if (state.settingsTab === 'providers') providersTab(next);
  else generalTab(next);
  // Sekme degisince dugumler degissin; ayni sekmede yerinde guncellenir (kaydirici surukleme bozulmaz).
  for (const child of Array.from(next.children)) child.setAttribute('data-key', `${state.settingsTab}-${child.getAttribute('data-key') ?? ''}`);
  morph(body, Array.from(next.childNodes));
}

export function openSettings(tab?: 'agents' | 'providers' | 'general'): void {
  if (tab) state.settingsTab = tab;
  if (!dialog().open) dialog().showModal();
  invalidate('settings');
  void refreshQuotas();
}

export function setupSettings(): void {
  register('settings', renderSettings);
  $('open-settings').addEventListener('click', () => openSettings());
  $('settings-close').addEventListener('click', () => dialog().close());
  dialog().addEventListener('click', (event) => {
    if (event.target === dialog()) dialog().close();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.settingsTab = button.dataset.settingsTab as typeof state.settingsTab;
      invalidate('settings');
    });
  });
}
