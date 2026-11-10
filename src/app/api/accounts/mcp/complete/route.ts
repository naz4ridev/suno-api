import { NextRequest } from 'next/server';
import { requireAccountsAdmin } from '@/lib/apiAuth';
import { toPublicAccount } from '@/lib/accounts';
import { completeAuthorization } from '@/lib/sunoMcp';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * POST /api/accounts/mcp/complete  { callback_url }
 * For when the browser cannot reach /api/accounts/mcp/callback: paste the URL Suno redirected to (it has
 * `code` and `state`) and the account is stored the same way. Needs the API key (and x-admin-token if set).
 */
export async function POST(req: NextRequest) {
  const denied = requireAccountsAdmin(req);
  if (denied)
    return denied;

  try {
    const body = await req.json().catch(() => ({}));
    let query: URLSearchParams;
    try {
      query = new URL(String(body.callback_url ?? '')).searchParams;
    } catch {
      return jsonResponse({ error: 'callback_url must be the full URL Suno redirected to' }, 400);
    }
    const account = await completeAuthorization(query);
    return jsonResponse({ connected: true, account: toPublicAccount(account) }, 201);
  } catch (error: any) {
    return errorResponse(error, 'Error completing Suno MCP authorization');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
