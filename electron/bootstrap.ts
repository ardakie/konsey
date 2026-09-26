/**
 * Ana surecin ilk calisan modulu: dil ve PATH, diger moduller yuklenmeden
 * once belirlenir. main.ts bunu ilk satirda ice aktarir.
 */
import { app } from 'electron';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeLang, setLang, type Lang } from '../src/shared/i18n';
import { ensurePath } from '../src/core/env';

function preferredLang(): Lang {
  if (process.env.KONSEY_LANG) return normalizeLang(process.env.KONSEY_LANG);
  try {
    const config = JSON.parse(readFileSync(path.join(os.homedir(), '.konsey', 'config.json'), 'utf8'));
    const chosen = config?.ui?.language;
    if (chosen === 'tr' || chosen === 'en') return chosen;
  } catch {
    /* ilk acilis */
  }
  const system = app.getPreferredSystemLanguages?.()[0] || app.getLocale?.() || '';
  return normalizeLang(system);
}

export const LANG = preferredLang();
setLang(LANG);
void ensurePath();
