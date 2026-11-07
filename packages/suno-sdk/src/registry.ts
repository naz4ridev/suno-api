import { decodeCookieValue, type SunoAccountResolver } from './accounts.ts';
import { resolveRuntime, type SunoRuntime, type SunoRuntimeOptions } from './runtime.ts';
import { SunoApi } from './SunoApi.ts';

export interface SunoRegistryOptions extends SunoRuntimeOptions {
  /** Where accounts come from when a call names an account instead of a cookie. */
  accounts?: SunoAccountResolver;
  missingCookieMessage?: string;
  missingAccountMessage?: string;
}

export interface SunoRegistry {
  readonly runtime: SunoRuntime;
  /**
   * Returns an initialised client for a cookie. Instances are cached per cookie, so several accounts stay
   * authenticated at the same time. Concurrent first calls share the same init.
   */
  sunoApi(cookie?: string, accountId?: string): Promise<SunoApi>;
  /** Client for a registered account (id, label, email or handle). Without selector, the default account. */
  sunoApiForAccount(selector?: string | null): Promise<SunoApi>;
  /** Drops cached clients (e.g. after an account cookie was replaced or removed). */
  evict(account?: { cookie?: string } | null): void;
}

/**
 * Cache of authenticated clients, scoped to one host (no module-level or `global` state), so two hosts in
 * the same process never share sessions, proxies or captcha providers.
 */
export function createSunoRegistry(options: SunoRegistryOptions = {}): SunoRegistry {
  const runtime = resolveRuntime(options);
  const cache = new Map<string, SunoApi>();
  const pendingInits = new Map<string, Promise<SunoApi>>();

  const sunoApi: SunoRegistry['sunoApi'] = async (cookie, accountId) => {
    let resolvedCookie = decodeCookieValue(cookie);
    let resolvedAccountId = accountId;
    if (!resolvedCookie) {
      const account = await options.accounts?.resolve(accountId);
      resolvedCookie = account?.cookie || '';
      resolvedAccountId = account?.id;
    }
    if (!resolvedCookie)
      throw new Error(options.missingCookieMessage
        || 'Please provide a Suno cookie or select a configured account.');

    const cachedInstance = cache.get(resolvedCookie);
    if (cachedInstance) {
      if (resolvedAccountId && !cachedInstance.accountId)
        cachedInstance.accountId = resolvedAccountId;
      return cachedInstance;
    }

    let pending = pendingInits.get(resolvedCookie);
    if (!pending) {
      const key = resolvedCookie;
      pending = new SunoApi(key, runtime)
        .init()
        .then(instance => {
          instance.accountId = resolvedAccountId;
          cache.set(key, instance);
          return instance;
        })
        .finally(() => pendingInits.delete(key));
      pendingInits.set(key, pending);
    }
    return pending;
  };

  return {
    runtime,
    sunoApi,
    async sunoApiForAccount(selector) {
      const account = await options.accounts?.resolve(selector);
      if (!account)
        throw new Error(options.missingAccountMessage || 'No Suno account configured.');
      return sunoApi(account.cookie, account.id);
    },
    evict(account) {
      if (account?.cookie)
        cache.delete(account.cookie);
    }
  };
}
