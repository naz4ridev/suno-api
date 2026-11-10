import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps } from '@suno-sdk';

export const maxDuration = 90;
export const dynamic = 'force-dynamic';

/** GET /api/clip_analysis?id=<clip_id>&wait=true -> musical key and downbeats computed by Suno. */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const clipId = url.searchParams.get('id');
    if (!clipId)
      return jsonResponse({ error: 'Missing parameter id' }, 400);

    const mcp = await viaMcp(req, null, c => mcpOps.clipAnalysis(c, clipId, parseBoolean(url.searchParams.get('wait'), true)), 200, { auto: false });
    if (mcp)
      return mcp;

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
