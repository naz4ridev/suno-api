import type { BrowserContext, Frame, Locator, Page, Route } from 'rebrowser-playwright-core';

/**
 * Browser-side hCaptcha acquisition for POST /api/generate/v2-web/.
 *
 * Contract:
 *  - The generation interceptor is registered on the BrowserContext BEFORE any page exists, so no
 *    request to /api/generate/* issued by the automated page can ever reach Suno. Every one is aborted;
 *    only the captcha token (and the renewed bearer) is read from it, privately.
 *  - Everything is bounded by one total deadline. The browser and context are always closed.
 *  - Every failure is a CaptchaFlowError: it happens before the real generation POST, so
 *    `submitted` is always false and the code is public and free of upstream data.
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
 * client may record "not sent" without reconciling. Properties are picked up by errorResponse().
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

/** Every URL this matches is aborted in the captcha browser. */
export const GENERATE_REQUEST_PATTERN = /\/api\/generate(?:\/|\?|$)/;
/** Only these carry the captcha token that ends the flow; any other generate* request is just aborted. */
const TOKEN_CARRIER_PATTERN = /\/api\/generate\/v2(?:-web)?\/?(?:\?|$)/;

/**
 * c/check now answers captcha_version 2: the create form first runs a Cloudflare Turnstile widget and only
 * falls back to hCaptcha when Turnstile cannot load. In a headless server browser that widget never completes
 * (the page waits forever and hCaptcha is never rendered), so its script is blocked to take Suno's own
 * hCaptcha fallback, which the configured solver can answer. The token still comes from Suno's page.
 */
export const TURNSTILE_PATTERN = /^https:\/\/challenges\.cloudflare\.com\/turnstile\//;

export const CREATE_URL = 'https://suno.com/create';
export const DUMMY_PROMPT = 'Lorem ipsum';
export const DEFAULT_TOTAL_TIMEOUT_MS = 180_000;
export const MAX_SOLVER_REQUESTS = 3;
const MAX_CREATE_RECLICKS = 2;

/**
 * Ordered candidates. Semantic ones first; the old `.custom-textarea` is kept only as a legacy fallback
 * and the last resort is structural (nearest textarea in the form that owns the Create button).
 */
export const CREATE_BUTTON_SELECTORS = [
  'button[aria-label="Create song"]',
  'button[aria-label="Create"]',
  'button[aria-label^="Create" i]:not([aria-label*="clear" i])'
];
export const PROMPT_SELECTORS = [
  '.custom-textarea',
  'textarea[data-testid*="prompt" i]',
  'textarea[aria-label*="song description" i]',
  'textarea[placeholder*="describe" i]'
];

export interface CaptchaSolver {
  /** 2Captcha coordinates task; `data` is an array of {x,y} points at runtime. */
  coordinates(payload: any): Promise<any>;
  badReport(id: string): unknown;
}

export interface CaptchaFlowDeps {
  /** Launches a browser and returns an authenticated context (caller owns cookies/proxy/UA). */
  launchContext: () => Promise<BrowserContext>;
  /** null when no solver key is configured. */
  solver: CaptchaSolver | null;
  /** Pointer helper (ghost cursor aware). Defaults to a plain forced click. */
  click?: (target: Locator | Page, position?: { x: number; y: number }) => Promise<unknown>;
  /** Called with the page before interaction (e.g. to attach a ghost cursor). */
  onPage?: (page: Page) => Promise<void> | void;
  readDragInstructions?: () => Promise<string>;
  locale?: string;
  url?: string;
  totalTimeoutMs?: number;
  /** How long to wait for the create UI controls to appear (default 60s, always capped by the total deadline). */
  uiTimeoutMs?: number;
  /** How long to wait for the Create click to start the captcha check (default 8s per click). */
  triggerTimeoutMs?: number;
  /** Block the Turnstile script so the app uses its hCaptcha fallback (default true). */
  blockTurnstile?: boolean;
  /** Progress log. Must never receive tokens, cookies or request bodies. */
  log?: (message: string) => void;
}

export interface CaptchaFlowResult {
  token: string;
  /** Renewed bearer observed on the aborted request. Never log it. */
  authorization?: string;
  /** Number of aborted /api/generate* requests (must be >= 1 on success, never delivered upstream). */
  abortedGenerateRequests: number;
  solverRequests: number;
}

const defer = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>(res => { timer = setTimeout(() => res(undefined), ms); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const sleepAbortable = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });

/** First candidate that becomes visible before the deadline. */
async function firstVisible(
  page: Page, selectors: string[], timeoutMs: number, signal: AbortSignal
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.count() > 0 && await locator.isVisible())
          return locator;
      } catch { /* page navigating or closed: retry until deadline */ }
    }
    await sleepAbortable(400, signal);
  } while (Date.now() < deadline && !signal.aborted);
  return null;
}

const DISMISS_BUTTON = /^(got it|close|dismiss|no,? thanks|not now|maybe later|skip|ok|okay|done)$/i;

/** Promo/onboarding dialogs steal focus and disable the Create button; close up to `rounds` of them. */
export async function dismissBlockingDialogs(page: Page, signal: AbortSignal, rounds = 3): Promise<number> {
  let closed = 0;
  for (let i = 0; i < rounds && !signal.aborted; i++) {
    const dialog = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').first();
    try {
      if (await dialog.count() === 0) break;
      const action = dialog.getByRole('button', { name: DISMISS_BUTTON }).first();
      if (await action.count() > 0) await action.click({ timeout: 2000 });
      else await page.keyboard.press('Escape');
      closed++;
      await sleepAbortable(400, signal);
    } catch { break; }
  }
  return closed;
}

/** Waits until the Create button accepts clicks (it stays disabled while a dialog or empty prompt blocks it). */
async function waitForEnabled(button: Locator, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    try { if (await button.isEnabled()) return true; } catch { /* re-render */ }
    await sleepAbortable(300, signal);
  }
  return false;
}

/**
 * The create form ships in two variants (experiment/last-used mode). Advanced has several textareas
 * (Cowriter prompt, Styles...) and keeps Create disabled; Simple has the single description box.
 * The tab strip can render after the Create button, so wait for it before deciding.
 */
export async function ensureSimpleMode(page: Page, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const tab = page.getByRole('tab', { name: /^simple$/i }).first();
  while (!signal.aborted && Date.now() < deadline) {
    try {
      if (await tab.count() > 0) {
        for (let i = 0; i < 3; i++) {
          if (await tab.getAttribute('aria-selected', { timeout: 1500 }) === 'true') return true;
          await tab.click({ force: true, timeout: 2000 });
          await sleepAbortable(800, signal);
        }
        return await tab.getAttribute('aria-selected', { timeout: 1500 }) === 'true';
      }
    } catch { /* tab strip re-rendering */ }
    await sleepAbortable(300, signal);
  }
  return false; // older UI without tabs: continue with whatever textarea the form has
}

/** Finds the prompt box and the Create button on the current /create UI. */
export async function locateCreateControls(
  page: Page, timeoutMs: number, signal: AbortSignal
): Promise<{ prompt: Locator; button: Locator }> {
  const button = await firstVisible(page, CREATE_BUTTON_SELECTORS, timeoutMs, signal);
  if (!button)
    throw new CaptchaFlowError('CAPTCHA_UI_CHANGED', 'Create button not found on the create page',
      `selectors=${CREATE_BUTTON_SELECTORS.join(' | ')}`);

  await ensureSimpleMode(page, Math.min(timeoutMs, 10_000), signal);

  let prompt = await firstVisible(page, PROMPT_SELECTORS, 1500, signal);
  if (!prompt) {
    // Structural fallback: nearest ancestor of the Create button that contains a textarea.
    const owned = button.locator('xpath=ancestor::*[.//textarea][1]').locator('textarea:visible').first();
    try {
      if (await owned.count() > 0) prompt = owned;
    } catch { /* ignore */ }
  }
  if (!prompt)
    throw new CaptchaFlowError('CAPTCHA_UI_CHANGED', 'Prompt textarea not found on the create page',
      `selectors=${PROMPT_SELECTORS.join(' | ')} + form textarea fallback`);
  return { prompt, button };
}

/**
 * The challenge iframe is not reachable through page.locator()/frameLocator() on the current UI (Suno mounts
 * it behind a shadow root), but page.frames() still lists it. Match by frame URL or iframe title.
 */
export async function findChallengeFrame(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    let isCaptcha = /hcaptcha/i.test(frame.url());
    if (!isCaptcha) {
      try { isCaptcha = /hcaptcha/i.test(await (await frame.frameElement()).getAttribute('title') ?? ''); } catch { /* detached */ }
    }
    if (!isCaptcha) continue;
    try {
      const container = frame.locator('.challenge-container');
      if (await container.count() > 0 && await container.isVisible()) return frame;
    } catch { /* frame navigating */ }
  }
  return null;
}

/** Resolves once the hCaptcha image traffic has been quiet for `quietMs` (or `maxMs` passed). */
function waitForHcaptchaQuiet(page: Page, signal: AbortSignal, quietMs = 1000, maxMs = 10_000): Promise<void> {
  return new Promise<void>(resolve => {
    // Suno proxies hCaptcha through its own hosts (hcaptcha-imgs-prod.suno.com, ...): match any host with 'hcaptcha'.
    const pattern = /^https:\/\/[^/]*hcaptcha[^/]*\//i;
    let active = 0;
    let quiet: NodeJS.Timeout | undefined;
    const arm = () => { if (quiet) clearTimeout(quiet); if (active <= 0) quiet = setTimeout(finish, quietMs); };
    const onReq = (r: { url: () => string }) => { if (pattern.test(r.url())) { active++; if (quiet) clearTimeout(quiet); } };
    const onDone = (r: { url: () => string }) => { if (pattern.test(r.url())) { active--; arm(); } };
    const cap = setTimeout(finish, maxMs);
    function finish() {
      clearTimeout(cap); if (quiet) clearTimeout(quiet);
      page.off('request', onReq); page.off('requestfinished', onDone); page.off('requestfailed', onDone);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    page.on('request', onReq); page.on('requestfinished', onDone); page.on('requestfailed', onDone);
    signal.addEventListener('abort', finish, { once: true });
    arm();
  });
}

/**
 * Opens the create page, triggers the hCaptcha, solves it through 2Captcha and returns the token. The
 * generation request that carries the token is aborted, never delivered.
 */
export async function acquireGenerationCaptchaToken(deps: CaptchaFlowDeps): Promise<CaptchaFlowResult> {
  const log = deps.log ?? (() => {});
  const totalMs = deps.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const deadline = Date.now() + totalMs;
  const remaining = (cap = Infinity) => Math.max(1, Math.min(cap, deadline - Date.now()));

  // Fail before launching anything: without a solver nobody can answer the challenge.
  if (!deps.solver)
    throw new CaptchaFlowError('CAPTCHA_INTERACTION_REQUIRED',
      'A CAPTCHA is required and no solver key is configured; manual interaction is needed');

  const click = deps.click ?? ((target, position) =>
    (target as Locator).click({ force: true, position, timeout: remaining(5000) }));
  const controller = new AbortController();
  const outcome = defer<CaptchaFlowResult>();
  let settled = false;
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    outcome.reject(isCaptchaFlowError(error) ? error
      : new CaptchaFlowError('CAPTCHA_BROWSER_FAILED', 'Captcha browser flow failed', error));
  };
  const succeed = (result: CaptchaFlowResult) => {
    if (settled) return;
    settled = true;
    outcome.resolve(result);
  };
  outcome.promise.catch(() => {}); // never an unhandled rejection, whoever settles first

  const timer = setTimeout(() => fail(new CaptchaFlowError('CAPTCHA_TIMEOUT',
    `No captcha token within ${Math.round(totalMs / 1000)}s`)), totalMs);

  let context: BrowserContext | undefined;
  let driver: Promise<void> = Promise.resolve();
  let aborted = 0;
  let solverRequests = 0;

  try {
    // A launch may complete after the deadline. Close that late context too; it must never
    // escape just because it was not assigned when finally ran.
    const launching = deps.launchContext().then(async launched => {
      if (!controller.signal.aborted && !settled) return launched;
      const browser = launched.browser();
      await withTimeout(launched.close().catch(() => {}), 5000);
      if (browser) await withTimeout(browser.close().catch(() => {}), 5000);
      return undefined;
    });
    context = await withTimeout(launching, remaining()) ?? (() => {
      throw new CaptchaFlowError('CAPTCHA_TIMEOUT', 'Browser launch timed out');
    })();
    const ctx = context;

    // 1) Interceptor FIRST: nothing the page does can reach /api/generate*.
    await ctx.route(GENERATE_REQUEST_PATTERN, async (route: Route) => {
      const request = route.request();
      let token: unknown;
      let authorization: string | undefined;
      try {
        if (request.method() === 'POST') {
          const body = request.postDataJSON() as any;
          token = body?.token;
          authorization = request.headers().authorization?.split('Bearer ').pop();
        }
      } catch { /* body not JSON */ }
      aborted++;
      await route.abort('blockedbyclient').catch(() => {});
      if (request.method() !== 'POST' || !TOKEN_CARRIER_PATTERN.test(request.url())) return;
      if (typeof token === 'string' && token.length > 0)
        succeed({ token, authorization, abortedGenerateRequests: aborted, solverRequests });
      else
        fail(new CaptchaFlowError('CAPTCHA_TOKEN_MISSING',
          'The create page produced a generation request without a captcha token (aborted)'));
    });

    if (deps.blockTurnstile !== false)
      await ctx.route(TURNSTILE_PATTERN, (route: Route) => route.abort('blockedbyclient').catch(() => {}));

    ctx.on('close', () => fail(new CaptchaFlowError('CAPTCHA_BROWSER_FAILED', 'Browser closed before a token was produced')));

    driver = (async () => {
      const page = await ctx.newPage();
      page.on('crash', () => fail(new CaptchaFlowError('CAPTCHA_BROWSER_FAILED', 'Page crashed')));
      await page.goto(deps.url ?? CREATE_URL, {
        referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: remaining(60_000)
      });
      await deps.onPage?.(page);

      log('Waiting for Suno interface to load');
      const { prompt, button } = await locateCreateControls(page, remaining(deps.uiTimeoutMs ?? 60_000), controller.signal);
      await dismissBlockingDialogs(page, controller.signal);

      log('Triggering the CAPTCHA');
      await click(prompt);
      await prompt.pressSequentially(DUMMY_PROMPT, { delay: 80, timeout: remaining(30_000) });
      if (!await waitForEnabled(button, 3000, controller.signal)) {
        // A dialog may have opened while typing: close it and type again once.
        await dismissBlockingDialogs(page, controller.signal);
        await click(prompt);
        await prompt.fill(DUMMY_PROMPT, { timeout: remaining(10_000) });
        if (!await waitForEnabled(button, 5000, controller.signal))
          throw new CaptchaFlowError('CAPTCHA_UI_CHANGED', 'Create button stayed disabled after entering a prompt');
      }
      await sleepAbortable(1500, controller.signal); // the form validates asynchronously; an early click is ignored

      // A click only counts once the app asks Suno whether a captcha is needed (POST /api/c/check).
      const clickCreate = async () => {
        const started = page.waitForRequest(r => /\/api\/c\/check/.test(r.url()), { timeout: remaining(deps.triggerTimeoutMs ?? 8000) })
          .then(() => true, () => false);
        await click(button);
        return started;
      };
      let triggered = await clickCreate();
      for (let attempt = 0; !triggered && attempt < MAX_CREATE_RECLICKS && !controller.signal.aborted; attempt++) {
        await dismissBlockingDialogs(page, controller.signal);
        triggered = await clickCreate();
      }
      if (!triggered && !controller.signal.aborted)
        throw new CaptchaFlowError('CAPTCHA_UI_CHANGED', 'Clicking Create did not start the captcha check',
          'no POST /api/c/check observed after the Create click');

      let reclicks = 0;
      let lastProgress = 0;
      let lastSubmit = 0;

      while (!controller.signal.aborted) {
        const challengeFrame = await findChallengeFrame(page).catch(() => null);
        const visible = Boolean(challengeFrame);
        if (Date.now() - lastProgress > 10_000) {
          lastProgress = Date.now();
          log(`Waiting for the challenge (hcaptcha frames=${page.frames().filter(f => /hcaptcha/i.test(f.url())).length}, challenge visible=${visible})`);
        }
        if (!visible) {
          // The challenge window closes on inactivity: re-trigger it a bounded number of times.
          if (lastSubmit && Date.now() - lastSubmit > 12_000 && reclicks < MAX_CREATE_RECLICKS) {
            reclicks++; lastSubmit = Date.now();
            await click(button).catch(() => {});
          }
          await sleepAbortable(500, controller.signal);
          continue;
        }

        const challenge = challengeFrame!.locator('.challenge-container');
        if (solverRequests >= MAX_SOLVER_REQUESTS)
          throw new CaptchaFlowError('CAPTCHA_SOLVER_FAILED', `Solver did not produce a valid answer in ${MAX_SOLVER_REQUESTS} requests`);

        await waitForHcaptchaQuiet(page, controller.signal);
        if (controller.signal.aborted) break;
        const drag = (await challenge.locator('.prompt-text').first().innerText({ timeout: remaining(5000) }))
          .toLowerCase().includes('drag');

        solverRequests++;
        log('Sending the CAPTCHA to 2Captcha');
        const payload: any = {
          body: (await challenge.screenshot({ timeout: remaining(5000) })).toString('base64'),
          lang: deps.locale
        };
        if (drag) {
          payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
          if (deps.readDragInstructions) payload.imginstructions = await deps.readDragInstructions();
        }
        let solution: { id: string; data: Array<{ x: number | string; y: number | string }> };
        try {
          solution = await deps.solver!.coordinates(payload);
        } catch (err) {
          throw new CaptchaFlowError('CAPTCHA_SOLVER_FAILED', 'Solver request failed', err);
        }
        if (!Array.isArray(solution?.data) || solution.data.length === 0)
          throw new CaptchaFlowError('CAPTCHA_SOLVER_FAILED', 'Solver returned no coordinates');
        if (controller.signal.aborted) break;

        if (drag) {
          const box = await challenge.boundingBox();
          if (!box) throw new CaptchaFlowError('CAPTCHA_UI_CHANGED', 'Captcha challenge has no bounding box');
          if (solution.data.length % 2) {
            log('Solution does not have an even amount of points; requesting a new one');
            try { await deps.solver!.badReport(solution.id); } catch { /* best effort */ }
            continue;
          }
          for (let i = 0; i < solution.data.length; i += 2) {
            const a = solution.data[i], b = solution.data[i + 1];
            await page.mouse.move(box.x + +a.x, box.y + +a.y);
            await page.mouse.down();
            await sleepAbortable(1100, controller.signal);
            await page.mouse.move(box.x + +b.x, box.y + +b.y, { steps: 30 });
            await page.mouse.up();
          }
        } else {
          for (const point of solution.data)
            await click(challenge, { x: +point.x, y: +point.y });
        }
        await click(challengeFrame!.locator('.button-submit')).catch(() => {});
        lastSubmit = Date.now();
        await sleepAbortable(4000, controller.signal);
      }
    })().catch(fail);

    return await outcome.promise;
  } catch (error) {
    if (!settled) fail(error);
    // Re-throw whatever settled the outcome first (launch failures included).
    return await outcome.promise;
  } finally {
    clearTimeout(timer);
    controller.abort();
    const toClose = context;
    if (toClose) {
      const browser = toClose.browser();
      await withTimeout(toClose.close().catch(() => {}), 5000);
      if (browser) await withTimeout(browser.close().catch(() => {}), 5000);
    }
    await withTimeout(driver, 3000);
  }
}
