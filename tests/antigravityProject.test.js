const test = require('node:test');
const assert = require('node:assert/strict');
const { urisInclude } = require('../dist/src/core/adapters/antigravity.js');

test('Antigravity klasor eslesmesi bosluklu ve kodlanmis yollari tanir', () => {
  const uris = ['file:///Users/a/Desktop/Konsey%20Deneme'];
  assert.equal(urisInclude(uris, '/Users/a/Desktop/Konsey Deneme'), true);
  assert.equal(urisInclude(uris, '/Users/a/Desktop/Konsey Deneme/'), true);
  assert.equal(urisInclude(uris, '/Users/a/Desktop/Konsey'), false);
  assert.equal(urisInclude([], '/Users/a'), false);
});

test('agentapi cevabindaki konusma kimligi farkli sarmallarda bulunur', () => {
  const { findConversationId, findMetadata } = require('../dist/src/core/adapters/antigravity.js');
  assert.equal(findConversationId({ conversationId: 'a1' }), 'a1');
  assert.equal(findConversationId({ newConversation: { prompt: 'x', cascadeId: 'c9' } }), 'c9');
  assert.equal(findConversationId({ newConversation: { prompt: 'x' } }), undefined);
  assert.deepEqual(
    findMetadata({ conversationMetadata: { metadata: { projectId: 'p', workspaceUris: ['file:///a'] } } }),
    { projectId: 'p', uris: ['file:///a'] },
  );
  assert.equal(findMetadata({ nothing: true }), null);
});
