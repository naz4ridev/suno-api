import { NextRequest } from 'next/server';
import { getClient, parseClipIds } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';

export const maxDuration = 900;
export const dynamic = 'force-dynamic';

/**
 * GET /api/custom_models -> ready custom models + models still training.
 */
export async function GET(req: NextRequest) {
  try {
    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    return jsonResponse(await client.api.listCustomModels());
  } catch (error: any) {
    return errorResponse(error, 'Error listing custom models');
  }
}

/**
 * POST /api/custom_models
 * Body: { name, clip_ids (uploaded clips, the web app requires at least 6), base_model? (see /api/custom_models/bases),
 *         wait?: boolean (wait until training finishes, up to 15 min), account? }
 * When ready, use `chirp-custom:<id>` as `model` in the generate endpoints.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const clipIds = parseClipIds(body.clip_ids ?? body.clip_id);
    if (!body.name)
      return jsonResponse({ error: 'name is required' }, 400);
    if (clipIds.length === 0)
      return jsonResponse({ error: 'clip_ids is required' }, 400);

    const client = await getClient(req, body);
    if (client instanceof Response)
      return client;

    const created = await client.api.createCustomModel({
      clip_ids: clipIds,
      name: String(body.name),
      base_model: body.base_model
    });

    const response: Record<string, any> = {
      ...created,
      model_key: `chirp-custom:${created.id}`
    };
    if (parseBoolean(body.wait)) {
      const model = await client.api.waitForCustomModel(created.id);
      response.status = model ? 'ready' : 'pending';
      response.model = model;
    }

    return jsonResponse(response, 201);
  } catch (error: any) {
    return errorResponse(error, 'Error creating custom model');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
