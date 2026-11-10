# Changelog

## 1.4.0 — 2026-11-11

- Transport policy (`SUNO_TRANSPORT`, `x-suno-transport`): with `auto`, routes whose official-MCP version is equivalent (generation, extend, cover, concat, library, clips, workspaces, playlists, metadata, downloads) go through the MCP for every account, so generation avoids captchas; requests the MCP cannot honour and accounts whose MCP connection fails fall back to the web API.
- Cookie accounts are linked to the MCP when added (`link_mcp`), on demand (`POST/DELETE /api/accounts/{id}/mcp`) or on first use; `auth.mcp_error` shows linking failures. A cookie replaced by another Suno user's revokes the old grant.

- Official Suno MCP (`api.suno.com/mcp`): `GET /api/mcp/tools` and `POST /api/mcp/call` pass through every tool Suno declares. Cookie accounts are linked to the MCP automatically; `POST /api/accounts/mcp/authorize` + `/api/accounts/mcp/callback` (or `/api/accounts/mcp/complete`) add accounts through Suno's OAuth without a cookie.
- OAuth-only accounts use the regular routes that have an MCP equivalent (generation, extend, cover, concat, stems, library, clips, workspaces, playlists, metadata, downloads, uploads, voices, models, credits); the rest answer 409. Responses carry `x-suno-transport: mcp`. SDK: `mcpOps` and the upload workflow's MCP branch.
- MCP grants are revoked when an account is deleted or its tokens are replaced; pending authorizations survive restarts.
- Extract the Suno client into a reusable library, `packages/suno-sdk` (`@suno-api/sdk`): `SunoApi`, the account selection rules, the upload workflow and the route contract used by clients. The library reads no environment, imports no Next.js/Electron and embeds no browser; accounts, proxy, logger and the captcha provider are injected.
- `src/lib/SunoApi.ts` is now a thin compatibility wrapper over that library (same exports, same routes). The headless Chromium + 2Captcha flow stays in the server (`src/lib/headlessCaptcha.ts`).
- Upload works are durable across restarts: records left running by a previous process are reported as interrupted.
- `npm run sdk:build` produces the self-describing artifact consumed by the Suno2DAW desktop app; `npm run sdk:test` and `npm run sdk:typecheck` cover it.

## 1.2.0 — 2026-11-06

- List existing stem pages with `GET /api/stems`, including native alternative/complement metadata.
- Export official WAV stem ZIPs with `POST /api/stems/render` and native Studio timing state. Source authorization is explicit and defaults to false; only complete stems from the same source may be exported.
- Expose the native preparation hint at `POST /api/stems/prefetch` and the versioned instrument snapshot at `GET /api/stems/catalogue`.
- Share playback media validation and decryption with the Suno extension through the generated suno-core library.
- Include the application version in `/api/health`; preserve existing authentication, account selection and proxy routing.

The API accepts a caller-provided timing/warp state. It does not validate Suno's beat analysis against the audio and does not select a project tempo automatically.
