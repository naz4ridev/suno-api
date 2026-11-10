import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/lib/utils';
import { AccountError, normalizeAccountCookie, resolveAccount, type SunoAccount } from '@/lib/accounts';

export const MISSING_SUNO_COOKIE_ERROR =
  'Missing suno_cookie (no Suno account available). Provide `suno_cookie`, select an account with `account` (or the `x-suno-account` header), add one with POST /api/accounts or configure SUNO_COOKIE in the environment.';

export const MCP_ONLY_ACCOUNT_ERROR = (accountId: string) =>
  `Suno account "${accountId}" is connected only through the official Suno MCP (OAuth) and this endpoint has no ` +
  'MCP equivalent: it needs a cookie. Use the MCP tools (GET /api/mcp/tools, POST /api/mcp/call) or PATCH /api/accounts/{id} with a cookie.';

function decodeCookieValue(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value))
    return value;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeCookieValue(value: unknown): string | null {
  if (typeof value !== 'string')
    return null;

  const normalized = decodeCookieValue(value.trim());
  return normalized.length > 0 ? normalized : null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string')
    return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPayloadField(
  payload: Record<string, any> | FormData | null | undefined,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    const value = payload instanceof FormData
      ? payload.get(key)
      : payload && typeof payload === 'object'
        ? payload[key]
        : undefined;
    if (value !== undefined && value !== null && value !== '')
      return value;
  }
  return undefined;
}

/**
 * Account selector sent by the client: `account` / `account_id` (body, form-data or query)
 * or the `x-suno-account` header. Accepts an account id, label, email or Suno handle.
 */
export function resolveAccountSelector(
  req: NextRequest,
  payload?: Record<string, any> | FormData | null
): string | null {
  const url = new URL(req.url);
  return (
    normalizeText(readPayloadField(payload, 'account', 'account_id')) ||
    normalizeText(url.searchParams.get('account')) ||
    normalizeText(url.searchParams.get('account_id')) ||
    normalizeText(req.headers.get('x-suno-account')) ||
    null
  );
}

export type SunoAuth = {
  cookie: string;
  accountId?: string;
  source: 'request_cookie' | 'account';
};

/**
 * Resolves the Suno credentials for a request.
 * Precedence: explicit cookie (suno_cookie / x-suno-cookie) > selected account > default account.
 * Throws AccountError (status 404/409) when a selected account does not exist or is disabled.
 */
export function resolveSunoAuth(
  req: NextRequest,
  payload?: Record<string, any> | FormData | null
): SunoAuth | null {
  const url = new URL(req.url);
  const explicitCookie =
    normalizeCookieValue(readPayloadField(payload, 'suno_cookie')) ||
    normalizeCookieValue(url.searchParams.get('suno_cookie')) ||
    normalizeCookieValue(req.headers.get('x-suno-cookie')) ||
    normalizeCookieValue(req.headers.get('suno-cookie'));

  if (explicitCookie) {
    return {
      cookie: normalizeAccountCookie(explicitCookie) || explicitCookie,
      source: 'request_cookie'
    };
  }

  const account = resolveAccount(resolveAccountSelector(req, payload));
  if (!account)
    return null;
  if (!account.cookie)
    throw new AccountError(MCP_ONLY_ACCOUNT_ERROR(account.id), 409);

  return { cookie: account.cookie, accountId: account.id, source: 'account' };
}

/** The registered account serving this request, or null when the request brings its own cookie. */
export function resolveSelectedAccount(
  req: NextRequest,
  payload?: Record<string, any> | FormData | null
): SunoAccount | null {
  const url = new URL(req.url);
  const explicitCookie =
    readPayloadField(payload, 'suno_cookie') ||
    url.searchParams.get('suno_cookie') ||
    req.headers.get('x-suno-cookie') ||
    req.headers.get('suno-cookie');
  return explicitCookie ? null : resolveAccount(resolveAccountSelector(req, payload));
}

/** `transport` (body/form, query) or `x-suno-transport` header: auto | cookie | mcp. */
export function readTransportField(req: NextRequest, payload?: Record<string, any> | FormData | null): string | null {
  const value = readPayloadField(payload, 'transport') ?? new URL(req.url).searchParams.get('transport') ?? req.headers.get('x-suno-transport');
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

export function resolveSunoCookie(
  req: NextRequest,
  payload?: Record<string, any> | FormData | null
): string | null {
  return resolveSunoAuth(req, payload)?.cookie ?? null;
}

export function missingSunoCookieResponse() {
  return new NextResponse(JSON.stringify({ error: MISSING_SUNO_COOKIE_ERROR }), {
    status: 400,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

/**
 * Optional protection for account management: when SUNO_ACCOUNTS_ADMIN_TOKEN is set,
 * mutating /api/accounts calls must send it in the `x-admin-token` header.
 */
export function requireAccountsAdmin(req: NextRequest): NextResponse | null {
  const expected = process.env.SUNO_ACCOUNTS_ADMIN_TOKEN?.trim();
  if (!expected)
    return null;

  if (req.headers.get('x-admin-token')?.trim() === expected)
    return null;

  return new NextResponse(JSON.stringify({ error: 'Invalid or missing x-admin-token' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}
