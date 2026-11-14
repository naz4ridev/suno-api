# @suno-api/core

Núcleo común de Suno. **La fuente vive aquí, en suno-api**; la usan suno-api (SDK), la extensión de
Chrome (`suno-stems-extension`), suno2daw y, a través de suno-api, Trackroom. Sin DOM, cookies, fs,
red ni dependencias. Web Crypto inyectable (navegador o Node).

| Export | Qué hace |
|---|---|
| `describeClip(clip)` | `{ isStem, isComplement, stemName, songTitle, version, kind, songId, userId, handle }`. Complemento por `metadata.stem_task === 'remove'` o título «Without X»; `songId` salta el UUID nulo y mira `history[0]`. |
| `createPlaybackCrypto({ subtle })` | `deriveMasterKey(token)` (SHA-256), `unwrapKey` / `unwrapPlaybackRights` (AES-GCM, AAD = clipId), `decryptPlayback` (AES-CTR 128 bits + validación MP4 y longitud de clave). |
| `selectPlaybackUrl(clip, { clipId, allowLegacyCdn })` | URL `progressive` + `1.0.0` de `media_urls`, con política https / `*.cloudfront.net` / sin puerto ni credenciales / id en la ruta. El CDN antiguo solo si el clip **no trae** `media_urls` y se pide `allowLegacyCdn: true`. |
| `isClipId`, `bytesToHex`, `hexToBytes`, `base64ToBytes`, `isMp4`, `SunoCoreError`… | Utilidades. Errores con mensaje fijo y `code`; nunca incluyen token, claves ni valores envueltos. |

El token no se guarda en estado de módulo: quien llama lo pasa a `deriveMasterKey` y conserva la
`C## Versiones y distribución

Es una librería versionada: nadie copia su código.

```
cd packages/suno-core
npm run pack:release        # build (dist/suno-core.global.js) + npm pack → suno-api-core-X.Y.Z.tgz
```

| Consumidor | Cómo la usa |
|---|---|
| suno-api | `"@suno-api/core": "file:packages/suno-core"` (siempre la fuente) |
| suno2daw | `"@suno-api/core": "file:vendor/suno-api-core-X.Y.Z.tgz"` |
| suno-stems-extension | misma dependencia; `npm install` copia `@suno-api/core/global` (MAIN world, `globalThis.__sunoCore`) a `lib/` |
| Trackroom | no la incluye: pide el audio a suno-api (`/api/playback_audio`) |

Para publicar un cambio: sube `version` en `package.json`, `npm run pack:release`, copia el `.tgz`
al `vendor/` de cada consumidor, cambia la versión en su `package.json` y `npm install`.

## Tests

```
npm test    # node --test "test/*.test.js"
```

Round-trip con token inventado y MP4 sintético (servidor simulado con `node:crypto`), rechazos por
token/AAD/clave incorrectos, `describeClip` con la captura real
`test/fixtures/advanced-drums-submitted.json`, URLs inválidas y drift del distribuidor.
