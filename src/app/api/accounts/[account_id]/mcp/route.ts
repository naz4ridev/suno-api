import { NextRequest } from 'next/server';
import { requireAccountsAdmin } from '@/lib/apiAuth';
import { AccountError, toPublicAccount, upsertStoreAccount } from '@/lib/accounts';
import { requireAccount } from '@/lib/accountService';
import { disconnectMcp, linkMcp } from '@/lib/sunoMcp';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Params = { params: { account_id: string } };

/**
 * POST /api/accounts/{id}/mcp { relink? } -> connects a cookie account to the official Suno MCP with its own
 * Suno session (no browser). `relink: true` revokes the current connection and makes a new one.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const denied = requireAccountsAdmin(req);
  if (denied)
    return denied;
  try {
    const body = await req.json().catch(() => ({}));
    const account = await linkMcp(requireAccount(params.account_id), parseBoolean(body.relink));
    return jsonResponse(toPublicAccount(account));
  } catch (error: any) {
    return errorResponse(error, 'Error linking Suno MCP');
  }
}

/**
 * DELETE /api/accounts/{id}/mcp -> revokes the account's Suno MCP connection; it keeps working through its
 * cookie. An account connected only through the MCP is removed with DELETE /api/accounts/{id} instead.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  const denied = requireAccountsAdmin(req);
  if (denied)
    return denied;
  try {
    const account = requireAccount(params.account_id);
    if (!account.cookie)
      throw new AccountError(`Account "${account.id}" only has its Suno MCP connection: delete the account instead`, 409);
    const revoked = await disconnectMcp(account);
    return jsonResponse({ ...toPublicAccount(upsertStoreAccount({ id: account.id, mcp: null, mcp_error: null })), mcp_revoked: revoked });
  } catch (error: any) {
    return errorResponse(error, 'Error unlinking Suno MCP');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
