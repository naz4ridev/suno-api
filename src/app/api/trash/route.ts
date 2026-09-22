import { NextRequest } from 'next/server';
import { getClient, parseClipIds } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trash
 * Body: { clip_ids (or clip_id), trash?: boolean (default true; false restores), account? }
 * Moves clips to Suno's trash (restorable) or back out of it.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const clipIds = parseClipIds(body.clip_ids ?? body.clip_id);
    if (clipIds.length === 0)
      return jsonResponse({ error: 'clip_ids is required' }, 400);

    const client = await getClient(req, body);
    if (client instanceof Response)
      return client;

    const trash = body.trash === undefined ? true : parseBoolean(body.trash);
    return jsonResponse(await client.api.trashClips(clipIds, trash));
  } catch (error: any) {
    return errorResponse(error, 'Error trashing clips');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
