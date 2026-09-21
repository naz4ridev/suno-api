import { NextResponse, NextRequest } from "next/server";
import { missingSunoCookieResponse, resolveSunoCookie } from "@/lib/apiAuth";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders, errorResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      const song_id = url.searchParams.get('song_id');

      if (!song_id) {
        return new NextResponse(JSON.stringify({ error: 'Song ID is required' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      const sunoCookie = resolveSunoCookie(req);
      if (!sunoCookie)
        return missingSunoCookieResponse();

      const lyricAlignment = await (await sunoApi(sunoCookie)).getLyricAlignment(song_id);


      return new NextResponse(JSON.stringify(lyricAlignment), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      return errorResponse(error, 'Error fetching lyric alignment');
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
