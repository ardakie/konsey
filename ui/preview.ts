export function setupPreview(): void {
  const api = (window as any).konsey;
  const $ = (id: string) => document.getElementById(id)!;
  let mode = 'browser';
  let loaded = false;
  let capturing = false;
  const status = (value: string) => { $('preview-status').textContent = value; };
  const bounds = () => {
    if (!api) return;
    const r = $('browser-surface').getBoundingClientRect();
    const visible = !$('preview-panel').hidden && mode === 'browser' && loaded && !(document.getElementById('settings') as HTMLDialogElement).open;
    void api.browser('bounds', { x: r.x, y: r.y, width: visible ? r.width : 0, height: visible ? r.height : 0 }).catch((e: Error) => status(e.message));
  };
  const select = async (next: string) => {
    mode = next;
    $('browser-panel').hidden = next !== 'browser';
    $('sim-panel').hidden = next !== 'sim';
    bounds();
    if (next === 'sim') {
      try {
        if (!api) throw new Error('Simulator masaüstü uygulamasında kullanılabilir.');
        const list = await api.simulator('list');
        const select = $('sim-devices') as HTMLSelectElement;
        select.replaceChildren(...list.map((d: any) => new Option(`${d.name} · ${d.state}`, d.udid)));
        status(list.length ? '' : 'Xcode üzerinden bir iOS runtime yükle.');
      } catch (e) { status((e as Error).message); }
    }
  };
  const setOpen = (open: boolean) => {
    $('preview-panel').hidden = !open;
    document.body.classList.toggle('preview-open', open);
    const toggle = $('preview-toggle');
    toggle.textContent = open ? 'Paneli gizle ◂' : 'Tarayıcı / iOS ▸';
    toggle.setAttribute('aria-expanded', String(open));
    bounds();
  };
  $('preview-toggle').onclick = () => setOpen($('preview-panel').hidden);
  $('preview-hide').onclick = () => setOpen(false);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('preview-panel').hidden) setOpen(false);
  });
  $('browser-tab').onclick = () => void select('browser');
  $('sim-tab').onclick = () => void select('sim');
  $('browser-address').onsubmit = async e => {
    e.preventDefault();
    try {
      if (!api) throw new Error('Tarayıcı masaüstü uygulamasında kullanılabilir.');
      status('Yükleniyor…'); loaded = true; bounds();
      await api.browser('go', ($('browser-url') as HTMLInputElement).value.trim()); status('');
    } catch (e) { loaded = false; bounds(); status((e as Error).message); }
  };
  for (const action of ['back', 'forward', 'reload']) $('browser-' + action).onclick = () => void api?.browser(action).catch((e: Error) => status(e.message));
  $('sim-open').onclick = async () => {
    try { status('Cihaz açılıyor…'); await api.simulator('boot', ($('sim-devices') as HTMLSelectElement).value); const choice = ($('sim-devices') as HTMLSelectElement).selectedOptions[0]; if (choice) choice.textContent = choice.textContent?.replace('Shutdown', 'Booted') ?? ''; status('Ekran hazırlanıyor…'); }
    catch (e) { status((e as Error).message); }
  };
  setInterval(async () => {
    if (!api || mode !== 'sim' || $('preview-panel').hidden || capturing) return;
    const id = ($('sim-devices') as HTMLSelectElement).value;
    if (!id) return;
    capturing = true;
    try { const src = await api.simulator('screen', id); const img = $('sim-screen') as HTMLImageElement; img.hidden = !src; if (src) { img.src = src; status(''); } }
    catch (e) { status((e as Error).message); }
    finally { capturing = false; }
  }, 2000);
  new ResizeObserver(bounds).observe($('browser-surface'));
  new MutationObserver(bounds).observe($('settings'), { attributes: true, attributeFilter: ['open'] });
}
