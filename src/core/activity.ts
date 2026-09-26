/**
 * Ajanlarin ham ciktisini (stream-json, JSONL, eylem JSON'u) insan okur tek
 * satirlik etkinliklere cevirir: "src/app.ts dosyasini duzenliyor", "$ npm test".
 *
 * Arayuz ham JSON gostermez; akis bu satirlardan olusur.
 */
import { extractJson } from './json';
import { L } from '../shared/i18n';
import type { AgentId } from '../shared/types';

export interface Activity {
  text: string;
  tone: 'say' | 'tool' | 'think';
}

const MAX = 240;

function short(value: unknown, max = MAX): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function base(p: unknown): string {
  const text = String(p ?? '');
  const parts = text.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || text;
}

function claudeTool(name: string, input: any): Activity {
  switch (name) {
    case 'Read':
      return { text: L(`${base(input?.file_path)} okunuyor`, `Reading ${base(input?.file_path)}`), tone: 'tool' };
    case 'Write':
      return { text: L(`${base(input?.file_path)} yazılıyor`, `Writing ${base(input?.file_path)}`), tone: 'tool' };
    case 'Edit':
    case 'MultiEdit':
      return { text: L(`${base(input?.file_path)} düzenleniyor`, `Editing ${base(input?.file_path)}`), tone: 'tool' };
    case 'Bash':
      return { text: `$ ${short(input?.command, 160)}`, tone: 'tool' };
    case 'Grep':
      return { text: L(`"${short(input?.pattern, 60)}" aranıyor`, `Searching for "${short(input?.pattern, 60)}"`), tone: 'tool' };
    case 'Glob':
      return { text: L(`${short(input?.pattern, 80)} dosyaları listeleniyor`, `Listing files matching ${short(input?.pattern, 80)}`), tone: 'tool' };
    case 'TodoWrite':
    case 'TaskCreate':
      return { text: L('Yapılacaklar listesi güncellendi', 'Todo list updated'), tone: 'tool' };
    case 'WebFetch':
    case 'WebSearch':
      return { text: `Web: ${short(input?.url ?? input?.query, 100)}`, tone: 'tool' };
    default:
      return { text: L(`${name} aracı`, `${name} tool`), tone: 'tool' };
  }
}

function fromClaude(ev: any): Activity[] {
  if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) return [];
  const out: Activity[] = [];
  for (const block of ev.message.content) {
    if (block?.type === 'text' && block.text?.trim() && !isStructured(block.text)) out.push({ text: short(block.text), tone: 'say' });
    else if (block?.type === 'tool_use') out.push(claudeTool(block.name, block.input));
    else if (block?.type === 'thinking' && block.thinking?.trim()) out.push({ text: short(block.thinking, 160), tone: 'think' });
  }
  return out;
}

function fromCodex(ev: any, seen: Set<string>): Activity[] {
  const item = ev.item ?? ev.msg;
  if (!item) return [];
  const done = ev.type === 'item.completed';
  const started = ev.type === 'item.started';
  switch (item.type) {
    case 'agent_message':
      return done && item.text && !isStructured(item.text) ? [{ text: short(item.text), tone: 'say' }] : [];
    case 'reasoning':
      return done && item.text ? [{ text: short(item.text, 160), tone: 'think' }] : [];
    case 'command_execution': {
      const id = String(item.id ?? item.command);
      if (!(started || done) || seen.has(id)) return [];
      seen.add(id);
      return [{ text: `$ ${short(item.command, 160)}`, tone: 'tool' }];
    }
    case 'file_change':
      return done && Array.isArray(item.changes)
        ? item.changes.slice(0, 6).map((c: any) => ({
            text: L(
              `${base(c.path)} ${c.kind === 'add' ? 'oluşturuldu' : c.kind === 'delete' ? 'silindi' : 'düzenlendi'}`,
              `${base(c.path)} ${c.kind === 'add' ? 'created' : c.kind === 'delete' ? 'deleted' : 'edited'}`,
            ),
            tone: 'tool' as const,
          }))
        : [];
    case 'web_search':
      return done ? [{ text: L(`Web araması: ${short(item.query, 100)}`, `Web search: ${short(item.query, 100)}`), tone: 'tool' }] : [];
    case 'todo_list':
      return done ? [{ text: L('Yapılacaklar listesi güncellendi', 'Todo list updated'), tone: 'tool' }] : [];
    default:
      return [];
  }
}

/** Plan/talep/inceleme turlarinin JSON cevaplari akista ham gosterilmez. */
function isStructured(text: string): boolean {
  const t = text.trim();
  return t.startsWith('```') || t.startsWith('{') || t.startsWith('[');
}

function fromProviderAction(text: string): Activity[] {
  const action = extractJson<any>(text);
  if (!action?.action) return text.trim() && !isStructured(text) ? [{ text: short(text), tone: 'say' }] : [];
  switch (action.action) {
    case 'list_dir':
      return [{ text: L(`${action.path ?? '.'} klasörü listeleniyor`, `Listing folder ${action.path ?? '.'}`), tone: 'tool' }];
    case 'read_file':
      return [{ text: L(`${base(action.path)} okunuyor`, `Reading ${base(action.path)}`), tone: 'tool' }];
    case 'grep':
      return [{ text: L(`"${short(action.pattern, 60)}" aranıyor`, `Searching for "${short(action.pattern, 60)}"`), tone: 'tool' }];
    case 'write_file':
      return [{ text: L(`${base(action.path)} yazılıyor`, `Writing ${base(action.path)}`), tone: 'tool' }];
    case 'replace_text':
      return [{ text: L(`${base(action.path)} düzenleniyor`, `Editing ${base(action.path)}`), tone: 'tool' }];
    case 'run':
      return [{ text: `$ ${short(action.command, 160)}`, tone: 'tool' }];
    case 'copy_attachment':
      return [{ text: L(`Görsel ${base(action.path)} yoluna kopyalanıyor`, `Copying image to ${base(action.path)}`), tone: 'tool' }];
    case 'image_info':
      return [{ text: L('Ekli görsel inceleniyor', 'Examining attached image'), tone: 'tool' }];
    case 'finish':
      return action.summary ? [{ text: short(action.summary), tone: 'say' }] : [];
    default:
      return [];
  }
}

/**
 * Parca parca gelen ciktiyi satirlara bolup etkinlige cevirir.
 * Donen fonksiyon her parca icin cagrilir; tamamlanan satirlarin etkinliklerini dondurur.
 */
export function createActivityParser(agent: AgentId): (chunk: string) => Activity[] {
  let buffer = '';
  const seen = new Set<string>();
  const isProvider = agent.startsWith('provider:');

  if (isProvider) {
    // Saglayici dongusu her adimda eylem JSON'unun tamamini tek parca yollar.
    return (chunk) => {
      const text = chunk.trim();
      if (!text || /^--- (adım|adim|step) \d/.test(text) || text.startsWith('[Düşünüyor') || text.startsWith('[Thinking')) return [];
      return fromProviderAction(text);
    };
  }

  if (agent.startsWith('cli:')) {
    // Ek CLI'lar duz metin yazar: her tamamlanan satir bir etkinliktir.
    return (chunk) => {
      buffer += chunk.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\r/g, '');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      return lines
        .map((line) => line.trim())
        .filter((line) => line && !isStructured(line))
        .map((line) => ({ text: short(line), tone: 'say' as const }));
    };
  }

  if (agent === 'antigravity') {
    // Antigravity her cevabi tek parca yollar. Parca butun olarak ele alinir:
    // kod/JSON bloklari atilir, [dosya](file://...) baglantilari ada indirgenir.
    return (chunk) => {
      const text = chunk.trim();
      if (!text) return [];
      if (text.startsWith('[Konsey]')) return [{ text: short(text), tone: 'say' }];
      const plain = text
        .replace(/```[\s\S]*?(```|$)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
      if (!plain || isStructured(plain) || /^OZET:?$/i.test(plain)) return [];
      return [{ text: short(plain), tone: 'say' }];
    };
  }

  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    const out: Activity[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('{')) {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (agent === 'claude') out.push(...fromClaude(ev));
        else if (agent === 'codex') out.push(...fromCodex(ev, seen));
        continue;
      }
      // Konsey'in kendi notlari okunur metindir.
      if (line.startsWith('[Konsey]')) out.push({ text: short(line), tone: 'say' });
    }
    return out;
  };
}
