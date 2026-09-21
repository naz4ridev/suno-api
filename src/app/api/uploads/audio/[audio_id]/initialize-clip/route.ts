import { NextRequest, NextResponse } from 'next/server';
import { missingSunoCookieResponse, resolveSunoCookie } from '@/lib/apiAuth';
import { corsHeaders } from '@/lib/utils';
import { sunoApi } from '@/lib/SunoApi';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: { audio_id: string } }
) {
  try {
    const audioId = params.audio_id?.trim();
    if (!audioId) {
      return new NextResponse(
        JSON.stringify({ error: 'Missing path parameter audio_id' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      );
    }

    let body: Record<string, any> | null = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    const sunoCookie = resolveSunoCookie(req, body);
    if (!sunoCookie)
      return missingSunoCookieResponse();

    const initBody: { user_reviewed_tags?: boolean; downbeats?: any } = {};
    if (typeof body?.user_reviewed_tags === 'boolean')
      initBody.user_reviewed_tags = body.user_reviewed_tags;
    if (body?.downbeats !== undefined)
      initBody.downbeats = body.downbeats;

    const response = await (await sunoApi(sunoCookie)).initializeUploadClip(audioId, initBody);

    return new NextResponse(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error: any) {
    console.error('Error initializing uploaded audio clip:', error);

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
