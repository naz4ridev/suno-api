import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const maxDuration = 180;
export const dynamic = 'force-dynamic';

/** GET /api/playback_audio?id=<clip-id> returns the playable M4A stream for an accessible clip. */
export async function GET(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return jsonResponse({ error: 'Missing parameter id' }, 400);
    const client = await getClient(req);
    if (client instanceof Response) return client;
    const audio = await client.api.getPlaybackAudio(id);
    return new Response(new Uint8Array(audio), {
      headers: { 'Content-Type': 'audio/mp4', 'Content-Length': String(audio.length), 'Cache-Control': 'no-store' }
    });
  } catch (error: any) {
    return errorResponse(error, 'Error getting playback audio');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
