const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const NIL = '00000000-0000-0000-0000-000000000000';
const invalid = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };

/** Validate the native render contract before any download can be unlocked. */
export function stemRenderClipIds(sourceId: string, render: any): string[] {
  if (!UUID.test(sourceId)) invalid('source_clip_id must be a clip UUID');
  if (!render || render.format !== 'wav_s16') invalid('render.format must be wav_s16');
  if (!Number.isFinite(render.start_beats) || !Number.isFinite(render.end_beats)
    || render.end_beats <= render.start_beats) invalid('Invalid render beat range');
  if (!(render.state?.timing?.bps > 0) || !Number.isFinite(render.state.timing.bps))
    invalid('render.state.timing.bps must be positive');
  const tracks = render.state?.tracks;
  if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > 128)
    invalid('render.state.tracks must contain 1 to 128 tracks');
  const ids = new Set<string>();
  for (const track of tracks) {
    if (!Array.isArray(track?.clips) || track.clips.length < 1 || track.clips.length > 128)
      invalid('Each render track must contain 1 to 128 clips');
    for (const clip of track.clips) {
      if (clip?.asset?.type !== 'clip' || typeof clip.asset.id !== 'string' || !UUID.test(clip.asset.id))
        invalid('Render assets must be Suno clip UUIDs');
      ids.add(clip.asset.id);
      if (ids.size > 128) invalid('At most 128 distinct clips may be rendered');
    }
  }
  return [...ids];
}

/** A stem unlock belongs to its source song, shared by both alternatives and complements. */
export function assertStemRenderSource(sourceId: string, ids: string[], clips: any[]): void {
  for (const id of ids) {
    const clip = clips.find(c => c.id === id);
    if (!clip || clip.status !== 'complete')
      invalid('All rendered clips must be accessible and complete');
    if (id === sourceId) continue;
    const metadata = clip?.metadata || {};
    const history = Array.isArray(metadata.history) ? metadata.history : [];
    const root = [metadata.stem_from_id, ...history.map((h: any) => h?.stem_from_id)]
      .find(value => typeof value === 'string' && UUID.test(value) && value !== NIL);
    if (!clip || root !== sourceId)
      invalid('All rendered stems must belong to source_clip_id');
  }
}
