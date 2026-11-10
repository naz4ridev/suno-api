import { NextRequest } from 'next/server';
import { AudioToAudioMode } from '@/lib/SunoApi';
import { buildGenerateOptions, getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps } from '@suno-sdk';
import { unsupportedViaMcp } from '@suno-sdk';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const validModes: AudioToAudioMode[] = ['cover', 'add_vocals', 'add_instrumental'];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const mode = body.mode as AudioToAudioMode;

    if (!body.clip_id)
      return jsonResponse({ error: 'Missing clip_id' }, 400);

    if (!validModes.includes(mode))
      return jsonResponse({ error: 'mode must be one of: cover, add_vocals, add_instrumental' }, 400);

    const mcp = await viaMcp(req, body, async c => {
      if (mode !== 'cover')
        throw unsupportedViaMcp(`mode "${mode}" (only cover)`);
      return mcpOps.createClips(c, 'audio-covers-create', {
        ...mcpOps.generationArgs(body, await mcpOps.workspaceIdFrom(c, body)),
        id: body.clip_id,
        lyrics: body.prompt || undefined,
        style: body.tags || undefined,
        negative_style: body.negative_tags || undefined,
        title: body.title || undefined
      }, parseBoolean(body.wait_audio));
    });
    if (mcp)
      return mcp;

    const client = await getClient(req, body);
    if (client instanceof Response)
      return client;

    // workspace resolution is done inside generateFromAudio (it defaults to the source clip workspace)
    const { workspace_id, workspace_name, project_id, ...generateBody } = body;
    const options = await buildGenerateOptions(client.api, generateBody);
    const response = await client.api.generateFromAudio(body.clip_id, mode, {
      ...options,
      prompt: body.prompt,
      title: body.title,
      tags: body.tags,
      negative_tags: body.negative_tags,
      model: body.model,
      wait_audio: parseBoolean(body.wait_audio),
      workspace_id: workspace_id || project_id,
      workspace_name
    });

    return jsonResponse(response);
  } catch (error: any) {
    return errorResponse(error, 'Error generating from audio');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
