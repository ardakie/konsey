const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { prepareRepo, applyIntegration, isGitRepo, headCommit } = require('../dist/src/core/git.js');

const gitc = (dir, ...args) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });

test('duz ve bos bir klasor git deposuna cevrilir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konsey-plain-'));
  const result = await prepareRepo(dir);
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(await isGitRepo(dir), true);
  assert.ok(await headCommit(dir));

  const again = await prepareRepo(dir);
  assert.equal(again.created, false, 'hazir depoya dokunulmaz');
});

test('mevcut dosyalar ilk commite alinir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konsey-files-'));
  fs.writeFileSync(path.join(dir, 'not.txt'), 'merhaba');
  await prepareRepo(dir);
  assert.match(gitc(dir, 'ls-files'), /not\.txt/);
});

test('entegrasyon dali proje klasorune uygulanir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konsey-apply-'));
  await prepareRepo(dir);
  gitc(dir, 'checkout', '-q', '-b', 'konsey/x/integration');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>ok</h1>');
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'is');
  gitc(dir, 'checkout', '-q', 'main');
  assert.equal(fs.existsSync(path.join(dir, 'index.html')), false);

  const applied = await applyIntegration(dir, 'konsey/x/integration');
  assert.equal(applied.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>ok</h1>');
});

test('olmayan dal uygulanamaz ve hicbir sey bozulmaz', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konsey-noapply-'));
  await prepareRepo(dir);
  const applied = await applyIntegration(dir, 'yok/boyle/bir-dal');
  assert.equal(applied.ok, false);
});
