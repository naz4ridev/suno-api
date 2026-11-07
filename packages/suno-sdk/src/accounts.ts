/**
 * Account selection shared by every host. The SDK never stores accounts: the host owns the registry
 * (suno-api: env + JSON store; desktop: its encrypted account list) and hands records over on demand.
 */

export interface SunoAccountRecord {
  id: string;
  cookie: string;
  label?: string;
  disabled?: boolean;
  /** Marks the account used when a call names none. Without one, the first enabled account is the default. */
  isDefault?: boolean;
  user?: { id?: string; email?: string; handle?: string };
}

/** Resolves a selector (id, label, email or handle; empty = default account) to a record. */
export interface SunoAccountResolver {
  resolve(selector?: string | null): Promise<Pick<SunoAccountRecord, 'id' | 'cookie'> | null> | Pick<SunoAccountRecord, 'id' | 'cookie'> | null;
}

export class AccountError extends Error {
  status: number;

  constructor(message: string, status: number = 400) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
  }
}

/**
 * Picks the account that serves a request. `selector` may be an account id, a label, an email or a Suno
 * handle. Without selector the default account wins. Unknown (404) and disabled (409) accounts throw.
 */
export function selectAccount<T extends SunoAccountRecord>(
  accounts: readonly T[],
  selector?: string | null,
  defaultId?: string | null
): T | null {
  const requested = selector?.trim();
  if (!requested)
    return defaultId ? accounts.find(account => account.id === defaultId) ?? null : null;

  const normalized = requested.toLowerCase();
  const account =
    accounts.find(item => item.id === requested) ||
    accounts.find(item =>
      [item.label, item.user?.email, item.user?.handle]
        .filter(Boolean)
        .some(value => String(value).toLowerCase() === normalized)
    );

  if (!account)
    throw new AccountError(`Suno account not found: ${requested}`, 404);
  if (account.disabled)
    throw new AccountError(`Suno account is disabled: ${account.id}`, 409);
  return account;
}

/** Cookies may arrive percent-encoded (copied from a Cookie header); the session wants them decoded. */
export function decodeCookieValue(value?: string | null): string {
  if (!value)
    return value ?? '';
  const trimmed = value.trim();
  if (!/%[0-9A-Fa-f]{2}/.test(trimmed))
    return trimmed;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}
