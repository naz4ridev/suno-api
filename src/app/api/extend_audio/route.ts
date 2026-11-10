import { NextRequest } from "next/server";
import { DEFAULT_MODEL } from "@/lib/SunoApi";
import { buildGenerateOptions, getClient } from "@/lib/routeHelpers";
import { errorResponse, jsonResponse, optionsResponse, parseBoolean, parseOptionalNumber } from "@/lib/utils";
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps } from '@suno-sdk';

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { audio_id, prompt, continue_at, tags, negative_tags, title, model, wait_audio } = body;

    if (!audio_id)
      return jsonResponse({ error: 'Audio ID is required' }, 400);

    const mcp = await viaMcp(req, body, async c => mcpOps.createClips(c, 'audio-extensions-create', {
      ...mcpOps.generationArgs(body, await mcpOps.workspaceIdFrom(c, body)),
      id: audio_id,
      // The MCP needs the point to continue from; default to the end of the source clip.
      continue_at: parseOptionalNumber(continue_at) ?? (await c.callToolJson('audio-retrieve', { id: audio_id }))?.metadata?.duration,
      lyrics: prompt || undefined,
      style: tags || undefined,
      negative_style: tags ? negative_tags || undefined : undefined,
      title: title || undefined
    }, parseBoolean(wait_audio)));
    if (mcp)
      return mcp;

    const client = await getClient(req, body);
    if (client instanceof Response)
      return client;

    const options = await buildGenerateOptions(client.api, body);
    const audioInfo = await client.api.extendAudio(
      audio_id,
      prompt,
      parseOptionalNumber(continue_at) as number,
      tags || '',
      negative_tags || '',
      title,
      model || DEFAULT_MODEL,
      parseBoolean(wait_audio),
      options
    );
    return jsonResponse(audioInfo);
  } catch (error: any) {
    return errorResponse(error, 'Error extending audio');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
