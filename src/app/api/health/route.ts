import { listAccounts } from '@/lib/accounts';
import { describeEgress, proxyUrl } from '@/lib/egress';
import { jsonResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Liveness check (no Suno login, no auth).
 * `?egress=1` also reports the public IP seen through SUNO_PROXY_URL (503 if the egress is down).
 */
export async function GET(req: Request) {
  let accounts = 0;
  try {
    accounts = listAccounts().filter(account => !account.disabled).length;
  } catch {
    accounts = -1;
  }

  const body: Record<string, any> = { ok: true, accounts, proxy: proxyUrl ? proxyUrl.replace(/\/\/.*@/, '//***@') : null };
  if (new URL(req.url).searchParams.get('egress')) {
    try {
      body.egress = await describeEgress();
    } catch (error: any) {
      body.ok = false;
      body.egress = { error: error?.message || String(error) };
      return jsonResponse(body, 503);
    }
  }
  return jsonResponse(body);
}
