import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import {
  authorizeUrl,
  createPkce,
  decodeTokenClaims,
  exchangeAuthorizationCode,
  linkWithSessionToken,
  mcpOps,
  registerOAuthClient,
  revokeOAuthToken,
  SunoMcpClient,
  SunoMcpError,
  type SunoMcpTokens
} from '@suno-sdk';
import {
  AccountError,
  accountsStoreDir,
  getAccount,
  getDefaultAccountId,
  listAccounts,
  suggestAccountId,
  type SunoAccount,
  upsertStoreAccount
} from '@/lib/accounts';
import { readTransportField, resolveSelectedAccount } from '@/lib/apiAuth';
import { getSunoProxy } from '@/lib/egress';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

/**
 * suno-api's side of the official Suno MCP: one MCP client per account, tokens persisted in the account store.
 * Cookie accounts are linked on first use (their Clerk session approves the connection); OAuth accounts come
 * from the browser flow below.
 */

// SUNO_MCP_URL / SUNO_OAUTH_URL only exist to point tests at a fake Suno.
const mcpOptions = () => ({
  proxy: getSunoProxy(),
  ...(process.env.SUNO_MCP_URL ? { mcpUrl: process.env.SUNO_MCP_URL } : {}),
  ...(process.env.SUNO_OAUTH_URL ? { oauthUrl: process.env.SUNO_OAUTH_URL } : {})
});

const globalForMcp = global as unknown as {
  sunoMcpClients?: Map<string, SunoMcpClient>;
  sunoMcpLinks?: Map<string, Promise<SunoMcpTokens>>;
};
const clients = globalForMcp.sunoMcpClients ||= new Map();
const links = globalForMcp.sunoMcpLinks ||= new Map();

/** Stores new tokens for an account and revokes the ones they replace (best effort, in the background). */
function saveTokens(accountId: string, tokens: SunoMcpTokens | null): SunoAccount {
  const previous = getAccount(accountId)?.mcp;
  const account = upsertStoreAccount({ id: accountId, mcp: tokens });
  if (previous && previous.refresh_token !== tokens?.refresh_token && previous.access_token !== tokens?.access_token)
    void revokeOAuthToken(previous, mcpOptions());
  return account;
}

async function tokensFor(account: SunoAccount): Promise<SunoMcpTokens> {
  if (account.mcp)
    return account.mcp;
  if (!account.cookie)
    throw new AccountError(`Suno account "${account.id}" has neither a cookie nor a Suno MCP connection`, 409);

  let pending = links.get(account.id);
  if (!pending) {
    pending = (async () => {
      const api = await sunoApi(account.cookie, account.id);
      const tokens = await linkWithSessionToken(await api.getSessionToken(), mcpOptions());
      saveTokens(account.id, tokens);
      unavailableUntil.delete(account.id);
      return tokens;
    })().finally(() => links.delete(account.id));
    links.set(account.id, pending);
  }
  return pending;
}

/** MCP client of an account (links cookie accounts to the MCP the first time). */
export async function mcpClientFor(account: SunoAccount): Promise<SunoMcpClient> {
  const cached = clients.get(account.id);
  if (cached)
    return cached;

  const client = new SunoMcpClient(await tokensFor(account), {
    ...mcpOptions(),
    // Refreshed tokens replace the stored ones; the old refresh token is already spent, nothing to revoke.
    onTokens: tokens => {
      if (getAccount(account.id))
        upsertStoreAccount({ id: account.id, mcp: tokens });
    }
  });
  clients.set(account.id, client);
  return client;
}

/** Forgets the cached client (account removed, tokens replaced or revoked). */
export function evictMcpClient(accountId: string) {
  clients.delete(accountId);
}

/**
 * Links a cookie account to the MCP now (its Clerk session approves the connection). `relink` revokes the
 * current grant first. Returns the stored account.
 */
export async function linkMcp(account: SunoAccount, relink = false): Promise<SunoAccount> {
  if (!account.cookie)
    throw new AccountError(`Account "${account.id}" has no cookie to approve a Suno MCP connection with; use POST /api/accounts/mcp/authorize`, 409);
  if (account.mcp && !relink)
    return account;
  if (account.mcp) {
    await disconnectMcp(account);
    account = upsertStoreAccount({ id: account.id, mcp: null });
  }
  try {
    await tokensFor(account);
  } catch (error: any) {
    upsertStoreAccount({ id: account.id, mcp_error: { at: new Date().toISOString(), error: String(error?.message || error).slice(0, 300) } });
    throw error;
  }
  return getAccount(account.id) as SunoAccount;
}

/** Drops an account's MCP connection: forgets the client and revokes its grant at Suno. */
export async function disconnectMcp(account: SunoAccount): Promise<boolean> {
  evictMcpClient(account.id);
  return account.mcp ? revokeOAuthToken(account.mcp, mcpOptions()) : false;
}

/**
 * Runs `fn` with the account's MCP client. When the grant is gone (401 after a refresh attempt), a cookie
 * account is re-linked once; an OAuth-only account must be connected again.
 */
export async function withMcp<T>(account: SunoAccount, fn: (client: SunoMcpClient) => Promise<T>): Promise<T> {
  try {
    return await fn(await mcpClientFor(account));
  } catch (error) {
    if (!(error instanceof SunoMcpError) || error.status !== 401)
      throw error;
    evictMcpClient(account.id);
    if (!account.cookie)
      throw new AccountError(
        `The Suno MCP connection of account "${account.id}" expired or was revoked: connect it again with POST /api/accounts/mcp/authorize`,
        401
      );
    const relinked = upsertStoreAccount({ id: account.id, mcp: null });
    return fn(await mcpClientFor(relinked));
  }
}

/** Credits and plan from the MCP `account-usage` tool, in the shape of /api/get_limit. */
export function mcpCredits(account: SunoAccount) {
  return withMcp(account, client => mcpOps.accountCredits(client));
}

/* Transport policy */

export type SunoTransport = 'auto' | 'cookie' | 'mcp';
const TRANSPORTS: SunoTransport[] = ['auto', 'cookie', 'mcp'];
const asTransport = (value: unknown) => TRANSPORTS.find(item => item === value);

/** Per request (`transport`, `x-suno-transport`), else SUNO_TRANSPORT, else auto. */
export function requestedTransport(req: NextRequest, payload?: Record<string, any> | FormData | null): SunoTransport {
  return asTransport(readTransportField(req, payload)) ?? asTransport(process.env.SUNO_TRANSPORT?.trim().toLowerCase()) ?? 'auto';
}

// A cookie account whose MCP connection failed goes back to the web API for a while instead of retrying each call.
const MCP_RETRY_AFTER_MS = 10 * 60_000;
const unavailableUntil = (global as any).sunoMcpUnavailable as Map<string, number> ?? ((global as any).sunoMcpUnavailable = new Map<string, number>());

function markUnavailable(account: SunoAccount, error: any) {
  unavailableUntil.set(account.id, Date.now() + MCP_RETRY_AFTER_MS);
  const message = error?.message || String(error);
  console.warn(`Suno MCP unavailable for account ${account.id}, using the web API for 10 min: ${message}`);
  if (getAccount(account.id))
    upsertStoreAccount({ id: account.id, mcp_error: { at: new Date().toISOString(), error: message.slice(0, 300) } });
}

/**
 * Which account, if any, should serve this request through the MCP:
 *  - an account connected only through Suno MCP OAuth: always (`required`);
 *  - a cookie account: when the transport is `mcp` (required) or `auto` on a route whose MCP version is
 *    equivalent (`auto`), unless its MCP connection failed recently;
 *  - a request with its own cookie, or transport `cookie`: never.
 */
export function mcpAccountFor(
  req: NextRequest,
  payload: Record<string, any> | FormData | null | undefined,
  auto: boolean
): { account: SunoAccount; required: boolean } | null {
  const account = resolveSelectedAccount(req, payload);
  if (!account)
    return null;
  if (!account.cookie)
    return account.mcp ? { account, required: true } : null;
  const transport = requestedTransport(req, payload);
  if (transport === 'cookie')
    return null;
  if (transport === 'mcp')
    return { account, required: true };
  if (!auto || (unavailableUntil.get(account.id) ?? 0) > Date.now())
    return null;
  return { account, required: false };
}

/**
 * For routes that also work through the official MCP. Runs `fn` with the account's MCP client when the
 * transport policy says so and answers (header `x-suno-transport: mcp`); returns null to take the web API path.
 * A cookie account falls back to the web API when its MCP connection cannot be opened or the request needs
 * something the MCP lacks (`unsupported`). Errors of the tool call itself (credits, not found…) are answered.
 *
 * `auto: false` keeps cookie accounts on the web API unless they ask for `transport: mcp`: routes whose MCP
 * answer differs in shape or meaning (stems, analysis, models, voices, health/credits, uploads).
 */
export async function viaMcp(
  req: NextRequest,
  payload: Record<string, any> | FormData | null | undefined,
  fn: (client: SunoMcpClient, account: SunoAccount) => Promise<any>,
  status: number | ((data: any) => number) = 200,
  { auto = true }: { auto?: boolean } = {}
): Promise<Response | null> {
  const choice = mcpAccountFor(req, payload, auto);
  if (!choice)
    return null;
  const { account, required } = choice;

  if (!required) {
    try {
      await (await mcpClientFor(account)).connect();
    } catch (error) {
      markUnavailable(account, error);
      return null;
    }
  }

  let data: any;
  try {
    data = await withMcp(account, client => fn(client, account));
  } catch (error: any) {
    if (error?.unsupported && !required)
      return null;
    throw error;
  }
  return new Response(JSON.stringify(data), {
    status: typeof status === 'function' ? status(data) : status,
    headers: { 'Content-Type': 'application/json', 'x-suno-transport': 'mcp', ...corsHeaders }
  });
}

/* Browser OAuth flow: adds an account without a cookie. */

export type PendingAuthorization = {
  clientId: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  account: { id?: string; label?: string; make_default?: boolean; replace?: boolean };
};

const PENDING_TTL_MS = 10 * 60_000;

// Pending authorizations hold PKCE verifiers: kept next to the accounts file (mode 600), so a restart between
// "authorize" and "callback" does not lose them. Expired entries are pruned on every read.
const pendingFile = () => path.join(accountsStoreDir(), 'mcp-oauth-pending.json');

function readPending(): Record<string, PendingAuthorization> {
  try {
    const all = JSON.parse(fs.readFileSync(pendingFile(), 'utf8')) as Record<string, PendingAuthorization>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, pending]) => pending?.expiresAt > now));
  } catch {
    return {};
  }
}

function writePending(all: Record<string, PendingAuthorization>) {
  fs.mkdirSync(path.dirname(pendingFile()), { recursive: true });
  const tempPath = `${pendingFile()}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(all), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, pendingFile());
}

export async function startAuthorization(redirectUri: string, account: PendingAuthorization['account']) {
  const clientId = await registerOAuthClient(redirectUri, mcpOptions());
  const { verifier, challenge } = createPkce();
  const state = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + PENDING_TTL_MS;
  writePending({ ...readPending(), [state]: { clientId, verifier, redirectUri, expiresAt, account } });
  return {
    authorize_url: authorizeUrl({ clientId, redirectUri, state, challenge }),
    redirect_uri: redirectUri,
    expires_at: new Date(expiresAt).toISOString()
  };
}

/** Single use: the state is consumed whether or not the exchange succeeds. */
function takeAuthorization(state: string | null): PendingAuthorization {
  const all = readPending();
  const pending = state ? all[state] : undefined;
  if (state && pending) {
    delete all[state];
    writePending(all);
  }
  if (!pending)
    throw new AccountError('Unknown or expired authorization (start again with POST /api/accounts/mcp/authorize)', 400);
  return pending;
}

/**
 * Finishes the OAuth flow from the redirect's query (`code`, `state`, or `error`): exchanges the code with
 * the stored PKCE verifier, identifies the Suno user and stores the account. A user that is already
 * registered gets its MCP tokens refreshed instead of a duplicate account.
 */
export async function completeAuthorization(query: URLSearchParams): Promise<SunoAccount> {
  const pending = takeAuthorization(query.get('state'));
  const denied = query.get('error');
  if (denied)
    throw new AccountError(`Suno did not authorize the connection: ${query.get('error_description') || denied}`, 400);
  const code = query.get('code');
  if (!code)
    throw new AccountError('Missing code', 400);

  const tokens = await exchangeAuthorizationCode(
    { clientId: pending.clientId, code, verifier: pending.verifier, redirectUri: pending.redirectUri },
    mcpOptions()
  );
  try {
    // The token only carries `sub`; the handle comes from the MCP `account-me` tool.
    const me = await new SunoMcpClient(tokens, mcpOptions()).callToolJson('account-me');
    const user = { id: decodeTokenClaims(tokens.access_token).sub, handle: me?.handle, display_name: me?.display_name };
    const isSameUser = (account?: SunoAccount | null) =>
      Boolean(account && ((user.id && account.user?.id === user.id) || (user.handle && account.user?.handle === user.handle)));

    const { id: requestedId, label, make_default, replace } = pending.account;
    const sameUser = listAccounts().find(account => isSameUser(account));
    const id = requestedId || sameUser?.id || suggestAccountId(user, label);
    const target = getAccount(id);
    if (target && !isSameUser(target)) {
      // Never pair one user's cookie with another user's MCP grant.
      if (target.cookie)
        throw new AccountError(`Account "${id}" belongs to another Suno user (${target.user?.handle ?? 'unknown'}); use another id`, 409);
      if (!replace)
        throw new AccountError(`Account id already exists: ${id} (send replace=true to overwrite)`, 409);
    }

    let account = upsertStoreAccount({
      id,
      label,
      mcp: tokens,
      user: isSameUser(target) ? undefined : user,
      make_default: make_default || !getDefaultAccountId()
    });
    if (target?.mcp)
      void revokeOAuthToken(target.mcp, mcpOptions());
    evictMcpClient(id);
    if (!account.cookie) {
      const credits = await mcpCredits(account).catch(() => null);
      if (credits)
        account = upsertStoreAccount({
          id, last_check: { ok: true, at: new Date().toISOString(), credits_left: credits.credits_left, plan: credits.plan }
        });
    }
    return account;
  } catch (error) {
    // Nothing stored the new grant: do not leave it alive at Suno.
    if (!listAccounts().some(account => account.mcp?.refresh_token === tokens.refresh_token))
      void revokeOAuthToken(tokens, mcpOptions());
    throw error;
  }
}
