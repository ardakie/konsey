/**
 * Sag paneldeki "Onizleme": gomulu web tarayicisi (WebContentsView) ve iOS Simulator
 * ekran goruntusu. Tarayici yerel bir gorunum oldugu icin konumu buradan bildirilir.
 */
import { L } from '../src/shared/i18n';

export function setupPreview(): void {
  const api = (window as any).konsey;
  const $ = (id: string) => document.getElementById(id)!;
  let mode: 'browser' | 'sim' = 'browser';
  let loaded = false;
  let capturing = false;
  const status = (value: string) => {
    $('preview-status').textContent = value;
  };

  const visible = () =>
    !$('preview-panel').hidden &&
    !document.querySelector('.stage')?.classList.contains('chat-closed') &&
    mode === 'browser' &&
    loaded &&
    !($('settings') as HTMLDialogElement).open &&
    !document.querySelector('.menu:not([hidden])');

  let queued = false;
  let last = '';
  const bounds = () => {
    if (!api || queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const r = $('browser-surface').getBoundingClientRect();
      const show = visible();
      const next = { x: r.x, y: r.y, width: show ? r.width : 0, height: show ? r.height : 0 };
      const key = JSON.stringify(next);
      // Yalnizca konum degistiginde ana surece bildir.
      if (key === last) return;
      last = key;
      void api.browser('bounds', next).catch((e: Error) => status(e.message));
    });
  };

  const select = async (next: 'browser' | 'sim') => {
    mode = next;
    $('browser-tab').classList.toggle('is-on', next === 'browser');
    $('sim-tab').classList.toggle('is-on', next === 'sim');
    $('browser-panel').hidden = next !== 'browser';
    $('sim-panel').hidden = next !== 'sim';
    bounds();
    if (next === 'sim') {
      try {
        if (!api) throw new Error(L('Simulator masaüstü uygulamasında kullanılabilir.', 'Simulator is only available in the desktop app.'));
        const list = await api.simulator('list');
        const selectEl = $('sim-devices') as HTMLSelectElement;
        selectEl.replaceChildren(...list.map((d: any) => new Option(`${d.name} · ${d.state === 'Booted' ? L('açık', 'on') : L('kapalı', 'off')}`, d.udid)));
        status(list.length ? '' : L('Xcode üzerinden bir iOS runtime yükle.', 'Install an iOS runtime via Xcode.'));
      } catch (e) {
        status((e as Error).message);
      }
    }
  };

  $('browser-tab').onclick = () => void select('browser');
  $('sim-tab').onclick = () => void select('sim');
  $('browser-address').onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (!api) throw new Error(L('Tarayıcı masaüstü uygulamasında kullanılabilir.', 'Browser is only available in the desktop app.'));
      status(L('Yükleniyor…', 'Loading…'));
      loaded = true;
      bounds();
      const url = await api.browser('go', ($('browser-url') as HTMLInputElement).value.trim());
      if (url) ($('browser-url') as HTMLInputElement).value = url;
      status('');
    } catch (e) {
      loaded = false;
      bounds();
      status((e as Error).message);
    }
  };
  for (const action of ['back', 'forward', 'reload']) {
    $(`browser-${action}`).onclick = () => void api?.browser(action).catch((e: Error) => status(e.message));
  }
  $('sim-open').onclick = async () => {
    try {
      status(L('Cihaz açılıyor…', 'Starting device…'));
      await api.simulator('boot', ($('sim-devices') as HTMLSelectElement).value);
      status(L('Ekran hazırlanıyor…', 'Preparing screen…'));
    } catch (e) {
      status((e as Error).message);
    }
  };

  setInterval(async () => {
    if (!api || mode !== 'sim' || $('preview-panel').hidden || capturing) return;
    const id = ($('sim-devices') as HTMLSelectElement).value;
    if (!id) return;
    capturing = true;
    try {
      const src = await api.simulator('screen', id);
      const img = $('sim-screen') as HTMLImageElement;
      img.hidden = !src;
      if (src) {
        img.src = src;
        status('');
      }
    } catch (e) {
      status((e as Error).message);
    } finally {
      capturing = false;
    }
  }, 2000);

  // Panel gizlenince, ayarlar ya da bir menu acilinca yerel gorunum da gizlenmeli.
  new ResizeObserver(bounds).observe($('browser-surface'));
  new MutationObserver(bounds).observe(document.body, {
    attributes: true,
    subtree: true,
    attributeFilter: ['open', 'hidden', 'class'],
  });
  window.addEventListener('resize', bounds);
}
