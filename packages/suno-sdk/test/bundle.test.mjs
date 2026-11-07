import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSdk } from '../scripts/build.mjs';
import { ACCOUNTS, CLIP, fakeJwt } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await mkdtemp(path.join(os.tmpdir(), 'sdk-bundle-'));
const files = await buildSdk();
for (const [name, content] of files) await writeFile(path.join(out, name), content);
const bundleUrl = pathToFileURL(path.join(out, 'suno-sdk.generated.mjs')).href;

test('the build is reproducible and self-describing', async () => {
  const again = await buildSdk();
  for (const [name, content] of files) assert.equal(again.get(name), content, `${name} is deterministic`);
  const provenance = JSON.parse(files.get('PROVENANCE.json'));
  const sha = text => createHash('sha256').update(text).digest('hex');
  for (const [name, hash] of Object.entries(provenance.outputs)) assert.equal(sha(files.get(name)), hash, name);
  const source = JSON.parse(files.get('suno-sdk.source.json'));
  assert.ok(source.files['src/SunoApi.ts'] && source.files['src/contract.ts'], 'complete source is embedded');
  const header = /body-sha256: ([0-9a-f]{64})/.exec(files.get('suno-sdk.generated.mjs'))[1];
  assert.equal(header, sha(files.get('suno-sdk.generated.mjs').split(' */\n').slice(1).join(' */\n')));
});

test('the bundle carries no browser, solver, framework or desktop dependency', () => {
  const text = files.get('suno-sdk.generated.mjs');
  const specifiers = [...text.matchAll(/^import\s[^;]*?from\s*["']([^"']+)["']/gm), ...text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)]
    .map(match => match[1]);
  assert.ok(specifiers.length > 5);
  assert.deepEqual([...new Set(specifiers.filter(name => !isBuiltin(name) && name !== 'supports-color'))].sort(), [],
    'only Node builtins (and debug\'s optional supports-color probe) are imported');
  for (const forbidden of ['playwright', 'puppeteer', '2captcha', 'next/server', 'ghost-cursor', 'rebrowser'])
    assert.ok(!text.toLowerCase().includes(forbidden), forbidden);
  const names = JSON.parse(files.get('PROVENANCE.json')).dependencies.map(d => d.name);
  assert.ok(names.includes('axios') && names.includes('cookie'));
  assert.ok(files.get('THIRD_PARTY_NOTICES.txt').includes('axios@'));
  for (const dep of JSON.parse(files.get('PROVENANCE.json')).dependencies)
    assert.match(files.get('THIRD_PARTY_NOTICES.txt'), new RegExp(`${dep.name.replace('/', '\\/')}@${dep.version.replace(/\./g, '\\.')}`));
});

test('the shipped bundle passes the same suite as the TypeScript source', () => {
  const run = spawnSync(process.execPath, ['--test', path.join(root, 'test/sdk.test.mjs')],
    { env: { ...process.env, SDK_TARGET: bundleUrl }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('the bundled HTTP stack talks to a real server with cookie, bearer and proxy-free egress', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization, agent: req.headers['user-agent'] });
    const send = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/v1/client/sessions/')) return send({ jwt: fakeJwt() });
    if (req.url.startsWith('/v1/client')) return send({ response: { last_active_session_id: 'sess_1' } });
    if (req.url === `/api/clip/${CLIP}`) return send({ id: CLIP, status: 'complete', metadata: {} });
    res.statusCode = 404; send({ detail: 'nope' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const sdk = await import(bundleUrl);
    const contract = sdk.createSunoContract({ listAccounts: () => ACCOUNTS, baseUrl: base, authBaseUrl: base, userAgent: 'suno2daw-test' });
    assert.equal((await contract.request({ path: `/api/clip?id=${CLIP}` })).id, CLIP);
    const clip = seen.find(call => call.url === `/api/clip/${CLIP}`);
    assert.match(clip.cookie, /__client=cookie-main/);
    assert.match(clip.authorization, /^Bearer /);
    assert.equal(clip.agent, 'suno2daw-test');
    const missing = await contract.request({ path: `/api/clip?id=7390193c-678d-4453-bfb6-0b6b6c244e12` }).catch(e => e);
    assert.equal(missing.status, 404);
    assert.ok(!/cookie-main/.test(missing.message), 'upstream errors do not echo credentials');
  } finally { server.close(); }
});
