import { NextRequest, NextResponse } from 'next/server';

/**
 * Optional API key for every API route. When SUNO_API_KEY is set, requests to /api/* and /v1/*
 * must send `x-api-key: <key>` or `Authorization: Bearer <key>`. /api/health and CORS preflights stay open.
 * suno-api is meant to be reachable only from the internal Docker network and the VPN; this key stops
 * other containers on the shared network from using the Suno accounts.
 */
const PUBLIC_PATHS = new Set(['/api/health']);

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const expected = process.env.SUNO_API_KEY?.trim();
  if (!expected || req.method === 'OPTIONS')
    return NextResponse.next();

  const basePath = req.nextUrl.basePath || '';
  const pathname = req.nextUrl.pathname.startsWith(basePath)
    ? req.nextUrl.pathname.slice(basePath.length) || '/'
    : req.nextUrl.pathname;
  if (PUBLIC_PATHS.has(pathname.replace(/\/+$/, '')))
    return NextResponse.next();

  const authorization = req.headers.get('authorization') || '';
  const provided =
    req.headers.get('x-api-key')?.trim() ||
    (authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '');

  if (provided && safeEqual(provided, expected))
    return NextResponse.next();

  return NextResponse.json(
    { error: 'Missing or invalid API key (send the x-api-key header)' },
    {
      status: 401,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'WWW-Authenticate': 'Bearer realm="suno-api"'
      }
    }
  );
}

export const config = {
  matcher: ['/api/:path*', '/v1/:path*']
};
