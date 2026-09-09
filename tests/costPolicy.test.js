const test = require('node:test');
const assert = require('node:assert/strict');

const { Orchestrator } = require('../dist/src/core/orchestrator.js');

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
