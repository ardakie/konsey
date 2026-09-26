/**
 * Entegrasyonlar: GitHub, Supabase, Sentry, Stripe, PostHog, Notion ve
 * kullanicinin kendi MCP sunucusu.
 *
 * Kullanici bir kez token girer; token sistemin guvenli deposunda durur
 * (secrets.ts), ayar dosyasina yazilmaz. Calisma aninda servisler ajanlara
 * MCP sunucusu olarak verilir:
 *   - Claude: gecici --mcp-config dosyasi (0600, tur bitince silinir) ve
 *     yalnizca bu sunucularin araclarina izin.
 *   - Codex: -c mcp_servers.* ayarlari; token ortam degiskeniyle gecer,
 *     komut satirinda gorunmez. Codex'e yalnizca HTTP sunuculari verilir.
 * Desteklenen yerlerde varsayilan salt okunurdur.
 */
import { L } from '../shared/i18n';
import type { IntegrationConfig } from '../shared/types';

export interface IntegrationDef {
  id: string;
  label: string;
  /** Kisa aciklama: ajan bu baglantiyla ne yapabilir. */
  blurb: () => string;
  /** Token'in alindigi sayfa. */
  tokenUrl: string;
  tokenHint: string;
  /** Salt okunur kip destekleniyor mu. */
  readOnly: boolean;
  /** MCP sunucusu: HTTP ya da yerel komut. */
  server: (token: string, readOnly: boolean) =>
    | { type: 'http'; url: string }
    | { type: 'stdio'; command: string; args: string[]; tokenEnv: string };
  /** Token'i dogrulayan hafif istek. */
  test: (token: string) => Promise<{ ok: boolean; detail: string }>;
}

async function probe(url: string, headers: Record<string, string>, pick?: (body: any) => string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Konsey', ...headers }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) {
      return { ok: false, detail: res.status === 401 || res.status === 403 ? L('Token geçersiz ya da yetkisi yetersiz.', 'Token is invalid or lacks permission.') : `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: true, detail: pick?.(body) || L('Bağlantı çalışıyor.', 'Connection works.') };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'github',
    label: 'GitHub',
    blurb: () => L('Depolar, issue’lar, pull request’ler ve Actions.', 'Repositories, issues, pull requests and Actions.'),
    tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
    tokenHint: 'github_pat_…',
    readOnly: true,
    server: (_t, readOnly) => ({ type: 'http', url: `https://api.githubcopilot.com/mcp/${readOnly ? 'readonly' : ''}` }),
    test: (token) => probe('https://api.github.com/user', { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, (b) => b.login && `@${b.login}`),
  },
  {
    id: 'supabase',
    label: 'Supabase',
    blurb: () => L('Veritabanı tabloları, SQL, loglar ve projeler.', 'Database tables, SQL, logs and projects.'),
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    tokenHint: 'sbp_…',
    readOnly: true,
    server: (_t, readOnly) => ({ type: 'http', url: `https://mcp.supabase.com/mcp${readOnly ? '?read_only=true' : ''}` }),
    test: (token) => probe('https://api.supabase.com/v1/projects', { Authorization: `Bearer ${token}` }, (b) =>
      Array.isArray(b) ? L(`${b.length} proje`, `${b.length} projects`) : ''),
  },
  {
    id: 'sentry',
    label: 'Sentry',
    blurb: () => L('Hatalar, olaylar ve performans sorunları.', 'Errors, events and performance issues.'),
    tokenUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    tokenHint: 'sntryu_…',
    readOnly: false,
    server: () => ({ type: 'stdio', command: 'npx', args: ['-y', '@sentry/mcp-server@latest'], tokenEnv: 'SENTRY_ACCESS_TOKEN' }),
    test: (token) => probe('https://sentry.io/api/0/organizations/', { Authorization: `Bearer ${token}` }, (b) =>
      Array.isArray(b) && b[0]?.slug ? b.map((o: any) => o.slug).slice(0, 3).join(', ') : ''),
  },
  {
    id: 'stripe',
    label: 'Stripe',
    blurb: () => L('Müşteriler, ödemeler, abonelikler. Kısıtlı (rk_) anahtar önerilir.', 'Customers, payments, subscriptions. A restricted (rk_) key is recommended.'),
    tokenUrl: 'https://dashboard.stripe.com/apikeys',
    tokenHint: 'rk_test_…',
    readOnly: false,
    server: () => ({ type: 'http', url: 'https://mcp.stripe.com' }),
    test: (token) => probe('https://api.stripe.com/v1/balance', { Authorization: `Bearer ${token}` }, (b) =>
      b.livemode === false ? L('Test kipi', 'Test mode') : b.livemode ? L('Canlı kip', 'Live mode') : ''),
  },
  {
    id: 'posthog',
    label: 'PostHog',
    blurb: () => L('Ürün analitiği, özellik bayrakları, hatalar.', 'Product analytics, feature flags, errors.'),
    tokenUrl: 'https://us.posthog.com/settings/user-api-keys',
    tokenHint: 'phx_…',
    readOnly: false,
    server: () => ({ type: 'http', url: 'https://mcp.posthog.com/mcp' }),
    test: async (token) => {
      const us = await probe('https://us.posthog.com/api/users/@me/', { Authorization: `Bearer ${token}` }, (b) => b.email);
      return us.ok ? us : probe('https://eu.posthog.com/api/users/@me/', { Authorization: `Bearer ${token}` }, (b) => b.email);
    },
  },
  {
    id: 'notion',
    label: 'Notion',
    blurb: () => L('Sayfalar ve veritabanları (entegrasyona paylaşılanlar).', 'Pages and databases (those shared with the integration).'),
    tokenUrl: 'https://www.notion.so/profile/integrations',
    tokenHint: 'ntn_…',
    readOnly: false,
    server: () => ({ type: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], tokenEnv: 'NOTION_TOKEN' }),
    test: (token) => probe('https://api.notion.com/v1/users/me', { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' }, (b) => b.name ?? b.bot?.workspace_name),
  },
];

export function integrationDef(id: string): IntegrationDef | undefined {
  return INTEGRATIONS.find((d) => d.id === id);
}

export function secretAccount(id: string): string {
  return `integration:${id}`;
}

/** Calisma anindaki baglanti: sunucu tanimi ve token (yalnizca ana surecte). */
export interface ActiveIntegration {
  id: string;
  label: string;
  readOnly: boolean;
  token: string;
  server: ReturnType<IntegrationDef['server']>;
}

/** Ayarlardaki acik entegrasyonlari token'lariyla cozer. */
export async function resolveIntegrations(
  list: IntegrationConfig[] | undefined,
  getSecret: (account: string) => Promise<string | null>,
): Promise<ActiveIntegration[]> {
  const out: ActiveIntegration[] = [];
  for (const cfg of list ?? []) {
    if (!cfg.enabled) continue;
    const token = await getSecret(secretAccount(cfg.id));
    if (cfg.id.startsWith('custom-')) {
      if (!cfg.url) continue;
      out.push({ id: cfg.id, label: cfg.label ?? cfg.id, readOnly: false, token: token ?? '', server: { type: 'http', url: cfg.url } });
      continue;
    }
    const def = integrationDef(cfg.id);
    if (!def || !token) continue;
    const readOnly = def.readOnly && cfg.readOnly !== false;
    out.push({ id: def.id, label: def.label, readOnly, token, server: def.server(token, readOnly) });
  }
  return out;
}

/** MCP sunucu adi: harf, rakam ve alt cizgi. */
export function serverName(id: string): string {
  return `konsey_${id.replace(/[^a-z0-9]/gi, '_')}`;
}

export function tokenEnvName(id: string): string {
  return `KONSEY_MCP_${id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
}

/** Claude --mcp-config icerigi. */
export function claudeMcpConfig(list: ActiveIntegration[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const item of list) {
    const s = item.server;
    mcpServers[serverName(item.id)] = s.type === 'http'
      ? { type: 'http', url: s.url, ...(item.token ? { headers: { Authorization: `Bearer ${item.token}` } } : {}) }
      : { type: 'stdio', command: s.command, args: s.args, env: { [s.tokenEnv]: item.token } };
  }
  return { mcpServers };
}

/** Codex -c ayarlari ve token ortam degiskenleri. Yerel (stdio) sunucular verilmez. */
export function codexMcpArgs(list: ActiveIntegration[]): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const item of list) {
    if (item.server.type !== 'http') continue;
    const name = serverName(item.id);
    args.push('-c', `mcp_servers.${name}.url=${JSON.stringify(item.server.url)}`);
    // Codex exec onay soramaz; yalnizca kullanicinin bagladigi bu sunucunun araclari onayli sayilir.
    args.push('-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`);
    if (item.token) {
      const envName = tokenEnvName(item.id);
      env[envName] = item.token;
      args.push('-c', `mcp_servers.${name}.bearer_token_env_var=${JSON.stringify(envName)}`);
    }
  }
  return { args, env };
}

/** Ajana verilen not: hangi servisler bagli ve nasil kullanilir. */
export function integrationNote(list: ActiveIntegration[], agent: string): string {
  const usable = agent === 'codex' ? list.filter((i) => i.server.type === 'http') : list;
  if (!usable.length) return '';
  const names = usable.map((i) => `${i.label}${i.readOnly ? L(' (salt okunur)', ' (read-only)') : ''}`).join(', ');
  return L(
    `BAĞLI SERVİSLER: ${names}. Bunlara ${usable.map((i) => serverName(i.id)).join(', ')} MCP araçlarıyla erişebilirsin. İş gerektiriyorsa kullan; bir servis yetkisi yetmezse hangi iznin eksik olduğunu açıkça söyle, tahmin yürütme.`,
    `CONNECTED SERVICES: ${names}. You can reach them through the ${usable.map((i) => serverName(i.id)).join(', ')} MCP tools. Use them when the work needs it; if a permission is missing, say exactly which one instead of guessing.`,
  );
}
