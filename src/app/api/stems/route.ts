import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps } from '@suno-sdk';
import { SunoMcpError } from '@suno-sdk';

export const dynamic = 'force-dynamic';

/** Read existing stems without generating or unlocking downloads. Page indexes start at zero. */
export async function GET(req: NextRequest) {
  try {
    const query = new URL(req.url).searchParams;
    const id = query.get('id');
    const rawPage = query.get('page') ?? '0';
    if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
      return jsonResponse({ error: 'id must be a clip UUID' }, 400);
    if (!/^\d+$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage)))
      return jsonResponse({ error: 'page must be a non-negative integer' }, 400);
    // The MCP reads a stem split by the group id /api/generate_stems returned, not by page.
    const mcp = await viaMcp(req, null, c => {
      const groupId = query.get('group_id');
      if (!groupId)
        throw new SunoMcpError('group_id is required for accounts connected through the Suno MCP (from /api/generate_stems)', 400);
      return c.callToolJson('audio-stems-retrieve', { id, group_id: groupId });
    }, 200, { auto: false });
    if (mcp)
      return mcp;

    const client = await getClient(req);
    if (client instanceof Response) return client;
    return jsonResponse(await client.api.listStems(id, Number(rawPage)));
  } catch (error: any) {
    return errorResponse(error, 'Error listing stems');
  }
}

export async function OPTIONS() { return optionsResponse(); }
