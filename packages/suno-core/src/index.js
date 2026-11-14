/**
 * @suno-api/core — núcleo compartido de Suno (suno-api, extensión de Chrome, suno2daw).
 *
 * Reglas de este fichero (se publica como paquete versionado; scripts/build.mjs genera la versión global):
 *  - SIN DOM, SIN cookies, SIN fs, SIN red, SIN dependencias, SIN imports.
 *  - Web Crypto INYECTABLE: nunca toca `crypto.subtle` por su cuenta salvo que no se le pase nada
 *    (entonces usa `globalThis.crypto.subtle`). La extensión le pasa el `subtle` original, anterior
 *    a sus propios hooks; suno-api le pasa `webcrypto.subtle` de node:crypto.
 *  - NINGÚN secreto (token de sesión, claves, IV, valores envueltos) se guarda en estado de módulo,
 *    se escribe en logs ni viaja dentro de mensajes de error. Los errores son SunoCoreError con
 *    mensaje fijo + `code`; quien llama decide cómo mostrarlos.
 *  - Todas las exportaciones van en UN único bloque `export { ... }` al final: el generador lo
 *    reescribe para la copia global de Chrome (MAIN world). No añadir otras formas de `export`.
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const CLIP_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const LEGACY_CDN_ORIGIN = 'https://d2lwuy8qc234o3.cloudfront.net';
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
/** iv(12) + tag(16) + al menos 1 byte de texto cifrado. */
const MIN_WRAPPED_BYTES = GCM_IV_BYTES + GCM_TAG_BYTES + 1;
/** Clave AES-128 y contador de AES-CTR: ambos de 16 bytes. */
const KEY_MATERIAL_BYTES = 16;

class SunoCoreError extends Error {
  /**
   * @param {string} message mensaje fijo, sin datos secretos
   * @param {string} code identificador estable
   */
  constructor(message, code) {
    super(message);
    this.name = 'SunoCoreError';
    this.code = code;
  }
}

const err = (message, code) => new SunoCoreError(message, code);
const isObject = (v) => v !== null && typeof v === 'object';
const utf8 = (s) => new TextEncoder().encode(s);

// --- identificadores y bytes -----------------------------------------------

function isClipId(value) {
  return typeof value === 'string' && CLIP_ID_RE.test(value);
}

function assertClipId(value) {
  if (!isClipId(value)) throw err('Invalid clip id', 'INVALID_CLIP_ID');
  return value;
}

/** ArrayBuffer | vista → Uint8Array sin copiar; otra cosa → null. */
function asBytes(buf) {
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return null;
}

/** ArrayBuffer | vista → hex en minúsculas ('' si no es un buffer). */
function bytesToHex(buf) {
  const u = asBytes(buf);
  return u ? Array.from(u, (x) => x.toString(16).padStart(2, '0')).join('') : '';
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw err('Invalid playback key', 'INVALID_KEY');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Base64 estándar o URL-safe, con o sin relleno. */
function base64ToBytes(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64) || typeof globalThis.atob !== 'function') {
    throw err('Invalid playback key', 'INVALID_KEY');
  }
  let bin;
  try {
    bin = globalThis.atob(b64.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''));
  } catch {
    throw err('Invalid playback key', 'INVALID_KEY');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Clave o contador: hex de 32 caracteres o 16 bytes. Devuelve Uint8Array(16). */
function parseKeyMaterial(value) {
  const bytes = typeof value === 'string' ? hexToBytes(value) : asBytes(value);
  if (!bytes || bytes.length !== KEY_MATERIAL_BYTES) throw err('Invalid playback key size', 'INVALID_KEY_SIZE');
  return Uint8Array.from(bytes);
}

// --- MP4 -------------------------------------------------------------------

/** ¿Empieza como un MP4/M4A? (caja `ftyp` en los bytes 4-7). */
function isMp4(bytes) {
  const u = asBytes(bytes);
  return !!u && u.length >= 8 && u[4] === 0x66 && u[5] === 0x74 && u[6] === 0x79 && u[7] === 0x70;
}

function assertMp4(bytes) {
  if (!isMp4(bytes)) throw err('The playback audio could not be decoded', 'NOT_MP4');
  return bytes;
}

// --- URLs de audio ---------------------------------------------------------

function legacyCdnUrl(clipId) {
  assertClipId(clipId);
  return `${LEGACY_CDN_ORIGIN}/1/clip/${clipId}.m4a`;
}

/**
 * Política de URL de audio: https, sin puerto ni credenciales, host *.cloudfront.net y el id del
 * clip dentro de la ruta. Devuelve la URL normalizada.
 */
function assertPlaybackUrl(url, clipId) {
  assertClipId(clipId);
  let u;
  try {
    u = new URL(url);
  } catch {
    throw err('Invalid playback media URL', 'INVALID_MEDIA_URL');
  }
  if (u.protocol !== 'https:' || u.port || u.username || u.password
    || !u.hostname.endsWith('.cloudfront.net') || !u.pathname.includes(clipId)) {
    throw err('Invalid playback media URL', 'INVALID_MEDIA_URL');
  }
  return u.toString();
}

/**
 * Elige y valida la URL de audio de un clip: la primera de `media_urls` con delivery
 * "progressive" y encoding "1.0.0".
 *
 * Solo los clips antiguos SIN `media_urls` (ausente o null) pueden caer al CDN heredado, y solo si
 * `allowLegacyCdn` es true. Si `media_urls` existe pero no trae esa entrada (incluida una lista
 * vacía) es un error: no se adivina una URL.
 *
 * @param {object} clip JSON del clip (/api/clip/<id>)
 * @param {{ clipId?: string, allowLegacyCdn?: boolean }} [options]
 */
function selectPlaybackUrl(clip, options = {}) {
  const clipId = assertClipId(options.clipId !== undefined ? options.clipId : isObject(clip) ? clip.id : undefined);
  const mediaUrls = isObject(clip) ? clip.media_urls : undefined;
  if (mediaUrls === undefined || mediaUrls === null) {
    if (options.allowLegacyCdn === true) return assertPlaybackUrl(legacyCdnUrl(clipId), clipId);
    throw err('This clip has no playable audio', 'NO_PLAYABLE_AUDIO');
  }
  const entry = Array.isArray(mediaUrls)
    ? mediaUrls.find((e) => isObject(e) && e.delivery === 'progressive' && e.encoding === '1.0.0' && typeof e.url === 'string')
    : undefined;
  if (!entry) throw err('This clip has no playable audio', 'NO_PLAYABLE_AUDIO');
  return assertPlaybackUrl(entry.url, clipId);
}

// --- criptografía de reproducción -----------------------------------------

function resolveSubtle(subtle) {
  const s = subtle || (globalThis.crypto && globalThis.crypto.subtle);
  if (!s || typeof s.digest !== 'function' || typeof s.importKey !== 'function' || typeof s.decrypt !== 'function') {
    throw err('Web Crypto is not available', 'NO_WEBCRYPTO');
  }
  return s;
}

/**
 * Crea las operaciones criptográficas sobre un `subtle` inyectado.
 *
 * Flujo de Suno: /api/mango/rights devuelve key e iv envueltos con AES-GCM. La clave de envoltura
 * es SHA-256(token de sesión) y el dato autenticado (AAD) es el id del clip. Lo desenvuelto son
 * 16 bytes (clave AES-128-CTR) y 16 bytes (contador inicial, 128 bits).
 *
 * @param {{ subtle?: SubtleCrypto }} [options]
 */
function createPlaybackCrypto(options = {}) {
  const subtle = resolveSubtle(options.subtle);

  /** SHA-256(token) como CryptoKey AES-GCM no extraíble. El token no se retiene. */
  async function deriveMasterKey(token) {
    if (typeof token !== 'string' || token.length === 0) {
      throw err('Missing Suno session token', 'NO_TOKEN');
    }
    const digest = await subtle.digest('SHA-256', utf8(token));
    return subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt']);
  }

  /** Desenvuelve un valor base64 (iv12 | cifrado | tag16) → 16 bytes. */
  async function unwrapKey(wrappedB64, clipId, masterKey) {
    assertClipId(clipId);
    const w = base64ToBytes(wrappedB64);
    if (w.length < MIN_WRAPPED_BYTES) throw err('Invalid playback key', 'INVALID_KEY');
    let raw;
    try {
      raw = await subtle.decrypt(
        { name: 'AES-GCM', iv: w.slice(0, GCM_IV_BYTES), additionalData: utf8(clipId) },
        masterKey,
        w.slice(GCM_IV_BYTES));
    } catch {
      throw err('Invalid playback key', 'KEY_UNWRAP_FAILED');
    }
    const out = new Uint8Array(raw);
    if (out.length !== KEY_MATERIAL_BYTES) throw err('Invalid playback key size', 'INVALID_KEY_SIZE');
    return out;
  }

  /** Respuesta de /api/mango/rights → { key, iv } en Uint8Array(16). */
  async function unwrapPlaybackRights(rights, clipId, masterKey) {
    if (!isObject(rights) || typeof rights.key !== 'string' || typeof rights.iv !== 'string') {
      throw err('Suno did not provide playback rights for this clip', 'NO_RIGHTS');
    }
    const key = await unwrapKey(rights.key, clipId, masterKey);
    const iv = await unwrapKey(rights.iv, clipId, masterKey);
    return { key, iv };
  }

  /** AES-CTR (contador de 128 bits) + validación de MP4. key/iv: hex o 16 bytes. */
  async function decryptPlayback(encrypted, material) {
    if (!isObject(material)) throw err('Invalid playback key', 'INVALID_KEY');
    const key = parseKeyMaterial(material.key);
    const counter = parseKeyMaterial(material.iv);
    const data = asBytes(encrypted);
    if (!data || data.length === 0) throw err('Invalid playback audio size', 'INVALID_SIZE');
    let plain;
    try {
      const ck = await subtle.importKey('raw', key, { name: 'AES-CTR' }, false, ['decrypt']);
      plain = new Uint8Array(await subtle.decrypt({ name: 'AES-CTR', counter, length: 128 }, ck, data));
    } catch {
      throw err('The playback audio could not be decoded', 'DECRYPT_FAILED');
    }
    return assertMp4(plain);
  }

  return Object.freeze({ deriveMasterKey, unwrapKey, unwrapPlaybackRights, decryptPlayback });
}

// --- descripción de clips ---------------------------------------------------

/**
 * Qué es un clip para la UI: canción o stem, qué stem, versión (V1/V2), tipo de split, canción de
 * origen. Misma forma de salida que la UI de la extensión 1.5.0.
 *
 * Notas sobre los datos reales:
 *  - Complemento («Without X»): `metadata.stem_task === 'remove'` (captura real de Advanced split);
 *    el título «(Without X)» sigue valiendo para clips sin ese campo.
 *  - `history[0].stem_task` guarda la operación pedida («extract», «twelve»), no el papel del clip:
 *    en un complemento `metadata.stem_task` es «remove», así que el tipo de split se lee del history.
 *  - `metadata.stem_from_id` puede venir como UUID nulo; el real está en `history[0]`.
 *  - Versión por `batch_index`: Auto split (twelve) 12 clips por versión; Advanced split 2 por versión.
 */
function describeClip(clip) {
  const j = isObject(clip) ? clip : {};
  const m = isObject(j.metadata) ? j.metadata : {};
  const h0 = (Array.isArray(m.history) && isObject(m.history[0]) && m.history[0]) || {};
  const title = typeof j.title === 'string' ? j.title : '';
  const isStem = m.task === 'gen_stem' || !!m.stem_type_group_name;

  const splitTask = m.stem_task === 'remove' ? h0.stem_task : (m.stem_task || h0.stem_task);
  const kind = splitTask === 'twelve' ? 'auto' : 'advanced';
  const perVersion = kind === 'auto' ? 12 : 2;
  const rawIndex = j.batch_index != null ? j.batch_index : m.batch_index;
  const index = rawIndex == null || rawIndex === '' ? NaN : Number(rawIndex);
  const version = !isStem || !Number.isFinite(index) || index < 0 ? '' : 'V' + (Math.floor(index / perVersion) + 1);

  const songId = [m.stem_from_id, h0.stem_from_id].find((x) => x && x !== NIL_UUID) || j.id;

  const paren = /\(([^)]+)\)\s*$/.exec(title);
  const isComplement = m.stem_task === 'remove' || (paren ? /\bwithout\b/i.test(paren[1]) : false);

  let songTitle = title || 'Suno';
  let stemName = null;
  if (isStem) {
    stemName = String(m.stem_type_group_name || (paren ? paren[1] : 'Stem')).replace(/_/g, ' ');
    songTitle = title.replace(/\s*\([^)]*\)\s*$/, '') || songTitle;
  }
  return { isStem, isComplement, stemName, songTitle, version, kind, songId, userId: j.user_id, handle: j.handle };
}

export {
  CLIP_ID_RE,
  LEGACY_CDN_ORIGIN,
  SunoCoreError,
  isClipId,
  assertClipId,
  bytesToHex,
  hexToBytes,
  base64ToBytes,
  parseKeyMaterial,
  isMp4,
  assertMp4,
  legacyCdnUrl,
  assertPlaybackUrl,
  selectPlaybackUrl,
  createPlaybackCrypto,
  describeClip,
};
