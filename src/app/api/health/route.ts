import { listAccounts } from '@/lib/accounts';
import { jsonResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** Liveness check (no Suno login, no auth). */
export async function GET() {
  let accounts = 0;
  try {
    accounts = listAccounts().filter(account => !account.disabled).length;
  } catch {
    accounts = -1;
  }
  return jsonResponse({ ok: true, accounts });
}
