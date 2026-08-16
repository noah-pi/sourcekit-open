#!/usr/bin/env node
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
// repair variant: no destructive wipe (mount rejects rm -rf)
fs.mkdirSync(out, { recursive: true });

const STAGE = [
  // Hand-rolled verification core — ARCHIVED but still wired as the
  // differential oracle and the desk's current engine. Staged from
  // archive/handrolled-verifier/ under flat basenames, so the suites
  // import './verifyAsset.mts' etc.
  'archive/handrolled-verifier/verifyAsset.ts', 'archive/handrolled-verifier/verifyAppAttest.ts',
  'archive/handrolled-verifier/c2pa.ts', 'archive/handrolled-verifier/bmff.ts',
  'archive/handrolled-verifier/jpegApp11.ts', 'archive/handrolled-verifier/png.ts',
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
  // The vault itself — staged for the disclosure-store hygiene suite:
  // deleteItem/destroyVault must take the disclosure
  // state + chunk maps with them. cipher.ts is vaultFs's encryption core.
  'src/lib/cipher.ts', 'src/vault/vaultFs.ts',
  'src/sensors/motion.ts',
  // desk-side analyzers staged so the lab exercises the SAME code the desk
  // ships (parallax; display-beat / ENF-extract / onset
  // A/V desync / rolling-shutter skew; @exhibit/lib/* imports rewired below).
  'desk/src/core/parallax.ts',
  'desk/src/core/displayBeat.ts', 'desk/src/core/enfExtract.ts',
  'desk/src/core/avSync.ts', 'desk/src/core/rollingShutter.ts',
  'desk/cli/raster.ts', 'desk/cli/avExtract.ts',
  // Stereo planarity verifier (P4) — committed-input types, LUT
  // undistortion, pure-TS homography RANSAC, the distance-gated signal,
  // and the public entry point. Zero external deps by design.
  'desk/stereo/types.ts', 'desk/stereo/undistort.ts',
  'desk/stereo/homography.ts', 'desk/stereo/planarity.ts',
  'desk/stereo/index.ts',
  // Feature-extraction front end for the stereo verifier: FAST-9/Harris
  // corners, oriented rBRIEF descriptors, Hamming matching with ratio +
  // cross-check, epipolar pre-filter from the committed calibration.
  'desk/stereo/match.ts',
  // Desk stereo bundle command (exhibit-desk stereo): extraction, integrity,
  // planarity signal. Imports @exhibit/provenance/stereoArtifacts and
  // ../stereo/index — rewired below.
  'desk/cli/stereoVerify.ts',
  // Multi-baseline (three-lens: ultra-wide/wide/tele) stereo verifier —
  // per-pair two-view pipeline reuse + the over-determined
  // composition-consistency check. Sibling './x' imports flatten via the
  // same rewrite rules as the other stereo modules.
  'desk/stereo/multibaseline.ts',
  // P5 single-image physics checks (Lumethic-derived): radial CA structure,
  // JPEG-grid-in-RAW with a provenance gate, Poisson–PRNU profile. The
  // orchestrator index.ts is staged separately at the end of this file as
  // singleimageIndex.mts (basename collision with desk/stereo/index.ts).
  'desk/singleimage/caRadial.ts',
  'desk/singleimage/jpegGrid.ts',
  'desk/singleimage/poissonPrnu.ts',
];

function rewrite(src, fname) {
  src = src
    // Longest prefixes FIRST: engine/ modules are one level deeper than
    // provenance/ modules, and archived modules reach back into src/ —
    // everything flattens to './x.mts' here.
    .replace(/from '\.\.\/\.\.\/\.\.\/archive\/handrolled-verifier\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/\.\.\/archive\/handrolled-verifier\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/\.\.\/src\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/\.\.\/src\/provenance\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '@exhibit\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '@exhibit\/provenance\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/stereo\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/provenance\/(\w+)'/g, "from './$1.mts'")
    // provenance/disclosure cross-imports flatten to the disclosure-*.mts names below.
    .replace(/from '\.\.\/disclosure\/(\w+)'/g, "from './disclosure-$1.mts'")
    .replace(/from '\.\/(\w+)'/g, "from './$1.mts'")
    .replace("from 'expo-device'", "from './shim-device.mts'")
    .replace("from 'react-native'", "from './shim-rn.mts'")
    .replace("from 'expo-constants'", "from './shim-constants.mts'")
    .replace("from 'expo-file-system/legacy'", "from './shim-fs.mts'")
    .replace("from 'expo-image-manipulator'", "from './shim-image-manipulator.mts'")
    .replace("from 'expo-secure-store'", "from './shim-secure-store.mts'");
  if (fname === 'attest') {
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
// target binding is @contentauth/c2pa-node@0.8.1, but it declares
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

// --- P5 append (singleimage orchestrator) -----------------------------------
// desk/singleimage/index.ts stages as singleimageIndex.mts: the flat staged
// dir already carries desk/stereo/index.ts as index.mts, and the basename
// flattening would clobber it. Same rewrite() pipeline as the STAGE list.
{
  const src = fs.readFileSync(path.join(root, 'desk/singleimage/index.ts'), 'utf8');
  fs.writeFileSync(path.join(out, 'singleimageIndex.mts'), rewrite(src, 'singleimageIndex'));
}
