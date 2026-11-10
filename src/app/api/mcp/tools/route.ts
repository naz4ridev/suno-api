import { NextRequest } from 'next/server';
import { resolveAccountSelector } from '@/lib/apiAuth';
import { AccountError, resolveAccount } from '@/lib/accounts';
import { withMcp } from '@/lib/sunoMcp';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mcp/tools[?account=] -> tools the official Suno MCP exposes to this account (name, description,
 * inputSchema). Works with cookie accounts (linked on first use) and MCP-only OAuth accounts.
 */
export async function GET(req: NextRequest) {
  try {
    const account = resolveAccount(resolveAccountSelector(req));
    if (!account)
      throw new AccountError('No Suno account configured. Add one with POST /api/accounts or /api/accounts/mcp/authorize.', 400);
    const tools = await withMcp(account, client => client.listTools());
    return jsonResponse({ account_id: account.id, tools });
  } catch (error: any) {
    return errorResponse(error, 'Error listing Suno MCP tools');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
