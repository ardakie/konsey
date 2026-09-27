/** Tartisma rolleri: ana surec istemlerde, arayuz etiketlerde kullanir. */
import { L } from './i18n';
import type { AgentId, DebateRole } from './types';

/** Iki ya da daha fazla ajanda roller bu sirayla dagitilir. */
export const ROLE_ORDER: DebateRole[] = ['builder', 'critic', 'user', 'pragmatist'];

export function roleName(role: DebateRole): string {
  switch (role) {
    case 'builder': return L('Mimar', 'Architect');
    case 'critic': return L('Eleştirmen', 'Critic');
    case 'user': return L('Kullanıcı sesi', 'User advocate');
    case 'pragmatist': return L('Pragmatist', 'Pragmatist');
    default: return L('Çok yönlü', 'All-round');
  }
}

/** Istemde ajana verilen gorev tanimi (ajanlar Turkce istemle calisir). */
export function roleBrief(role: DebateRole): string {
  switch (role) {
    case 'builder':
      return 'Fikri nasıl inşa edeceğini düşün: teknik yaklaşım, mimari, kullanılacak araçlar ve ilk sürümün kapsamı.';
    case 'critic':
      return 'Fikrin zayıf yanlarını, risklerini, gözden kaçan zorlukları ve daha basit alternatifleri bul. Nazik ama dürüst ol; boş övgü yapma.';
    case 'user':
      return 'Hedef kullanıcıyı düşün: gerçekten bir ihtiyaç var mı, kullanıcı neyi değerli bulur, neyi kullanmaz, benzer ürünler neler ve bunlardan nasıl ayrışır.';
    case 'pragmatist':
      return 'Kapsamı küçült: işe yarayan en küçük sürüm ne, önce ne yapılmalı, ne sonraya kalmalı, kabaca ne kadar emek ister.';
    default:
      return 'Fikri her yönüyle değerlendir: nasıl yapılır, riskleri neler, kullanıcıya değeri ne, en küçük işe yarar sürüm ne.';
  }
}

/** Ajanlara rol verir; bir ajan tartisma boyunca ayni rolde kalir. */
export function assignRoles(existing: Record<string, DebateRole> | undefined, speakers: AgentId[]): Record<string, DebateRole> {
  if (speakers.length === 1 && !existing?.[speakers[0]]) return { ...existing, [speakers[0]]: 'all' };
  const roles: Record<string, DebateRole> = { ...existing };
  for (const agent of speakers) {
    if (roles[agent] && roles[agent] !== 'all') continue;
    const used = (role: DebateRole) => speakers.filter((a) => a !== agent && roles[a] === role).length;
    roles[agent] = ROLE_ORDER.reduce((best, role) => (used(role) < used(best) ? role : best), ROLE_ORDER[0]);
  }
  return roles;
}

/** Turkce karakterleri sadelestirip klasor adi yapar. */
export function slugify(text: string): string {
  const slug = text
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'I')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'konsey-proje';
}

