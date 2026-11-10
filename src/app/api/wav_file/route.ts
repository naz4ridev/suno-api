import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps, unsupportedViaMcp } from '@suno-sdk';

export const maxDuration = 180;
export const dynamic = 'force-dynamic';

/** GET /api/wav_file?id=<clip_id> -> converts the clip to WAV if needed and returns { wav_file_url }. */
export async function GET(req: NextRequest) {
  try {
    const clipId = new URL(req.url).searchParams.get('id');
    if (!clipId)
      return jsonResponse({ error: 'Missing parameter id' }, 400);

    const mcp = await viaMcp(req, null, async c => {
      const download = await mcpOps.downloadClip(c, clipId, 'wav', false);
      // The web flow converts without spending a download credit; the MCP would need one.
      if (download.status === 'requires_credit')
        throw unsupportedViaMcp('this WAV needs a download credit through the MCP');
      return download.status === 'ready' ? { wav_file_url: download.download_url } : download;
    }, data => data.wav_file_url ? 200 : 202);
    if (mcp)
      return mcp;

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
