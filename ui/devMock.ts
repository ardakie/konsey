/**
 * Arayuzu Electron acmadan denemek icin sahte kopru.
 *
 * Yalnizca window.konsey yokken devreye girer; paketlenmis uygulamada
 * gercek kopru her zaman vardir, bu dosyaya hic ugranmaz.
 */
import { L } from '../src/shared/i18n';
import type { AgentQuota, ChatMessage, Debate, DebateMessage, KonseyEvent, RunPhase, RunRecord, Task } from '../src/shared/types';
import { assignRoles } from '../src/shared/debate';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

export function createMockApi(): any {
  let emit: (e: KonseyEvent) => void = () => {};
  const config: any = {
    profiles: [
      { agent: 'claude', label: 'Claude', strengths: '', enabled: true, costTier: 'premium', usageCapPercent: 80 },
      { agent: 'codex', label: 'Codex', strengths: '', enabled: true, costTier: 'premium', usageCapPercent: 80 },
      { agent: 'antigravity', label: 'Antigravity', strengths: '', enabled: false, costTier: 'standard', usageCapPercent: 100 },
      { agent: 'cli:gemini', label: 'Gemini CLI', strengths: '', enabled: true, costTier: 'standard', usageCapPercent: 100, cli: { preset: 'gemini' } },
    ],
    providers: [
      { slug: 'space-bunny', label: 'Space Bunny', baseUrl: 'https://openrouter.ai/api/v1', model: 'stealth/space-bunny-alpha', strengths: '', enabled: true, canWriteCode: true, maxTokens: 8000, usageCapPercent: 100 },
      { slug: 'glm', label: 'GLM', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3-flash', strengths: '', enabled: true, canWriteCode: true, maxTokens: 8000, usageCapPercent: 100 },
    ],
    coordinator: null,
    reviewer: null,
    recentProjects: ['/Users/ardakie/Desktop/konsey-deneme'],
    autoApply: true,
    dismissedClis: [],
    ui: { theme: 'system', mode: 'auto', chatOpen: true, officeOpen: true, language: 'system', onboarded: true },
  };
  const chats: Record<string, ChatMessage[]> = {};
  const runs: { record: RunRecord; activity: any[] }[] = [];
  const debates: Debate[] = [];

  const DEBATE_LINES: Record<string, string[]> = {
    builder: [
      L('Tek sayfalık bir web uygulamasıyla başlarım: **Next.js + SQLite**, giriş için e-posta bağlantısı. Sipariş akışı üç ekran: ürünler, sepet, onay.', 'I would start with a single-page web app: **Next.js + SQLite**, email-link sign-in. The order flow is three screens: products, cart, confirmation.'),
      L('Eleştirmenin haklı olduğu yer ödeme; ilk sürümde kapıda ödeme yeterli. Bildirimleri de e-postayla başlatalım.', 'The critic is right about payments; cash on delivery is enough for v1. Let us start notifications over email.'),
    ],
    critic: [
      L('En büyük risk alışkanlık: esnaf WhatsApp’tan vazgeçmeyebilir. Ayrıca stok takibi olmadan siparişler yanlış olur.', 'The biggest risk is habit: shops may not give up WhatsApp. And without stock tracking, orders will go wrong.'),
      L('Kapıda ödemeye katılıyorum; ama WhatsApp’a sipariş özeti gönderen bir köprü olmadan kimse kullanmaz.', 'I agree on cash on delivery, but without a bridge that sends the order summary to WhatsApp nobody will use it.'),
    ],
    user: [
      L('Esnaf için değer: dağınık mesajlar yerine tek liste. Müşteri için değer: ne kadar tuttuğunu önceden görmek.', 'Value for the shop: one list instead of scattered messages. Value for the customer: seeing the total up front.'),
      L('WhatsApp köprüsü şart; müşteri alıştığı yerden onay almalı.', 'The WhatsApp bridge is essential; customers should get confirmation where they already are.'),
    ],
    pragmatist: [
      L('MVP: ürün listesi, sepet, sipariş listesi. Stok, ödeme ve kurye sonraya. İki haftalık iş.', 'MVP: product list, cart, order list. Stock, payments and couriers later. Two weeks of work.'),
      L('Anlaştık: WhatsApp bağlantısı “paylaş” bağlantısıyla basitçe yapılabilir, API gerekmez.', 'Agreed: the WhatsApp link can be a simple share link, no API needed.'),
    ],
  };

  function publishDebate(d: Debate) {
    emit({ type: 'debate:updated', debate: structuredClone(d) });
  }

  async function mockTalk(d: Debate, agent: string, round: number) {
    const role = d.roles?.[agent] ?? 'builder';
    const m: DebateMessage = { id: uid(), from: agent as any, text: '', at: Date.now(), round, role, kind: 'say', pending: true };
    d.messages.push(m);
    publishDebate(d);
    const full = (DEBATE_LINES[role] ?? DEBATE_LINES.builder)[Math.min(round - 1, 1)];
    for (let i = 20; i < full.length; i += 24) {
      await sleep(90);
      emit({ type: 'debate:delta', debateId: d.id, id: m.id, from: agent as any, text: full.slice(0, i) });
    }
    m.pending = false;
    m.text = full;
    m.at = Date.now();
    publishDebate(d);
  }

  async function mockAdvance(d: Debate, rounds: number) {
    const speakers = ['claude', 'codex', 'cli:gemini', 'provider:glm'];
    d.roles = assignRoles(d.roles, speakers as any);
    d.busy = 'round';
    publishDebate(d);
    for (let r = 0; r < rounds; r++) {
      const round = Math.max(0, ...d.messages.map((m) => m.round)) + 1;
      if (round === 1) await Promise.all(speakers.map((a) => mockTalk(d, a, round)));
      else for (const a of speakers) await mockTalk(d, a, round);
    }
    d.busy = 'summary';
    publishDebate(d);
    const text = L(
      '## Karar\nYapmaya değer: esnafın dağınık siparişlerini tek listeye toplamak gerçek bir ihtiyaç; WhatsApp köprüsüyle başlanırsa benimsenir. Puan: 7.5/10\n## Önerilen ilk sürüm\n- Ürün listesi ve sepet\n- Sipariş listesi (esnaf ekranı)\n- WhatsApp paylaşım bağlantısıyla sipariş özeti\n- Kapıda ödeme\n## Teknik yaklaşım\n- Next.js + SQLite, tek sunucu\n- E-posta bağlantısıyla giriş\n## Riskler\n- Esnafın alışkanlığını değiştirmek\n- Stok takibi olmadan hatalı sipariş\n## Açık sorular\n- Esnaf ürünleri kendisi mi girecek?\n- Tek dükkân mı, çok dükkân mı?\n## İlk adımlar\n1. Veri modeli\n2. Ürün ve sepet ekranı\n3. Sipariş listesi ve WhatsApp bağlantısı',
      '## Verdict\nWorth building: collecting a shop’s scattered orders into one list is a real need; starting with a WhatsApp bridge makes adoption likely. Score: 7.5/10\n## Suggested first version\n- Product list and cart\n- Order list (shop screen)\n- Order summary via WhatsApp share link\n- Cash on delivery\n## Technical approach\n- Next.js + SQLite, single server\n- Email-link sign-in\n## Risks\n- Changing shop habits\n- Wrong orders without stock tracking\n## Open questions\n- Will shops enter products themselves?\n- One shop or many?\n## First steps\n1. Data model\n2. Product and cart screens\n3. Order list and WhatsApp link',
    );
    for (let i = 40; i < text.length; i += 60) {
      await sleep(60);
      emit({ type: 'debate:delta', debateId: d.id, id: 'summary', from: 'claude', text: text.slice(0, i) });
    }
    d.summary = { text, at: Date.now(), by: 'claude', score: 7.5, name: 'esnaf-siparis' };
    d.busy = undefined;
    d.updatedAt = Date.now();
    publishDebate(d);
  }

  const debateSummary = (d: Debate) => ({ id: d.id, title: d.title, projectDir: d.projectDir, updatedAt: d.updatedAt, score: d.summary?.score, busy: d.busy, converted: Boolean(d.converted) });

  function quotas(): AgentQuota[] {
    const cap = (id: string) =>
      config.profiles.find((p: any) => p.agent === id)?.usageCapPercent ??
      config.providers.find((p: any) => `provider:${p.slug}` === id)?.usageCapPercent ?? 100;
    const make = (agent: string, windows: any[], source: any): AgentQuota => {
      const used = windows.length ? Math.max(...windows.map((w) => w.usedPercent)) : null;
      const c = cap(agent);
      return { agent: agent as any, windows, usedPercent: used, capPercent: c, capped: used !== null && used >= c, source, observedAt: Date.now() };
    };
    const h = 3_600_000;
    return [
      make('claude', [{ key: 'five_hour', label: '5 saatlik', usedPercent: 32, resetsAt: Date.now() + 2.4 * h }, { key: 'seven_day', label: 'Haftalık', usedPercent: 4, resetsAt: Date.now() + 140 * h }], 'cli'),
      make('codex', [{ key: 'five_hour', label: '5 saatlik', usedPercent: 18, resetsAt: Date.now() + 3 * h }, { key: 'seven_day', label: 'Haftalık', usedPercent: 83, resetsAt: Date.now() + 60 * h }], 'log'),
      make('antigravity', [{ key: 'daily', label: 'Günlük bütçe', usedPercent: 0, resetsAt: Date.now() + 9 * h }], 'local'),
      make('provider:space-bunny', [{ key: 'daily', label: 'Günlük bütçe', usedPercent: 0.4, resetsAt: Date.now() + 9 * h }], 'local'),
      make('provider:glm', [{ key: 'daily', label: 'Günlük bütçe', usedPercent: 0, resetsAt: Date.now() + 9 * h }], 'local'),
    ];
  }

  function put(message: ChatMessage) {
    const list = (chats[message.thread] ??= []);
    const i = list.findIndex((m) => m.id === message.id);
    if (i >= 0) list[i] = message;
    else list.push(message);
  }

  const REPLIES: Record<string, string> = {
    claude: L('Önce veri modelini netleştirelim: görevleri `localStorage` içinde tek bir dizi olarak tutmak yeterli. Arayüz tarafını **Codex** hızlıca kurabilir.', 'Let’s pin down the data model first: a single array in `localStorage` is enough. **Codex** can set up the UI quickly.'),
    codex: L('Katılıyorum. `app.js` içinde ekle/tamamla/sil için üç saf fonksiyon yazar, DOM’u tek bir `render()` ile güncellerim. Test için küçük bir `node --test` dosyası da eklerim.', 'Agreed. I’ll write three pure functions in `app.js` for add/complete/delete and update the DOM from a single `render()`. I’ll add a small `node --test` file too.'),
    'provider:space-bunny': L('Stil dosyasını ben alabilirim; basit bir iş, pahalı ajanlara gerek yok.', 'I can take the stylesheet; it’s simple, no need for the expensive agents.'),
    'provider:glm': L('README kısmını ben yazarım.', 'I’ll write the README.'),
  };

  async function reply(thread: string, agent: string) {
    const id = uid();
    const base: ChatMessage = { id, thread: thread as any, from: agent as any, text: '', at: Date.now(), kind: 'chat' };
    put({ ...base, pending: true });
    emit({ type: 'chat:message', message: { ...base, pending: true } });
    await sleep(500);
    emit({ type: 'chat:delta', id, thread: thread as any, text: L('_proje dosyaları okunuyor…_', '_reading project files…_') });
    await sleep(900);
    const final = { ...base, text: REPLIES[agent] ?? L('Anlaşıldı.', 'Got it.'), at: Date.now() };
    put(final);
    emit({ type: 'chat:done', message: final });
  }

  async function simulate(prompt: string): Promise<RunRecord> {
    const run: RunRecord = {
      id: uid(),
      projectDir: config.recentProjects[0],
      prompt,
      strategy: 'council',
      phase: 'planning',
      startedAt: Date.now(),
      baseBranch: 'main',
      baseCommit: 'abc1234',
      integrationBranch: null,
      tasks: [],
      claims: [],
      workspaces: [],
      merges: [],
      usage: [],
      routeReason: L('birden fazla uzmanlık alanına bölünebilen geniş iş', 'broad work that splits across several specialties'),
    };
    const activity: any[] = [];
    const note = (from: string, text: string) => {
      const m: ChatMessage = { id: uid(), thread: 'council', from: from as any, text, at: Date.now(), kind: 'run', runId: run.id };
      put(m);
      emit({ type: 'chat:message', message: m });
    };
    const act = (agent: string, text: string, tone: any = 'tool') => {
      activity.push({ agent, text, tone, at: Date.now() });
      emit({ type: 'activity', runId: run.id, agent: agent as any, text, tone, at: Date.now() });
    };
    const phase = async (p: RunPhase, ms: number) => {
      run.phase = p;
      emit({ type: 'run:phase', runId: run.id, phase: p });
      emit({ type: 'run:updated', run: structuredClone(run) });
      await sleep(ms);
    };

    emit({ type: 'run:started', run: structuredClone(run) });
    await phase('planning', 900);
    act('claude', L('Proje yapısı inceleniyor', 'Looking at the project structure'), 'say');
    await sleep(700);
    const tasks: Task[] = [
      { id: 't1', title: L('Arayüz iskeleti', 'UI skeleton'), detail: L('index.html ve style.css', 'index.html and style.css'), scope: ['index.html', 'style.css'], dependsOn: [], complexity: 'low', requiresVisual: false, suggestedAgent: 'provider:space-bunny', assignedTo: null, status: 'pending' },
      { id: 't2', title: L('Uygulama mantığı', 'App logic'), detail: L('app.js: ekle, tamamla, sil, localStorage', 'app.js: add, complete, delete, localStorage'), scope: ['app.js'], dependsOn: [], complexity: 'medium', requiresVisual: false, suggestedAgent: 'codex', assignedTo: null, status: 'pending' },
      { id: 't3', title: 'README', detail: L('Kurulum ve kullanım', 'Setup and usage'), scope: ['README.md'], dependsOn: [], complexity: 'low', requiresVisual: false, suggestedAgent: 'provider:glm', assignedTo: null, status: 'pending' },
    ];
    run.tasks = tasks;
    run.summary = L('Tek sayfalık yapılacaklar uygulaması: arayüz, mantık ve belge.', 'Single-page to-do app: UI, logic and docs.');
    note('claude', L(`Planı çıkardım: 3 görev. ${run.summary}`, `Plan ready: 3 tasks. ${run.summary}`));
    await phase('claiming', 900);
    run.claims = [
      { agent: 'codex', offers: [{ taskId: 't2', confidence: 88, rationale: L('Saf fonksiyonlar ve DOM güncellemesi tam bana göre.', 'Pure functions and DOM updates are right up my alley.') }], declines: [], raw: '' },
      { agent: 'provider:space-bunny', offers: [{ taskId: 't1', confidence: 75, rationale: 'Basit HTML/CSS.' }], declines: [], raw: '' },
    ];
    note('codex', L('"Uygulama mantığı" bende olsun (güven 88). Saf fonksiyonlar ve DOM güncellemesi tam bana göre.', 'I’ll take "App logic" (confidence 88). Pure functions and DOM updates are right up my alley.'));
    note('provider:space-bunny', L('"Arayüz iskeleti" bende olsun (güven 75). Basit HTML/CSS.', 'I’ll take "UI skeleton" (confidence 75). Simple HTML/CSS.'));
    await phase('arbitrating', 700);
    tasks[0].assignedTo = 'provider:space-bunny';
    tasks[1].assignedTo = 'codex';
    tasks[2].assignedTo = 'provider:glm';
    tasks.forEach((t) => (t.status = 'claimed'));
    note('orchestrator', L('Dağıtım: Space Bunny → Arayüz iskeleti · Codex → Uygulama mantığı · GLM → README', 'Assignment: Space Bunny → UI skeleton · Codex → App logic · GLM → README'));
    await phase('executing', 300);
    run.workspaces = tasks.map((t) => ({ agent: t.assignedTo!, dir: '/tmp/x', branch: 'b', isMainTree: false }));
    tasks.forEach((t) => (t.status = 'running'));
    emit({ type: 'run:updated', run: structuredClone(run) });
    const steps: [string, string, string?][] = [
      ['codex', L('app.js okunuyor', 'reading app.js')], ['provider:space-bunny', L('index.html yazılıyor', 'writing index.html')], ['provider:glm', L('README.md yazılıyor', 'writing README.md')],
      ['codex', L('app.js yazılıyor', 'writing app.js')], ['provider:space-bunny', L('style.css yazılıyor', 'writing style.css')], ['codex', '$ node --test'],
      ['codex', L('Testler geçti, render() tek noktadan çağrılıyor.', 'Tests pass; render() is called from one place.'), 'say'], ['provider:glm', L('README tamam.', 'README done.'), 'say'],
    ];
    for (const [agent, text, tone] of steps) {
      act(agent, text, tone ?? 'tool');
      await sleep(450);
    }
    tasks.forEach((t) => (t.status = 'succeeded'));
    note('codex', L('Uygulama mantığı tamam. Ekle/tamamla/sil ve kalıcılık hazır.', 'App logic done. Add/complete/delete and persistence are ready.'));
    await phase('merging', 800);
    run.merges = tasks.map((t) => ({ agent: t.assignedTo!, branch: 'b', status: 'merged' as const, conflictFiles: [] }));
    run.integrationBranch = `konsey/${run.id}/integration`;
    run.validation = { ok: true, summary: L('1/1 kontrol geçti.', '1/1 checks passed.'), commands: [{ command: 'npm test', ok: true, output: L('✔ 3 test geçti', '✔ 3 tests passed'), durationMs: 1400 }] };
    await phase('reviewing', 900);
    run.review = { reviewer: 'claude', verdict: 'approved', summary: L('Değişiklikler istekle uyumlu, testler geçiyor.', 'Changes match the request; tests pass.'), findings: [], raw: '' };
    note('claude', L('İnceledim, onaylıyorum. Değişiklikler istekle uyumlu, testler geçiyor.', 'Reviewed and approved. Changes match the request; tests pass.'));
    run.phase = 'done';
    run.endedAt = Date.now();
    run.diffStat = ' README.md  | 24 ++++\n app.js     | 88 ++++++++++\n index.html | 31 ++++\n style.css  | 64 ++++++++\n 4 files changed, 207 insertions(+)';
    run.applied = { ok: true, message: L('Değişiklikler proje klasörüne uygulandı.', 'Changes were applied to the project folder.'), at: Date.now() };
    run.usage = [
      { agent: 'claude', role: 'plan', durationMs: 9000, totalTokens: 41000 },
      { agent: 'codex', role: 'execute', durationMs: 52000, totalTokens: 88000 },
      { agent: 'provider:space-bunny', role: 'execute', durationMs: 21000, totalTokens: 12000 },
      { agent: 'provider:glm', role: 'execute', durationMs: 15000, totalTokens: 7000 },
      { agent: 'claude', role: 'review', durationMs: 11000, totalTokens: 36000 },
    ];
    note('orchestrator', L('Bitti. Değişiklikler proje klasörüne uygulandı.', 'Done. Changes were applied to the project folder.'));
    runs.unshift({ record: structuredClone(run), activity });
    emit({ type: 'run:finished', run: structuredClone(run) });
    return run;
  }

  const params = new URLSearchParams(location.search);
  return {
    lang: params.get('lang') || navigator.language,
    platform: params.get('platform') || 'darwin',
    system: async () => ({ platform: params.get('platform') || 'darwin', lang: 'tr', version: '1.0.0', git: params.get('nogit') === null, node: true }),
    connectList: async () => [
      { id: 'claude', label: 'Claude Code', install: 'curl -fsSL https://claude.ai/install.sh | bash', login: 'claude', docs: 'https://docs.claude.com', needsNode: false, installed: true },
      { id: 'codex', label: 'Codex CLI', install: 'npm install -g @openai/codex', login: 'codex login', docs: 'https://developers.openai.com/codex/cli', needsNode: true, installed: true },
      { id: 'antigravity', label: 'Antigravity', install: null, login: null, docs: 'https://antigravity.google/download', needsNode: false, installed: true },
      { id: 'cli:gemini', label: 'Gemini CLI', install: 'npm install -g @google/gemini-cli', login: 'gemini', docs: 'https://github.com/google-gemini/gemini-cli', needsNode: true, installed: true },
      { id: 'cli:cursor', label: 'Cursor Agent', install: 'curl https://cursor.com/install -fsS | bash', login: 'cursor-agent login', docs: 'https://cursor.com/cli', needsNode: false, installed: false },
      { id: 'cli:copilot', label: 'GitHub Copilot CLI', install: 'npm install -g @github/copilot', login: 'copilot', docs: 'https://github.com/github/copilot-cli', needsNode: true, installed: false },
      { id: 'cli:opencode', label: 'OpenCode', install: 'npm install -g opencode-ai', login: 'opencode auth login', docs: 'https://opencode.ai', needsNode: true, installed: false },
    ],
    connectRun: async () => ({ ok: true }),
    openExternal: async () => true,
    relaunch: async () => location.reload(),
    checkUpdate: async () => ({ current: '1.0.0', latest: params.get('update') ? 'v1.1.0' : 'v1.0.0', available: Boolean(params.get('update')), url: '' }),
    openDownloads: async () => true,
    integrations: async () => [
      { id: 'github', label: 'GitHub', blurb: 'Repositories, issues, pull requests and Actions.', tokenUrl: 'https://github.com/settings/tokens', tokenHint: 'github_pat_…', supportsReadOnly: true, readOnly: true, enabled: true, hasToken: true, engines: ['claude', 'codex'], custom: false },
      { id: 'supabase', label: 'Supabase', blurb: 'Database tables, SQL, logs and projects.', tokenUrl: 'https://supabase.com/dashboard/account/tokens', tokenHint: 'sbp_…', supportsReadOnly: true, readOnly: true, enabled: false, hasToken: false, engines: ['claude', 'codex'], custom: false },
      { id: 'sentry', label: 'Sentry', blurb: 'Errors, events and performance issues.', tokenUrl: 'https://sentry.io/settings/account/api/auth-tokens/', tokenHint: 'sntryu_…', supportsReadOnly: false, readOnly: false, enabled: false, hasToken: false, engines: ['claude'], custom: false },
    ],
    setupChecks: async () => [
      { id: 'git', title: 'Git', required: true, state: params.get('nogit') !== null ? 'missing' : 'ok', detail: 'Installed.', action: params.get('nogit') !== null ? { id: 'install-git', label: 'Install git' } : undefined },
      { id: 'node', title: 'Node.js', required: false, state: 'ok', detail: 'Installed.' },
      { id: 'login-claude', title: 'Claude Code', required: false, state: 'ok', detail: 'Connected.' },
      { id: 'login-codex', title: 'Codex', required: false, state: 'missing', detail: 'Not signed in; this agent cannot take work.', action: { id: 'login-codex', label: 'Sign in' } },
      { id: 'terminal', title: 'Terminal', required: false, state: 'unknown', detail: 'macOS asks once.', action: { id: 'grant-terminal', label: 'Allow' } },
    ],
    setupFix: async () => ({ ok: true }),
    saveIntegration: async () => ({ ok: true }),
    removeIntegration: async () => true,
    testIntegration: async () => ({ ok: true, detail: '@octocat' }),
    browser: async () => undefined,
    simulator: async () => [],
    availability: async () => [
      { agent: 'claude', available: true, detail: 'CLI bulundu' },
      { agent: 'codex', available: true, detail: 'CLI bulundu' },
      { agent: 'antigravity', available: true, detail: L('Kapalı · gerektiğinde Konsey arka planda açar', 'Closed · Konsey opens it in the background when needed') },
      { agent: 'cli:gemini', available: true, detail: 'Bulundu: /opt/homebrew/bin/gemini' },
      { agent: 'provider:space-bunny', available: true, detail: 'stealth/space-bunny-alpha' },
      { agent: 'provider:glm', available: true, detail: 'glm-5.3-flash' },
    ],
    quotas: async () => quotas(),
    usage: async () => [
      { agent: 'claude', today: { calls: 6, tokens: 180000, costUsd: 0.8, durationMs: 60000 }, total: { calls: 40, tokens: 1200000, costUsd: 6.1, durationMs: 600000 } },
      { agent: 'codex', today: { calls: 3, tokens: 90000, costUsd: 0, durationMs: 60000 }, total: { calls: 22, tokens: 700000, costUsd: 0, durationMs: 600000 } },
    ],
    pickImages: async () => [],
    imagesFromPaths: async () => [],
    saveImage: async () => ({ path: '/tmp/mock.png', name: 'mock.png', dataUrl: '' }),
    filePath: () => '',
    loadConfig: async () => structuredClone(config),
    saveConfig: async (next: any) => {
      Object.assign(config, structuredClone(next));
      return true;
    },
    setTheme: async () => true,
    setProviderKey: async () => true,
    hasProviderKey: async () => true,
    testProvider: async () => ({ ok: true, models: ['deepseek-chat'] }),
    pickProject: async () => ({ dir: config.recentProjects[0], isGit: false, hasCommit: false }),
    selectProject: async (dir: string) => ({ dir, isGit: false, hasCommit: false }),
    describeProject: async (dir: string) => ({ dir, isGit: true, hasCommit: true }),
    prepareProject: async () => ({ ok: true, created: true, message: L('Klasör git deposu olarak hazırlandı.', 'Folder prepared as a git repository.') }),
    openPath: async () => {},
    reveal: async () => {},
    loadChats: async () => structuredClone(chats),
    sendChat: async ({ thread, text }: { thread: string; text: string }) => {
      const m: ChatMessage = { id: uid(), thread: thread as any, from: 'user', text, at: Date.now(), kind: 'chat' };
      put(m);
      emit({ type: 'chat:message', message: m });
      const speakers = thread === 'council' ? ['claude', 'codex', 'provider:space-bunny'] : [thread];
      for (const agent of speakers) await reply(thread, agent);
      return { ok: true };
    },
    cancelChat: async () => true,
    clearChat: async (_dir: string, thread: string) => {
      delete chats[thread];
      return true;
    },
    listDebates: async (dir: string | null) => debates.filter((d) => !d.projectDir || d.projectDir === dir).map(debateSummary).sort((a, b) => b.updatedAt - a.updatedAt),
    getDebate: async (id: string) => structuredClone(debates.find((d) => d.id === id) ?? null),
    startDebate: async ({ topic, projectDir, depth }: { topic: string; projectDir: string | null; depth: number }) => {
      const now = Date.now();
      const d: Debate = { id: `${uid()}${uid()}`, title: topic.split('\n')[0].slice(0, 80), topic, projectDir, createdAt: now, updatedAt: now, messages: [{ id: uid(), from: 'user', text: topic, at: now, round: 0, kind: 'user' }] };
      debates.push(d);
      void mockAdvance(d, depth);
      return { ok: true, debate: structuredClone(d) };
    },
    sayDebate: async (id: string, text: string) => {
      const d = debates.find((x) => x.id === id)!;
      d.messages.push({ id: uid(), from: 'user', text, at: Date.now(), round: Math.max(...d.messages.map((m) => m.round)), kind: 'user' });
      publishDebate(d);
      void mockAdvance(d, 1);
      return { ok: true };
    },
    roundDebate: async (id: string) => {
      void mockAdvance(debates.find((x) => x.id === id)!, 1);
      return { ok: true };
    },
    summarizeDebate: async (id: string) => {
      void mockAdvance(debates.find((x) => x.id === id)!, 0);
      return { ok: true };
    },
    cancelDebate: async () => true,
    deleteDebate: async (id: string) => {
      const i = debates.findIndex((d) => d.id === id);
      if (i >= 0) debates.splice(i, 1);
      return true;
    },
    renameDebate: async (id: string, title: string) => {
      const d = debates.find((x) => x.id === id);
      if (!d) return null;
      d.title = title;
      publishDebate(d);
      return structuredClone(d);
    },
    convertDebate: async ({ id, parentDir, name }: { id: string; parentDir?: string; name?: string }) => {
      const d = debates.find((x) => x.id === id)!;
      const projectDir = d.projectDir ?? `${parentDir}/${name || 'yeni-proje'}`;
      const file = d.projectDir ? `${projectDir}/docs/konsey/${d.summary?.name ?? 'fikir'}.md` : `${projectDir}/KONSEY.md`;
      d.converted = { projectDir, file, at: Date.now() };
      publishDebate(d);
      return { ok: true, projectDir, file, isNew: !d.projectDir, prompt: `${d.title}\n\n${d.summary?.text ?? ''}` };
    },
    pickFolder: async () => '/Users/ardakie/Documents/Konsey',
    defaultProjectsDir: async () => '/Users/ardakie/Desktop',
    listRuns: async () => runs.map(({ record }) => ({ id: record.id, projectDir: record.projectDir, prompt: record.prompt, phase: record.phase, strategy: record.strategy, startedAt: record.startedAt, endedAt: record.endedAt, applied: record.applied?.ok })),
    getRun: async (id: string) => structuredClone(runs.find((r) => r.record.id === id) ?? null),
    deleteRun: async (id: string) => {
      const i = runs.findIndex((r) => r.record.id === id);
      if (i >= 0) runs.splice(i, 1);
      return true;
    },
    applyRun: async () => ({ ok: true, message: L('Uygulandı.', 'Applied.') }),
    startRun: async ({ prompt }: { prompt: string }) => ({ ok: true, record: await simulate(prompt) }),
    cancelRun: async () => true,
    onEvent: (handler: (e: KonseyEvent) => void) => {
      emit = handler;
      return () => {
        emit = () => {};
      };
    },
  };
}
