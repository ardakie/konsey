const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyFailure, retryHintToTimestamp } = require('../dist/src/core/adapters/failures.js');

test('quota hatasi ve goreli reset zamani ayristirilir', () => {
  const result = classifyFailure('Usage limit reached. Try again after 2 hours.');
  assert.equal(result.kind, 'quota');
  assert.equal(result.retryHint, '2 hours');
  assert.equal(retryHintToTimestamp(result.retryHint, 1_000), 7_201_000);
});

test('saat-only reset ipucu gecmisse ertesi gune tasinir', () => {
  const now = new Date(2026, 8, 9, 15, 0, 0).getTime();
  const retryAt = retryHintToTimestamp('1:02 PM', now);
  assert.equal(retryAt, new Date(2026, 8, 10, 13, 2, 0).getTime());
});

test('auth hatasi kota uykusu olarak siniflanmaz', () => {
  assert.equal(classifyFailure('OAuth session expired').kind, 'auth');
});
