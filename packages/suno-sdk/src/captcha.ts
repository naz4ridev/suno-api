/**
 * Captcha contract shared by every host of the SDK.
 *
 * The SDK never opens a browser and never talks to a solver. When Suno asks for a generation captcha it
 * calls the injected `CaptchaProvider`: suno-api's server provides a headless Chromium + solver adapter,
 * the desktop app provides an interactive callback. Every failure is a CaptchaFlowError raised strictly
 * BEFORE the real generation POST, so `submitted` is always false.
 */

export type CaptchaErrorCode =
  | 'CAPTCHA_INTERACTION_REQUIRED'
  | 'CAPTCHA_UI_CHANGED'
  | 'CAPTCHA_TIMEOUT'
  | 'CAPTCHA_SOLVER_FAILED'
  | 'CAPTCHA_TOKEN_MISSING'
  | 'CAPTCHA_BROWSER_FAILED';

const RETRYABLE: Record<CaptchaErrorCode, boolean> = {
  CAPTCHA_INTERACTION_REQUIRED: false,
  CAPTCHA_UI_CHANGED: false,
  CAPTCHA_TIMEOUT: true,
  CAPTCHA_SOLVER_FAILED: true,
  CAPTCHA_TOKEN_MISSING: true,
  CAPTCHA_BROWSER_FAILED: true
};

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}/g, // JWT
  /\bP[01]_[A-Za-z0-9_.-]{20,}/g, // hCaptcha response token
  /(?:__client|__session|cookie)\s*[=:]\s*[^\s;]+/gi,
  /([?&](?:X-Amz-Signature|Signature|token|sig|key)=)[^&\s]+/gi
];

/** Strips anything that looks like a credential, token or signed URL part and caps the length. */
export function redactSecrets(value: unknown, max = 240): string {
  let text = typeof value === 'string' ? value : (value as any)?.message ?? String(value ?? '');
  for (const pattern of SECRET_PATTERNS)
    text = text.replace(pattern, (_m: string, prefix?: string) => `${typeof prefix === 'string' ? prefix : ''}[redacted]`);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Failure that happens strictly BEFORE the real generation POST. `submitted` is always false, so a
 * client may record "not sent" without reconciling. Properties are picked up by the HTTP error responses.
 */
export class CaptchaFlowError extends Error {
  code: CaptchaErrorCode;
  status: number;
  error_type: string;
  category: string;
  stage: string;
  submitted: boolean;
  retryable: boolean;
  detail?: string;

  constructor(code: CaptchaErrorCode, message: string, detail?: unknown) {
    super(`${code}: ${redactSecrets(message)}`);
    this.name = 'CaptchaFlowError';
    this.code = code;
    this.status = 503;
    this.error_type = 'captcha_failed_before_post';
    this.category = 'captcha';
    this.stage = 'before_generate_post';
    this.submitted = false;
    this.retryable = RETRYABLE[code];
    if (detail !== undefined)
      this.detail = redactSecrets(detail);
  }
}

export const isCaptchaFlowError = (error: unknown): error is CaptchaFlowError =>
  Boolean(error) && (error as any).name === 'CaptchaFlowError' && (error as any).submitted === false;

/**
 * What a provider gets to work with. `cookies` and `sessionToken` are credentials: a provider that opens
 * its own browser may use them to authenticate that browser, and must never log or persist them.
 */
export interface CaptchaRequest {
  /** Registry id of the account being served, when known. */
  accountId?: string;
  userAgent: string;
  locale?: string;
  /** Always `generation`: the only challenge Suno raises on this API. */
  purpose: 'generation';
  /** Cookies of the Suno session (secret). */
  cookies: Readonly<Record<string, string | undefined>>;
  /** Current bearer JWT (secret). */
  sessionToken?: string;
  /** Egress proxy for browser-based providers, in Chromium `{ server }` form. */
  proxy?: { server: string };
}

export interface CaptchaResult {
  /** hCaptcha response that the generation request will carry. */
  token: string;
  /** Renewed bearer observed while solving. Never log it. */
  authorization?: string;
}

/** Host-provided way to obtain a generation captcha token. May throw CaptchaFlowError. */
export type CaptchaProvider = (request: CaptchaRequest) => Promise<CaptchaResult | string | null | undefined>;

/** Normalises a provider's answer; anything without a token is a CAPTCHA_TOKEN_MISSING. */
export function normalizeCaptchaResult(value: CaptchaResult | string | null | undefined): CaptchaResult {
  const result = typeof value === 'string' ? { token: value } : value;
  const token = typeof result?.token === 'string' ? result.token.trim() : '';
  if (!token)
    throw new CaptchaFlowError('CAPTCHA_TOKEN_MISSING', 'The captcha provider returned no token');
  const authorization = typeof result?.authorization === 'string' && result.authorization ? result.authorization : undefined;
  return { token, ...(authorization ? { authorization } : {}) };
}
