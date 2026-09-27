const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

process.env.KONSEY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'konsey-debates-'));
process.env.KONSEY_LANG = 'tr';
process.env.FAKEA_API_KEY = 'test-key';
process.env.FAKEB_API_KEY = 'test-key';

const debates = require('../dist/src/core/debates.js');

const SUMMARY = `## Karar
Yapmaya değer, küçük başlanırsa. Puan: 8/10
## Önerilen ilk sürüm
- Liste
## Teknik yaklaşım
- Node.js
## Riskler
- Benimsenme
## Açık sorular
- Tek kullanıcı mı?
## İlk adımlar
1. Veri modeli
Ad: alisveris-listesi`;

/** OpenAI uyumlu sahte saglayici: istemleri kaydeder, role gore cevap verir. */
function fakeProvider() {
  const prompts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const payload = JSON.parse(body);
      const prompt = payload.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      prompts.push(prompt);
      const content = prompt.includes('moderatörüsün') ? SUMMARY : `Görüşüm (${payload.model}): küçük başlayalım.`;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, prompts, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const provider = (slug, url) => ({
  slug, label: slug.toUpperCase(), baseUrl: url, model: `${slug}-model`, strengths: '', enabled: true,
  canWriteCode: false, maxTokens: 2000, usageCapPercent: 100,
});

test('slugify Turkce karakterleri sadelestirir', () => {
  assert.equal(debates.slugify('Akıllı Alışveriş Listesi!'), 'akilli-alisveris-listesi');
  assert.equal(debates.slugify('İŞÇİ ÖĞÜN'), 'isci-ogun');
  assert.equal(debates.slugify('   '), 'konsey-proje');
});

test('roller dagitilir ve tartisma boyunca sabit kalir', () => {
  assert.deepEqual(debates.assignRoles(undefined, ['claude']), { claude: 'all' });
  const two = debates.assignRoles(undefined, ['claude', 'codex']);
  assert.deepEqual(two, { claude: 'builder', codex: 'critic' });
  const three = debates.assignRoles(two, ['claude', 'codex', 'provider:glm']);
  assert.equal(three.claude, 'builder');
  assert.equal(three.codex, 'critic');
  assert.equal(three['provider:glm'], 'user');
  // Tek basina 'all' olan ajan, ikinci ajan gelince gercek bir rol alir.
  const grown = debates.assignRoles({ claude: 'all' }, ['claude', 'codex']);
  assert.notEqual(grown.claude, 'all');
  assert.notEqual(grown.claude, grown.codex);
});

test('karar notundan puan ve klasor adi ayrilir', () => {
  const parsed = debates.parseSummary(SUMMARY);
  assert.equal(parsed.score, 8);
  assert.equal(parsed.name, 'alisveris-listesi');
  assert.ok(!parsed.text.includes('Ad: alisveris-listesi'));
  assert.equal(debates.parseSummary('Score: 6.5/10').score, 6.5);
  assert.equal(debates.parseSummary('Puan: 7,5 / 10').score, 7.5);
  assert.equal(debates.parseSummary('puan yok').score, undefined);
});

test('moderator secimi: koordinator, sonra guclu CLI', () => {
  assert.deepEqual(debates.pickModerator(['provider:a', 'codex', 'claude'], null).slice(0, 2), ['claude', 'codex']);
  assert.equal(debates.pickModerator(['provider:a', 'codex'], 'provider:a')[0], 'provider:a');
  assert.equal(debates.pickModerator(['provider:a', 'cli:gemini'], null)[0], 'cli:gemini');
});

test('dolu klasorun ustune yazilmaz', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'konsey-parent-'));
  assert.equal(await debates.freeDir(parent, 'Proje'), path.join(parent, 'proje'));
  fs.mkdirSync(path.join(parent, 'proje'));
  assert.equal(await debates.freeDir(parent, 'Proje'), path.join(parent, 'proje'), 'bos klasor kullanilabilir');
  fs.writeFileSync(path.join(parent, 'proje', 'a.txt'), 'x');
  assert.equal(await debates.freeDir(parent, 'Proje'), path.join(parent, 'proje-2'));
});

test('tartisma: acilis, karsilikli tur, karar notu ve projeye donusturme', async () => {
  const fake = await fakeProvider();
  try {
    const providers = [provider('fakea', fake.url), provider('fakeb', fake.url)];
    const events = [];
    const talk = { profiles: [], providers, integrations: [], coordinator: null, emit: (e) => events.push(e) };

    const created = await debates.createDebate('Aile için ortak alışveriş listesi\nGerçek zamanlı eşitleme olsun.', null);
    assert.equal(created.title, 'Aile için ortak alışveriş listesi');
    assert.equal((await debates.listDebates(null)).length, 1);

    await debates.advanceDebate(created.id, { ...talk, rounds: 2, summarize: true });
    const d = await debates.getDebate(created.id);
    const said = d.messages.filter((m) => m.kind === 'say');
    assert.equal(said.length, 4, 'iki ajan, iki tur');
    assert.deepEqual([...new Set(said.map((m) => m.round))], [1, 2]);
    assert.deepEqual(said.slice(0, 2).map((m) => m.role).sort(), ['builder', 'critic']);
    assert.equal(d.busy, undefined);
    assert.equal(d.summary.score, 8);
    assert.equal(d.summary.name, 'alisveris-listesi');
    assert.ok(events.some((e) => e.type === 'debate:updated'));

    // Acilis turunda ajanlar birbirini gormez; ikinci turda gecmisi gorur.
    const opening = fake.prompts.filter((p) => p.includes('açılış turu'));
    assert.equal(opening.length, 2);
    assert.ok(opening.every((p) => !p.includes('TARTIŞMA:')));
    assert.ok(fake.prompts.some((p) => p.includes('karşılıklı') || (p.includes('TARTIŞMA:') && p.includes('Görüşüm'))));

    // Kullanici araya girer; bir tur daha konusulur.
    await debates.postToDebate(created.id, 'Tek kullanıcıyla başlayalım.');
    await debates.advanceDebate(created.id, { ...talk, rounds: 1, summarize: false });
    const after = await debates.getDebate(created.id);
    assert.equal(after.messages.filter((m) => m.kind === 'say').length, 6);
    assert.ok(fake.prompts.at(-1).includes('Kullanıcı az önce araya girdi'));

    // Projeye donusturme: yeni klasor, KONSEY.md, git deposu, gorev istemi.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'konsey-new-'));
    const result = await debates.convertDebate(created.id, { parentDir: parent, details: 'Mobil öncelikli.', profiles: [], providers, emit: () => {} });
    assert.equal(result.isNew, true);
    assert.equal(result.projectDir, path.join(parent, 'alisveris-listesi'));
    const doc = fs.readFileSync(result.file, 'utf8');
    assert.ok(doc.startsWith('# Aile için ortak alışveriş listesi'));
    assert.ok(doc.includes('Mobil öncelikli.'));
    assert.ok(doc.includes('Puan: 8/10'));
    assert.ok(doc.includes('### 2. tur'));
    const tracked = execFileSync('git', ['ls-files'], { cwd: result.projectDir, encoding: 'utf8' });
    assert.ok(tracked.includes('KONSEY.md'), 'dosya ilk commit icinde');
    assert.equal(result.prompt.split('\n')[0], 'Aile için ortak alışveriş listesi');
    assert.ok(result.prompt.includes('KONSEY.md'));
    assert.ok(result.prompt.includes('Mobil öncelikli.'));
    assert.ok((await debates.getDebate(created.id)).converted);
  } finally {
    fake.server.close();
  }
});

test('projeye bagli tartisma docs/konsey altina yazilir, depo commit edilmez', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'konsey-proj-'));
  fs.writeFileSync(path.join(project, 'index.js'), '');
  const d = await debates.createDebate('Önbellek ekleyelim mi?', project);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'konsey-other-'));
  assert.ok((await debates.listDebates(project)).some((x) => x.id === d.id));
  assert.ok(!(await debates.listDebates(other)).some((x) => x.id === d.id), 'baska projede gorunmez');

  const result = await debates.convertDebate(d.id, { details: '', profiles: [], providers: [], emit: () => {} });
  assert.equal(result.isNew, false);
  assert.equal(result.file, path.join(project, 'docs', 'konsey', 'onbellek-ekleyelim-mi.md'));
  assert.ok(!fs.existsSync(path.join(project, '.git')), 'kullanicinin klasorune git acilmaz');

  const again = await debates.convertDebate(d.id, { details: '', profiles: [], providers: [], emit: () => {} });
  assert.equal(again.file, path.join(project, 'docs', 'konsey', 'onbellek-ekleyelim-mi-2.md'), 'eski dosyanin ustune yazilmaz');
});

test('acik ajan yoksa aciklayici not dusulur', async () => {
  const d = await debates.createDebate('Boş masa', null);
  await debates.advanceDebate(d.id, { profiles: [], providers: [], emit: () => {}, rounds: 1, summarize: true });
  const after = await debates.getDebate(d.id);
  assert.equal(after.messages.at(-1).from, 'orchestrator');
  assert.match(after.messages.at(-1).text, /açık ajan yok/);
  await debates.deleteDebate(d.id);
  assert.equal(await debates.getDebate(d.id), null);
});

test('konusma surerken silinen tartisma geri yazilmaz', async () => {
  const d = await debates.createDebate('Silinecek fikir', null);
  const file = path.join(process.env.KONSEY_HOME, 'debates', `${d.id}.json`);
  const events = [];
  const running = debates.advanceDebate(d.id, { profiles: [], providers: [provider('fakea', 'http://127.0.0.1:9/v1')], emit: (e) => events.push(e), rounds: 1, summarize: true });
  await debates.deleteDebate(d.id);
  const before = events.length;
  await running;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(file), false);
  assert.equal(events.slice(before).filter((e) => e.type === 'debate:updated').length, 0);
});
