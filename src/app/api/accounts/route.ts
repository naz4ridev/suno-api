import { NextRequest } from 'next/server';
import { requireAccountsAdmin } from '@/lib/apiAuth';
import {
  AccountError,
  getAccount,
  getDefaultAccountId,
  listAccounts,
  normalizeAccountCookie,
  suggestAccountId,
  toPublicAccount,
  upsertStoreAccount
} from '@/lib/accounts';
import { inspectCookie } from '@/lib/accountService';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * GET /api/accounts -> registered Suno accounts (cookies are never returned).
 */
export async function GET() {
  try {
    return jsonResponse({
      default_account_id: getDefaultAccountId(),
      accounts: listAccounts().map(toPublicAccount)
    });
  } catch (error: any) {
    return errorResponse(error, 'Error listing accounts');
  }
}

/**
 * POST /api/accounts
 * Body: { cookie: "<full cookie header or __client value>", id?, label?, make_default?, skip_check? }
 * The cookie is validated against Suno (session + credits) before it is stored.
 */
export async function POST(req: NextRequest) {
  const denied = requireAccountsAdmin(req);
  if (denied)
    return denied;

  try {
    const body = await req.json();
    const cookie = normalizeAccountCookie(body.cookie ?? body.suno_cookie);
    if (!cookie)
      return jsonResponse({ error: 'cookie is required (full Cookie header or the __client value)' }, 400);

    let user: any;
    let lastCheck: any;
    if (!parseBoolean(body.skip_check)) {
      try {
        const inspected = await inspectCookie(cookie);
        user = inspected.user;
        lastCheck = inspected.check;
      } catch (error: any) {
        throw new AccountError(`Could not log in with this cookie: ${error?.message || error}`, 422);
      }
    }

    const duplicate = user?.id
      ? listAccounts().find(account => account.user?.id === user.id && account.id !== body.id)
      : undefined;
    if (duplicate && !parseBoolean(body.allow_duplicate)) {
      return jsonResponse(
        { error: `This Suno user is already registered as account "${duplicate.id}". Use PATCH /api/accounts/${duplicate.id} to replace its cookie.` },
        409
      );
    }

    const id = typeof body.id === 'string' && body.id.trim()
      ? body.id.trim()
      : suggestAccountId(user, body.label);
    if (getAccount(id) && !parseBoolean(body.replace))
      return jsonResponse({ error: `Account id already exists: ${id} (send replace=true to overwrite)` }, 409);

    const account = upsertStoreAccount({
      id,
      cookie,
      label: body.label,
      user,
      last_check: lastCheck,
      make_default: parseBoolean(body.make_default) || !getDefaultAccountId()
    });

    return jsonResponse(toPublicAccount(account), 201);
  } catch (error: any) {
    return errorResponse(error, 'Error adding account');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
