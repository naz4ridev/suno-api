import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import * as flow from '../src/lib/captchaFlow.ts';

// Real Chromium against a local fixture that mirrors the current suno.com/create markup
// (Simple/Advanced tabs, unlabeled emotion textarea, button[aria-label="Create song"]).
// No Suno, no 2Captcha, no cookies: the solver is a stub and the "upstream" is a counter.

function findChromium() {
  if (process.env.CAPTCHA_TEST_CHROMIUM) return process.env.CAPTCHA_TEST_CHROMIUM;
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cache)) return null;
  const dirs = readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse();
  for (const d of dirs) {
    const base = path.join(cache, d);
    for (const sub of readdirSync(base)) {
      const exe = path.join(base, sub, 'chrome-headless-shell');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}
const executablePath = findChromium();
const skip = executablePath ? false : 'no local chromium available';

const FAKE_TOKEN = 'P1_' + 'a1B2c3D4'.repeat(8);
const FAKE_BEARER = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';

const iframeDoc = `<div class="challenge-container" style="width:200px;height:120px;background:#ddd"><div class="prompt-text">Please click on the cat</div></div><button class="button-submit" onclick="parent.postMessage('solved','*')">Verify</button>`;
const generatePost = `fetch('/api/generate/v2-web/', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ${FAKE_BEARER}' }, body: JSON.stringify({ token: TOKEN, prompt: 'x' }) }).catch(() => {});`;

function page(variant) {
  const modern = variant !== 'legacy';
  const textarea = variant === 'broken' ? '' : modern
    ? '<textarea class="css-1saxq8q etwdol2"></textarea>'
    : '<textarea class="custom-textarea"></textarea>';
  const label = modern ? 'Create song' : 'Create';
  const afterCheck = {
    token: `TOKEN=${JSON.stringify(FAKE_TOKEN)}; ${generatePost}`,
    legacy: `TOKEN=${JSON.stringify(FAKE_TOKEN)}; ${generatePost}`,
    advanced: `TOKEN=${JSON.stringify(FAKE_TOKEN)}; ${generatePost}`,
    dialog: `TOKEN=${JSON.stringify(FAKE_TOKEN)}; ${generatePost}`,
    turnstile: `TOKEN=${JSON.stringify(FAKE_TOKEN)}; ${generatePost}`,
    notoken: `TOKEN=null; ${generatePost}`,
    silent: '',
    onload: '',
    captcha: `document.getElementById('hc').style.display='block'`,
    broken: ''
  }[variant];
  const check = variant === 'nocheck' ? '' : `fetch('/api/c/check', { method: 'POST' }).then(() => { ${afterCheck} });`;
  const advanced = variant === 'advanced';
  const dialog = variant === 'dialog';
  return `<!doctype html><title>create</title>
<div role="tablist"><button role="tab" id="t-simple" aria-selected="${advanced ? 'false' : 'true'}" onclick="sw(true)">Simple</button><button role="tab" id="t-adv" aria-selected="${advanced ? 'true' : 'false'}" onclick="sw(false)">Advanced</button></div>
${dialog ? '<div role="dialog"><p>Create your own lyricist</p><button onclick="this.parentElement.remove(); document.getElementById(\'go\').disabled = false">Got it</button></div>' : ''}
<form id="simple" onsubmit="return false"><button type="button" aria-label="Clear all form inputs" disabled></button>
<div id="adv" style="display:${advanced ? 'block' : 'none'}"><textarea aria-label="Cowriter prompt"></textarea><textarea aria-label="Styles"></textarea></div>
<div id="simple-box" style="display:${advanced ? 'none' : 'block'}">${textarea}</div>
<button id="go" type="button" aria-label="${label}" ${dialog || advanced ? 'disabled' : ''} onclick="${check.replace(/"/g, '&quot;')}"><div class="flex">Create</div></button></form>
<iframe id="hc" title="hCaptcha challenge" style="display:none" srcdoc="${iframeDoc.replace(/"/g, '&quot;')}"></iframe>
<script>
function sw(simple) {
  document.getElementById('simple-box').style.display = simple ? 'block' : 'none';
  document.getElementById('adv').style.display = simple ? 'none' : 'block';
  document.getElementById('go').disabled = !simple;
  document.getElementById('t-simple').setAttribute('aria-selected', String(simple));
  document.getElementById('t-adv').setAttribute('aria-selected', String(!simple));
}
window.addEventListener('message', e => { if (e.data === 'solved') { var TOKEN=${JSON.stringify(FAKE_TOKEN)}; ${generatePost} } });
${variant === 'onload' ? `var TOKEN=null; ${generatePost}` : ''}
${variant === 'turnstile' ? "fetch('https://challenges.cloudflare.com/turnstile/v0/api.js').catch(() => fetch('/turnstile-blocked'));" : ''}
</script>`;
}

async function withFixture(fn) {
  const hits = [];
  const misc = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/c/check') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"required":true,"captcha_version":2}');
      return;
    }
    if (url.pathname === '/turnstile-blocked') {
      misc.push('turnstile-blocked');
      res.writeHead(200).end('ok');
      return;
    }
    if (url.pathname.startsWith('/api/generate')) {
      hits.push(`${req.method} ${url.pathname}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"clips":[]}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(page(url.searchParams.get('v') || 'token'));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/create`;
  try { return await fn({ base, hits, misc }); }
  finally { await new Promise(r => server.close(r)); }
}

function harness(overrides = {}) {
  const state = { browser: null, launched: 0, solved: 0, logs: [] };
  const solver = overrides.solver === undefined ? {
    coordinates: async () => { state.solved++; return { id: 'job-1', data: [{ x: 40, y: 40 }] }; },
    badReport: () => {}
  } : overrides.solver;
  return {
    state,
    deps: {
      launchContext: overrides.launchContext ?? (async () => {
        state.launched++;
        state.browser = await chromium.launch({ headless: true, executablePath });
        return state.browser.newContext({ serviceWorkers: 'block' });
      }),
      solver,
      log: m => state.logs.push(m),
      uiTimeoutMs: 2500,
      totalTimeoutMs: 20_000,
      ...overrides.deps
    }
  };
}

const rejectsWith = async (promise, code) => {
  const error = await promise.then(() => null, e => e);
  assert.ok(error, `expected ${code} but the flow resolved`);
  assert.equal(error.code, code, error.message);
  assert.equal(error.submitted, false);
  assert.equal(error.stage, 'before_generate_post');
  assert.equal(error.category, 'captcha');
  assert.ok(flow.isCaptchaFlowError(error));
  return error;
};

test('current UI selectors: token is captured and the generation POST is aborted', { skip }, async () => {
  await withFixture(async ({ base, hits }) => {
    const { deps, state } = harness({ deps: {} });
    deps.url = `${base}?v=token`;
    const result = await flow.acquireGenerationCaptchaToken(deps);
    assert.equal(result.token, FAKE_TOKEN);
    assert.equal(result.authorization, FAKE_BEARER);
    assert.equal(result.abortedGenerateRequests, 1);
    assert.equal(result.solverRequests, 0);
    assert.deepEqual(hits, [], 'no request may reach /api/generate upstream');
    assert.equal(state.browser.isConnected(), false, 'browser must be closed');
  });
});

test('legacy .custom-textarea markup still works as a fallback', { skip }, async () => {
  await withFixture(async ({ base, hits }) => {
    const { deps, state } = harness();
    deps.url = `${base}?v=legacy`;
    assert.equal((await flow.acquireGenerationCaptchaToken(deps)).token, FAKE_TOKEN);
    assert.deepEqual(hits, []);
    assert.equal(state.browser.isConnected(), false);
  });
});

test('hCaptcha challenge: solver is used once, token returned, POST still aborted', { skip }, async () => {
  await withFixture(async ({ base, hits }) => {
    const { deps, state } = harness();
    deps.url = `${base}?v=captcha`;
    const result = await flow.acquireGenerationCaptchaToken(deps);
    assert.equal(result.token, FAKE_TOKEN);
    assert.equal(result.solverRequests, 1);
    assert.equal(state.solved, 1);
    assert.deepEqual(hits, []);
    assert.equal(state.browser.isConnected(), false);
  });
});

test('interceptor is registered first: a generation POST fired on page load never reaches upstream', { skip }, async () => {
  await withFixture(async ({ base, hits }) => {
    const { deps, state } = harness();
    deps.url = `${base}?v=onload`;
    const error = await rejectsWith(flow.acquireGenerationCaptchaToken(deps), 'CAPTCHA_TOKEN_MISSING');
    assert.equal(error.retryable, true);
    assert.deepEqual(hits, []);
    assert.equal(state.browser.isConnected(), false);
  });
});

test('generation request without a token is aborted and reported, not treated as success', { skip }, async () => {
  await withFixture(async ({ base, hits }) => {
    const { deps } = harness();
    deps.url = `${base}?v=notoken`;
    await rejectsWith(flow.acquireGenerationCaptchaToken(deps), 'CAPTCHA_TOKEN_MISSING');
    assert.deepEqual(hits, []);
  });
});

test('missing selectors: structured CAPTCHA_UI_CHANGED, nothing submitted, Chromium closed', { skip }, async () => {
  await withFixture(async ({ base, hits }) => {
    const { deps, state } = harness();
    deps.url = `${base}?v=broken`;
    const error = await rejectsWith(flow.acquireGenerationCaptchaToken(deps), 'CAPTCHA_UI_CHANGED');
    assert.equal(error.retryable, false);
    assert.match(error.detail, /selectors=/);
    assert.deepEqual(hits, []);
    assert.equal(state.browser.isConnected(), false);
  });
});

test('total timeout is finite and cleans the browser when nothing ever happens', { skip }, async () => {
  await withFixture(async ({ base, hits }) => {
    const { deps, state } = harness({ deps: { totalTimeoutMs: 3000, uiTimeoutMs: 2000 } });
    deps.url = `${base}?v=silent`;
    const started = Date.now();
    const error = await rejectsWith(flow.acquireGenerationCaptchaToken(deps), 'CAPTCHA_TIMEOUT');
    assert.ok(Date.now() - started < 12_000, 'must return shortly after the deadline');
    assert.equal(error.retryable, true);
    assert.deepEqual(hits, []);
    assert.equal(state.browser.isConnected(), false);
  });
});

test('no solver key: CAPTCHA_INTERACTION_REQUIRED before any browser is launched', { skip }, async () => {
  const { deps, state } = harness({ solver: null });
  deps.url = 'http://127.0.0.1:9/never';
  const error = await rejectsWith(flow.acquireGenerationCaptchaToken(deps), 'CAPTCHA_INTERACTION_REQUIRED');
  assert.equal(error.retryable, false);
  assert.equal(state.launched, 0);
});

test('solver failure: structured error, bounded paid requests, secrets redacted, browser closed', { skip }, async () => {
  await withFixture(async ({ base, hits }) => {
    let calls = 0;
    const { deps, state } = harness({ solver: {
      coordinates: async () => { calls++; throw new Error(`2captcha said no Authorization: Bearer ${FAKE_BEARER} token ${FAKE_TOKEN}`); },
      badReport: () => {}
    } });
    deps.url = `${base}?v=captcha`;
    const error = await rejectsWith(flow.acquireGenerationCaptchaToken(deps), 'CAPTCHA_SOLVER_FAILED');
    assert.equal(calls, 1, 'a failing solver must not be hammered');
    const text = JSON.stringify({ m: error.message, d: error.detail });
    assert.ok(!text.includes(FAKE_BEARER) && !text.includes(FAKE_TOKEN) && !text.includes('eyJ'), text);
    assert.deepEqual(hits, []);
    assert.equal(state.browser.isConnected(), false);
  });
});

test('browser launch failure becomes CAPTCHA_BROWSER_FAILED without leaking the cause', { skip: false }, async () => {
  const { deps } = harness({ launchContext: async () => { throw new Error(`spawn failed Bearer ${FAKE_BEARER}`); } });
  const error = await rejectsWith(flow.acquireGenerationCaptchaToken(deps), 'CAPTCHA_BROWSER_FAILED');
  assert.ok(!JSON.stringify([error.message, error.detail]).includes(FAKE_BEARER));
});


test('Advanced variant (several textareas, Create disabled) is switched to Simple before typing', { skip }, async () => {
  await withFixture(async ({ base, hits }) => {
    const { deps, state } = harness();
    deps.url = `${base}?v=advanced`;
    assert.equal((await flow.acquireGenerationCaptchaToken(deps)).token, FAKE_TOKEN);
    assert.deepEqual(hits, []);
    assert.equal(state.browser.isConnected(), false);
  });
});

test('a blocking dialog ("Got it") is dismissed so Create becomes enabled', { skip }, async () => {
  await withFixture(async ({ base, hits }) => {
    const { deps } = harness();
    deps.url = `${base}?v=dialog`;
    assert.equal((await flow.acquireGenerationCaptchaToken(deps)).token, FAKE_TOKEN);
    assert.deepEqual(hits, []);
  });
});

test('Turnstile script is blocked in the captcha browser so the app falls back to hCaptcha', { skip }, async () => {
  await withFixture(async ({ base, misc }) => {
    const { deps } = harness();
    deps.url = `${base}?v=turnstile`;
    await flow.acquireGenerationCaptchaToken(deps);
    assert.deepEqual(misc, ['turnstile-blocked']);
  });
});

test('a Create click that never reaches /api/c/check is reported as CAPTCHA_UI_CHANGED (nothing submitted)', { skip }, async () => {
  await withFixture(async ({ base, hits }) => {
    const { deps, state } = harness({ deps: { triggerTimeoutMs: 800 } });
    deps.url = `${base}?v=nocheck`;
    const error = await rejectsWith(flow.acquireGenerationCaptchaToken(deps), 'CAPTCHA_UI_CHANGED');
    assert.match(error.detail, /c\/check/);
    assert.deepEqual(hits, []);
    assert.equal(state.browser.isConnected(), false);
  });
});

test('hCaptcha challenge is found through page.frames() even when it is not reachable by DOM selectors', { skip }, async () => {
  await withFixture(async ({ base }) => {
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const page = await browser.newPage();
      await page.goto(`${base}?v=captcha`);
      assert.equal(await flow.findChallengeFrame(page), null, 'hidden iframe is not a visible challenge');
      await page.evaluate(() => { document.getElementById('hc').style.display = 'block'; });
      const frame = await flow.findChallengeFrame(page);
      assert.ok(frame, 'visible challenge frame must be found by title');
      assert.match(await frame.locator('.prompt-text').innerText(), /cat/);
    } finally { await browser.close(); }
  });
});

test('redactSecrets removes bearer tokens, JWTs, hCaptcha tokens, cookies and signed URL parts', () => {
  const dirty = `Bearer ${FAKE_BEARER} ${FAKE_TOKEN} __client=abc.def cookie: sid=1 https://x/y?X-Amz-Signature=deadbeef&a=1`;
  const clean = flow.redactSecrets(dirty);
  for (const secret of [FAKE_BEARER, FAKE_TOKEN, 'abc.def', 'deadbeef'])
    assert.ok(!clean.includes(secret), clean);
});

test('GENERATE_REQUEST_PATTERN covers every generation endpoint and nothing else', () => {
  for (const url of ['https://studio-api-prod.suno.com/api/generate/v2-web/', 'https://x/api/generate/v2/', 'https://x/api/generate/lyrics/', 'https://x/api/generate'])
    assert.ok(flow.GENERATE_REQUEST_PATTERN.test(url), url);
  for (const url of ['https://x/api/c/check', 'https://x/api/project/default?x=1', 'https://x/api/generated/foo'])
    assert.ok(!flow.GENERATE_REQUEST_PATTERN.test(url), url);
});

test('errorResponse exposes the public captcha fields so clients know nothing was submitted', async () => {
  const nodeRequire = createRequire(import.meta.url);
  const source = readFileSync(new URL('../src/lib/utils.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const sandbox = { exports: {} };
  vm.runInNewContext(output, { exports: sandbox.exports, process, console, setTimeout, clearTimeout, Response, require: name => (name === 'rebrowser-playwright-core' ? {} : nodeRequire(name)) });
  const error = new flow.CaptchaFlowError('CAPTCHA_UI_CHANGED', 'Create button not found');
  const response = sandbox.exports.errorResponse(error);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'CAPTCHA_UI_CHANGED');
  assert.equal(body.submitted, false);
  assert.equal(body.stage, 'before_generate_post');
  assert.equal(body.error_type, 'captcha_failed_before_post');
  assert.equal(body.category, 'captcha');
  assert.equal(body.retryable, false);
});


test('a context that finishes launching after the total deadline is closed without opening a page', async () => {
  let resolveLaunch;
  const launch = new Promise(resolve => { resolveLaunch = resolve; });
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let contextClosed = false;
  const browser = { close: async () => { resolveClosed(); } };
  const lateContext = { browser: () => browser, close: async () => { contextClosed = true; },
    newPage: () => assert.fail('a late browser must never open a page') };
  const { deps } = harness({ launchContext: () => launch, deps: { totalTimeoutMs: 30 } });
  await rejectsWith(flow.acquireGenerationCaptchaToken(deps), 'CAPTCHA_TIMEOUT');
  resolveLaunch(lateContext);
  await closed;
  assert.equal(contextClosed, true);
});
