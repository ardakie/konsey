/**
 * Konsey CLI — arayuzden bagimsiz test ve kullanim.
 *
 *   node dist/src/cli.js doctor
 *   node dist/src/cli.js run <proje-dizini> "<istek>"
 */
import { checkAvailability } from './core/discovery';
import { Orchestrator } from './core/orchestrator';
import { AGENT_LABEL } from './core/adapters';
import { L } from './shared/i18n';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const AGENT_COLOR: Record<string, string> = {
  claude: C.cyan,
  codex: C.green,
  antigravity: C.blue,
  orchestrator: C.yellow,
};

async function doctor(): Promise<number> {
  console.log(`${C.bold}${L('Konsey — ajan durumu', 'Konsey — agent status')}${C.reset}\n`);
  const avail = await checkAvailability();
  let allOk = true;
  for (const a of avail) {
    const mark = a.available ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`${mark} ${C.bold}${AGENT_LABEL[a.agent]}${C.reset}`);
    console.log(`  ${C.dim}${a.detail}${C.reset}`);
    if (!a.available) allOk = false;
  }
  console.log();
  if (!allOk) {
    console.log(`${C.yellow}${L('Bazı ajanlar kullanılamıyor. Konsey kalan ajanlarla çalışır.', 'Some agents are unavailable. Konsey will work with the rest.')}${C.reset}`);
  }
  return allOk ? 0 : 1;
}

async function run(projectDir: string, prompt: string): Promise<number> {
  const orch = new Orchestrator();

  orch.bus.on((ev) => {
    if (ev.type === 'log') {
      const color = AGENT_COLOR[ev.agent] ?? '';
      const level = ev.level === 'error' ? C.red : ev.level === 'warn' ? C.yellow : '';
      console.log(`${color}[${ev.agent}]${C.reset} ${level}${ev.text}${C.reset}`);
    } else if (ev.type === 'run:phase') {
      console.log(`\n${C.bold}── ${ev.phase.toUpperCase()} ──${C.reset}`);
    }
  });

  const controller = new AbortController();
  process.on('SIGINT', () => {
    console.log(`\n${C.yellow}${L('İptal ediliyor...', 'Cancelling...')}${C.reset}`);
    controller.abort();
  });

  const providers = [
    {
      slug: 'nvidia',
      label: 'NVIDIA (Llama 3 70B)',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'meta/llama-3.1-70b-instruct',
      strengths: 'Arayuz ve on yuz calismasi, tarayicida dogrulama, gorsel kontrol, dokumantasyon, genis kod tabaninda kesif. (Antigravity gorevlerini ustlenir)',
      enabled: true,
      canWriteCode: true,
      maxTokens: 4000,
    }
  ];

  const record = await orch.start({ projectDir, prompt, signal: controller.signal, providers });

  console.log(`\n${C.bold}── ${L('SONUÇ', 'RESULT')} ──${C.reset}`);
  console.log(`${L('Durum', 'Status')}: ${record.phase}`);
  if (record.error) console.log(`${C.red}${L('Hata', 'Error')}: ${record.error}${C.reset}`);
  if (record.integrationBranch) console.log(`${L('Entegrasyon dalı', 'Integration branch')}: ${record.integrationBranch}`);
  for (const t of record.tasks) {
    const icon = t.status === 'succeeded' ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`  ${icon} ${t.id} (${t.assignedTo}) ${t.title}`);
  }
  if (record.review) {
    console.log(`\n${L('İnceleme', 'Review')} (${record.review.reviewer}): ${record.review.verdict}`);
    console.log(record.review.summary);
    for (const f of record.review.findings) console.log(`  • ${f}`);
  }
  return record.phase === 'done' ? 0 : 1;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'doctor' || !cmd) {
    process.exitCode = await doctor();
    return;
  }
  if (cmd === 'run') {
    const [dir, ...promptParts] = rest;
    if (!dir || promptParts.length === 0) {
      console.error(L('Kullanım: konsey run <proje-dizini> "<istek>"', 'Usage: konsey run <project-dir> "<request>"'));
      process.exitCode = 2;
      return;
    }
    process.exitCode = await run(dir, promptParts.join(' '));
    return;
  }
  console.error(L(`Bilinmeyen komut: ${cmd}`, `Unknown command: ${cmd}`));
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
