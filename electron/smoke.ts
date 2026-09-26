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
