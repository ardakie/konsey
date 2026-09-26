// Beklenen etkinlik metinleri Turkce; test dili sabitlenir.
process.env.KONSEY_LANG = 'tr';
const test = require('node:test');
const assert = require('node:assert/strict');

const { createActivityParser } = require('../dist/src/core/activity.js');

test('Claude stream-json satirlari okunur etkinliklere cevrilir', () => {
  const parse = createActivityParser('claude');
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Dosyayı düzenliyorum.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/p/src/app.ts' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ],
    },
  });
  // Satir iki parcada gelse de tamamlaninca islenir.
  assert.deepEqual(parse(line.slice(0, 30)), []);
  const out = parse(line.slice(30) + '\n');
  assert.deepEqual(out.map((a) => a.text), ['Dosyayı düzenliyorum.', 'src/app.ts düzenleniyor', '$ npm test']);
  assert.deepEqual(out.map((a) => a.tone), ['say', 'tool', 'tool']);
});

test('Codex olaylari: komut bir kez, dosya degisikligi ve mesaj', () => {
  const parse = createActivityParser('codex');
  const lines = [
    { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: '/p/index.html', kind: 'add' }] } },
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Bitti.' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
  assert.deepEqual(parse(lines).map((a) => a.text), ['$ ls', 'p/index.html oluşturuldu', 'Bitti.']);
});

test('saglayici eylem JSONu etkinlige cevrilir', () => {
  const parse = createActivityParser('provider:x');
  assert.deepEqual(parse('{"action":"write_file","path":"src/a.js","content":"x"}').map((a) => a.text), ['src/a.js yazılıyor']);
  assert.deepEqual(parse('\n--- adim 2 (Yanıt bekleniyor...) ---\n'), []);
});

test('Antigravity cevabindaki JSON ve kod bloklari etkinlige sizmaz', () => {
  const { createActivityParser } = require('../dist/src/core/activity.js');
  const parse = createActivityParser('antigravity');
  assert.deepEqual(parse('```json\n{ "verdict": "approved" }\n```\n'), []);
  const [line] = parse('- [index.html](file:///x/index.html) — bağlantı eklendi\n');
  assert.equal(line.tone, 'say');
  assert.ok(line.text.includes('index.html — bağlantı eklendi'));
  assert.ok(!line.text.includes('file://'));
});
