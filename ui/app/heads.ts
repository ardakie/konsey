/**
 * Avatarlar: piksel ofisteki calisanlarin kafalari. Her ajan ofiste hangi
 * karakterse sohbette ve listelerde de ayni yuzle gorunur.
 */
const CHAR_COUNT = 6;

/** Ajan → karakter sayfasi. Hazir ajanlar sabit, saglayicilar siralarina gore. */
export function charIndexFor(agent: string, providerSlugs: string[]): number | null {
  if (agent === 'claude') return 0;
  if (agent === 'codex') return 1;
  if (agent === 'antigravity') return 2;
  if (agent.startsWith('provider:')) {
    const index = providerSlugs.indexOf(agent.slice('provider:'.length));
    return 3 + ((index < 0 ? 0 : index) % (CHAR_COUNT - 3));
  }
  if (agent.startsWith('cli:')) {
    // Ek CLI'lar saglayicilardan sonra siralanir; adlarina gore sabit kalir.
    let value = providerSlugs.length;
    for (const ch of agent) value = (value * 31 + ch.charCodeAt(0)) >>> 0;
    return 3 + (value % (CHAR_COUNT - 3));
  }
  return null;
}

/** Kafa, sprite sayfasinin ilk karesinden CSS arka plani olarak kirpilir (canvas gerekmez). */
export function headFor(index: number | null): string | null {
  return index === null ? null : `assets/characters/char_${index}.png`;
}
