/**
 * Ek kodlama CLI'lari: Gemini CLI, Cursor Agent, GitHub Copilot CLI,
 * OpenCode, Qwen Code, Amp, Factory Droid, Aider ve kullanicinin kendi CLI'i.
 *
 * Hepsi ayni kaliba oturur: calisma klasorunde tek seferlik, etkilesimsiz bir
 * komut calisir; son cevap stdout'tan okunur. Her birinin "yalnizca oku" ve
 * "calisma klasorunde dosya duzenleyebilir" bayraklari ayri tutulur. Hicbir
 * sablon CLI'nin kendi izin denetimini kapatmaz.
 *
 * Makinede bulunan hazir CLI'lar ajan listesine kendiliginden eklenir.
 */
import { runProcess, failure } from './adapters/base';
import { classifyFailure } from './adapters/failures';
import { ensurePath, which } from './env';
import { L } from '../shared/i18n';
import type { AgentProfile, AgentRunRequest, AgentRunResult, CliAgentConfig } from '../shared/types';

export interface CliPreset {
  id: string;
  label: string;
  /** PATH'te aranacak komut adlari (ilk bulunan kullanilir). */
  bins: string[];
  /** Istemin verilisi: stdin ya da son arguman. */
  promptVia: 'stdin' | 'arg';
  /** Her calistirmada eklenen argumanlar ({prompt} ve {model} yer tutuculari). */
  base: string[];
  /** Salt okunur turlar (plan, inceleme, sohbet). */
  read: string[];
  /** Calisma klasorunde dosya yazabilen turlar. */
  write: string[];
  modelFlag?: string;
  /** Kipe gore eklenen ortam degiskenleri (or. Goose'un izin kipi). */
  env?: Partial<Record<'read' | 'write', Record<string, string>>>;
  /** Kurulum komutu (kullaniciya kopyalanir ya da terminalde acilir). */
  install: string;
  /** Giris/hesap baglama komutu. */
  login: string;
  docs: string;
  strengths: string;
  color: string;
}

export const CLI_PRESETS: CliPreset[] = [
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bins: ['gemini'],
    promptVia: 'stdin',
    base: ['--output-format', 'text', '-p', 'Follow the instructions above.'],
    read: ['--approval-mode', 'plan'],
    write: ['--approval-mode', 'auto_edit'],
    modelFlag: '-m',
    install: 'npm install -g @google/gemini-cli',
    login: 'gemini',
    docs: 'https://github.com/google-gemini/gemini-cli',
    strengths: 'Genis baglam penceresi, buyuk kod tabaninda kesif, dokumantasyon ve web aramasi.',
    color: '#4C8DF6',
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    bins: ['cursor-agent'],
    promptVia: 'arg',
    base: ['-p', '--output-format', 'text'],
    read: [],
    write: [],
    modelFlag: '--model',
    install: 'curl https://cursor.com/install -fsS | bash',
    login: 'cursor-agent login',
    docs: 'https://cursor.com/cli',
    strengths: 'Hizli kod duzenleme, on yuz ve TypeScript isleri.',
    color: '#9AA0AA',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    bins: ['copilot'],
    promptVia: 'arg',
    base: ['--no-color'],
    read: ['--deny-tool', 'write', '--allow-tool', 'shell(git:*)', '-p'],
    write: ['--allow-tool', 'write', '--allow-tool', 'shell(git:*)', '-p'],
    modelFlag: '--model',
    install: 'npm install -g @github/copilot',
    login: 'copilot',
    docs: 'https://github.com/github/copilot-cli',
    strengths: 'GitHub is akislari, genel kod degisiklikleri ve kod incelemesi.',
    color: '#8E6BE8',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bins: ['opencode'],
    promptVia: 'arg',
    base: ['run'],
    read: [],
    write: [],
    modelFlag: '-m',
    install: 'npm install -g opencode-ai',
    login: 'opencode auth login',
    docs: 'https://opencode.ai',
    strengths: 'Istedigin model saglayicisiyla genel kodlama isleri.',
    color: '#E8A33A',
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    bins: ['qwen'],
    promptVia: 'stdin',
    base: ['--output-format', 'text'],
    read: ['--approval-mode', 'plan'],
    write: ['--approval-mode', 'auto-edit'],
    modelFlag: '-m',
    install: 'npm install -g @qwen-code/qwen-code',
    login: 'qwen',
    docs: 'https://github.com/QwenLM/qwen-code',
    strengths: 'Ucuz ve hizli kod uretimi, betikler, basit ve orta isler.',
    color: '#6A5CF5',
  },
  {
    id: 'amp',
    label: 'Amp',
    bins: ['amp'],
    promptVia: 'arg',
    base: [],
    read: ['-x'],
    write: ['-x'],
    install: 'npm install -g @sourcegraph/amp',
    login: 'amp login',
    docs: 'https://ampcode.com',
    strengths: 'Cok adimli kodlama gorevleri ve refactor.',
    color: '#F25C54',
  },
  {
    id: 'droid',
    label: 'Factory Droid',
    bins: ['droid'],
    promptVia: 'arg',
    base: ['exec', '-o', 'text'],
    read: [],
    write: ['--auto', 'low'],
    modelFlag: '-m',
    install: 'npm install -g @factory/cli',
    login: 'droid',
    docs: 'https://docs.factory.ai/cli',
    strengths: 'Uctan uca ozellik gelistirme, test ve hata ayiklama.',
    color: '#E0773C',
  },
  {
    id: 'crush',
    label: 'Crush',
    bins: ['crush'],
    promptVia: 'stdin',
    base: ['run', '--quiet'],
    read: [],
    write: [],
    modelFlag: '-m',
    install: 'npm install -g @charmland/crush',
    login: 'crush',
    docs: 'https://github.com/charmbracelet/crush',
    strengths: 'Istedigin model saglayicisiyla terminalde hizli kodlama.',
    color: '#C86BF5',
  },
  {
    id: 'goose',
    label: 'Goose',
    bins: ['goose'],
    promptVia: 'arg',
    base: ['run', '-t'],
    read: [],
    write: [],
    // Okuma turlarinda arac kullanmaz; yazma turlarinda riskli adimlari Goose'un kendi denetimi ayiklar.
    env: { read: { GOOSE_MODE: 'chat' }, write: { GOOSE_MODE: 'smart_approve' } },
    install: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash',
    login: 'goose configure',
    docs: 'https://block.github.io/goose/',
    strengths: 'Genel amacli ajan: kod, betik ve arastirma isleri.',
    color: '#5B5B5B',
  },
  {
    id: 'aider',
    label: 'Aider',
    bins: ['aider'],
    promptVia: 'arg',
    base: ['--yes-always', '--no-suggest-shell-commands', '--no-auto-commits', '--no-pretty', '--no-check-update', '--no-show-release-notes'],
    read: ['--dry-run', '--message'],
    write: ['--message'],
    modelFlag: '--model',
    install: 'python -m pip install aider-install && aider-install',
    login: 'aider',
    docs: 'https://aider.chat',
    strengths: 'Mevcut dosyalarda hedefli duzenlemeler, kendi API anahtarinla her model.',
    color: '#3FA66B',
  },
];

export function presetFor(id: string | undefined): CliPreset | undefined {
  return CLI_PRESETS.find((p) => p.id === id);
}

export function cliSlug(agent: string): string {
  return agent.slice('cli:'.length);
}

/** Kullanicinin yazdigi arguman satirini parcalara ayirir (tirnaklari korur). */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}

/** Profildeki CLI tanimi: hazir sablon ya da kullanicinin kendi komutu. */
export interface ResolvedCli {
  command: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
}

function fill(args: string[], prompt: string, model?: string): { args: string[]; usedPrompt: boolean } {
  let usedPrompt = false;
  const out: string[] = [];
  for (const a of args) {
    if (a.includes('{model}')) {
      if (model) out.push(a.replace('{model}', model));
      // Model yoksa "-m {model}" ikilisinin bayragi da atilir.
      else if (a === '{model}' && out.at(-1)?.startsWith('-')) out.pop();
      continue;
    }
    if (a.includes('{prompt}')) {
      usedPrompt = true;
      out.push(a.replace('{prompt}', prompt));
      continue;
    }
    out.push(a);
  }
  return { args: out, usedPrompt };
}

export async function findCliBinary(cfg: CliAgentConfig): Promise<string | null> {
  await ensurePath();
  const preset = presetFor(cfg.preset);
  const names = cfg.command ? [cfg.command] : preset?.bins ?? [];
  for (const name of names) {
    const found = await which(name);
    if (found) return found;
  }
  return null;
}

export type CliAccess = 'read' | 'write';

export function buildCliCommand(cfg: CliAgentConfig, bin: string, prompt: string, access: CliAccess, model?: string): ResolvedCli {
  const preset = presetFor(cfg.preset);
  if (preset && !cfg.args) {
    const args = [...preset.base];
    if (preset.modelFlag && (model || cfg.model)) args.push(preset.modelFlag, (model || cfg.model)!);
    args.push(...preset[access]);
    const env = preset.env?.[access];
    if (preset.promptVia === 'arg') return { command: bin, args: [...args, prompt], ...(env ? { env } : {}) };
    return { command: bin, args, stdin: prompt, ...(env ? { env } : {}) };
  }
  const { args, usedPrompt } = fill(splitArgs(cfg.args ?? ''), prompt, model || cfg.model);
  return usedPrompt ? { command: bin, args } : { command: bin, args, stdin: prompt };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function cleanOutput(text: string): string {
  return text.replace(ANSI, '').replace(/\r/g, '').trim();
}

export async function runCliAgent(req: AgentRunRequest, profile: AgentProfile | undefined): Promise<AgentRunResult> {
  const cfg = profile?.cli;
  if (!cfg) return failure(req.agent, L('CLI tanımı bulunamadı.', 'CLI definition not found.'));
  const bin = await findCliBinary(cfg);
  const label = profile?.label ?? req.agent;
  if (!bin) return failure(req.agent, L(`${label} bulunamadı. Kurulu mu?`, `${label} was not found. Is it installed?`));

  const access: CliAccess = req.allowWrite ? 'write' : 'read';
  const cmd = buildCliCommand(cfg, bin, req.prompt, access, req.model);
  const res = await runProcess(cmd.command, cmd.args, {
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    stdin: cmd.stdin ?? '',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', ...(cmd.env ?? {}) },
    onChunk: req.onChunk,
  });

  const text = cleanOutput(res.stdout);
  const ok = res.exitCode === 0 && !res.timedOut && !res.aborted && text.length > 0;
  if (ok) {
    return { agent: req.agent, ok: true, text, raw: res.raw, exitCode: res.exitCode, durationMs: res.durationMs };
  }
  const classified = classifyFailure(`${text}\n${res.stderr}`);
  return {
    agent: req.agent,
    ok: false,
    text,
    raw: res.raw,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    error: res.timedOut
      ? L('Zaman aşımı', 'Timed out')
      : res.aborted
        ? L('İptal edildi', 'Cancelled')
        : cleanOutput(res.stderr).split('\n').slice(-3).join(' ').slice(0, 400) || text.slice(0, 400) || L(`${label} çıkış kodu ${res.exitCode}`, `${label} exited with code ${res.exitCode}`),
    failureKind: res.timedOut ? 'timeout' : res.aborted ? 'cancelled' : classified.kind,
    retryHint: classified.retryHint,
  };
}

/** Makinede kurulu hazir CLI'lar (yol ile birlikte). */
export async function detectInstalledClis(): Promise<{ preset: CliPreset; path: string }[]> {
  await ensurePath();
  const found: { preset: CliPreset; path: string }[] = [];
  for (const preset of CLI_PRESETS) {
    for (const bin of preset.bins) {
      const p = await which(bin);
      if (p) {
        found.push({ preset, path: p });
        break;
      }
    }
  }
  return found;
}

/** Hazir sablondan yeni ajan profili. */
export function profileForPreset(preset: CliPreset): AgentProfile {
  return {
    agent: `cli:${preset.id}`,
    label: preset.label,
    strengths: preset.strengths,
    enabled: true,
    costTier: 'standard',
    cli: { preset: preset.id },
  };
}
