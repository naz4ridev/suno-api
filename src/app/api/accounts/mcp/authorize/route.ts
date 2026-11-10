import { NextRequest } from 'next/server';
import { requireAccountsAdmin } from '@/lib/apiAuth';
import { startAuthorization } from '@/lib/sunoMcp';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * POST /api/accounts/mcp/authorize  { id?, label?, make_default?, replace? }
 * Starts adding an account through Suno's official OAuth (no cookie): open `authorize_url` in a browser
 * signed in to suno.com and accept. Suno redirects to /api/accounts/mcp/callback, which stores the account.
 * The account can then use the MCP tools (/api/mcp/*), not the cookie-based endpoints.
 * The callback URL is SUNO_PUBLIC_URL + basePath + /api/accounts/mcp/callback (default: this request's origin).
 */
export async function POST(req: NextRequest) {
  const denied = requireAccountsAdmin(req);
  if (denied)
    return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const origin = process.env.SUNO_PUBLIC_URL?.trim().replace(/\/+$/, '') || req.nextUrl.origin;
    const redirectUri = `${origin}${req.nextUrl.basePath || ''}/api/accounts/mcp/callback`;
    const started = await startAuthorization(redirectUri, {
      id: typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined,
      label: typeof body.label === 'string' ? body.label : undefined,
      make_default: parseBoolean(body.make_default),
      replace: parseBoolean(body.replace)
    });
    return jsonResponse(started, 201);
  } catch (error: any) {
    return errorResponse(error, 'Error starting Suno MCP authorization');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
