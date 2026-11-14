import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPlaybackUrl, isClipId, legacyCdnUrl, selectPlaybackUrl } from '../src/index.js';
import { CLIP_ID, OTHER_CLIP_ID } from './helpers.js';

const good = `https://cdn1.suno.cloudfront.net/audio/${CLIP_ID}/main.m4a?x=1`;
const entry = (over = {}) => ({ delivery: 'progressive', encoding: '1.0.0', url: good, ...over });
const clip = (media_urls) => ({ id: CLIP_ID, media_urls });

test('elige la primera entrada progressive + 1.0.0', () => {
  const picked = selectPlaybackUrl(clip([
    entry({ delivery: 'hls', url: `https://a.cloudfront.net/${CLIP_ID}/hls.m3u8` }),
    entry({ encoding: '2.0.0', url: `https://b.cloudfront.net/${CLIP_ID}/v2.m4a` }),
    entry({ url: 12 }),
    null,
    'texto',
    entry(),
    entry({ url: `https://c.cloudfront.net/${CLIP_ID}/otra.m4a` }),
  ]));
  assert.equal(picked, good);
});

test('clipId explícito tiene prioridad sobre clip.id', () => {
  const other = `https://x.cloudfront.net/${OTHER_CLIP_ID}.m4a`;
  assert.equal(selectPlaybackUrl({ id: CLIP_ID, media_urls: [entry({ url: other })] }, { clipId: OTHER_CLIP_ID }), other);
  assert.throws(() => selectPlaybackUrl(clip([entry({ url: other })])), { code: 'INVALID_MEDIA_URL' });
});

test('URLs inválidas se rechazan', () => {
  const bad = [
    `http://x.cloudfront.net/${CLIP_ID}.m4a`,             // sin https
    `https://x.cloudfront.net:8443/${CLIP_ID}.m4a`,       // puerto
    `https://user:pw@x.cloudfront.net/${CLIP_ID}.m4a`,    // credenciales
    `https://user@x.cloudfront.net/${CLIP_ID}.m4a`,
    `https://cloudfront.net/${CLIP_ID}.m4a`,              // sin subdominio (no termina en ".cloudfront.net")
    `https://evilcloudfront.net/${CLIP_ID}.m4a`,
    `https://x.cloudfront.net.evil.example/${CLIP_ID}.m4a`,
    `https://x.cloudfront.net@evil.example/${CLIP_ID}.m4a`,
    `https://cdn1.suno.com/${CLIP_ID}.m4a`,               // otro host
    `https://x.cloudfront.net/otro-clip.m4a`,             // sin el id en la ruta
    `https://x.cloudfront.net/?id=${CLIP_ID}`,            // el id solo en la query
    `https://x.cloudfront.net/#${CLIP_ID}`,               // ni en el fragmento
    `https://x.cloudfront.net/${OTHER_CLIP_ID}.m4a`,
    `file:///${CLIP_ID}.m4a`,
    `javascript:alert('${CLIP_ID}')`,
    'no es una url', '', '//x.cloudfront.net/' + CLIP_ID,
  ];
  for (const url of bad) {
    assert.throws(() => assertPlaybackUrl(url, CLIP_ID), { code: 'INVALID_MEDIA_URL' }, url);
    assert.throws(() => selectPlaybackUrl(clip([entry({ url })])), { code: 'INVALID_MEDIA_URL' }, url);
  }
});

test('el puerto por defecto (443) no cuenta como puerto', () => {
  assert.equal(assertPlaybackUrl(`https://x.cloudfront.net:443/${CLIP_ID}.m4a`, CLIP_ID), `https://x.cloudfront.net/${CLIP_ID}.m4a`);
});

test('la URL devuelta es la normalizada (URL#toString), como hacía suno-api', () => {
  assert.equal(assertPlaybackUrl(`HTTPS://X.CloudFront.NET/${CLIP_ID}.m4a`, CLIP_ID), `https://x.cloudfront.net/${CLIP_ID}.m4a`);
});

test('clipId inválido', () => {
  for (const id of ['', 'x', undefined, null, 7, CLIP_ID + '0']) {
    // clipId === undefined en las opciones significa «usa clip.id», que aquí es válido
    if (id !== undefined) assert.throws(() => selectPlaybackUrl(clip([entry()]), { clipId: id }), { code: 'INVALID_CLIP_ID' });
    assert.throws(() => assertPlaybackUrl(good, id), { code: 'INVALID_CLIP_ID' });
  }
  assert.throws(() => selectPlaybackUrl({ media_urls: [entry()] }), { code: 'INVALID_CLIP_ID' });
  assert.ok(isClipId(CLIP_ID) && isClipId(CLIP_ID.toUpperCase()) && !isClipId('x'));
});

test('media_urls presente pero sin entrada válida: error, NUNCA fallback al CDN', () => {
  for (const list of [[], [entry({ delivery: 'hls' })], [entry({ encoding: '0.9' })], [entry({ url: undefined })], {}, 'x', 0]) {
    for (const allowLegacyCdn of [false, true]) {
      assert.throws(() => selectPlaybackUrl(clip(list), { allowLegacyCdn }), { code: 'NO_PLAYABLE_AUDIO' });
    }
  }
});

test('clips antiguos sin media_urls: fallback al CDN solo si se permite', () => {
  for (const c of [{ id: CLIP_ID }, { id: CLIP_ID, media_urls: null }, { id: CLIP_ID, media_urls: undefined }]) {
    assert.throws(() => selectPlaybackUrl(c), { code: 'NO_PLAYABLE_AUDIO' });
    assert.throws(() => selectPlaybackUrl(c, { allowLegacyCdn: false }), { code: 'NO_PLAYABLE_AUDIO' });
    assert.throws(() => selectPlaybackUrl(c, { allowLegacyCdn: 'yes' }), { code: 'NO_PLAYABLE_AUDIO' });
    assert.equal(selectPlaybackUrl(c, { allowLegacyCdn: true }), `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${CLIP_ID}.m4a`);
  }
  assert.equal(legacyCdnUrl(CLIP_ID), `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${CLIP_ID}.m4a`);
  assert.throws(() => legacyCdnUrl('../x'), { code: 'INVALID_CLIP_ID' });
});

test('clip no objeto', () => {
  assert.throws(() => selectPlaybackUrl(null, { clipId: CLIP_ID }), { code: 'NO_PLAYABLE_AUDIO' });
  assert.equal(selectPlaybackUrl(null, { clipId: CLIP_ID, allowLegacyCdn: true }), legacyCdnUrl(CLIP_ID));
});
