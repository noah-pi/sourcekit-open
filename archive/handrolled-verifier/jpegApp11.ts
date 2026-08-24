// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * JPEG APP11 / JUMBF embedding, extraction, and stripping.
 *
 * Structure follows ISO/IEC 19566-5 (JUMBF in JPEG) — the same container
 * family C2PA uses — so the attestation rides inside the image file itself
 * and survives ordinary file copying, AirDrop, and messaging:
 *
 *   FF EB | length(2) | "JP" | box-instance(2) | packet-seq(4) | JUMBF
 *
 * A JUMBF too large for one segment splits across an ordered chain of
 * packets (same box-instance En, consecutive 1-based Z) — the reader
 * reassembles in Z order, and stripping removes the whole chain by group.
 *
 * JUMBF payload:
 *   jumb  { jumd(uuid, label "verify.attestation"), json(manifest UTF-8) }
 *
 * The signature covers the file WITHOUT this segment, so stripping our
 * segment must always reproduce the exact signed bytes.
 *
 * Pure module — no React Native dependencies.
 */

import { asciiToBytes, concatBytes } from '../../src/lib/bytes';

const MARKER_SOI = 0xd8;
const MARKER_EOI = 0xd9;
const MARKER_SOS = 0xda;
const MARKER_APP0 = 0xe0;
const MARKER_APP1 = 0xe1;
const MARKER_APP11 = 0xeb;
const MARKER_APP13 = 0xed;
const MARKER_COM = 0xfe;

/** 16-byte JUMBF UUID identifying a Source Kit attestation box. */
export const VERIFY_JUMD_UUID = asciiToBytes('verifyappattest!');
const JUMD_LABEL = 'exhibit.attestation';

const MAX_SEGMENT_PAYLOAD = 65533; // length field is 2 bytes, includes itself
/** "JP"(2) + box-instance En(2) + packet-sequence Z(4) — the per-segment JUMBF envelope. */
const APP11_ENVELOPE_BYTES = 8;
/** Box-instance id (En) for the legacy attestation box. */
const VERIFY_EN = 0x0001;

interface Segment {
  marker: number;
  /** Absolute offset of the 0xFF marker byte. */
  start: number;
  /** Absolute offset one past the end of this segment. */
  end: number;
  /** Segment payload (after the length field). */
  payload: Uint8Array;
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === MARKER_SOI;
}

/**
 * Iterates JPEG marker segments from SOI up to (not including) SOS/EOI.
 * Throws on malformed structure rather than guessing.
 */
function parseSegments(bytes: Uint8Array): Segment[] {
  if (!isJpeg(bytes)) throw new Error('Not a JPEG file');
  const segments: Segment[] = [];
  let offset = 2;
  while (offset < bytes.length) {
    // Skip fill bytes; a marker begins at the last 0xFF of a run.
    if (bytes[offset] !== 0xff) throw new Error(`Malformed JPEG at offset ${offset}`);
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    const markerStart = offset - 1;
    offset++;
    if (marker === MARKER_EOI || marker === MARKER_SOS) break;
    // Standalone markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start: markerStart, end: offset, payload: new Uint8Array(0) });
      continue;
    }
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) {
      throw new Error(`Malformed JPEG segment length at offset ${offset}`);
    }
    segments.push({
      marker,
      start: markerStart,
      end: offset + length,
      payload: bytes.subarray(offset + 2, offset + length),
    });
    offset += length;
  }
  return segments;
}

/**
 * The ISO 19566-5 envelope of an APP11 "JP" payload: En (box-instance id,
 * 2 bytes) and Z (packet sequence, 1-based, 4 bytes). A JUMBF box larger
 * than one segment is split across consecutive Z values sharing one En.
 * Null when the payload is not JUMBF-in-JPEG at all.
 */
function jpEnvelope(payload: Uint8Array): { en: number; z: number } | null {
  if (payload.length < APP11_ENVELOPE_BYTES || payload[0] !== 0x4a || payload[1] !== 0x50) return null;
  const en = (payload[2] << 8) | payload[3];
  const z = ((payload[5] << 16) | (payload[6] << 8) | payload[7]) >>> 0; // payload[4] is always 0 in practice
  return { en, z };
}

/** True if an APP11 payload is one of ours (JP header + our JUMD UUID). */
function isVerifyApp11(payload: Uint8Array): boolean {
  if (payload.length < 8 + 8 + 8 + 16) return false;
  if (payload[0] !== 0x4a || payload[1] !== 0x50) return false; // "JP"
  // JUMBF begins at byte 8: jumb length(4), 'jumb'(4), then jumd box:
  // jumd length(4), 'jumd'(4), uuid(16)
  if (
    payload[12] !== 0x6a || payload[13] !== 0x75 || payload[14] !== 0x6d || payload[15] !== 0x62 // 'jumb'
  ) return false;
  if (
    payload[20] !== 0x6a || payload[21] !== 0x75 || payload[22] !== 0x6d || payload[23] !== 0x64 // 'jumd'
  ) return false;
  for (let i = 0; i < 16; i++) {
    if (payload[24 + i] !== VERIFY_JUMD_UUID[i]) return false;
  }
  return true;
}

/** True if an APP11 payload holds a C2PA JUMBF store (uuid prefix 'c2pa'). */
function isC2paApp11(payload: Uint8Array): boolean {
  if (payload.length < 40) return false;
  if (payload[0] !== 0x4a || payload[1] !== 0x50) return false; // "JP"
  return (
    payload[12] === 0x6a && payload[13] === 0x75 && payload[14] === 0x6d && payload[15] === 0x62 && // 'jumb'
    payload[24] === 0x63 && payload[25] === 0x32 && payload[26] === 0x70 && payload[27] === 0x61    // 'c2pa' UUID prefix
  );
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function buildJumbf(manifest: Uint8Array): Uint8Array {
  // jumd box: length + 'jumd' + uuid(16) + toggle(1) + label + NUL
  const labelBytes = concatBytes(asciiToBytes(JUMD_LABEL), new Uint8Array([0]));
  const jumdPayload = concatBytes(VERIFY_JUMD_UUID, new Uint8Array([0x02]), labelBytes);
  const jumd = concatBytes(u32be(8 + jumdPayload.length), asciiToBytes('jumd'), jumdPayload);
  // json content box
  const json = concatBytes(u32be(8 + manifest.length), asciiToBytes('json'), manifest);
  const jumbPayload = concatBytes(jumd, json);
  return concatBytes(u32be(8 + jumbPayload.length), asciiToBytes('jumb'), jumbPayload);
}

/**
 * Builds the APP11 segment(s) for a manifest: one when it fits, an ordered
 * ISO 19566-5 packet chain when it doesn't — the JUMBF is split across
 * consecutive Z values (1-based) sharing VERIFY_EN, exactly how C2PA
 * manifests >64KB ride JPEG. Returns the concatenated segments.
 */
function buildApp11Segments(manifest: Uint8Array): Uint8Array {
  const jumbf = buildJumbf(manifest);
  const chunkMax = MAX_SEGMENT_PAYLOAD - APP11_ENVELOPE_BYTES;
  const out: Uint8Array[] = [];
  for (let z = 0, off = 0; ; z++) {
    const chunk = jumbf.subarray(off, Math.min(off + chunkMax, jumbf.length));
    off += chunk.length;
    const seq = z + 1;
    const header = new Uint8Array([
      0x4a, 0x50,
      (VERIFY_EN >> 8) & 0xff, VERIFY_EN & 0xff,
      (seq >>> 24) & 0xff, (seq >>> 16) & 0xff, (seq >>> 8) & 0xff, seq & 0xff,
    ]);
    const payload = concatBytes(header, chunk);
    const length = payload.length + 2;
    out.push(concatBytes(
      new Uint8Array([0xff, MARKER_APP11, (length >> 8) & 0xff, length & 0xff]),
      payload
    ));
    if (off >= jumbf.length) break;
  }
  return concatBytes(...out);
}

/**
 * The box-instance ids (En) whose FIRST packet (Z=1) opens a provenance
 * JUMBF — the legacy attestation box or a C2PA store. Multi-segment honesty:
 * continuation packets (Z>1) carry no uuid, so per-segment uuid matching
 * strands orphans; stripping works by GROUP, and a group is only as
 * provenance-marked as its first packet. A continuation chain whose Z=1 is
 * absent (crafted) is left alone — unknown bytes are not ours to delete.
 */
function provenanceGroupEns(segments: Segment[]): Set<number> {
  const ens = new Set<number>();
  for (const seg of segments) {
    if (seg.marker !== MARKER_APP11) continue;
    const env = jpEnvelope(seg.payload);
    if (env && env.z === 1 && (isVerifyApp11(seg.payload) || isC2paApp11(seg.payload))) {
      ens.add(env.en);
    }
  }
  return ens;
}

/** Removes every provenance APP11 segment (legacy attestation box or C2PA store), returning the clean signed bytes. */
export function stripManifest(jpeg: Uint8Array): Uint8Array {
  if (!isJpeg(jpeg)) throw new Error('Not a JPEG file');
  const segments = parseSegments(jpeg);
  const provenanceEns = provenanceGroupEns(segments);
  const out: Uint8Array[] = [jpeg.subarray(0, 2)];
  let cursor = 2;
  for (const seg of segments) {
    if (seg.start > cursor) out.push(jpeg.subarray(cursor, seg.start));
    const env = seg.marker === MARKER_APP11 ? jpEnvelope(seg.payload) : null;
    const drop = env !== null && provenanceEns.has(env.en);
    if (!drop) out.push(jpeg.subarray(seg.start, seg.end));
    cursor = seg.end;
  }
  out.push(jpeg.subarray(cursor)); // SOS + entropy-coded data + EOI, untouched
  return concatBytes(...out);
}

/**
 * Removes metadata-bearing segments — EXIF/XMP (APP1), IPTC (APP13), and COM
 * comments — while leaving the compressed image data and non-identifying
 * segments (JFIF APP0, ICC color profile APP2, Adobe APP14) byte-identical.
 *
 * Used by de-identification: a "clean" copy must not leak device make/model,
 * EXIF timestamps, or IPTC bylines that the redacted telemetry has dropped.
 * Lossless — the pixel data (SOS → EOI) is never touched. App captures shoot
 * with processing on, so pixels are already upright and no EXIF orientation is
 * needed to display them correctly.
 */
export function stripMetadata(jpeg: Uint8Array): Uint8Array {
  if (!isJpeg(jpeg)) throw new Error('Not a JPEG file');
  const segments = parseSegments(jpeg);
  const out: Uint8Array[] = [jpeg.subarray(0, 2)];
  let cursor = 2;
  for (const seg of segments) {
    if (seg.start > cursor) out.push(jpeg.subarray(cursor, seg.start));
    const drop = seg.marker === MARKER_APP1 || seg.marker === MARKER_APP13 || seg.marker === MARKER_COM;
    if (!drop) out.push(jpeg.subarray(seg.start, seg.end));
    cursor = seg.end;
  }
  out.push(jpeg.subarray(cursor)); // SOS + entropy-coded data + EOI, untouched
  return concatBytes(...out);
}

/**
 * Groups APP11 "JP" segments by box-instance id (En), each group ordered by
 * packet sequence (Z). Returns null for a group whose packet chain is
 * broken (duplicate Z, or a gap — reassembly would be a guess).
 */
function jpGroups(segments: Segment[]): Map<number, Segment[]> {
  const groups = new Map<number, Segment[]>();
  for (const seg of segments) {
    if (seg.marker !== MARKER_APP11) continue;
    const env = jpEnvelope(seg.payload);
    if (!env || env.z === 0) continue;
    const g = groups.get(env.en) ?? [];
    g.push(seg);
    groups.set(env.en, g);
  }
  for (const [en, g] of groups) {
    g.sort((a, b) => (jpEnvelope(a.payload)?.z ?? 0) - (jpEnvelope(b.payload)?.z ?? 0));
    for (let i = 0; i < g.length; i++) {
      if (jpEnvelope(g[i].payload)?.z !== i + 1) groups.delete(en); // broken chain — unusable
    }
  }
  return groups;
}

/** Reassembles one group's JUMBF from its ordered packets. */
function reassemble(group: Segment[]): Uint8Array {
  return concatBytes(...group.map((s) => s.payload.subarray(APP11_ENVELOPE_BYTES)));
}

/** Extracts the first Source Kit attestation manifest, or null if none. */
export function extractManifest(jpeg: Uint8Array): Uint8Array | null {
  if (!isJpeg(jpeg)) return null;
  let segments: Segment[];
  try {
    segments = parseSegments(jpeg);
  } catch {
    return null;
  }
  for (const group of jpGroups(segments).values()) {
    const first = group[0];
    if (!first || !isVerifyApp11(first.payload)) continue;
    const jumbf = reassemble(group);
    // Walk jumb → children; find the 'json' content box.
    if (jumbf.length < 8) return null;
    const jumbLen =
      (jumbf[0] << 24) | (jumbf[1] << 16) | (jumbf[2] << 8) | jumbf[3];
    const children = jumbf.subarray(8, Math.min(jumbLen, jumbf.length));
    let offset = 0;
    while (offset + 8 <= children.length) {
      const len =
        (children[offset] << 24) |
        (children[offset + 1] << 16) |
        (children[offset + 2] << 8) |
        children[offset + 3];
      const type = String.fromCharCode(
        children[offset + 4],
        children[offset + 5],
        children[offset + 6],
        children[offset + 7]
      );
      if (len < 8 || offset + len > children.length) break;
      if (type === 'json') {
        return children.subarray(offset + 8, offset + len);
      }
      offset += len;
    }
    return null;
  }
  return null;
}

/**
 * Returns a new JPEG with the manifest embedded. Any previous Source Kit
 * attestation is stripped first, so a file always carries at most one.
 * The segment is placed after SOI and any APP0 (JFIF) headers.
 */
export function embedManifest(jpeg: Uint8Array, manifest: Uint8Array): Uint8Array {
  const clean = stripManifest(jpeg);
  const segments = buildApp11Segments(manifest); // one or more ISO 19566-5 packets, inserted consecutively

  // Insert after SOI (2 bytes) and any leading APP0 segments.
  let insertAt = 2;
  const parsed = parseSegments(clean);
  for (const seg of parsed) {
    if (seg.marker === MARKER_APP0) insertAt = seg.end;
    else break;
  }
  return concatBytes(clean.subarray(0, insertAt), segments, clean.subarray(insertAt));
}
