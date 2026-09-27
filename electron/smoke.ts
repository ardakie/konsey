/**
 * `--smoke-test`: paketlenmis uygulamanin gercekten acildigini denetler
 * (CI'da macOS ve Windows uzerinde calisir). Pencere yuklenir, arayuz
 * cizilir, ajan kesfi hatasiz tamamlanir; sonra uygulama 0 koduyla kapanir.
 */
import { app, type BrowserWindow } from 'electron';
import { checkAvailability } from '../src/core/discovery';

export const SMOKE = process.argv.includes('--smoke-test');

export function runSmoke(win: BrowserWindow): void {
  const errors: string[] = [];
  const fail = (why: string) => {
    console.error(`[smoke] FAIL: ${why}`);
    app.exit(1);
  };
  const timer = setTimeout(() => fail('timeout'), 60_000);

  win.webContents.on('console-message', (_e, level, message) => {
    // ResizeObserver uyarisi zararsizdir; tarayicilar hata duzeyinde bildirir.
    if (level >= 3 && !message.includes('ResizeObserver loop')) errors.push(message);
  });
  win.webContents.on('render-process-gone', (_e, details) => fail(`renderer gone: ${details.reason}`));
  win.webContents.once('did-fail-load', (_e, code, description) => fail(`load failed: ${code} ${description}`));
  win.webContents.once('did-finish-load', async () => {
    try {
      // Arayuz baslangic isini bitirsin.
      await new Promise((r) => setTimeout(r, 4000));
      const rendered = await win.webContents.executeJavaScript(
        "document.querySelector('#flow')?.children.length ?? 0",
      );
      // Tartis modu: IPC kanali yanit verir, yeni tartisma ekrani cizilir.
      const debates = await win.webContents.executeJavaScript(
        "window.konsey.listDebates(null).then((list) => Array.isArray(list))",
      );
      const debateScreen = await win.webContents.executeJavaScript(
        "document.getElementById('new-debate').click(); new Promise((r) => { let n = 0; const t = setInterval(() => { const ok = Boolean(document.querySelector('#flow .debate-new')); if (ok || ++n > 50) { clearInterval(t); r(ok); } }, 100); })",
      );
      console.log(`[smoke] debates: ${debates} · debate screen: ${debateScreen}`);
      if (!debates || !debateScreen) return fail(`debate mode did not load ${errors.join(' | ')} ${await win.webContents.executeJavaScript("document.getElementById('thread-title')?.textContent + ' | ' + (document.querySelector('#flow')?.firstElementChild?.className ?? '')")}`);
      const agents = await checkAvailability();
      console.log(`[smoke] flow nodes: ${rendered}`);
      console.log(`[smoke] agents: ${agents.map((a) => `${a.agent}=${a.available}`).join(', ')}`);
      if (!rendered) return fail('UI did not render');
      if (errors.length) return fail(`renderer errors: ${errors.join(' | ')}`);
      clearTimeout(timer);
      console.log('[smoke] OK');
      app.exit(0);
    } catch (error) {
      fail((error as Error).message);
    }
  });
}
