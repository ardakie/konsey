const test = require('node:test');
const assert = require('node:assert/strict');

const { workspaceIdToPath } = require('../dist/src/core/discovery.js');

test('Antigravity workspace kimligindeki bosluk kodunu gercek yola cevirir', () => {
  assert.equal(
    workspaceIdToPath('file_Users_ardakie_Desktop_dating_20app'),
    '/Users/ardakie/Desktop/dating app',
  );
});
