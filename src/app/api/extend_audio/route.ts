import { NextRequest } from "next/server";
import { DEFAULT_MODEL } from "@/lib/SunoApi";
import { buildGenerateOptions, getClient } from "@/lib/routeHelpers";
import { errorResponse, jsonResponse, optionsResponse, parseBoolean, parseOptionalNumber } from "@/lib/utils";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { audio_id, prompt, continue_at, tags, negative_tags, title, model, wait_audio } = body;

    if (!audio_id)
      return jsonResponse({ error: 'Audio ID is required' }, 400);

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
