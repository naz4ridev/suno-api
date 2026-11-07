import type { CaptchaProvider } from './captcha.ts';

/**
 * Everything the host injects into the SDK. The SDK reads no environment variable, no file, no Next.js
 * or Electron API: servers, CLIs and the desktop app all describe their world through these objects.
 */

export interface SunoLogger {
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error?(...args: any[]): void;
}

export const silentLogger: SunoLogger = { info() {}, warn() {}, error() {} };

/** Outbound egress. `axiosConfig()` is spread into every axios request (agents, `proxy: false`). */
export interface SunoProxy {
  axiosConfig(): Record<string, unknown>;
  /** Chromium proxy settings for browser-based captcha providers. */
  browser?(): { server: string } | undefined;
}

export const noProxy: SunoProxy = { axiosConfig: () => ({}), browser: () => undefined };

export interface SunoRuntimeOptions {
  /** Suno studio API origin. Defaults to the production API. */
  baseUrl?: string;
  /** Clerk (session/token) origin. Defaults to the production auth service. */
  authBaseUrl?: string;
  userAgent?: string;
  secChUa?: string;
  /** Retries of a 429 from the studio API (default 3). */
  max429Retries?: number;
  logger?: SunoLogger;
  proxy?: SunoProxy;
  captcha?: CaptchaProvider;
  /** Locale hint forwarded to captcha providers. */
  locale?: string;
}

export interface SunoRuntime {
  baseUrl: string;
  authBaseUrl: string;
  userAgent: string;
  secChUa: string;
  max429Retries: number;
  logger: SunoLogger;
  proxy: SunoProxy;
  captcha?: CaptchaProvider;
  locale?: string;
}

export const DEFAULT_BASE_URL = 'https://studio-api-prod.suno.com';
export const DEFAULT_AUTH_BASE_URL = 'https://auth.suno.com';
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
export const DEFAULT_SEC_CH_UA = '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"';

export function resolveRuntime(options: SunoRuntimeOptions = {}): SunoRuntime {
  const retries = Number(options.max429Retries);
  return {
    baseUrl: (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    authBaseUrl: (options.authBaseUrl || DEFAULT_AUTH_BASE_URL).replace(/\/+$/, ''),
    userAgent: options.userAgent || DEFAULT_USER_AGENT,
    secChUa: options.secChUa || DEFAULT_SEC_CH_UA,
    max429Retries: Number.isFinite(retries) && retries >= 0 ? retries : 3,
    logger: options.logger ?? silentLogger,
    proxy: options.proxy ?? noProxy,
    ...(options.captcha ? { captcha: options.captcha } : {}),
    ...(options.locale ? { locale: options.locale } : {})
  };
}

/** Pause for x seconds, or a whole-second random time between x and y. */
export const sleep = (x: number, y?: number): Promise<void> => {
  let timeout = x * 1000;
  if (y !== undefined && y !== x) {
    const min = Math.min(x, y);
    const max = Math.max(x, y);
    timeout = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  }
  return new Promise(resolve => setTimeout(resolve, timeout));
};
