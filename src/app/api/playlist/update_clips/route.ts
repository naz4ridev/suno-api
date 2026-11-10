import { NextRequest, NextResponse } from 'next/server';
import { missingSunoCookieResponse, resolveSunoCookie } from '@/lib/apiAuth';
import { corsHeaders } from '@/lib/utils';
import { sunoApi } from '@/lib/SunoApi';
import { viaMcp } from '@/lib/sunoMcp';
import { mcpOps } from '@suno-sdk';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const playlistId =
      typeof body.playlist_id === 'string' ? body.playlist_id.trim() : '';
    const rawClipIds =
      body.metadata?.clip_ids ??
      body.clip_ids ??
      body.clip_id;
    const clipIds = Array.isArray(rawClipIds)
      ? rawClipIds
      : typeof rawClipIds === 'string'
        ? rawClipIds.split(',').map((clipId: string) => clipId.trim()).filter(Boolean)
        : [];

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

    if (clipIds.length === 0) {
      return new NextResponse(
        JSON.stringify({ error: 'Missing clip_ids or clip_id' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      );
    }

    const mcp = await viaMcp(req, body, c =>
      mcpOps.updatePlaylistClips(c, playlistId, body.update_type === 'remove' ? 'remove' : 'add', clipIds));
    if (mcp)
      return mcp;

    const sunoCookie = resolveSunoCookie(req, body);
    if (!sunoCookie)
      return missingSunoCookieResponse();

    const updateType =
      body.update_type === 'remove'
        ? 'remove'
        : 'add';

    const response = await (await sunoApi(sunoCookie)).updatePlaylistClips({
      playlist_id: playlistId,
      update_type: updateType,
      metadata: { clip_ids: clipIds },
      recommendation_metadata:
        body.recommendation_metadata && typeof body.recommendation_metadata === 'object'
          ? body.recommendation_metadata
          : {}
    });

    return new NextResponse(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error: any) {
    console.error('Error updating playlist clips:', error);

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
