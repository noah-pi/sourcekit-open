// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * byteReads.ts — Tier-0 byte reads (ARCHITECTURE §5.1). PURE: bytes in,
 * data out. No DOM, no canvas, no network — safe in a Web Worker and under
 * node:test.
 *
 * These are CUSTODY reads, never content verdicts (r3 honest-caveat
 * guidance): they report what is embedded in the bytes — metadata blocks,
 * readable strings, JPEG structure, quantization tables, an embedded
 * preview — and every read has an explicit not-applicable / absent state
 * WITH A REASON (law L3). Absence is normal and says nothing about the
 * file's honesty (law L4); the reasons say so.
 *
 * Fail-closed rule: a truncated or corrupt stream never yields a partial
 * read dressed up as complete. Parsers stop at the first structural break
 * and report the break with its offset; nothing throws across the API.
 */
import type { SignalStatus } from '../contracts-ext';

/* ================================================================== */
/* Format sniffing                                                     */
/* ================================================================== */

export type ByteFormat = 'jpeg' | 'png' | 'bmff' | 'unknown';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function sniffFormat(bytes: Uint8Array): ByteFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && PNG_SIG.every((b, i) => bytes[i] === b)) return 'png';
  // BMFF brands: 'ftyp' at offset 4 (same probe deskCore/deskItem use).
  if (bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'bmff';
  return 'unknown';
}

/* ================================================================== */
/* Metadata layer (EXIF / XMP / IPTC / PNG text)                       */
/* ================================================================== */

export interface MetadataEntry {
  label: string;
  value: string;
  source: 'exif' | 'xmp' | 'iptc' | 'marker' | 'png-text';
}

export interface MetadataRead {
  state: 'observed' | 'absent';
  entries: MetadataEntry[];
  /** GPS coordinates rendered as TEXT — a map would be a network call. */
  gps: { present: boolean; text: string | null };
  /** Present (and mandatory) when state is 'absent' — L3/L4. */
  reason: string | null;
  /** True when the entry list was capped for display. */
  truncated: boolean;
}

/** Deck fx.meta.stripped — the normative absence line. */
export const METADATA_ABSENT_REASON =
  'No metadata block found. Stripping is common — platforms and editors do it routinely. Absence here says nothing about the file\u2019s honesty.';

const MAX_METADATA_ENTRIES = 60;

/* ------------------------------------------------------------------ */
/* Minimal TIFF/EXIF parser (bounds-checked everywhere, fail closed)   */
/* ------------------------------------------------------------------ */

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

interface TiffCursor {
  bytes: Uint8Array;
  start: number; // absolute offset of the TIFF header
  little: boolean;
  broken: string | null; // first structural break, with offset
}

function u16(c: TiffCursor, off: number): number | null {
  if (off < c.start || off + 2 > c.bytes.length) return null;
  const b = c.bytes;
  return c.little ? b[off] | (b[off + 1] << 8) : (b[off] << 8) | b[off + 1];
}

function u32(c: TiffCursor, off: number): number | null {
  if (off < c.start || off + 4 > c.bytes.length) return null;
  const b = c.bytes;
  return c.little
    ? (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
    : ((b[off] << 24) >>> 0) + ((b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]);
}

interface IfdEntryRaw { tag: number; type: number; count: number; valueOrOffset: number; entryOffset: number }

function readIfd(c: TiffCursor, relOffset: number): { entries: IfdEntryRaw[]; next: number } | null {
  const base = c.start + relOffset;
  const n = u16(c, base);
  if (n === null || n > 512) {
    c.broken ??= `IFD at offset ${relOffset} is unreadable or implausibly large`;
    return null;
  }
  const entries: IfdEntryRaw[] = [];
  for (let i = 0; i < n; i++) {
    const eoff = base + 2 + i * 12;
    const tag = u16(c, eoff);
    const type = u16(c, eoff + 2);
    const count = u32(c, eoff + 4);
    const valueOrOffset = u32(c, eoff + 8);
    if (tag === null || type === null || count === null || valueOrOffset === null) {
      c.broken ??= `IFD entry ${i} runs past the end of the file (offset ${eoff})`;
      return null;
    }
    entries.push({ tag, type, count, valueOrOffset, entryOffset: eoff });
  }
  const next = u32(c, base + 2 + n * 12) ?? 0;
  return { entries, next };
}

/** Absolute offset of an entry's value bytes (inline when ≤4, else pointed). */
function valueOffset(c: TiffCursor, e: IfdEntryRaw): number | null {
  const size = (TYPE_SIZE[e.type] ?? 0) * e.count;
  if (size <= 0 || size > 0x100000) return null;
  if (size <= 4) return e.entryOffset + 8;
  const abs = c.start + e.valueOrOffset;
  if (abs < c.start || abs + size > c.bytes.length) {
    c.broken ??= `tag 0x${e.tag.toString(16)} value runs past the end of the file`;
    return null;
  }
  return abs;
}

function readAscii(c: TiffCursor, e: IfdEntryRaw): string | null {
  const off = valueOffset(c, e);
  if (off === null) return null;
  const size = (TYPE_SIZE[e.type] ?? 0) * e.count;
  let end = off;
  const limit = Math.min(off + size, c.bytes.length);
  while (end < limit && c.bytes[end] !== 0) end++;
  let s = '';
  for (let i = off; i < end; i++) {
    const b = c.bytes[i];
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '';
  }
  return s.trim() || null;
}

function readUInts(c: TiffCursor, e: IfdEntryRaw): number[] | null {
  const off = valueOffset(c, e);
  if (off === null) return null;
  const out: number[] = [];
  for (let i = 0; i < e.count && i < 32; i++) {
    let v: number | null = null;
    if (e.type === 3) v = u16(c, off + i * 2);
    else if (e.type === 4) v = u32(c, off + i * 4);
    else if (e.type === 1) v = c.bytes[off + i] ?? null;
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

function readRational(c: TiffCursor, e: IfdEntryRaw, index: number): number | null {
  const off = valueOffset(c, e);
  if (off === null) return null;
  const num = u32(c, off + index * 8);
  const den = u32(c, off + index * 8 + 4);
  if (num === null || den === null || den === 0) return null;
  return num / den;
}

const IFD0_TAGS: Record<number, string> = {
  0x010e: 'Image description',
  0x010f: 'Camera make',
  0x0110: 'Camera model',
  0x0112: 'Orientation',
  0x0131: 'Software',
  0x0132: 'File date (EXIF)',
  0x013b: 'Artist',
  0x8298: 'Copyright',
};

const EXIF_TAGS: Record<number, string> = {
  0x9003: 'Date taken (EXIF original)',
  0x9004: 'Date digitized (EXIF)',
  0x829a: 'Exposure time',
  0x829d: 'F-number',
  0x8827: 'ISO speed',
  0x920a: 'Focal length',
  0xa002: 'Pixel width (EXIF)',
  0xa003: 'Pixel height (EXIF)',
};

export interface ExifRead {
  entries: MetadataEntry[];
  gps: { present: boolean; text: string | null };
  /** Embedded-preview location (absolute file offsets), when IFD1 carries one. */
  thumbnail: { offset: number; length: number } | null;
  /** First structural break, if any — stated, never hidden. */
  broken: string | null;
}

/**
 * Parse a TIFF block (the payload of a JPEG APP1 "Exif\0\0" segment or a
 * PNG eXIf chunk). Returns null only when the TIFF header itself is not a
 * TIFF header; every later break is reported in `broken`.
 */
export function parseExifTiff(bytes: Uint8Array, start: number): ExifRead | null {
  if (start < 0 || start + 8 > bytes.length) return null;
  const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  const big = bytes[start] === 0x4d && bytes[start + 1] === 0x4d;
  if (!little && !big) return null;
  const c: TiffCursor = { bytes, start, little, broken: null };
  if (u16(c, start + 2) !== 42) return null;
  const ifd0Rel = u32(c, start + 4);
  if (ifd0Rel === null) return null;

  const out: ExifRead = { entries: [], gps: { present: false, text: null }, thumbnail: null, broken: null };

  const ifd0 = readIfd(c, ifd0Rel);
  if (!ifd0) {
    out.broken = c.broken;
    return out;
  }

  let exifRel: number | null = null;
  let gpsRel: number | null = null;

  for (const e of ifd0.entries) {
    const label = IFD0_TAGS[e.tag];
    if (label && (e.type === 2)) {
      const v = readAscii(c, e);
      if (v) out.entries.push({ label, value: v, source: 'exif' });
    } else if (label === 'Orientation' && e.type === 3) {
      const v = readUInts(c, e);
      if (v && v.length > 0) out.entries.push({ label, value: String(v[0]), source: 'exif' });
    } else if (e.tag === 0x8769) {
      exifRel = e.valueOrOffset;
    } else if (e.tag === 0x8825) {
      gpsRel = e.valueOrOffset;
    }
  }

  if (exifRel !== null) {
    const exif = readIfd(c, exifRel);
    if (exif) {
      for (const e of exif.entries) {
        const label = EXIF_TAGS[e.tag];
        if (!label) continue;
        if (e.type === 2) {
          const v = readAscii(c, e);
          if (v) out.entries.push({ label, value: v, source: 'exif' });
        } else if (e.type === 3 || e.type === 4) {
          const v = readUInts(c, e);
          if (v && v.length > 0) out.entries.push({ label, value: v.join(', '), source: 'exif' });
        } else if (e.type === 5) {
          const v = readRational(c, e, 0);
          if (v !== null) {
            const text = e.tag === 0x829a && v < 1 && v > 0 ? `1/${Math.round(1 / v)} s` : `${+v.toFixed(4)}`;
            out.entries.push({ label, value: text, source: 'exif' });
          }
        }
      }
      // MakerNote (0x927c): proprietary — presence is stated, content is not parsed.
      if (exif.entries.some((e) => e.tag === 0x927c)) {
        out.entries.push({ label: 'MakerNote', value: 'present (proprietary manufacturer block — not parsed)', source: 'exif' });
      }
    }
  }

  if (gpsRel !== null) {
    const gps = readIfd(c, gpsRel);
    if (gps) {
      let latRef: string | null = null;
      let lonRef: string | null = null;
      let lat: number[] | null = null;
      let lon: number[] | null = null;
      let alt: number | null = null;
      for (const e of gps.entries) {
        if (e.tag === 0x0001 && e.type === 2) latRef = readAscii(c, e);
        else if (e.tag === 0x0003 && e.type === 2) lonRef = readAscii(c, e);
        else if (e.tag === 0x0002 && e.type === 5 && e.count >= 3) {
          lat = [readRational(c, e, 0), readRational(c, e, 1), readRational(c, e, 2)].filter((v): v is number => v !== null);
        } else if (e.tag === 0x0004 && e.type === 5 && e.count >= 3) {
          lon = [readRational(c, e, 0), readRational(c, e, 1), readRational(c, e, 2)].filter((v): v is number => v !== null);
        } else if (e.tag === 0x0006 && e.type === 5) {
          alt = readRational(c, e, 0);
        }
      }
      if (lat && lat.length === 3 && lon && lon.length === 3) {
        const toDeg = (dms: number[]) => dms[0] + dms[1] / 60 + dms[2] / 3600;
        const latDeg = toDeg(lat) * (latRef === 'S' ? -1 : 1);
        const lonDeg = toDeg(lon) * (lonRef === 'W' ? -1 : 1);
        out.gps = {
          present: true,
          text:
            `${Math.abs(latDeg).toFixed(6)}° ${latDeg < 0 ? 'S' : 'N'}, ${Math.abs(lonDeg).toFixed(6)}° ${lonDeg < 0 ? 'W' : 'E'}` +
            (alt !== null ? `, altitude ${alt.toFixed(1)} m` : '') +
            ' — as declared in EXIF; rendered as text (a map would be a network call)',
        };
      } else {
        out.gps = { present: true, text: 'GPS block present but coordinates could not be decoded — stated, not guessed' };
      }
    }
  }

  // IFD1: the embedded-preview pointer pair (JPEGInterchangeFormat/Length).
  if (ifd0.next > 0) {
    const ifd1 = readIfd(c, ifd0.next);
    if (ifd1) {
      let thumbOff: number | null = null;
      let thumbLen: number | null = null;
      for (const e of ifd1.entries) {
        if (e.tag === 0x0201) thumbOff = e.valueOrOffset;
        else if (e.tag === 0x0202) thumbLen = e.valueOrOffset;
      }
      if (thumbOff !== null && thumbLen !== null && thumbLen > 0) {
        const abs = c.start + thumbOff;
        if (abs >= c.start && abs + thumbLen <= bytes.length) {
          out.thumbnail = { offset: abs, length: thumbLen };
        } else {
          c.broken ??= `the embedded-preview pointer runs past the end of the file (offset ${abs}, length ${thumbLen})`;
        }
      }
    }
  }

  out.broken = c.broken;
  return out;
}

/* ------------------------------------------------------------------ */
/* XMP packet fields (presence + a few named fields, honestly bounded)  */
/* ------------------------------------------------------------------ */

const XMP_FIELDS: { label: string; pattern: RegExp }[] = [
  { label: 'Creator tool (XMP)', pattern: /xmp:CreatorTool="([^"]{1,120})"/ },
  { label: 'Create date (XMP)', pattern: /xmp:CreateDate="([^"]{1,60})"/ },
  { label: 'Modify date (XMP)', pattern: /xmp:ModifyDate="([^"]{1,60})"/ },
  { label: 'Metadata date (XMP)', pattern: /xmp:MetadataDate="([^"]{1,60})"/ },
  { label: 'Document ID (XMP)', pattern: /xmpMM:DocumentID="([^"]{1,120})"/ },
  { label: 'Credit (XMP)', pattern: /photoshop:Credit="([^"]{1,120})"/ },
];

function readXmpPacket(packet: Uint8Array): MetadataEntry[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(packet);
  } catch {
    return [];
  }
  const entries: MetadataEntry[] = [];
  for (const f of XMP_FIELDS) {
    const m = f.pattern.exec(text);
    if (m) entries.push({ label: f.label, value: m[1], source: 'xmp' });
  }
  if (entries.length === 0) {
    entries.push({ label: 'XMP packet', value: `present (${packet.length} bytes) — no named fields this build reads`, source: 'xmp' });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* ASCII search helper (FBMD-style markers)                            */
/* ------------------------------------------------------------------ */

function containsAscii(bytes: Uint8Array, needle: string): boolean {
  if (needle.length === 0 || bytes.length < needle.length) return false;
  const codes = Array.from(needle, (ch) => ch.charCodeAt(0));
  outer: for (let i = 0; i + codes.length <= bytes.length; i++) {
    for (let j = 0; j < codes.length; j++) {
      if (bytes[i + j] !== codes[j]) continue outer;
    }
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* JPEG / PNG segment walks for the metadata layer                     */
/* ------------------------------------------------------------------ */

const XMP_NS = 'http://ns.adobe.com/xap/1.0/';

function asciiAt(bytes: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = off; i < off + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

interface SegmentWalk {
  entries: MetadataEntry[];
  exif: ExifRead | null;
  /** COM comments (also surfaced by the JPEG structure read). */
  comments: string[];
  broken: string | null;
}

/** Walk JPEG APPn/COM segments for metadata; stops at SOS/EOI/break. */
function walkJpegMetadata(bytes: Uint8Array): SegmentWalk {
  const out: SegmentWalk = { entries: [], exif: null, comments: [], broken: null };
  let off = 2; // after SOI
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) {
      out.broken = `expected a marker at offset ${off} — the header is truncated or corrupt`;
      break;
    }
    const marker = bytes[off + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI — metadata lives before scan data
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    const len = (bytes[off + 2] << 8) | bytes[off + 3];
    if (len < 2 || off + 2 + len > bytes.length) {
      out.broken = `segment at offset ${off} declares a length past the end of the file — truncated or corrupt`;
      break;
    }
    const body = off + 4;
    const bodyLen = len - 2;
    if (marker === 0xe1) {
      if (bodyLen >= 6 && asciiAt(bytes, body, 6) === 'Exif\0\0') {
        const exif = parseExifTiff(bytes, body + 6);
        if (exif) {
          out.exif = exif;
          out.entries.push(...exif.entries);
          if (exif.broken) out.broken ??= `EXIF: ${exif.broken}`;
        }
      } else if (bodyLen >= XMP_NS.length + 1 && asciiAt(bytes, body, XMP_NS.length) === XMP_NS) {
        out.entries.push(...readXmpPacket(bytes.subarray(body + XMP_NS.length + 1, body + bodyLen)));
      }
    } else if (marker === 0xed) {
      if (bodyLen >= 14 && asciiAt(bytes, body, 13) === 'Photoshop 3.0') {
        out.entries.push({ label: 'IPTC block', value: 'present (Photoshop 3.0 APP13) — block-level read only in this build', source: 'iptc' });
      }
    } else if (marker === 0xfe) {
      let text = '';
      try {
        text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(body, body + bodyLen)).trim();
      } catch { text = ''; }
      if (text) out.comments.push(text.length > 200 ? `${text.slice(0, 200)}…` : text);
    }
    off += 2 + len;
  }
  return out;
}

/** Walk PNG chunks for tEXt / zTXt / iTXt / eXIf metadata. */
function walkPngMetadata(bytes: Uint8Array): SegmentWalk {
  const out: SegmentWalk = { entries: [], exif: null, comments: [], broken: null };
  let off = 8;
  let seenIdat = false;
  while (off + 8 <= bytes.length) {
    const len = ((bytes[off] << 24) >>> 0) + ((bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]);
    const type = asciiAt(bytes, off + 4, 4);
    if (off + 12 + len > bytes.length) {
      out.broken = `chunk ${type} at offset ${off} runs past the end of the file — truncated or corrupt`;
      break;
    }
    const data = off + 8;
    if (type === 'IDAT') seenIdat = true;
    if (type === 'IEND') break;
    if (type === 'tEXt') {
      const nul = bytes.indexOf(0, data);
      if (nul > data && nul < data + len) {
        const keyword = asciiAt(bytes, data, nul - data);
        const value = asciiAt(bytes, nul + 1, data + len - nul - 1).trim();
        if (value) out.entries.push({ label: `${keyword} (PNG text)`, value: value.length > 200 ? `${value.slice(0, 200)}…` : value, source: 'png-text' });
      }
    } else if (type === 'zTXt' || type === 'iTXt') {
      const nul = bytes.indexOf(0, data);
      const keyword = nul > data && nul < data + len ? asciiAt(bytes, data, nul - data) : type;
      out.entries.push({ label: `${keyword} (PNG ${type})`, value: 'compressed text chunk — presence noted, not inflated in this build', source: 'png-text' });
    } else if (type === 'eXIf') {
      const exif = parseExifTiff(bytes, data);
      if (exif) {
        out.exif = exif;
        out.entries.push(...exif.entries.map((en) => ({ ...en, label: `${en.label} (PNG eXIf)` })));
        if (exif.broken) out.broken ??= `EXIF: ${exif.broken}`;
      }
    }
    if (seenIdat && type === 'IDAT') { /* metadata can still follow; keep walking */ }
    off += 12 + len;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Strings layer (≥4 printable runs, r3 §12)                            */
/* ------------------------------------------------------------------ */

export interface StringsRead {
  state: 'observed' | 'absent';
  /** The first runs found, capped — display copy, not the full scan. */
  runs: string[];
  /** Total qualifying runs in the whole byte array. */
  totalCount: number;
  truncated: boolean;
  reason: string | null;
}

const STRINGS_MIN_RUN = 4;
const STRINGS_MAX_LISTED = 120;
const STRINGS_MAX_RUN_SHOWN = 96;

export function readStrings(bytes: Uint8Array): StringsRead {
  const runs: string[] = [];
  let total = 0;
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    if (b >= 0x20 && b < 0x7f) {
      let j = i + 1;
      while (j < n && bytes[j] >= 0x20 && bytes[j] < 0x7f) j++;
      const runLen = j - i;
      if (runLen >= STRINGS_MIN_RUN) {
        // Require at least one alphanumeric — pure punctuation runs are noise.
        let hasAlnum = false;
        for (let k = i; k < j; k++) {
          const c = bytes[k];
          if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) { hasAlnum = true; break; }
        }
        if (hasAlnum) {
          total++;
          if (runs.length < STRINGS_MAX_LISTED) {
            let s = '';
            const limit = Math.min(j, i + STRINGS_MAX_RUN_SHOWN);
            for (let k = i; k < limit; k++) s += String.fromCharCode(bytes[k]);
            runs.push(runLen > STRINGS_MAX_RUN_SHOWN ? `${s}…` : s);
          }
        }
      }
      i = j;
    } else {
      i++;
    }
  }
  return {
    state: total > 0 ? 'observed' : 'absent',
    runs,
    totalCount: total,
    truncated: total > runs.length,
    reason: total > 0 ? null : 'no readable text runs (≥4 characters) found in these bytes',
  };
}

/* ------------------------------------------------------------------ */
/* The byte-reads layer (format-dispatched)                            */
/* ------------------------------------------------------------------ */

export interface ByteReads {
  format: ByteFormat;
  metadata: MetadataRead;
  strings: StringsRead;
  /** First structural break encountered while reading metadata, if any. */
  metadataProblem: string | null;
}

export function readByteLayer(bytes: Uint8Array): ByteReads {
  const format = sniffFormat(bytes);
  const strings = readStrings(bytes);

  let entries: MetadataEntry[] = [];
  let gps: { present: boolean; text: string | null } = { present: false, text: null };
  let broken: string | null = null;

  if (format === 'jpeg') {
    const walk = walkJpegMetadata(bytes);
    entries = walk.entries;
    broken = walk.broken;
    if (walk.exif?.gps.present) gps = walk.exif.gps;
  } else if (format === 'png') {
    const walk = walkPngMetadata(bytes);
    entries = walk.entries;
    broken = walk.broken;
    if (walk.exif?.gps.present) gps = walk.exif.gps;
  }

  // FBMD-style marker: a Facebook process marker — presence and absence are both normal.
  if (containsAscii(bytes, 'FBMD')) {
    entries.push({
      label: 'FBMD marker',
      value: 'present — a Facebook process marker; presence and absence are both normal',
      source: 'marker',
    });
  }

  const truncated = entries.length > MAX_METADATA_ENTRIES;
  if (truncated) entries = entries.slice(0, MAX_METADATA_ENTRIES);

  const metadata: MetadataRead = {
    state: entries.length > 0 || gps.present ? 'observed' : 'absent',
    entries,
    gps,
    reason:
      entries.length > 0 || gps.present
        ? null
        : format === 'unknown' || format === 'bmff'
          ? 'No photo-style metadata block (EXIF/XMP/IPTC) found in this container. That is normal for this file type — absence says nothing about the file\u2019s honesty.'
          : METADATA_ABSENT_REASON,
    truncated,
  };

  return { format, metadata, strings, metadataProblem: broken };
}

/* ================================================================== */
/* JPEG structure: marker sequence, COM comments, quantization          */
/* ================================================================== */

export interface JpegMarker {
  code: number;
  name: string;
  offset: number;
  /** Segment length including the 2 length bytes; null for standalone markers. */
  length: number | null;
}

export type QuantClass = 'standard' | 'adobe-style' | 'non-standard';

export interface QuantTableInfo {
  /** Which family of software last saved this file — a family claim, labeled. */
  class: QuantClass;
  /**
   * Closest IJG-style quality estimate (1–100). An estimate, not a
   * measurement; an incomplete table set can misclassify (fx.jpeg.qt.note).
   */
  closestQuality: number | null;
  tableCount: number;
  note: string;
}

export interface JpegStructure {
  markers: JpegMarker[];
  comments: string[];
  quantization: QuantTableInfo | null;
  encoding: 'baseline' | 'progressive' | 'other' | null;
  dimensions: { width: number; height: number } | null;
  /**
   * True when the marker walk ended at SOS/EOI with a complete header.
   * False is never returned silently — readJpegStructure fails closed to a
   * SignalStatus error with the break offset instead.
   */
  complete: true;
}

const MARKER_NAMES: Record<number, string> = {
  0xc0: 'SOF0', 0xc1: 'SOF1', 0xc2: 'SOF2', 0xc3: 'SOF3',
  0xc5: 'SOF5', 0xc6: 'SOF6', 0xc7: 'SOF7',
  0xc8: 'JPG', 0xc9: 'SOF9', 0xca: 'SOF10', 0xcb: 'SOF11',
  0xcc: 'DAC', 0xcd: 'SOF13', 0xce: 'SOF14', 0xcf: 'SOF15',
  0xc4: 'DHT', 0xd8: 'SOI', 0xd9: 'EOI', 0xda: 'SOS',
  0xdb: 'DQT', 0xdc: 'DNL', 0xdd: 'DRI', 0xde: 'DHP', 0xdf: 'EXP',
  0xfe: 'COM',
};
for (let i = 0; i <= 15; i++) MARKER_NAMES[0xe0 + i] = `APP${i}`;
for (let i = 0; i <= 7; i++) MARKER_NAMES[0xd0 + i] = `RST${i}`;
MARKER_NAMES[0x01] = 'TEM';

/* JPEG Annex K base tables (the IJG standard tables, natural order). */
const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

/** Zigzag scan order → natural (row-major) index. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

/** IJG quality scaling: quality q → scaled standard table. */
function scaleStandard(base: number[], q: number): number[] {
  const qq = Math.max(1, Math.min(100, Math.round(q)));
  const scale = qq < 50 ? Math.floor(5000 / qq) : 200 - qq * 2;
  return base.map((v) => {
    const s = Math.floor((v * scale + 50) / 100);
    return Math.max(1, Math.min(255, s));
  });
}

interface ParsedQuantTable { slot: number; values: number[] /* natural order */ }

function parseDqt(bytes: Uint8Array, body: number, bodyLen: number): ParsedQuantTable[] {
  const tables: ParsedQuantTable[] = [];
  let p = body;
  const end = body + bodyLen;
  while (p < end) {
    const pq = bytes[p] >> 4;
    const tq = bytes[p] & 0x0f;
    p++;
    const need = pq === 0 ? 64 : 128;
    if (pq > 1 || p + need > end) break;
    const zig: number[] = new Array(64);
    for (let i = 0; i < 64; i++) {
      zig[i] = pq === 0 ? bytes[p + i] : (bytes[p + i * 2] << 8) | bytes[p + i * 2 + 1];
    }
    p += need;
    const natural: number[] = new Array(64);
    for (let i = 0; i < 64; i++) natural[ZIGZAG[i]] = zig[i];
    tables.push({ slot: tq, values: natural });
  }
  return tables;
}

function maxAbsDiff(a: number[], b: number[]): number {
  let m = 0;
  for (let i = 0; i < 64; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function totalAbsDiff(a: number[], b: number[]): number {
  let t = 0;
  for (let i = 0; i < 64; i++) t += Math.abs(a[i] - b[i]);
  return t;
}

/** Closest IJG quality for one table against both base tables. */
function closestQuality(values: number[]): { q: number; maxDiff: number; totalDiff: number } {
  let best = { q: 50, maxDiff: Infinity, totalDiff: Infinity };
  for (let q = 1; q <= 100; q++) {
    for (const base of [STD_LUMA, STD_CHROMA]) {
      const scaled = scaleStandard(base, q);
      const md = maxAbsDiff(values, scaled);
      const td = totalAbsDiff(values, scaled);
      if (td < best.totalDiff) best = { q, maxDiff: md, totalDiff: td };
    }
  }
  return best;
}

/**
 * Is this table a UNIFORM scale of a standard table (any real factor),
 * even when no exact IJG quality matches? Adobe-family savers historically
 * scale the standard tables with their own curve; this detects that family
 * shape without claiming a specific product.
 */
function uniformScaleResidual(values: number[]): { residual: number; factor: number } {
  let best = { residual: Infinity, factor: 1 };
  for (const base of [STD_LUMA, STD_CHROMA]) {
    // Median ratio as the scale estimate (robust to a few outlier cells).
    const ratios: number[] = [];
    for (let i = 0; i < 64; i++) if (base[i] > 0) ratios.push(values[i] / base[i]);
    ratios.sort((a, b) => a - b);
    const f = ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)] : 1;
    let residual = 0;
    for (let i = 0; i < 64; i++) residual = Math.max(residual, Math.abs(values[i] - base[i] * f));
    if (residual < best.residual) best = { residual, factor: f };
  }
  return best;
}

/** Classify one JPEG's quantization tables (r3 ternary, honestly caveated). */
export function classifyQuantization(tables: ParsedQuantTable[]): QuantTableInfo | null {
  if (tables.length === 0) return null;
  const perTable = tables.map((t) => ({
    slot: t.slot,
    closest: closestQuality(t.values),
    uniform: uniformScaleResidual(t.values),
  }));
  const exactStandard = perTable.filter((t) => t.closest.maxDiff === 0).length;
  const adobeLike = perTable.filter(
    (t) => t.closest.maxDiff > 0 && t.uniform.residual <= 2,
  ).length;

  let klass: QuantClass;
  if (exactStandard === perTable.length) klass = 'standard';
  else if (exactStandard + adobeLike === perTable.length) klass = 'adobe-style';
  else klass = 'non-standard';

  // Closest-quality estimate: the first table (luma in practice), vs IJG.
  const q = perTable[0].closest.q;

  const note =
    'The class tells you which family of software last saved this file. ' +
    '“Closest quality” is an estimate, not a measurement; an incomplete table set can misclassify. ' +
    (klass === 'standard'
      ? `These tables exactly match the IJG standard tables${exactStandard === 1 && perTable.length > 1 ? ' (at least one table)' : ''}.`
      : klass === 'adobe-style'
        ? 'These tables track the standard tables at a non-IJG scale — the shape Adobe-family savers produce. Family-level only.'
        : 'These tables match neither the IJG standard tables nor a uniform rescale of them — a custom table set.');

  return { class: klass, closestQuality: q, tableCount: tables.length, note };
}

/**
 * JPEG structural read. Fails closed: any structural break before the scan
 * data begins returns a SignalStatus error naming the break offset — a
 * partial marker map is never presented as the file's structure.
 */
export function readJpegStructure(bytes: Uint8Array): JpegStructure | SignalStatus {
  if (sniffFormat(bytes) !== 'jpeg') {
    return { state: 'not-applicable', reason: 'Not applicable — not a JPEG.' };
  }
  const markers: JpegMarker[] = [{ code: 0xd8, name: 'SOI', offset: 0, length: null }];
  const comments: string[] = [];
  const quantTables: ParsedQuantTable[] = [];
  let encoding: JpegStructure['encoding'] = null;
  let dimensions: JpegStructure['dimensions'] = null;

  const brk = (off: number, what: string): SignalStatus => ({
    state: 'error',
    reason: `the marker stream broke at offset ${off} — ${what}. The file is truncated or corrupt; only complete structural reads are reported.`,
  });

  let off = 2;
  for (;;) {
    if (off + 2 > bytes.length) return brk(off, 'ran out of bytes waiting for a marker');
    if (bytes[off] !== 0xff) return brk(off, `found 0x${bytes[off].toString(16).padStart(2, '0')} where a 0xFF marker prefix belongs`);
    // Fill bytes (0xFF padding) before the marker code are legal.
    let m = off + 1;
    while (m < bytes.length && bytes[m] === 0xff) m++;
    if (m >= bytes.length) return brk(off, 'ran out of bytes inside marker padding');
    const code = bytes[m];
    if (code === 0x00) return brk(off, 'a stuffed 0xFF00 byte pair where a marker belongs — the header is corrupt');
    if (code === 0xd9) {
      markers.push({ code, name: 'EOI', offset: off, length: null });
      break;
    }
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      markers.push({ code, name: MARKER_NAMES[code] ?? `0x${code.toString(16)}`, offset: off, length: null });
      off = m + 1;
      continue;
    }
    if (m + 3 > bytes.length) return brk(off, 'ran out of bytes reading a segment length');
    const len = (bytes[m + 1] << 8) | bytes[m + 2];
    if (len < 2) return brk(off, `segment declares an impossible length (${len})`);
    const body = m + 3;
    if (body + (len - 2) > bytes.length) return brk(off, `segment declares ${len} bytes but the file ends first`);
    const name = MARKER_NAMES[code] ?? `0x${code.toString(16)}`;
    markers.push({ code, name, offset: off, length: len });

    if (code === 0xfe) {
      let text = '';
      try {
        text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(body, body + len - 2)).trim();
      } catch { text = ''; }
      if (text) comments.push(text.length > 200 ? `${text.slice(0, 200)}…` : text);
    } else if (code === 0xdb) {
      quantTables.push(...parseDqt(bytes, body, len - 2));
    } else if (code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc) {
      // SOFn: precision(1) height(2) width(2) components(1)
      if (len >= 8) {
        const height = (bytes[body + 1] << 8) | bytes[body + 2];
        const width = (bytes[body + 3] << 8) | bytes[body + 4];
        dimensions = { width, height };
        encoding = code === 0xc0 || code === 0xc1 ? 'baseline' : code === 0xc2 ? 'progressive' : 'other';
      }
    }
    if (code === 0xda) break; // scan data follows — structure before it is complete
    off = body + (len - 2);
  }

  if (markers.length < 2) {
    return { state: 'error', reason: 'no JPEG segments beyond the SOI marker — the file is truncated or not really a JPEG.' };
  }

  return {
    markers,
    comments,
    quantization: classifyQuantization(quantTables),
    encoding,
    dimensions,
    complete: true,
  };
}

/* ================================================================== */
/* Embedded thumbnail extraction (bytes only — decode/diff is canvas)   */
/* ================================================================== */

/**
 * Extraction result. NOTE: the variants are spelled out instead of reusing
 * SignalStatus because SignalStatus has its own 'observed' variant without
 * `bytes` — a shared 'observed' literal would defeat narrowing.
 */
export type ThumbnailExtraction =
  | { state: 'observed'; bytes: Uint8Array }
  | { state: 'not-applicable'; reason: string }
  | { state: 'not-run'; reason: string }
  | { state: 'error'; reason: string };

/** Deck fx.thumb.none. */
export const THUMB_ABSENT_REASON = 'No embedded preview found — normal for many encoders.';

export function extractEmbeddedThumbnail(bytes: Uint8Array): ThumbnailExtraction {
  const format = sniffFormat(bytes);
  if (format === 'bmff') {
    return { state: 'not-applicable', reason: 'Not applicable — embedded previews are a photo-container read; this is a video container.' };
  }
  if (format === 'unknown') {
    return { state: 'not-applicable', reason: 'Not applicable — not a JPEG or PNG container.' };
  }
  const walk = format === 'jpeg' ? walkJpegMetadata(bytes) : walkPngMetadata(bytes);
  if (!walk.exif) {
    return { state: 'not-applicable', reason: `No EXIF block to carry a preview. ${THUMB_ABSENT_REASON}` };
  }
  if (walk.broken && !walk.exif.thumbnail) {
    return {
      state: 'error',
      reason: `the metadata stream broke (${walk.broken}) before a preview could be confirmed absent — stated rather than guessed`,
    };
  }
  if (!walk.exif.thumbnail) {
    return { state: 'not-applicable', reason: `The EXIF block carries no preview pointer. ${THUMB_ABSENT_REASON}` };
  }
  const { offset, length } = walk.exif.thumbnail;
  const slice = bytes.slice(offset, offset + length);
  if (slice.length >= 3 && slice[0] === 0xff && slice[1] === 0xd8 && slice[2] === 0xff) {
    return { state: 'observed', bytes: slice };
  }
  return {
    state: 'error',
    reason: 'the EXIF preview pointer does not point at a JPEG preview — the block is malformed; stated, not guessed',
  };
}
