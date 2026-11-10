import { randomUUID } from 'node:crypto';
import { SunoMcpError, unsupportedViaMcp, type SunoMcpClient } from './mcp.ts';
import { parseBoolean } from './util.ts';

/**
 * suno-api operations implemented on the official Suno MCP tools, answering in the shapes the cookie-based
 * routes already return (AudioInfo-like clips, { workspace_id, clip_ids }, { status, download_url }…), so a
 * client does not care which transport served it. Shapes verified against api.suno.com/mcp on 2026-11-10.
 */

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A /v0 clip ({ id, title, status, cover_image_url, metadata: { lyrics, style, duration, type… } }) as an AudioInfo. */
export function toAudioInfo(clip: any): any {
  if (!clip || typeof clip !== 'object')
    return clip;
  const metadata = clip.metadata ?? {};
  return {
    ...clip,
    image_url: clip.cover_image_url,
    image_large_url: clip.cover_image_large_url,
    lyric: metadata.lyrics ?? '',
    prompt: metadata.lyrics,
    gpt_description_prompt: metadata.description ?? undefined,
    tags: metadata.style ?? undefined,
    type: metadata.type,
    duration: metadata.duration,
    model_name: metadata.model ?? clip.model,
    is_liked: clip.liked,
    is_public: clip.visibility === undefined ? undefined : clip.visibility === 'public',
    error_message: typeof clip.error === 'string' ? clip.error : clip.error?.message ?? undefined
  };
}

/** Walks a cursor-paginated list tool (`next_cursor`) and returns every item under `key`. */
export async function listAllPages(
  client: SunoMcpClient, tool: string, key: string, args: Record<string, any> = {}, maxPages = 50
): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const data = await client.callToolJson(tool, { ...args, ...(cursor ? { cursor } : {}) });
    items.push(...(data?.[key] ?? []));
    cursor = data?.next_cursor || undefined;
    if (!cursor)
      break;
  }
  return items;
}

/* Account */

export async function accountCredits(client: SunoMcpClient) {
  const usage = await client.callToolJson('account-usage');
  const suno = usage?.suno_account ?? {};
  return {
    credits_left: suno.credits_remaining,
    monthly_limit: suno.monthly_limit,
    monthly_usage: suno.monthly_usage,
    plan: suno.plan?.name,
    period: suno.plan?.period,
    renews_on: suno.renews_on,
    download_credits_left: suno.download_credits_remaining,
    allowed_models: usage?.allowed_models,
    features: usage?.features
  };
}

/** Models the plan allows, in the /api/models shape (the MCP only gives labels such as "v6"). */
export async function listModels(client: SunoMcpClient) {
  const usage = await client.callToolJson('account-usage');
  return (usage?.allowed_models ?? []).map((label: string) => ({
    id: label, name: label, external_key: label, can_use: true, is_default: false, is_custom: false
  }));
}

/* Clips */

export async function retrieveClips(client: SunoMcpClient, ids: string[]): Promise<any[]> {
  return Promise.all(ids.map(async id => toAudioInfo(await client.callToolJson('audio-retrieve', { id }))));
}

const SETTLED: Record<'playable' | 'complete', string[]> = {
  playable: ['streaming', 'complete', 'error'],
  complete: ['complete', 'error']
};

/** audio-wait (≈50 s per call) until every clip is settled or `timeoutMs` runs out; returns the latest clips. */
export async function waitForClips(
  client: SunoMcpClient, ids: string[], until: 'playable' | 'complete' = 'playable', timeoutMs = 50_000
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  let clips: any[] = ids.map(id => ({ id }));
  for (let start = 0; start < ids.length; start += 12) {
    const batch = ids.slice(start, start + 12);
    do {
      const data = await client.callToolJson('audio-wait', batch.length === 1 ? { id: batch[0], until } : { ids: batch, until });
      const got: any[] = Array.isArray(data?.clips) ? data.clips : [data];
      clips = clips.map(clip => got.find(item => item?.id === clip.id) ?? clip);
    } while (
      Date.now() < deadline &&
      batch.some(id => !SETTLED[until].includes(clips.find(clip => clip.id === id)?.status))
    );
  }
  return clips.map(toAudioInfo);
}

/** Runs a creation tool (2 songs per call for a suno.com user) and optionally waits until they play. */
export async function createClips(
  client: SunoMcpClient, tool: string, args: Record<string, any>, wait = false
): Promise<any[]> {
  // Creation spends credits: a key makes any retry of this same call return the first result instead.
  const data = await client.callToolJson(tool, { idempotency_key: randomUUID(), ...args });
  const created: any[] = Array.isArray(data?.clips) ? data.clips : [data];
  const ids: string[] = Array.isArray(data?.clip_ids) && data.clip_ids.length
    ? data.clip_ids
    : created.map(clip => clip?.id).filter(Boolean);
  if (!ids.length)
    throw new SunoMcpError(`Suno MCP ${tool} returned no clip ids`, 502);
  if (wait)
    return waitForClips(client, ids, 'playable');
  return ids.map(id => toAudioInfo(created.find(clip => clip?.id === id) ?? { id, status: data?.status ?? 'submitted' }));
}

/** Generation sliders: suno-api takes 0–1 or 0–100, the MCP 0–1 fractions. */
const fraction = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '' || Number.isNaN(Number(value)))
    return undefined;
  const numeric = Number(value);
  return Math.min(1, Math.max(0, numeric > 1 ? numeric / 100 : numeric));
};

const compact = (value: Record<string, any>) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));

/** suno-api / web model keys and the MCP labels for the same models (account-usage `allowed_models`). */
export const MCP_MODEL_LABELS: Record<string, string> = {
  'chirp-hawk': 'v6',
  'chirp-hawk-wild': 'v6-wild',
  'chirp-goose': 'v6-mini'
};

/** Generation fields the web API honours and the MCP has no argument for. */
const WEB_ONLY_GENERATION_FIELDS = [
  'lyrics_project_id', 'artist_clip_id', 'task', 'artist_start_s', 'artist_end_s', 'cover_start_s', 'cover_end_s',
  'extra_payload', 'extra_metadata', 'aug_creativity'
];

/** MCP label for a model chosen by the caller (`v6`, or its web key `chirp-hawk`); custom/older models are web-only. */
export function mcpModel(model: unknown): string | undefined {
  if (model === undefined || model === null || model === '')
    return undefined;
  const value = String(model);
  if (Object.values(MCP_MODEL_LABELS).includes(value))
    return value;
  if (MCP_MODEL_LABELS[value])
    return MCP_MODEL_LABELS[value];
  throw unsupportedViaMcp(`model "${value}" (MCP models: ${Object.entries(MCP_MODEL_LABELS).map(([key, label]) => `${label} = ${key}`).join(', ')})`);
}

/**
 * Translates suno-api's generation fields (persona_id/voice_id, weirdness, style_weight, audio_weight,
 * vocal_gender, is_max_mode, model, workspace_id, idempotency_key) to MCP arguments.
 */
export function generationArgs(body: Record<string, any>, workspaceId?: string): Record<string, any> {
  const webOnly = WEB_ONLY_GENERATION_FIELDS.filter(field => body[field] !== undefined && body[field] !== null && body[field] !== '');
  if (webOnly.length)
    throw unsupportedViaMcp(webOnly.join(', '));
  const gender = String(body.vocal_gender ?? '').toLowerCase();
  const controls = compact({
    weirdness: fraction(body.weirdness),
    style_influence: fraction(body.style_weight),
    audio_influence: fraction(body.audio_weight)
  });
  return compact({
    voice_id: body.voice_id || body.persona_id,
    vocal_gender: gender.startsWith('f') ? 'female' : gender.startsWith('m') ? 'male' : undefined,
    max_mode: body.is_max_mode ?? body.max_mode,
    model: mcpModel(body.model),
    workspace_id: workspaceId,
    idempotency_key: body.idempotency_key,
    duration: body.duration,
    controls: Object.keys(controls).length ? controls : undefined
  });
}

/* Workspaces */

export async function listWorkspaces(client: SunoMcpClient): Promise<any[]> {
  return listAllPages(client, 'workspaces-list', 'workspaces');
}

/** Same rules as SunoApi.resolveWorkspace: id wins, then an exact (case-insensitive) name, created on request. */
export async function resolveWorkspace(
  client: SunoMcpClient, workspaceId?: string, workspaceName?: string, createIfMissing = false
): Promise<{ id: string; name?: string; [key: string]: any }> {
  if (workspaceId)
    return { id: workspaceId };
  const name = workspaceName?.trim();
  if (!name)
    throw new SunoMcpError('workspace_id or workspace_name is required', 400);
  const found = (await listWorkspaces(client)).find(item => String(item.name).trim().toLowerCase() === name.toLowerCase());
  if (found)
    return found;
  if (!createIfMissing)
    throw new SunoMcpError(`Workspace not found: ${name}`, 404);
  return client.callToolJson('workspaces-create', { name });
}

/** Workspace id for a creation from suno-api's `workspace_id` / `project_id` / `workspace_name` fields. */
export async function workspaceIdFrom(client: SunoMcpClient, body: Record<string, any>): Promise<string | undefined> {
  const id = body.workspace_id || body.project_id;
  if (!id && !body.workspace_name)
    return undefined;
  return (await resolveWorkspace(client, id, body.workspace_name, parseBoolean(body.create_workspace_if_missing))).id;
}

export async function moveClipsToWorkspace(
  client: SunoMcpClient, clipIds: string[], workspaceId?: string, workspaceName?: string, createIfMissing = false
) {
  const workspace = await resolveWorkspace(client, workspaceId, workspaceName, createIfMissing);
  await client.callToolJson('workspaces-update-clips', { id: workspace.id, add: clipIds });
  return { workspace_id: workspace.id, workspace_name: workspace.name, clip_ids: clipIds };
}

/** set_metadata through audio-edit: only `title`, `lyrics` and `caption` exist on the MCP. */
export async function editClip(client: SunoMcpClient, clipId: string, body: Record<string, any>) {
  const webOnly = Object.keys(body).filter(key => !['title', 'lyrics', 'caption', 'description', 'account', 'account_id', 'transport'].includes(key));
  if (webOnly.length)
    throw unsupportedViaMcp(webOnly.join(', '));
  const args = compact({ title: body.title, lyrics: body.lyrics, caption: body.caption ?? body.description });
  if (!Object.keys(args).length)
    throw new SunoMcpError('Through the Suno MCP only title, lyrics and caption can be edited', 400);
  return toAudioInfo(await client.callToolJson('audio-edit', { id: clipId, ...args }));
}

/** Key, tempo, beats and sections (audio-analysis). `wait` polls while Suno is still analysing. */
export async function clipAnalysis(client: SunoMcpClient, clipId: string, wait = true, timeoutMs = 75_000) {
  const deadline = Date.now() + timeoutMs;
  let analysis = await client.callToolJson('audio-analysis', { id: clipId });
  while (wait && analysis?.status === 'processing' && Date.now() < deadline) {
    await sleep(3000);
    analysis = await client.callToolJson('audio-analysis', { id: clipId });
  }
  return analysis;
}

/** Lyric alignment; `aligned_words` mirrors the cookie API's field name. */
export async function lyricAlignment(client: SunoMcpClient, clipId: string) {
  const data = await client.callToolJson('audio-lyrics-alignment', { id: clipId });
  return { ...data, aligned_words: data?.words ?? [] };
}

export async function listVoices(client: SunoMcpClient) {
  const voices = await listAllPages(client, 'voices-list', 'voices');
  return { voices, personas: voices };
}

/* Library */

export async function listLibrary(client: SunoMcpClient, options: {
  query?: string | null; liked?: boolean; workspaceId?: string | null; playlistId?: string | null;
  cursor?: string | null; limit?: number;
}) {
  const page = compact({ cursor: options.cursor, limit: options.limit });
  const data = options.playlistId
    ? await client.callToolJson('playlists-list-clips', { id: options.playlistId, ...page })
    : options.query
      ? await client.callToolJson('library-search', compact({ query: options.query, liked: options.liked || undefined, workspace_id: options.workspaceId, ...page }))
      : await client.callToolJson('library-list', compact({ liked: options.liked || undefined, workspace_id: options.workspaceId, ...page }));
  return {
    clips: (data?.items ?? []).map(toAudioInfo),
    has_more: Boolean(data?.next_cursor),
    next_cursor: data?.next_cursor ?? null
  };
}

export async function getWorkspaceFeed(
  client: SunoMcpClient, workspaceId?: string, workspaceName?: string, cursor?: string | null, limit = 20
) {
  const workspace = await resolveWorkspace(client, workspaceId, workspaceName);
  return { workspace, ...(await listLibrary(client, { workspaceId: workspace.id, cursor, limit })) };
}

/* Playlists */

const toPlaylist = (playlist: any) => ({
  ...playlist,
  num_total_results: playlist.clip_count,
  is_public: playlist.visibility === undefined ? undefined : playlist.visibility === 'public'
});

/**
 * /api/playlist/me shape. The MCP pages by cursor, not by number, so page 1 carries every playlist (and
 * `num_total_results` their count) and later pages are empty: page-number callers stop after the first.
 */
export async function listMyPlaylists(client: SunoMcpClient, page = 1) {
  const playlists = page > 1 ? [] : (await listAllPages(client, 'playlists-list', 'playlists')).map(toPlaylist);
  return { playlists, num_total_results: playlists.length, current_page: page };
}

export async function getPlaylistWithAllClips(client: SunoMcpClient, playlistId: string) {
  const clips = (await listAllPages(client, 'playlists-list-clips', 'items', { id: playlistId })).map(toAudioInfo);
  return { id: playlistId, clips, num_total_results: clips.length };
}

export async function createPlaylist(client: SunoMcpClient, name: string, description?: string, isPublic?: boolean) {
  const args = compact({ name, description, visibility: isPublic === undefined ? undefined : isPublic ? 'public' : 'private' });
  try {
    return toPlaylist({ ...(await client.callToolJson('playlists-create', args)), name, description: description ?? '' });
  } catch (error: any) {
    // Same rule as the cookie API: a description Suno's moderation rejects (e.g. links) is dropped, not fatal.
    if (!description || !/moderation/i.test(String(error?.message)))
      throw error;
    return toPlaylist({ ...(await client.callToolJson('playlists-create', { ...args, description: undefined })), name, description: '' });
  }
}

export async function updatePlaylistClips(client: SunoMcpClient, playlistId: string, updateType: 'add' | 'remove', clipIds: string[]) {
  const data = await client.callToolJson(updateType === 'remove' ? 'playlists-remove-clips' : 'playlists-add-clips', { id: playlistId, clip_ids: clipIds });
  return { ...(data && typeof data === 'object' ? data : {}), playlist_id: playlistId, update_type: updateType, clip_ids: clipIds, success: true as const };
}

/* Files */

/**
 * Download URL under Suno's download rules. Without `confirm`, a song that needs a download credit answers
 * `requires_credit` instead of spending it.
 */
export async function downloadClip(client: SunoMcpClient, clipId: string, format: 'mp3' | 'wav' = 'mp3', confirm = false) {
  const data = await client.callToolJson('audio-download', { id: clipId, format, confirm });
  if (data?.url)
    return { status: 'ready' as const, download_url: data.url, format: data.format ?? format, expires_at: data.expires_at };
  return { ...data, status: data?.status ?? 'processing' };
}

/* Stems */

/** suno-api modes: twelve → twelve; extract (vocals) and legacy → two (vocals + instrumental). */
export function stemsMode(mode?: string, stemName?: string): 'two' | 'twelve' {
  if (mode === 'twelve')
    return 'twelve';
  if (stemName && !/vocal/i.test(stemName))
    throw unsupportedViaMcp(`stem "${stemName}" (the MCP only separates vocals/instrumental or 12 stems)`);
  return 'two';
}

export async function createStems(client: SunoMcpClient, clipId: string, mode: 'two' | 'twelve', wait = false, timeoutMs = 50_000) {
  let group = await client.callToolJson('audio-stems-create', { id: clipId, mode, idempotency_key: randomUUID() });
  const deadline = Date.now() + timeoutMs;
  while (wait && group?.status === 'pending' && group?.id && Date.now() < deadline) {
    await sleep(4000);
    group = await client.callToolJson('audio-stems-retrieve', { id: clipId, group_id: group.id });
  }
  return group;
}

/* Uploads */

/** Starts an upload session: `{ id, upload_url, upload_page_url, expires_at }`, valid for one file for one hour. */
export async function startUpload(client: SunoMcpClient, title?: string) {
  return client.callToolJson('audio-upload-create', compact({ title }));
}
