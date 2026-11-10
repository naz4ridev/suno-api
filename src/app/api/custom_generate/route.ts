import { NextRequest } from "next/server";
import { DEFAULT_MODEL } from "@/lib/SunoApi";
import { buildGenerateOptions, getClient } from "@/lib/routeHelpers";
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from "@/lib/utils";
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps } from '@suno-sdk';

export const maxDuration = 60; // allow longer timeout for wait_audio == true
export const dynamic = "force-dynamic";

/**
 * Custom mode generation (lyrics + styles + title).
 * Optional: persona_id/voice_id, weirdness, style_weight, audio_weight, aug_creativity, vocal_gender,
 * is_max_mode, workspace_id/workspace_name, model (incl. chirp-custom:<id>), account.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { prompt, tags, title, make_instrumental, model, wait_audio, negative_tags } = body;

    const mcp = await viaMcp(req, body, async c => mcpOps.createClips(c, 'audio-create', {
      ...mcpOps.generationArgs(body, await mcpOps.workspaceIdFrom(c, body)),
      lyrics: prompt || undefined,
      style: tags || undefined,
      negative_style: tags ? negative_tags || undefined : undefined,
      title: title || undefined,
      instrumental: parseBoolean(make_instrumental) || undefined
    }, parseBoolean(wait_audio)));
    if (mcp)
      return mcp;

    const client = await getClient(req, body);
    if (client instanceof Response)
      return client;

    const options = await buildGenerateOptions(client.api, body);
    const audioInfo = await client.api.custom_generate(
      prompt || '',
      tags || '',
      title || '',
      parseBoolean(make_instrumental),
      model || DEFAULT_MODEL,
      parseBoolean(wait_audio),
      negative_tags,
      options
    );
    return jsonResponse(audioInfo);
  } catch (error: any) {
    return errorResponse(error, 'Error generating custom audio');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
