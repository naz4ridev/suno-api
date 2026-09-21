import { NextRequest, NextResponse } from 'next/server';
import { missingSunoCookieResponse, resolveSunoCookie } from '@/lib/apiAuth';
import { corsHeaders } from '@/lib/utils';
import { sunoApi } from '@/lib/SunoApi';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const playlistId =
      typeof body.playlist_id === 'string' ? body.playlist_id.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';

    if (!playlistId) {
      return new NextResponse(
        JSON.stringify({ error: 'Missing required field playlist_id' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      );
    }

    if (!name) {
      return new NextResponse(
        JSON.stringify({ error: 'Missing required field name' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      );
    }

    const sunoCookie = resolveSunoCookie(req, body);
    if (!sunoCookie)
      return missingSunoCookieResponse();

    const response = await (await sunoApi(sunoCookie)).setPlaylistMetadata({
      playlist_id: playlistId,
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      is_public: typeof body.is_public === 'boolean' ? body.is_public : undefined
    });

    return new NextResponse(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error: any) {
    console.error('Error updating playlist metadata:', error);

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
