/**
 * streamedChunks v2 — per-track Merkle commitments.
 *
 *   - v2 round-trips through a real attestVideo seal;
 *   - truncation localizes to a chunk index;
 *   - the missing chunk map reports the locked honest string;
 *   - the super-root binds a multi-track asset;
 *   - audio-only uses the identical structure with one entry.
 *
 * v1 (capture-stream) acceptance was removed: old-version compatibility was
 * dropped, and the seal path emits v2-only.
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-streamed-chunks-v2.mts
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha256';
import {
  buildChunkMapSidecar,
  buildStreamedChunksV2,
  chunkEsStream,
  chunkRootHex,
  extractTrackStreams,
  verifyChunkMapSidecar,
  verifyStreamedChunksAssertion,
} from './trackChunks.mts';
import { buildProofBundle } from './proofBundle.mts';
import {
  MISSING_CHUNK_MAP_NOTE,
  STREAM_CHUNK_BYTES,
  streamedChunksSuperRoot,
  type StreamedChunksAssertionV2,
} from './manifest.mts';
import { attestVideo } from './attest.mts';
import { parseManifest } from './c2pa.mts';
import { extractC2paStoreBmff } from './bmff.mts';
import { labSigner } from './deviceKey-shim.mts';
import { asciiToBytes, base64ToBytes, bytesToBase64, bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from './bytes.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};
const section = (t: string) => console.log(`\n— ${t} —`);

// Repo-relative default: stage.mjs copies this suite INTO tests/.staged, so
// the staged dir is this file's own directory. VERIFY_STAGED_DIR overrides
// when running the un-staged source against a lab staged elsewhere.
const STAGED = process.env.VERIFY_STAGED_DIR ?? fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------------------
// Minimal monolithic MP4 builder (ftyp + moov + mdat) with real sample
// tables — enough structure for the demuxer, no codec validity needed.
// ---------------------------------------------------------------------------

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const content = concatBytes(...parts);
  return concatBytes(u32(content.length + 8), asciiToBytes(type), content);
}
function fullBox(type: string, ...parts: Uint8Array[]): Uint8Array {
  return box(type, new Uint8Array(4), ...parts); // version/flags = 0
}

function sampleBytes(seed: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let block = sha256(utf8ToBytes(`sample-${seed}`));
  for (let i = 0; i < len; i++) {
    if (i % 32 === 0 && i > 0) block = sha256(block);
    out[i] = block[i % 32];
  }
  return out;
}

function buildTestMp4(trackSpecs: { trackId: 'video' | 'audio'; codec: string; samples: Uint8Array[] }[]): Uint8Array {
  const ftyp = box('ftyp', asciiToBytes('isom'), u32(0), asciiToBytes('isom'));
  const mdatContent = concatBytes(...trackSpecs.flatMap((t) => t.samples));
  // Two passes: stco offsets depend on the moov length.
  let moovLen = 0;
  let mp4 = new Uint8Array(0);
  for (let iter = 0; iter < 2; iter++) {
    const mdatContentStart = ftyp.length + moovLen + 8;
    let trackDataOffset = mdatContentStart;
    const traks = trackSpecs.map((t) => {
      const stsd = fullBox('stsd', u32(1), concatBytes(u32(16), asciiToBytes(t.codec), new Uint8Array(8)));
      const hdlr = fullBox(
        'hdlr',
        new Uint8Array(4),
        asciiToBytes(t.trackId === 'video' ? 'vide' : 'soun'),
        new Uint8Array(12),
        new Uint8Array(1)
      );
      const stsc = fullBox('stsc', u32(1), concatBytes(u32(1), u32(t.samples.length), u32(1)));
      const stsz = fullBox('stsz', u32(0), u32(t.samples.length), concatBytes(...t.samples.map((s) => u32(s.length))));
      const stco = fullBox('stco', u32(1), u32(trackDataOffset));
      const stbl = box('stbl', stsd, stsc, stsz, stco);
      const minf = box('minf', stbl);
      const mdia = box('mdia', hdlr, minf);
      trackDataOffset += t.samples.reduce((n, s) => n + s.length, 0);
      return box('trak', mdia);
    });
    const moov = box('moov', ...traks);
    moovLen = moov.length;
    mp4 = concatBytes(ftyp, moov, box('mdat', mdatContent));
  }
  return mp4;
}

// ---------------------------------------------------------------------------
section('v2 round-trip through a real attestVideo seal');

const key = labSigner();
const cleanMp4 = new Uint8Array(fs.readFileSync(`${STAGED}/clean.mp4`));
const nativeChunks = chunkEsStream('video', extractTrackStreams(cleanMp4)[0].es);

const sealed = await attestVideo({
  videoUri: `${STAGED}/clean.mp4`,
  context: { location: { lat: 37.7749, lon: -122.4194 } } as any,
  identity: { author: 'WS2 P2', organization: null },
  key,
});
check('attestVideo produced signed bytes', !!sealed.signedVideoBytes);
const m = parseManifest(extractC2paStoreBmff(sealed.signedVideoBytes!)!.payload)!;
const v2 = m.customAssertions['com.verify.streamedChunks']?.data as StreamedChunksAssertionV2;
check('manifest carries com.verify.streamedChunks v2', v2?.v === 2);
check('v2 declares the delivery-file binding', v2?.binding === 'delivery-file');
check('v2 names the demux in its note', typeof v2?.note === 'string' && v2.note.includes('binding: delivery-file'));
check('attest returned the vault chunk maps', !!sealed.chunkMaps?.video && sealed.chunkMaps.video.chunks.length === nativeChunks.length);
check('chunk digest wire format matches the native recomputation',
  bytesToHex(sealed.chunkMaps!.video!.chunks.map((c) => c.sha256Hex).join('')) ===
  bytesToHex(nativeChunks.map((c) => c.sha256Hex).join('')));
{
  // Verify the SIGNED bytes (uuid insert + stco patch must not disturb the ES streams).
  const v = verifyStreamedChunksAssertion(sealed.signedVideoBytes!, v2, { chunkMaps: sealed.chunkMaps });
  check('v2 verifies against the signed file (stco patch preserved ES bytes)', v.ok, JSON.stringify(v.failures));
  const rootOnly = verifyStreamedChunksAssertion(sealed.signedVideoBytes!, v2, {});
  check('v2 without maps: root-only, locked honesty string', rootOnly.ok && rootOnly.notes.includes(`video: ${MISSING_CHUNK_MAP_NOTE}`), JSON.stringify(rootOnly.notes));
}

// ---------------------------------------------------------------------------
section('truncation localizes to a chunk index — both versions');

{
  // One video track whose ES spans 3 chunks (2.5 MiB + tail).
  const es = sampleBytes(7, 2 * STREAM_CHUNK_BYTES + STREAM_CHUNK_BYTES / 2);
  // Sample sizes chosen so dropping the last sample leaves a complete-sample
  // prefix that reaches into chunk 2 (the demuxer truncates at sample
  // granularity — as real files do).
  const samples = [es.subarray(0, 1100000), es.subarray(1100000, 2200000), es.subarray(2200000)];
  const mp4 = buildTestMp4([{ trackId: 'video', codec: 'avc1', samples }]);
  const built = buildStreamedChunksV2(mp4);
  check('v2 build on synthetic multi-chunk mp4', built.ok, built.ok ? '' : built.reason);
  if (built.ok) {
    const map = built.build.maps.video!;
    check('3 chunks over 2.5 MiB', map.chunks.length === 3, String(map.chunks.length));
    const whole = verifyStreamedChunksAssertion(mp4, built.build.assertion, { chunkMaps: built.build.maps });
    check('untruncated file verifies', whole.ok, JSON.stringify(whole.failures));
    // Cut the file exactly after the second sample: the ES prefix reaches
    // 2 200 000 bytes — inside chunk 2 (the third 1 MiB chunk).
    const cutAt = mp4.length - samples[2].length;
    const truncated = mp4.subarray(0, cutAt);
    const v = verifyStreamedChunksAssertion(truncated, built.build.assertion, { chunkMaps: built.build.maps });
    check('truncation detected', !v.ok);
    check('truncation localizes to chunk 2', v.truncation?.trackId === 'video' && v.truncation.chunkIndex === 2, JSON.stringify(v.truncation));
  }
}

// ---------------------------------------------------------------------------
section('super-root binds a multi-track asset');

{
  const mp4 = buildTestMp4([
    { trackId: 'video', codec: 'avc1', samples: [sampleBytes(11, 600000), sampleBytes(12, 500000)] },
    { trackId: 'audio', codec: 'mp4a', samples: [sampleBytes(13, 300000), sampleBytes(14, 200000)] },
  ]);
  const built = buildStreamedChunksV2(mp4);
  check('two-track v2 build', built.ok, built.ok ? '' : built.reason);
  if (built.ok) {
    const a = built.build.assertion;
    check('track order is canonical (video, audio)', a.tracks.map((t) => t.trackId).join(',') === 'video,audio');
    check('superRoot = SHA256(rootVideo ‖ rootAudio)',
      a.superRoot === bytesToHex(sha256(concatBytes(hexToBytes(a.tracks[0].root), hexToBytes(a.tracks[1].root)))));
    check('superRoot matches the manifest helper', a.superRoot === streamedChunksSuperRoot(a.tracks.map((t) => t.root)));
    const okV = verifyStreamedChunksAssertion(mp4, a, { chunkMaps: built.build.maps });
    check('two-track asset verifies', okV.ok, JSON.stringify(okV.failures));
    // Flip one byte inside the audio region (the audio samples sit after the video samples).
    const tampered = new Uint8Array(mp4);
    tampered[tampered.length - 42] ^= 0x01;
    const bad = verifyStreamedChunksAssertion(tampered, a, { chunkMaps: built.build.maps });
    check('audio tamper is caught and localized', !bad.ok && bad.truncation?.trackId === 'audio', JSON.stringify(bad));
    // Super-root tamper: structural failure even before media recomputation.
    const forged = { ...a, superRoot: a.tracks[0].root };
    const forgedV = verifyStreamedChunksAssertion(mp4, forged, { chunkMaps: built.build.maps });
    check('a forged superRoot fails structurally', !forgedV.ok && forgedV.failures.some((f) => f.includes('superRoot')));
  }
}

// ---------------------------------------------------------------------------
section('audio-only: the identical structure with one entry');

{
  const cleanM4a = new Uint8Array(fs.readFileSync(`${STAGED}/clean.m4a`));
  const built = buildStreamedChunksV2(cleanM4a);
  check('m4a v2 build', built.ok, built.ok ? '' : built.reason);
  if (built.ok) {
    check('single audio track', built.build.assertion.tracks.length === 1 && built.build.assertion.tracks[0].trackId === 'audio');
    const v = verifyStreamedChunksAssertion(cleanM4a, built.build.assertion, { chunkMaps: built.build.maps });
    check('audio-only verifies with the same math', v.ok, JSON.stringify(v.failures));
  }
}

// ---------------------------------------------------------------------------
section('proof-bundle chunk-map sidecar: export → desk range-verify (B-I-1)');

{
  const store = extractC2paStoreBmff(sealed.signedVideoBytes!)!;
  // The app's shareProofJson wires exactly this: the vault's stored maps +
  // the sha256 of the SIGNED delivery bytes the desk will hash.
  const sidecar = buildChunkMapSidecar(bytesToHex(sha256(sealed.signedVideoBytes!)), sealed.chunkMaps!);
  const bundle = buildProofBundle(sealed.record, bytesToBase64(store.payload), sidecar);
  check('the proof bundle export includes the chunk-map sidecar',
    bundle.chunkMaps?.format === 'verify-chunk-maps/1' && bundle.chunkMaps.assetSha256 === bytesToHex(sha256(sealed.signedVideoBytes!)));

  // Desk side: consume the JSON that actually crossed the wire.
  const desk = JSON.parse(JSON.stringify(bundle));
  const deskManifest = parseManifest(base64ToBytes(desk.c2paManifestBase64))!;
  const deskV2 = deskManifest.customAssertions['com.verify.streamedChunks']?.data as StreamedChunksAssertionV2;
  check('the desk manifest references the v2 label', deskManifest.referencedAssertionLabels.includes('com.verify.streamedChunks'));
  const rv = verifyChunkMapSidecar(sealed.signedVideoBytes!, deskV2, desk.chunkMaps);
  check('desk consumer range-verifies against the v2 roots', rv.ok, JSON.stringify(rv.failures));

  // Tampered chunk map → named failure (root no longer recomputes).
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.chunkMaps.maps.video.chunks[0].sha256Hex = '00'.repeat(32);
  const tv = verifyChunkMapSidecar(sealed.signedVideoBytes!, deskV2, tampered.chunkMaps);
  check('a tampered chunk map fails the range verification', !tv.ok, JSON.stringify(tv.failures));

  // A sidecar bound to a DIFFERENT asset is refused before any range check.
  const foreign = { ...desk.chunkMaps, assetSha256: 'ff'.repeat(32) };
  const fv = verifyChunkMapSidecar(sealed.signedVideoBytes!, deskV2, foreign);
  check('a sidecar for a different asset is refused',
    !fv.ok && fv.failures.some((f) => f.includes('different asset')), JSON.stringify(fv.failures));

  // Absent sidecar → honest root-only (locked string), never a failure.
  const av = verifyChunkMapSidecar(sealed.signedVideoBytes!, deskV2, null);
  check('absent sidecar degrades to root-only honestly',
    av.ok && av.notes.includes(`video: ${MISSING_CHUNK_MAP_NOTE}`), JSON.stringify(av.notes));
}

// ---------------------------------------------------------------------------
section('type-malformed sidecar maps fail NAMED, never throw');

{
  // The sidecar crosses the wire as JSON — its shape is untrusted. A
  // type-malformed map must come back as a named failure; a throw here
  // (e.g. 'map.chunks.map is not a function') IS the bug.
  const store = extractC2paStoreBmff(sealed.signedVideoBytes!)!;
  const v2 = parseManifest(store.payload)!.customAssertions['com.verify.streamedChunks']?.data as StreamedChunksAssertionV2;
  const good = buildChunkMapSidecar(bytesToHex(sha256(sealed.signedVideoBytes!)), sealed.chunkMaps!);
  const hostile = (maps: unknown) =>
    verifyChunkMapSidecar(sealed.signedVideoBytes!, v2, { ...good, maps: maps as any });

  const notArray = hostile({ video: { ...good.maps.video!, chunks: 42 } });
  check('chunks:not-array is a named failure, not a throw',
    !notArray.ok && notArray.failures.some((f) => f.includes('chunks is not an array')), JSON.stringify(notArray.failures));

  const mapString = hostile({ video: 'nope' });
  check('map:string is a named failure, not a throw',
    !mapString.ok && mapString.failures.some((f) => f.includes('is not an object')), JSON.stringify(mapString.failures));

  const badHex = hostile({ video: { ...good.maps.video!, chunks: [{ index: 0, bytes: 1, sha256Hex: 'gg'.repeat(32) }] } });
  check('bad chunk hex is a named failure, not a throw',
    !badHex.ok && badHex.failures.some((f) => f.includes('sha256Hex')), JSON.stringify(badHex.failures));

  const negIndex = hostile({ video: { ...good.maps.video!, chunks: [{ index: -1, bytes: 1, sha256Hex: 'ab'.repeat(32) }] } });
  check('negative chunk index is a named failure, not a throw',
    !negIndex.ok && negIndex.failures.some((f) => f.includes('index')), JSON.stringify(negIndex.failures));

  const unknownTrack = hostile({ video: { ...good.maps.video!, trackId: 'smpte' } });
  check('an unknown trackId is a named failure, not a throw',
    !unknownTrack.ok && unknownTrack.failures.some((f) => f.includes('unknown trackId')), JSON.stringify(unknownTrack.failures));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
