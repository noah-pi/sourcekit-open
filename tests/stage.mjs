#!/usr/bin/env node
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Stages a runnable validation lab into tests/.staged/.
 *
 * The app's provenance/crypto code is plain TypeScript with no build step, but
 * a few modules import expo/react-native for device services (keychain,
 * filesystem, device model). For lab runs we rewire exactly those imports to
 * tiny shims (tests/shims/) — everything cryptographic runs as the real code.
 *
 * Usage:
 *   node tests/stage.mjs
 *   cd tests/.staged && npm install
 *   ./node_modules/.bin/tsx test-070-final.mts
 *
 * Requirements: node 20+, ffmpeg (fixtures), and optionally c2patool on PATH
 * (or C2PATOOL=/path/to/c2patool) for the independent-verifier checks.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, '.staged');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const STAGE = [
  // Hand-rolled verification core — ARCHIVED but still wired as the
  // differential oracle and the desk's current engine. Staged from
  // src/c2pa/ under flat basenames, so the suites
  // import './verifyAsset.mts' etc.
  'src/c2pa/verifyAsset.ts', 'src/c2pa/verifyAppAttest.ts',
  'src/c2pa/c2pa.ts', 'src/c2pa/bmff.ts',
  'src/c2pa/jpegApp11.ts', 'src/c2pa/png.ts',
  'src/provenance/attest.ts', 'src/provenance/manifest.ts',
  'src/provenance/detached.ts',
  // Stereo-capture artifact ingestion (Spec-Camera-Module-0.13): three-state
  // commit → proof-bundle section + context.stereo-* claims + the
  // StereoCommitment builder the desk verifier consumes.
  'src/provenance/stereoArtifacts.ts',
  // The seal-side glue (native-shape JSON → committed desk shape; pair
  // events → three-state pair inputs) — exercised by test-stereo-video.mts.
  'src/provenance/stereoGlue.ts',
  // Per-track streamedChunks v2 (delivery-file demux) + signed poseTrace.
  'src/provenance/trackChunks.ts', 'src/provenance/poseTrace.ts',
  // Engine layer: normalized engines + policy layer + oracle.
  'src/provenance/engine/upstreamEngine.ts', 'src/provenance/engine/handrolledEngine.ts',
  'src/provenance/engine/policyLayer.ts', 'src/provenance/engine/oracle.ts',
  'src/lib/sign.ts', 'src/lib/bytes.ts', 'src/lib/canonical.ts', 'src/lib/cert.ts',
  'src/lib/der.ts', 'src/lib/timestamp.ts', 'src/lib/fileHash.ts',
  'src/lib/x509.ts', 'src/lib/rfc3161.ts', 'src/lib/tsaTrustList.ts', 'src/lib/exif.ts', 'src/lib/beacon.ts', 'src/lib/phash.ts', 'src/lib/rephoto.ts', 'src/lib/roc.ts',
  'src/lib/opticalflow.ts', 'src/lib/imuflow.ts', 'src/lib/appleAttestRoot.ts',
  'src/lib/roster.ts', 'src/lib/signingProvider.ts', 'src/lib/ots.ts', 'src/lib/proofBundle.ts',
  'src/lib/seal.ts', 'src/lib/shamir.ts', 'src/lib/pq.ts',
  'src/lib/trustLadder.ts', 'src/lib/trustProvider.ts', 'src/lib/rosterStore.ts',
  // Persistent on-device diagnostics log — attest.ts appends to it
  // at seal time, so the lab stages it too (filesystem via shim-fs).
  'src/lib/diagnosticsLog.ts',
  // The vault itself — staged for the disclosure-store hygiene suite:
  // deleteItem/destroyVault must take the disclosure
  // state + chunk maps with them. cipher.ts is vaultFs's encryption core.
  'src/lib/cipher.ts', 'src/vault/vaultFs.ts',
  // passcode is vaultFs's PIN verifier (staged so the strict typecheck
  // covers it; the lockout path is exercised via the real pinLockout.ts).
  'src/vault/passcode.ts',
  // Device-integrity signal collector + its Enclave bridge — staged for
  // typecheck coverage; attest.mts imports the SIGNALS TYPE only, and the
  // Enclave bridge resolves to the absent-module case via shim-modules-core.
  'src/lib/integrity.ts', 'src/lib/enclave.ts',
  'src/sensors/motion.ts',
  // desk-side analyzers staged so the lab exercises the SAME code the desk
  // ships (parallax; display-beat / ENF-extract / onset
  // A/V desync / rolling-shutter skew; @exhibit/lib/* imports rewired below).
  // rephoto + videoMotion are raster.ts/avExtract.ts's desk-core
  // dependencies (type-level for avExtract, runtime for raster).
  // NOTE: desk/src/core/rephoto.ts collides on basename with
  // src/lib/rephoto.ts — it is staged below as deskRephoto.mts instead.
  // Stereo planarity verifier (P4) — committed-input types, LUT
  // undistortion, pure-TS homography RANSAC, the distance-gated signal,
  // and the public entry point. Zero external deps by design.
  // Feature-extraction front end for the stereo verifier: FAST-9/Harris
  // corners, oriented rBRIEF descriptors, Hamming matching with ratio +
  // cross-check, epipolar pre-filter from the committed calibration.
  // Desk stereo bundle command (exhibit-desk stereo): extraction, integrity,
  // planarity signal. Imports @exhibit/provenance/stereoArtifacts and
  // ../stereo/index — rewired below.
  // Multi-baseline (three-lens: ultra-wide/wide/tele) stereo verifier —
  // per-pair two-view pipeline reuse + the over-determined
  // composition-consistency check. Sibling './x' imports flatten via the
  // same rewrite rules as the other stereo modules.
  // P5 single-image physics checks (Lumethic-derived): radial CA structure,
  // JPEG-grid-in-RAW with a provenance gate, Poisson–PRNU profile. The
  // orchestrator index.ts is staged separately at the end of this file as
  // singleimageIndex.mts (basename collision with desk/stereo/index.ts).
];

function rewrite(src, fname) {
  src = src
    // Longest prefixes FIRST: engine/ modules are one level deeper than
    // provenance/ modules, and archived modules reach back into src/ —
    // everything flattens to './x.mts' here.
    .replace(/from '\.\.\/\.\.\/c2pa\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/c2pa\/(\w+)'/g, "from './$1.mts'")
    // engine/ modules reach src/lib as '../../lib/x' (policyLayer → trustProvider).
    .replace(/from '\.\.\/\.\.\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/\.\.\/src\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/\.\.\/src\/provenance\/(\w+)'/g, "from './$1.mts'")
    // desk/cli modules reach desk/src/core as '../src/core/x' (avExtract, raster).
    // rephoto is the basename-collision exception: it lands at deskRephoto.mts.
    .replace(/from '\.\.\/src\/core\/rephoto'/g, "from './deskRephoto.mts'")
    .replace(/from '\.\.\/src\/core\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '@exhibit\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '@exhibit\/provenance\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/stereo\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/provenance\/(\w+)'/g, "from './$1.mts'")
    // provenance/disclosure cross-imports flatten to the disclosure-*.mts names below.
    .replace(/from '\.\.\/disclosure\/(\w+)'/g, "from './disclosure-$1.mts'")
    .replace(/from '\.\/(\w+)'/g, "from './$1.mts'")
    // Inline TYPE imports (import('./x')) flatten by the same rules — the
    // 'from'-anchored rules above never see them (manifest → stereoArtifacts).
    .replace(/import\('\.\.\/\.\.\/lib\/(\w+)'\)/g, "import('./$1.mts')")
    .replace(/import\('\.\/(\w+)'\)/g, "import('./$1.mts')")
    .replace("from 'expo-device'", "from './shim-device.mts'")
    .replace("from 'react-native'", "from './shim-rn.mts'")
    .replace("from 'expo-constants'", "from './shim-constants.mts'")
    .replace("from 'expo-modules-core'", "from './shim-modules-core.mts'")
    .replace("from 'expo-file-system/legacy'", "from './shim-fs.mts'")
    .replace("from 'expo-image-manipulator'", "from './shim-image-manipulator.mts'")
    .replace("from 'expo-video-thumbnails'", "from './shim-video-thumbnails.mts'")
    .replace("from 'expo-secure-store'", "from './shim-secure-store.mts'");
  if (fname === 'attest' || fname === 'signingProvider') {
    src = src
      .replace("from './deviceKey.mts'", "from './deviceKey-shim.mts'")
      .replace("from './appAttest.mts'", "from './appAttest-shim.mts'");
  }
  return src;
}

for (const rel of STAGE) {
  const name = path.basename(rel, '.ts');
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  fs.writeFileSync(path.join(out, `${name}.mts`), rewrite(src, name));
}

// Disclosure engine (core + commit-at-capture/burn):
// staged as disclosure-*.mts — the SAME flattening test-disclosure.mts
// applies, so both paths produce byte-identical modules. In-disclosure
// imports ('./tree') map to the disclosure- prefixed names.
const DISCLOSURE_STAGE = ['ladder', 'inventory', 'salts', 'tree', 'bundle', 'commit', 'captureCommit', 'burn'];
for (const name of DISCLOSURE_STAGE) {
  const src = fs.readFileSync(path.join(root, 'src/disclosure', `${name}.ts`), 'utf8')
    .replace(/from '\.\.\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\/(\w+)'/g, "from './disclosure-$1.mts'");
  fs.writeFileSync(path.join(out, `disclosure-${name}.mts`), src);
}


// shims — filesystem shim roots inside the staged dir
for (const f of fs.readdirSync(path.join(here, 'shims'))) {
  let s = fs.readFileSync(path.join(here, 'shims', f), 'utf8');
  s = s.replaceAll('/tmp/lab/fs/', path.join(out, 'fs') + '/').replaceAll('/tmp/lab/fs', path.join(out, 'fs'));
  fs.writeFileSync(path.join(out, f), s);
}
// The withheld camera bridge's CONTRACT types land under the name the
// staged code imports: './exhibitCamera.mts'. Type-only; see the shim's
// header for the boundary rationale.
fs.copyFileSync(path.join(out, 'exhibitCamera-types-shim.mts'), path.join(out, 'exhibitCamera.mts'));

// test suites — media paths point at the staged dir; c2patool from env/PATH
const stagedAbs = out.endsWith('/') ? out : out + '/';
for (const f of fs.readdirSync(here).filter((f) => (f.startsWith('test-') || f.startsWith('build-') || f.startsWith('tool-')) && f.endsWith('.mts'))) {
  let s = fs.readFileSync(path.join(here, f), 'utf8');
  s = s.replaceAll('/tmp/lab/', stagedAbs);
  s = s.replaceAll("'/tmp/bin/c2patool'", `process.env.C2PATOOL ?? 'c2patool'`);
  fs.writeFileSync(path.join(out, f), s);
}

// crypto fixtures (real openssl-generated certs/tokens for the verification suite)
fs.cpSync(path.join(here, 'fixtures'), path.join(out, 'fixtures'), { recursive: true });

// generated media fixtures
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' }); return true; } catch { return false; } })();
if (hasFfmpeg) {
  const f = (args) => execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });
  f(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(out, 'clean.mp4')]);
  f(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-pix_fmt', 'yuv420p', path.join(out, 'clean.mov')]);
  f(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', '-movflags', '+faststart', path.join(out, 'clean.m4a')]);
  f(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x480:rate=1', '-frames:v', '1', path.join(out, 'clean.jpg')]);
  f(['-f', 'lavfi', '-i', 'testsrc2=duration=1:size=512x384:rate=1', '-frames:v', '1', path.join(out, 'other.jpg')]);
  // tiny PNG without PIL: solid-color via ffmpeg
  f(['-f', 'lavfi', '-i', 'color=c=0x5A8CC8:size=320x240', '-frames:v', '1', path.join(out, 'clean.png')]);
  console.log('fixtures generated with ffmpeg');
} else {
  console.log('NOTE: ffmpeg not found — generate clean.{jpg,png,mp4,mov,m4a} in', out, 'yourself');
}

// EXACT versions matching the app's package-lock.json:
// the lab must test the crypto the app SHIPS, not whatever the ranges
// resolve to on the day the lab is staged. tsx stays a range — it is the
// runner, not the code under test.
// @contentauth/c2pa-wasm is the upstream C2PA engine pinned EXACTLY. The
// target binding is @contentauth/c2pa-node@, but it declares
// engines: node>=22 and the harness runs node 20 — the wasm build
// (same c2pa-rs core) is the documented fallback. upstreamEngine
// prefers c2pa-node automatically on node>=22 hosts.
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({
  name: 'verify-lab', private: true, type: 'module',
  dependencies: {
    '@noble/curves': '1.9.7', '@noble/hashes': '1.8.0', '@noble/ciphers': '1.3.0',
    '@noble/post-quantum': '0.6.1',
    'cbor-x': '1.6.5', 'tsx': '^4.19.0', 'jpeg-js': '0.4.4',
    '@contentauth/c2pa-wasm': '0.11.1',
  },
}, null, 2));

console.log('staged →', out);
console.log('next: cd tests/.staged && npm install && ./node_modules/.bin/tsx test-070-final.mts');

