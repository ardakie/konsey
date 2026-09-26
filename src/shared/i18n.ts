/**
 * Arayuz dili: sistem dili Turkce ise Turkce, degilse Ingilizce.
 *
 * Metinler anahtar sozlugu yerine yerinde cift olarak yazilir: L('Kaydet', 'Save').
 * Boylece metin kullanildigi yerde okunur ve ceviri eksik kalamaz.
 *
 * Dil surec basina bir kez belirlenir. Ana surecte bootstrap (setLang),
 * arayuzde preload'un verdigi deger kullanilir. Dil degisince uygulama
 * yeniden baslatilir; bu yuzden L() modul seviyesinde de guvenle cagrilabilir.
 */
export type Lang = 'tr' | 'en';

export function normalizeLang(value: string | null | undefined): Lang {
  return String(value ?? '').toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

function initial(): Lang {
  const g = globalThis as { konsey?: { lang?: string }; navigator?: { language?: string }; location?: { search?: string }; document?: unknown };
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  if (env.KONSEY_LANG) return normalizeLang(env.KONSEY_LANG);
  if (g.konsey?.lang) return normalizeLang(g.konsey.lang);
  // Tarayici onizlemesi: ?lang=en ile dil denenebilir.
  const param = g.location?.search ? new URLSearchParams(g.location.search).get('lang') : null;
  if (param) return normalizeLang(param);
  // Node 21+ da navigator tanimlar; yalnizca gercek bir sayfada kullanilir.
  if (g.document && g.navigator?.language) return normalizeLang(g.navigator.language);
  return normalizeLang(env.LC_ALL || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale);
}

let current: Lang = initial();

export function setLang(value: Lang): void {
  current = value;
}

export function lang(): Lang {
  return current;
}

/** Tarih/sayi bicimleri icin BCP 47 etiketi. */
export function locale(): string {
  return current === 'tr' ? 'tr-TR' : 'en-US';
}

/** Metnin o anki dildeki hali. */
export function L(tr: string, en: string): string {
  return current === 'tr' ? tr : en;
}

/** Modellere verilen dil talimati: kullaniciya hangi dilde yazilacagi. */
export function replyLanguage(): string {
  return current === 'tr'
    ? 'Kullanıcıya Türkçe yaz (kullanıcı başka bir dilde yazdıysa onun dilini kullan).'
    : 'Write to the user in English (if the user writes in another language, use that language).';
}
