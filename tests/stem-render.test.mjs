import test from 'node:test';
import assert from 'node:assert/strict';
import { stemRenderClipIds, assertStemRenderSource } from '../src/lib/stemRender.ts';

const song = '8e3286fb-5046-4233-b478-af5b0d61f69f';
const stem = '7390193c-678d-4453-bfb6-0b6b6c244e12';
const other = '7e97c261-1ec4-4296-a2f0-c95019ebaa6a';
const render = () => ({ format: 'wav_s16', start_beats: -1, end_beats: 380.02,
  state: { timing: { bps: 2.1165 }, tracks: [{ clips: [{ asset: { type: 'clip', id: stem } }] }] } });

test('native export accepts a pickup before beat zero and deduplicates repeated assets', () => {
  const r = render(); r.state.tracks.push(r.state.tracks[0]);
  assert.deepEqual(stemRenderClipIds(song, r), [stem]);
});

test('rejects invalid render input before the caller can unlock a song', () => {
  for (const mutate of [r => { r.state.timing.bps = Infinity; }, r => { r.end_beats = -2; },
    r => { r.state.tracks = []; }, r => { r.state.tracks[0].clips[0].asset.type = 'url'; },
    r => { r.state.tracks[0].clips[0].asset.id = '../../other'; }, r => { r.format = 'unknown'; }]) {
    const r = render(); mutate(r);
    assert.throws(() => stemRenderClipIds(song, r), { status: 400 });
  }
});

test('an unlock cannot be applied to an unrelated or inaccessible stem', () => {
  assert.throws(() => assertStemRenderSource(song, [stem], []), { status: 400 });
  assert.throws(() => assertStemRenderSource(song, [stem], [{ id: stem, status: 'complete', metadata: { stem_from_id: other } }]), { status: 400 });
  assert.throws(() => assertStemRenderSource(song, [stem], [{ id: stem, status: 'streaming', metadata: { stem_from_id: song } }]), { status: 400 });
  assert.doesNotThrow(() => assertStemRenderSource(song, [stem], [{ id: stem, status: 'complete', metadata: {
    stem_from_id: '00000000-0000-0000-0000-000000000000', history: [{ stem_from_id: song }] } }]));
});
