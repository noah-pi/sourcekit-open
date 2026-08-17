// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * byteReads.test.ts — Tier-0 byte reads on hand-built fixture byte arrays.
 *
 * Runs under `tsx --test` (node:test) — no test-runner dependency added.
 * Fixtures are tiny hand-assembled JPEG/PNG byte strings (a few hundred
 * bytes each): a JPEG with EXIF (Make/Model/dates/GPS), a COM comment, a
 * standard quantization table and an embedded preview; a PNG with a tEXt
 * chunk; truncated/corrupt variants that must fail CLOSED with an honest
 * reason, never a throw, never a partial read dressed up as complete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sniffFormat,
  readByteLayer,
  readStrings,
  readJpegStructure,
  classifyQuantization,
  extractEmbeddedThumbnail,
  parseExifTiff,
  METADATA_ABSENT_REASON,
} from './byteReads';

/* ------------------------------------------------------------------ */
/* Fixture builders                                                    */
/* ------------------------------------------------------------------ */

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

function concat(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const flat: number[] = [];
  for (const p of parts) for (const b of p) flat.push(b);
  return new Uint8Array(flat);
}

function seg(marker: number, payload: number[] | Uint8Array): number[] {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}

/* JPEG Annex K luma table (natural order) — same constant the parser uses. */
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

/** IJG quality scaling (reimplemented in the test on purpose — independent). */
function scaleStandard(base: number[], q: number): number[] {
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return base.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
}

function dqtSegment(zigzagValues: number[]): number[] {
  return seg(0xdb, [0x00, ...zigzagValues]);
}

/** A tiny standalone "preview" JPEG (SOI + APP0 + EOI). */
function tinyThumbJpeg(): Uint8Array {
  return concat(
    [0xff, 0xd8],
    seg(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    [0xff, 0xd9],
  );
}

/** TIFF (little-endian) with IFD0 + ExifIFD + GPS IFD + IFD1 thumbnail pointer. */
function buildExifTiff(thumb: Uint8Array): Uint8Array {
  const make = ascii('TestCam\0'); // 8
  const model = ascii('TC-1\0'); // 5
  const dt = ascii('2025:07:14 09:31:00\0'); // 20
  const dto = ascii('2025:07:14 09:31:05\0'); // 20

  const ifd0Off = 8;
  const ifd0Size = 2 + 5 * 12 + 4;
  const exifOff = ifd0Off + ifd0Size;
  const exifSize = 2 + 1 * 12 + 4;
  const gpsOff = exifOff + exifSize;
  const gpsSize = 2 + 4 * 12 + 4;
  const ifd1Off = gpsOff + gpsSize;
  const ifd1Size = 2 + 2 * 12 + 4;

  let dataOff = ifd1Off + ifd1Size;
  const makeOff = dataOff; dataOff += make.length;
  const modelOff = dataOff; dataOff += model.length;
  const dtOff = dataOff; dataOff += dt.length;
  const dtoOff = dataOff; dataOff += dto.length;
  const latOff = dataOff; dataOff += 24;
  const lonOff = dataOff; dataOff += 24;
  const thumbOff = dataOff; dataOff += thumb.length;

  const buf = new Uint8Array(dataOff);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x49; buf[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifd0Off, true);

  const entry = (base: number, i: number, tag: number, type: number, count: number, valueOrOffset: number) => {
    const o = base + 2 + i * 12;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, count, true);
    dv.setUint32(o + 8, valueOrOffset, true);
  };
  const inlineAscii = (base: number, i: number, tag: number, s: string) => {
    const o = base + 2 + i * 12;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, 2, true);
    dv.setUint32(o + 4, s.length, true);
    for (let k = 0; k < s.length; k++) buf[o + 8 + k] = s.charCodeAt(k);
  };

  // IFD0: Make, Model, DateTime, ExifIFD ptr, GPS ptr; next → IFD1.
  entry(ifd0Off, 0, 0x010f, 2, make.length, makeOff);
  entry(ifd0Off, 1, 0x0110, 2, model.length, modelOff);
  entry(ifd0Off, 2, 0x0132, 2, dt.length, dtOff);
  entry(ifd0Off, 3, 0x8769, 4, 1, exifOff);
  entry(ifd0Off, 4, 0x8825, 4, 1, gpsOff);
  dv.setUint16(ifd0Off, 5, true);
  dv.setUint32(ifd0Off + 2 + 5 * 12, ifd1Off, true);

  // ExifIFD: DateTimeOriginal.
  entry(exifOff, 0, 0x9003, 2, dto.length, dtoOff);
  dv.setUint16(exifOff, 1, true);

  // GPS IFD: N 40°30'0", W 74°0'0".
  inlineAscii(gpsOff, 0, 0x0001, 'N\0');
  entry(gpsOff, 1, 0x0002, 5, 3, latOff);
  inlineAscii(gpsOff, 2, 0x0003, 'W\0');
  entry(gpsOff, 3, 0x0004, 5, 3, lonOff);
  dv.setUint16(gpsOff, 4, true);
  const rational = (off: number, i: number, num: number, den: number) => {
    dv.setUint32(off + i * 8, num, true);
    dv.setUint32(off + i * 8 + 4, den, true);
  };
  rational(latOff, 0, 40, 1); rational(latOff, 1, 30, 1); rational(latOff, 2, 0, 1);
  rational(lonOff, 0, 74, 1); rational(lonOff, 1, 0, 1); rational(lonOff, 2, 0, 1);

  // IFD1: preview pointer pair; no further IFD.
  entry(ifd1Off, 0, 0x0201, 4, 1, thumbOff);
  entry(ifd1Off, 1, 0x0202, 4, 1, thumb.length);
  dv.setUint16(ifd1Off, 2, true);

  // Data area.
  buf.set(make, makeOff);
  buf.set(model, modelOff);
  buf.set(dt, dtOff);
  buf.set(dto, dtoOff);
  buf.set(thumb, thumbOff);

  return buf;
}

interface JpegOpts {
  dqtZig?: number[];
  withExif?: boolean;
  withThumb?: boolean;
}

function buildJpeg(opts: JpegOpts = {}): Uint8Array {
  const { withExif = true, withThumb = true } = opts;
  const dqtZig = opts.dqtZig ?? ZIGZAG.map((i) => scaleStandard(STD_LUMA, 75)[i]);
  const parts: (number[] | Uint8Array)[] = [[0xff, 0xd8]];
  parts.push(seg(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]));
  if (withExif) {
    const tiff = buildExifTiff(withThumb ? tinyThumbJpeg() : new Uint8Array(0));
    parts.push(seg(0xe1, [...ascii('Exif\0\0'), ...tiff]));
  }
  parts.push(seg(0xfe, ascii('File written by TestCam firmware 1.0')));
  parts.push(dqtSegment(dqtZig));
  // SOF0: 8-bit, 4×4, one component.
  parts.push(seg(0xc0, [8, 0, 4, 0, 4, 1, 1, 0x11, 0]));
  // DHT: one class-0 table with a single code of length 1.
  parts.push(seg(0xc4, [0x00, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00]));
  // SOS + one byte of scan data + EOI.
  parts.push(seg(0xda, [1, 1, 0, 0, 0x3f, 0]));
  parts.push([0x2a, 0xff, 0xd9]);
  return concat(...parts);
}

function buildPng(): Uint8Array {
  const crc = [0, 0, 0, 0]; // CRCs are not validated by this reader — stated in its docs.
  const chunk = (type: string, data: number[]): number[] => {
    const len = data.length;
    return [(len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...ascii(type), ...data, ...crc];
  };
  return concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk('IHDR', [0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0]),
    chunk('tEXt', [...ascii('Software'), 0, ...ascii('PaintTest 2.0')]),
    chunk('IDAT', [0x78, 0x01, 0x01, 0x00]),
    chunk('IEND', []),
  );
}

/* ------------------------------------------------------------------ */
/* Format sniffing                                                     */
/* ------------------------------------------------------------------ */

test('sniffFormat recognizes jpeg/png/bmff/unknown', () => {
  assert.equal(sniffFormat(buildJpeg()), 'jpeg');
  assert.equal(sniffFormat(buildPng()), 'png');
  assert.equal(sniffFormat(concat([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('mp42'), 0, 0, 0, 0, 0])), 'bmff');
  assert.equal(sniffFormat(concat(ascii('{"hello":1}'))), 'unknown');
  assert.equal(sniffFormat(new Uint8Array(0)), 'unknown');
});

/* ------------------------------------------------------------------ */
/* JPEG fixture: structure / quantization / comments / metadata         */
/* ------------------------------------------------------------------ */

test('JPEG structure: marker sequence, dims, encoding, comments', () => {
  const s = readJpegStructure(buildJpeg());
  assert.ok(!('state' in s), 'expected a structure, got a status');
  const names = s.markers.map((m) => m.name);
  assert.deepEqual(names, ['SOI', 'APP0', 'APP1', 'COM', 'DQT', 'SOF0', 'DHT', 'SOS']);
  assert.deepEqual(s.dimensions, { width: 4, height: 4 });
  assert.equal(s.encoding, 'baseline');
  assert.deepEqual(s.comments, ['File written by TestCam firmware 1.0']);
  assert.equal(s.complete, true);
});

test('JPEG quantization: standard table classifies as standard with closest quality 75', () => {
  const s = readJpegStructure(buildJpeg());
  assert.ok(!('state' in s));
  assert.ok(s.quantization);
  assert.equal(s.quantization.class, 'standard');
  assert.equal(s.quantization.closestQuality, 75);
  assert.equal(s.quantization.tableCount, 1);
});

test('JPEG quantization: a uniform non-IJG rescale classifies as adobe-style', () => {
  const rescaled = STD_LUMA.map((v) => Math.max(1, Math.round(v * 0.37)));
  const zig = ZIGZAG.map((i) => rescaled[i]);
  const s = readJpegStructure(buildJpeg({ dqtZig: zig }));
  assert.ok(!('state' in s));
  assert.ok(s.quantization);
  assert.equal(s.quantization.class, 'adobe-style');
  assert.ok(s.quantization.closestQuality !== null);
});

test('JPEG quantization: an arbitrary flat table classifies as non-standard', () => {
  const flat = new Array(64).fill(7);
  const q = classifyQuantization([{ slot: 0, values: flat }]);
  assert.ok(q);
  assert.equal(q.class, 'non-standard');
});

test('JPEG metadata: EXIF entries + GPS text from the fixture', () => {
  const layer = readByteLayer(buildJpeg());
  assert.equal(layer.format, 'jpeg');
  assert.equal(layer.metadata.state, 'observed');
  const byLabel = new Map(layer.metadata.entries.map((e) => [e.label, e.value]));
  assert.equal(byLabel.get('Camera make'), 'TestCam');
  assert.equal(byLabel.get('Camera model'), 'TC-1');
  assert.equal(byLabel.get('Date taken (EXIF original)'), '2025:07:14 09:31:05');
  assert.equal(layer.metadata.gps.present, true);
  assert.match(layer.metadata.gps.text ?? '', /40\.500000° N/);
  assert.match(layer.metadata.gps.text ?? '', /74\.000000° W/);
});

test('JPEG embedded thumbnail: extracted bytes start with a JPEG SOI', () => {
  const t = extractEmbeddedThumbnail(buildJpeg());
  assert.equal(t.state, 'observed');
  if (t.state === 'observed') {
    assert.ok(t.bytes.length > 4);
    assert.equal(t.bytes[0], 0xff);
    assert.equal(t.bytes[1], 0xd8);
    assert.equal(t.bytes[2], 0xff);
    assert.deepEqual([...t.bytes], [...tinyThumbJpeg()]);
  }
});

test('JPEG without EXIF: metadata and thumbnail are absent-with-reason, never missing', () => {
  const bytes = buildJpeg({ withExif: false });
  const layer = readByteLayer(bytes);
  assert.equal(layer.metadata.state, 'absent');
  assert.equal(layer.metadata.reason, METADATA_ABSENT_REASON);
  const t = extractEmbeddedThumbnail(bytes);
  assert.equal(t.state, 'not-applicable');
  assert.ok(t.state === "not-applicable" && t.reason.length > 0);
});

/* ------------------------------------------------------------------ */
/* PNG fixture: correct N/A-with-reason states everywhere               */
/* ------------------------------------------------------------------ */

test('PNG: metadata from tEXt; JPEG structure and thumbnail are N/A with reasons', () => {
  const png = buildPng();
  const layer = readByteLayer(png);
  assert.equal(layer.format, 'png');
  assert.equal(layer.metadata.state, 'observed');
  const entry = layer.metadata.entries.find((e) => e.label.startsWith('Software'));
  assert.ok(entry);
  assert.equal(entry.value, 'PaintTest 2.0');

  const s = readJpegStructure(png);
  assert.ok('state' in s);
  assert.equal(s.state, 'not-applicable');
  if (s.state === 'not-applicable') assert.equal(s.reason, 'Not applicable — not a JPEG.');

  const t = extractEmbeddedThumbnail(png);
  assert.equal(t.state, 'not-applicable');
  assert.ok(t.state === "not-applicable" && t.reason.length > 0);

  // Strings layer still runs — PNG text is readable text in the bytes.
  assert.equal(layer.strings.state, 'observed');
  assert.ok(layer.strings.runs.some((r) => r.includes('PaintTest 2.0')));
});

test('PNG: a PNG with no text chunks reports the normative absence line', () => {
  const bare = concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    // IHDR only + IEND
    [0, 0, 0, 13, ...ascii('IHDR'), 0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, ...ascii('IEND'), 0, 0, 0, 0],
  );
  const layer = readByteLayer(bare);
  assert.equal(layer.metadata.state, 'absent');
  assert.equal(layer.metadata.reason, METADATA_ABSENT_REASON);
});

/* ------------------------------------------------------------------ */
/* Strings layer                                                        */
/* ------------------------------------------------------------------ */

test('strings: ≥4 alnum runs extracted; binary noise and short runs skipped', () => {
  const bytes = concat(
    [0x00, 0x01, 0x02, 0xff],
    ascii('hello world'),
    [0x00],
    ascii('ab'), // too short
    [0x03],
    ascii('XMP:xmpmeta 1234'),
    [0x00, 0x00],
    ascii('!!!!'), // no alnum — noise
    [0x00],
  );
  const s = readStrings(bytes);
  assert.equal(s.state, 'observed');
  assert.equal(s.totalCount, 2);
  assert.deepEqual(s.runs, ['hello world', 'XMP:xmpmeta 1234']);
});

test('strings: no readable runs is an explicit absent state with reason', () => {
  const s = readStrings(new Uint8Array([0, 1, 2, 3, 255, 254]));
  assert.equal(s.state, 'absent');
  assert.ok(s.reason && s.reason.length > 0);
});

/* ------------------------------------------------------------------ */
/* Fail-closed behavior: truncated / corrupt input                      */
/* ------------------------------------------------------------------ */

test('truncated JPEG (cut inside a segment) fails closed with the break offset', () => {
  const full = buildJpeg();
  // Cut inside the APP1 EXIF segment — the DQT never arrives.
  const cutAt = full.indexOf(0xdb) - 10;
  const truncated = full.slice(0, cutAt > 20 ? cutAt : 40);
  const s = readJpegStructure(truncated);
  assert.ok('state' in s);
  assert.equal(s.state, 'error');
  if (s.state === 'error') {
    assert.match(s.reason, /marker stream broke at offset \d+/);
    assert.match(s.reason, /truncated or corrupt/);
  }
});

test('corrupt JPEG (non-FF where a marker belongs) fails closed, no throw', () => {
  const full = buildJpeg();
  const corrupt = full.slice();
  corrupt[4] = 0x41; // clobber the APP0 marker byte with 'A'
  const s = readJpegStructure(corrupt);
  assert.ok('state' in s);
  assert.equal(s.state, 'error');
  if (s.state === 'error') assert.match(s.reason, /0x41|marker/);
});

test('garbage bytes are not a JPEG: not-applicable with reason, never an error', () => {
  const s = readJpegStructure(concat(ascii('this is not a jpeg at all')));
  assert.ok('state' in s);
  assert.equal(s.state, 'not-applicable');
});

test('a truncated TIFF does not throw and reports the break honestly', () => {
  const tiff = buildExifTiff(tinyThumbJpeg());
  const cut = tiff.slice(0, 20); // inside IFD0
  const parsed = parseExifTiff(cut, 0);
  assert.ok(parsed);
  assert.ok(parsed.broken !== null || parsed.entries.length === 0);
  // and a value pointer past EOF is reported, never dereferenced:
  const evil = tiff.slice();
  const dv = new DataView(evil.buffer);
  dv.setUint32(8 + 2 + 8, 0xfffff0, true); // Make's value offset → past EOF
  const parsed2 = parseExifTiff(evil, 0);
  assert.ok(parsed2);
  assert.ok(!parsed2.entries.some((e) => e.label === 'Camera make'));
});

test('empty input: every read returns a state with a reason, nothing throws', () => {
  const empty = new Uint8Array(0);
  assert.equal(sniffFormat(empty), 'unknown');
  const layer = readByteLayer(empty);
  assert.equal(layer.metadata.state, 'absent');
  assert.ok(layer.metadata.reason);
  const s = readJpegStructure(empty);
  assert.ok('state' in s && s.state === 'not-applicable');
  const t = extractEmbeddedThumbnail(empty);
  assert.ok(t.state === 'not-applicable');
});
