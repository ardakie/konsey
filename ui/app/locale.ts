/**
 * Statik HTML'in diline ve platformuna uyarlanmasi.
 *
 * index.html Turkce yazilir; Ingilizce karsiliklar oge uzerindeki data-en
 * (metin), data-en-title, data-en-placeholder ve data-en-aria-label
 * ozniteliklerindedir. Windows'ta kisayollardaki ⌘ isareti Ctrl olur.
 */
import { lang } from '../../src/shared/i18n';
import { api } from './api';

export const IS_MAC = (api.platform || 'darwin') === 'darwin';

/** Kisayol metni: ⌘N → Ctrl+N (Mac disinda). */
export function shortcut(text: string): string {
  return IS_MAC ? text : text.replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+');
}

export function applyStaticLocale(root: ParentNode = document): void {
  document.documentElement.lang = lang();
  document.body.classList.add(IS_MAC ? 'platform-mac' : 'platform-other');
  if (api.platform === 'win32') document.body.classList.add('platform-win');

  if (lang() === 'en') {
    root.querySelectorAll<HTMLElement>('[data-en]').forEach((el) => {
      el.textContent = el.dataset.en ?? el.textContent;
    });
    for (const attr of ['title', 'placeholder', 'aria-label', 'alt'] as const) {
      root.querySelectorAll<HTMLElement>(`[data-en-${attr}]`).forEach((el) => {
        el.setAttribute(attr, el.getAttribute(`data-en-${attr}`) ?? '');
      });
    }
  }

  if (!IS_MAC) {
    root.querySelectorAll<HTMLElement>('kbd').forEach((el) => {
      el.textContent = shortcut(el.textContent ?? '');
    });
    root.querySelectorAll<HTMLElement>('[title]').forEach((el) => {
      el.title = shortcut(el.title);
    });
  }
}
