/**
 * Yeni surum denetimi: GitHub'daki son yayini uygulamanin surumuyle
 * karsilastirir. Imzasiz bir Mac uygulamasi kendini guncelleyemedigi icin
 * indirme sayfasi acilir; kurulum iki tiktir.
 */
import { app, ipcMain, shell } from 'electron';

const REPO = 'ardakie/konsey';
// Sitenin barindirildigi yerden bagimsiz: GitHub'daki son surum sayfasi.
export const DOWNLOAD_PAGE = 'https://github.com/ardakie/konsey/releases/latest';

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  url: string;
}

/** 1.2.10 > 1.2.9 gibi sayisal karsilastirma. */
export function newer(latest: string, current: string): boolean {
  const a = latest.replace(/^v/, '').split(/[.-]/).map((n) => Number(n) || 0);
  const b = current.replace(/^v/, '').split(/[.-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

let cached: { at: number; info: UpdateInfo } | null = null;

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion();
  if (cached && Date.now() - cached.at < 6 * 3600_000) return cached.info;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Konsey' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { tag_name?: string };
    const latest = body.tag_name ?? null;
    const info = { current, latest, available: Boolean(latest && newer(latest, current)), url: DOWNLOAD_PAGE };
    cached = { at: Date.now(), info };
    return info;
  } catch {
    // Cevrimdisi ya da henuz yayin yok: sessizce "guncel" kabul edilir.
    return { current, latest: null, available: false, url: DOWNLOAD_PAGE };
  }
}

export function registerUpdates(): void {
  ipcMain.handle('konsey:update:check', () => checkForUpdate());
  ipcMain.handle('konsey:update:open', async () => {
    await shell.openExternal(DOWNLOAD_PAGE);
    return true;
  });
}
