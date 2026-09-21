import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import pino from 'pino';
import yn from 'yn';
import { isPage, sleep, waitForRequests } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { Solver } from '@2captcha/captcha-solver';
import { paramsCoordinates } from '@2captcha/captcha-solver/dist/structs/2captcha';
import { BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import { promises as fs } from 'fs';
import path from 'node:path';
import { resolveAccount, SunoAccount } from '@/lib/accounts';
import { browserProxy, proxiedAxiosConfig } from '@/lib/egress';

// sunoApi instance caching (one instance per cookie, so several accounts can be authenticated at once)
const globalForSunoApi = global as unknown as {
  sunoApiCache?: Map<string, SunoApi>;
  sunoApiPending?: Map<string, Promise<SunoApi>>;
};
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
const pendingInits = globalForSunoApi.sunoApiPending || new Map<string, Promise<SunoApi>>();
globalForSunoApi.sunoApiCache = cache;
globalForSunoApi.sunoApiPending = pendingInits;

const logger = pino();

// Models exposed by /api/billing/info/ (Sep 2026): chirp-hawk (v6, default), chirp-hawk-wild (v6-wild),
// chirp-goose (v6-mini) and custom models as `chirp-custom:<model_id>`.
export const DEFAULT_MODEL = 'chirp-hawk';
export const DEFAULT_AUDIO_TO_AUDIO_MODEL = 'chirp-hawk';
// The web app always uses this model for stem generation (task gen_stem).
export const STEM_MODEL = 'chirp-v3-5-b';
export const STEM_TYPE_ID = 91;
export const TWELVE_STEM_GROUPS = [
  'Vocals', 'Backing_Vocals', 'Drums', 'Bass', 'Guitar', 'Keyboard',
  'Percussion', 'Strings', 'Synth', 'FX', 'Brass', 'Woodwinds'
];

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const DEFAULT_SEC_CH_UA = '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"';

export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  negative_tags?: string; // Negative tags of music.
  duration?: string; // Duration of the audio
  error_message?: string; // Error message if any
  [key: string]: any;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  description?: string;
  clip_count?: number;
  last_updated_clip?: string;
  shared?: boolean;
  created_at?: string;
}

export interface UploadedAudioInfo {
  id: string;
  status: string;
  s3_id?: string;
  title?: string;
  image_url?: string;
  has_vocal?: boolean;
  display_tags?: string;
  inferred_description?: string;
  error_message?: string;
  error_type?: string;
  copyright_muted?: boolean;
  [key: string]: any;
}

export interface AudioUploadInitInfo {
  id: string;
  url: string;
  fields?: Record<string, string>;
  is_file_uploaded?: boolean;
}

export interface InitializedUploadClipInfo {
  clip_id: string;
  rights_clearance_available?: boolean;
}

export type AudioUploadType = 'file_upload' | 'voice_recording' | 'studio_file_upload';

export interface PlaylistInfo {
  id: string;
  entity_type?: string;
  image_url?: string;
  playlist_clips?: any[];
  current_page?: number;
  num_total_results?: number;
  is_owned?: boolean;
  is_trashed?: boolean;
  is_public?: boolean;
  is_hidden?: boolean;
  name: string;
  description?: string;
  upvote_count?: number;
  dislike_count?: number;
  flag_count?: number;
  skip_count?: number;
  play_count?: number;
  song_count?: number;
  is_discover_playlist?: boolean;
  [key: string]: any;
}

export interface PlaylistListResponse {
  num_total_results: number;
  current_page: number;
  playlists: PlaylistInfo[];
}

export interface ModelInfo {
  id?: string;
  name: string;
  external_key: string;
  major_version?: number;
  description?: string;
  can_use: boolean;
  is_default: boolean;
  is_custom: boolean;
  badges?: string[];
  capabilities?: string[];
  features?: string[];
  max_lengths?: Record<string, number>;
}

export type AudioToAudioMode = 'cover' | 'add_vocals' | 'add_instrumental';

export type StemMode = 'extract' | 'twelve' | 'legacy';

export interface ControlSliders {
  /** 0..1 (or 0..100) */
  weirdness?: number;
  /** 0..1 (or 0..100) */
  style_weight?: number;
  /** 0..1 (or 0..100), only used when there is an audio reference (cover, persona, ...) */
  audio_weight?: number;
  /** integer 0..4 */
  aug_creativity?: number;
}

export interface GenerateOptions extends ControlSliders {
  /** Custom mode lyrics. */
  prompt?: string;
  /** Simple ("song description") mode prompt. When set, generation runs in simple mode. */
  gpt_description_prompt?: string;
  tags?: string;
  negative_tags?: string;
  title?: string;
  make_instrumental?: boolean;
  model?: string;
  /** Explicit task. When omitted it is derived from the references (cover, extend, persona...). */
  task?: string;
  /** Workspace (project) id where the clips will be created. */
  project_id?: string;
  /** Persona / voice id. Voices are personas with persona_type "vox". */
  persona_id?: string;
  artist_clip_id?: string;
  artist_start_s?: number | null;
  artist_end_s?: number | null;
  cover_clip_id?: string;
  cover_start_s?: number | null;
  cover_end_s?: number | null;
  continue_clip_id?: string;
  continue_at?: number | null;
  continued_aligned_prompt?: string | null;
  underpainting_clip_id?: string;
  overpainting_clip_id?: string;
  stem_type_id?: number;
  stem_type_group_name?: string;
  stem_task?: string;
  stem_name?: string;
  vocal_gender?: 'm' | 'f' | string;
  is_max_mode?: boolean;
  override_fields?: string[];
  lyrics_project_id?: string;
  wait_audio?: boolean;
  /** Extra fields merged into the payload as-is (escape hatch for new Suno parameters). */
  extra_payload?: Record<string, any>;
  /** Extra fields merged into payload.metadata as-is. */
  extra_metadata?: Record<string, any>;
}

/**
 * Upload rejection types used by the Suno web app (see uploads.* locale keys).
 */
const UPLOAD_FAILURES: Record<string, { category: string; retryable: boolean; copyright: boolean; description: string }> = {
  upload_failure_match_audible_magic: { category: 'audio_match', retryable: false, copyright: true, description: 'copyright: this audio matches an existing recording (Audible Magic)' },
  upload_failure_match_version_id: { category: 'audio_match', retryable: false, copyright: true, description: 'copyright: this audio matches an existing recording (version id)' },
  upload_failure_match_acrcloud: { category: 'audio_match', retryable: false, copyright: true, description: 'copyright: this audio matches an existing recording (ACRCloud)' },
  upload_failure_artwork: { category: 'audio_match', retryable: false, copyright: true, description: 'copyright: this audio matches an existing work of art' },
  upload_failure_lyrics_copyright: { category: 'lyrics_copyright', retryable: false, copyright: true, description: 'copyright: this audio contains copyrighted lyrics' },
  upload_blocked_copyright: { category: 'copyright_blocked', retryable: false, copyright: true, description: 'copyright infringement detected, uploads blocked' },
  upload_failure_check_failed: { category: 'verification_failed', retryable: true, copyright: false, description: 'audio verification check timed out, try again' },
  upload_failure_lyrics_check_failed: { category: 'verification_failed', retryable: true, copyright: false, description: 'lyrics verification failed, try again' },
  upload_failure_artwork_check_failed: { category: 'verification_failed', retryable: true, copyright: false, description: 'artwork verification failed, try again' },
  upload_failure_duration_short: { category: 'duration', retryable: false, copyright: false, description: 'audio is too short' },
  upload_failure_duration_long: { category: 'duration', retryable: false, copyright: false, description: 'audio is too long' },
  upload_failure_decode_audio: { category: 'decode', retryable: false, copyright: false, description: 'file is corrupted or has an unsupported format' },
  upload_failure_fetch_audio: { category: 'fetch', retryable: true, copyright: false, description: 'Suno could not fetch the uploaded file, try again' },
  upload_rate_limited: { category: 'rate_limited', retryable: true, copyright: false, description: 'uploading too fast, wait a few minutes' },
  upload_blocked_account: { category: 'account_restricted', retryable: false, copyright: false, description: 'audio uploads are restricted for this account' }
};

export class SunoUploadError extends Error {
  status?: number;
  error_type?: string;
  category: string;
  retryable: boolean;
  copyright: boolean;
  detail?: any;

  constructor(params: {
    message: string;
    error_type?: string;
    category: string;
    retryable: boolean;
    copyright: boolean;
    status?: number;
    detail?: any;
  }) {
    super(params.message);
    this.name = 'SunoUploadError';
    this.error_type = params.error_type;
    this.category = params.category;
    this.retryable = params.retryable;
    this.copyright = params.copyright;
    this.status = params.status;
    this.detail = params.detail;
  }
}

/**
 * Builds a descriptive error for a failed upload. Copyright-related failures always contain the word
 * "copyright" in the message, so clients that match on it (e.g. spotify2suno pitch retries) keep working.
 */
export function classifyUploadFailure(
  errorType?: string | null,
  errorMessage?: string | null,
  status?: number,
  detail?: any
): SunoUploadError {
  const known = errorType ? UPLOAD_FAILURES[errorType] : undefined;
  const message = (errorMessage || '').trim();
  const looksCopyright = /copyright|infring|matched|known recording|rights holder/i.test(message);
  const category = known?.category || (looksCopyright ? 'copyright' : 'processing_failed');
  const copyright = known?.copyright ?? looksCopyright;
  const description = known?.description || (copyright ? 'copyright check failed' : 'Suno upload processing failed');
  const parts = [`Suno upload rejected${errorType ? ` (${errorType})` : ''}: ${description}`];
  if (message && !description.toLowerCase().includes(message.toLowerCase()))
    parts.push(message);

  return new SunoUploadError({
    message: parts.join(' - '),
    error_type: errorType || undefined,
    category,
    retryable: known?.retryable ?? false,
    copyright,
    status,
    detail
  });
}

export interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any;
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{
      clip: any;
    }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
    persona_type?: string;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

const normalizeSlider = (value?: number): number | undefined => {
  if (value === undefined || value === null || Number.isNaN(Number(value)))
    return undefined;
  const numeric = Number(value);
  const ratio = numeric > 1 ? numeric / 100 : numeric;
  return Math.min(1, Math.max(0, Math.round(ratio * 100) / 100));
};

const errorDetail = (data: any): string | undefined => {
  if (!data)
    return undefined;
  if (typeof data === 'string')
    return data.slice(0, 500);
  const detail = data.detail ?? data.error ?? data.message;
  if (typeof detail === 'string')
    return detail;
  if (detail)
    return JSON.stringify(detail).slice(0, 500);
  return JSON.stringify(data).slice(0, 500);
};

type RetryableConfig = InternalAxiosRequestConfig & { __retryCount?: number };

class SunoApi {
  private static BASE_URL: string = (process.env.SUNO_STUDIO_API_URL || 'https://studio-api-prod.suno.com').replace(/\/+$/, '');
  private static CLERK_BASE_URL: string = 'https://auth.suno.com';
  private static CLERK_VERSION = '5.117.0';
  private static MAX_429_RETRIES = Number(process.env.SUNO_MAX_429_RETRIES || 3);

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private currentTokenExpiresAt?: number;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
  private ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
  private cursor?: Cursor;
  private billingCache?: { at: number; data: any };
  private sessionCache?: { at: number; data: any };

  /** Account id this instance was created for (when resolved through the account registry). */
  public accountId?: string;

  constructor(cookies: string) {
    this.userAgent = process.env.SUNO_USER_AGENT || DEFAULT_USER_AGENT;
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    this.client = axios.create({
      ...proxiedAxiosConfig(),
      withCredentials: true,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `${this.deviceId}`,
        'Browser-Token': this.getBrowserToken(),
        'Referring-Origin': 'https://suno.com',
        'sec-ch-ua': process.env.SUNO_SEC_CH_UA || DEFAULT_SEC_CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'User-Agent': this.userAgent,
        'Accept-Language': 'en',
        Accept: '*/*',
        Origin: 'https://suno.com',
        Referer: 'https://suno.com/'
      }
    });
    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization)
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      config.headers['Browser-Token'] = this.getBrowserToken();
      const cookiesArray = Object.entries(this.cookies).map(([key, value]) =>
        cookie.serialize(key, value as string)
      );
      config.headers.Cookie = cookiesArray.join('; ');
      return config;
    });
    this.client.interceptors.response.use(
      resp => {
        const setCookieHeader = resp.headers['set-cookie'];
        if (Array.isArray(setCookieHeader)) {
          const newCookies = cookie.parse(setCookieHeader.join('; '));
          for (const [key, value] of Object.entries(newCookies)) {
            this.cookies[key] = value;
          }
        }
        return resp;
      },
      async (error: AxiosError) => {
        const config = error.config as RetryableConfig | undefined;
        const status = error.response?.status;
        const isStudioApi = config?.url?.startsWith(SunoApi.BASE_URL);

        // Suno rate limits bursts (429 "Too many requests", retryable: true). Back off and retry.
        if (config && isStudioApi && status === 429) {
          config.__retryCount = (config.__retryCount || 0) + 1;
          if (config.__retryCount <= SunoApi.MAX_429_RETRIES) {
            const retryAfter = Number(error.response?.headers?.['retry-after']);
            const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 2000 * 2 ** (config.__retryCount - 1) + Math.floor(Math.random() * 1000);
            logger.warn(`Suno 429 on ${config.url}, retry ${config.__retryCount} in ${delayMs}ms`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            return this.client.request(config);
          }
        }

        if (error.response && isStudioApi) {
          const detail = errorDetail(error.response.data);
          const method = (config?.method || 'get').toUpperCase();
          const pathname = config?.url?.replace(SunoApi.BASE_URL, '') || '';
          error.message = `Suno API ${status} on ${method} ${pathname}${detail ? `: ${detail}` : ''}`;
          (error as any).status = status;
        }
        throw error;
      }
    );
  }

  private getBrowserToken(): string {
    return JSON.stringify({
      token: Buffer.from(JSON.stringify({ timestamp: Date.now() })).toString('base64')
    });
  }

  private decodeJwtExpiry(token?: string | null): number | undefined {
    if (!token)
      return undefined;

    try {
      const payload = token.split('.')[1];
      if (!payload)
        return undefined;

      const normalizedPayload = payload
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payload.length / 4) * 4, '=');

      const decoded = JSON.parse(
        Buffer.from(normalizedPayload, 'base64').toString('utf8')
      );

      return typeof decoded.exp === 'number'
        ? decoded.exp * 1000
        : undefined;
    } catch {
      return undefined;
    }
  }

  private setCurrentToken(token?: string | null) {
    this.currentToken = token || undefined;
    this.currentTokenExpiresAt = this.decodeJwtExpiry(token);
  }

  private hasUsableCurrentToken(bufferMs: number = 60_000): boolean {
    if (!this.currentToken)
      return false;

    if (!this.currentTokenExpiresAt)
      return true;

    return this.currentTokenExpiresAt - Date.now() > bufferMs;
  }

  public async init(): Promise<SunoApi> {
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  /**
   * Get the session ID and save it for later use.
   */
  private async getAuthToken() {
    logger.info('Getting the session ID');
    // URL to get session ID
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Get session ID
    const sessionResponse = await this.client.get(getSessionUrl, {
      headers: { Authorization: this.cookies.__client }
    });
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      const error = new Error(
        'Failed to get session id, you may need to update the SUNO_COOKIE'
      );
      (error as Error & { status?: number }).status = 401;
      throw error;
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  /**
   * Keep the session alive.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    if (this.hasUsableCurrentToken()) {
      return;
    }
    // URL to renew session token
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Renew session token
    logger.info('KeepAlive...\n');
    let renewResponse;
    try {
      renewResponse = await this.client.post(renewUrl, {}, {
        headers: { Authorization: this.cookies.__client }
      });
    } catch (error) {
      if (
        axios.isAxiosError(error) &&
        error.response?.status === 429 &&
        this.hasUsableCurrentToken(5_000)
      ) {
        logger.warn(
          'KeepAlive rate limited by Cloudflare; reusing current JWT token.'
        );
        return;
      }
      throw error;
    }
    if (isWait) {
      await sleep(1, 2);
    }
    const newToken = renewResponse.data.jwt;
    // Update Authorization field in request header with the new JWT token
    this.setCurrentToken(newToken);
  }

  private async captchaRequired(): Promise<boolean> {
    const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
      ctype: 'generation'
    });
    logger.info(resp.data);
    return Boolean(resp.data?.required);
  }

  /**
   * Clicks on a locator or XY vector. This method is made because of the difference between ghost-cursor-playwright and Playwright methods
   */
  private async click(target: Locator|Page, position?: { x: number, y: number }): Promise<void> {
    if (this.ghostCursorEnabled) {
      let pos: any = isPage(target) ? { x: 0, y: 0 } : await target.boundingBox();
      if (position) 
        pos = {
          ...pos,
          x: pos.x + position.x,
          y: pos.y + position.y,
          width: null,
          height: null,
        };
      return this.cursor?.actions.click({
        target: pos
      });
    } else {
      if (isPage(target))
        return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
      else
        return target.click({ force: true, position });
    }
  }

  /**
   * Get the BrowserType from the `BROWSER` environment variable.
   * @returns {BrowserType} chromium, firefox or webkit. Default is chromium
   */
  private getBrowserType() {
    const browser = process.env.BROWSER?.toLowerCase();
    switch (browser) {
      case 'firefox':
        return firefox;
      /*case 'webkit': ** doesn't work with rebrowser-patches
      case 'safari':
        return webkit;*/
      default:
        return chromium;
    }
  }

  /**
   * Launches a browser with the necessary cookies
   * @returns {BrowserContext}
   */
  private async launchBrowser(): Promise<BrowserContext> {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
      '--disable-features=IsolateOrigins',
      '--disable-extensions',
      '--disable-infobars'
    ];
    const proxy = browserProxy();
    if (proxy) // WebRTC does not go through the proxy: avoid leaking the server IP
      args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    // Check for GPU acceleration, as it is recommended to turn it off for Docker
    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false }))
      args.push('--enable-unsafe-swiftshader',
        '--disable-gpu',
        '--disable-setuid-sandbox');
    const browser = await this.getBrowserType().launch({
      args,
      headless: yn(process.env.BROWSER_HEADLESS, { default: true }),
      ...(proxy ? { proxy } : {})
    });
    const context = await browser.newContext({ userAgent: this.userAgent, locale: process.env.BROWSER_LOCALE, viewport: null });
    const cookies = [];
    const lax: 'Lax' | 'Strict' | 'None' = 'Lax';
    cookies.push({
      name: '__session',
      value: this.currentToken+'',
      domain: '.suno.com',
      path: '/',
      sameSite: lax
    });
    for (const key in this.cookies) {
      cookies.push({
        name: key,
        value: this.cookies[key]+'',
        domain: '.suno.com',
        path: '/',
        sameSite: lax
      })
    }
    await context.addCookies(cookies);
    return context;
  }

  /**
   * Checks for CAPTCHA verification and solves the CAPTCHA if needed
   * @returns {string|null} hCaptcha token. If no verification is required, returns null
   */
  public async getCaptcha(): Promise<string|null> {
    if (!await this.captchaRequired())
      return null;

    logger.info('CAPTCHA required. Launching browser...')
    const browser = await this.launchBrowser();
    const page = await browser.newPage();
    await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });

    logger.info('Waiting for Suno interface to load');
    // await page.locator('.react-aria-GridList').waitFor({ timeout: 60000 });
    await page.waitForResponse('**/api/project/**\\?**', { timeout: 60000 }); // wait for song list API call

    if (this.ghostCursorEnabled)
      this.cursor = await createCursor(page);
    
    logger.info('Triggering the CAPTCHA');
    try {
      await page.getByLabel('Close').click({ timeout: 2000 }); // close all popups
      // await this.click(page, { x: 318, y: 13 });
    } catch(e) {}

    const textarea = page.locator('.custom-textarea');
    await this.click(textarea);
    await textarea.pressSequentially('Lorem ipsum', { delay: 80 });

    const button = page.locator('button[aria-label="Create"]').locator('div.flex');
    this.click(button);

    const controller = new AbortController();
    new Promise<void>(async (resolve, reject) => {
      const frame = page.frameLocator('iframe[title*="hCaptcha"]');
      const challenge = frame.locator('.challenge-container');
      try {
        let wait = true;
        while (true) {
          if (wait)
            await waitForRequests(page, controller.signal);
          const drag = (await challenge.locator('.prompt-text').first().innerText()).toLowerCase().includes('drag');
          let captcha: any;
          for (let j = 0; j < 3; j++) { // try several times because sometimes 2Captcha could return an error
            try {
              logger.info('Sending the CAPTCHA to 2Captcha');
              const payload: paramsCoordinates = {
                body: (await challenge.screenshot({ timeout: 5000 })).toString('base64'),
                lang: process.env.BROWSER_LOCALE
              };
              if (drag) {
                // Say to the worker that he needs to click
                payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
                payload.imginstructions = (await fs.readFile(path.join(process.cwd(), 'public', 'drag-instructions.jpg'))).toString('base64');
              }
              captcha = await this.solver.coordinates(payload);
              break;
            } catch(err: any) {
              logger.info(err.message);
              if (j != 2)
                logger.info('Retrying...');
              else
                throw err;
            }
          } 
          if (drag) {
            const challengeBox = await challenge.boundingBox();
            if (challengeBox == null)
              throw new Error('.challenge-container boundingBox is null!');
            if (captcha.data.length % 2) {
              logger.info('Solution does not have even amount of points required for dragging. Requesting new solution...');
              this.solver.badReport(captcha.id);
              wait = false;
              continue;
            }
            for (let i = 0; i < captcha.data.length; i += 2) {
              const data1 = captcha.data[i];
              const data2 = captcha.data[i+1];
              logger.info(JSON.stringify(data1) + JSON.stringify(data2));
              await page.mouse.move(challengeBox.x + +data1.x, challengeBox.y + +data1.y);
              await page.mouse.down();
              await sleep(1.1); // wait for the piece to be 'unlocked'
              await page.mouse.move(challengeBox.x + +data2.x, challengeBox.y + +data2.y, { steps: 30 });
              await page.mouse.up();
            }
            wait = true;
          } else {
            for (const data of captcha.data) {
              logger.info(data);
              await this.click(challenge, { x: +data.x, y: +data.y });
            };
          }
          this.click(frame.locator('.button-submit')).catch(e => {
            if (e.message.includes('viewport')) // when hCaptcha window has been closed due to inactivity,
              this.click(button); // click the Create button again to trigger the CAPTCHA
            else
              throw e;
          });
        }
      } catch(e: any) {
        if (e.message.includes('been closed') // catch error when closing the browser
          || e.message == 'AbortError') // catch error when waitForRequests is aborted
          resolve();
        else
          reject(e);
      }
    }).catch(e => {
      browser.browser()?.close();
      throw e;
    });
    return (new Promise((resolve, reject) => {
      page.route(/\/api\/generate\/v2(-web)?\//, async (route: any) => {
        try {
          logger.info('hCaptcha token received. Closing browser');
          route.abort();
          browser.browser()?.close();
          controller.abort();
          const request = route.request();
          this.setCurrentToken(
            request.headers().authorization.split('Bearer ').pop()
          );
          resolve(request.postDataJSON().token);
        } catch(err) {
          reject(err);
        }
      });
    }));
  }

  /**
   * Imitates Cloudflare Turnstile loading error. Unused right now, left for future
   */
  private async getTurnstile() {
    return this.client.post(
      `https://clerk.suno.com/v1/client?__clerk_api_version=2021-02-05&_clerk_js_version=${SunoApi.CLERK_VERSION}&_method=PATCH`,
      { captcha_error: '300030,300030,300030' },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }


  private url(pathname: string): string {
    return `${SunoApi.BASE_URL}${pathname}`;
  }

  private isNotFoundOrMethod(error: any): boolean {
    const status = error?.response?.status;
    return status === 404 || status === 405;
  }

  /* ------------------------------------------------------------------ */
  /* Account / session                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Returns the logged in user (id, email, handle...) from /api/session/.
   */
  public async getSessionInfo(maxAgeMs: number = 5 * 60_000): Promise<any> {
    if (this.sessionCache && Date.now() - this.sessionCache.at < maxAgeMs)
      return this.sessionCache.data;

    await this.keepAlive(false);
    const response = await this.client.get(this.url('/api/session/'), { timeout: 15000 });
    this.sessionCache = { at: Date.now(), data: response.data };
    return response.data;
  }

  public async getUserInfo(): Promise<{ id?: string; email?: string; handle?: string; display_name?: string }> {
    const session = await this.getSessionInfo();
    const user = session?.user || {};
    return {
      id: user.id,
      email: user.email,
      handle: user.handle,
      display_name: user.display_name
    };
  }

  public async getBillingInfo(maxAgeMs: number = 60_000): Promise<any> {
    if (this.billingCache && Date.now() - this.billingCache.at < maxAgeMs)
      return this.billingCache.data;

    await this.keepAlive(false);
    const response = await this.client.get(this.url('/api/billing/info/'), { timeout: 15000 });
    this.billingCache = { at: Date.now(), data: response.data };
    return response.data;
  }

  public async get_credits(): Promise<object> {
    const data = await this.getBillingInfo(0);
    return {
      credits_left: data.total_credits_left,
      period: data.period,
      monthly_limit: data.monthly_limit,
      monthly_usage: data.monthly_usage,
      plan: data.plan?.plan_key || data.plan?.name,
      renews_on: data.renews_on,
      period_end: data.period_end,
      max_active_custom_models: data.max_active_custom_models,
      audio_upload_limits: data.audio_upload_limits,
      voice_upload_limits: data.voice_upload_limits,
      voice_record_limits: data.voice_record_limits
    };
  }

  /**
   * Models available for this account, including custom models (`chirp-custom:<id>`).
   */
  public async getModels(): Promise<ModelInfo[]> {
    const data = await this.getBillingInfo();
    return (data.models || []).map((model: any) => ({
      id: model.id,
      name: model.name,
      external_key: model.external_key,
      major_version: model.major_version,
      description: model.description,
      can_use: Boolean(model.can_use),
      is_default: Boolean(model.is_default_model),
      is_custom: String(model.external_key || '').startsWith('chirp-custom:') || (model.badges || []).includes('custom'),
      badges: model.badges,
      capabilities: model.capabilities,
      features: model.features,
      max_lengths: model.max_lengths
    }));
  }

  private async getUserTier(): Promise<string | undefined> {
    try {
      const data = await this.getBillingInfo(10 * 60_000);
      return data?.plan?.id;
    } catch {
      return undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Generation                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Generate a song based on the prompt (simple mode).
   */
  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    options: Partial<GenerateOptions> = {}
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateV2Web({
      ...options,
      gpt_description_prompt: prompt,
      make_instrumental,
      model,
      wait_audio
    });
    logger.info('Generate cost time: ' + (Date.now() - startTime));
    return audios;
  }

  /**
   * Calls the concatenate endpoint for a clip to generate the whole song.
   */
  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const response = await this.client.post(
      this.url('/api/generate/concat/v2/'),
      { clip_id },
      { timeout: 10000 }
    );
    return response.data;
  }

  /**
   * Generates custom audio (custom mode: lyrics + styles + title).
   */
  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    options: Partial<GenerateOptions> = {}
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateV2Web({
      ...options,
      prompt,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags
    });
    logger.info('Custom generate cost time: ' + (Date.now() - startTime));
    return audios;
  }

  /**
   * Resolves the generation task the same way the web app does (getGenerateTaskFromReferences).
   */
  private resolveTask(options: GenerateOptions, personaType?: string): string | undefined {
    if (options.task)
      return options.task;

    const persona = options.persona_id ? (personaType === 'vox' ? 'vox' : 'legacy') : undefined;
    const hasCover = Boolean(options.cover_clip_id);
    const hasExtend = Boolean(options.continue_clip_id);

    if (hasCover && persona === 'vox') return 'vox_cover';
    if (hasCover && persona === 'legacy') return 'artist_cover';
    if (hasExtend && persona === 'vox') return 'vox_extend';
    if (hasExtend && persona === 'legacy') return 'artist_extend';
    if (hasCover) return 'cover';
    if (persona === 'vox') return 'vox';
    if (persona === 'legacy') return 'artist_consistency';
    if (options.stem_task) return 'gen_stem';
    if (options.overpainting_clip_id) return 'overpainting';
    if (options.underpainting_clip_id) return 'underpainting';
    if (hasExtend) return 'extend';
    return undefined;
  }

  /**
   * Core generation call, equivalent to the web create form (POST /api/generate/v2-web/).
   */
  public async generateV2Web(options: GenerateOptions): Promise<AudioInfo[]> {
    await this.keepAlive();

    let personaType: string | undefined;
    let artistClipId = options.artist_clip_id;
    if (options.persona_id && (!options.task || !artistClipId)) {
      const persona = await this.getPersona(options.persona_id).catch(() => null);
      personaType = persona?.persona_type;
      if (!artistClipId && persona?.root_clip_id)
        artistClipId = persona.root_clip_id;
    }

    const isSimple = Boolean(options.gpt_description_prompt) && !options.prompt;
    const task = this.resolveTask(options, personaType);
    const hasReference = Boolean(
      options.persona_id || options.cover_clip_id || options.continue_clip_id ||
      options.underpainting_clip_id || options.overpainting_clip_id || options.stem_task
    );

    const sliders: Record<string, number> = {};
    const weirdness = normalizeSlider(options.weirdness);
    const styleWeight = normalizeSlider(options.style_weight);
    const audioWeight = normalizeSlider(options.audio_weight);
    if (weirdness !== undefined) sliders.weirdness_constraint = weirdness;
    if (styleWeight !== undefined) sliders.style_weight = styleWeight;
    if (audioWeight !== undefined && hasReference) sliders.audio_weight = audioWeight;
    if (options.aug_creativity !== undefined && options.aug_creativity !== null)
      sliders.aug_creativity = Math.min(4, Math.max(0, Math.round(Number(options.aug_creativity))));

    const metadata: Record<string, any> = {
      web_client_pathname: '/create',
      create_surface: 'desktop_create_form',
      is_max_mode: Boolean(options.is_max_mode),
      is_mumble: false,
      create_mode: isSimple ? 'simple' : 'custom',
      user_tier: await this.getUserTier(),
      create_session_token: randomUUID(),
      disable_volume_normalization: false,
      ...(options.vocal_gender ? { vocal_gender: options.vocal_gender } : {}),
      ...(Object.keys(sliders).length ? { control_sliders: sliders } : {}),
      ...(hasReference ? { is_remix: true } : {}),
      ...(options.extra_metadata || {})
    };

    const payload: Record<string, any> = {
      project_id: options.project_id,
      token: await this.getCaptcha(),
      task,
      generation_type: 'TEXT',
      title: options.title ?? '',
      tags: options.tags ?? '',
      negative_tags: options.negative_tags ?? '',
      mv: options.model || (options.stem_task ? STEM_MODEL : DEFAULT_MODEL),
      prompt: isSimple ? '' : options.prompt ?? '',
      make_instrumental: Boolean(options.make_instrumental),
      user_uploaded_images_b64: null,
      metadata,
      override_fields: options.override_fields ?? [],
      cover_clip_id: options.cover_clip_id ?? null,
      cover_start_s: options.cover_clip_id ? options.cover_start_s ?? null : null,
      cover_end_s: options.cover_clip_id ? options.cover_end_s ?? null : null,
      persona_id: options.persona_id ?? null,
      artist_clip_id: options.persona_id ? artistClipId ?? null : null,
      artist_start_s: options.persona_id ? options.artist_start_s ?? 0 : null,
      artist_end_s: options.persona_id ? options.artist_end_s ?? null : null,
      continue_clip_id: options.continue_clip_id ?? null,
      continued_aligned_prompt: options.continued_aligned_prompt ?? null,
      continue_at: options.continue_at ?? null,
      transaction_uuid: randomUUID(),
      token_provider: null
    };

    if (isSimple) {
      payload.gpt_description_prompt = options.gpt_description_prompt;
      delete payload.title;
      delete payload.tags;
      delete payload.negative_tags;
    }
    if (options.persona_id && !options.override_fields)
      payload.override_fields = isSimple ? ['tags'] : ['prompt', 'tags'];
    if (options.underpainting_clip_id)
      payload.underpainting_clip_id = options.underpainting_clip_id;
    if (options.overpainting_clip_id)
      payload.overpainting_clip_id = options.overpainting_clip_id;
    if (options.stem_task) {
      payload.stem_type_id = options.stem_type_id ?? STEM_TYPE_ID;
      payload.stem_type_group_name = options.stem_type_group_name;
      payload.stem_task = options.stem_task;
      if (options.stem_name)
        payload.stem_name = options.stem_name;
    }
    if (options.lyrics_project_id)
      payload.lyrics_project_id = options.lyrics_project_id;
    Object.assign(payload, options.extra_payload || {});

    logger.info({ task, mv: payload.mv, project_id: payload.project_id, persona_id: payload.persona_id }, 'generate/v2-web');
    const response = await this.client.post(this.url('/api/generate/v2-web/'), payload, {
      timeout: 20000
    });

    const clips = response.data?.clips || [];
    const clipIds = clips.map((clip: any) => clip.id);
    if (options.wait_audio && clipIds.length > 0)
      return this.waitForFeedClips(clipIds);

    return clips.map((clip: any) => this.normalizeClip(clip));
  }

  /**
   * Generates lyrics based on a given prompt.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    const generateResponse = await this.client.post(
      this.url('/api/generate/lyrics/'),
      { prompt }
    );
    const generateId = generateResponse.data.id;

    const startedAt = Date.now();
    let lyricsResponse = await this.client.get(this.url(`/api/generate/lyrics/${generateId}`));
    while (lyricsResponse?.data?.status !== 'complete') {
      if (Date.now() - startedAt > 120000)
        throw new Error('Timed out waiting for lyrics generation');
      await sleep(2);
      lyricsResponse = await this.client.get(this.url(`/api/generate/lyrics/${generateId}`));
    }

    return lyricsResponse.data;
  }

  /**
   * Extends an existing audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean,
    options: Partial<GenerateOptions> = {}
  ): Promise<AudioInfo[]> {
    return this.generateV2Web({
      ...options,
      prompt,
      tags,
      negative_tags,
      title,
      model,
      wait_audio,
      continue_clip_id: audioId,
      continue_at: continueAt
    });
  }

  /**
   * Generate stems for a song.
   * - `extract` (default): one stem (default "Lead Vocal") plus its complement ("Without Lead Vocal").
   * - `twelve`: all twelve stem groups (Vocals, Backing_Vocals, Drums, Bass, Guitar, ...).
   * - `legacy`: the old /api/edit/stems endpoint (vocals + instrumental).
   */
  public async generateStems(
    song_id: string,
    options: { mode?: StemMode; stem_name?: string; title?: string; wait_audio?: boolean } = {}
  ): Promise<AudioInfo[]> {
    const mode = options.mode || 'extract';

    if (mode === 'legacy') {
      await this.keepAlive(false);
      const response = await this.client.post(this.url(`/api/edit/stems/${song_id}`), {});
      return response.data.clips.map((clip: any) => ({
        id: clip.id,
        status: clip.status,
        created_at: clip.created_at,
        title: clip.title,
        stem_from_id: clip.metadata.stem_from_id,
        duration: clip.metadata.duration
      }));
    }

    const source: any = await this.getClip(song_id);
    const stemName = options.stem_name || 'Lead Vocal';
    const clips = await this.generateV2Web({
      task: 'gen_stem',
      title: options.title ?? source?.title ?? '',
      model: STEM_MODEL,
      make_instrumental: true,
      continue_clip_id: song_id,
      stem_type_id: STEM_TYPE_ID,
      stem_type_group_name: mode === 'twelve' ? 'Twelve' : stemName,
      stem_task: mode === 'twelve' ? 'twelve' : 'extract',
      stem_name: mode === 'twelve' ? undefined : stemName,
      wait_audio: options.wait_audio
    });

    return clips.map((clip: any) => ({
      ...clip,
      stem_from_id: clip.metadata?.stem_from_id,
      stem_type_group_name: clip.metadata?.stem_type_group_name,
      stem_task: clip.metadata?.stem_task
    }));
  }

  /**
   * Get the lyric alignment for a song.
   */
  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(this.url(`/api/gen/${song_id}/aligned_lyrics/v2/`));

    return response.data?.aligned_words.map((transcribedWord: any) => ({
      word: transcribedWord.word,
      start_s: transcribedWord.start_s,
      end_s: transcribedWord.end_s,
      success: transcribedWord.success,
      p_align: transcribedWord.p_align
    }));
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   */
  private parseLyrics(prompt: string): string {
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');
    return lines.join('\n');
  }

  private normalizeClip(audio: any): any {
    const metadata = audio?.metadata || {};

    return {
      ...audio,
      lyric: metadata.prompt ? this.parseLyrics(metadata.prompt) : '',
      gpt_description_prompt: metadata.gpt_description_prompt,
      prompt: metadata.prompt,
      type: metadata.type,
      tags: metadata.tags,
      negative_tags: metadata.negative_tags,
      duration: metadata.duration,
      error_message: metadata.error_message
    };
  }

  private getAudioExtension(filename: string, contentType?: string): string {
    const extension = path.extname(filename).replace(/^\./, '').toLowerCase();
    if (extension)
      return extension;

    const extensionByMime: Record<string, string> = {
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/wav': 'wav',
      'audio/wave': 'wav',
      'audio/x-wav': 'wav',
      'audio/flac': 'flac',
      'audio/x-flac': 'flac',
      'audio/aac': 'aac',
      'audio/mp4': 'm4a',
      'audio/x-m4a': 'm4a',
      'audio/ogg': 'ogg',
      'audio/webm': 'webm'
    };

    return extensionByMime[contentType || ''] || 'wav';
  }

  public resolveAudioUploadExtension(
    filename: string,
    contentType?: string
  ): string {
    return this.getAudioExtension(filename, contentType);
  }

  private async feedV3(payload: object): Promise<any> {
    await this.keepAlive(false);
    const response = await this.client.post(
      this.url('/api/feed/v3'),
      payload,
      { timeout: 15000 }
    );

    return response.data;
  }

  private async getFeedClipsByIds(clipIds: string[]): Promise<any[]> {
    const response = await this.feedV3({
      filters: {
        ids: {
          presence: 'True',
          clipIds
        }
      },
      limit: clipIds.length
    });

    return (response.clips || []).map((clip: any) => this.normalizeClip(clip));
  }

  private async waitForFeedClips(
    clipIds: string[],
    timeoutMs: number = 180000
  ): Promise<any[]> {
    const startTime = Date.now();
    let lastResponse: any[] = [];

    await sleep(3, 5);
    while (Date.now() - startTime < timeoutMs) {
      const response = await this.getFeedClipsByIds(clipIds);
      const allCompleted = response.length > 0 && response.every(
        audio => audio.status === 'streaming' || audio.status === 'complete'
      );
      const allError = response.length > 0 && response.every(audio => audio.status === 'error');

      if (allCompleted || allError)
        return response;

      lastResponse = response;
      await sleep(3, 6);
      await this.keepAlive(true);
    }

    return lastResponse;
  }

  private buildAudioToAudioOptions(mode: AudioToAudioMode, sourceClipId: string): Partial<GenerateOptions> {
    switch (mode) {
      case 'cover':
        return { cover_clip_id: sourceClipId };
      case 'add_vocals':
        return { task: 'overpainting', overpainting_clip_id: sourceClipId };
      case 'add_instrumental':
        return { task: 'underpainting', underpainting_clip_id: sourceClipId };
    }
  }

  /**
   * Retrieves audio information for the given song IDs (feed/v3).
   * Without ids it returns the latest clips of the default workspace; `page` is the feed cursor.
   */
  public async get(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    if (songIds && songIds.length > 0)
      return this.getFeedClipsByIds(songIds);

    const response = await this.feedV3({
      cursor: page || null,
      limit: 20,
      filters: {
        disliked: 'False',
        trashed: 'False',
        fromStudioProject: { presence: 'False' },
        stem: { presence: 'False' },
        stemComplement: 'False',
        workspace: { presence: 'True', workspaceId: 'default' }
      }
    });
    return (response.clips || []).map((clip: any) => this.normalizeClip(clip));
  }

  /* ------------------------------------------------------------------ */
  /* Uploads                                                             */
  /* ------------------------------------------------------------------ */

  public async getUploadedAudio(uploadId: string): Promise<UploadedAudioInfo> {
    await this.keepAlive(false);
    const response = await this.client.get(
      this.url(`/api/uploads/audio/${uploadId}/`)
    );

    return response.data;
  }

  public async createAudioUpload(
    extension: string,
    uploadType: AudioUploadType = 'file_upload'
  ): Promise<AudioUploadInitInfo> {
    await this.keepAlive(false);
    try {
      const response = await this.client.post(
        this.url('/api/uploads/audio/'),
        { extension, upload_type: uploadType }
      );
      return response.data;
    } catch (error: any) {
      const status = error?.response?.status;
      const data = error?.response?.data;
      if (status === 423)
        throw classifyUploadFailure('upload_blocked_account', errorDetail(data), status, data);
      if (status === 429)
        throw classifyUploadFailure('upload_rate_limited', errorDetail(data), status, data);
      const detail = errorDetail(data) || '';
      if (data?.error_type === 'copyright_infringement' || /copyright|infring/i.test(detail))
        throw classifyUploadFailure('upload_blocked_copyright', detail, status, data);
      throw error;
    }
  }

  public async uploadAudioToStorage(
    uploadData: AudioUploadInitInfo,
    fileBuffer: Buffer,
    filename: string,
    contentType?: string
  ): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
  }> {
    const extension = this.getAudioExtension(filename, contentType);
    const formData = new FormData();

    Object.entries(uploadData.fields || {}).forEach(([key, value]) => {
      formData.append(key, String(value));
    });

    formData.append(
      'file',
      new Blob([fileBuffer], {
        type: uploadData.fields?.['Content-Type'] || contentType || `audio/${extension}`
      }),
      filename
    );

    // axios (not fetch) so the upload goes through the same egress proxy as the rest of the traffic
    const uploadResponse = await axios.post(uploadData.url, formData, {
      ...proxiedAxiosConfig(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 10 * 60_000,
      validateStatus: () => true
    });

    if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
      const body = typeof uploadResponse.data === 'string' ? uploadResponse.data : JSON.stringify(uploadResponse.data ?? '');
      throw new Error(
        `Failed to upload file to storage: ${uploadResponse.status} ${uploadResponse.statusText} ${body.slice(0, 300)}`
      );
    }

    return {
      ok: true,
      status: uploadResponse.status,
      statusText: uploadResponse.statusText
    };
  }

  public async finishAudioUpload(
    uploadId: string,
    filename: string,
    options: { upload_type?: AudioUploadType; agreed_to_vip_upload_terms?: boolean } = {}
  ): Promise<any> {
    await this.keepAlive(false);
    const uploadType = options.upload_type || 'file_upload';
    const body: Record<string, any> = {
      upload_type: uploadType,
      upload_filename: filename
    };
    if (uploadType !== 'voice_recording')
      body.agreed_to_vip_upload_terms = Boolean(options.agreed_to_vip_upload_terms);

    const response = await this.client.post(
      this.url(`/api/uploads/audio/${uploadId}/upload-finish/`),
      body
    );

    return response.data;
  }

  /**
   * Polls an upload until it is processed. Throws a SunoUploadError (with error_type/category/copyright)
   * when Suno rejects the file.
   */
  public async waitForUploadedAudio(
    uploadId: string,
    options: {
      timeoutMs?: number;
      intervalMs?: number;
      onAttempt?: (info: UploadedAudioInfo) => Promise<void> | void;
    } = {}
  ): Promise<UploadedAudioInfo> {
    const timeoutMs = options.timeoutMs ?? 300000;
    const intervalMs = options.intervalMs ?? 4000;
    const startedAt = Date.now();

    while (true) {
      const info = await this.getUploadedAudio(uploadId);
      await options.onAttempt?.(info);

      if (info.status === 'complete')
        return info;
      if (info.status === 'error')
        throw classifyUploadFailure(info.error_type, info.error_message, undefined, info);
      if (Date.now() - startedAt > timeoutMs)
        throw new SunoUploadError({
          message: 'Timed out waiting for Suno to finish processing the upload',
          category: 'timeout',
          retryable: true,
          copyright: false,
          detail: info
        });

      await new Promise(resolve => setTimeout(resolve, intervalMs));
      await this.keepAlive(true);
    }
  }

  public async initializeUploadClip(
    uploadId: string,
    body: { user_reviewed_tags?: boolean; downbeats?: any } = {}
  ): Promise<InitializedUploadClipInfo> {
    await this.keepAlive(false);
    const response = await this.client.post(
      this.url(`/api/uploads/audio/${uploadId}/initialize-clip/`),
      body
    );

    return response.data;
  }

  public async setClipMetadata(
    clipId: string,
    payload: {
      title?: string;
      image_url?: string;
      lyrics?: string;
      is_audio_upload_tos_accepted?: boolean;
      [key: string]: any;
    }
  ): Promise<any> {
    await this.keepAlive(false);
    const response = await this.client.post(
      this.url(`/api/gen/${clipId}/set_metadata/`),
      payload
    );

    return response.data;
  }

  /**
   * Accepts the description Suno inferred for an uploaded clip.
   * The web app also sends the selected `audio_content_types` (e.g. ["Song Demo"]).
   */
  public async acceptAudioDescription(
    clipId: string,
    payload: Record<string, any> = { gemini_description_accepted: true }
  ): Promise<any> {
    await this.keepAlive(false);
    const response = await this.client.post(
      this.url(`/api/gen/${clipId}/set_audio_description`),
      payload
    );

    return response.data;
  }

  public async uploadAudio(
    fileBuffer: Buffer,
    filename: string,
    contentType?: string,
    wait_audio: boolean = true,
    uploadType: AudioUploadType = 'file_upload'
  ): Promise<UploadedAudioInfo> {
    const extension = this.getAudioExtension(filename, contentType);
    const uploadData = await this.createAudioUpload(extension, uploadType);
    await this.uploadAudioToStorage(uploadData, fileBuffer, filename, contentType);
    await this.finishAudioUpload(uploadData.id, filename, { upload_type: uploadType });

    if (!wait_audio)
      return this.getUploadedAudio(uploadData.id);

    return this.waitForUploadedAudio(uploadData.id);
  }

  /* ------------------------------------------------------------------ */
  /* Playlists                                                           */
  /* ------------------------------------------------------------------ */

  public async createPlaylistDraft(
    name: string = 'Untitled'
  ): Promise<PlaylistInfo> {
    await this.keepAlive(false);
    const response = await this.client.post(
      this.url('/api/playlist/create/'),
      { name }
    );

    return response.data;
  }

  public async getPlaylist(playlistId: string, page: number = 1): Promise<PlaylistInfo> {
    await this.keepAlive(false);
    const response = await this.client.get(this.url(`/api/playlist/${playlistId}/?page=${page}`));
    return response.data;
  }

  /**
   * Updates name/description/visibility (PATCH /api/playlist/v2/{id}, falls back to the legacy endpoint).
   */
  public async setPlaylistMetadata(payload: {
    playlist_id: string;
    name: string;
    description?: string;
    is_public?: boolean;
  }): Promise<PlaylistInfo> {
    await this.keepAlive(false);
    try {
      const metadata: Record<string, any> = { name: payload.name };
      if (payload.is_public !== undefined)
        metadata.is_public = payload.is_public;
      const response = await this.client.patch(
        this.url(`/api/playlist/v2/${payload.playlist_id}`),
        { metadata, bio: { description: payload.description ?? '' } }
      );
      if (response.data?.success === false)
        throw new Error(`Failed to update playlist: ${JSON.stringify(response.data?.errors || {})}`);

      return {
        id: payload.playlist_id,
        name: payload.name,
        description: payload.description ?? '',
        ...(payload.is_public !== undefined ? { is_public: payload.is_public } : {}),
        updated_fields: response.data?.updated_fields
      };
    } catch (error) {
      if (!this.isNotFoundOrMethod(error))
        throw error;
    }

    const response = await this.client.post(
      this.url('/api/playlist/set_metadata'),
      {
        playlist_id: payload.playlist_id,
        name: payload.name,
        description: payload.description ?? ''
      }
    );

    return response.data;
  }

  public async createPlaylist(
    name: string,
    description?: string,
    isPublic?: boolean
  ): Promise<PlaylistInfo> {
    const draft = await this.createPlaylistDraft('Untitled');
    const updated = await this.setPlaylistMetadata({
      playlist_id: draft.id,
      name,
      description,
      is_public: isPublic
    });
    return { ...draft, ...updated, id: draft.id, name, description: description ?? '' };
  }

  public async getMyPlaylists(
    page: number = 1,
    showTrashed: boolean = false,
    showSharelist: boolean = false
  ): Promise<PlaylistListResponse> {
    await this.keepAlive(false);
    const response = await this.client.get(
      this.url(`/api/playlist/me?page=${page}&show_trashed=${String(showTrashed)}&show_sharelist=${String(showSharelist)}`)
    );

    return response.data;
  }

  public async updatePlaylistClips(payload: {
    playlist_id: string;
    update_type?: 'add' | 'remove';
    metadata: {
      clip_ids: string[];
    };
    recommendation_metadata?: Record<string, any>;
  }): Promise<{
    playlist_id: string;
    update_type: 'add' | 'remove';
    clip_ids: string[];
    success: true;
    successes?: string[];
    failures?: any[];
  }> {
    await this.keepAlive(false);
    const updateType = payload.update_type ?? 'add';
    const clipIds = payload.metadata.clip_ids;

    try {
      const response = await this.client.post(
        this.url(`/api/playlist/v2/${payload.playlist_id}/tracks/${updateType}`),
        { clip_ids: clipIds }
      );
      const failures = response.data?.failures || [];
      if (failures.length > 0 && !(response.data?.successes || []).length)
        throw new Error(`Failed to ${updateType} playlist clips: ${JSON.stringify(failures)}`);

      return {
        playlist_id: payload.playlist_id,
        update_type: updateType,
        clip_ids: clipIds,
        success: true,
        successes: response.data?.successes,
        failures
      };
    } catch (error) {
      if (!this.isNotFoundOrMethod(error))
        throw error;
    }

    await this.client.post(
      this.url('/api/playlist/update_clips/'),
      {
        playlist_id: payload.playlist_id,
        update_type: updateType,
        metadata: payload.metadata,
        recommendation_metadata: payload.recommendation_metadata ?? {}
      }
    );

    return {
      playlist_id: payload.playlist_id,
      update_type: updateType,
      clip_ids: clipIds,
      success: true
    };
  }

  /**
   * Retrieves information for a specific audio clip.
   */
  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);

    try {
      const response = await this.client.get(
        this.url(`/api/clip/${clipId}`)
      );

      return this.normalizeClip(response.data);
    } catch (error) {
      if (!axios.isAxiosError(error) || error.response?.status !== 404)
        throw error;

      const [clip] = await this.getFeedClipsByIds([clipId]);
      if (clip)
        return clip;

      const notFoundError = new Error(`Clip not found: ${clipId}`);
      (notFoundError as Error & { status?: number }).status = 404;
      throw notFoundError;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Workspaces (projects)                                               */
  /* ------------------------------------------------------------------ */

  public async listWorkspaces(page: number = 1): Promise<WorkspaceInfo[]> {
    await this.keepAlive(false);
    const response = await this.client.get(
      this.url(`/api/project/me?page=${page}&sort=max_created_at_last_updated_clip&show_trashed=false&exclude_shared=false`),
      { timeout: 15000 }
    );

    return response.data.projects || [];
  }

  public async listAllWorkspaces(maxPages: number = 20): Promise<WorkspaceInfo[]> {
    const all: WorkspaceInfo[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.listWorkspaces(page);
      const fresh = items.filter(item => !seen.has(item.id));
      fresh.forEach(item => seen.add(item.id));
      all.push(...fresh);
      if (items.length === 0 || fresh.length === 0)
        break;
    }
    return all;
  }

  public async createWorkspace(name: string, description: string = ''): Promise<WorkspaceInfo> {
    await this.keepAlive(false);
    const response = await this.client.post(this.url('/api/project'), { name, description });
    return response.data;
  }

  public async resolveWorkspace(
    workspaceId?: string,
    workspaceName?: string,
    createIfMissing: boolean = false
  ): Promise<WorkspaceInfo> {
    if (workspaceId) {
      return {
        id: workspaceId,
        name: workspaceName || workspaceId
      };
    }

    if (!workspaceName)
      throw new Error('workspace_id or workspace_name is required');

    const normalizedName = workspaceName.trim().toLowerCase();
    const workspaces = await this.listAllWorkspaces();
    const workspace = workspaces.find(
      item => item.name?.trim().toLowerCase() === normalizedName
    );

    if (workspace)
      return workspace;

    if (createIfMissing) {
      logger.info(`Workspace "${workspaceName}" not found, creating it`);
      return this.createWorkspace(workspaceName.trim());
    }

    const notFound = new Error(`Workspace not found: ${workspaceName}`);
    (notFound as Error & { status?: number }).status = 404;
    throw notFound;
  }

  public async moveClipsToWorkspace(
    clipIds: string[],
    workspaceId?: string,
    workspaceName?: string,
    createIfMissing: boolean = false
  ): Promise<{
    workspace_id: string;
    workspace_name?: string;
    clip_ids: string[];
  }> {
    const workspace = await this.resolveWorkspace(workspaceId, workspaceName, createIfMissing);

    await this.keepAlive(false);
    await this.client.post(
      this.url(`/api/project/${workspace.id}/clips`),
      {
        update_type: 'add',
        metadata: {
          clip_ids: clipIds
        }
      }
    );

    return {
      workspace_id: workspace.id,
      workspace_name: workspace.name,
      clip_ids: clipIds
    };
  }

  public async getWorkspaceFeed(
    workspaceId?: string,
    workspaceName?: string,
    cursor?: string | null,
    limit: number = 20
  ): Promise<{
    workspace: WorkspaceInfo;
    clips: any[];
    has_more?: boolean;
    next_cursor?: string | null;
  }> {
    const workspace = await this.resolveWorkspace(workspaceId, workspaceName);
    const response = await this.feedV3({
      cursor: cursor ?? null,
      limit,
      filters: {
        disliked: 'False',
        trashed: 'False',
        fromStudioProject: {
          presence: 'False'
        },
        stem: {
          presence: 'False'
        },
        stemComplement: 'False',
        workspace: {
          presence: 'True',
          workspaceId: workspace.id
        }
      }
    });

    return {
      workspace,
      clips: (response.clips || []).map((clip: any) => this.normalizeClip(clip)),
      has_more: response.has_more,
      next_cursor: response.next_cursor || response.cursor || null
    };
  }

  public async generateFromAudio(
    clipId: string,
    mode: AudioToAudioMode,
    options?: Partial<GenerateOptions> & {
      workspace_id?: string;
      workspace_name?: string;
    }
  ): Promise<any[]> {
    const sourceClip: any = await this.getClip(clipId);
    const sourceMetadata = sourceClip?.metadata || {};
    const defaultTitleByMode: Record<AudioToAudioMode, string> = {
      cover: sourceClip.title || clipId,
      add_vocals: `${sourceClip.title || clipId} (Add Vocal)`,
      add_instrumental: `${sourceClip.title || clipId} (Add Instrumental)`
    };

    let workspace: WorkspaceInfo | undefined;
    if (options?.workspace_id || options?.workspace_name) {
      workspace = await this.resolveWorkspace(
        options.workspace_id,
        options.workspace_name
      );
    } else if (sourceClip?.project?.id) {
      workspace = {
        id: sourceClip.project.id,
        name: sourceClip.project.name
      };
    }

    const { workspace_id, workspace_name, wait_audio, ...generateOptions } = options || {};
    const clips = await this.generateV2Web({
      ...generateOptions,
      ...this.buildAudioToAudioOptions(mode, clipId),
      prompt: options?.prompt ?? sourceMetadata.prompt ?? '',
      title: options?.title ?? defaultTitleByMode[mode],
      tags: options?.tags ?? sourceMetadata.tags ?? '',
      negative_tags: options?.negative_tags ?? sourceMetadata.negative_tags ?? '',
      model: options?.model || DEFAULT_AUDIO_TO_AUDIO_MODEL,
      project_id: workspace?.id
    });

    const clipIds = clips.map((clip: any) => clip.id);

    // project_id already places the clips in the workspace; this is a best-effort safety net.
    if (workspace?.id && clipIds.length > 0) {
      await this.moveClipsToWorkspace(clipIds, workspace.id).catch(error =>
        logger.warn(`Could not move clips to workspace ${workspace?.id}: ${error.message}`)
      );
    }

    if (wait_audio)
      return this.waitForFeedClips(clipIds);

    return clips;
  }

  /* ------------------------------------------------------------------ */
  /* Personas & voices                                                   */
  /* ------------------------------------------------------------------ */

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);
    const response = await this.client.get(
      this.url(`/api/persona/get-persona-paginated/${personaId}/?page=${page}`),
      { timeout: 10000 }
    );
    return response.data;
  }

  public async getPersona(personaId: string): Promise<any> {
    await this.keepAlive(false);
    const response = await this.client.get(this.url(`/api/persona/get-persona/${personaId}/`), {
      timeout: 10000
    });
    return response.data;
  }

  /**
   * Lists the account personas. Voices are personas with persona_type "vox".
   */
  public async listPersonas(page: number = 1, kind: 'mine' | 'loved' | 'followed' = 'mine'): Promise<any> {
    await this.keepAlive(false);
    const endpoint = {
      mine: '/api/persona/get-personas/',
      loved: '/api/persona/get-loved-personas/',
      followed: '/api/persona/get-followed-personas/'
    }[kind];
    const response = await this.client.get(this.url(`${endpoint}?page=${page}`));
    return response.data;
  }

  public async createPersona(body: Record<string, any>): Promise<any> {
    await this.keepAlive(false);
    const response = await this.client.post(this.url('/api/persona/create/'), body);
    return response.data;
  }

  /** Generates a cover image from a prompt (used for voices). Returns image_url, image_s3_id, upload_id. */
  public async generatePromptImage(prompt: string): Promise<{ image_url: string; image_s3_id: string; upload_id?: string }> {
    await this.keepAlive(false);
    const response = await this.client.post(this.url('/api/gen/prompt_image/'), { prompt }, { timeout: 60000 });
    return response.data;
  }

  /** Phrase the user has to sing/say in the verification recording. */
  public async getVoiceVerificationPhrase(language: string = 'en'): Promise<{ phrase_id: string; phrase_text: string }> {
    await this.keepAlive(false);
    const response = await this.client.get(
      this.url(`/api/voice-verification/phrase/?language=${encodeURIComponent(language)}`)
    );
    return response.data;
  }

  /**
   * Extracts the vocal stem of an uploaded voice recording. Returns { id, status, voice_recording_id }.
   * Use recording_type "verification" for the verification phrase recording.
   */
  public async processVoiceStem(body: {
    upload_id: string;
    vocal_start_s?: number;
    vocal_end_s?: number;
    recording_type?: 'verification' | string;
  }): Promise<{ id: string; status: string; voice_recording_id: string; vocal_start_s?: number; vocal_end_s?: number }> {
    await this.keepAlive(false);
    const response = await this.client.post(this.url('/api/processed_clip/voice-vox-stem'), body);
    return response.data;
  }

  public async createVoiceVerification(body: {
    voice_recording_id: string;
    verification_recording_id: string;
    phrase_id: string;
  }): Promise<any> {
    await this.keepAlive(false);
    const response = await this.client.post(this.url('/api/voice-verification/'), body);
    return response.data;
  }

  public async getVoiceVerification(verificationId: string): Promise<any> {
    await this.keepAlive(false);
    const response = await this.client.get(this.url(`/api/voice-verification/${verificationId}`));
    return response.data;
  }

  public async waitForVoiceVerification(verificationId: string, timeoutMs: number = 180000): Promise<any> {
    const startedAt = Date.now();
    while (true) {
      const verification = await this.getVoiceVerification(verificationId);
      if (verification.status && verification.status !== 'pending' && verification.status !== 'processing')
        return verification;
      if (Date.now() - startedAt > timeoutMs)
        return verification;
      await sleep(2, 3);
    }
  }

  private async waitForUploadIfPossible(uploadId: string, timeoutMs: number): Promise<UploadedAudioInfo | null> {
    try {
      return await this.waitForUploadedAudio(uploadId, { timeoutMs, intervalMs: 2000 });
    } catch (error) {
      if (error instanceof SunoUploadError && error.category !== 'timeout')
        throw error;
      logger.warn(`Voice upload ${uploadId} status unavailable, continuing: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Full "create voice" flow of the web app:
   * voice recording upload -> vocal stem -> verification recording upload -> verification -> persona (vox).
   */
  public async createVoice(input: {
    voice: { buffer: Buffer; filename: string; contentType?: string };
    verification: { buffer: Buffer; filename: string; contentType?: string };
    phrase_id: string;
    name: string;
    description?: string;
    vocal_start_s?: number;
    vocal_end_s?: number;
    is_public?: boolean;
    image_s3_id?: string;
    image_prompt?: string;
    user_input_styles?: string;
    singer_skill_level?: string;
  }): Promise<{ persona?: any; verification: any; voice_recording_id: string; verification_recording_id: string; steps: any[] }> {
    const steps: any[] = [];

    const voiceUpload = await this.createAudioUpload(this.getAudioExtension(input.voice.filename, input.voice.contentType), 'voice_recording');
    await this.uploadAudioToStorage(voiceUpload, input.voice.buffer, input.voice.filename, input.voice.contentType);
    await this.finishAudioUpload(voiceUpload.id, input.voice.filename, { upload_type: 'voice_recording' });
    steps.push({ step: 'voice_upload', upload_id: voiceUpload.id });
    await this.waitForUploadIfPossible(voiceUpload.id, 90000);

    const voiceStem = await this.processVoiceStem({
      upload_id: voiceUpload.id,
      vocal_start_s: input.vocal_start_s ?? 0,
      ...(input.vocal_end_s !== undefined ? { vocal_end_s: input.vocal_end_s } : {})
    });
    steps.push({ step: 'voice_stem', ...voiceStem });

    const verificationUpload = await this.createAudioUpload(
      this.getAudioExtension(input.verification.filename, input.verification.contentType),
      'voice_recording'
    );
    await this.uploadAudioToStorage(verificationUpload, input.verification.buffer, input.verification.filename, input.verification.contentType);
    await this.finishAudioUpload(verificationUpload.id, input.verification.filename, { upload_type: 'voice_recording' });
    steps.push({ step: 'verification_upload', upload_id: verificationUpload.id });
    await this.waitForUploadIfPossible(verificationUpload.id, 90000);

    const verificationStem = await this.processVoiceStem({
      upload_id: verificationUpload.id,
      recording_type: 'verification'
    });
    steps.push({ step: 'verification_stem', ...verificationStem });

    const created = await this.createVoiceVerification({
      voice_recording_id: voiceStem.voice_recording_id,
      verification_recording_id: verificationStem.voice_recording_id,
      phrase_id: input.phrase_id
    });
    const verification = await this.waitForVoiceVerification(created.id);
    steps.push({ step: 'verification', id: verification.id, status: verification.status, rejection_reason: verification.rejection_reason });

    const result = {
      verification,
      voice_recording_id: voiceStem.voice_recording_id,
      verification_recording_id: verificationStem.voice_recording_id,
      steps
    };

    // Only "pending" and "rejected" have been observed; treat any other final state as success.
    const failedStatuses = ['pending', 'processing', 'rejected', 'failed', 'error', 'expired'];
    if (failedStatuses.includes(verification.status)) {
      const error = new Error(
        `Voice verification ${verification.status}${verification.rejection_reason ? `: ${verification.rejection_reason}` : ''}`
      );
      (error as any).status = 422;
      (error as any).detail = result;
      throw error;
    }

    let imageS3Id = input.image_s3_id;
    if (!imageS3Id && input.image_prompt) {
      const image = await this.generatePromptImage(input.image_prompt).catch(() => null);
      imageS3Id = image?.image_s3_id;
    }

    const persona = await this.createPersona({
      name: input.name,
      description: input.description ?? '',
      persona_type: 'vox',
      is_voice_recording: true,
      voice_recording_id: voiceStem.voice_recording_id,
      verification_id: verification.id,
      vocal_start_s: input.vocal_start_s ?? voiceStem.vocal_start_s ?? 0,
      ...(input.vocal_end_s ?? voiceStem.vocal_end_s ? { vocal_end_s: input.vocal_end_s ?? voiceStem.vocal_end_s } : {}),
      is_public: input.is_public ?? false,
      ...(imageS3Id ? { image_s3_id: imageS3Id } : {}),
      ...(input.user_input_styles ? { user_input_styles: input.user_input_styles } : {}),
      ...(input.singer_skill_level ? { singer_skill_level: input.singer_skill_level } : {})
    });
    steps.push({ step: 'persona', id: persona?.id });

    return { ...result, persona };
  }

  /* ------------------------------------------------------------------ */
  /* Custom models                                                       */
  /* ------------------------------------------------------------------ */

  public async getCustomModelBases(): Promise<Array<{ base_model: string; name: string; is_default: boolean }>> {
    await this.keepAlive(false);
    const response = await this.client.get(this.url('/api/custom-model/bases/'));
    return response.data?.options || [];
  }

  public async getPendingCustomModels(): Promise<{ has_pending: boolean; pending_models: Array<{ id: string; name: string }> }> {
    await this.keepAlive(false);
    const response = await this.client.get(this.url('/api/custom-model/pending/'));
    return response.data;
  }

  /**
   * Trains a custom model from uploaded clips (the web app asks for at least 6 songs).
   * Once ready it shows up in getModels() as `chirp-custom:<id>` and can be used as `model`.
   */
  public async createCustomModel(body: { clip_ids: string[]; name: string; base_model?: string }): Promise<{ id: string; status: string; base_model: string }> {
    await this.keepAlive(false);
    let baseModel = body.base_model;
    if (!baseModel) {
      const bases = await this.getCustomModelBases().catch(() => []);
      baseModel = bases.find(base => base.is_default)?.base_model || DEFAULT_MODEL;
    }
    const response = await this.client.post(this.url('/api/custom-model/create/'), {
      clip_ids: body.clip_ids,
      name: body.name,
      base_model: baseModel
    });
    return response.data;
  }

  public async archiveCustomModel(modelId: string): Promise<any> {
    await this.keepAlive(false);
    const response = await this.client.post(this.url('/api/custom-model/archive/'), { id: modelId });
    this.billingCache = undefined;
    return response.data ?? { ok: true };
  }

  public async listCustomModels(): Promise<{ models: ModelInfo[]; pending: Array<{ id: string; name: string }> }> {
    const [models, pending] = await Promise.all([
      this.getModels(),
      this.getPendingCustomModels().catch(() => ({ has_pending: false, pending_models: [] }))
    ]);
    return {
      models: models.filter(model => model.is_custom),
      pending: pending.pending_models || []
    };
  }

  public async waitForCustomModel(modelId: string, timeoutMs: number = 15 * 60_000): Promise<ModelInfo | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const pending = await this.getPendingCustomModels();
      if (!(pending.pending_models || []).some(model => model.id === modelId)) {
        this.billingCache = undefined;
        const models = await this.getModels();
        return models.find(model => model.id === modelId || model.external_key === `chirp-custom:${modelId}`) || null;
      }
      await sleep(10, 15);
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Downloads                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Unlocks a clip for download. NOTE: this may deduct download credits (credit_deducted: true).
   */
  public async authorizeDownload(itemId: string, itemType: string = 'clip'): Promise<{ ok: boolean; already_unlocked?: boolean; credit_deducted?: boolean }> {
    await this.keepAlive(false);
    const response = await this.client.post(this.url('/api/download/authorize'), {
      item_id: itemId,
      item_type: itemType
    });
    return response.data;
  }

  public async getClipDownload(clipId: string, format: string = 'mp3'): Promise<{ ok: boolean; status: string; download_url?: string }> {
    await this.keepAlive(false);
    const response = await this.client.get(this.url(`/api/download/clip/${clipId}?format=${encodeURIComponent(format)}`));
    return response.data;
  }

  public async downloadClip(
    clipId: string,
    options: { format?: string; authorize?: boolean; timeoutMs?: number } = {}
  ): Promise<any> {
    const format = options.format || 'mp3';
    const authorization = options.authorize === false ? null : await this.authorizeDownload(clipId, 'clip');
    const startedAt = Date.now();
    let status = await this.getClipDownload(clipId, format);
    while (status.status !== 'ready' && status.status !== 'error' && Date.now() - startedAt < (options.timeoutMs ?? 120000)) {
      await sleep(2, 3);
      status = await this.getClipDownload(clipId, format);
    }
    return { clip_id: clipId, format, authorization, ...status };
  }

  /** Requests the WAV conversion of a clip and waits for its URL. */
  public async getWavFile(clipId: string, options: { timeoutMs?: number } = {}): Promise<{ clip_id: string; wav_file_url?: string; status: string }> {
    await this.keepAlive(false);
    const existing = await this.client.get(this.url(`/api/gen/${clipId}/wav_file/`));
    if (existing.data?.wav_file_url)
      return { clip_id: clipId, wav_file_url: existing.data.wav_file_url, status: 'ready' };

    await this.client.post(this.url(`/api/gen/${clipId}/convert_wav/`));
    const startedAt = Date.now();
    while (Date.now() - startedAt < (options.timeoutMs ?? 120000)) {
      await sleep(2, 3);
      const response = await this.client.get(this.url(`/api/gen/${clipId}/wav_file/`));
      if (response.data?.wav_file_url)
        return { clip_id: clipId, wav_file_url: response.data.wav_file_url, status: 'ready' };
    }
    return { clip_id: clipId, status: 'processing' };
  }

  /* ------------------------------------------------------------------ */
  /* Clip analysis                                                       */
  /* ------------------------------------------------------------------ */

  /** Musical key and downbeats computed by Suno ({ state, key } / { state, downbeats }). */
  public async getClipAnalysis(clipId: string, wait: boolean = true): Promise<{ key?: any; downbeats?: any }> {
    await this.keepAlive(false);
    const fetchBoth = async () => {
      const [key, downbeats] = await Promise.all([
        this.client.get(this.url(`/api/gen/${clipId}/key`)).then(r => r.data),
        this.client.get(this.url(`/api/gen/${clipId}/downbeats`)).then(r => r.data)
      ]);
      return { key, downbeats };
    };
    let result = await fetchBoth();
    const startedAt = Date.now();
    while (wait && (result.key?.state === 'running' || result.downbeats?.state === 'running') && Date.now() - startedAt < 60000) {
      await sleep(2, 3);
      result = await fetchBoth();
    }
    return result;
  }
}

const decodeCookieValue = (value?: string | null) => {
  if (!value)
    return value ?? '';

  const trimmed = value.trim();
  if (!/%[0-9A-Fa-f]{2}/.test(trimmed))
    return trimmed;

  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
};

/**
 * Returns an initialized client for a cookie. Instances are cached per cookie, so several
 * accounts stay authenticated at the same time. Concurrent first calls share the same init.
 */
export const sunoApi = async (cookie?: string, accountId?: string) => {
  let resolvedCookie = decodeCookieValue(cookie);
  let resolvedAccountId = accountId;
  if (!resolvedCookie) {
    const account = resolveAccount(accountId);
    resolvedCookie = account?.cookie || '';
    resolvedAccountId = account?.id;
  }
  if (!resolvedCookie) {
    logger.info('No cookie provided! Aborting...\nPlease provide `suno_cookie` in the request or set SUNO_COOKIE in the .env file.')
    throw new Error('Please provide `suno_cookie` in the request, add an account (/api/accounts) or set SUNO_COOKIE in the .env file.');
  }

  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance) {
    if (resolvedAccountId && !cachedInstance.accountId)
      cachedInstance.accountId = resolvedAccountId;
    return cachedInstance;
  }

  let pending = pendingInits.get(resolvedCookie);
  if (!pending) {
    pending = new SunoApi(resolvedCookie)
      .init()
      .then(instance => {
        instance.accountId = resolvedAccountId;
        cache.set(resolvedCookie, instance);
        return instance;
      })
      .finally(() => pendingInits.delete(resolvedCookie));
    pendingInits.set(resolvedCookie, pending);
  }

  return pending;
};

/** Client for a registered account (id, label, email or handle). Without id, the default account. */
export const sunoApiForAccount = async (accountId?: string | null) => {
  const account = resolveAccount(accountId);
  if (!account)
    throw new Error('No Suno account configured. Add one with POST /api/accounts or set SUNO_COOKIE.');
  return sunoApi(account.cookie, account.id);
};

/** Drops cached clients (e.g. after an account cookie was replaced or removed). */
export const evictSunoApi = (account?: SunoAccount | { cookie?: string } | null) => {
  if (account?.cookie)
    cache.delete(account.cookie);
};

export type { SunoApi };
