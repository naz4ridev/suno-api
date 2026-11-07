import { AxiosError } from 'axios';

export const CLIP = '8e3286fb-5046-4233-b478-af5b0d61f69f';
export const STEM = '7390193c-678d-4453-bfb6-0b6b6c244e12';

export const fakeJwt = (expiresInSeconds = 3600) => {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds })}.sig`;
};

export const ACCOUNTS = [
  { id: 'main', label: 'Main', isDefault: true, cookie: '__client=cookie-main; ajs_anonymous_id=anon-main',
    user: { id: 'user-main', handle: 'main_handle' } },
  { id: 'second', label: 'Second', cookie: '__client=cookie-second',
    user: { id: 'user-second', handle: 'second_handle', email: 'second@example.test' } },
  { id: 'off', label: 'Disabled', disabled: true, cookie: '__client=cookie-off' }
];

/**
 * An axios adapter that answers like Suno. No socket is opened: `routes` maps "METHOD /path" to an answer
 * (value, or function of the request). Unknown requests fail the test loudly.
 */
export function mockSuno(routes = {}) {
  const calls = [];
  const table = {
    'GET /v1/client': () => ({ response: { last_active_session_id: 'sess_1' } }),
    'POST /v1/client/sessions/sess_1/tokens': () => ({ jwt: fakeJwt() }),
    'POST /api/c/check': () => ({ required: false }),
    'GET /api/billing/info/': () => ({ total_credits_left: 42, plan: { plan_key: 'pro' }, models: [] }),
    ...routes
  };
  const adapter = async config => {
    const url = new URL(config.url, 'https://studio.invalid');
    const method = String(config.method || 'get').toUpperCase();
    const key = `${method} ${url.pathname}`;
    const call = { method, path: url.pathname, query: url.search, headers: { ...config.headers.toJSON?.() ?? config.headers }, body: config.data, host: url.host };
    calls.push(call);
    const handler = table[key];
    if (!handler) throw new Error(`Unmocked Suno request: ${key}`);
    const answer = typeof handler === 'function' ? handler(call, config) : handler;
    const status = answer?.__status ?? 200;
    const response = { data: answer?.__status ? answer.body : answer, status, statusText: String(status), headers: {}, config, request: {} };
    if (status >= 400) throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_RESPONSE', config, {}, response);
    return response;
  };
  return { adapter, calls, proxy: { axiosConfig: () => ({ adapter }) } };
}

export const status = (code, body = {}) => ({ __status: code, body });
