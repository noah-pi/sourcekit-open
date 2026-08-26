#!/usr/bin/env node
// Source Kit 0.1.0 — Stages a runnable validation lab into tests/.staged/. Provenance
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Stages a runnable validation lab into tests/.staged/.
 *
 * Provenance and crypto code is plain TypeScript with no build step; the few
 * modules importing expo/react-native for device services are rewired to the
 * shims in tests/shims/. Everything cryptographic runs as the real code.
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
  // Hand-rolled verification core, staged from archive/handrolled-verifier/
  // under flat basenames, so the suites import './verifyAsset.mts' etc.
  'archive/handrolled-verifier/verifyAsset.ts', 'archive/handrolled-verifier/verifyAppAttest.ts',
  'archive/handrolled-verifier/c2pa.ts', 'archive/handrolled-verifier/bmff.ts',
  'archive/handrolled-verifier/jpegApp11.ts', 'archive/handrolled-verifier/png.ts',
  'src/provenance/attest.ts', 'src/provenance/manifest.ts',
  'src/provenance/detached.ts',
  // Stereo-capture artifact ingestion (Spec-Camera-Module-0.13): three-state
  // commit, proof-bundle section, context.stereo-* claims, and the
  // StereoCommitment builder the desk verifier consumes.
  'src/provenance/stereoArtifacts.ts',
  // Seal-side glue: native-shape JSON to committed desk shape, pair events
  // to three-state pair inputs. Exercised by test-stereo-video.mts.
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
  'src/lib/roster.ts', 'src/lib/ots.ts', 'src/lib/proofBundle.ts',
  'src/lib/seal.ts', 'src/lib/shamir.ts', 'src/lib/pq.ts',
  'src/lib/trustLadder.ts', 'src/lib/trustProvider.ts', 'src/lib/rosterStore.ts',
  // Runtime gate for the c2pa-swift signing arm. Staged so attest.ts resolves;
  // off in the lab, which is the hand-rolled path the suites pin.
  'src/lib/sdkSigningGate.ts',
  // The c2pa-swift engine wrapper. attest.ts imports it unconditionally, so it
  // has to resolve; the native module is absent in the lab, which is the
  // nativeLoadError branch, and the gate above is off, so nothing calls it.
  'src/provenance/engine/upstreamEngineIos.ts',
  // Persistent on-device diagnostics log; attest.ts appends to it at seal
  // time, so the lab stages it too (filesystem via shim-fs).
  'src/lib/diagnosticsLog.ts',
  // Vault, staged for the disclosure-store hygiene suite: deleteItem and
  // destroyVault must take the disclosure state and chunk maps with them.
  // cipher.ts is vaultFs's encryption core.
  'src/lib/cipher.ts', 'src/vault/vaultFs.ts',
  // passcode is vaultFs's PIN verifier, staged for typecheck coverage; the
  // lockout path runs through the real pinLockout.ts.
  'src/vault/passcode.ts',
  // Device-integrity signal collector and its Enclave bridge, staged for
  // typecheck coverage. attest.mts imports the signals type only, and the
  // Enclave bridge resolves to the absent-module case via shim-modules-core.
  'src/lib/integrity.ts', 'src/lib/enclave.ts',
  'src/sensors/motion.ts',
];

function rewrite(src, fname) {
  src = src
    // Longest prefixes first: engine/ modules sit one level deeper than
    // provenance/ modules, and some modules reach back into src/. Everything
    // flattens to './x.mts'.
    .replace(/from '(?:\.\.\/)+archive\/handrolled-verifier\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/\.\.\/src\/lib\/(\w+)'/g, "from './$1.mts'")
    // engine/ modules reach src/lib as '../../lib/x' (policyLayer to trustProvider).
    .replace(/from '\.\.\/\.\.\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/\.\.\/src\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/\.\.\/src\/provenance\/(\w+)'/g, "from './$1.mts'")
    // desk/cli modules reach desk/src/core as '../src/core/x'. rephoto is the
    // basename-collision exception and lands at deskRephoto.mts.
    .replace(/from '\.\.\/src\/core\/rephoto'/g, "from './deskRephoto.mts'")
    .replace(/from '\.\.\/src\/core\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/lib\/(\w+)'/g, "from './$1.mts'")
    // The reader's card model sits at src/reader/types.ts; '../types' from
    // reader/verify/ would otherwise flatten onto a generic types.mts.
    .replace(/from '\.\.\/types'/g, "from './reader-types.mts'")
    .replace(/from '(?:\.\.\/)+src\/reader\/verify\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '@exhibit\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '@exhibit\/provenance\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/stereo\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\.\/provenance\/(\w+)'/g, "from './$1.mts'")
    // provenance/disclosure cross-imports flatten to the disclosure-*.mts names.
    .replace(/from '\.\.\/disclosure\/(\w+)'/g, "from './disclosure-$1.mts'")
    // provenance/ modules reach the engine layer as './engine/x'; the generic
    // './x' rule below cannot match a path segment.
    .replace(/from '\.\/engine\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\/(\w+)'/g, "from './$1.mts'")
    // Inline type imports (import('./x')) need their own rules; the
    // 'from'-anchored rules above never match them.
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

// Disclosure engine, staged as disclosure-*.mts under the same flattening
// test-disclosure.mts applies, so both paths produce identical modules.
// In-disclosure imports ('./tree') map to the disclosure- prefixed names.
// Reader custody ladder and its card model, staged as reader-*.mts. The
// ladder projects the verification core's checks onto five rungs; the suite
// pins that each rung reads only signature-covered evidence.
for (const [name, rel] of [
  ['reader-types', 'src/reader/types.ts'],
  ['reader-ladder', 'src/reader/verify/ladder.ts'],
  // The WMM evaluator and its generated table, for the declination gate.
  ['geomag', 'src/reader/verify/geomag.ts'],
  ['wmmCoefficients', 'src/reader/verify/wmmCoefficients.ts'],
]) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  fs.writeFileSync(path.join(out, `${name}.mts`), rewrite(src, name));
}

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
// The camera bridge's contract types land under the name the staged code
// imports, './exhibitCamera.mts'. Type-only; see the shim's header.
fs.copyFileSync(path.join(out, 'exhibitCamera-types-shim.mts'), path.join(out, 'exhibitCamera.mts'));

// NOAA's published WMM test vectors, read by test-geomag at run time.
fs.copyFileSync(path.join(here, 'WMM_TEST_VALUES.txt'), path.join(out, 'WMM_TEST_VALUES.txt'));

// test suites — media paths point at the staged dir; c2patool from env/PATH
const stagedAbs = out.endsWith('/') ? out : out + '/';
for (const f of fs.readdirSync(here).filter((f) => (f.startsWith('test-') || f.startsWith('build-') || f.startsWith('tool-')) && f.endsWith('.mts'))) {
  let s = fs.readFileSync(path.join(here, f), 'utf8');
  s = s.replaceAll('/tmp/lab/', stagedAbs);
  s = s.replaceAll("'/tmp/bin/c2patool'", `process.env.C2PATOOL ?? 'c2patool'`);
  // Suites that import app modules by their repo path resolve to the flat
  // staged copies, same rule the modules themselves are rewritten under.
  s = s.replace(/from '(?:\.\.\/)+src\/reader\/verify\/(\w+)'/g, "from './$1.mts'");
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

// Versions pinned to the app's package-lock.json so the lab tests the crypto
// the app ships. tsx stays a range: it is the runner, not code under test.
// @contentauth/c2pa-wasm is the upstream C2PA engine; the c2pa-node binding
// needs node>=22 while the harness runs node 20, and upstreamEngine prefers
// c2pa-node automatically on node>=22 hosts.
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

