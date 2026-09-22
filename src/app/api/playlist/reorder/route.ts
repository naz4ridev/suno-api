import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * POST /api/playlist/reorder
 * Body: { playlist_id, positions: [{ clip_id, index }], account? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const playlistId = typeof body.playlist_id === 'string' ? body.playlist_id.trim() : '';
    const positions = Array.isArray(body.positions)
      ? body.positions
          .map((position: any) => ({ clip_id: String(position?.clip_id ?? '').trim(), index: Number(position?.index) }))
          .filter((position: { clip_id: string; index: number }) => position.clip_id && Number.isInteger(position.index) && position.index >= 0)
      : [];
    if (!playlistId)
      return jsonResponse({ error: 'playlist_id is required' }, 400);
    if (positions.length === 0)
      return jsonResponse({ error: 'positions is required' }, 400);

    const client = await getClient(req, body);
    if (client instanceof Response)
      return client;

    return jsonResponse(await client.api.reorderPlaylistClips(playlistId, positions));
  } catch (error: any) {
    return errorResponse(error, 'Error reordering playlist');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
