import catalogue from './data/stem-catalogue.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };
import { AccountError, selectAccount, type SunoAccountRecord, type SunoAccountResolver } from './accounts.ts';
import { createSunoRegistry, type SunoRegistryOptions } from './registry.ts';
import type { StemMode, SunoApi } from './SunoApi.ts';
import { stemRenderClipIds } from './stemRender.ts';
import { createUploadFileWorkflow, type UploadFileWork } from './uploadFileWorkflow.ts';
import { CLIP_UUID, parseBoolean } from './util.ts';

/**
 * The suno-api HTTP route contract, as plain functions.
 *
 * `request({ method, path, body, account, binary })` is exactly the transport that `SunoClient` (HTTP and SSH
 * today) issues against suno-api: same paths, same query strings, same bodies, same answers. Hosts that embed
 * the SDK (the desktop app) route that transport here and no HTTP server is involved; every Suno call is still
 * made by SunoApi.
 *
 * Only the routes that the clients actually use are covered here. Account answers never include cookies.
 */

export const MISSING_ACCOUNT_ERROR =
  'Missing suno_cookie (no Suno account available). Select an account that is configured in this application.';

/** An error that maps to an HTTP status and the public body suno-api would answer with. */
export class ContractError extends Error {
  status: number;
  [key: string]: unknown;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ContractError';
    this.status = status;
    Object.assign(this, extra);
  }
}

const badRequest = (message: string) => new ContractError(400, message);

/** The public failure fields suno-api exposes on error responses (never upstream bodies). */
export function errorBody(error: any): Record<string, unknown> {
  const body: Record<string, unknown> = { error: error?.message || 'Internal server error' };
  for (const key of ['error_type', 'category', 'retryable', 'copyright', 'code', 'stage', 'submitted']) {
    if (error?.[key] !== undefined)
      body[key] = error[key];
  }
  if (error?.detail !== undefined)
    body.detail = error.detail;
  return body;
}

export function errorStatus(error: any): number {
  const rawStatus = Number(error?.status || error?.response?.status);
  return rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
}

export interface ContractRequest {
  method?: 'GET' | 'POST';
  /** Path with query string, e.g. `/api/stems?id=…&page=0`. */
  path: string;
  body?: any;
  /** Account selector (id, label, email or handle). Same meaning as the `x-suno-account` header. */
  account?: string;
  binary?: boolean;
}

export interface PublicAccount {
  id: string;
  label: string;
  disabled: boolean;
  is_default: boolean;
  user: { id?: string; handle?: string; email?: string } | null;
}

export interface ContractOptions extends Omit<SunoRegistryOptions, 'accounts'> {
  /** Host account list. Records carry cookies: they stay inside the host process. */
  listAccounts(): Promise<readonly SunoAccountRecord[]> | readonly SunoAccountRecord[];
  /** Where upload works are persisted. Without it, uploads are unavailable. */
  storageDirectory?: string;
}

export const defaultAccountId = (accounts: readonly SunoAccountRecord[]): string | null => {
  const active = accounts.filter(account => !account.disabled);
  return (active.find(account => account.isDefault) ?? active[0])?.id ?? null;
};

export function toPublicAccount(account: SunoAccountRecord, defaultId: string | null): PublicAccount {
  return {
    id: account.id,
    label: account.label || account.id,
    disabled: Boolean(account.disabled),
    is_default: account.id === defaultId,
    user: account.user ? { id: account.user.id, handle: account.user.handle, email: account.user.email } : null
  };
}

const validModes: StemMode[] = ['extract', 'twelve', 'legacy'];

export function createSunoContract(options: ContractOptions) {
  const list = async () => [...await options.listAccounts()];
  const accounts: SunoAccountResolver = {
    async resolve(selector) {
      const all = await list();
      return selectAccount(all, selector, defaultAccountId(all));
    }
  };
  const registry = createSunoRegistry({ ...options, accounts, missingCookieMessage: MISSING_ACCOUNT_ERROR });
  const workflow = options.storageDirectory
    ? createUploadFileWorkflow({
      storageDirectory: options.storageDirectory,
      getApi: (cookie, accountId) => registry.sunoApi(cookie, accountId)
    })
    : null;

  const client = async (selector?: string | null): Promise<{ api: SunoApi; accountId: string }> => {
    const account = await accounts.resolve(selector);
    if (!account)
      throw badRequest(MISSING_ACCOUNT_ERROR);
    return { api: await registry.sunoApi(account.cookie, account.id), accountId: account.id };
  };

  const clipId = (value: string | null): string => {
    if (!value)
      throw badRequest('Missing parameter id');
    return value;
  };

  type Ctx = { query: URLSearchParams; body: any; account?: string; params: string[] };
  type Handler = (ctx: Ctx) => Promise<unknown>;

  const handlers: Array<{ method: 'GET' | 'POST'; pattern: RegExp; run: Handler }> = [
    { method: 'GET', pattern: /^\/api\/health$/, async run() {
      const all = await list();
      return { ok: true, version: pkg.version, mode: 'embedded', accounts: all.filter(account => !account.disabled).length };
    } },
    { method: 'GET', pattern: /^\/api\/accounts$/, async run() {
      const all = await list();
      const defaultId = defaultAccountId(all);
      return { default_account_id: defaultId, accounts: all.map(account => toPublicAccount(account, defaultId)) };
    } },
    { method: 'GET', pattern: /^\/api\/stems\/catalogue$/, async run() { return { ...catalogue, snapshot: true }; } },
    { method: 'GET', pattern: /^\/api\/clip$/, async run({ query, account }) {
      const id = clipId(query.get('id'));
      return (await client(account)).api.getClip(id);
    } },
    { method: 'GET', pattern: /^\/api\/get$/, async run({ query, account }) {
      const songIds = query.get('ids');
      const page = query.get('page') || query.get('cursor');
      const { api } = await client(account);
      const ids = songIds ? songIds.split(',').map(id => id.trim()).filter(Boolean) : undefined;
      return api.get(ids, page);
    } },
    { method: 'GET', pattern: /^\/api\/get_limit$/, async run({ account }) {
      const { api, accountId } = await client(account);
      return { ...await api.get_credits(), account_id: accountId };
    } },
    { method: 'GET', pattern: /^\/api\/clip_analysis$/, async run({ query, account }) {
      const id = clipId(query.get('id'));
      return (await client(account)).api.getClipAnalysis(id, parseBoolean(query.get('wait'), true));
    } },
    { method: 'GET', pattern: /^\/api\/stems$/, async run({ query, account }) {
      const id = query.get('id');
      const rawPage = query.get('page') ?? '0';
      if (!id || !CLIP_UUID.test(id))
        throw badRequest('id must be a clip UUID');
      if (!/^\d+$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage)))
        throw badRequest('page must be a non-negative integer');
      return (await client(account)).api.listStems(id, Number(rawPage));
    } },
    { method: 'POST', pattern: /^\/api\/generate_stems$/, async run({ body, account }) {
      const audioId = body?.audio_id;
      const mode = (body?.mode || 'extract') as StemMode;
      if (!audioId)
        throw badRequest('Audio ID is required');
      if (!validModes.includes(mode))
        throw badRequest(`mode must be one of: ${validModes.join(', ')}`);
      return (await client(account)).api.generateStems(audioId, {
        mode, stem_name: body.stem_name, title: body.title, wait_audio: parseBoolean(body.wait_audio)
      });
    } },
    { method: 'GET', pattern: /^\/api\/playback_audio$/, async run({ query, account }) {
      const id = clipId(query.get('id'));
      return (await client(account)).api.getPlaybackAudio(id);
    } },
    { method: 'POST', pattern: /^\/api\/stems\/render$/, async run({ body, account }) {
      if (!body || typeof body.source_clip_id !== 'string')
        throw badRequest('source_clip_id is required');
      if (body.authorize !== undefined && typeof body.authorize !== 'boolean')
        throw badRequest('authorize must be a boolean');
      stemRenderClipIds(body.source_clip_id, body.render);
      return (await client(account)).api.renderStems(body.source_clip_id, body.render, body.authorize === true);
    } },
    { method: 'GET', pattern: /^\/api\/workspaces$/, async run({ account }) {
      return { workspaces: await (await client(account)).api.listAllWorkspaces() };
    } },
    { method: 'GET', pattern: /^\/api\/playlist\/me$/, async run({ query, account }) {
      const page = Number(query.get('page') ?? '1');
      const showTrashed = String(query.get('show_trashed') ?? 'false').toLowerCase() === 'true';
      const showSharelist = String(query.get('show_sharelist') ?? 'false').toLowerCase() === 'true';
      return (await client(account)).api.getMyPlaylists(Number.isFinite(page) && page > 0 ? page : 1, showTrashed, showSharelist);
    } },
    { method: 'GET', pattern: /^\/api\/playlist\/([^/]+)$/, async run({ params, account }) {
      return (await client(account)).api.getPlaylistWithAllClips(decodeURIComponent(params[0]));
    } },
    { method: 'GET', pattern: /^\/api\/workspace_feed$/, async run({ query, account }) {
      const workspaceId = query.get('workspace_id');
      const workspaceName = query.get('workspace_name');
      if (!workspaceId && !workspaceName)
        throw badRequest('workspace_id or workspace_name is required');
      const limitValue = Number(query.get('limit') ?? '20');
      return (await client(account)).api.getWorkspaceFeed(
        workspaceId || undefined, workspaceName || undefined, query.get('cursor'),
        Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 20);
    } },
    { method: 'GET', pattern: /^\/api\/library\/songs$/, async run({ query, account }) {
      const rawLimit = query.get('limit');
      const liked = query.get('liked');
      if (liked !== null && !['true', 'false', '1', '0'].includes(liked.toLowerCase()))
        throw badRequest('liked must be true or false');
      return (await client(account)).api.getLibraryFeed({
        workspaceId: query.get('workspace_id'),
        playlistId: query.get('playlist_id'),
        searchText: query.get('q'),
        liked: liked !== null && ['true', '1'].includes(liked.toLowerCase()),
        cursor: query.get('cursor'),
        limit: rawLimit === null ? undefined : Number(rawLimit)
      });
    } }
  ];

  async function request(req: ContractRequest): Promise<unknown> {
    const method = req.method || 'GET';
    let url: URL;
    try { url = new URL(req.path, 'http://suno.invalid'); } catch { throw badRequest('Invalid request path'); }
    if (url.origin !== 'http://suno.invalid' || !req.path.startsWith('/api/'))
      throw badRequest('Invalid request path');
    for (const handler of handlers) {
      const match = handler.pattern.exec(url.pathname);
      if (match && handler.method === method)
        return handler.run({ query: url.searchParams, body: req.body, account: req.account || url.searchParams.get('account') || undefined, params: match.slice(1) });
    }
    throw new ContractError(404, `Unsupported route: ${method} ${url.pathname}`);
  }

  const requireWorkflow = () => {
    if (!workflow)
      throw new ContractError(501, 'Source uploads need a storageDirectory');
    return workflow;
  };

  return {
    registry,
    request,
    /** POST /api/upload_file: creates the durable work and uploads in the background. */
    async uploadFile(input: {
      account?: string;
      file: { name: string; type?: string; bytes: Buffer };
      title?: string;
      workspaceId?: string;
      workspaceName?: string;
      rejectCopyrightMuted?: boolean;
      createWorkspaceIfMissing?: boolean;
      audioContentTypes?: string[];
      imageUrl?: string;
    }): Promise<{ work_id: string; status: UploadFileWork['status']; account_id: string | null }> {
      const flow = requireWorkflow();
      const account = await accounts.resolve(input.account);
      if (!account) throw badRequest(MISSING_ACCOUNT_ERROR);
      const work = await flow.submitUploadFile({
        file: input.file, auth: { cookie: account.cookie, accountId: account.id },
        workspaceId: input.workspaceId, workspaceName: input.workspaceName, title: input.title, imageUrl: input.imageUrl,
        createWorkspaceIfMissing: input.createWorkspaceIfMissing, audioContentTypes: input.audioContentTypes,
        rejectCopyrightMuted: input.rejectCopyrightMuted
      });
      return { work_id: work.work_id, status: work.status, account_id: account.id };
    },
    /**
     * GET /api/upload_file?work_id=: the persisted work, or a 404. When an account is named, only works that
     * account started are visible (another account's work answers 404, never 403, so ids cannot be probed).
     */
    async uploadStatus(workId: string, accountSelector?: string): Promise<UploadFileWork> {
      const flow = requireWorkflow();
      const owner = accountSelector ? await accounts.resolve(accountSelector) : null;
      if (accountSelector && !owner)
        throw badRequest(MISSING_ACCOUNT_ERROR);
      const work = await flow.getUploadFileWork(workId);
      if (!work || (owner && work.input.account_id !== owner.id))
        throw new ContractError(404, `Upload work not found: ${workId}`);
      return work;
    }
  };
}

export type SunoContract = ReturnType<typeof createSunoContract>;
export { AccountError };
