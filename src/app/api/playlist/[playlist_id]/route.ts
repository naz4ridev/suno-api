import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * GET /api/playlist/{playlist_id}[?account=] -> playlist metadata + all its clips (every page).
 */
export async function GET(req: NextRequest, { params }: { params: { playlist_id: string } }) {
  try {
    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    return jsonResponse(await client.api.getPlaylistWithAllClips(params.playlist_id));
  } catch (error: any) {
    return errorResponse(error, 'Error reading playlist');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
