// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * ISO Base Media File Format (MP4/MOV/M4A) surgery for C2PA embedding.
 *
 * What this module does, per the C2PA spec (BMFF-based assets):
 *
 *   - Walks root-level boxes (32-bit and 64-bit largesize headers).
 *   - Builds the C2PA `uuid` box: usertype d8fec3d6-1b0e-483c-9297-5828877ec481,
 *     version/flags 0, box_purpose "manifest", 8-byte merkle offset (0 = no
 *     merkle aux boxes), then the raw JUMBF manifest store — byte-identical
 *     to what c2pa-rs writes (see write_c2pa_box in bmff_io.rs).
 *   - Inserts that box immediately after `ftyp` and repairs the one thing
 *     that would otherwise silently break playback: absolute chunk offsets
 *     in stco/co64 tables shift when bytes are inserted before `mdat`
 *     (c2pa-rs calls this adjust_known_offsets).
 *   - Extracts / strips the manifest box again (strip is the exact inverse
 *     of embed — verified bit-for-bit in the lab).
 *
 * Scope, honestly: monolithic (non-fragmented) files only — no moof/mvex/
 * styp, no multi-mdat merkle hashing. iPhone camera recordings are always
 * monolithic. Anything else throws BmffUnsupported and the caller falls
 * back to the sidecar attestation rather than failing the capture.
 *
 * Pure module — no React Native dependencies.
 */

import { concatBytes, asciiToBytes } from '../../src/lib/bytes';

/** The C2PA usertype for uuid boxes, per spec (NOT the JUMBF "c2pa" prefix UUID). */
export const C2PA_UUID_BYTES = new Uint8Array([
  0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81,
]);

export class BmffUnsupported extends Error {}

export interface RootBox {
  type: string;
  start: number;
  /** Total box size including header. */
  size: number;
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function writeU32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

function type4(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** Walks root-level boxes. Throws BmffUnsupported on malformed structure. */
export function parseRootBoxes(bytes: Uint8Array): RootBox[] {
  const boxes: RootBox[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size32 = readU32(bytes, offset);
    const type = type4(bytes, offset + 4);
    let size: number;
    let headerSize = 8;
    if (size32 === 1) {
      if (offset + 16 > bytes.length) throw new BmffUnsupported('truncated largesize header');
      const hi = readU32(bytes, offset + 8);
      const lo = readU32(bytes, offset + 12);
      size = hi * 2 ** 32 + lo;
      headerSize = 16;
    } else if (size32 === 0) {
      size = bytes.length - offset; // box extends to EOF (legal as the last box)
    } else {
      size = size32;
    }
    if (size < headerSize || offset + size > bytes.length) {
      throw new BmffUnsupported(`malformed ${type} box at ${offset}`);
    }
    boxes.push({ type, start: offset, size });
    offset += size;
  }
  if (offset !== bytes.length) throw new BmffUnsupported('trailing bytes after last box');
  return boxes;
}

/** True when the first box is an ftyp (any brand — mp4, qt, M4A, …). */
export function isBmff(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && type4(bytes, 4) === 'ftyp';
}

/**
 * Structural gate for embedding: ftyp first (C2PA wants the manifest box
 * right after it), and no fragmentation markers. Throws BmffUnsupported
 * with a human-readable reason when the file is out of scope.
 */
export function assertEmbeddable(boxes: RootBox[]): void {
  if (boxes.length === 0 || boxes[0].type !== 'ftyp' || boxes[0].start !== 0) {
    throw new BmffUnsupported('no leading ftyp box');
  }
  for (const b of boxes) {
    if (b.type === 'moof' || b.type === 'mvex' || b.type === 'styp') {
      throw new BmffUnsupported('fragmented MP4 (moof/mvex) is not supported');
    }
  }
}

/** The C2PA uuid box around a raw JUMBF manifest store (c2pa-rs layout). */
export function buildC2paUuidBox(storePayload: Uint8Array): Uint8Array {
  const purpose = asciiToBytes('manifest');
  const content = concatBytes(
    C2PA_UUID_BYTES,          // usertype
    new Uint8Array(4),        // version + flags
    purpose, new Uint8Array([0]), // box_purpose as NUL-terminated string
    new Uint8Array(8),        // merkle offset: 0 = no merkle aux boxes
    storePayload
  );
  return concatBytes(u32be(content.length + 8), asciiToBytes('uuid'), content);
}

export interface ExtractedBmffStore {
  /** Raw JUMBF manifest store bytes. */
  payload: Uint8Array;
  boxStart: number;
  boxSize: number;
}

/** Locates and unwraps the C2PA manifest uuid box, if present. */
export function extractC2paStoreBmff(bytes: Uint8Array): ExtractedBmffStore | null {
  let boxes: RootBox[];
  try {
    boxes = parseRootBoxes(bytes);
  } catch {
    return null;
  }
  for (const b of boxes) {
    if (b.type !== 'uuid' || b.size < 8 + 16 + 4 + 2) continue;
    const base = b.start + 8;
    if (!C2PA_UUID_BYTES.every((v, i) => bytes[base + i] === v)) continue;
    // version/flags at base+16..base+20, then NUL-terminated box_purpose
    let q = base + 20;
    const purposeStart = q;
    while (q < b.start + b.size && bytes[q] !== 0) q++;
    if (q >= b.start + b.size) continue;
    const purpose = String.fromCharCode(...bytes.subarray(purposeStart, q));
    if (purpose !== 'manifest') continue; // e.g. a 'merkle' aux box — not ours
    // merkle offset (u64 BE) must be 0: we never write merkle aux boxes
    let merkleOffset = 0;
    for (let i = 0; i < 8; i++) merkleOffset = merkleOffset * 256 + bytes[q + 1 + i];
    if (merkleOffset !== 0) {
      throw new BmffUnsupported('manifest references merkle aux boxes — unsupported');
    }
    const payloadStart = q + 1 + 8;
    if (payloadStart >= b.start + b.size) continue;
    return { payload: bytes.subarray(payloadStart, b.start + b.size), boxStart: b.start, boxSize: b.size };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chunk-offset repair (stco / co64)
// ---------------------------------------------------------------------------

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'dinf']);

/**
 * Walks moov's container hierarchy and shifts every absolute chunk offset
 * that points at or beyond `insertOffset` by `delta` (negative when bytes
 * were removed). Mutates `bytes` in place. Without this, inserting the
 * manifest box before mdat would leave every stco/co64 entry pointing at
 * media that has moved — a silent playback break.
 */
function patchChunkOffsetsIn(bytes: Uint8Array, rangeStart: number, rangeEnd: number, insertOffset: number, delta: number, depth: number): void {
  if (depth > 8) return;
  let offset = rangeStart;
  while (offset + 8 <= rangeEnd) {
    const size32 = readU32(bytes, offset);
    const type = type4(bytes, offset + 4);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (offset + 16 > rangeEnd) return;
      size = readU32(bytes, offset + 8) * 2 ** 32 + readU32(bytes, offset + 12);
      headerSize = 16;
    } else if (size32 === 0) {
      size = rangeEnd - offset;
    }
    if (size < headerSize || offset + size > rangeEnd) return; // malformed — leave untouched

    if (CONTAINER_BOXES.has(type)) {
      patchChunkOffsetsIn(bytes, offset + headerSize, offset + size, insertOffset, delta, depth + 1);
    } else if (type === 'stco' || type === 'co64') {
      const is64 = type === 'co64';
      const entrySize = is64 ? 8 : 4;
      const countAt = offset + headerSize + 4; // skip FullBox version/flags
      if (countAt + 4 > offset + size) { offset += size; continue; }
      const count = readU32(bytes, countAt);
      let entryAt = countAt + 4;
      if (entryAt + count * entrySize > offset + size) { offset += size; continue; }
      for (let i = 0; i < count; i++, entryAt += entrySize) {
        if (is64) {
          const hi = readU32(bytes, entryAt);
          const lo = readU32(bytes, entryAt + 4);
          const value = hi * 2 ** 32 + lo;
          if (value < insertOffset) continue;
          const shifted = value + delta;
          if (shifted < 0 || shifted > Number.MAX_SAFE_INTEGER) continue;
          writeU32(bytes, entryAt, Math.floor(shifted / 2 ** 32));
          writeU32(bytes, entryAt + 4, shifted % 2 ** 32);
        } else {
          const value = readU32(bytes, entryAt);
          if (value < insertOffset) continue;
          const shifted = value + delta;
          if (shifted < 0 || shifted > 0xffffffff) continue;
          writeU32(bytes, entryAt, shifted);
        }
      }
    }
    offset += size;
  }
}

function patchChunkOffsets(bytes: Uint8Array, insertOffset: number, delta: number): void {
  let boxes: RootBox[];
  try {
    boxes = parseRootBoxes(bytes);
  } catch {
    throw new BmffUnsupported('cannot repair chunk offsets in malformed file');
  }
  for (const b of boxes) {
    if (b.type === 'moov') {
      patchChunkOffsetsIn(bytes, b.start + 8, b.start + b.size, insertOffset, delta, 0);
    }
  }
}

/**
 * Embeds a JUMBF manifest store into a (clean) BMFF file: uuid box placed
 * immediately after ftyp, chunk offsets repaired. Throws BmffUnsupported
 * for structures outside the supported scope.
 */
export function embedUuidStore(clean: Uint8Array, storePayload: Uint8Array): Uint8Array {
  const boxes = parseRootBoxes(clean);
  assertEmbeddable(boxes);
  const insertOffset = boxes[0].size; // end of the leading ftyp
  const uuidBox = buildC2paUuidBox(storePayload);
  const out = new Uint8Array(clean.length + uuidBox.length);
  out.set(clean.subarray(0, insertOffset), 0);
  out.set(uuidBox, insertOffset);
  out.set(clean.subarray(insertOffset), insertOffset + uuidBox.length);
  patchChunkOffsets(out, insertOffset, uuidBox.length);
  return out;
}

/**
 * Removes the C2PA manifest box and shifts chunk offsets back — the exact
 * inverse of embedUuidStore (lab-verified bit-for-bit).
 */
export function stripC2paFromBmff(bytes: Uint8Array): Uint8Array {
  const found = extractC2paStoreBmff(bytes);
  if (!found) return bytes;
  const out = new Uint8Array(bytes.length - found.boxSize);
  out.set(bytes.subarray(0, found.boxStart), 0);
  out.set(bytes.subarray(found.boxStart + found.boxSize), found.boxStart);
  patchChunkOffsets(out, found.boxStart, -found.boxSize);
  return out;
}
