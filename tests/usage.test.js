const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Testler gercek ~/.konsey dosyalarina dokunmasin.
process.env.KONSEY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'konsey-usage-'));

const {
  buildQuota,
  claudeWindowsFromEvent,
  clampCap,
  computeQuotas,
  recordUsage,
  __resetUsageCache,
} = require('../dist/src/core/usage.js');

test('Claude rate_limit_event yuzdelik pencerelere cevrilir', () => {
  const windows = claudeWindowsFromEvent({
    status: 'allowed',
    unifiedWindows: {
      five_hour: { utilization: 0.29, resetsAt: 1790431200 },
      seven_day: { utilization: 0.04, resetsAt: 1791003600 },
    },
  });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].usedPercent, 29);
  assert.equal(windows[0].resetsAt, 1790431200 * 1000);
  assert.equal(windows[1].usedPercent, 4);
});

test('reddedilen eski bicim pencereyi dolu sayar', () => {
  const windows = claudeWindowsFromEvent({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1790000000 });
  assert.equal(windows[0].key, 'seven_day');
  assert.equal(windows[0].usedPercent, 100);
});

test('kullanim izin verilen payi gecince ajan kilitlenir', () => {
  const windows = [
    { key: 'five_hour', label: '5 saatlik', usedPercent: 18, resetsAt: 1000 },
    { key: 'seven_day', label: 'Haftalık', usedPercent: 83, resetsAt: 5000 },
  ];
  assert.equal(buildQuota('codex', windows, 100, 'log').capped, false);
  const at80 = buildQuota('codex', windows, 80, 'log');
  assert.equal(at80.capped, true);
  assert.equal(at80.unlocksAt, 5000);
  const at1 = buildQuota('codex', windows, 1, 'log');
  assert.equal(at1.capped, true);
  assert.equal(at1.unlocksAt, 5000);
  assert.equal(buildQuota('claude', [], 1, 'unknown').capped, false, 'olcum yoksa kilitlenmez');
});

test('pay 1-100 araligina sikistirilir', () => {
  assert.equal(clampCap(0), 1);
  assert.equal(clampCap(250), 100);
  assert.equal(clampCap('abc'), 100);
  assert.equal(clampCap(37.6), 38);
});

test('saglayici gunluk token butcesinin yuzdesi hesaplanir ve %1 payi uygulanir', async () => {
  __resetUsageCache();
  const provider = {
    slug: 'deneme', label: 'Deneme', baseUrl: '', model: '', strengths: '', enabled: true,
    canWriteCode: true, maxTokens: 8000, dailyTokenBudget: 10_000, usageCapPercent: 1,
  };
  let quotas = await computeQuotas([], [provider]);
  assert.equal(quotas[0].usedPercent, 0);
  assert.equal(quotas[0].capped, false);

  await recordUsage('provider:deneme', { tokens: 150, durationMs: 10 });
  quotas = await computeQuotas([], [provider]);
  assert.equal(quotas[0].usedPercent, 1.5);
  assert.equal(quotas[0].capped, true, '%1.5 > %1 pay');
});

test('Antigravity gunluk tur butcesiyle olculur', async () => {
  __resetUsageCache();
  const profile = { agent: 'antigravity', label: 'Antigravity', strengths: '', enabled: true, usageCapPercent: 50, dailyTurnBudget: 4 };
  await recordUsage('antigravity', {});
  await recordUsage('antigravity', {});
  const [quota] = await computeQuotas([profile], []);
  assert.equal(quota.usedPercent, 50);
  assert.equal(quota.capped, true);
});
