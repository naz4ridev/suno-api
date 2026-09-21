import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const maxDuration = 180;
export const dynamic = 'force-dynamic';

/** GET /api/wav_file?id=<clip_id> -> converts the clip to WAV if needed and returns { wav_file_url }. */
export async function GET(req: NextRequest) {
  try {
    const clipId = new URL(req.url).searchParams.get('id');
    if (!clipId)
      return jsonResponse({ error: 'Missing parameter id' }, 400);

    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    const result = await client.api.getWavFile(clipId);
    return jsonResponse(result, result.wav_file_url ? 200 : 202);
  } catch (error: any) {
    return errorResponse(error, 'Error getting wav file');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
