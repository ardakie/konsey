const test = require('node:test');
const assert = require('node:assert/strict');

const { Orchestrator, routeRequest } = require('../dist/src/core/orchestrator.js');

const PROFILES = [
  { agent: 'claude', label: 'Claude', strengths: '', enabled: true, costTier: 'premium' },
  { agent: 'codex', label: 'Codex', strengths: '', enabled: true, costTier: 'premium' },
  { agent: 'provider:orfi', label: 'Orfi', strengths: '', enabled: true, costTier: 'cheap' },
  { agent: 'provider:nvidia', label: 'NVIDIA', strengths: '', enabled: true, costTier: 'cheap' },
];

const ENABLED = PROFILES.map((p) => p.agent);

function make() {
  const o = new Orchestrator();
  o.profileIndex = new Map(PROFILES.map((p) => [p.agent, p]));
  o.providers = [
    { slug: 'orfi', label: 'Orfi', baseUrl: '', model: '', strengths: '', enabled: true, canWriteCode: true },
    { slug: 'nvidia', label: 'NVIDIA', baseUrl: '', model: '', strengths: '', enabled: true, canWriteCode: true },
  ];
  return o;
}

function task(id, complexity, assignedTo, extra = {}) {
  return {
    id, title: id, detail: '', scope: [], dependsOn: [],
    complexity, requiresVisual: false, suggestedAgent: null,
    assignedTo, status: 'claimed', ...extra,
  };
}

test('basit gorev pahali abonelikten ucuz saglayiciya tasinir', () => {
  const o = make();
  const tasks = [task('t1', 'low', 'codex')];
  o.enforceCostPolicy(tasks, ENABLED);
  assert.equal(tasks[0].assignedTo, 'provider:orfi');
});

test('zor gorev pahali ajanda birakilir', () => {
  const o = make();
  const tasks = [task('t1', 'high', 'claude'), task('t2', 'critical', 'codex')];
  o.enforceCostPolicy(tasks, ENABLED);
  assert.equal(tasks[0].assignedTo, 'claude');
  assert.equal(tasks[1].assignedTo, 'codex');
});

test('gorsel ureten gorev ucuz saglayiciya tasinmaz', () => {
  const o = make();
  const tasks = [task('t1', 'low', 'codex', { requiresVisual: true })];
  o.enforceCostPolicy(tasks, ENABLED);
  assert.equal(tasks[0].assignedTo, 'codex');
});

test('birden cok basit gorev ucuz ajanlar arasinda sirayla dagitilir', () => {
  const o = make();
  const tasks = [task('t1', 'low', 'codex'), task('t2', 'low', 'claude'), task('t3', 'low', 'codex')];
  o.enforceCostPolicy(tasks, ENABLED);
  assert.deepEqual(
    tasks.map((t) => t.assignedTo),
    ['provider:orfi', 'provider:nvidia', 'provider:orfi'],
  );
});

test('ucuz ajan yoksa atama degismez', () => {
  const o = make();
  const only = ['claude', 'codex'];
  const tasks = [task('t1', 'low', 'codex')];
  o.enforceCostPolicy(tasks, only);
  assert.equal(tasks[0].assignedTo, 'codex');
});

test('kotasi dolmus ucuz ajan hedef olarak secilmez', () => {
  const o = make();
  o.downed.set('provider:orfi', { reason: 'kota' });
  const tasks = [task('t1', 'low', 'codex')];
  o.enforceCostPolicy(tasks, ENABLED);
  assert.equal(tasks[0].assignedTo, 'provider:nvidia');
});

test('zaten ucuz olan gorev yeniden atanmaz', () => {
  const o = make();
  const tasks = [task('t1', 'low', 'provider:nvidia')];
  o.enforceCostPolicy(tasks, ENABLED);
  assert.equal(tasks[0].assignedTo, 'provider:nvidia');
});

test('hakem atlarsa basit gorev dogrudan ucuz ajana duser', () => {
  const o = make();
  const claims = [
    {
      agent: 'codex',
      offers: [
        { taskId: 't1', confidence: 99, rationale: '' },
        { taskId: 't2', confidence: 99, rationale: '' },
      ],
      declines: [],
      raw: '',
    },
  ];
  assert.equal(o.fallbackAssign(task('t1', 'low', null), claims, ENABLED), 'provider:orfi');
  assert.equal(o.fallbackAssign(task('t2', 'high', null), claims, ENABLED), 'codex');
});

test('tum isler basitse inceleyici de ucuz olur', () => {
  const o = make();
  const tasks = [task('t1', 'low', 'provider:orfi')];
  assert.equal(o.pickReviewer(ENABLED, tasks), 'provider:nvidia');
});

test('is zorsa inceleyici en az yuklu ajandir', () => {
  const o = make();
  const tasks = [task('t1', 'high', 'provider:orfi'), task('t2', 'high', 'provider:nvidia')];
  assert.equal(o.pickReviewer(ENABLED, tasks), 'claude');
});

test('rutin rota pahali ajanlari cagirmadan ucuz ajanlara dengeli dagitir', () => {
  const o = make();
  const tasks = [task('t1', 'low', null), task('t2', 'low', null), task('t3', 'low', null)];
  o.assignRoutineTasks(tasks, ENABLED);
  assert.deepEqual(tasks.map((t) => t.assignedTo), [
    'provider:orfi', 'provider:nvidia', 'provider:orfi',
  ]);
});

test('orta risk claim turu koordinatoru tekrar cagirmadan ekonomik ajanlari ve tek premium uzmani kullanir', () => {
  const o = make();
  const candidates = o.claimCandidates([task('t1', 'medium', null)], ENABLED, 'codex');
  assert.deepEqual(candidates, ['provider:orfi', 'provider:nvidia', 'claude']);
  assert.equal(candidates.includes('codex'), false);
});

test('bagimli gorevler ayni worktree sahibine alinir ve siralanir', () => {
  const o = make();
  const first = task('t1', 'medium', 'codex');
  const second = task('t2', 'medium', 'provider:orfi', { dependsOn: ['t1'] });
  o.enforceDependencyOwnership([second, first]);
  assert.equal(second.assignedTo, 'codex');
  assert.deepEqual(o.orderTasks([second, first]).map((t) => t.id), ['t1', 't2']);
});

test('kalite kapisi kalirsa basit istekte bile premium inceleyici secilir', () => {
  const o = make();
  const tasks = [task('t1', 'low', 'provider:orfi')];
  assert.equal(o.pickReviewer(ENABLED, tasks, false), 'claude');
});

test('onarim icin inceleyiciden farkli premium kod ajani secilir', () => {
  const o = make();
  assert.equal(o.pickFixer(ENABLED, 'high', 'claude'), 'codex');
  assert.equal(o.pickFixer(ENABLED, 'critical', 'codex'), 'claude');
});

test('gorsel uretim gorevi arac yetenegi bulunan Codex rotasina alinir', () => {
  const o = make();
  const visual = task('t1', 'medium', 'provider:orfi', { requiresVisual: true });
  o.enforceCapabilityPolicy([visual], ENABLED);
  assert.equal(visual.assignedTo, 'codex');
});

test('dar kapsamli istek dogrudan DeepSeek hizli yoluna gider', () => {
  assert.deepEqual(routeRequest('Ana sayfadaki Başla yazısını Hemen Başla yap.').strategy, 'fast');
  assert.deepEqual(routeRequest('assets klasörüne logo.png dosyasını ekle.').strategy, 'fast');
  assert.deepEqual(routeRequest('Bu depoda bağımlılıksız tek sayfalık bir pomodoro web uygulaması oluştur. index.html, styles.css ve app.js dosyalarını ekle. 25:00 başlangıç süresi, Başlat/Duraklat ve Sıfırla düğmeleri olsun. Tarayıcıda doğrudan açılabilsin. README\'ye kullanım bilgisini ekle. Basit ve tamamlanmış bir uygulama yap.').strategy, 'fast');
});

test('uzmanlik ve konsey gerektiren isleri ayirir', () => {
  assert.equal(routeRequest('Ekran görüntüsünde işaretlediğim hizalama hatasını düzelt.').strategy, 'expert');
  assert.equal(routeRequest('Kimlik doğrulama ve ödeme mimarisini yeniden tasarla.').strategy, 'council');
  assert.equal(routeRequest('Bildirim sistemi özelliği ekle.').strategy, 'expert');
  assert.equal(routeRequest('Tüm uygulamayı yeniden tasarla.').strategy, 'council');
});

test('uzman rota isi alanina uygun tek ajana verir', () => {
  const o = make();
  const frontend = task('t1', 'medium', null, { detail: 'frontend CSS layout düzelt' });
  o.assignExpertTasks([frontend], [...ENABLED, 'antigravity']);
  assert.equal(frontend.assignedTo, 'antigravity');
  const refactor = task('t2', 'medium', null, { detail: 'mimari refactor yap' });
  o.assignExpertTasks([refactor], ENABLED);
  assert.equal(refactor.assignedTo, 'claude');
});

test('ucuz ajan basarisiz olursa premiumdan once diger ucuz ajan denenir', () => {
  const o = make();
  const rescuers = ['claude', 'codex', 'provider:nvidia'];
  const alternateCheap = rescuers.find((agent) => o.tier(agent) === 'cheap');
  assert.equal(alternateCheap, 'provider:nvidia');
});
