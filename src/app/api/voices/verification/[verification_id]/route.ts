import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** GET /api/voices/verification/{id} -> { status: pending | rejected | ..., rejection_reason } */
export async function GET(req: NextRequest, { params }: { params: { verification_id: string } }) {
  try {
    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    return jsonResponse(await client.api.getVoiceVerification(params.verification_id));
  } catch (error: any) {
    return errorResponse(error, 'Error reading voice verification');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
