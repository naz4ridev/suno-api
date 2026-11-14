import assert from 'node:assert/strict';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  SunoCoreError, bytesToHex, createPlaybackCrypto, hexToBytes, isMp4,
} from '../src/index.js';
import {
  CLIP_ID, OTHER_CLIP_ID, TOKEN, encryptCtr, makeRights, subtle, syntheticMp4, wrap,
} from './helpers.js';

const core = () => createPlaybackCrypto({ subtle });

test('round-trip: token → master key → unwrap rights → decrypt MP4 sintético', async () => {
  const c = core();
  const { key, iv, rights } = makeRights();
  const mp4 = syntheticMp4(10_000);
  const encrypted = encryptCtr(mp4, key, iv);

  const master = await c.deriveMasterKey(TOKEN);
  const material = await c.unwrapPlaybackRights(rights, CLIP_ID, master);
  assert.deepEqual(Buffer.from(material.key), key);
  assert.deepEqual(Buffer.from(material.iv), iv);

  const plain = await c.decryptPlayback(encrypted, material);
  assert.ok(plain instanceof Uint8Array);
  assert.deepEqual(Buffer.from(plain), mp4);
});

test('el core coincide con la implementación de node:crypto que usaba suno-api', async () => {
  // Réplica literal del código previo de getPlaybackAudio (aes-256-gcm + aes-128-ctr).
  const { key, iv, rights } = makeRights();
  const mp4 = syntheticMp4(2048);
  const encrypted = encryptCtr(mp4, key, iv);
  const master = createHash('sha256').update(TOKEN).digest();
  const legacyUnwrap = (value) => {
    const wrapped = Buffer.from(value, 'base64');
    const d = createDecipheriv('aes-256-gcm', master, wrapped.subarray(0, 12));
    d.setAAD(Buffer.from(CLIP_ID));
    d.setAuthTag(wrapped.subarray(-16));
    return Buffer.concat([d.update(wrapped.subarray(12, -16)), d.final()]);
  };
  const c = core();
  const mk = await c.deriveMasterKey(TOKEN);
  assert.deepEqual(Buffer.from(await c.unwrapKey(rights.key, CLIP_ID, mk)), legacyUnwrap(rights.key));
  assert.deepEqual(Buffer.from(await c.unwrapKey(rights.iv, CLIP_ID, mk)), legacyUnwrap(rights.iv));
  const legacy = createDecipheriv('aes-128-ctr', legacyUnwrap(rights.key), legacyUnwrap(rights.iv));
  const legacyPlain = Buffer.concat([legacy.update(encrypted), legacy.final()]);
  const plain = await c.decryptPlayback(encrypted, { key: legacyUnwrap(rights.key), iv: legacyUnwrap(rights.iv) });
  assert.deepEqual(Buffer.from(plain), legacyPlain);
});

test('decryptPlayback acepta clave/iv en hex (así los guarda la extensión)', async () => {
  const { key, iv } = makeRights();
  const mp4 = syntheticMp4();
  const plain = await core().decryptPlayback(encryptCtr(mp4, key, iv), {
    key: key.toString('hex'), iv: iv.toString('hex'),
  });
  assert.deepEqual(Buffer.from(plain), mp4);
});

test('el contador de AES-CTR es de 128 bits: acarreo entre bloques correcto', async () => {
  const key = randomBytes(16);
  const iv = Buffer.alloc(16, 0xff); // desborda en el segundo bloque
  const mp4 = syntheticMp4(4096);
  const plain = await core().decryptPlayback(encryptCtr(mp4, key, iv), { key, iv });
  assert.deepEqual(Buffer.from(plain), mp4);
});

test('token incorrecto rechaza el unwrap', async () => {
  const c = core();
  const { rights } = makeRights();
  const wrong = await c.deriveMasterKey(TOKEN + 'x');
  await assert.rejects(c.unwrapKey(rights.key, CLIP_ID, wrong), { code: 'KEY_UNWRAP_FAILED' });
  await assert.rejects(c.unwrapPlaybackRights(rights, CLIP_ID, wrong), SunoCoreError);
});

test('AAD (clipId) incorrecto rechaza el unwrap', async () => {
  const c = core();
  const { rights } = makeRights();
  const mk = await c.deriveMasterKey(TOKEN);
  await assert.rejects(c.unwrapKey(rights.key, OTHER_CLIP_ID, mk), { code: 'KEY_UNWRAP_FAILED' });
});

test('valor envuelto manipulado o truncado se rechaza', async () => {
  const c = core();
  const mk = await c.deriveMasterKey(TOKEN);
  const good = Buffer.from(wrap(randomBytes(16)), 'base64');
  const flipped = Buffer.from(good); flipped[20] ^= 1;
  await assert.rejects(c.unwrapKey(flipped.toString('base64'), CLIP_ID, mk), { code: 'KEY_UNWRAP_FAILED' });
  await assert.rejects(c.unwrapKey(good.subarray(0, 28).toString('base64'), CLIP_ID, mk), { code: 'INVALID_KEY' });
  await assert.rejects(c.unwrapKey('', CLIP_ID, mk), { code: 'INVALID_KEY' });
  await assert.rejects(c.unwrapKey('###no-es-base64###', CLIP_ID, mk), { code: 'INVALID_KEY' });
  await assert.rejects(c.unwrapKey(123, CLIP_ID, mk), { code: 'INVALID_KEY' });
});

test('el valor desenvuelto debe medir 16 bytes', async () => {
  const c = core();
  const mk = await c.deriveMasterKey(TOKEN);
  await assert.rejects(c.unwrapKey(wrap(randomBytes(32)), CLIP_ID, mk), { code: 'INVALID_KEY_SIZE' });
  await assert.rejects(c.unwrapKey(wrap(randomBytes(15)), CLIP_ID, mk), { code: 'INVALID_KEY_SIZE' });
});

test('clipId inválido se rechaza antes de tocar la criptografía', async () => {
  const c = core();
  const mk = await c.deriveMasterKey(TOKEN);
  const { rights } = makeRights();
  for (const bad of ['', 'nope', CLIP_ID + 'a', '../' + CLIP_ID, null, undefined, 5]) {
    await assert.rejects(c.unwrapKey(rights.key, bad, mk), { code: 'INVALID_CLIP_ID' });
  }
});

test('rights incompletos', async () => {
  const c = core();
  const mk = await c.deriveMasterKey(TOKEN);
  const { rights } = makeRights();
  for (const bad of [null, undefined, {}, { key: rights.key }, { iv: rights.iv }, { key: 1, iv: 2 }, 'x']) {
    await assert.rejects(c.unwrapPlaybackRights(bad, CLIP_ID, mk), { code: 'NO_RIGHTS' });
  }
});

test('clave AES-CTR equivocada produce basura y se rechaza por no ser MP4', async () => {
  const { key, iv } = makeRights();
  const encrypted = encryptCtr(syntheticMp4(), key, iv);
  await assert.rejects(core().decryptPlayback(encrypted, { key: randomBytes(16), iv }), { code: 'NOT_MP4' });
  await assert.rejects(core().decryptPlayback(encrypted, { key, iv: randomBytes(16) }), { code: 'NOT_MP4' });
});

test('un texto claro sin caja ftyp se rechaza aunque descifre bien', async () => {
  const { key, iv } = makeRights();
  const notMp4 = Buffer.from('esto no es un mp4, es texto plano largo');
  await assert.rejects(core().decryptPlayback(encryptCtr(notMp4, key, iv), { key, iv }), { code: 'NOT_MP4' });
  const short = Buffer.from('ftyp'); // menos de 8 bytes
  await assert.rejects(core().decryptPlayback(encryptCtr(short, key, iv), { key, iv }), { code: 'NOT_MP4' });
});

test('longitud de clave/contador y tamaño de entrada', async () => {
  const c = core();
  const { key, iv } = makeRights();
  const enc = encryptCtr(syntheticMp4(), key, iv);
  for (const bad of [randomBytes(15), randomBytes(17), randomBytes(32), '', 'abcd', Buffer.alloc(0), null, undefined, 7]) {
    await assert.rejects(c.decryptPlayback(enc, { key: bad, iv }), SunoCoreError);
    await assert.rejects(c.decryptPlayback(enc, { key, iv: bad }), SunoCoreError);
  }
  await assert.rejects(c.decryptPlayback(enc, { key: 'zz'.repeat(16), iv }), { code: 'INVALID_KEY' });
  await assert.rejects(c.decryptPlayback(Buffer.alloc(0), { key, iv }), { code: 'INVALID_SIZE' });
  await assert.rejects(c.decryptPlayback('texto', { key, iv }), { code: 'INVALID_SIZE' });
  await assert.rejects(c.decryptPlayback(enc, null), SunoCoreError);
});

test('deriveMasterKey exige token no vacío', async () => {
  const c = core();
  for (const bad of ['', null, undefined, 42, {}]) await assert.rejects(c.deriveMasterKey(bad), { code: 'NO_TOKEN' });
});

test('Web Crypto inyectable: usa el subtle recibido, no el global', async () => {
  const calls = [];
  const spy = {
    digest: (...a) => (calls.push('digest'), subtle.digest(...a)),
    importKey: (...a) => (calls.push('importKey'), subtle.importKey(...a)),
    decrypt: (...a) => (calls.push('decrypt'), subtle.decrypt(...a)),
  };
  const c = createPlaybackCrypto({ subtle: spy });
  const { key, iv, rights } = makeRights();
  const mk = await c.deriveMasterKey(TOKEN);
  const material = await c.unwrapPlaybackRights(rights, CLIP_ID, mk);
  await c.decryptPlayback(encryptCtr(syntheticMp4(), key, iv), material);
  assert.deepEqual(calls, ['digest', 'importKey', 'decrypt', 'decrypt', 'importKey', 'decrypt']);
});

test('sin subtle inyectado usa globalThis.crypto.subtle; sin ninguno, error claro', async () => {
  const { key, iv, rights } = makeRights();
  const c = createPlaybackCrypto();
  const mk = await c.deriveMasterKey(TOKEN);
  assert.deepEqual(Buffer.from((await c.unwrapPlaybackRights(rights, CLIP_ID, mk)).key), key);
  assert.throws(() => createPlaybackCrypto({ subtle: { digest() {} } }), { code: 'NO_WEBCRYPTO' });
  void iv;
});

test('ningún mensaje de error contiene token, claves, IV ni valores envueltos', async () => {
  const c = core();
  const { key, iv, rights } = makeRights();
  const secrets = [TOKEN, key.toString('hex'), iv.toString('hex'), rights.key, rights.iv,
    key.toString('base64'), iv.toString('base64')];
  const wrong = await c.deriveMasterKey(TOKEN + '!');
  const mk = await c.deriveMasterKey(TOKEN);
  const attempts = [
    () => c.deriveMasterKey(''),
    () => c.unwrapKey(rights.key, CLIP_ID, wrong),
    () => c.unwrapKey(rights.key, OTHER_CLIP_ID, mk),
    () => c.unwrapKey(rights.key, 'mal-id', mk),
    () => c.unwrapKey(rights.key.slice(0, 20), CLIP_ID, mk),
    () => c.unwrapPlaybackRights({ key: rights.key }, CLIP_ID, mk),
    () => c.decryptPlayback(encryptCtr(syntheticMp4(), key, iv), { key: randomBytes(16), iv }),
    () => c.decryptPlayback(encryptCtr(syntheticMp4(), key, iv), { key: key.toString('hex') + '00', iv }),
    () => c.decryptPlayback(Buffer.alloc(0), { key, iv }),
  ];
  for (const attempt of attempts) {
    const e = await attempt().then(() => null, (x) => x);
    assert.ok(e instanceof SunoCoreError, 'debe fallar con SunoCoreError');
    const dump = `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${String(e.cause ?? '')}`;
    for (const s of secrets) assert.ok(!dump.includes(s), `un error filtra un secreto: ${e.code}`);
  }
});

test('helpers de bytes', () => {
  const b = Uint8Array.from([0, 1, 254, 255]);
  assert.equal(bytesToHex(b), '0001feff');
  assert.equal(bytesToHex(b.buffer), '0001feff');
  assert.equal(bytesToHex(new DataView(b.buffer, 1, 2)), '01fe');
  assert.equal(bytesToHex('no'), '');
  assert.deepEqual(hexToBytes('0001FEff'), b);
  assert.throws(() => hexToBytes('abc'), { code: 'INVALID_KEY' });
  assert.throws(() => hexToBytes('zz'), { code: 'INVALID_KEY' });
  assert.ok(isMp4(syntheticMp4(32)));
  assert.ok(!isMp4(Buffer.from('12345678')));
  assert.ok(!isMp4(null));
});
