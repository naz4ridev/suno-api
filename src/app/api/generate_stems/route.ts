import { NextRequest } from "next/server";
import { StemMode } from "@/lib/SunoApi";
import { getClient } from "@/lib/routeHelpers";
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from "@/lib/utils";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const validModes: StemMode[] = ['extract', 'twelve', 'legacy'];

/**
 * Body: { audio_id, mode?: 'extract' | 'twelve' | 'legacy', stem_name?: string, title?, wait_audio?, account? }
 * - extract (default): `stem_name` (default "Lead Vocal") + its complement ("Without Lead Vocal").
 *   Other names used by the web: Drum Kit, Bass, Lead Electric Guitar, Rhythm Electric Guitar, String Section, Synth...
 * - twelve: 12 stems (Vocals, Backing_Vocals, Drums, Bass, Guitar, Keyboard, Percussion, Strings, Synth, FX, Brass, Woodwinds).
 * - legacy: old /api/edit/stems endpoint.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { audio_id } = body;
    const mode = (body.mode || 'extract') as StemMode;

    if (!audio_id)
      return jsonResponse({ error: 'Audio ID is required' }, 400);
    if (!validModes.includes(mode))
      return jsonResponse({ error: `mode must be one of: ${validModes.join(', ')}` }, 400);

    const client = await getClient(req, body);
    if (client instanceof Response)
      return client;

    const audioInfo = await client.api.generateStems(audio_id, {
      mode,
      stem_name: body.stem_name,
      title: body.title,
      wait_audio: parseBoolean(body.wait_audio)
    });
    return jsonResponse(audioInfo);
  } catch (error: any) {
    return errorResponse(error, 'Error generating stems');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
