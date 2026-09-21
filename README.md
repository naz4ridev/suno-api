<div align="center">
  <h1 align="center">
      Suno AI API
  </h1>
  <p>Use API to call the music generation AI of Suno.ai and easily integrate it into agents like GPTs.</p>
  <p>👉 We update quickly, please star.</p>
</div>
<p align="center">
  <a target="_blank" href="./README.md">English</a> 
  | <a target="_blank" href="./README_CN.md">简体中文</a> 
  | <a target="_blank" href="./README_RU.md">русский</a> 
  | <a target="_blank" href="https://suno.gcui.ai">Demo</a> 
  | <a target="_blank" href="https://suno.gcui.ai/docs">Docs</a> 
  | <a target="_blank" href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgcui-art%2Fsuno-api&env=SUNO_COOKIE,TWOCAPTCHA_KEY,BROWSER,BROWSER_GHOST_CURSOR,BROWSER_LOCALE,BROWSER_HEADLESS&project-name=suno-api&repository-name=suno-api">Deploy with Vercel</a> 
</p>
<p align="center">
  <a href="https://www.producthunt.com/products/gcui-art-suno-api-open-source-sunoai-api/reviews?utm_source=badge-product_review&utm_medium=badge&utm_souce=badge-gcui&#0045;art&#0045;suno&#0045;api&#0045;open&#0045;source&#0045;sunoai&#0045;api" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/product_review.svg?product_id=577408&theme=light" alt="gcui&#0045;art&#0047;suno&#0045;api&#0058;Open&#0045;source&#0032;SunoAI&#0032;API - Use&#0032;API&#0032;to&#0032;call&#0032;the&#0032;music&#0032;generation&#0032;AI&#0032;of&#0032;suno&#0046;ai&#0046; | Product Hunt" style="width: 250px; height: 54px;" width="250" height="54" /></a>
</p>

> 🔥 Check out my new project: [Linkly-ai-cli: A document search engine CLI, built for AI Agents.](https://github.com/LinklyAI/linkly-ai-cli)

![suno-api banner](https://github.com/gcui-art/suno-api/blob/main/public/suno-banner.png)

## Introduction

Suno is an amazing AI music service. Although the official API is not yet available, we couldn't wait to integrate its capabilities somewhere.

We discovered that some users have similar needs, so we decided to open-source this project, hoping you'll like it.

This implementation uses the paid [2Captcha](https://2captcha.com/about) service (a.k.a. ruCaptcha) to solve the hCaptcha challenges automatically and does not use any already made closed-source paid Suno API implementations.

## Demo

We have deployed an example bound to a free Suno account, so it has daily usage limits, but you can see how it runs:
[suno.gcui.ai](https://suno.gcui.ai)

## Features

- Perfectly implements the creation API from suno.ai.
- Automatically keep the account active.
- Solve CAPTCHAs automatically using [2Captcha](https://2captcha.com) and [Playwright](https://playwright.dev) with [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches).
- Compatible with the format of OpenAI’s `/v1/chat/completions` API.
- Supports Custom Mode.
- One-click deployment to [Vercel](#deploy-to-vercel) & [Docker](#docker).
- In addition to the standard API, it also adapts to the API Schema of Agent platforms like GPTs and Coze, so you can use it as a tool/plugin/Action for LLMs and integrate it into any AI Agent.
- Permissive open-source license, allowing you to freely integrate and modify.

## Getting Started

### 1. Obtain the cookie of your Suno account

1. Head over to [suno.com/create](https://suno.com/create) using your browser.
2. Open up the browser console: hit `F12` or access the `Developer Tools`.
3. Navigate to the `Network` tab.
4. Give the page a quick refresh.
5. Identify the latest request that includes the keyword `?__clerk_api_version`.
6. Click on it and switch over to the `Header` tab.
7. Locate the `Cookie` section, hover your mouse over it, and copy the value of the Cookie.

![get cookie](https://github.com/gcui-art/suno-api/blob/main/public/get-cookie-demo.gif)

### 2. Register on 2Captcha and top up your balance
[2Captcha](https://2captcha.com/about) is a paid CAPTCHA solving service that uses real workers to solve the CAPTCHA and has high accuracy. It is needed because of Suno constantly requesting hCaptcha solving that currently isn't possible for free by any means.

[Create](https://2captcha.com/auth/register?userType=customer) a new 2Captcha account, [top up](https://2captcha.com/pay) your balance and [get your API key](https://2captcha.com/enterpage#recognition).

> [!NOTE]
> If you are located in Russia or Belarus, use the [ruCaptcha](https://rucaptcha.com) interface instead of 2Captcha. It's the same service, but it supports payments from those countries.

> [!TIP]
> If you want as few CAPTCHAs as possible, it is recommended to use a macOS system. macOS systems usually get fewer CAPTCHAs than Linux and Windows—this is due to its unpopularity in the web scraping industry. Running suno-api on Windows and Linux will work, but in some cases, you could get a pretty large number of CAPTCHAs.

### 3. Clone and deploy this project

You can choose your preferred deployment method:

#### Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgcui-art%2Fsuno-api&env=SUNO_COOKIE,TWOCAPTCHA_KEY,BROWSER,BROWSER_GHOST_CURSOR,BROWSER_LOCALE,BROWSER_HEADLESS&project-name=suno-api&repository-name=suno-api)

#### Run locally

```bash
git clone https://github.com/gcui-art/suno-api.git
cd suno-api
npm install
cp .env.example .env
```
#### Docker
>[!IMPORTANT]
> GPU acceleration will be disabled in Docker. If you have a slow CPU, it is recommended to [deploy locally](#run-locally).

Alternatively, you can use [Docker Compose](https://docs.docker.com/compose/). Copy the example env file first and adjust the published host/port if needed.

```bash
cp .env.example .env
docker compose build && docker compose up
```

### 4. Configure suno-api

- If deployed to Vercel, please add the environment variables in the Vercel dashboard.

- If you’re running this locally, be sure to add the following to your `.env` file:
#### Environment variables
- `SUNO_COOKIE` — the `Cookie` header you obtained in the first step. Optional if you prefer sending `suno_cookie` per request.
- `TWOCAPTCHA_KEY` — your 2Captcha API key from the second step.
- `BROWSER` — the name of the browser that is going to be used to solve the CAPTCHA. Only `chromium` and `firefox` supported.
- `BROWSER_GHOST_CURSOR` — use ghost-cursor-playwright to simulate smooth mouse movements. Please note that it doesn't seem to make any difference in the rate of CAPTCHAs, so you can set it to `false`. Retained for future testing.
- `BROWSER_LOCALE` — the language of the browser. Using either `en` or `ru` is recommended, since those have the most workers on 2Captcha. [List of supported languages](https://2captcha.com/2captcha-api#language)
- `BROWSER_HEADLESS` — run the browser without the window. You probably want to set this to `true`.
- `HOST` — host/interface where Next.js binds. Recommended `127.0.0.1` locally and `0.0.0.0` in Docker.
- `PORT` — port where the app listens.
- `APP_BASE_PATH` — base path where the app is exposed. Default is `/`, which is represented by leaving this variable empty. If you serve the app behind a reverse proxy under a subpath such as `/tools/suno-api`, this value must be set before `npm run build` or `docker compose build`.
- `UPLOAD_FILE_WORK_DIR` — directory used by the async `/api/upload_file` workflow to persist `work_id` state across process restarts. Defaults to `./.data/upload-file-works`.
- `DOCKER_BIND_HOST` — only for Docker Compose. Host interface where the container port is published.
- `DOCKER_HOST_PORT` — only for Docker Compose. Host port published by Docker.
```bash
SUNO_COOKIE=<…>
TWOCAPTCHA_KEY=<…>
BROWSER=chromium
BROWSER_GHOST_CURSOR=false
BROWSER_LOCALE=en
BROWSER_HEADLESS=true
HOST=127.0.0.1
PORT=3000
APP_BASE_PATH=
UPLOAD_FILE_WORK_DIR=
DOCKER_BIND_HOST=127.0.0.1
DOCKER_HOST_PORT=3000
```

### 5. Run suno-api

- If you’ve deployed to Vercel:
  - Please click on Deploy in the Vercel dashboard and wait for the deployment to be successful.
  - Visit the `https://<vercel-assigned-domain>/api/get_limit` API for testing.
- If running locally:
  - Development: run `npm run dev`.
  - Production-like: run `npm run build && npm run start`.
  - You can override binding with `HOST` and `PORT`, for example: `HOST=127.0.0.1 PORT=4000 npm run dev`.
  - If you use a subpath via reverse proxy, set `APP_BASE_PATH` before building and keep the same value at runtime.
  - Visit `http://<HOST>:<PORT><APP_BASE_PATH>/api/get_limit` for testing. If `APP_BASE_PATH` is empty, this becomes `http://<HOST>:<PORT>/api/get_limit`.
- If running with Docker Compose:
  - Configure `HOST`, `PORT`, `APP_BASE_PATH`, `DOCKER_BIND_HOST`, and `DOCKER_HOST_PORT` in `.env` as needed.
  - Example: `HOST=0.0.0.0`, `PORT=3001`, `APP_BASE_PATH=/tools/suno-api`, `DOCKER_BIND_HOST=127.0.0.1`, `DOCKER_HOST_PORT=3001`.
  - Then run `docker compose up --build`.
  - Visit `http://<DOCKER_BIND_HOST>:<DOCKER_HOST_PORT><APP_BASE_PATH>/api/get_limit`.
- If the following result is returned:

```json
{
  "credits_left": 50,
  "period": "day",
  "monthly_limit": 50,
  "monthly_usage": 50
}
```

it means the program is running normally.

### Reverse proxy and PM2

If you want to serve the app behind nginx under a subpath such as `/tools/suno-api`, set the same `APP_BASE_PATH` value for both the build and the runtime. The easiest approach is to place it in `.env`, because:

- `npm run build` will use it when Next.js generates the app.
- `npm run start` will use it for `HOST` and `PORT`.
- `pm2 start ecosystem.config.cjs` will read the same `.env` file and use the same values.

If `APP_BASE_PATH` is empty, the app is served from `/`.

Example `.env` for your nginx setup:

```bash
HOST=127.0.0.1
PORT=8015
APP_BASE_PATH=/tools/suno-api
SUNO_COOKIE=<…>
TWOCAPTCHA_KEY=<…>
BROWSER=chromium
BROWSER_GHOST_CURSOR=false
BROWSER_LOCALE=en
BROWSER_HEADLESS=true
```

Build and run without Docker:

```bash
npm install
npm run build
pm2 start ecosystem.config.cjs
```

With the example above, the external health-check URL will be `https://<your-domain>/tools/suno-api/api/get_limit`.

PM2 fallbacks are intentionally generic:

- `HOST=127.0.0.1`
- `PORT=8015`
- `APP_BASE_PATH=` which means `/`

nginx example:

```nginx
location ^~ /tools/suno-api {
    auth_basic "Suno API";
    auth_basic_user_file /etc/nginx/.htpasswd-stems;

    client_max_body_size 250M;

    proxy_pass http://127.0.0.1:8015;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Port  $server_port;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        "upgrade";

    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

If you later change the external path, rebuild the app with the new `APP_BASE_PATH` before restarting PM2 or rebuilding the Docker image.

### 6. Use Suno API

You can check out the detailed API documentation at :
[suno.gcui.ai/docs](https://suno.gcui.ai/docs)

## API Reference

Suno API currently mainly implements the following APIs:

```bash
- `/api/generate`: Generate music
- `/v1/chat/completions`: Generate music - Call the generate API in a format that works with OpenAI’s API.
- `/api/custom_generate`: Generate music (Custom Mode, support setting lyrics, music style, title, etc.)
- `/api/generate_lyrics`: Generate lyrics based on prompt
- `/api/get`: Get music information based on the id. Use “,” to separate multiple ids.
    If no IDs are provided, all music will be returned.
- `/api/get_limit`: Get quota Info
- `/api/extend_audio`: Extend audio length
- `/api/generate_stems`: Make stem tracks (separate audio and music track)
- `/api/get_aligned_lyrics`: Get list of timestamps for each word in the lyrics
- `/api/clip`: Get clip information based on ID passed as query parameter `id`
- `/api/concat`: Generate the whole song from extensions
```

You can also specify `suno_cookie` per request, overriding the default cookies in the `SUNO_COOKIE` environment variable. This works in JSON bodies, query string, `multipart/form-data`, or the headers `x-suno-cookie` / `suno-cookie`.

### Multiple accounts

suno-api keeps one authenticated client per account, so several Suno accounts can be used at the same time.

- **Register accounts** with `POST /api/accounts` `{ "cookie": "<Cookie header of suno.com or the __client value>", "label": "Main", "make_default": true }`.
  The cookie is validated (login + `/api/session/` + credits) and stored in `SUNO_ACCOUNTS_FILE` (default `./.data/accounts.json`, mode 600, git-ignored; mount `/app/.data` as a volume in Docker).
  Accounts can also be declared read-only with env vars: `SUNO_COOKIE` (id `SUNO_DEFAULT_ACCOUNT_ID`, default `default`) and `SUNO_ACCOUNTS='[{"id":"b","label":"B","cookie":"__client=..."}]'`.
- **Pick an account** per request with `account` (JSON body, form-data or query) or the `x-suno-account` header. The value can be the account id, label, email or Suno handle. Without it the default account is used; `suno_cookie` still overrides everything.
- **Manage**: `GET /api/accounts`, `GET|PATCH|DELETE /api/accounts/{id}` (`label`, `cookie`, `disabled`, `make_default`), `POST /api/accounts/{id}/check` (refresh user + credits). Cookies are never returned by the API.
- Set `SUNO_ACCOUNTS_ADMIN_TOKEN` to require the `x-admin-token` header on account changes.
- `/api/upload_file` works store the `account_id` that ran them (never the cookie).

### Endpoints added in the Sep 2026 update

```bash
- `/api/models`: Models of the account (chirp-hawk = v6 default, chirp-hawk-wild, chirp-goose, custom `chirp-custom:<id>`)
- `/api/custom_models` (GET/POST), `/api/custom_models/bases`, `/api/custom_models/{id}` (GET/DELETE): train and manage custom models
- `/api/voices` (GET/POST), `/api/voices/phrase`, `/api/voices/verification/{id}`: create and list voices (vox personas)
- `/api/persona?list=mine|loved|followed`: list personas
- `/api/workspaces` (GET/POST): list/create workspaces
- `/api/download`: mp3/wav download through /api/download/authorize (may deduct download credits)
- `/api/wav_file?id=`: WAV conversion
- `/api/clip_analysis?id=`: key and downbeats
```

Generation endpoints (`/api/generate`, `/api/custom_generate`, `/api/extend_audio`, `/api/generate_from_audio`) now use `POST /api/generate/v2-web/` and accept
`persona_id` / `voice_id`, `weirdness`, `style_weight`, `audio_weight`, `aug_creativity`, `vocal_gender`, `is_max_mode`, `workspace_id` / `workspace_name` and `model` (including custom models).
`/api/generate_stems` accepts `mode` = `extract` (default, `stem_name` + complement), `twelve` (12 stems) or `legacy`.

`/api/upload_file` follows the current web flow and reports Suno's upload rejections in `error.detail` with `error_type`
(`upload_failure_match_audible_magic`, `upload_failure_match_acrcloud`, `upload_failure_lyrics_copyright`, `upload_failure_check_failed`, ...),
`category`, `retryable` and `copyright`. Copyright rejections always include the word "copyright" in the message.
Completed works expose `result.copyright_muted` when Suno muted copyrighted parts (send `reject_copyright_muted=true` to fail instead).
Extra form fields: `create_workspace_if_missing`, `audio_content_types`, `reject_copyright_muted`, `account`.

For more detailed documentation, please check out the demo site:
[suno.gcui.ai/docs](https://suno.gcui.ai/docs)

## API Integration Code Examples

### Python

```python
import time
import requests

# replace with your suno-api URL
base_url = 'http://localhost:3000'


def custom_generate_audio(payload):
    url = f"{base_url}/api/custom_generate"
    response = requests.post(url, json=payload, headers={'Content-Type': 'application/json'})
    return response.json()


def extend_audio(payload):
    url = f"{base_url}/api/extend_audio"
    response = requests.post(url, json=payload, headers={'Content-Type': 'application/json'})
    return response.json()

def generate_audio_by_prompt(payload):
    url = f"{base_url}/api/generate"
    response = requests.post(url, json=payload, headers={'Content-Type': 'application/json'})
    return response.json()


def get_audio_information(audio_ids):
    url = f"{base_url}/api/get?ids={audio_ids}"
    response = requests.get(url)
    return response.json()


def get_quota_information():
    url = f"{base_url}/api/get_limit"
    response = requests.get(url)
    return response.json()

def get_clip(clip_id):
    url = f"{base_url}/api/clip?id={clip_id}"
    response = requests.get(url)
    return response.json()

def generate_whole_song(clip_id):
    payload = {"clip_id": clip_id}
    url = f"{base_url}/api/concat"
    response = requests.post(url, json=payload)
    return response.json()


if __name__ == '__main__':
    data = generate_audio_by_prompt({
        "prompt": "A popular heavy metal song about war, sung by a deep-voiced male singer, slowly and melodiously. The lyrics depict the sorrow of people after the war.",
        "make_instrumental": False,
        "wait_audio": False
    })

    ids = f"{data[0]['id']},{data[1]['id']}"
    print(f"ids: {ids}")

    for _ in range(60):
        data = get_audio_information(ids)
        if data[0]["status"] == 'streaming':
            print(f"{data[0]['id']} ==> {data[0]['audio_url']}")
            print(f"{data[1]['id']} ==> {data[1]['audio_url']}")
            break
        # sleep 5s
        time.sleep(5)

```

### JavaScript

```js
const axios = require("axios");

// replace your vercel domain
const baseUrl = "http://localhost:3000";

async function customGenerateAudio(payload) {
  const url = `${baseUrl}/api/custom_generate`;
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
  });
  return response.data;
}

async function generateAudioByPrompt(payload) {
  const url = `${baseUrl}/api/generate`;
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
  });
  return response.data;
}

async function extendAudio(payload) {
  const url = `${baseUrl}/api/extend_audio`;
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
  });
  return response.data;
}

async function getAudioInformation(audioIds) {
  const url = `${baseUrl}/api/get?ids=${audioIds}`;
  const response = await axios.get(url);
  return response.data;
}

async function getQuotaInformation() {
  const url = `${baseUrl}/api/get_limit`;
  const response = await axios.get(url);
  return response.data;
}

async function getClipInformation(clipId) {
  const url = `${baseUrl}/api/clip?id=${clipId}`;
  const response = await axios.get(url);
  return response.data;
}

async function main() {
  const data = await generateAudioByPrompt({
    prompt:
      "A popular heavy metal song about war, sung by a deep-voiced male singer, slowly and melodiously. The lyrics depict the sorrow of people after the war.",
    make_instrumental: false,
    wait_audio: false,
  });

  const ids = `${data[0].id},${data[1].id}`;
  console.log(`ids: ${ids}`);

  for (let i = 0; i < 60; i++) {
    const data = await getAudioInformation(ids);
    if (data[0].status === "streaming") {
      console.log(`${data[0].id} ==> ${data[0].audio_url}`);
      console.log(`${data[1].id} ==> ${data[1].audio_url}`);
      break;
    }
    // sleep 5s
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

main();
```

## Integration with Custom Agents

You can integrate Suno AI as a tool/plugin/action into your AI agent.

### Integration with GPTs

[coming soon...]

### Integration with Coze

[coming soon...]

### Integration with LangChain

[coming soon...]

## Contributing

There are four ways you can support this project:

1. Fork and Submit Pull Requests: We welcome any PRs that enhance the functionality, APIs, response time and availability. You can also help us just by translating this README into your language—any help for this project is welcome!
2. Open Issues: We appreciate reasonable suggestions and bug reports.
3. Donate: If this project has helped you, consider buying us a coffee using the Sponsor button at the top of the project. Cheers! ☕
4. Spread the Word: Recommend this project to others, star the repo, or add a backlink after using the project.

## Questions, Suggestions, Issues, or Bugs?

We use [GitHub Issues](https://github.com/gcui-art/suno-api/issues) to manage feedback. Feel free to open an issue, and we'll address it promptly.

## License

The license of this project is LGPL-3.0 or later. See [LICENSE](LICENSE) for more information.

## Related Links

- Project repository: [github.com/gcui-art/suno-api](https://github.com/gcui-art/suno-api)
- Suno.ai official website: [suno.ai](https://suno.ai)
- Demo: [suno.gcui.ai](https://suno.gcui.ai)
- [Readpo](https://readpo.com?utm_source=github&utm_medium=suno-api): ReadPo is an AI-powered reading and writing assistant. Collect, curate, and create content at lightning speed.
- Album AI: [Auto generate image metadata and chat with the album. RAG + Album.](https://github.com/gcui-art/album-ai)

## Statement

suno-api is an unofficial open source project, intended for learning and research purposes only.
