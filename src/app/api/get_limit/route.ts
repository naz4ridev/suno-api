import { NextRequest } from "next/server";
import { getClient } from "@/lib/routeHelpers";
import { errorResponse, jsonResponse, optionsResponse } from "@/lib/utils";
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps } from '@suno-sdk';

export const dynamic = "force-dynamic";

/** GET /api/get_limit[?account=] -> credits of the account (plus plan and upload limits). */
export async function GET(req: NextRequest) {
  try {
    // Accounts connected only through the Suno MCP read their credits from its `account-usage` tool.
    const mcp = await viaMcp(req, null, async (c, account) => ({ ...(await mcpOps.accountCredits(c)), account_id: account.id, via: 'mcp' }),
      // Cookie accounts keep reading credits through the cookie: it is their health check.
      200, { auto: false });
    if (mcp)
      return mcp;

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
