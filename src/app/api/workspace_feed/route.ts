import { NextRequest, NextResponse } from 'next/server';
import { missingSunoCookieResponse, resolveSunoCookie } from '@/lib/apiAuth';
import { corsHeaders, errorResponse } from '@/lib/utils';
import { sunoApi } from '@/lib/SunoApi';

export const dynamic = 'force-dynamic';

async function handleRequest({
  req,
  payload,
  workspaceId,
  workspaceName,
  cursor,
  limit
}: {
  req: NextRequest;
  payload?: Record<string, any> | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  cursor?: string | null;
  limit?: number;
}) {
  if (!workspaceId && !workspaceName) {
    return new NextResponse(
      JSON.stringify({ error: 'workspace_id or workspace_name is required' }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      }
    );
  }

  const sunoCookie = resolveSunoCookie(req, payload);
  if (!sunoCookie)
    return missingSunoCookieResponse();

  const response = await (await sunoApi(sunoCookie)).getWorkspaceFeed(
    workspaceId || undefined,
    workspaceName || undefined,
    cursor,
    limit
  );

  return new NextResponse(JSON.stringify(response), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limitValue = Number(url.searchParams.get('limit') ?? '20');

    return await handleRequest({
      req,
      payload: null,
      workspaceId: url.searchParams.get('workspace_id'),
      workspaceName: url.searchParams.get('workspace_name'),
      cursor: url.searchParams.get('cursor'),
      limit: Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 20
    });
  } catch (error: any) {
    return errorResponse(error, 'Error fetching workspace feed');
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const limitValue = Number(body.limit ?? 20);

    return await handleRequest({
      req,
      payload: body,
      workspaceId: body.workspace_id,
      workspaceName: body.workspace_name,
      cursor: body.cursor ?? null,
      limit: Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 20
    });
  } catch (error: any) {
    return errorResponse(error, 'Error fetching workspace feed');
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
