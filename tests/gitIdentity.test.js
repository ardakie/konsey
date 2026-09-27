const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

// Git kimligi hic ayarlanmamis bir bilgisayar: global ve sistem ayarlari yok sayilir.
test('git kimligi ayarsiz makinede Konsey commit atabilir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'konsey-noid-'));
  const emptyGlobal = path.join(dir, 'empty-gitconfig');
  await writeFile(emptyGlobal, '');
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM, e: process.env.EMAIL };
  process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  delete process.env.EMAIL;
  try {
    const { prepareRepo, commitWorkspace, git } = require('../dist/src/core/git.js');
    const repo = path.join(dir, 'repo');
    require('node:fs').mkdirSync(repo);
    await writeFile(path.join(repo, 'a.txt'), 'merhaba');
    const prepared = await prepareRepo(repo);
    assert.equal(prepared.ok, true, prepared.message);
    await writeFile(path.join(repo, 'b.txt'), 'yeni');
    const result = await commitWorkspace({ agent: 'claude', dir: repo, branch: 'main', isMainTree: false }, 'deneme');
    assert.equal(result.committed, true, result.error);
    const log = await git(repo, ['log', '-1', '--format=%cn']);
    assert.equal(log.stdout.trim(), 'Konsey');
  } finally {
    if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
    if (saved.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.s;
    if (saved.e !== undefined) process.env.EMAIL = saved.e;
    await rm(dir, { recursive: true, force: true });
  }
});
