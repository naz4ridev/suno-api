import yn from 'yn';
import { promises as fs } from 'fs';
import path from 'node:path';
import { Solver } from '@2captcha/captcha-solver';
import { BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import type { CaptchaProvider, CaptchaRequest, SunoLogger } from '@suno-sdk';
import { acquireGenerationCaptchaToken } from '@/lib/captchaFlow';
import { isPage } from '@/lib/utils';

/**
 * The server's captcha provider: headless Chromium (or Firefox) + 2Captcha, driven by environment
 * variables. This is the only place that knows about browsers and solvers; the SDK just calls it.
 *
 * Env: TWOCAPTCHA_KEY, BROWSER, BROWSER_HEADLESS, BROWSER_LOCALE, BROWSER_DISABLE_GPU,
 * BROWSER_GHOST_CURSOR, CAPTCHA_TIMEOUT_MS.
 */
export function createHeadlessCaptchaProvider(logger: SunoLogger, env: NodeJS.ProcessEnv = process.env): CaptchaProvider {
  let solver: Solver | undefined;

  return async (request: CaptchaRequest) => {
    const ghostCursorEnabled = yn(env.BROWSER_GHOST_CURSOR, { default: false });
    let cursor: Cursor | undefined;
    const solverKey = env.TWOCAPTCHA_KEY?.trim();
    if (solverKey) solver ??= new Solver(solverKey);

    /**
     * Clicks on a locator or XY vector. This method is made because of the difference between ghost-cursor-playwright and Playwright methods
     */
    const click = async (target: Locator | Page, position?: { x: number, y: number }): Promise<void> => {
      if (ghostCursorEnabled) {
        let pos: any = isPage(target) ? { x: 0, y: 0 } : await target.boundingBox();
        if (position)
          pos = {
            ...pos,
            x: pos.x + position.x,
            y: pos.y + position.y,
            width: null,
            height: null,
          };
        return cursor?.actions.click({
          target: pos
        });
      } else {
        if (isPage(target))
          return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
        else
          return target.click({ force: true, position });
      }
    };

    /**
     * Get the BrowserType from the `BROWSER` environment variable.
     * @returns {BrowserType} chromium, firefox or webkit. Default is chromium
     */
    const getBrowserType = () => {
      const browser = env.BROWSER?.toLowerCase();
      switch (browser) {
        case 'firefox':
          return firefox;
        /*case 'webkit': ** doesn't work with rebrowser-patches
        case 'safari':
          return webkit;*/
        default:
          return chromium;
      }
    };

    /**
     * Launches a browser with the necessary cookies
     * @returns {BrowserContext}
     */
    const launchBrowser = async (): Promise<BrowserContext> => {
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
      const proxy = request.proxy;
      if (proxy) // WebRTC does not go through the proxy: avoid leaking the server IP
        args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
      // Check for GPU acceleration, as it is recommended to turn it off for Docker
      if (yn(env.BROWSER_DISABLE_GPU, { default: false }))
        args.push('--enable-unsafe-swiftshader',
          '--disable-gpu',
          '--disable-setuid-sandbox');
      const browser = await getBrowserType().launch({
        args,
        headless: yn(env.BROWSER_HEADLESS, { default: true }),
        ...(proxy ? { proxy } : {})
      });
      try {
        const context = await browser.newContext({
          userAgent: request.userAgent, locale: env.BROWSER_LOCALE, viewport: null,
          serviceWorkers: 'block' // a service worker could bypass the generation interceptor
        });
        const cookies = [];
        const lax: 'Lax' | 'Strict' | 'None' = 'Lax';
        cookies.push({
          name: '__session',
          value: request.sessionToken + '',
          domain: '.suno.com',
          path: '/',
          sameSite: lax
        });
        for (const key in request.cookies) {
          cookies.push({
            name: key,
            value: request.cookies[key] + '',
            domain: '.suno.com',
            path: '/',
            sameSite: lax
          });
        }
        await context.addCookies(cookies);
        return context;
      } catch (error) {
        await browser.close().catch(() => {}); // never leave Chromium alive if the context cannot be prepared
        throw error;
      }
    };

    const result = await acquireGenerationCaptchaToken({
      launchContext: launchBrowser,
      solver: solverKey ? solver! : null,
      click,
      onPage: async page => {
        if (ghostCursorEnabled)
          cursor = await createCursor(page);
      },
      readDragInstructions: async () =>
        (await fs.readFile(path.join(process.cwd(), 'public', 'drag-instructions.jpg'))).toString('base64'),
      locale: env.BROWSER_LOCALE,
      totalTimeoutMs: Number(env.CAPTCHA_TIMEOUT_MS) > 0 ? Number(env.CAPTCHA_TIMEOUT_MS) : undefined,
      log: message => logger.info(message)
    });
    logger.info({ abortedGenerateRequests: result.abortedGenerateRequests, solverRequests: result.solverRequests },
      'hCaptcha token received; generation request aborted in the browser');
    return { token: result.token, ...(result.authorization ? { authorization: result.authorization } : {}) };
  };
}
