import axios from 'axios';
import { createSocksProxy, noProxy, type SunoProxy } from '@suno-sdk';

/**
 * Outbound egress for everything suno-api sends to Suno/Clerk/S3.
 * SUNO_PROXY_URL, e.g. `socks5h://tailscale-egress:1055` (residential exit via Tailscale).
 * When set, requests fail if the proxy is down instead of leaking through the server IP.
 */
export const proxyUrl = process.env.SUNO_PROXY_URL?.trim() || '';

let proxy: SunoProxy | undefined;

/** The SDK proxy for this process (created lazily so an unsupported scheme fails on first use). */
export function getSunoProxy(): SunoProxy {
  proxy ??= proxyUrl ? createSocksProxy(proxyUrl) : noProxy;
  return proxy;
}

/** axios options that route a request through the egress proxy. */
export function proxiedAxiosConfig() {
  return getSunoProxy().axiosConfig();
}

/** Playwright/Chromium proxy settings (Chromium resolves DNS in the proxy for socks5). */
export function browserProxy(): { server: string } | undefined {
  return getSunoProxy().browser?.();
}

/** Public IP information as seen through the configured egress. */
export async function describeEgress(): Promise<Record<string, any>> {
  const response = await axios.get('https://ipinfo.io/json', { timeout: 15000, ...proxiedAxiosConfig() });
  const { ip, country, org, city } = response.data || {};
  return { proxied: Boolean(proxyUrl), ip, country, org, city };
}
