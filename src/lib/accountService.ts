import {
  AccountCheck,
  AccountUserInfo,
  getAccount,
  SunoAccount,
  upsertStoreAccount
} from '@/lib/accounts';
import { evictSunoApi, sunoApi } from '@/lib/SunoApi';

/**
 * Logs in with the cookie and reads the user + credits. Throws when the cookie is not valid.
 */
export async function inspectCookie(cookie: string): Promise<{ user: AccountUserInfo; check: AccountCheck }> {
  const api = await sunoApi(cookie);
  const [user, credits] = await Promise.all([
    api.getUserInfo(),
    api.get_credits().catch(() => null) as Promise<any>
  ]);

  return {
    user,
    check: {
      ok: true,
      at: new Date().toISOString(),
      credits_left: credits?.credits_left,
      plan: credits?.plan
    }
  };
}

/**
 * Re-validates an account and stores the result (user info + last_check).
 */
export async function checkAccount(account: SunoAccount): Promise<SunoAccount> {
  try {
    const { user, check } = await inspectCookie(account.cookie);
    return upsertStoreAccount({ id: account.id, user, last_check: check });
  } catch (error: any) {
    evictSunoApi(account);
    upsertStoreAccount({
      id: account.id,
      last_check: {
        ok: false,
        at: new Date().toISOString(),
        error: error?.message || String(error)
      }
    });
    throw error;
  }
}

export function requireAccount(accountId: string): SunoAccount {
  const account = getAccount(accountId);
  if (!account) {
    const error = new Error(`Suno account not found: ${accountId}`);
    (error as any).status = 404;
    throw error;
  }
  return account;
}
