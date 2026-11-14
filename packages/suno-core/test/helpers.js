// Ayudas de test. Todo es inventado: token, ids, claves y "audio". Nada toca la red ni Suno.
// El lado "servidor" usa node:crypto (OpenSSL) a propósito: es una implementación independiente
// de la Web Crypto que usa el core, así el round-trip prueba compatibilidad real.
import { createCipheriv, createHash, randomBytes, webcrypto } from 'node:crypto';

export const TOKEN = 'inventado.token-de-prueba.no-es-real';
export const CLIP_ID = '11111111-2222-4333-8444-555555555555';
export const OTHER_CLIP_ID = '99999999-8888-4777-8666-555555555555';
export const subtle = webcrypto.subtle;

/** Valor tal y como lo entrega /api/mango/rights: base64(iv12 | cifrado | tag16), AES-256-GCM. */
export function wrap(plain16, token = TOKEN, clipId = CLIP_ID, iv = randomBytes(12)) {
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(token).digest(), iv);
  cipher.setAAD(Buffer.from(clipId));
  const body = Buffer.concat([cipher.update(plain16), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
}

/** M4A sintético: caja ftyp + relleno determinista. */
export function syntheticMp4(size = 4096) {
  if (size < 24) throw new RangeError('syntheticMp4 necesita al menos 24 bytes');
  const head = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(8)]);
  const filler = Buffer.alloc(size - head.length);
  for (let i = 0; i < filler.length; i++) filler[i] = (i * 31 + 7) & 0xff;
  return Buffer.concat([head, filler]);
}

export function encryptCtr(plain, key, counter) {
  const cipher = createCipheriv('aes-128-ctr', key, counter);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** Clip de prueba con `rights` coherentes. */
export function makeRights({ token = TOKEN, clipId = CLIP_ID } = {}) {
  const key = randomBytes(16);
  const iv = randomBytes(16);
  return { key, iv, rights: { key: wrap(key, token, clipId), iv: wrap(iv, token, clipId) } };
}
