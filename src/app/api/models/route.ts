import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * GET /api/models -> models available to the account (use `external_key` as `model`),
 * including custom models (`chirp-custom:<id>`).
 */
export async function GET(req: NextRequest) {
  try {
    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    const models = await client.api.getModels();
    return jsonResponse({
      account_id: client.auth.accountId ?? null,
      default_model: models.find(model => model.is_default)?.external_key,
      models
    });
  } catch (error: any) {
    return errorResponse(error, 'Error listing models');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
