/** Piksel ofisi arayuzden bagimsiz denemek icin kucuk bir sahne. */
import { PixelOffice, type AgentActivity } from './office';

const canvas = document.getElementById('office') as HTMLCanvasElement;
const office = new PixelOffice(canvas);

const agents = [
  { id: 'claude', label: 'Claude', color: '#c96442' },
  { id: 'codex', label: 'Codex', color: '#2f7d62' },
  { id: 'antigravity', label: 'Antigravity', color: '#3f6fb5' },
  { id: 'provider:orfi', label: 'Orfi', color: '#7c5cb0' },
  { id: 'provider:nvidia', label: 'NVIDIA', color: '#76b900' },
  { id: 'provider:yerel', label: 'Yerel', color: '#c98a2f' },
];

(window as any).office = office;
office.setAgents(agents);
void office.load().then(() => office.start());

// Yazma animasyonu akis parcalariyla besleniyor; burada taklit ediliyor.
setInterval(() => {
  for (const a of agents) office.pulse(a.id);
}, 400);

const states: AgentActivity[] = [
  'idle', 'arriving', 'working', 'reading', 'thinking', 'done', 'blocked', 'offline',
];

const controls = document.getElementById('controls')!;
for (const state of states) {
  const btn = document.createElement('button');
  btn.textContent = state;
  btn.addEventListener('click', () => {
    for (const a of agents) office.setActivity(a.id, state);
  });
  controls.append(btn);
}

const mixed = document.createElement('button');
mixed.textContent = 'karisik';
mixed.addEventListener('click', () => {
  office.setActivity('claude', 'working');
  office.setActivity('codex', 'reading');
  office.setActivity('antigravity', 'thinking');
  office.setActivity('provider:orfi', 'blocked');
});
controls.append(mixed);

// Ilk goruntude anlamli bir sahne olsun.
office.setActivity('claude', 'working');
office.setActivity('codex', 'reading');
office.setActivity('antigravity', 'thinking');
office.setActivity('provider:orfi', 'blocked');
