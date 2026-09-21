import { NextRequest } from "next/server";
import { getClient } from "@/lib/routeHelpers";
import { errorResponse, jsonResponse, optionsResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * GET /api/persona?id=<persona_id>&page=1   -> persona with its clips (paginated)
 * GET /api/persona?list=mine|loved|followed -> personas of the account (voices have persona_type "vox")
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const personaId = url.searchParams.get('id');
    const list = url.searchParams.get('list');
    const pageNumber = parseInt(url.searchParams.get('page') || '1') || 1;

    if (!personaId && !list)
      return jsonResponse({ error: 'Missing parameter id (or list=mine|loved|followed)' }, 400);

    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    if (!personaId) {
      const kind = (['mine', 'loved', 'followed'].includes(list!) ? list : 'mine') as 'mine' | 'loved' | 'followed';
      return jsonResponse(await client.api.listPersonas(pageNumber, kind));
    }

    const personaInfo = await client.api.getPersonaPaginated(personaId, pageNumber);
    return jsonResponse(personaInfo);
  } catch (error: any) {
    return errorResponse(error, 'Error fetching persona');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
