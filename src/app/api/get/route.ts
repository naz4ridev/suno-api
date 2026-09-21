import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * GET /api/get?ids=a,b -> clips by id (feed/v3).
 * Without ids -> latest clips of the default workspace; `page` is the feed cursor.
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const songIds = url.searchParams.get('ids');
    const page = url.searchParams.get('page') || url.searchParams.get('cursor');

    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    const ids = songIds ? songIds.split(',').map(id => id.trim()).filter(Boolean) : undefined;
    return jsonResponse(await client.api.get(ids, page));
  } catch (error: any) {
    return errorResponse(error, 'Error fetching audio');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
