import { NextRequest } from 'next/server';
import { missingSunoCookieResponse, resolveSunoAuth, SunoAuth } from '@/lib/apiAuth';
import { GenerateOptions, sunoApi, SunoApi } from '@/lib/SunoApi';
import { parseBoolean, parseOptionalNumber } from '@/lib/utils';

export type ResolvedClient = {
  api: SunoApi;
  auth: SunoAuth;
};

/**
 * Resolves the Suno client for a request (explicit cookie, selected account or default account).
 * Returns a Response when no credentials are available.
 */
export async function getClient(
  req: NextRequest,
  payload?: Record<string, any> | FormData | null
): Promise<ResolvedClient | Response> {
  const auth = resolveSunoAuth(req, payload);
  if (!auth)
    return missingSunoCookieResponse();

  const api = await sunoApi(auth.cookie, auth.accountId);
  return { api, auth };
}

export function parseClipIds(raw: unknown): string[] {
  if (Array.isArray(raw))
    return raw.map(value => String(value).trim()).filter(Boolean);
  if (typeof raw === 'string')
    return raw.split(',').map(value => value.trim()).filter(Boolean);
  return [];
}

const readField = (body: Record<string, any> | FormData, key: string): any =>
  body instanceof FormData ? body.get(key) ?? undefined : body?.[key];

/**
 * Optional generation parameters shared by the generate endpoints:
 * persona_id / voice_id, control sliders, vocal_gender, max mode, workspace and raw payload overrides.
 */
export async function buildGenerateOptions(
  api: SunoApi,
  body: Record<string, any> | FormData
): Promise<Partial<GenerateOptions>> {
  const options: Partial<GenerateOptions> = {};
  const personaId = readField(body, 'persona_id') || readField(body, 'voice_id');
  if (personaId)
    options.persona_id = String(personaId);

  const numericFields: Array<keyof GenerateOptions> = [
    'weirdness', 'style_weight', 'audio_weight', 'aug_creativity',
    'artist_start_s', 'artist_end_s', 'cover_start_s', 'cover_end_s'
  ];
  for (const field of numericFields) {
    const value = parseOptionalNumber(readField(body, field));
    if (value !== undefined)
      (options as any)[field] = value;
  }

  const vocalGender = readField(body, 'vocal_gender');
  if (vocalGender) {
    const normalized = String(vocalGender).toLowerCase();
    options.vocal_gender = normalized.startsWith('f') ? 'f' : normalized.startsWith('m') ? 'm' : normalized;
  }

  const maxMode = readField(body, 'is_max_mode') ?? readField(body, 'max_mode');
  if (maxMode !== undefined)
    options.is_max_mode = parseBoolean(maxMode);

  for (const field of ['task', 'lyrics_project_id', 'artist_clip_id'] as const) {
    const value = readField(body, field);
    if (value)
      (options as any)[field] = String(value);
  }

  const workspaceId = readField(body, 'workspace_id') || readField(body, 'project_id');
  const workspaceName = readField(body, 'workspace_name');
  if (workspaceId || workspaceName) {
    const workspace = await api.resolveWorkspace(
      workspaceId ? String(workspaceId) : undefined,
      workspaceName ? String(workspaceName) : undefined,
      parseBoolean(readField(body, 'create_workspace_if_missing'))
    );
    options.project_id = workspace.id;
  }

  const extraPayload = readField(body, 'extra_payload');
  if (extraPayload && typeof extraPayload === 'object')
    options.extra_payload = extraPayload;
  const extraMetadata = readField(body, 'extra_metadata');
  if (extraMetadata && typeof extraMetadata === 'object')
    options.extra_metadata = extraMetadata;

  return options;
}
