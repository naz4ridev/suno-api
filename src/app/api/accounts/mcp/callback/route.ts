import { NextRequest } from 'next/server';
import { toPublicAccount } from '@/lib/accounts';
import { completeAuthorization } from '@/lib/sunoMcp';
import { errorResponse, jsonResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * GET /api/accounts/mcp/callback?code&state -> where Suno sends the browser after the user accepts.
 * Public (no x-api-key: the browser cannot send it). It is safe because the single-use, 10-minute `state`
 * only exists in the /authorize answer given to an admin, and the code is useless without the PKCE verifier
 * kept on this server.
 */
export async function GET(req: NextRequest) {
  // A person lands here from suno.com: answer them with a page; API clients still get JSON.
  const wantsPage = (req.headers.get('accept') || '').includes('text/html');
  try {
    const account = await completeAuthorization(req.nextUrl.searchParams);
    if (wantsPage)
      return page(201, 'Cuenta de Suno conectada', `La cuenta <b>${escapeHtml(account.user?.handle || account.id)}</b> ya puede usar el MCP oficial de Suno. Puedes cerrar esta pestaña.`);
    return jsonResponse({ connected: true, account: toPublicAccount(account) }, 201);
  } catch (error: any) {
    if (wantsPage)
      return page(Number(error?.status) || 500, 'No se pudo conectar la cuenta', escapeHtml(error?.message || String(error)));
    return errorResponse(error, 'Error completing Suno MCP authorization');
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

function page(status: number, title: string, message: string) {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#0b1b3a}h1{font-size:1.3rem}</style></head>
<body><h1>${title}</h1><p>${message}</p></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
