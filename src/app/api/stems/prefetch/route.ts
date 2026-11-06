import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** Native preparation hint, separate from generation and official download authorization. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || typeof body.source_clip_id !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.source_clip_id))
      return jsonResponse({ error: 'source_clip_id must be a clip UUID' }, 400);
    const client = await getClient(req, body);
    if (client instanceof Response) return client;
    return jsonResponse(await client.api.prefetchStems(body.source_clip_id));
  } catch (error: any) {
    return errorResponse(error, 'Error prefetching stems');
  }
}

export async function OPTIONS() { return optionsResponse(); }
