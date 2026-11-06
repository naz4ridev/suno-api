# Stems (web contract captured 2026-11-06)

Select an account with `x-suno-account` (or `account` in query/body); API key authentication is unchanged.

- `POST /api/generate_stems`: `audio_id`, `mode: "extract"`, `stem_name`, `wait_audio: false`. Advanced separation returns two alternatives and their complements. The UI label **Drums** maps to **Drum Kit**. `mode: "twelve"` is Auto split. Wait for every requested clip to reach `complete` before final export.
- `GET /api/stems?id=<source-uuid>&page=0`: list existing stems, native metadata, alternatives and complements. Returns `pages`, `current_page` and `stems`; pages start at zero. No generation or unlock occurs.
- `GET /api/stems/catalogue`: instrument snapshot with internal names, display labels, groups, Beta flags and capture/source metadata. Use the internal `name` in generation requests; display labels may collide. This is a snapshot, not a live quality assessment.
- `POST /api/stems/prefetch`: `{ "source_clip_id": "<source-uuid>", "account": "itsmpvmusic" }`. Returns the native preparation hint (e.g. `outcome: "not_assigned"`). It does not generate stems or authorize downloads and is not required before generation.
- `GET /api/playback_audio?id=<stem-uuid>`: decrypts the accessible playback M4A. A live stem was verified as Opus, stereo, 48 kHz. It is lossy playback audio, not lossless WAV.
- `POST /api/stems/render`: official ZIP export through `/api/studio/render-state-multitrack`. Body below. This accepts native Studio state; constructing its beat/warp mapping is the caller's responsibility.

```json
{
  "source_clip_id": "<source-song-uuid>",
  "account": "itsmpvmusic",
  "authorize": false,
  "render": {
    "format": "wav_s16",
    "start_beats": -1,
    "end_beats": 380.0264407822626,
    "state": "<native Studio state object, including tracks, timing and warp markers>"
  }
}
```

The example's `state` is a placeholder, not a runnable export. The actual object contains `timing.bps`, optional `bpsAutomation`, `markersRegistry`, `timeSignatureChanges`, tracks and audio clips referencing Suno assets. Other native export fields (e.g. `downbeats`, title and lyrics) pass through. Only `wav_s16` is supported in this initial adapter, because it was captured and verified.

`authorize` defaults to false. Set it to true to request `/api/download/authorize` for the **source song**, not for each stem. In the live capture this consumed one download and unlocked the song's stems. The adapter validates asset ownership/origin before requesting an unlock. Subsequent exports of the unlocked song can use `authorize: false`. The returned `download_url` expires; download the ZIP promptly without forwarding the API key to its host.

The captured official WAV is PCM signed 16-bit, stereo, 48 kHz. Its duration matches the playback audio to within one sample. This verifies format and duration only; it is not a fidelity benchmark. Exporting a playback Opus file as WAV would not restore the official file's quality. All referenced clips must be complete, not streaming. A failed explicit authorization stops the export.

The legacy `/api/wav_file` (conversion of one clip) and `/api/download` (individual download) remain available. Neither is the native multi-stem export observed in the web UI. This change does not deploy the API or alter existing generation behavior.

The web export already supplies tempo automation and shared warp markers. This data is an unverified reference: native analysis must be checked against the audio before DAW import. For a fixed-tempo project, the caller should pass constant `state.timing.bps` (manual BPM / 60) with no tempo automation and a validated seconds-to-beats warp map shared by all stems from the same source. A pickup before bar one can legitimately appear at negative beats; do not trim it automatically as silence. Native analysis remains available through `GET /api/clip_analysis?id=<source-uuid>`.
