import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';

export const maxDuration = 90;
export const dynamic = 'force-dynamic';

/** GET /api/clip_analysis?id=<clip_id>&wait=true -> musical key and downbeats computed by Suno. */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const clipId = url.searchParams.get('id');
    if (!clipId)
      return jsonResponse({ error: 'Missing parameter id' }, 400);

    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    return jsonResponse(await client.api.getClipAnalysis(clipId, parseBoolean(url.searchParams.get('wait'), true)));
  } catch (error: any) {
    return errorResponse(error, 'Error getting clip analysis');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
