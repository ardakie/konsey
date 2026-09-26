const test = require('node:test');
const assert = require('node:assert/strict');

const { providerFailure } = require('../dist/src/core/providers/agent.js');

test('saglayici HTTP durumlarini devralma icin dogru siniflar', () => {
  assert.equal(providerFailure(401, 'unauthorized').kind, 'auth');
  assert.equal(providerFailure(403, 'forbidden').kind, 'auth');
  assert.equal(providerFailure(429, 'rate limit exceeded').kind, 'quota');
  assert.equal(providerFailure(0, 'Zaman asimi').kind, 'timeout');
});

test('upstream model kimligi olmayan saglayici kullanilamaz sayilir', () => {
  assert.equal(
    providerFailure(500, 'No available CommandCode credentials for model deepseek/deepseek-v4-flash').kind,
    'unavailable',
  );
});
