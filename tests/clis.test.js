const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildCliCommand, splitArgs, cleanOutput, CLI_PRESETS, presetFor, profileForPreset } = require('../dist/src/core/clis.js');
const { which } = require('../dist/src/core/env.js');
const { createActivityParser } = require('../dist/src/core/activity.js');
const { newer } = require('../dist/electron/updates.js');

test('arguman satiri tirnaklari koruyarak bolunur', () => {
  assert.deepEqual(splitArgs('run --yes "iki kelime" \'tek tirnak\' {prompt}'), ['run', '--yes', 'iki kelime', 'tek tirnak', '{prompt}']);
  assert.deepEqual(splitArgs(''), []);
});

test('ozel CLI: {prompt} varsa argumana, yoksa stdin e gider', () => {
  const withArg = buildCliCommand({ command: 'x', args: 'run {prompt} -m {model}' }, '/bin/x', 'merhaba dunya', 'write', 'gpt');
  assert.deepEqual(withArg, { command: '/bin/x', args: ['run', 'merhaba dunya', '-m', 'gpt'] });

  const viaStdin = buildCliCommand({ command: 'x', args: 'exec --quiet -m {model}' }, '/bin/x', 'istem', 'read');
  assert.deepEqual(viaStdin, { command: '/bin/x', args: ['exec', '--quiet'], stdin: 'istem' });
});

test('hazir sablonlar yazma ve okuma kiplerini ayirir, izin denetimini kapatmaz', () => {
  const gemini = presetFor('gemini');
  const read = buildCliCommand({ preset: 'gemini' }, 'gemini', 'P', 'read');
  const write = buildCliCommand({ preset: 'gemini' }, 'gemini', 'P', 'write', 'gemini-2.5-pro');
  assert.equal(read.stdin, 'P');
  assert.ok(read.args.includes('plan'));
  assert.ok(write.args.includes('auto_edit'));
  assert.deepEqual(write.args.slice(write.args.indexOf(gemini.modelFlag), write.args.indexOf(gemini.modelFlag) + 2), ['-m', 'gemini-2.5-pro']);

  const copilot = buildCliCommand({ preset: 'copilot' }, 'copilot', 'istem', 'write');
  assert.equal(copilot.args.at(-1), 'istem');
  assert.equal(copilot.args.at(-2), '-p');

  for (const preset of CLI_PRESETS) {
    const all = [...preset.base, ...preset.read, ...preset.write].join(' ');
    assert.doesNotMatch(all, /dangerously|yolo|skip-permissions|allow-all/i, `${preset.id} izin denetimini kapatmamali`);
  }
});

test('profil sablondan olusur', () => {
  const profile = profileForPreset(presetFor('opencode'));
  assert.equal(profile.agent, 'cli:opencode');
  assert.equal(profile.cli.preset, 'opencode');
  assert.equal(profile.costTier, 'standard');
});

test('ANSI renk kodlari ve CR temizlenir', () => {
  assert.equal(cleanOutput('\u001b[32mhazir\u001b[0m\r\n'), 'hazir');
});

test('CLI duz metin ciktisi satir satir etkinlige doner', () => {
  const parse = createActivityParser('cli:gemini');
  assert.deepEqual(parse('ilk satir\nikin'), [{ text: 'ilk satir', tone: 'say' }]);
  assert.deepEqual(parse('ci satir\n{"json":1}\n'), [{ text: 'ikinci satir', tone: 'say' }]);
});

test('which PATH icindeki calistirilabiliri bulur', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konsey-which-'));
  const name = `konsey-test-bin-${process.pid}`;
  const file = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved}`;
  try {
    assert.equal(await which(name), file);
    assert.equal(await which(`${name}-yok`), null);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('surum karsilastirmasi', () => {
  assert.equal(newer('v1.0.1', '1.0.0'), true);
  assert.equal(newer('v1.2.10', '1.2.9'), true);
  assert.equal(newer('v1.0.0', '1.0.0'), false);
  assert.equal(newer('0.9.9', '1.0.0'), false);
});
