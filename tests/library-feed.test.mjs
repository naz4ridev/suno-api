import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import * as core from '../src/lib/vendor/suno-core.generated.js';
import * as feed from '../src/lib/libraryFeed.ts';

// Real SunoApi implementation with session, browser and network adapters replaced: no cookies or Suno calls.
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
    if (name === '@/lib/libraryFeed') return feed;
    if (name.startsWith('@/lib/')) return {};
    return nodeRequire(name);
  },
});

test('default scope is the default workspace and only live, non-stem songs are listed', () => {
  const request = feed.buildLibraryFeedRequest({});
  assert.deepEqual(request, { cursor: null, limit: 20, filters: {
    disliked: 'False', trashed: 'False', fromStudioProject: { presence: 'False' }, stem: { presence: 'False' },
    stemComplement: 'False', workspace: { presence: 'True', workspaceId: 'default' } } });
});

test('liked, search text, workspace and playlist map to the Suno web filter names', () => {
  const w = feed.buildLibraryFeedRequest({ workspaceId: 'abc-123', liked: true, searchText: '  night drive ', cursor: 'next', limit: 50 });
  assert.equal(w.filters.liked, 'True'); assert.equal(w.filters.searchText, 'night drive');
  assert.deepEqual(w.filters.workspace, { presence: 'True', workspaceId: 'abc-123' });
  assert.equal(w.filters.playlist, undefined); assert.equal(w.cursor, 'next'); assert.equal(w.limit, 50);
  const p = feed.buildLibraryFeedRequest({ playlistId: 'pl_1' });
  assert.deepEqual(p.filters.playlist, { presence: 'True', playlistId: 'pl_1' });
  assert.equal(p.filters.workspace, undefined);
  assert.equal('liked' in p.filters, false); assert.equal('searchText' in p.filters, false);
});

test('invalid library input is rejected with 400 before any Suno call', () => {
  const status = options => { try { feed.buildLibraryFeedRequest(options); return null; } catch (e) { return e.status; } };
  assert.equal(status({ workspaceId: 'a', playlistId: 'b' }), 400);
  assert.equal(status({ workspaceId: '../x' }), 400);
  assert.equal(status({ playlistId: 'a b' }), 400);
  assert.equal(status({ searchText: 'x'.repeat(201) }), 400);
  assert.equal(status({ limit: 0 }), 400);
  assert.equal(status({ limit: 51 }), 400);
  assert.equal(status({ limit: Number.NaN }), 400);
  assert.equal(status({ cursor: 'c'.repeat(3000) }), 400);
});

test('getLibraryFeed posts one read-only feed/v3 request and reports the next cursor', async () => {
  const api = Object.create(exports.TestApi.prototype); const calls = [];
  api.normalizeClip = clip => ({ ...clip, normalized: true });
  api.feedV3 = async payload => { calls.push(payload); return { clips: [{ id: 'a' }], next_cursor: 'abc', has_more: true }; };
  const plain = value => JSON.parse(JSON.stringify(value)); // objects built inside vm have another realm
  const page = plain(await api.getLibraryFeed({ liked: true, searchText: 'x' }));
  assert.deepEqual(page, { clips: [{ id: 'a', normalized: true }], has_more: true, next_cursor: 'abc' });
  assert.equal(calls.length, 1); assert.equal(calls[0].filters.liked, 'True');
  api.feedV3 = async () => ({ clips: [] });
  assert.deepEqual(plain(await api.getLibraryFeed({})), { clips: [], has_more: false, next_cursor: null });
  api.feedV3 = async () => ({ clips: [], next_cursor: 'zzz', has_more: false });
  assert.equal((await api.getLibraryFeed({})).has_more, false);
});
