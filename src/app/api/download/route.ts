import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps, unsupportedViaMcp } from '@suno-sdk';

export const maxDuration = 180;
export const dynamic = 'force-dynamic';

/**
 * POST /api/download { clip_id, format?: "mp3" | "wav" | ..., authorize?: boolean (default true), account? }
 * Uses the web download flow: /api/download/authorize (MAY DEDUCT DOWNLOAD CREDITS) + /api/download/clip/{id}.
 * Returns { status: "ready", download_url } (a signed, short lived S3 URL).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.clip_id)
      return jsonResponse({ error: 'clip_id is required' }, 400);

    // Same rule as the web flow: `authorize` (default true) allows spending a download credit.
    const mcp = await viaMcp(req, body, c => {
      const format = String(body.format || 'mp3');
      if (format !== 'mp3' && format !== 'wav')
        throw unsupportedViaMcp(`format "${format}" (mp3 or wav only)`);
      return mcpOps.downloadClip(c, String(body.clip_id), format, parseBoolean(body.authorize, true));
    }, data => data.status === 'ready' ? 200 : 202);
    if (mcp)
      return mcp;

    const client = await getClient(req, body);
    if (client instanceof Response)
      return client;

    const result = await client.api.downloadClip(String(body.clip_id), {
      format: body.format || 'mp3',
      authorize: parseBoolean(body.authorize, true)
    });
    return jsonResponse(result, result.status === 'ready' ? 200 : 202);
  } catch (error: any) {
    return errorResponse(error, 'Error downloading clip');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
