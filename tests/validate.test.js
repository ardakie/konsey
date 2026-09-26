const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { validateProject } = require('../dist/src/core/validate.js');

test('projenin kendi kalite komutunu calistirir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'konsey-validate-'));
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    const result = await validateProject(dir);
    assert.equal(result.ok, true);
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0].command, 'npm test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('basarisiz kalite komutunu teslimata izin vermeyecek sekilde raporlar', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'konsey-validate-'));
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "process.exit(2)"' },
    }));
    const result = await validateProject(dir);
    assert.equal(result.ok, false);
    assert.equal(result.commands[0].ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
