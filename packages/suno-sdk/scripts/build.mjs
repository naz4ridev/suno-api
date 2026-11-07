#!/usr/bin/env node
/**
 * Reproducible build of @suno-api/sdk into a single, self-describing library artifact.
 *
 * The canonical source is packages/suno-sdk/src/** (TypeScript). This script bundles it, together with the
 * JavaScript runtime dependencies it needs (axios, cookie, socks-proxy-agent…), into plain readable ESM:
 *
 *   suno-sdk.generated.mjs      the library (no minification, so it stays inspectable/replaceable)
 *   suno-sdk.source.json        complete corresponding source of the SDK (LGPL-3.0-or-later §4/§6), keyed by path
 *   LICENSE.LGPL-3.0.txt        the licence of the SDK (copy of the repository LICENSE)
 *   THIRD_PARTY_NOTICES.txt     licence texts of every bundled dependency
 *   PROVENANCE.json             versions, build inputs and sha256 of every output
 *
 * Same input -> same bytes: no dates, no absolute paths, no git state. The artifact never embeds a browser:
 * Chromium/Playwright/2captcha/Next/Electron are not dependencies of the SDK.
 *
 *   node scripts/build.mjs [--out <dir>]      write the artifact (default: packages/suno-sdk/dist)
 *   node scripts/build.mjs --check [--out dir] exit 1 if <dir> differs from a fresh build
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import esbuildPackage from 'esbuild/package.json' with { type: 'json' };

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const posix = file => file.split(path.sep).join('/');

export const OUTPUT_NAMES = ['suno-sdk.generated.mjs', 'suno-sdk.source.json', 'LICENSE.LGPL-3.0.txt', 'THIRD_PARTY_NOTICES.txt', 'PROVENANCE.json'];
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license', 'license.md', 'license.txt'];

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap(entry => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full, base) : [posix(path.relative(base, full))];
    });
}

/** Everything a rebuild depends on, in a stable order. */
function readSources(root) {
  const files = [...walk(path.join(root, 'src')).map(file => `src/${file}`), 'package.json', 'scripts/build.mjs'];
  return Object.fromEntries(files.map(file => [file, readFileSync(path.join(root, file), 'utf8')]));
}

const sourceDigest = sources =>
  sha256(Object.keys(sources).sort().map(file => `${file}\0${sha256(sources[file])}\n`).join(''));

/** Package name and directory of the innermost node_modules package that owns `inputFile`. */
function findPackageDir(root, inputFile) {
  const absolute = posix(path.resolve(root, inputFile));
  const marker = 'node_modules/';
  const start = absolute.lastIndexOf(marker) + marker.length;
  const parts = absolute.slice(start).split('/');
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  return { name, dir: absolute.slice(0, start) + name };
}

export async function buildSdk(root = PKG_ROOT) {
  const sources = readSources(root);
  const sdkPackage = JSON.parse(sources['package.json']);

  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/index.ts'],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    minify: false,
    sourcemap: false,
    legalComments: 'inline',
    charset: 'utf8',
    // debug (via socks-proxy-agent) probes this optional package inside try/catch.
    external: ['supports-color'],
    banner: { js: "import { createRequire as __sunoCreateRequire } from 'node:module';\nconst require = __sunoCreateRequire(import.meta.url);" },
    logLevel: 'silent'
  });
  const bundle = result.outputFiles[0].text;

  const packages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    const { name, dir } = findPackageDir(root, input);
    packages.set(`${name}@${dir}`, { name, dir });
  }
  const dependencies = [...packages.values()].sort((a, b) => (a.name + a.dir < b.name + b.dir ? -1 : 1)).map(({ name, dir }) => {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const licenseFile = LICENSE_FILES.find(file => existsSync(path.join(dir, file)));
    return {
      name, version: manifest.version, license: typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? 'UNKNOWN',
      text: licenseFile ? readFileSync(path.join(dir, licenseFile), 'utf8').trim() : null
    };
  });
  const missing = dependencies.filter(dep => !dep.text && dep.license === 'UNKNOWN');
  if (missing.length) throw new Error(`No licence information for: ${missing.map(dep => dep.name).join(', ')}`);

  const notices = [
    '@suno-api/sdk bundles the following third-party packages (unmodified) in suno-sdk.generated.mjs.',
    'The SDK itself is licensed under LGPL-3.0-or-later; its complete source is in suno-sdk.source.json.',
    '',
    ...dependencies.flatMap(dep => [
      '='.repeat(78), `${dep.name}@${dep.version}  (${dep.license})`, '='.repeat(78),
      dep.text ?? `Licensed under ${dep.license}.`, '']),
  ].join('\n');

  const licenseText = readFileSync(path.resolve(root, '../../LICENSE'), 'utf8');
  if (!/GNU LESSER GENERAL PUBLIC LICENSE/.test(licenseText)) throw new Error('The repository LICENSE must be the LGPL');
  const sourceSha256 = sourceDigest(sources);
  const header = [
    '@generated by @suno-api/sdk scripts/build.mjs. DO NOT EDIT BY HAND.',
    `Library: ${sdkPackage.name} v${sdkPackage.version} (LGPL-3.0-or-later) · source-sha256 ${sourceSha256}`,
    'Complete corresponding source: suno-sdk.source.json · Third-party licences: THIRD_PARTY_NOTICES.txt',
    'Rebuild: node packages/suno-sdk/scripts/build.mjs (in the suno-api repository)',
    `body-sha256: ${sha256(bundle)}`
  ];
  const generated = `/*\n${header.map(line => ` * ${line}`).join('\n')}\n */\n${bundle}`;
  const sourceJson = JSON.stringify({ name: sdkPackage.name, version: sdkPackage.version, license: 'LGPL-3.0-or-later', files: sources }, null, 1) + '\n';

  const provenance = {
    name: sdkPackage.name,
    version: sdkPackage.version,
    license: 'LGPL-3.0-or-later',
    sourceSha256,
    builder: { esbuild: esbuildPackage.version, target: 'node22', format: 'esm', minified: false },
    dependencies: dependencies.map(({ name, version, license }) => ({ name, version, license })),
    outputs: {
      'suno-sdk.generated.mjs': sha256(generated),
      'suno-sdk.source.json': sha256(sourceJson),
      'LICENSE.LGPL-3.0.txt': sha256(licenseText),
      'THIRD_PARTY_NOTICES.txt': sha256(notices)
    }
  };
  return new Map([
    ['suno-sdk.generated.mjs', generated],
    ['suno-sdk.source.json', sourceJson],
    ['LICENSE.LGPL-3.0.txt', licenseText],
    ['THIRD_PARTY_NOTICES.txt', notices],
    ['PROVENANCE.json', JSON.stringify(provenance, null, 2) + '\n']
  ]);
}

function parseArgs(argv) {
  const args = { out: path.join(PKG_ROOT, 'dist'), check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--out' && argv[i + 1]) args.out = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { out, check } = parseArgs(process.argv.slice(2));
    const files = await buildSdk();
    let drift = 0;
    for (const [name, content] of files) {
      const file = path.join(out, name);
      const current = existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : null;
      if (check) {
        const status = current === content ? 'ok' : current === null ? 'missing' : 'drift';
        if (status !== 'ok') drift++;
        console.log(`${status.padEnd(8)} ${file}`);
      } else {
        mkdirSync(out, { recursive: true });
        writeFileSync(file, content);
        console.log(`written  ${file}`);
      }
    }
    if (drift) process.exit(1);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
