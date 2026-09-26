/** DOM yardimcilari: guvenli eleman uretimi, simgeler, kucuk markdown, zaman bicimleri. */
import { L, locale } from '../../src/shared/i18n';

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; on?: Record<string, (event: any) => void> };

/**
 * Eleman uretir. Metin her zaman textContent olarak eklenir: ajan ciktisi
 * HTML olarak yorumlanmaz.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'on') {
        (node as any).__on = value;
        bindEvents(node);
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(node.style, value);
      } else if (key === 'dataset' && typeof value === 'object') {
        Object.assign(node.dataset, value);
      } else if (key in node && typeof value !== 'string') {
        (node as any)[key] = value;
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(node, children);
  return node;
}

/**
 * Olay dinleyicileri dugumun __on tablosu uzerinden cagrilir. Boylece morph()
 * eski dugumu korurken yeni cizimin dinleyicilerini devralabilir.
 */
function bindEvents(node: Element): void {
  const handlers = (node as any).__on as Record<string, (e: Event) => void> | undefined;
  if (!handlers) return;
  const bound: Set<string> = ((node as any).__bound ??= new Set());
  for (const name of Object.keys(handlers)) {
    if (bound.has(name)) continue;
    bound.add(name);
    node.addEventListener(name, (event) => ((node as any).__on?.[name] as ((e: Event) => void) | undefined)?.(event));
  }
}

function syncAttributes(a: Element, b: Element): void {
  for (const attr of Array.from(a.attributes)) {
    // Kullanicinin actigi <details> acik kalsin.
    if (attr.name === 'open' && a.tagName === 'DETAILS') continue;
    if (!b.hasAttribute(attr.name)) a.removeAttribute(attr.name);
  }
  for (const attr of Array.from(b.attributes)) {
    if (a.getAttribute(attr.name) !== attr.value) a.setAttribute(attr.name, attr.value);
  }
}

function patch(a: Node, b: Node): void {
  const sameKind =
    a.nodeType === b.nodeType &&
    a.nodeName === b.nodeName &&
    (!(a instanceof Element) || a.getAttribute('data-key') === (b as Element).getAttribute('data-key'));
  if (!sameKind) {
    a.parentNode?.replaceChild(b, a);
    return;
  }
  if (a.nodeType !== Node.ELEMENT_NODE) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  const ea = a as Element;
  const eb = b as Element;
  if (ea instanceof SVGElement) {
    if (ea.outerHTML !== eb.outerHTML) ea.replaceWith(eb);
    return;
  }
  syncAttributes(ea, eb);
  (ea as any).__on = (eb as any).__on;
  bindEvents(ea);
  morph(ea, Array.from(eb.childNodes));
}

/**
 * Kabin cocuklarini yeni dugum listesine esitler; ayni turdeki dugumler korunur.
 * Animasyonlar bastan baslamaz, kaydirma ve odak kaybolmaz.
 */
export function morph(parent: Element, next: Node[]): void {
  const current = Array.from(parent.childNodes);
  next.forEach((node, index) => {
    const existing = current[index];
    if (existing) patch(existing, node);
    else parent.appendChild(node);
  });
  for (let i = next.length; i < current.length; i++) current[i].remove();
}

function append(node: Node, children: (Child | Child[])[]): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

const ICONS: Record<string, string> = {
  compose: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  'folder-plus': '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  chevrons: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M15 3v18"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  'arrow-up': '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  sparkles: '<path d="M12 3l1.9 5.8L20 10.7l-6.1 1.9L12 18.5l-1.9-5.9L4 10.7l6.1-1.9z"/><path d="M19 3v4"/><path d="M21 5h-4"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  scale: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="m5 7-3 7a4 4 0 0 0 6 0Z"/><path d="m19 7-3 7a4 4 0 0 0 6 0Z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>',
  pixel: '<rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="9" y="9" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
};

export function icon(name: string, extraClass = ''): SVGSVGElement {
  const wrapper = document.createElement('span');
  wrapper.innerHTML = `<svg class="icon ${extraClass}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return wrapper.firstElementChild as SVGSVGElement;
}

/** HTML'deki data-icon yer tutucularini gercek simgelerle doldurur. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((node) => {
    if (node.firstElementChild) return;
    node.appendChild(icon(node.dataset.icon ?? ''));
    node.style.display = 'contents';
  });
}

// --------------------------------------------------------------- markdown

function inline(text: string, into: HTMLElement): void {
  // `kod`, **kalin**, *italik*, [baglanti](url) — hepsi textContent ile.
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\((https?:[^)\s]+)\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) into.append(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) into.append(h('code', null, token.slice(1, -1)));
    else if (token.startsWith('**')) into.append(h('strong', null, token.slice(2, -2)));
    else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']'));
      into.append(h('a', { href: match[2], target: '_blank', rel: 'noreferrer' }, label));
    } else into.append(h('em', null, token.slice(1, -1)));
    last = match.index! + token.length;
  }
  if (last < text.length) into.append(text.slice(last));
}

/** Ajan cevaplari icin kucuk ve guvenli markdown cizici. */
export function md(source: string): HTMLElement {
  const root = h('div', { class: 'md' });
  const lines = source.replace(/\r/g, '').split('\n');
  let i = 0;
  let list: HTMLElement | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const p = h('p');
    inline(para.join(' '), p);
    root.append(p);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      flushPara();
      list = null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      root.append(h('pre', null, h('code', null, body.join('\n'))));
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      flushPara();
      list = null;
      const node = h(heading[1].length <= 2 ? 'h2' : 'h3');
      inline(heading[2], node);
      root.append(node);
      i++;
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)/);
    if (bullet) {
      flushPara();
      const ordered = Boolean(bullet[1]);
      if (!list || (ordered ? list.tagName !== 'OL' : list.tagName !== 'UL')) {
        list = h(ordered ? 'ol' : 'ul');
        root.append(list);
      }
      const li = h('li');
      inline(bullet[2], li);
      list.append(li);
      i++;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      list = null;
      i++;
      continue;
    }
    list = null;
    para.push(line.trim());
    i++;
  }
  flushPara();
  return root;
}

// --------------------------------------------------------------- bicimler

export function relTime(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return L('şimdi', 'now');
  if (diff < 3_600_000) {
    const n = Math.round(diff / 60_000);
    return L(`${n} dk önce`, `${n} min ago`);
  }
  if (diff < 86_400_000) {
    const n = Math.round(diff / 3_600_000);
    return L(`${n} sa önce`, `${n} hr ago`);
  }
  if (diff < 2 * 86_400_000) return L('dün', 'yesterday');
  return new Date(at).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return L(`${s} sn`, `${s}s`);
  const m = Math.floor(s / 60);
  if (m < 60) return L(`${m} dk ${s % 60} sn`, `${m}m ${s % 60}s`);
  const h = Math.floor(m / 60);
  return L(`${h} sa ${m % 60} dk`, `${h}h ${m % 60}m`);
}

export function tokens(n: number): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function until(at?: number): string {
  if (!at) return '';
  const diff = at - Date.now();
  if (diff <= 0) return L('şimdi', 'now');
  const m = Math.round(diff / 60_000);
  if (m < 60) return L(`${m} dk sonra`, `in ${m} min`);
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return L(`${hrs} sa ${m % 60} dk sonra`, `in ${hrs} hr ${m % 60} min`);
  return new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

export function tildify(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

let toastTimer = 0;
export function toast(message: string, ms = 3200): void {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  node.style.animation = 'none';
  void node.offsetWidth;
  node.style.animation = '';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.hidden = true;
  }, ms);
}

/** Metin alanini icerigine gore buyutur. */
export function autosize(area: HTMLTextAreaElement, max: number): void {
  area.style.height = 'auto';
  area.style.height = `${Math.min(max, area.scrollHeight)}px`;
}
