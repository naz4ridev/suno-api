import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Params = { params: { model_id: string } };

const normalizeModelId = (value: string) => decodeURIComponent(value).replace(/^chirp-custom:/, '');

/** GET /api/custom_models/{id} -> status of a custom model (pending | ready | not_found). */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    const modelId = normalizeModelId(params.model_id);
    const { models, pending } = await client.api.listCustomModels();
    const model = models.find(item => item.id === modelId);
    const status = pending.some(item => item.id === modelId) ? 'pending' : model ? 'ready' : 'not_found';

    return jsonResponse({ id: modelId, model_key: `chirp-custom:${modelId}`, status, model }, status === 'not_found' ? 404 : 200);
  } catch (error: any) {
    return errorResponse(error, 'Error reading custom model');
  }
}

/** DELETE /api/custom_models/{id} -> archives (deletes) the custom model. */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    const modelId = normalizeModelId(params.model_id);
    const result = await client.api.archiveCustomModel(modelId);
    return jsonResponse({ id: modelId, archived: true, result });
  } catch (error: any) {
    return errorResponse(error, 'Error archiving custom model');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
