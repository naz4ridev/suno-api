import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';

/**
 * Outbound egress for everything suno-api sends to Suno/Clerk/S3.
 * SUNO_PROXY_URL, e.g. `socks5h://tailscale-egress:1055` (residential exit via Tailscale).
 * When set, requests fail if the proxy is down instead of leaking through the server IP.
 */
export const proxyUrl = process.env.SUNO_PROXY_URL?.trim() || '';

let agent: SocksProxyAgent | undefined;

export function getProxyAgent(): SocksProxyAgent | undefined {
  if (!proxyUrl)
    return undefined;
  if (!proxyUrl.startsWith('socks'))
    throw new Error(`Unsupported SUNO_PROXY_URL scheme (expected socks5:// or socks5h://): ${proxyUrl}`);
  agent ??= new SocksProxyAgent(proxyUrl);
  return agent;
}

/** axios options that route a request through the egress proxy. */
export function proxiedAxiosConfig() {
  const proxyAgent = getProxyAgent();
  return proxyAgent ? { httpAgent: proxyAgent, httpsAgent: proxyAgent, proxy: false as const } : {};
}

/** Playwright/Chromium proxy settings (Chromium resolves DNS in the proxy for socks5). */
export function browserProxy(): { server: string } | undefined {
  if (!proxyUrl)
    return undefined;
  return { server: proxyUrl.replace(/^socks5h:/, 'socks5:') };
}

/** Public IP information as seen through the configured egress. */
export async function describeEgress(): Promise<Record<string, any>> {
  const response = await axios.get('https://ipinfo.io/json', { timeout: 15000, ...proxiedAxiosConfig() });
  const { ip, country, org, city } = response.data || {};
  return { proxied: Boolean(proxyUrl), ip, country, org, city };
}
