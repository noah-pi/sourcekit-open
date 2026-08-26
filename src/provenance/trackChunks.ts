// Source Kit 0.1.0 — per-track Merkle commitments
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * streamedChunks v2 — per-track Merkle commitments.
 *
 * The per-track structure is derived at the TS layer by demuxing the
 * finalized delivery file: each track's elementary stream is the
 * concatenation of its samples (stbl sample tables), chunked as
 * `chunkDigest = SHA-256(trackId ‖ uint64BE index ‖ bytes)` over 1 MiB
 * logical chunks.
 *
 * v2 roots bind the delivery-file bytes reconstructed at seal time. The
 * assertion states that in its `binding` field and the verifier reports
 * repeat it.
 *
 * Media parity: the same math serves video+audio (two tracks), audio-only
 * (one LPCM/AAC track), and photos-as-video (one track). Stills emit the
 * assertion with zero tracks, noted as structural.
 *
 * Scope: monolithic MP4/MOV/M4A only. Fragmented or malformed containers
 * degrade to null rather than throwing into the seal path. Pure module, no
 * React Native dependencies.
 */

import { sha256 } from '@noble/hashes/sha256';
import { asciiToBytes, bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '../lib/bytes';
import { buildTree } from '../disclosure/tree';
import {
  MISSING_CHUNK_MAP_NOTE,
  STREAM_CHUNK_BYTES,
  STREAMED_CHUNKS_V2_LABEL,
  STREAMED_CHUNKS_V2_NOTE,
  streamedChunksSuperRoot,
  CHUNK_MAP_SIDECAR_FORMAT,
  type ChunkMapSidecar,
  type StreamedChunksAssertionV2,
  type StreamedChunksTrackId,
  type StreamedChunksTrackV2,
  type TrackChunkMap,
} from './manifest';

// ---------------------------------------------------------------------------
// BMFF demux (monolithic only)
// ---------------------------------------------------------------------------

export class TrackChunksUnsupported extends Error {}

interface SubBox {
  type: string;
  start: number;
  size: number;
  headerSize: number;
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function type4(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/** Walks the child boxes of [start, end). Tolerates 64-bit largesize. */
function walkBoxes(b: Uint8Array, start: number, end: number): SubBox[] {
  const out: SubBox[] = [];
  let off = start;
  while (off + 8 <= end) {
    const size32 = readU32(b, off);
    const type = type4(b, off + 4);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (off + 16 > end) throw new TrackChunksUnsupported(`truncated largesize header at ${off}`);
      size = readU32(b, off + 8) * 2 ** 32 + readU32(b, off + 12);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - off; // extends to end of container
    }
    if (size < headerSize || off + size > end) {
      throw new TrackChunksUnsupported(`malformed ${type} box at ${off}`);
    }
    out.push({ type, start: off, size, headerSize });
    off += size;
  }
  if (off !== end) throw new TrackChunksUnsupported('trailing bytes inside container box');
  return out;
}

function child(b: Uint8Array, parent: SubBox, type: string): SubBox | null {
  const contentStart = parent.start + parent.headerSize;
  for (const c of walkBoxes(b, contentStart, parent.start + parent.size)) {
    if (c.type === type) return c;
  }
  return null;
}

export interface TrackStream {
  trackId: StreamedChunksTrackId;
  /** Sample-entry fourcc from stsd (e.g. 'avc1', 'mp4a'). */
  codec: string;
  /** Concatenated sample bytes in sample order (the ES byte stream). */
  es: Uint8Array;
  /** Declared sample count from stsz. */
  sampleCount: number;
  /** True when the file ended before every sample byte was available (truncated media). */
  truncated: boolean;
  /** When truncated: the first sample index whose bytes were not fully present. */
  missingFromSample: number | null;
}

function extractTrack(b: Uint8Array, trak: SubBox): TrackStream | null {
  const mdia = child(b, trak, 'mdia');
  if (!mdia) return null;
  const hdlr = child(b, mdia, 'hdlr');
  const minf = child(b, mdia, 'minf');
  if (!hdlr || !minf) return null;
  // hdlr content: version/flags(4) pre_defined(4) handler_type(4)
  const hc = hdlr.start + hdlr.headerSize;
  if (hc + 12 > b.length) return null;
  const handler = type4(b, hc + 8);
  const trackId: StreamedChunksTrackId | null = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : null;
  if (!trackId) return null; // hint/meta tracks are not elementary media — ignored.
  const stbl = child(b, minf, 'stbl');
  if (!stbl) return null;
  const stsd = child(b, stbl, 'stsd');
  const stsz = child(b, stbl, 'stsz');
  const stsc = child(b, stbl, 'stsc');
  const stco = child(b, stbl, 'stco') ?? child(b, stbl, 'co64');
  if (!stsd || !stsz || !stsc || !stco) return null;
  if (child(b, stbl, 'stz2')) {
    throw new TrackChunksUnsupported('stz2 compact sample sizes are not supported');
  }

  // Codec is the first sample entry's fourcc, read rather than inferred.
  const sc = stsd.start + stsd.headerSize;
  if (sc + 16 > b.length) throw new TrackChunksUnsupported('truncated stsd');
  const entryCount = readU32(b, sc + 4);
  if (entryCount < 1) return null;
  const codec = type4(b, sc + 8 + 4); // entry size(4) then format(4)

  // stsz: version/flags(4) sample_size(4) sample_count(4) [sizes]
  const sz = stsz.start + stsz.headerSize;
  if (sz + 12 > b.length) throw new TrackChunksUnsupported('truncated stsz');
  const uniform = readU32(b, sz + 4);
  const sampleCount = readU32(b, sz + 8);
  const sizes = new Array<number>(sampleCount);
  if (uniform !== 0) {
    sizes.fill(uniform);
  } else {
    if (sz + 12 + sampleCount * 4 > stsz.start + stsz.size) throw new TrackChunksUnsupported('truncated stsz table');
    for (let i = 0; i < sampleCount; i++) sizes[i] = readU32(b, sz + 12 + i * 4);
  }

  // stsc entries
  const ss = stsc.start + stsc.headerSize;
  if (ss + 8 > b.length) throw new TrackChunksUnsupported('truncated stsc');
  const stscCount = readU32(b, ss + 4);
  const stscEntries: { firstChunk: number; samplesPerChunk: number }[] = [];
  for (let i = 0; i < stscCount; i++) {
    const at = ss + 8 + i * 12;
    if (at + 12 > stsc.start + stsc.size) throw new TrackChunksUnsupported('truncated stsc table');
    stscEntries.push({ firstChunk: readU32(b, at), samplesPerChunk: readU32(b, at + 4) });
  }

  // chunk offsets (stco 32-bit / co64 64-bit)
  const is64 = stco.type === 'co64';
  const co = stco.start + stco.headerSize;
  if (co + 8 > b.length) throw new TrackChunksUnsupported('truncated chunk-offset table');
  const chunkCount = readU32(b, co + 4);
  const entrySize = is64 ? 8 : 4;
  if (co + 8 + chunkCount * entrySize > stco.start + stco.size) {
    throw new TrackChunksUnsupported('truncated chunk-offset table');
  }
  const chunkOffsets = new Array<number>(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const at = co + 8 + i * entrySize;
    chunkOffsets[i] = is64 ? readU32(b, at) * 2 ** 32 + readU32(b, at + 4) : readU32(b, at);
  }

  // Map samples to file offsets via the stsc run-length table.
  const sampleOffsets = new Array<number>(sampleCount);
  let sampleIndex = 0;
  let spe = 0;
  let stscIdx = -1;
  for (let chunkIdx = 1; chunkIdx <= chunkCount && sampleIndex < sampleCount; chunkIdx++) {
    while (stscIdx + 1 < stscEntries.length && stscEntries[stscIdx + 1].firstChunk <= chunkIdx) {
      stscIdx++;
      spe = stscEntries[stscIdx].samplesPerChunk;
    }
    let off = chunkOffsets[chunkIdx - 1];
    for (let j = 0; j < spe && sampleIndex < sampleCount; j++) {
      sampleOffsets[sampleIndex] = off;
      off += sizes[sampleIndex];
      sampleIndex++;
    }
  }
  if (sampleIndex < sampleCount) {
    throw new TrackChunksUnsupported('sample tables do not cover every declared sample');
  }

  // Concatenate the ES bytes. A file that ends early returns the contiguous
  // prefix plus the truncation marker, so verification can localize it.
  let truncated = false;
  let missingFromSample: number | null = null;
  let total = 0;
  for (let i = 0; i < sampleCount; i++) {
    if (sampleOffsets[i] + sizes[i] > b.length) {
      truncated = true;
      missingFromSample = i;
      break;
    }
    total += sizes[i];
  }
  const es = new Uint8Array(total);
  let cursor = 0;
  for (let i = 0; i < sampleCount; i++) {
    if (missingFromSample !== null && i >= missingFromSample) break;
    es.set(b.subarray(sampleOffsets[i], sampleOffsets[i] + sizes[i]), cursor);
    cursor += sizes[i];
  }
  return { trackId, codec, es, sampleCount, truncated, missingFromSample };
}

/**
 * Tolerant root-level scan: keeps a truncated final box (typically an mdat
 * cut short), clamped to the bytes present. Verification needs the intact
 * moov to localize the truncation; the seal path rejects truncated streams
 * separately.
 */
function scanRootBoxesTolerant(b: Uint8Array): SubBox[] {
  const out: SubBox[] = [];
  let off = 0;
  while (off + 8 <= b.length) {
    const size32 = readU32(b, off);
    const type = type4(b, off + 4);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (off + 16 > b.length) break;
      size = readU32(b, off + 8) * 2 ** 32 + readU32(b, off + 12);
      headerSize = 16;
    } else if (size32 === 0) {
      size = b.length - off;
    }
    if (size < headerSize) break;
    if (off + size > b.length) {
      out.push({ type, start: off, size: b.length - off, headerSize });
      break;
    }
    out.push({ type, start: off, size, headerSize });
    off += size;
  }
  return out;
}

/**
 * Demux a monolithic BMFF file into its per-track elementary streams,
 * ordered video-then-audio (the canonical assertion order). Returns [] when
 * no media tracks exist; throws TrackChunksUnsupported on fragmented or
 * moov-less containers, which callers degrade on. A truncated file yields
 * streams with `truncated: true` carrying the contiguous prefix, so
 * verification can localize the cut.
 */
export function extractTrackStreams(bytes: Uint8Array): TrackStream[] {
  const roots = scanRootBoxesTolerant(bytes);
  const moov = roots.find((r) => r.type === 'moov');
  if (!moov) throw new TrackChunksUnsupported('no moov box (fragmented or streaming layout)');
  if (roots.some((r) => r.type === 'moof' || r.type === 'mvex')) {
    throw new TrackChunksUnsupported('fragmented MP4 is not supported');
  }
  const tracks: TrackStream[] = [];
  for (const trak of walkBoxes(bytes, moov.start + moov.headerSize, moov.start + moov.size)) {
    if (trak.type !== 'trak') continue;
    const t = extractTrack(bytes, trak);
    if (t) tracks.push(t);
  }
  tracks.sort((a, b) => (a.trackId === b.trackId ? 0 : a.trackId === 'video' ? -1 : 1));
  return tracks;
}

// ---------------------------------------------------------------------------
// Wire-format chunking (1:1 with CaptureKit StreamingHasher.swift)
// ---------------------------------------------------------------------------

export interface ChunkDigestEntry {
  index: number;
  bytes: number;
  sha256Hex: string;
}

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  const hi = Math.floor(n / 2 ** 32);
  const lo = n % 2 ** 32;
  out[0] = (hi >>> 24) & 0xff; out[1] = (hi >>> 16) & 0xff; out[2] = (hi >>> 8) & 0xff; out[3] = hi & 0xff;
  out[4] = (lo >>> 24) & 0xff; out[5] = (lo >>> 16) & 0xff; out[6] = (lo >>> 8) & 0xff; out[7] = lo & 0xff;
  return out;
}

/** The Swift wire format: SHA-256(trackId ‖ uint64BE index ‖ chunk bytes). */
export function chunkDigest(trackId: StreamedChunksTrackId, index: number, bytes: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8ToBytes(trackId), u64be(index), bytes));
}

/**
 * Chunk one track's ES stream into fixed-size logical chunks (trailing
 * partial chunk committed with its actual byte count, like the native
 * finalize). Zero bytes → zero chunks.
 */
export function chunkEsStream(
  trackId: StreamedChunksTrackId,
  es: Uint8Array,
  chunkBytes: number = STREAM_CHUNK_BYTES
): ChunkDigestEntry[] {
  const out: ChunkDigestEntry[] = [];
  let index = 0;
  for (let off = 0; off < es.length; off += chunkBytes) {
    const slice = es.subarray(off, Math.min(off + chunkBytes, es.length));
    out.push({ index, bytes: slice.length, sha256Hex: bytesToHex(chunkDigest(trackId, index, slice)) });
    index++;
  }
  return out;
}

/** Merkle root over chunk digests: raw 32-byte leaves, odd leaf promoted. */
export function chunkRootHex(digestsHex: string[]): string {
  return buildTree(digestsHex.map(hexToBytes)).root;
}

// ---------------------------------------------------------------------------
// v2 build (seal path)
// ---------------------------------------------------------------------------

export interface StreamedChunksV2Build {
  assertion: StreamedChunksAssertionV2;
  maps: Partial<Record<StreamedChunksTrackId, TrackChunkMap>>;
}

export type StreamedChunksV2Result =
  | { ok: true; build: StreamedChunksV2Build }
  | { ok: false; reason: string };

/** Build the v2 assertion and vault chunk maps from the delivery bytes. */
export function buildStreamedChunksV2(
  bytes: Uint8Array
): StreamedChunksV2Result {
  let tracks: TrackStream[];
  try {
    tracks = extractTrackStreams(bytes);
  } catch (e) {
    return { ok: false, reason: `demux failed: ${(e as Error).message}` };
  }
  if (tracks.length === 0) return { ok: false, reason: 'no elementary media tracks in container' };
  if (tracks.some((t) => t.truncated)) {
    return { ok: false, reason: 'delivery file ends before its sample tables declare — refusing to commit partial media' };
  }

  const entries: StreamedChunksTrackV2[] = [];
  const maps: Partial<Record<StreamedChunksTrackId, TrackChunkMap>> = {};
  for (const t of tracks) {
    const chunks = chunkEsStream(t.trackId, t.es);
    const root = chunkRootHex(chunks.map((c) => c.sha256Hex));
    entries.push({
      trackId: t.trackId,
      codec: t.codec,
      chunkBytes: STREAM_CHUNK_BYTES,
      chunkCount: chunks.length,
      root,
      digest: 'SHA-256',
    });
    maps[t.trackId] = {
      trackId: t.trackId,
      codec: t.codec,
      chunkBytes: STREAM_CHUNK_BYTES,
      digest: 'SHA-256',
      chunkCount: chunks.length,
      chunks,
    };
  }

  const total = entries.reduce((n, e) => n + e.chunkCount, 0);
  const assertion: StreamedChunksAssertionV2 = {
    label: STREAMED_CHUNKS_V2_LABEL,
    v: 2,
    alg: 'sha256-merkle',
    chunkBytes: STREAM_CHUNK_BYTES,
    tracks: entries,
    superRoot: streamedChunksSuperRoot(entries.map((e) => e.root)),
    binding: 'delivery-file',
    note: STREAMED_CHUNKS_V2_NOTE,
  };
  return { ok: true, build: { assertion, maps } };
}

/**
 * The zero-track v2 assertion for still images. Media parity keeps the same
 * label set on every kind; a JPEG has no elementary streams, which the note
 * states.
 */
export function buildStreamedChunksV2ForStill(): StreamedChunksAssertionV2 {
  return {
    label: STREAMED_CHUNKS_V2_LABEL,
    v: 2,
    alg: 'sha256-merkle',
    chunkBytes: STREAM_CHUNK_BYTES,
    tracks: [],
    superRoot: streamedChunksSuperRoot([]),
    binding: 'delivery-file',
    note:
      'No elementary streams: a still image commits its whole file byte-for-byte via the ' +
      'c2pa.hash.data hard binding. Structural absence of tracks, stated — the assertion set ' +
      'is identical across media kinds.',
  };
}

/**
 * The export-ready chunk-map sidecar. The proof-bundle export ('proof-only'
 * mode) carries the vault's stored chunk maps with the proof so a desk can
 * range-verify the delivery file without the vault.
 */
export function buildChunkMapSidecar(
  assetSha256: string,
  maps: Partial<Record<StreamedChunksTrackId, TrackChunkMap>>
): ChunkMapSidecar {
  return { format: CHUNK_MAP_SIDECAR_FORMAT, assetSha256, maps };
}

// ---- Verification (v2, the only version this tree produces) ----

export interface StreamedChunksVerification {
  version: 2;
  /** What the verified roots bind; restated in every report. */
  binding: 'delivery-file';
  ok: boolean;
  failures: string[];
  notes: string[];
  /** First mismatching chunk when a chunk map allowed localization. */
  truncation: { trackId: StreamedChunksTrackId | null; chunkIndex: number } | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

function localize(
  trackId: StreamedChunksTrackId,
  recomputed: ChunkDigestEntry[],
  expected: ChunkDigestEntry[]
): number | null {
  const n = Math.max(recomputed.length, expected.length);
  for (let i = 0; i < n; i++) {
    const r = recomputed[i];
    const e = expected[i];
    if (!r || !e || r.sha256Hex !== e.sha256Hex || r.bytes !== e.bytes) return i;
  }
  return null;
}

/**
 * Verify a streamedChunks v2 assertion against the media bytes it rides in.
 * Roots recompute from the delivery file; truncation localizes to a chunk
 * index when the chunk map is available, and the report falls back to the
 * locked string when it is not. Unknown assertion fields are ignored
 * (UNSUPPORTED semantics per policyLayer).
 */
export function verifyStreamedChunksAssertion(
  bytes: Uint8Array,
  assertion: StreamedChunksAssertionV2,
  opts?: {
    chunkMaps?: Partial<Record<StreamedChunksTrackId, TrackChunkMap>> | null;
  }
): StreamedChunksVerification {
  const failures: string[] = [];
  const notes: string[] = [];
  let truncation: StreamedChunksVerification['truncation'] = null;

  const a = assertion;
  // --- structural checks -------------------------------------------------
  if (a.binding !== 'delivery-file') {
    failures.push(`binding must be declared 'delivery-file', got '${String(a.binding)}'`);
  }
  if (a.chunkBytes !== STREAM_CHUNK_BYTES) {
    failures.push(`chunkBytes ${String(a.chunkBytes)} — this verifier reads ${STREAM_CHUNK_BYTES}`);
  }
  if (!Array.isArray(a.tracks)) failures.push('tracks is not an array');
  if (typeof a.superRoot !== 'string' || !HEX64.test(a.superRoot)) failures.push('malformed superRoot');
  if (failures.length > 0) {
    return { version: 2, binding: 'delivery-file', ok: false, failures, notes, truncation };
  }

  // Zero tracks means a still image: the superRoot must be the empty-input
  // hash, with nothing else to recompute.
  if (a.tracks.length === 0) {
    if (a.superRoot !== streamedChunksSuperRoot([])) {
      failures.push('superRoot mismatch for a zero-track (still) assertion');
    }
    notes.push('zero tracks: still image — whole-file integrity is the c2pa.hash.data hard binding');
    return { version: 2, binding: 'delivery-file', ok: failures.length === 0, failures, notes, truncation };
  }

  // --- superRoot recomputation over the declared roots -------------------
  for (const [i, t] of a.tracks.entries()) {
    if (typeof t?.root !== 'string' || !HEX64.test(t.root)) {
      failures.push(`tracks[${i}] ('${String(t?.trackId)}'): malformed root`);
    }
    if (t && t.digest !== 'SHA-256') failures.push(`tracks[${i}]: digest must be 'SHA-256'`);
    if (t && !Number.isInteger(t.chunkCount)) failures.push(`tracks[${i}]: malformed chunkCount`);
  }
  if (failures.length === 0 && streamedChunksSuperRoot(a.tracks.map((t) => t.root)) !== a.superRoot) {
    failures.push('superRoot does not recompute from the declared track roots');
  }
  if (failures.length > 0) {
    return { version: 2, binding: 'delivery-file', ok: false, failures, notes, truncation };
  }

  // --- media recomputation ----------------------------------------------
  let streams: TrackStream[];
  try {
    streams = extractTrackStreams(bytes);
  } catch (e) {
    // Unparseable container: the roots cannot be recomputed, so UNPROVEN
    // rather than proven tamper.
    failures.push(`delivery-file demux failed (${(e as Error).message}) — v2 roots could not be recomputed`);
    return { version: 2, binding: 'delivery-file', ok: false, failures, notes, truncation };
  }

  const mapNote = (trackId: StreamedChunksTrackId): void => {
    if (!opts?.chunkMaps?.[trackId]) notes.push(`${trackId}: ${MISSING_CHUNK_MAP_NOTE}`);
  };

  for (const declared of a.tracks) {
    const stream = streams.find((s) => s.trackId === declared.trackId);
    const map = opts?.chunkMaps?.[declared.trackId] ?? null;
    if (!stream) {
      failures.push(`track '${declared.trackId}' is declared but absent from the delivery file`);
      continue;
    }
    if (stream.codec !== declared.codec) {
      failures.push(`track '${declared.trackId}' codec is '${stream.codec}' in the file, '${declared.codec}' in the assertion`);
      continue;
    }
    const recomputed = chunkEsStream(stream.trackId, stream.es);
    if (map) {
      // Chunk map available: digest-by-digest, so a truncation or edit
      // localizes to a chunk index.
      const idx = localize(declared.trackId, recomputed, map.chunks);
      if (idx !== null) {
        truncation = truncation ?? { trackId: declared.trackId, chunkIndex: idx };
        failures.push(
          `track '${declared.trackId}' chunk ${idx} does not match the chunk map ` +
          `(delivery-file recomputation ${recomputed[idx]?.sha256Hex ?? '(absent — file ends here)'})`
        );
        continue;
      }
      const mapRoot = chunkRootHex(map.chunks.map((c) => c.sha256Hex));
      if (mapRoot !== declared.root) {
        failures.push(`track '${declared.trackId}' chunk map root does not equal the assertion root`);
        continue;
      }
      if (map.chunkCount !== declared.chunkCount) {
        failures.push(`track '${declared.trackId}' chunk map count ${map.chunkCount} ≠ assertion ${declared.chunkCount}`);
        continue;
      }
    } else {
      mapNote(declared.trackId);
      // Root-only: the recomputed root must equal the declared root.
      if (chunkRootHex(recomputed.map((c) => c.sha256Hex)) !== declared.root) {
        failures.push(
          `track '${declared.trackId}' recomputed root does not match the assertion — the delivery ` +
          'bytes changed after seal (or the file is truncated; a chunk map would localize it)'
        );
        continue;
      }
      if (recomputed.length !== declared.chunkCount) {
        failures.push(`track '${declared.trackId}' recomputed chunk count ${recomputed.length} ≠ declared ${declared.chunkCount}`);
        continue;
      }
    }
  }
  return { version: 2, binding: 'delivery-file', ok: failures.length === 0, failures, notes, truncation };
}

/**
 * Desk-side reader for the proof-bundle chunk-map sidecar that the app
 * exports from buildChunkMapSidecar. It range-verifies the media against the
 * v2 roots with the maps present, so a tampered or truncated delivery file
 * localizes to a chunk index.
 *
 *   - absent sidecar  → root-only verification with the locked missing-map
 *     note, not a failure;
 *   - wrong format    → a named failure;
 *   - assetSha256 ≠ sha256(media) → a named failure: the maps describe a
 *     different asset.
 */
export function verifyChunkMapSidecar(
  bytes: Uint8Array,
  assertion: StreamedChunksAssertionV2,
  sidecar: ChunkMapSidecar | null | undefined
): StreamedChunksVerification {
  if (!sidecar) return verifyStreamedChunksAssertion(bytes, assertion, {});
  const base = { version: 2 as const, binding: 'delivery-file' as const };
  if (sidecar.format !== CHUNK_MAP_SIDECAR_FORMAT) {
    return { ...base, ok: false, failures: [`unrecognized chunk-map sidecar format '${String(sidecar.format)}' — refusing to range-verify against an unknown layout`], notes: [], truncation: null };
  }
  const mediaSha256 = bytesToHex(sha256(bytes));
  if (sidecar.assetSha256 !== mediaSha256) {
    return {
      ...base,
      ok: false,
      failures: [
        `the chunk-map sidecar binds asset ${sidecar.assetSha256} but this media hashes to ${mediaSha256} — ` +
        'these maps describe a different asset; range verification refused',
      ],
      notes: [],
      truncation: null,
    };
  }
  // The sidecar crossed the wire as JSON, so validate its shape before use;
  // a type-malformed map must surface as a named failure, not a throw.
  const shapeError = chunkMapSidecarShapeError(sidecar.maps);
  if (shapeError) {
    return { ...base, ok: false, failures: [shapeError], notes: [], truncation: null };
  }
  return verifyStreamedChunksAssertion(bytes, assertion, { chunkMaps: sidecar.maps });
}

/**
 * Named structural failure for a malformed sidecar maps object, or null when
 * every map is usable: keyed by a known track id, trackId in the known enum,
 * chunks an array of { index: int ≥ 0, bytes: int ≥ 0, sha256Hex: 64 lowercase
 * hex }. Anything else is a wrong-format sidecar.
 */
function chunkMapSidecarShapeError(maps: unknown): string | null {
  if (maps == null || typeof maps !== 'object' || Array.isArray(maps)) {
    return 'malformed chunk-map sidecar: maps is not an object keyed by track id';
  }
  for (const [key, raw] of Object.entries(maps)) {
    if (key !== 'video' && key !== 'audio') {
      return `malformed chunk-map sidecar: unknown track key '${key}'`;
    }
    const map = raw as TrackChunkMap | null;
    if (map == null || typeof map !== 'object' || Array.isArray(map)) {
      return `malformed chunk-map sidecar: map '${key}' is not an object`;
    }
    if (map.trackId !== 'video' && map.trackId !== 'audio') {
      return `malformed chunk-map sidecar: map '${key}' has unknown trackId '${String((map as { trackId?: unknown }).trackId)}'`;
    }
    if (!Array.isArray(map.chunks)) {
      return `malformed chunk-map sidecar: track '${map.trackId}' chunks is not an array`;
    }
    for (let i = 0; i < map.chunks.length; i++) {
      const c = map.chunks[i];
      if (c == null || typeof c !== 'object') {
        return `malformed chunk-map sidecar: track '${map.trackId}' chunk[${i}] is not an object`;
      }
      if (!Number.isInteger(c.index) || c.index < 0) {
        return `malformed chunk-map sidecar: track '${map.trackId}' chunk[${i}].index is not a non-negative integer`;
      }
      if (!Number.isInteger(c.bytes) || c.bytes < 0) {
        return `malformed chunk-map sidecar: track '${map.trackId}' chunk[${i}].bytes is not a non-negative integer`;
      }
      if (typeof c.sha256Hex !== 'string' || !HEX64.test(c.sha256Hex)) {
        return `malformed chunk-map sidecar: track '${map.trackId}' chunk[${i}].sha256Hex is not 64 lowercase hex chars`;
      }
    }
  }
  return null;
}
