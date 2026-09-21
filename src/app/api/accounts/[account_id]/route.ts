import { NextRequest } from 'next/server';
import { requireAccountsAdmin } from '@/lib/apiAuth';
import {
  AccountError,
  isEnvAccount,
  normalizeAccountCookie,
  removeStoreAccount,
  setDefaultAccount,
  toPublicAccount,
  upsertStoreAccount
} from '@/lib/accounts';
import { inspectCookie, requireAccount } from '@/lib/accountService';
import { evictSunoApi } from '@/lib/SunoApi';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Params = { params: { account_id: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    return jsonResponse(toPublicAccount(requireAccount(params.account_id)));
  } catch (error: any) {
    return errorResponse(error, 'Error reading account');
  }
}

/**
 * PATCH /api/accounts/{id}
 * Body: { label?, cookie? (validated), disabled?, make_default? }
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const denied = requireAccountsAdmin(req);
  if (denied)
    return denied;

  try {
    const current = requireAccount(params.account_id);
    const body = await req.json();

    let cookie: string | undefined;
    let user: any;
    let lastCheck: any;
    if (body.cookie !== undefined) {
      cookie = normalizeAccountCookie(body.cookie) || undefined;
      if (!cookie)
        return jsonResponse({ error: 'cookie cannot be empty' }, 400);
      try {
        const inspected = await inspectCookie(cookie);
        user = inspected.user;
        lastCheck = inspected.check;
      } catch (error: any) {
        throw new AccountError(`Could not log in with this cookie: ${error?.message || error}`, 422);
      }
      evictSunoApi(current);
    }

    const account = upsertStoreAccount({
      id: current.id,
      cookie,
      label: typeof body.label === 'string' ? body.label : undefined,
      disabled: body.disabled !== undefined ? parseBoolean(body.disabled) : undefined,
      user,
      last_check: lastCheck
    });

    if (parseBoolean(body.make_default))
      setDefaultAccount(account.id);

    return jsonResponse(toPublicAccount(account));
  } catch (error: any) {
    return errorResponse(error, 'Error updating account');
  }
}

/**
 * DELETE /api/accounts/{id} -> removes a stored account. Accounts from env vars can only be disabled.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  const denied = requireAccountsAdmin(req);
  if (denied)
    return denied;

  try {
    const account = requireAccount(params.account_id);
    evictSunoApi(account);
    const removed = removeStoreAccount(account.id);

    if (isEnvAccount(account.id)) {
      return jsonResponse(
        {
          error: `Account "${account.id}" comes from environment variables (SUNO_COOKIE / SUNO_ACCOUNTS). Remove it there or PATCH it with disabled=true.`,
          removed_overrides: removed
        },
        409
      );
    }

    return jsonResponse({ id: account.id, deleted: removed });
  } catch (error: any) {
    return errorResponse(error, 'Error deleting account');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
