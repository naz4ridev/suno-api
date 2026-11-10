import { NextRequest, NextResponse } from 'next/server';
import { missingSunoCookieResponse, resolveSunoCookie } from '@/lib/apiAuth';
import { corsHeaders } from '@/lib/utils';
import { sunoApi } from '@/lib/SunoApi';
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps } from '@suno-sdk';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const page = Number(url.searchParams.get('page') ?? '1');
    const showTrashed = String(url.searchParams.get('show_trashed') ?? 'false').toLowerCase() === 'true';
    const showSharelist = String(url.searchParams.get('show_sharelist') ?? 'false').toLowerCase() === 'true';

    const mcp = await viaMcp(req, null, c => mcpOps.listMyPlaylists(c, Number.isFinite(page) && page > 0 ? page : 1),
      // The MCP list has no playlist description (clients match playlists by it): cookie accounts keep the web list.
      200, { auto: false });
    if (mcp)
      return mcp;

    const sunoCookie = resolveSunoCookie(req);
    if (!sunoCookie)
      return missingSunoCookieResponse();

    const response = await (await sunoApi(sunoCookie)).getMyPlaylists(
      Number.isFinite(page) && page > 0 ? page : 1,
      showTrashed,
      showSharelist
    );

    return new NextResponse(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error: any) {
    console.error('Error fetching playlists:', error);

    const status = error?.status || error?.response?.status || 500;
    const message =
      error?.response?.data?.detail ||
      error?.response?.data?.error ||
      error?.message ||
      'Internal server error';

    return new NextResponse(JSON.stringify({ error: message }), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
