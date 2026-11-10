import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps } from '@suno-sdk';

export const dynamic = 'force-dynamic';

/** GET /api/workspaces -> all workspaces (projects) of the account. */
export async function GET(req: NextRequest) {
  try {
    const mcp = await viaMcp(req, null, async c => ({ workspaces: await mcpOps.listWorkspaces(c) }));
    if (mcp)
      return mcp;

    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    return jsonResponse({ workspaces: await client.api.listAllWorkspaces() });
  } catch (error: any) {
    return errorResponse(error, 'Error listing workspaces');
  }
}

/** POST /api/workspaces { name, description?, account? } -> creates a workspace (returns the existing one if the name exists and if_missing=true). */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name)
      return jsonResponse({ error: 'name is required' }, 400);

    const mcp = await viaMcp(req, body, c => body.if_missing
      ? mcpOps.resolveWorkspace(c, undefined, name, true)
      : c.callToolJson('workspaces-create', { name, ...(body.description ? { description: body.description } : {}) }),
    body.if_missing ? 200 : 201);
    if (mcp)
      return mcp;

    const client = await getClient(req, body);
    if (client instanceof Response)
      return client;

    if (body.if_missing) {
      const workspace = await client.api.resolveWorkspace(undefined, name, true);
      return jsonResponse(workspace);
    }

    return jsonResponse(await client.api.createWorkspace(name, body.description || ''), 201);
  } catch (error: any) {
    return errorResponse(error, 'Error creating workspace');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
