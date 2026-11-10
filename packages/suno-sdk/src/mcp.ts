import axios, { type AxiosInstance } from 'axios';
import { createHash, randomBytes } from 'node:crypto';
import { noProxy, type SunoProxy } from './runtime.ts';

/**
 * Suno's official MCP server (api.suno.com/mcp) and the OAuth 2.1 server behind it.
 *
 * An account reaches it two ways:
 *  - OAuth: the user approves the connection on suno.com/link-account (authorizeUrl + exchangeAuthorizationCode).
 *  - Cookie: the Clerk session JWT of a cookie account approves it without a browser (linkWithSessionToken),
 *    the same call suno.com/link-account makes when the user clicks "Accept".
 * Tools are discovered at runtime (tools/list): the server, not this file, decides what exists.
 */

export const SUNO_MCP_URL = 'https://api.suno.com/mcp';
export const SUNO_OAUTH_URL = 'https://studio-api-prod.suno.com/api/v2/external/oauth';
/** Scopes the MCP resource accepts (/.well-known/oauth-protected-resource/mcp). */
export const SUNO_MCP_SCOPES =
  'api:v0 credits:spend download library:read library:search library:write offline_access profile:read';
const MCP_PROTOCOL_VERSION = '2025-06-18';
// Redirect for cookie linking: Suno only echoes it back with the code, nothing is ever served there.
const LOOPBACK_REDIRECT = 'http://127.0.0.1:33418/callback';

export interface SunoMcpTokens {
  client_id: string;
  access_token: string;
  refresh_token?: string;
  /** Epoch ms. */
  expires_at?: number;
  scope?: string;
}

export interface SunoMcpOptions {
  proxy?: SunoProxy;
  oauthUrl?: string;
  mcpUrl?: string;
  clientName?: string;
}

export class SunoMcpError extends Error {
  status?: number;
  code?: number;
  /** The request asks for something the MCP cannot do; a cookie account can take the web API path instead. */
  unsupported?: boolean;
  constructor(message: string, status?: number, code?: number) {
    super(message);
    this.name = 'SunoMcpError';
    this.status = status;
    this.code = code;
  }
}

// No browser headers here: api.suno.com/mcp answers 403 to `Origin: https://suno.com`.
/** Thrown when a request needs something the MCP lacks (custom model, non-vocal stem, cover image…). */
export function unsupportedViaMcp(message: string): SunoMcpError {
  const error = new SunoMcpError(`Not available through the Suno MCP: ${message}`, 409);
  error.unsupported = true;
  return error;
}

const http = (options: SunoMcpOptions): AxiosInstance =>
  axios.create({ ...(options.proxy ?? noProxy).axiosConfig(), timeout: 120_000, validateStatus: () => true });

const failure = (what: string, status: number, data: any) =>
  new SunoMcpError(`${what} failed (${status}): ${
    typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data?.error_description ?? data?.detail ?? data?.error ?? data).slice(0, 300)
  }`, status >= 400 && status < 500 ? (status === 401 ? 401 : 422) : 502);

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Dynamic client registration (public client, PKCE). One client per redirect URI. */
export async function registerOAuthClient(redirectUri: string, options: SunoMcpOptions = {}): Promise<string> {
  const response = await http(options).post(`${options.oauthUrl ?? SUNO_OAUTH_URL}/register/`, {
    client_name: options.clientName ?? 'suno-api',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SUNO_MCP_SCOPES
  });
  if (response.status >= 300 || !response.data?.client_id)
    throw failure('OAuth client registration', response.status, response.data);
  return response.data.client_id;
}

export function authorizeUrl(params: {
  clientId: string; redirectUri: string; state: string; challenge: string; scope?: string; oauthUrl?: string;
}): string {
  const url = new URL(`${params.oauthUrl ?? SUNO_OAUTH_URL}/authorize/`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
    scope: params.scope ?? SUNO_MCP_SCOPES,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    resource: SUNO_MCP_URL
  }).toString();
  return url.toString();
}

async function tokenRequest(form: Record<string, string>, clientId: string, options: SunoMcpOptions): Promise<SunoMcpTokens> {
  const response = await http(options).post(
    `${options.oauthUrl ?? SUNO_OAUTH_URL}/token/`,
    new URLSearchParams(form).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const data = response.data;
  if (response.status >= 300 || !data?.access_token)
    throw failure(`OAuth ${form.grant_type}`, response.status, data);
  return {
    client_id: clientId,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? form.refresh_token,
    expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined,
    scope: data.scope
  };
}

export function exchangeAuthorizationCode(
  params: { clientId: string; code: string; verifier: string; redirectUri: string },
  options: SunoMcpOptions = {}
): Promise<SunoMcpTokens> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.verifier,
    resource: SUNO_MCP_URL
  }, params.clientId, options);
}

/** Best-effort revocation (refresh token first: it ends the whole grant). Never throws. */
export async function revokeOAuthToken(tokens: SunoMcpTokens, options: SunoMcpOptions = {}): Promise<boolean> {
  try {
    const token = tokens.refresh_token ?? tokens.access_token;
    const response = await http(options).post(
      `${options.oauthUrl ?? SUNO_OAUTH_URL}/revoke_token/`,
      new URLSearchParams({
        token,
        token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token',
        client_id: tokens.client_id
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return response.status < 300;
  } catch {
    return false;
  }
}

export function refreshOAuthTokens(tokens: SunoMcpTokens, options: SunoMcpOptions = {}): Promise<SunoMcpTokens> {
  if (!tokens.refresh_token)
    throw new SunoMcpError('The Suno MCP token expired and has no refresh token: connect the account again', 401);
  return tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: tokens.client_id,
    resource: SUNO_MCP_URL
  }, tokens.client_id, options);
}

/**
 * Approves the MCP connection with a Clerk session JWT (what suno.com/link-account does on "Accept") and
 * returns OAuth tokens. Lets every cookie account use the MCP without a browser.
 */
export async function linkWithSessionToken(sessionJwt: string, options: SunoMcpOptions = {}): Promise<SunoMcpTokens> {
  const clientId = await registerOAuthClient(LOOPBACK_REDIRECT, options);
  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString('hex');
  const response = await http(options).post(
    `${options.oauthUrl ?? SUNO_OAUTH_URL}/generate-code`,
    {
      client_id: clientId,
      redirect_uri: LOOPBACK_REDIRECT,
      state,
      scope: SUNO_MCP_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    },
    { headers: { Authorization: `Bearer ${sessionJwt}` } }
  );
  const redirect = response.data?.redirect_url;
  if (response.status >= 300 || typeof redirect !== 'string')
    throw failure('Suno MCP account linking', response.status, response.data);
  const url = new URL(redirect);
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state)
    throw new SunoMcpError('Suno MCP account linking returned no authorization code', 502);
  return exchangeAuthorizationCode({ clientId, code, verifier, redirectUri: LOOPBACK_REDIRECT }, options);
}

/** JWT claims of an access token (no signature check: only used to label accounts). */
export function decodeTokenClaims(token: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** HTTP status for the `code` of a Suno tool error (documented in the tools' descriptions). */
const TOOL_ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  insufficient_credits: 402,
  forbidden: 403,
  feature_not_on_plan: 403,
  user_principal_required: 403,
  not_found: 404,
  conflict: 409,
  idempotency_key_reused: 409,
  rate_limited: 429,
  quota_exceeded: 429
};

export interface SunoMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, any>;
  annotations?: Record<string, any>;
  [key: string]: any;
}

/**
 * Minimal MCP client (Streamable HTTP, JSON-RPC). Refreshes the OAuth token when it expires and reports the
 * new tokens through `onTokens` so the host can persist them.
 */
export class SunoMcpClient {
  private tokens: SunoMcpTokens;
  private readonly options: SunoMcpOptions;
  private readonly onTokens?: (tokens: SunoMcpTokens) => void | Promise<void>;
  private readonly client: AxiosInstance;
  private sessionId?: string;
  private initializing?: Promise<void>;
  private nextId = 1;

  constructor(tokens: SunoMcpTokens, options: SunoMcpOptions & { onTokens?: SunoMcpClient['onTokens'] } = {}) {
    this.tokens = tokens;
    this.options = options;
    this.onTokens = options.onTokens;
    this.client = http(options);
  }

  private async refresh() {
    this.tokens = await refreshOAuthTokens(this.tokens, this.options);
    await this.onTokens?.(this.tokens);
  }

  private async post(body: Record<string, any>, retried = false): Promise<any> {
    if (this.tokens.expires_at && this.tokens.expires_at - Date.now() < 60_000 && this.tokens.refresh_token)
      await this.refresh();

    const response = await this.client.post(this.options.mcpUrl ?? SUNO_MCP_URL, body, {
      responseType: 'text',
      headers: {
        Authorization: `Bearer ${this.tokens.access_token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {})
      }
    });

    if (!retried && response.status === 401) {
      await this.refresh();
      return this.post(body, true);
    }
    // The server forgot our session: start a new one.
    if (!retried && response.status === 404 && this.sessionId && body.method !== 'initialize') {
      this.sessionId = undefined;
      this.initializing = undefined;
      await this.initialize();
      return this.post(body, true);
    }
    if (response.status >= 300)
      throw failure(`Suno MCP ${body.method}`, response.status, response.data);

    const session = response.headers['mcp-session-id'];
    if (session)
      this.sessionId = String(session);
    if (body.id === undefined)
      return undefined;

    const message = parseRpcResponse(String(response.data ?? ''), body.id);
    if (message?.error)
      throw new SunoMcpError(`Suno MCP ${body.method}: ${message.error.message}`, 502, message.error.code);
    return message?.result;
  }

  private initialize(): Promise<void> {
    this.initializing ??= (async () => {
      await this.post({
        jsonrpc: '2.0', id: this.nextId++, method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'suno-api', version: '1' } }
      });
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })().catch(error => {
      this.initializing = undefined;
      throw error;
    });
    return this.initializing;
  }

  /** Opens the MCP session (token refresh included); throws when the account cannot reach the MCP. */
  connect(): Promise<void> {
    return this.initialize();
  }

  async request(method: string, params?: Record<string, any>): Promise<any> {
    await this.initialize();
    return this.post({ jsonrpc: '2.0', id: this.nextId++, method, ...(params ? { params } : {}) });
  }

  async listTools(): Promise<SunoMcpTool[]> {
    const tools: SunoMcpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : undefined);
      tools.push(...(page?.tools ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return tools;
  }

  /** Sends a file to the `upload_url` of an upload session (one raw PUT, through the same egress). */
  async putUpload(uploadUrl: string, bytes: Buffer | Uint8Array, contentType?: string): Promise<void> {
    const response = await this.client.put(uploadUrl, bytes, {
      headers: contentType ? { 'Content-Type': contentType } : {},
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600_000
    });
    if (response.status >= 300)
      throw failure('Suno upload PUT', response.status, response.data);
  }

  /** Raw MCP result: { content: [...], structuredContent?, isError? }. */
  callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    return this.request('tools/call', { name, arguments: args });
  }

  /**
   * Tool result as data (Suno tools answer JSON in their text content). A tool error throws a SunoMcpError
   * whose status follows Suno's `code` (not_found → 404, insufficient_credits → 402, …).
   */
  async callToolJson(name: string, args: Record<string, any> = {}): Promise<any> {
    const result = await this.callTool(name, args);
    const text = (result?.content ?? []).filter((item: any) => item?.type === 'text').map((item: any) => item.text).join('');
    if (result?.isError) {
      let code: string | undefined;
      try {
        code = JSON.parse(text)?.code;
      } catch {
        // plain-text error
      }
      const error = new SunoMcpError(`Suno MCP ${name}: ${text.slice(0, 500) || 'tool error'}`, TOOL_ERROR_STATUS[code ?? ''] ?? 502);
      (error as any).suno_code = code;
      throw error;
    }
    if (result?.structuredContent)
      return result.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

/** Picks the JSON-RPC response with `id` from a JSON body or an SSE stream. */
export function parseRpcResponse(body: string, id: number | string): any {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('['))
    return [JSON.parse(trimmed)].flat().find(message => message?.id === id);

  for (const event of trimmed.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data)
      continue;
    try {
      const message = JSON.parse(data);
      if (message?.id === id)
        return message;
    } catch {
      // keep-alive or partial event
    }
  }
  return undefined;
}
