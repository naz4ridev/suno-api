import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';

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
