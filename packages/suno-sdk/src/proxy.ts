import { SocksProxyAgent } from 'socks-proxy-agent';
import type { SunoProxy } from './runtime.ts';

/**
 * Egress through a SOCKS proxy, e.g. `socks5h://tailscale-egress:1055`.
 * When a proxy is configured, requests fail if it is down instead of leaking through the host IP.
 */
export function createSocksProxy(proxyUrl: string): SunoProxy {
  const url = proxyUrl.trim();
  if (!url.startsWith('socks'))
    throw new Error('Unsupported proxy scheme (expected socks5:// or socks5h://)');
  let agent: SocksProxyAgent | undefined;
  return {
    axiosConfig() {
      agent ??= new SocksProxyAgent(url);
      return { httpAgent: agent, httpsAgent: agent, proxy: false as const };
    },
    // Chromium resolves DNS in the proxy for socks5.
    browser: () => ({ server: url.replace(/^socks5h:/, 'socks5:') })
  };
}
