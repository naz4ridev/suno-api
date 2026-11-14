import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { describeClip } from '../src/index.js';

const NIL = '00000000-0000-0000-0000-000000000000';
const SONG = '8e3286fb-5046-4233-b478-af5b0d61f69f';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/advanced-drums-submitted.json', import.meta.url), 'utf8'));
const generated = fixture.requests.find((r) => r.url.endsWith('/generate/v2-web/')).response.clips;

const stem = (over = {}, meta = {}) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  title: 'Mi canción (Drums)',
  user_id: 'user-1',
  handle: 'alguien',
  batch_index: 0,
  metadata: { task: 'gen_stem', stem_task: 'extract', stem_type_group_name: 'Drums', stem_from_id: SONG, ...meta },
  ...over,
});

test('captura real de Advanced split: 4 clips, aislados y complementos, V1/V2', () => {
  const d = generated.map(describeClip);
  assert.deepEqual(d.map((x) => [x.version, x.isComplement]),
    [['V1', false], ['V1', true], ['V2', false], ['V2', true]]);
  for (const x of d) {
    assert.equal(x.isStem, true);
    assert.equal(x.kind, 'advanced');
    assert.equal(x.stemName, 'Drum Kit');
    assert.equal(x.songTitle, 'fastdl 1 (FULL MIX LP)');
    assert.equal(x.songId, SONG);
  }
});

test('forma de salida compatible con la UI actual', () => {
  const d = describeClip(stem());
  assert.deepEqual(Object.keys(d),
    ['isStem', 'isComplement', 'stemName', 'songTitle', 'version', 'kind', 'songId', 'userId', 'handle']);
  assert.deepEqual(d, {
    isStem: true, isComplement: false, stemName: 'Drums', songTitle: 'Mi canción', version: 'V1',
    kind: 'advanced', songId: SONG, userId: 'user-1', handle: 'alguien',
  });
});

test('complemento: metadata.stem_task === "remove" aunque el título no diga Without', () => {
  const c = describeClip(stem({ title: 'Mi canción (Instrumental)' }, { stem_task: 'remove' }));
  assert.equal(c.isComplement, true);
  assert.equal(c.stemName, 'Drums');
});

test('complemento: sigue detectándose por título cuando no hay stem_task', () => {
  const c = describeClip(stem({ title: 'Mi canción (Without Drums)' }, { stem_task: undefined }));
  assert.equal(c.isComplement, true);
  assert.equal(describeClip(stem({ title: 'Mi canción (Sin batería)' })).isComplement, false);
  assert.equal(describeClip(stem({ title: 'X (WITHOUT bass)' }, { stem_task: 'twelve' })).isComplement, true);
});

test('un stem aislado ("extract") nunca es complemento', () => {
  assert.equal(describeClip(stem()).isComplement, false);
});

test('songId: metadata NIL → history[0]; todo NIL → id del clip', () => {
  const REAL = 'bbbbbbbb-1111-4222-8333-444444444444';
  const viaHistory = describeClip(stem({}, { stem_from_id: NIL, history: [{ stem_from_id: REAL, stem_task: 'twelve' }] }));
  assert.equal(viaHistory.songId, REAL);
  const allNil = describeClip(stem({}, { stem_from_id: NIL, history: [{ stem_from_id: NIL }] }));
  assert.equal(allNil.songId, 'aaaaaaaa-0000-4000-8000-000000000001');
  const noFields = describeClip(stem({}, { stem_from_id: undefined }));
  assert.equal(noFields.songId, 'aaaaaaaa-0000-4000-8000-000000000001');
  // metadata real gana sobre history
  const both = describeClip(stem({}, { stem_from_id: SONG, history: [{ stem_from_id: REAL }] }));
  assert.equal(both.songId, SONG);
});

test('índices Advanced split: 0,1 → V1 · 2,3 → V2', () => {
  const v = [0, 1, 2, 3, 4, 5].map((i) => describeClip(stem({ batch_index: i })).version);
  assert.deepEqual(v, ['V1', 'V1', 'V2', 'V2', 'V3', 'V3']);
});

test('índices Auto split (twelve): 0-11 → V1 · 12-23 → V2', () => {
  const auto = (i) => describeClip(stem({ batch_index: i }, { stem_task: 'twelve' }));
  assert.equal(auto(0).kind, 'auto');
  assert.deepEqual([0, 5, 11, 12, 17, 23].map((i) => auto(i).version), ['V1', 'V1', 'V1', 'V2', 'V2', 'V2']);
});

test('Auto split detectado por history cuando metadata no trae stem_task, y en complementos', () => {
  const viaHistory = describeClip(stem({ batch_index: 13 }, { stem_task: undefined, history: [{ stem_task: 'twelve' }] }));
  assert.equal(viaHistory.kind, 'auto');
  assert.equal(viaHistory.version, 'V2');
  // complemento ("remove"): el tipo de split sale del history, no de "remove"
  const comp = describeClip(stem({ batch_index: 13, title: 'S (Without Bass)' }, { stem_task: 'remove', history: [{ stem_task: 'twelve' }] }));
  assert.equal(comp.kind, 'auto');
  assert.equal(comp.version, 'V2');
  assert.equal(comp.isComplement, true);
  // sin pistas → advanced (comportamiento previo)
  assert.equal(describeClip(stem({}, { stem_task: undefined })).kind, 'advanced');
});

test('batch_index: raíz tiene prioridad; metadata como respaldo; basura → sin versión', () => {
  assert.equal(describeClip(stem({ batch_index: 2 }, { batch_index: 0 })).version, 'V2');
  assert.equal(describeClip(stem({ batch_index: undefined }, { batch_index: 2 })).version, 'V2');
  assert.equal(describeClip(stem({ batch_index: 0 }, { batch_index: 2 })).version, 'V1'); // 0 no es "ausente"
  assert.equal(describeClip(stem({ batch_index: '3' })).version, 'V2');
  for (const bad of [null, undefined, 'x', '', NaN, -1, Infinity]) {
    assert.equal(describeClip(stem({ batch_index: bad })).version, '', `batch_index=${String(bad)}`);
  }
});

test('canción completa (no stem): sin versión ni stemName, título intacto', () => {
  const d = describeClip({ id: 'cccccccc-0000-4000-8000-000000000003', title: 'Canción (Remix)', batch_index: 5, metadata: {} });
  assert.equal(d.isStem, false);
  assert.equal(d.version, '');
  assert.equal(d.stemName, null);
  assert.equal(d.songTitle, 'Canción (Remix)');
  assert.equal(d.songId, 'cccccccc-0000-4000-8000-000000000003');
  assert.equal(d.kind, 'advanced');
});

test('nombres: guiones bajos, stem sin grupo, título vacío', () => {
  assert.equal(describeClip(stem({}, { stem_type_group_name: 'Backing_Vocals' })).stemName, 'Backing Vocals');
  const noGroup = describeClip(stem({ title: 'Tema (Lead Vocal)' }, { stem_type_group_name: undefined }));
  assert.equal(noGroup.isStem, true); // task gen_stem
  assert.equal(noGroup.stemName, 'Lead Vocal');
  assert.equal(describeClip(stem({ title: 'Tema' }, { stem_type_group_name: undefined })).stemName, 'Stem');
  assert.equal(describeClip(stem({ title: '' })).songTitle, 'Suno');
  assert.equal(describeClip({ id: 'x', metadata: {} }).songTitle, 'Suno');
});

test('entradas hostiles no lanzan', () => {
  for (const bad of [null, undefined, 0, 'x', [], {}, { metadata: null }, { metadata: { history: 'x' } },
    { metadata: { history: [null] } }, { title: 5, metadata: { stem_type_group_name: 7 } }]) {
    assert.doesNotThrow(() => describeClip(bad));
  }
});
