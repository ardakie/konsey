process.env.KONSEY_LANG = 'tr';
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveIntegrations, claudeMcpConfig, codexMcpArgs, integrationNote, secretAccount, INTEGRATIONS } = require('../dist/src/core/integrations.js');

const secrets = { 'integration:github': 'ghp_x', 'integration:sentry': 'sntry_y', 'integration:custom-wiki': '' };
const get = async (account) => secrets[account] ?? null;

test('yalnizca acik ve token i olan servisler cozulur; GitHub varsayilan salt okunur', async () => {
  const list = await resolveIntegrations([
    { id: 'github', enabled: true },
    { id: 'sentry', enabled: true },
    { id: 'stripe', enabled: true },
    { id: 'supabase', enabled: false },
    { id: 'custom-wiki', enabled: true, label: 'Wiki', url: 'https://mcp.example.com/mcp' },
  ], get);
  assert.deepEqual(list.map((i) => i.id), ['github', 'sentry', 'custom-wiki']);
  assert.equal(list[0].readOnly, true);
  assert.match(list[0].server.url, /readonly$/);
});

test('salt okunur kapatilabilir', async () => {
  const [gh] = await resolveIntegrations([{ id: 'github', enabled: true, readOnly: false }], get);
  assert.equal(gh.readOnly, false);
  assert.doesNotMatch(gh.server.url, /readonly/);
});

test('Claude ayari HTTP icin baslik, yerel sunucu icin ortam degiskeni tasir', async () => {
  const list = await resolveIntegrations([{ id: 'github', enabled: true }, { id: 'sentry', enabled: true }], get);
  const cfg = claudeMcpConfig(list).mcpServers;
  assert.equal(cfg.konsey_github.headers.Authorization, 'Bearer ghp_x');
  assert.equal(cfg.konsey_sentry.env.SENTRY_ACCESS_TOKEN, 'sntry_y');
});

test('Codex token i komut satirina degil ortama koyar ve yerel sunuculari atlar', async () => {
  const list = await resolveIntegrations([{ id: 'github', enabled: true }, { id: 'sentry', enabled: true }], get);
  const { args, env } = codexMcpArgs(list);
  assert.ok(!args.join(' ').includes('ghp_x'));
  assert.equal(env.KONSEY_MCP_GITHUB, 'ghp_x');
  assert.ok(args.some((a) => a.startsWith('mcp_servers.konsey_github.url=')));
  assert.ok(!args.some((a) => a.includes('konsey_sentry')));
});

test('ajan notu bagli servisleri sayar', async () => {
  const list = await resolveIntegrations([{ id: 'github', enabled: true }, { id: 'sentry', enabled: true }], get);
  assert.match(integrationNote(list, 'claude'), /GitHub \(salt okunur\), Sentry/);
  assert.doesNotMatch(integrationNote(list, 'codex'), /Sentry/);
  assert.equal(integrationNote([], 'claude'), '');
});

test('her servisin token sayfasi ve testi var', () => {
  for (const def of INTEGRATIONS) {
    assert.match(def.tokenUrl, /^https:\/\//);
    assert.equal(typeof def.test, 'function');
  }
  assert.equal(secretAccount('github'), 'integration:github');
});
