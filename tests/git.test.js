const test = require('node:test');
const assert = require('node:assert/strict');

const { branchName } = require('../dist/src/core/git.js');

test('saglayici kimligi gecerli bir git dalina donusturulur', () => {
  assert.equal(branchName('abc123', 'provider:orfi-deepseek'), 'konsey/abc123/provider-orfi-deepseek');
});
