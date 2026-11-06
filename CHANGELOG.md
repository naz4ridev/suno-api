# Changelog

## 1.2.0 — 2026-11-06

- List existing stem pages with `GET /api/stems`, including native alternative/complement metadata.
- Export official WAV stem ZIPs with `POST /api/stems/render` and native Studio timing state. Source authorization is explicit and defaults to false; only complete stems from the same source may be exported.
- Expose the native preparation hint at `POST /api/stems/prefetch` and the versioned instrument snapshot at `GET /api/stems/catalogue`.
- Share playback media validation and decryption with the Suno extension through the generated suno-core library.
- Include the application version in `/api/health`; preserve existing authentication, account selection and proxy routing.

The API accepts a caller-provided timing/warp state. It does not validate Suno's beat analysis against the audio and does not select a project tempo automatically.
