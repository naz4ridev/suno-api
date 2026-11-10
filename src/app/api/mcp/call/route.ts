import { NextRequest } from 'next/server';
import { resolveAccountSelector } from '@/lib/apiAuth';
import { AccountError, resolveAccount } from '@/lib/accounts';
import { withMcp } from '@/lib/sunoMcp';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/mcp/call  { name, arguments?, account? }
 * Calls a tool of the official Suno MCP as the account and returns the MCP result
 * ({ content, structuredContent?, isError? }). Tools that generate music spend that account's credits.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.name !== 'string' || !body.name.trim())
      return jsonResponse({ error: 'name is required (see GET /api/mcp/tools)' }, 400);
    if (body.arguments !== undefined && (typeof body.arguments !== 'object' || Array.isArray(body.arguments)))
      return jsonResponse({ error: 'arguments must be an object' }, 400);

    const account = resolveAccount(resolveAccountSelector(req, body));
    if (!account)
      throw new AccountError('No Suno account configured. Add one with POST /api/accounts or /api/accounts/mcp/authorize.', 400);

    const result = await withMcp(account, client => client.callTool(body.name.trim(), body.arguments ?? {}));
    return jsonResponse({ account_id: account.id, tool: body.name.trim(), ...result });
  } catch (error: any) {
    return errorResponse(error, 'Error calling Suno MCP tool');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
