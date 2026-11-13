import { NextResponse, NextRequest } from "next/server";
import { missingSunoCookieResponse, resolveSunoCookie } from "@/lib/apiAuth";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps } from '@suno-sdk';

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      const clipId = url.searchParams.get('id');
      if (clipId == null) {
        return new NextResponse(JSON.stringify({ error: 'Missing parameter id' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      const mcp = await viaMcp(req, null, async (c, account) => (await mcpOps.retrieveClips(c, [clipId], account.user))[0]);
      if (mcp)
        return mcp;

      const sunoCookie = resolveSunoCookie(req);
      if (!sunoCookie)
        return missingSunoCookieResponse();

      const audioInfo = await (await sunoApi(sunoCookie)).getClip(clipId);

      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error: any) {
      console.error('Error fetching audio:', error);

      const status =
        error?.status ||
        error?.response?.status ||
        500;
      const message =
        error?.response?.data?.detail ||
        error?.response?.data?.error ||
        error?.message ||
        'Internal server error';

      return new NextResponse(JSON.stringify({ error: message }), {
        status: status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'GET',
        ...corsHeaders
      },
      status: 405
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
