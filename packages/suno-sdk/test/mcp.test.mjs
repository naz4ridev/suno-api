import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

const target = process.env.SDK_TARGET || new URL('../src/index.ts', import.meta.url).href;
const sdk = await import(target);

/** A fake Suno OAuth + MCP server on localhost (MCP answers as SSE, like a Streamable HTTP server may). */
async function fakeSuno() {
  const state = { codes: new Map(), access: 'at-1', refreshes: 0, sessions: 0, calls: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://x');
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    state.calls.push(`${req.method} ${url.pathname}`);

    if (url.pathname === '/oauth/register/') return json(201, { client_id: 'dcr-1' });
    if (url.pathname === '/oauth/generate-code') {
      if (req.headers.authorization !== 'Bearer clerk-jwt') return json(401, { detail: 'bad session' });
      const body = JSON.parse(raw);
      state.codes.set('code-1', body.code_challenge);
      return json(200, { redirect_url: `${body.redirect_uri}?code=code-1&state=${body.state}` });
    }
    if (url.pathname === '/oauth/token/') {
      const form = new URLSearchParams(raw);
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = createHash('sha256').update(form.get('code_verifier')).digest('base64url');
        if (state.codes.get(form.get('code')) !== challenge) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: state.access, refresh_token: 'rt-1', expires_in: 3600, scope: 'api:v0' });
      }
      state.refreshes++;
      state.access = `at-${state.refreshes + 1}`;
      return json(200, { access_token: state.access, expires_in: 3600 });
    }
    if (url.pathname === '/mcp') {
      if (req.headers.authorization !== `Bearer ${state.access}`) return json(401, { error: 'sign in' });
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        state.sessions++;
        return json(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } }, { 'mcp-session-id': `s${state.sessions}` });
      }
      if (req.headers['mcp-session-id'] !== `s${state.sessions}`) return json(404, { error: 'unknown session' });
      if (!('id' in message)) { res.writeHead(202); return res.end(); }
      const result = message.method === 'tools/list'
        ? (message.params?.cursor ? { tools: [{ name: 'b' }] } : { tools: [{ name: 'a' }], nextCursor: 'p2' })
        : message.params.name === 'boom'
          ? null
          : message.params.name === 'missing'
          ? { isError: true, content: [{ type: 'text', text: '{"error":"audio not found","code":"not_found"}' }] }
          : { content: [{ type: 'text', text: `called ${message.params.name} ${JSON.stringify(message.params.arguments)}` }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const reply = result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool' } };
      return res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    }
    json(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { state, options: { oauthUrl: `${base}/oauth`, mcpUrl: `${base}/mcp` }, close: () => server.close() };
}

test('mcp: a Clerk session links the account (PKCE), tools paginate, SSE replies parse, expiry refreshes', async t => {
  const suno = await fakeSuno();
  t.after(suno.close);

  const tokens = await sdk.linkWithSessionToken('clerk-jwt', suno.options);
  assert.equal(tokens.client_id, 'dcr-1');
  assert.equal(tokens.refresh_token, 'rt-1');
  await assert.rejects(sdk.linkWithSessionToken('nope', suno.options), err => err.status === 401);

  const saved = [];
  const client = new sdk.SunoMcpClient(tokens, { ...suno.options, onTokens: next => saved.push(next) });
  assert.deepEqual((await client.listTools()).map(tool => tool.name), ['a', 'b']);
  const result = await client.callTool('make_song', { prompt: 'hi' });
  assert.equal(result.content[0].text, 'called make_song {"prompt":"hi"}');
  await assert.rejects(client.callTool('boom'), /unknown tool/);
  await assert.rejects(client.callToolJson('missing'), err => err.status === 404 && err.suno_code === 'not_found');

  // Token revoked/rotated server-side: the client refreshes, keeps the refresh token and reports it.
  suno.state.access = 'rotated';
  suno.state.refreshes = 5;
  await client.callTool('x');
  assert.equal(saved.at(-1).access_token, 'at-7');
  assert.equal(saved.at(-1).refresh_token, 'rt-1');

  // Session lost server-side: re-initialize once.
  suno.state.sessions++;
  await client.callTool('y');
});

test('mcp: authorize URL carries PKCE S256 and the MCP resource', () => {
  const { verifier, challenge } = sdk.createPkce();
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  const url = new URL(sdk.authorizeUrl({ clientId: 'c', redirectUri: 'https://h/cb', state: 's', challenge }));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('resource'), sdk.SUNO_MCP_URL);
  assert.equal(sdk.parseRpcResponse('{"jsonrpc":"2.0","id":3,"result":1}', 3).result, 1);
});

/** A stand-in MCP client: `tools` maps a tool name to its JSON answer (value or function of the args). */
function fakeMcp(tools) {
  const calls = [];
  return {
    calls,
    async callToolJson(name, args = {}) {
      calls.push({ name, args });
      const answer = tools[name];
      if (answer === undefined) throw new Error(`unexpected tool ${name}`);
      return typeof answer === 'function' ? answer(args) : answer;
    },
    async putUpload(url, bytes) { calls.push({ name: 'PUT', args: { url, size: bytes.byteLength } }); }
  };
}

const v0Clip = (id, extra = {}) => ({
  id, title: 'Song', status: 'complete', cover_image_url: 'https://cdn/img.jpg', liked: true, visibility: 'private', error: null,
  metadata: { lyrics: '[Verse]\nla', style: 'pop', duration: 12.5, type: 'generate', description: null }, ...extra
});

test('mcp ops: clips keep the AudioInfo shape and creations carry an idempotency key', async () => {
  const info = sdk.mcpOps.toAudioInfo(v0Clip('c1'));
  assert.equal(info.image_url, 'https://cdn/img.jpg');
  assert.equal(info.lyric, '[Verse]\nla');
  assert.equal(info.tags, 'pop');
  assert.equal(info.duration, 12.5);
  assert.equal(info.is_public, false);

  const client = fakeMcp({ 'audio-create': { clip_ids: ['a', 'b'], clips: [v0Clip('a', { status: 'submitted' }), v0Clip('b', { status: 'submitted' })] } });
  const args = sdk.mcpOps.generationArgs({ persona_id: 'v1', weirdness: 40, style_weight: 0.5, vocal_gender: 'f', model: 'chirp-hawk', workspace_id: 'ignored' }, 'ws1');
  assert.deepEqual(args, { voice_id: 'v1', vocal_gender: 'female', model: 'v6', workspace_id: 'ws1', controls: { weirdness: 0.4, style_influence: 0.5 } });
  const clips = await sdk.mcpOps.createClips(client, 'audio-create', { ...args, description: 'x' });
  assert.deepEqual(clips.map(clip => clip.id), ['a', 'b']);
  assert.match(client.calls[0].args.idempotency_key, /^[0-9a-f-]{36}$/);
});

test('mcp ops: workspaces resolve by name (create on request), playlists come back on page 1', async () => {
  const client = fakeMcp({
    'workspaces-list': ({ cursor }) => cursor ? { workspaces: [{ id: 'w2', name: 'Uploads' }] } : { workspaces: [{ id: 'w1', name: 'Other' }], next_cursor: 'p2' },
    'workspaces-create': ({ name }) => ({ id: 'w3', name }),
    'workspaces-update-clips': {},
    'playlists-list': ({ cursor }) => cursor ? { playlists: [{ id: 'p2', name: 'B', clip_count: 1, visibility: 'public' }] } : { playlists: [{ id: 'p1', name: 'A', clip_count: 3 }], next_cursor: '2' }
  });
  assert.deepEqual(await sdk.mcpOps.moveClipsToWorkspace(client, ['c'], undefined, 'uploads'), { workspace_id: 'w2', workspace_name: 'Uploads', clip_ids: ['c'] });
  await assert.rejects(sdk.mcpOps.resolveWorkspace(client, undefined, 'Nope'), err => err.status === 404);
  assert.equal((await sdk.mcpOps.resolveWorkspace(client, undefined, 'Nope', true)).id, 'w3');

  const first = await sdk.mcpOps.listMyPlaylists(client, 1);
  assert.deepEqual(first.playlists.map(p => [p.id, p.num_total_results, p.is_public]), [['p1', 3, undefined], ['p2', 1, true]]);
  assert.equal(first.num_total_results, 2);
  assert.equal((await sdk.mcpOps.listMyPlaylists(client, 2)).playlists.length, 0);
});

test('mcp ops: downloads never spend a credit unless confirmed, stems map suno-api modes', async () => {
  const client = fakeMcp({ 'audio-download': ({ confirm }) => confirm ? { status: 'ok', url: 'https://s3/x.mp3', format: 'mp3' } : { status: 'requires_credit' } });
  assert.deepEqual(await sdk.mcpOps.downloadClip(client, 'c', 'mp3', false), { status: 'requires_credit' });
  assert.equal((await sdk.mcpOps.downloadClip(client, 'c', 'mp3', true)).download_url, 'https://s3/x.mp3');
  assert.equal(sdk.mcpOps.stemsMode('twelve'), 'twelve');
  assert.equal(sdk.mcpOps.stemsMode('extract', 'Lead Vocal'), 'two');
  assert.throws(() => sdk.mcpOps.stemsMode('extract', 'Drum Kit'), err => err.unsupported === true);
});

test('mcp upload workflow: same work steps and result shape, credentials never persisted', async t => {
  const dir = await (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'mcp-upload-'));
  let polls = 0;
  const client = fakeMcp({
    'audio-upload-create': { id: 'clip-up', upload_url: 'https://s3/secret?sig=1', upload_page_url: 'https://api/upload/secret', expires_at: 'x' },
    'audio-upload-complete': v0Clip('clip-up', { status: 'processing' }),
    'audio-retrieve': () => v0Clip('clip-up', { status: ++polls > 1 ? 'complete' : 'processing' }),
    'workspaces-list': { workspaces: [{ id: 'w1', name: 'Uploads' }] },
    'workspaces-update-clips': {}
  });
  const workflow = sdk.createUploadFileWorkflow({ storageDirectory: dir, getApi: () => { throw new Error('cookie path used'); }, getMcp: async () => client });
  const work = await workflow.submitUploadFile({
    file: { name: 'song.mp3', type: 'audio/mpeg', bytes: Buffer.from('abc') },
    auth: { cookie: '', accountId: 'oauth-only', transport: 'mcp' },
    workspaceName: 'Uploads'
  });
  let done;
  for (let i = 0; i < 100 && !['completed', 'failed'].includes((done = await workflow.getUploadFileWork(work.work_id)).status); i++)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.equal(done.input.transport, 'mcp');
  assert.equal(done.result.initialized_clip.clip_id, 'clip-up');
  assert.equal(done.result.clip.id, 'clip-up');
  assert.equal(done.result.workspace_move.workspace_id, 'w1');
  assert.deepEqual(client.calls.find(call => call.name === 'PUT').args, { url: 'https://s3/secret?sig=1', size: 3 });
  const stored = await (await import('node:fs/promises')).readFile((await import('node:path')).join(dir, `${work.work_id}.json`), 'utf8');
  assert.ok(!/secret/.test(stored), 'upload URLs are not persisted');
});

test('mcp ops: requests the MCP cannot honour are marked unsupported (cookie accounts fall back to the web API)', async () => {
  assert.equal(sdk.mcpOps.mcpModel('chirp-hawk'), 'v6');
  assert.equal(sdk.mcpOps.mcpModel('chirp-goose'), 'v6-mini');
  assert.equal(sdk.mcpOps.mcpModel('v6-wild'), 'v6-wild');
  assert.equal(sdk.mcpOps.mcpModel(undefined), undefined);
  for (const run of [
    () => sdk.mcpOps.mcpModel('chirp-custom:abc'),
    () => sdk.mcpOps.generationArgs({ lyrics_project_id: 'x' }),
    () => sdk.mcpOps.stemsMode('extract', 'Bass')
  ]) assert.throws(run, err => err.unsupported === true && err.status === 409);
  const client = fakeMcp({ 'audio-edit': v0Clip('c') });
  await assert.rejects(sdk.mcpOps.editClip(client, 'c', { title: 't', image_url: 'https://x' }), err => err.unsupported === true);
  assert.equal((await sdk.mcpOps.editClip(client, 'c', { title: 't', account: 'main' })).id, 'c');
  assert.equal(sdk.unsupportedViaMcp('x').unsupported, true);
});

test('an MCP clip gets the asking account user id only when its handle is that account\'s own', async () => {
  const client = { callToolJson: async (_tool, { id }) => ({ id, handle: id === 'mine' ? 'me' : 'someone', status: 'complete', metadata: {} }) };
  const [mine, other] = await sdk.mcpOps.retrieveClips(client, ['mine', 'theirs'], { id: 'u-me', handle: 'me' });
  assert.equal(mine.user_id, 'u-me');
  assert.equal(other.user_id, undefined);
  assert.equal((await sdk.mcpOps.retrieveClips(client, ['mine']))[0].user_id, undefined, 'no owner, no guess');
});
