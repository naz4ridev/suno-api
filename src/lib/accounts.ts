import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Multi-account registry.
 *
 * Accounts come from two sources:
 *  - `env`: read-only accounts declared with SUNO_COOKIE (id `SUNO_DEFAULT_ACCOUNT_ID`, default "default")
 *    and SUNO_ACCOUNTS (JSON array: [{ "id": "main", "cookie": "...", "label": "..." }]).
 *  - `store`: accounts added through the /api/accounts endpoints, persisted in SUNO_ACCOUNTS_FILE
 *    (default ./.data/accounts.json). This file contains Suno cookies: keep it out of git and backups you share.
 */

export type AccountSource = 'env' | 'store';

export type AccountUserInfo = {
  id?: string;
  email?: string;
  handle?: string;
  display_name?: string;
};

export type AccountCheck = {
  ok: boolean;
  at: string;
  error?: string;
  credits_left?: number;
  plan?: string;
};

export type SunoAccount = {
  id: string;
  label?: string;
  cookie: string;
  source: AccountSource;
  disabled?: boolean;
  created_at?: string;
  updated_at?: string;
  user?: AccountUserInfo;
  last_check?: AccountCheck;
};

export type PublicSunoAccount = Omit<SunoAccount, 'cookie'> & {
  is_default: boolean;
  cookie_preview: string;
};

type StoredAccount = Omit<SunoAccount, 'source' | 'cookie'> & { cookie?: string };

type StoreFile = {
  default_account_id?: string | null;
  accounts: StoredAccount[];
};

export class AccountError extends Error {
  status: number;

  constructor(message: string, status: number = 400) {
    super(message);
    this.status = status;
  }
}

const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

const resolveStoreFile = () => {
  const configured = process.env.SUNO_ACCOUNTS_FILE?.trim();
  if (configured)
    return path.resolve(configured);

  return path.resolve(process.cwd(), '.data', 'accounts.json');
};

const STORE_FILE = resolveStoreFile();

const envDefaultAccountId = () =>
  process.env.SUNO_DEFAULT_ACCOUNT_ID?.trim() || 'default';

function decodeCookieValue(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value))
    return value;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Accepts a full cookie header (`__client=...; other=...`) or a bare `__client` value.
 */
export function normalizeAccountCookie(value: unknown): string | null {
  if (typeof value !== 'string')
    return null;

  const trimmed = decodeCookieValue(value.trim());
  if (!trimmed)
    return null;

  if (!trimmed.includes('='))
    return `__client=${trimmed}`;

  return trimmed;
}

let storeCache: { mtimeMs: number; data: StoreFile } | null = null;

function readStore(): StoreFile {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(STORE_FILE);
  } catch (error: any) {
    if (error?.code === 'ENOENT')
      return { default_account_id: null, accounts: [] };
    throw error;
  }

  if (storeCache && storeCache.mtimeMs === stat.mtimeMs)
    return storeCache.data;

  const raw = fs.readFileSync(STORE_FILE, 'utf8');
  const parsed = raw.trim() ? JSON.parse(raw) : {};
  const data: StoreFile = {
    default_account_id: parsed.default_account_id ?? null,
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
  };
  storeCache = { mtimeMs: stat.mtimeMs, data };
  return data;
}

function writeStore(data: StoreFile) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const tempPath = `${STORE_FILE}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, STORE_FILE);
  storeCache = null;
}

function readEnvAccounts(): SunoAccount[] {
  const accounts: SunoAccount[] = [];
  const envCookie = normalizeAccountCookie(process.env.SUNO_COOKIE);
  if (envCookie) {
    accounts.push({
      id: envDefaultAccountId(),
      label: 'SUNO_COOKIE',
      cookie: envCookie,
      source: 'env'
    });
  }

  const rawAccounts = process.env.SUNO_ACCOUNTS?.trim();
  if (rawAccounts) {
    try {
      const parsed = JSON.parse(rawAccounts);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const cookie = normalizeAccountCookie(item?.cookie);
          const id = typeof item?.id === 'string' ? item.id.trim() : '';
          if (!cookie || !ACCOUNT_ID_PATTERN.test(id))
            continue;

          accounts.push({
            id,
            label: typeof item.label === 'string' ? item.label : undefined,
            cookie,
            source: 'env'
          });
        }
      }
    } catch (error) {
      console.error('Invalid SUNO_ACCOUNTS env var (expected a JSON array):', error);
    }
  }

  return accounts;
}

export function listAccounts(): SunoAccount[] {
  const byId = new Map<string, SunoAccount>();
  for (const account of readEnvAccounts())
    byId.set(account.id, account);

  // Store entries override env accounts with the same id (metadata, checks, cookie if set).
  for (const account of readStore().accounts) {
    const envAccount = byId.get(account.id);
    const cookie = account.cookie || envAccount?.cookie;
    if (!cookie)
      continue;

    byId.set(account.id, {
      ...envAccount,
      ...account,
      cookie,
      source: envAccount && !account.cookie ? 'env' : 'store'
    });
  }

  return Array.from(byId.values());
}

export function getDefaultAccountId(): string | null {
  const accounts = listAccounts().filter(account => !account.disabled);
  const storeDefault = readStore().default_account_id;
  if (storeDefault && accounts.some(account => account.id === storeDefault))
    return storeDefault;

  const envDefault = envDefaultAccountId();
  if (accounts.some(account => account.id === envDefault))
    return envDefault;

  return accounts[0]?.id ?? null;
}

export function getAccount(accountId: string): SunoAccount | null {
  return listAccounts().find(account => account.id === accountId) ?? null;
}

/**
 * Resolves which account should serve a request.
 * `accountId` may be an account id, a label, an email or a Suno handle.
 */
export function resolveAccount(accountId?: string | null): SunoAccount | null {
  const accounts = listAccounts();
  const requested = accountId?.trim();

  if (!requested) {
    const defaultId = getDefaultAccountId();
    return defaultId ? accounts.find(account => account.id === defaultId) ?? null : null;
  }

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

export function toPublicAccount(account: SunoAccount): PublicSunoAccount {
  const { cookie, ...rest } = account;
  const clientMatch = cookie.match(/__client=([^;]+)/);
  const secret = clientMatch?.[1] || cookie;

  return {
    ...rest,
    is_default: getDefaultAccountId() === account.id,
    cookie_preview: secret.length > 12 ? `${secret.slice(0, 6)}…${secret.slice(-4)}` : '***'
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function suggestAccountId(user?: AccountUserInfo, label?: string): string {
  const base =
    slugify(label || '') ||
    slugify(user?.handle || '') ||
    slugify(user?.email?.split('@')[0] || '') ||
    `account-${randomUUID().slice(0, 8)}`;
  const existing = new Set(listAccounts().map(account => account.id));
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate))
    candidate = `${base}-${suffix++}`;
  return candidate;
}

export function upsertStoreAccount(input: {
  id: string;
  cookie?: string;
  label?: string;
  disabled?: boolean;
  user?: AccountUserInfo;
  last_check?: AccountCheck;
  make_default?: boolean;
}): SunoAccount {
  if (!ACCOUNT_ID_PATTERN.test(input.id))
    throw new AccountError('Invalid account id. Use letters, numbers, ".", "_" or "-" (max 64 chars).');

  const store = readStore();
  const now = new Date().toISOString();
  const index = store.accounts.findIndex(account => account.id === input.id);
  const envAccount = readEnvAccounts().find(account => account.id === input.id);
  const previous = index >= 0 ? store.accounts[index] : envAccount;

  // Env accounts keep their cookie in the environment; only persist a cookie when one is given.
  const cookie = input.cookie ?? (index >= 0 ? store.accounts[index].cookie : undefined);
  if (!cookie && !envAccount)
    throw new AccountError('cookie is required');

  const next: StoredAccount = {
    id: input.id,
    label: input.label ?? previous?.label,
    cookie,
    disabled: input.disabled ?? previous?.disabled ?? false,
    created_at: (index >= 0 ? store.accounts[index].created_at : undefined) || now,
    updated_at: now,
    user: input.user ?? previous?.user,
    last_check: input.last_check ?? previous?.last_check
  };

  const accounts = [...store.accounts];
  if (index >= 0)
    accounts[index] = next;
  else
    accounts.push(next);

  writeStore({
    default_account_id: input.make_default ? input.id : store.default_account_id ?? null,
    accounts
  });

  return getAccount(input.id) as SunoAccount;
}

export function setDefaultAccount(accountId: string) {
  if (!getAccount(accountId))
    throw new AccountError(`Suno account not found: ${accountId}`, 404);

  const store = readStore();
  writeStore({ ...store, default_account_id: accountId });
}

export function removeStoreAccount(accountId: string): boolean {
  const store = readStore();
  const accounts = store.accounts.filter(account => account.id !== accountId);
  if (accounts.length === store.accounts.length)
    return false;

  writeStore({
    default_account_id: store.default_account_id === accountId ? null : store.default_account_id ?? null,
    accounts
  });
  return true;
}

export function isEnvAccount(accountId: string): boolean {
  return readEnvAccounts().some(account => account.id === accountId);
}
