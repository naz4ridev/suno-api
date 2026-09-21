import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** GET /api/voices/phrase?language=en -> { phrase_id, phrase_text } to record for voice verification. */
export async function GET(req: NextRequest) {
  try {
    const language = new URL(req.url).searchParams.get('language') || 'en';
    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    return jsonResponse(await client.api.getVoiceVerificationPhrase(language));
  } catch (error: any) {
    return errorResponse(error, 'Error getting voice verification phrase');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
