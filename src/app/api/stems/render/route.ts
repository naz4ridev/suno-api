import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';
import { stemRenderClipIds } from '@/lib/stemRender';

export const maxDuration = 180;
export const dynamic = 'force-dynamic';

/** Native official stem export. `render` is Suno Studio state; authorize=true unlocks the source song. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || typeof body.source_clip_id !== 'string')
      return jsonResponse({ error: 'source_clip_id is required' }, 400);
    if (body.authorize !== undefined && typeof body.authorize !== 'boolean')
      return jsonResponse({ error: 'authorize must be a boolean' }, 400);
    stemRenderClipIds(body.source_clip_id, body.render);
    const client = await getClient(req, body);
    if (client instanceof Response) return client;
    return jsonResponse(await client.api.renderStems(body.source_clip_id, body.render, body.authorize === true));
  } catch (error: any) {
    return errorResponse(error, 'Error rendering official stems');
  }
}

export async function OPTIONS() { return optionsResponse(); }
