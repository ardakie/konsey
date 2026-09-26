import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { L } from '../shared/i18n';
import type { ValidationOutcome } from '../shared/types';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 12_000;

type Check = { bin: string; args: string[]; label: string };

async function checksFor(dir: string): Promise<Check[]> {
  const checks: Check[] = [];
  const packageFile = path.join(dir, 'package.json');
  if (existsSync(packageFile)) {
    try {
      const pkg = JSON.parse(await readFile(packageFile, 'utf8')) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      if (scripts.verify) {
        checks.push({ bin: 'npm', args: ['run', 'verify'], label: 'npm run verify' });
      } else {
        if (scripts.typecheck) checks.push({ bin: 'npm', args: ['run', 'typecheck'], label: 'npm run typecheck' });
        if (scripts.test && !/no test specified/i.test(scripts.test)) {
        checks.push({ bin: 'npm', args: ['test'], label: 'npm test' });
        } else if (scripts.build) {
          checks.push({ bin: 'npm', args: ['run', 'build'], label: 'npm run build' });
        }
        if (scripts.lint && checks.length < 2) checks.push({ bin: 'npm', args: ['run', 'lint'], label: 'npm run lint' });
      }
    } catch {
      return [];
    }
  } else if (existsSync(path.join(dir, 'Cargo.toml'))) {
    checks.push({ bin: 'cargo', args: ['test'], label: 'cargo test' });
  } else if (existsSync(path.join(dir, 'Package.swift'))) {
    checks.push({ bin: 'swift', args: ['test'], label: 'swift test' });
  } else if (
    existsSync(path.join(dir, 'pyproject.toml')) ||
    existsSync(path.join(dir, 'pytest.ini')) ||
    existsSync(path.join(dir, 'setup.cfg'))
  ) {
    checks.push({ bin: 'python3', args: ['-m', 'pytest', '-q'], label: 'python3 -m pytest -q' });
  }
  return checks.slice(0, 2);
}

export async function validateProject(dir: string): Promise<ValidationOutcome> {
  const checks = await checksFor(dir);
  if (!checks.length) {
    return { ok: true, commands: [], summary: L('Otomatik doğrulama komutu bulunamadı.', 'No automated validation command found.') };
  }

  const commands: ValidationOutcome['commands'] = [];
  for (const check of checks) {
    const started = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(check.bin, check.args, {
        cwd: dir,
        timeout: 10 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CI: '1' },
      });
      commands.push({
        command: check.label,
        ok: true,
        output: (stdout + stderr).slice(-MAX_OUTPUT),
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      commands.push({
        command: check.label,
        ok: false,
        output: `${e.stdout ?? ''}${e.stderr ?? e.message ?? ''}`.slice(-MAX_OUTPUT),
        durationMs: Date.now() - started,
      });
      break;
    }
  }

  const ok = commands.every((command) => command.ok);
  return {
    ok,
    commands,
    summary: commands.map((command) => `${command.ok ? L('GEÇTİ', 'PASSED') : L('KALDI', 'FAILED')}: ${command.command}`).join(' · '),
  };
}
