import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import * as core from '../src/lib/vendor/suno-core.generated.js';
import * as renderHelpers from '../src/lib/stemRender.ts';

// Load the real implementation with session, browser and network adapters replaced.
// No cookies, credentials or Suno calls are needed for these contract tests.
const nodeRequire = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/lib/SunoApi.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;
const exports = {};
vm.runInNewContext(output + '\nexports.TestApi = SunoApi;', {
  exports, global: {}, Buffer, URL, console, process, setTimeout, clearTimeout,
  require(name) {
    if (name === '@/lib/vendor/suno-core.generated') return core;
    if (name === '@/lib/stemRender') return renderHelpers;
    if (name.startsWith('@/lib/')) return {};
    return nodeRequire(name);
  },
});
const song = '8e3286fb-5046-4233-b478-af5b0d61f69f';
const stem = '7390193c-678d-4453-bfb6-0b6b6c244e12';
const native = () => ({ format: 'wav_s16', start_beats: -1, end_beats: 8,
  state: { timing: { bps: 2 }, tracks: [{ clips: [{ asset: { type: 'clip', id: stem } }] }] } });
function api() {
  const instance = Object.create(exports.TestApi.prototype);
  instance.keepAlive = async () => {};
  instance.url = path => path;
  return instance;
}

test('list existing stems handles empty, multiple pages and invalid page without mutation', async () => {
  const client = api(); const calls = [];
  client.client = { get: async (path, options) => {
    calls.push({ path, options });
    return { data: path.endsWith('/pages') ? { pages: 2 } : { current_page: 1, stems: [{ id: stem }] } };
  } };
  assert.equal((await client.listStems(song, 1)).stems[0].id, stem);
  assert.equal(calls[1].options.params.page, 1);
  await assert.rejects(client.listStems(song, 2), { status: 400 });
  await assert.rejects(client.listStems(song, -1), { status: 400 });
  client.client.get = async () => ({ data: { pages: 0 } });
  assert.equal((await client.listStems(song)).stems.length, 0);
});

test('native render checks stems, unlocks the root once, preserves timing, and then renders', async () => {
  const client = api(); const calls = []; const render = native();
  client.getFeedClipsByIds = async ids => {
    calls.push(['clips', ...ids]);
    return [{ id: stem, status: 'complete', metadata: { stem_from_id: song } }];
  };
  client.authorizeDownload = async (id, kind) => { calls.push(['unlock', id, kind]); return { ok: true }; };
  client.client = { post: async (path, body) => {
    calls.push(['render', path]);
    assert.equal(body.state, render.state);
    assert.equal(body.start_beats, -1);
    assert.equal(body.export_surface, 'stems_modal');
    return { data: { download_url: 'https://example.invalid/temporary' } };
  } };
  await client.renderStems(song, render, true);
  assert.deepEqual(calls.map(x => x[0]), ['clips', 'unlock', 'render']);
  assert.equal(calls[1][1], song);
  calls.length = 0;
  await client.renderStems(song, render);
  assert.deepEqual(calls.map(x => x[0]), ['clips', 'render']);
});

test('unrelated, streaming or denied stems never reach the render endpoint', async () => {
  const client = api(); let unlocks = 0; let posts = 0;
  client.authorizeDownload = async () => { unlocks++; return { ok: false }; };
  client.client = { post: async () => { posts++; return {}; } };
  client.getFeedClipsByIds = async () => [{ id: stem, status: 'streaming', metadata: { stem_from_id: song } }];
  await assert.rejects(client.renderStems(song, native(), true), { status: 400 });
  assert.equal(unlocks, 0);
  client.getFeedClipsByIds = async () => [{ id: stem, status: 'complete', metadata: { stem_from_id: stem } }];
  await assert.rejects(client.renderStems(song, native(), true), { status: 400 });
  assert.equal(unlocks, 0);
  client.getFeedClipsByIds = async () => [{ id: stem, status: 'complete', metadata: { stem_from_id: song } }];
  await assert.rejects(client.renderStems(song, native(), true), { status: 403 });
  assert.equal(unlocks, 1);
  assert.equal(posts, 0);
});

test('prefetch calls only the native preparation endpoint', async () => {
  const client = api(); const calls = [];
  client.client = { post: async path => { calls.push(path); return { data: { outcome: 'not_assigned' } }; } };
  assert.equal((await client.prefetchStems(song)).outcome, 'not_assigned');
  assert.deepEqual(calls, [`/api/clip/${song}/stems/prefetch`]);
  await assert.rejects(client.prefetchStems('../invalid'), { status: 400 });
  assert.equal(calls.length, 1);
});
