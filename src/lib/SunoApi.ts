import pino from 'pino';
import { createSunoRegistry, type SunoRegistry } from '@suno-sdk';
import { resolveAccount, type SunoAccount } from '@/lib/accounts';
import { getSunoProxy } from '@/lib/egress';
import { createHeadlessCaptchaProvider } from '@/lib/headlessCaptcha';

/**
 * suno-api's view of the SDK (packages/suno-sdk): the same SunoApi class every host uses, wired to this
 * server's environment, account registry, egress proxy and headless-browser captcha adapter. There is no
 * Suno logic here: every method comes from the library.
 */
export {
  SunoApi, SunoUploadError, classifyUploadFailure,
  DEFAULT_MODEL, DEFAULT_AUDIO_TO_AUDIO_MODEL, STEM_MODEL, STEM_TYPE_ID, TWELVE_STEM_GROUPS
} from '@suno-sdk';
export type {
  AudioInfo, WorkspaceInfo, UploadedAudioInfo, AudioUploadInitInfo, InitializedUploadClipInfo, AudioUploadType,
  PlaylistInfo, PlaylistListResponse, ModelInfo, AudioToAudioMode, StemMode, ControlSliders, GenerateOptions,
  PersonaResponse
} from '@suno-sdk';

const logger = pino();

// One registry per process, kept on `global` so Next.js dev reloads keep the authenticated clients.
const globalForSunoApi = global as unknown as { sunoRegistry?: SunoRegistry };
const registry = globalForSunoApi.sunoRegistry ||= createSunoRegistry({
  baseUrl: process.env.SUNO_STUDIO_API_URL,
  userAgent: process.env.SUNO_USER_AGENT,
  secChUa: process.env.SUNO_SEC_CH_UA,
  max429Retries: Number(process.env.SUNO_MAX_429_RETRIES || 3),
  locale: process.env.BROWSER_LOCALE,
  logger,
  proxy: getSunoProxy(),
  captcha: createHeadlessCaptchaProvider(logger),
  accounts: { resolve: accountId => resolveAccount(accountId) },
  missingCookieMessage:
    'Please provide `suno_cookie` in the request, add an account (/api/accounts) or set SUNO_COOKIE in the .env file.',
  missingAccountMessage: 'No Suno account configured. Add one with POST /api/accounts or set SUNO_COOKIE.'
});

export { registry as sunoRegistry };

/**
 * Returns an initialized client for a cookie. Instances are cached per cookie, so several
 * accounts stay authenticated at the same time. Concurrent first calls share the same init.
 */
export const sunoApi = (cookie?: string, accountId?: string) => registry.sunoApi(cookie, accountId);

/** Client for a registered account (id, label, email or handle). Without id, the default account. */
export const sunoApiForAccount = (accountId?: string | null) => registry.sunoApiForAccount(accountId);

/** Drops cached clients (e.g. after an account cookie was replaced or removed). */
export const evictSunoApi = (account?: SunoAccount | { cookie?: string } | null) => registry.evict(account);
