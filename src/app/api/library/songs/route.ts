import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps } from '@suno-sdk';

export const dynamic = 'force-dynamic';

/**
 * GET /api/library/songs[?account=][&workspace_id=|playlist_id=][&q=][&liked=true][&cursor=][&limit=1..50]
 * -> { clips, has_more, next_cursor }. Read-only. Filters run on Suno's side (feed/v3), so `q`
 * and `liked` cover the whole scope, not just the returned page. Without workspace_id/playlist_id
 * the scope is the default workspace.
 */
export async function GET(req: NextRequest) {
  try {
    const query = new URL(req.url).searchParams;
    const rawLimit = query.get('limit');
    const liked = query.get('liked');
    if (liked !== null && !['true', 'false', '1', '0'].includes(liked.toLowerCase()))
      return jsonResponse({ error: 'liked must be true or false' }, 400);

    const mcp = await viaMcp(req, null, c => mcpOps.listLibrary(c, {
      workspaceId: query.get('workspace_id'),
      playlistId: query.get('playlist_id'),
      query: query.get('q'),
      liked: liked !== null && ['true', '1'].includes(liked.toLowerCase()),
      cursor: query.get('cursor'),
      limit: rawLimit === null ? undefined : Number(rawLimit)
    }));
    if (mcp)
      return mcp;

    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    return jsonResponse(await client.api.getLibraryFeed({
      workspaceId: query.get('workspace_id'),
      playlistId: query.get('playlist_id'),
      searchText: query.get('q'),
      liked: liked !== null && ['true', '1'].includes(liked.toLowerCase()),
      cursor: query.get('cursor'),
      limit: rawLimit === null ? undefined : Number(rawLimit)
    }));
  } catch (error: any) {
    return errorResponse(error, 'Error listing library songs');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
