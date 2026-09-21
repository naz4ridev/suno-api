import { NextRequest } from 'next/server';
import { toPublicAccount } from '@/lib/accounts';
import { checkAccount, requireAccount } from '@/lib/accountService';
import { errorResponse, jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * POST /api/accounts/{id}/check -> logs in, refreshes user info + credits and stores the result.
 */
export async function POST(_req: NextRequest, { params }: { params: { account_id: string } }) {
  try {
    const account = await checkAccount(requireAccount(params.account_id));
    return jsonResponse(toPublicAccount(account));
  } catch (error: any) {
    const status = Number(error?.status || error?.response?.status) || 502;
    return errorResponse(Object.assign(error, { status: status >= 400 ? status : 502 }), 'Account check failed');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
