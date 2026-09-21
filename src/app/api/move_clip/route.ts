import { NextRequest } from 'next/server';
import { getClient, parseClipIds } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Body: { clip_ids | clip_id, workspace_id | workspace_name, create_if_missing?: boolean, account? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const clipIds = parseClipIds(body.clip_ids ?? body.clip_id);

    if (clipIds.length === 0)
      return jsonResponse({ error: 'Missing clip_ids or clip_id' }, 400);

    if (!body.workspace_id && !body.workspace_name)
      return jsonResponse({ error: 'workspace_id or workspace_name is required' }, 400);

    const client = await getClient(req, body);
    if (client instanceof Response)
      return client;

    const response = await client.api.moveClipsToWorkspace(
      clipIds,
      body.workspace_id,
      body.workspace_name,
      parseBoolean(body.create_if_missing)
    );

    return jsonResponse(response);
  } catch (error: any) {
    return errorResponse(error, 'Error moving clips to workspace');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
