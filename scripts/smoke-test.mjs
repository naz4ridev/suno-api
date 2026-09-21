#!/usr/bin/env node
/**
 * Read-only smoke test against a running suno-api (no credits are spent, nothing is created).
 *
 *   node scripts/smoke-test.mjs [baseUrl] [accountId...]
 *
 * Without account ids it checks every account returned by GET /api/accounts.
 * Optional env: SMOKE_BASIC_AUTH=user:pass (when suno-api is behind basic auth).
 */

const baseUrl = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const requestedAccounts = process.argv.slice(3);
const headers = {};
if (process.env.SMOKE_BASIC_AUTH)
  headers.Authorization = `Basic ${Buffer.from(process.env.SMOKE_BASIC_AUTH).toString('base64')}`;

async function call(path, account) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { ...headers, ...(account ? { 'x-suno-account': account } : {}) }
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { ok: response.ok, status: response.status, ms: Date.now() - started, json };
}

const checks = [
  ['credits', '/api/get_limit', r => `credits_left=${r.credits_left} plan=${r.plan ?? '?'}`],
  ['models', '/api/models', r => (r.models || []).map(m => `${m.external_key}${m.is_default ? '*' : ''}`).join(', ')],
  ['workspaces', '/api/workspaces', r => `${(r.workspaces || []).length} workspaces`],
  ['custom models', '/api/custom_models', r => `${(r.models || []).length} ready, ${(r.pending || []).length} training`],
  ['custom bases', '/api/custom_models/bases', r => (r.options || []).map(o => o.base_model).join(', ')],
  ['voices', '/api/voices', r => `${(r.personas || []).length} voices`],
  ['voice phrase', '/api/voices/phrase?language=en', r => r.phrase_text],
  ['latest clips', '/api/get', r => `${Array.isArray(r) ? r.length : 0} clips (feed/v3)`],
  ['playlists', '/api/playlist/me?page=1', r => `${r.num_total_results ?? (r.playlists || []).length} playlists`]
];

const accountsResponse = await call('/api/accounts');
if (!accountsResponse.ok) {
  console.error('GET /api/accounts failed', accountsResponse.status, accountsResponse.json);
  process.exit(1);
}
const accounts = requestedAccounts.length
  ? requestedAccounts
  : (accountsResponse.json.accounts || []).filter(a => !a.disabled).map(a => a.id);

console.log(`suno-api ${baseUrl} — default account: ${accountsResponse.json.default_account_id ?? '(none)'}`);
let failures = 0;
for (const account of accounts) {
  console.log(`\n== account ${account}`);
  for (const [name, path, summarize] of checks) {
    try {
      const result = await call(path, account);
      if (!result.ok)
        failures++;
      const summary = result.ok ? summarize(result.json) : JSON.stringify(result.json).slice(0, 200);
      console.log(`${result.ok ? 'OK  ' : 'FAIL'} ${name.padEnd(14)} ${String(result.status).padEnd(4)} ${String(result.ms).padStart(5)}ms  ${summary}`);
    } catch (error) {
      failures++;
      console.log(`FAIL ${name.padEnd(14)} ${error.message}`);
    }
  }
}

process.exit(failures ? 1 : 0);
