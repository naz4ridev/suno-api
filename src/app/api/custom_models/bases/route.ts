import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** GET /api/custom_models/bases -> base models a custom model can be trained on. */
export async function GET(req: NextRequest) {
  try {
    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    return jsonResponse({ options: await client.api.getCustomModelBases() });
  } catch (error: any) {
    return errorResponse(error, 'Error listing custom model bases');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
