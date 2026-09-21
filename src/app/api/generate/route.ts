import { NextRequest } from "next/server";
import { DEFAULT_MODEL } from "@/lib/SunoApi";
import { buildGenerateOptions, getClient } from "@/lib/routeHelpers";
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from "@/lib/utils";

export const maxDuration = 60; // allow longer timeout for wait_audio == true
export const dynamic = "force-dynamic";

/**
 * Simple mode generation ("song description").
 * Optional: persona_id/voice_id, weirdness, style_weight, audio_weight, vocal_gender, workspace_id/workspace_name, account.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { prompt, make_instrumental, model, wait_audio } = body;
    if (!prompt)
      return jsonResponse({ error: 'prompt is required' }, 400);

    const client = await getClient(req, body);
    if (client instanceof Response)
      return client;

    const options = await buildGenerateOptions(client.api, body);
    const audioInfo = await client.api.generate(
      prompt,
      parseBoolean(make_instrumental),
      model || DEFAULT_MODEL,
      parseBoolean(wait_audio),
      options
    );
    return jsonResponse(audioInfo);
  } catch (error: any) {
    return errorResponse(error, 'Error generating audio');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
