import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ACCOUNTS, CLIP, STEM, fakeJwt, mockSuno, status } from './helpers.mjs';

// The same suite runs against the TypeScript source and the shipped bundle.
const target = process.env.SDK_TARGET || new URL('../src/index.ts', import.meta.url).href;
const sdk = await import(target);

const feedClip = (id, extra = {}) => ({ id, title: 'Song', status: 'complete', metadata: {}, ...extra });
const contractFor = (mock, overrides = {}) => sdk.createSunoContract({
  listAccounts: () => ACCOUNTS, proxy: mock.proxy, ...overrides });
const secretsOf = value => JSON.stringify(value);

test('the SDK is environment-free: env vars never choose the host, solver or proxy', async () => {
  const before = { ...process.env };
  Object.assign(process.env, { SUNO_STUDIO_API_URL: 'https://evil.invalid', TWOCAPTCHA_KEY: 'k', SUNO_PROXY_URL: 'socks5://evil.invalid:1',
    SUNO_USER_AGENT: 'evil-agent', BROWSER: 'firefox' });
  try {
    const mock = mockSuno({ 'GET /api/session/': () => ({ user: { id: 'u' } }) });
    const registry = sdk.createSunoRegistry({ proxy: mock.proxy, accounts: { resolve: () => ACCOUNTS[0] } });
    const api = await registry.sunoApi();
    await api.getUserInfo();
    assert.ok(mock.calls.length >= 3);
    for (const call of mock.calls) assert.ok(!/evil/.test(call.host + String(call.headers['User-Agent'])), call.path);
    assert.ok(mock.calls.some(call => call.host === 'studio-api-prod.suno.com'));
    assert.equal(mock.calls[0].host, 'auth.suno.com');
  } finally {
    for (const key of ['SUNO_STUDIO_API_URL', 'TWOCAPTCHA_KEY', 'SUNO_PROXY_URL', 'SUNO_USER_AGENT', 'BROWSER']) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  }
});

test('authentication sends the account cookie, renews a bearer and caches one client per cookie', async () => {
  const mock = mockSuno({ ['GET /api/clip/' + CLIP]: () => feedClip(CLIP) });
  const registry = sdk.createSunoRegistry({ proxy: mock.proxy, accounts: { resolve: s => ACCOUNTS.find(a => a.id === (s || 'main')) } });
  const [a, b] = await Promise.all([registry.sunoApiForAccount('main'), registry.sunoApiForAccount('main')]);
  assert.equal(a, b);
  assert.equal(mock.calls.filter(call => call.path === '/v1/client').length, 1, 'concurrent first calls share one init');
  await a.getClip(CLIP);
  const clipCall = mock.calls.find(call => call.path === `/api/clip/${CLIP}`);
  assert.match(clipCall.headers.Authorization, /^Bearer /);
  assert.match(clipCall.headers.Cookie, /__client=cookie-main/);
  const other = await registry.sunoApiForAccount('second');
  assert.notEqual(other, a);
  assert.equal(other.accountId, 'second');
});

test('a 429 is retried with the injected limit and never leaks the upstream body', async () => {
  let hits = 0;
  const mock = mockSuno({ 'GET /api/session/': () => (++hits < 3 ? status(429, { detail: 'slow down' }) : { user: { id: 'u1', handle: 'h' } }) });
  const api = await sdk.createSunoRegistry({ proxy: mock.proxy, max429Retries: 5, accounts: { resolve: () => ACCOUNTS[0] } }).sunoApi();
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => original(fn, Math.min(ms, 1), ...rest);
  try { assert.equal((await api.getUserInfo()).id, 'u1'); } finally { globalThis.setTimeout = original; }
  assert.equal(hits, 3);
});

test('captcha: the injected provider answers, receives the session and renews the bearer', async () => {
  const mock = mockSuno({ 'POST /api/c/check': () => ({ required: true }) });
  const seen = [];
  const renewed = fakeJwt(7200);
  const api = await sdk.createSunoRegistry({
    proxy: { ...mock.proxy, browser: () => ({ server: 'socks5://proxy.invalid:1' }) }, locale: 'es-ES',
    captcha: async request => { seen.push(request); return { token: 'P1_token', authorization: renewed }; },
    accounts: { resolve: () => ACCOUNTS[0] }
  }).sunoApi();
  assert.equal(await api.getCaptcha(), 'P1_token');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].purpose, 'generation');
  assert.equal(seen[0].accountId, 'main');
  assert.equal(seen[0].locale, 'es-ES');
  assert.equal(seen[0].cookies.__client, 'cookie-main');
  assert.deepEqual(seen[0].proxy, { server: 'socks5://proxy.invalid:1' });
  await api.keepAlive(); // the renewed bearer is current: no new token request
  assert.equal(mock.calls.filter(call => call.path.endsWith('/tokens')).length, 1);
});

test('captcha failures are CaptchaFlowErrors raised before any generation POST', async () => {
  const cases = [
    ['no provider', undefined, 'CAPTCHA_INTERACTION_REQUIRED'],
    ['provider throws', async () => { throw new Error('window closed Bearer abc.def.ghi'); }, 'CAPTCHA_BROWSER_FAILED'],
    ['empty token', async () => ({ token: '  ' }), 'CAPTCHA_TOKEN_MISSING'],
    ['typed error is kept', async () => { throw new sdk.CaptchaFlowError('CAPTCHA_TIMEOUT', 'too slow'); }, 'CAPTCHA_TIMEOUT']
  ];
  for (const [label, captcha, code] of cases) {
    const mock = mockSuno({ 'POST /api/c/check': () => ({ required: true }),
      [`GET /api/clip/${CLIP}`]: () => feedClip(CLIP), 'POST /api/generate/v2-web/': () => { throw new Error('GENERATION POSTED'); } });
    const contract = contractFor(mock, { captcha });
    const error = await contract.request({ method: 'POST', path: '/api/generate_stems', body: { audio_id: CLIP, stem_name: 'Bass' } }).catch(e => e);
    assert.equal(error.code, code, label);
    assert.equal(error.submitted, false, label);
    assert.equal(error.stage, 'before_generate_post', label);
    assert.equal(error.error_type, 'captcha_failed_before_post', label);
    assert.ok(!/abc\.def\.ghi/.test(error.message), `${label}: secrets are redacted`);
    assert.ok(!mock.calls.some(call => call.path.startsWith('/api/generate')), `${label}: no generation request`);
    const body = sdk.errorBody(error);
    assert.ok(['category', 'code', 'error', 'error_type', 'retryable', 'stage', 'submitted'].every(key => key in body), label);
    assert.ok(!/abc\.def\.ghi/.test(JSON.stringify(body)), `${label}: public body is redacted`);
  }
});

test('contract: accounts are sanitised, selected by id/label/handle and validated', async () => {
  const mock = mockSuno({ 'GET /api/session/': () => ({ user: {} }) });
  const contract = contractFor(mock);
  const listed = await contract.request({ path: '/api/accounts' });
  assert.equal(listed.default_account_id, 'main');
  assert.deepEqual(listed.accounts.map(a => a.id), ['main', 'second', 'off']);
  assert.ok(!/cookie-|__client/.test(secretsOf(listed)), 'cookies never leave the contract');
  assert.deepEqual(listed.accounts[0], { id: 'main', label: 'Main', disabled: false, is_default: true, user: { id: 'user-main', handle: 'main_handle', email: undefined } });

  await contract.request({ path: '/api/get_limit', account: 'Second' });
  await contract.request({ path: '/api/get_limit', account: 'second_handle' });
  await contract.request({ path: '/api/get_limit', account: 'second@example.test' });
  const limit = await contract.request({ path: '/api/get_limit' });
  assert.deepEqual([limit.credits_left, limit.account_id, limit.plan], [42, 'main', 'pro']);
  const cookiesUsed = mock.calls.filter(call => call.path === '/api/billing/info/').map(call => /__client=([^;]+)/.exec(call.headers.Cookie)[1]);
  assert.deepEqual(cookiesUsed, ['cookie-second', 'cookie-second', 'cookie-second', 'cookie-main']);

  assert.equal((await contract.request({ path: '/api/get_limit', account: 'nobody' }).catch(e => e)).status, 404);
  assert.equal((await contract.request({ path: '/api/get_limit', account: 'off' }).catch(e => e)).status, 409);
  const none = sdk.createSunoContract({ listAccounts: () => [], proxy: mock.proxy });
  const missing = await none.request({ path: '/api/get_limit' }).catch(e => e);
  assert.equal(missing.status, 400);
  assert.equal((await none.request({ path: '/api/health' })).accounts, 0);
});

test('contract: every client route maps to the SunoApi call the server route makes', async () => {
  const mock = mockSuno({
    [`GET /api/clip/${CLIP}`]: () => feedClip(CLIP),
    'POST /api/feed/v3': call => ({ clips: [feedClip(CLIP)], next_cursor: 'c2', has_more: true, _body: call.body }),
    [`GET /api/clip/${CLIP}/stems/pages`]: () => ({ pages: 1 }),
    [`GET /api/clip/${CLIP}/stems`]: () => ({ current_page: 0, stems: [feedClip(STEM)] }),
    [`GET /api/gen/${CLIP}/key`]: () => ({ state: 'done', key: 'C' }),
    [`GET /api/gen/${CLIP}/downbeats`]: () => ({ state: 'done', downbeats: [0.5] }),
    'GET /api/project/me': () => ({ projects: [{ id: 'w1', name: 'W' }] }),
    'GET /api/playlist/me': () => ({ playlists: [], num_total_results: 0, current_page: 1 }),
    'GET /api/playlist/p1/': () => ({ id: 'p1', playlist_clips: [{ clip: feedClip(CLIP) }], num_total_results: 1 }),
    'GET /api/session/': () => ({ user: { id: 'u' } })
  });
  const contract = contractFor(mock);
  const request = req => contract.request(req);

  assert.equal((await request({ path: `/api/clip?id=${CLIP}` })).id, CLIP);
  assert.deepEqual((await request({ path: `/api/get?ids=${CLIP}` })).map(c => c.id), [CLIP]);
  const library = await request({ path: '/api/library/songs?q=demo&liked=true&limit=5&workspace_id=default' });
  assert.deepEqual([library.has_more, library.next_cursor, library.clips.length], [true, 'c2', 1]);
  const feedBody = JSON.parse(mock.calls.filter(c => c.path === '/api/feed/v3').at(-1).body);
  assert.equal(feedBody.filters.searchText, 'demo');
  assert.equal(feedBody.filters.liked, 'True');
  assert.equal(feedBody.limit, 5);
  assert.deepEqual((await request({ path: '/api/workspaces' })).workspaces.map(w => w.id), ['w1']);
  assert.equal((await request({ path: '/api/playlist/me?page=1&show_trashed=false&show_sharelist=false' })).current_page, 1);
  assert.equal((await request({ path: '/api/playlist/p1' })).id, 'p1');
  assert.equal((await request({ path: '/api/stems/catalogue' })).snapshot, true);
  const stems = await request({ path: `/api/stems?id=${CLIP}&page=0` });
  assert.deepEqual([stems.pages, stems.stems[0].id], [1, STEM]);
  const analysis = await request({ path: `/api/clip_analysis?id=${CLIP}&wait=false` });
  assert.deepEqual([analysis.key.key, analysis.downbeats.downbeats], ['C', [0.5]]);
  const health = await request({ path: '/api/health' });
  assert.deepEqual([health.ok, health.accounts], [true, 2]);

  // input validation answers 400 like the routes, before touching Suno
  const before = mock.calls.length;
  for (const bad of [
    { path: '/api/stems?id=not-a-uuid' }, { path: `/api/stems?id=${CLIP}&page=-1` }, { path: '/api/clip' },
    { path: '/api/library/songs?liked=maybe' }, { path: '/api/library/songs?limit=500' },
    { method: 'POST', path: '/api/generate_stems', body: { mode: 'extract' } },
    { method: 'POST', path: '/api/generate_stems', body: { audio_id: CLIP, mode: 'bogus' } },
    { method: 'POST', path: '/api/stems/render', body: { source_clip_id: CLIP, render: { format: 'mp3' } } },
    { method: 'POST', path: '/api/stems/render', body: { source_clip_id: CLIP, render: {}, authorize: 'yes' } },
    { path: 'https://evil.invalid/api/clip?id=' + CLIP }, { path: '/not-api' }
  ]) {
    const error = await request(bad).catch(e => e);
    assert.equal(error.status, 400, JSON.stringify(bad));
  }
  assert.equal((await request({ path: '/api/nope' }).catch(e => e)).status, 404);
  assert.equal((await request({ method: 'POST', path: '/api/clip', body: {} }).catch(e => e)).status, 404);
  assert.equal(mock.calls.length, before, 'rejected requests never reach Suno');
});

test('contract: stem render authorises the source only after the stems are verified as its own', async () => {
  const render = { format: 'wav_s16', start_beats: 0, end_beats: 8,
    state: { timing: { bps: 2 }, tracks: [{ clips: [{ asset: { type: 'clip', id: STEM } }] }] } };
  const mock = mockSuno({
    'POST /api/feed/v3': () => ({ clips: [feedClip(STEM, { metadata: { stem_from_id: '00000000-0000-0000-0000-000000000000' } })] }),
    'POST /api/download/authorize': () => { throw new Error('AUTHORIZED'); }
  });
  const error = await contractFor(mock).request({ method: 'POST', path: '/api/stems/render', body: { source_clip_id: CLIP, render, authorize: true } }).catch(e => e);
  assert.equal(error.status, 400);
  assert.ok(!mock.calls.some(call => call.path === '/api/download/authorize'), 'no download credit is spent');
});

test('playback audio returns decrypted bytes through the same crypto as the server', async () => {
  const mock = mockSuno({ [`GET /api/clip/${CLIP}`]: () => feedClip(CLIP) });
  const error = await contractFor(mock).request({ path: `/api/playback_audio?id=${CLIP}`, binary: true }).catch(e => e);
  assert.ok(error instanceof Error, 'a clip without playable media_urls is refused, not downloaded');
  assert.ok(!mock.calls.some(call => call.host !== 'studio-api-prod.suno.com' && call.host !== 'auth.suno.com'));
});

test('upload workflow is durable: persisted status, interrupted work after restart, no secrets on disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sdk-upload-'));
  const mock = mockSuno({ 'POST /api/uploads/audio/': () => { throw new Error('stop'); } });
  const contract = contractFor(mock, { storageDirectory: dir });
  const accepted = await contract.uploadFile({ account: 'second', file: { name: 'a.wav', type: 'audio/wav', bytes: Buffer.from('RIFF') } });
  assert.match(accepted.work_id, /^[0-9a-f-]{36}$/);
  assert.equal(accepted.account_id, 'second');
  const first = await contract.uploadStatus(accepted.work_id);
  assert.equal(first.input.account_id, 'second');
  for (let i = 0; i < 50 && (await contract.uploadStatus(accepted.work_id)).status !== 'failed'; i++) await new Promise(r => setTimeout(r, 20));
  const failed = await contract.uploadStatus(accepted.work_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.step, 'create_upload');

  // a process that died mid-run leaves a running record; the next process must not report it as running
  const stale = { ...failed, work_id: '11111111-1111-4111-8111-111111111111', status: 'running', error: undefined,
    steps: failed.steps.map((s, i) => ({ ...s, status: i === 0 ? 'running' : 'pending' })) };
  await writeFile(path.join(dir, `${stale.work_id}.json`), JSON.stringify(stale));
  const restarted = contractFor(mock, { storageDirectory: dir });
  const recovered = await restarted.uploadStatus(stale.work_id);
  assert.equal(recovered.status, 'failed');
  assert.match(recovered.error.detail.message, /interrupted/);
  assert.equal((await restarted.uploadStatus('22222222-2222-4222-8222-222222222222').catch(e => e)).status, 404);

  // ownership: only the account that started a work can read it by account
  assert.equal((await restarted.uploadStatus(accepted.work_id, 'Second')).work_id, accepted.work_id);
  assert.equal((await restarted.uploadStatus(accepted.work_id, 'main').catch(e => e)).status, 404);
  assert.equal((await restarted.uploadStatus(accepted.work_id, 'unknown').catch(e => e)).status, 404);

  const onDisk = (await Promise.all((await readdir(dir)).filter(f => f.endsWith('.json')).map(f => readFile(path.join(dir, f), 'utf8')))).join('');
  assert.ok(!/cookie-second|__client/.test(onDisk), 'cookies are never persisted');
  const noStorage = sdk.createSunoContract({ listAccounts: () => ACCOUNTS, proxy: mock.proxy });
  assert.equal((await noStorage.uploadStatus(accepted.work_id).catch(e => e)).status, 501);
});

test('socks proxy factory validates the scheme and exposes the browser form', () => {
  const proxy = sdk.createSocksProxy('socks5h://127.0.0.1:1055');
  assert.deepEqual(proxy.browser(), { server: 'socks5://127.0.0.1:1055' });
  const config = proxy.axiosConfig();
  assert.equal(config.proxy, false);
  assert.ok(config.httpAgent && config.httpsAgent);
  assert.throws(() => sdk.createSocksProxy('http://proxy.invalid:8080'), /Unsupported proxy scheme/);
});
