/**
 * Ajan ciktilarindaki hata metinlerini siniflandirir.
 *
 * Uc ayri abonelikle calisirken birinin kotasinin dolmasi ya da oturumunun
 * duswmesi olagan bir durum. Bunlari "genel hata"dan ayirmak, orkestratorun
 * o ajani devre disi birakip isini digerlerine dagitabilmesini saglar.
 */
import { L } from '../../shared/i18n';
import type { FailureKind } from '../../shared/types';

const AUTH_PATTERNS = [
  /oauth session expired/i,
  /could not be refreshed/i,
  /not (?:logged in|authenticated)/i,
  /please (?:run )?.{0,20}login/i,
  /unauthorized/i,
  /401/,
  /invalid (?:api key|credentials|token)/i,
  /authentication (?:failed|error)/i,
];

const QUOTA_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /quota (?:exceeded|exhausted)/i,
  /out of credits/i,
  /insufficient credits/i,
  /too many requests/i,
  /429/,
  /upgrade to pro/i,
  /limit reached/i,
];

/** "try again at 1:02 AM" / "resets at 14:30" gibi ipuclarini yakalar. */
function extractRetryHint(text: string): string | undefined {
  const m =
    text.match(/try again (?:at|after) ([^.,\n)]{3,40})/i) ??
    text.match(/resets? (?:at|in) ([^.,\n)]{3,40})/i);
  return m ? m[1].trim() : undefined;
}

/** Saglayicinin insan-okur ipucunu arayuzde sayilabilecek bir zamana cevirir. */
export function retryHintToTimestamp(hint: string | undefined, now = Date.now()): number | undefined {
  if (!hint) return undefined;
  const relative = hint.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multiplier = unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000;
    return now + amount * multiplier;
  }

  // Saat-only ipuclari ("1:02 AM") bugune aittir; gecmisse ertesi gun kabul edilir.
  const clock = hint.match(/\b(\d{1,2}):(\d{2})(?:\s*([ap]m))?\b/i);
  if (clock && !/[/-]|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(hint)) {
    const date = new Date(now);
    let hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (clock[3]) {
      hour %= 12;
      if (clock[3].toLowerCase() === 'pm') hour += 12;
    }
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    return date.getTime();
  }

  const parsed = Date.parse(hint);
  return Number.isFinite(parsed) && parsed > now ? parsed : undefined;
}

export function classifyFailure(text: string): { kind: FailureKind; retryHint?: string } {
  const t = text.slice(0, 8000);
  // Kota once kontrol edilir: kota mesajlari bazen 401 gibi kodlar da tasir.
  if (QUOTA_PATTERNS.some((p) => p.test(t))) {
    return { kind: 'quota', retryHint: extractRetryHint(t) };
  }
  if (AUTH_PATTERNS.some((p) => p.test(t))) return { kind: 'auth' };
  return { kind: 'other' };
}

/** Kullaniciya gosterilecek, ne yapmasi gerektigini soyleyen mesaj. */
export function remedyFor(agent: string, kind: FailureKind, retryHint?: string): string {
  switch (kind) {
    case 'auth':
      return agent === 'claude'
        ? L('Claude oturumu düşmüş. Terminalde `claude` çalıştırıp /login ile yeniden giriş yapın.', 'Claude session has expired. Run `claude` in the terminal and log in again with /login.')
        : agent === 'codex'
          ? L('Codex oturumu düşmüş. ChatGPT uygulamasından çıkıp yeniden giriş yapın.', 'Codex session has expired. Sign out of the ChatGPT app and log in again.')
          : L('Antigravity oturumu düşmüş. Uygulamadan yeniden giriş yapın.', 'Antigravity session has expired. Log in again from the app.');
    case 'quota':
      return L(
        `Kota doldu.${retryHint ? ` Yeniden deneme: ${retryHint}.` : ''} Bu ajan bu çalışmada atlanacak.`,
        `Quota is full.${retryHint ? ` Retry: ${retryHint}.` : ''} This agent will be skipped for this run.`,
      );
    case 'timeout':
      return L('Zaman aşımı. Görev çok büyük olabilir; daha küçük parçalara bölmeyi deneyin.', 'Timed out. The task may be too large; try splitting it into smaller pieces.');
    case 'unavailable':
      return L('Ajan çalıştırılamıyor (uygulama kapalı ya da CLI bulunamadı).', 'The agent cannot be run (the app is closed or the CLI was not found).');
    case 'cancelled':
      return L('İptal edildi.', 'Cancelled.');
    default:
      return L('Bilinmeyen hata.', 'Unknown error.');
  }
}
