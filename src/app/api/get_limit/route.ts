import { NextRequest } from "next/server";
import { getClient } from "@/lib/routeHelpers";
import { errorResponse, jsonResponse, optionsResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** GET /api/get_limit[?account=] -> credits of the account (plus plan and upload limits). */
export async function GET(req: NextRequest) {
  try {
    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    const limit = await client.api.get_credits();
    return jsonResponse({ ...limit, account_id: client.auth.accountId ?? null });
  } catch (error: any) {
    return errorResponse(error, 'Error fetching limit');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
