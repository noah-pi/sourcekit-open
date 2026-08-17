// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * PNG container support for C2PA embedding.
 *
 * A C2PA manifest rides inside a PNG as a `caBX` chunk placed immediately
 * before IEND. The chunk framing is the standard PNG one:
 *
 *   length(4 BE) | "caBX"(4) | <JUMBF store bytes> | CRC32(4)
 *
 * where the CRC32 (ISO 3309, reflected polynomial 0xEDB88320 — the same CRC
 * used by zlib/gzip and every PNG chunk) covers type+data, i.e. "caBX" plus
 * the store bytes. The asset is hard-bound by a c2pa.hash.data byte-exclusion
 * that spans the WHOLE caBX chunk (framing included), so removing it
 * reconstructs the clean PNG exactly — the same exclusion semantics the JPEG
 * path uses, which c2pa-rs validates.
 *
 * Pure module — no React Native dependencies.
 */

import { asciiToBytes, concatBytes } from '../../src/lib/bytes';

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

// CRC32 table (reflected, poly 0xEDB88320) — built once.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngChunk {
  type: string;
  /** Absolute offset of the chunk's length field. */
  start: number;
  /** Absolute offset of the chunk's data. */
  dataStart: number;
  /** Data length (excludes length/type/CRC framing). */
  length: number;
  /** Total on-disk length including length/type/CRC framing. */
  totalLength: number;
}

/** Walks the chunk sequence after the 8-byte signature, stopping at IEND. */
function* iterChunks(png: Uint8Array): Generator<PngChunk> {
  if (!isPng(png)) return;
  let off = 8;
  while (off + 8 <= png.length) {
    const length = readU32(png, off);
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    const totalLength = length + 12;
    if (off + totalLength > png.length) break; // truncated chunk — fail closed
    yield { type, start: off, dataStart: off + 8, length, totalLength };
    off += totalLength;
    if (type === 'IEND') break;
  }
}

/** Builds a framed caBX chunk (length + type + store + CRC32) from store bytes. */
export function caBxChunk(store: Uint8Array): Uint8Array {
  const type = asciiToBytes('caBX');
  const crc = u32be(crc32(concatBytes(type, store)));
  return concatBytes(u32be(store.length), type, store, crc);
}

/**
 * Inserts a caBX chunk holding `store` immediately before IEND, per the C2PA
 * PNG spec. Returns the new PNG. The caBX chunk begins at exactly the clean
 * file's IEND offset, so that offset is also the hash.data exclusion start.
 */
export function embedCaBx(png: Uint8Array, store: Uint8Array): Uint8Array {
  const iend = iendOffset(png);
  if (iend === null) throw new Error('Not a well-formed PNG (no IEND)');
  return concatBytes(png.subarray(0, iend), caBxChunk(store), png.subarray(iend));
}

/** Absolute offset of the IEND chunk's length field (= insertion point). */
export function iendOffset(png: Uint8Array): number | null {
  for (const c of iterChunks(png)) {
    if (c.type === 'IEND') return c.start;
  }
  return null;
}

/**
 * Locates the first caBX chunk. Returns the raw JUMBF store bytes plus the
 * chunk's absolute start and total framed length (the hash.data exclusion).
 */
export function extractCaBx(png: Uint8Array): { store: Uint8Array; chunkStart: number; chunkLength: number } | null {
  for (const c of iterChunks(png)) {
    if (c.type === 'caBX') {
      return { store: png.subarray(c.dataStart, c.dataStart + c.length), chunkStart: c.start, chunkLength: c.totalLength };
    }
  }
  return null;
}

/** Removes every caBX chunk, reconstructing the clean (unsigned) PNG. */
export function stripCaBx(png: Uint8Array): Uint8Array {
  if (!isPng(png)) return png;
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const c of iterChunks(png)) {
    if (c.type !== 'caBX') continue;
    parts.push(png.subarray(cursor, c.start));
    cursor = c.start + c.totalLength;
  }
  if (cursor === 0) return png; // no caBX found
  parts.push(png.subarray(cursor));
  return concatBytes(...parts);
}
