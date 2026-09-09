/**
 * Arayuzu Electron acmadan denemek icin sahte kopru.
 *
 * Yalnizca window.konsey yokken devreye girer; paketlenmis uygulamada
 * gercek kopru her zaman vardir, bu dosyaya hic ugranmaz.
 */
import type { KonseyEvent, RunPhase, RunRecord, Task } from '../src/shared/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AGENTS = [
  { agent: 'claude', available: true, detail: 'CLI bulundu: /opt/homebrew/bin/claude' },
  { agent: 'codex', available: true, detail: 'CLI bulundu: ChatGPT.app/Contents/Resources/codex' },
  { agent: 'antigravity', available: true, detail: 'Language server 127.0.0.1:50102' },
  { agent: 'provider:orfi', available: false, detail: 'API anahtarı Keychain’de yok.' },
];

function makeTasks(): Task[] {
  return [
    {
      id: 't1',
      title: 'Giriş akışını ekle',
      detail: 'E-posta ve parola ile giriş; oturum saklama.',
      scope: ['src/auth/'],
      dependsOn: [],
      complexity: 'high',
      requiresVisual: false,
      suggestedAgent: 'claude',
      assignedTo: 'claude',
      status: 'claimed',
    },
    {
      id: 't2',
      title: 'Doğrulama yardımcıları',
      detail: 'E-posta ve parola kurallarını doğrulayan saf fonksiyonlar.',
      scope: ['src/lib/validate.ts'],
      dependsOn: [],
      complexity: 'medium',
      requiresVisual: false,
      suggestedAgent: 'codex',
      assignedTo: 'codex',
      status: 'claimed',
    },
    {
      id: 't3',
      title: 'README güncelle',
      detail: 'Kurulum ve giriş bölümünü yaz.',
      scope: ['README.md'],
      dependsOn: [],
      complexity: 'low',
      requiresVisual: false,
      suggestedAgent: 'antigravity',
      assignedTo: 'antigravity',
      status: 'claimed',
    },
  ];
}

export function createMockApi(): any {
  let emit: (e: KonseyEvent) => void = () => {};

  const run: RunRecord = {
    id: 'demo1234',
    projectDir: '/Users/ardakie/Projects/ornek',
    prompt: '',
    phase: 'planning',
    startedAt: Date.now(),
    baseBranch: 'main',
    baseCommit: 'abc1234',
    integrationBranch: null,
    tasks: [],
    claims: [],
    workspaces: [],
    merges: [],
  };

  async function phase(p: RunPhase, ms: number): Promise<void> {
    run.phase = p;
    emit({ type: 'run:phase', runId: run.id, phase: p });
    await sleep(ms);
  }

  async function simulate(prompt: string): Promise<void> {
    run.prompt = prompt;
    run.tasks = [];
    emit({ type: 'run:started', run: structuredClone(run) });

    await phase('planning', 1500);
    emit({ type: 'stream', runId: run.id, agent: 'claude', chunk: 'Plan hazırlanıyor…', at: Date.now() });
    await sleep(1200);

    run.tasks = makeTasks();
    emit({ type: 'run:updated', run: structuredClone(run) });

    await phase('claiming', 1400);
    for (const a of ['claude', 'codex', 'antigravity'] as const) {
      emit({ type: 'stream', runId: run.id, agent: a, chunk: `${a}: görevleri inceliyorum`, at: Date.now() });
    }
    await sleep(1500);

    await phase('arbitrating', 1200);
    await phase('executing', 200);

    for (const task of run.tasks) task.status = 'running';
    emit({ type: 'run:updated', run: structuredClone(run) });

    // Yazma animasyonunu besleyen sahte cikti akisi.
    for (let i = 0; i < 22; i++) {
      for (const task of run.tasks) {
        if (task.status !== 'running' || !task.assignedTo) continue;
        emit({
          type: 'stream',
          runId: run.id,
          agent: task.assignedTo,
          chunk: `${task.id}: dosya düzenleniyor (${i + 1})`,
          at: Date.now(),
        });
      }
      if (i === 12) {
        run.tasks[2].status = 'failed';
        run.tasks[2].error = 'Kota doldu';
        const retryAt = Date.now() + 2 * 60 * 60 * 1000;
        emit({
          type: 'agent:status', runId: run.id, agent: 'antigravity', status: 'sleeping',
          reason: 'Kota doldu', retryAt, retryHint: '2 hours',
        });
        emit({ type: 'log', runId: run.id, agent: 'antigravity', level: 'warn', text: 'Kota doldu — Codex devralıyor', at: Date.now() });
        emit({ type: 'run:updated', run: structuredClone(run) });
      }
      await sleep(320);
    }

    for (const task of run.tasks) if (task.status === 'running') task.status = 'succeeded';
    emit({ type: 'run:updated', run: structuredClone(run) });

    await phase('merging', 1400);
    run.integrationBranch = 'konsey/demo1234/integration';

    await phase('reviewing', 1600);
    run.review = {
      reviewer: 'codex',
      verdict: 'approved',
      summary: 'Planlanan iki görev tamamlanmış ve değişiklikler tutarlı. README görevi kota nedeniyle yapılamadı.',
      findings: ['README güncellemesi eksik kaldı', 'Parola kuralları testlerle karşılanıyor'],
      raw: '',
    };
    run.phase = 'done';
    emit({ type: 'run:finished', run: structuredClone(run) });
  }

  return {
    availability: async () => AGENTS,
    pickImages: async () => [],
    imagesFromPaths: async () => [],
    saveImage: async () => ({ path: '/tmp/mock.png', name: 'mock.png', dataUrl: '' }),
    filePath: () => '',
    loadConfig: async () => ({
      profiles: [],
      providers: [{ slug: 'orfi', label: 'Orfi', baseUrl: 'https://ornek/v1', model: 'deepseek', strengths: '', enabled: true, canWriteCode: true, maxTokens: 8000 }],
      coordinator: null,
      reviewer: null,
      recentProjects: ['/Users/ardakie/Projects/ornek'],
    }),
    saveConfig: async () => true,
    setProviderKey: async () => true,
    hasProviderKey: async () => false,
    testProvider: async () => ({ ok: true, models: ['deepseek-v4-flash'] }),
    pickProject: async () => ({ dir: '/Users/ardakie/Projects/ornek', isGit: true }),
    openPath: async () => {},
    startRun: async ({ prompt }: { prompt: string }) => {
      await simulate(prompt);
      return { ok: true, record: run };
    },
    cancelRun: async () => true,
    onEvent: (handler: (e: KonseyEvent) => void) => {
      emit = handler;
      return () => {
        emit = () => {};
      };
    },
  };
}
