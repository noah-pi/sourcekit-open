// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Genuine C2PA ("Content Credentials") support, implemented from the spec
 * with no external SDK:
 *
 *   JPEG APP11 (ISO 19566-5 JUMBF)
 *     └── c2pa store ── manifest (c2ma)
 *           ├── c2pa.claim        (CBOR: generator, title, assertion hashes)
 *           ├── c2pa.assertions   (c2as)
 *           │     ├── c2pa.hash.data        (CBOR: byte-exclusion + SHA-256)
 *           │     └── com.verify.telemetry  (JSON: capture context)
 *           └── c2pa.signature    (COSE_Sign1, ES256, x5chain = device cert)
 *
 * The hash.data assertion hard-binds the signature to the media bytes via a
 * byte-range exclusion, so any post-signing edit fails validation here and in
 * third-party verifiers (c2patool, verify.contentauthenticity.org).
 *
 * Output is checked against c2pa-rs: clean files report only
 * `signingCredential.untrusted` (the device cert is self-signed and off the
 * C2PA trust list), tampered files report `assertion.dataHash.mismatch`.
 *
 * Pure module — no React Native dependencies.
 */

import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { Encoder, decode } from 'cbor-x';
import { asciiToBytes, bytesToHex, concatBytes, utf8ToBytes, bytesToUtf8, hexToBytes, bytesToBase64, base64ToBytes } from '../lib/bytes';
import { derToP1363LowS } from '../lib/der';
import { ecPublicKeyFromCert } from '../lib/cert';
import { PQ_ALG, PQ_CUSTODY, PQ_SIZES, pqFingerprint, pqPublicBlockFrom, pqVerify, type PqLayerCheck } from '../lib/pq';
import { parseCertificate, publicKeyFromCert, verifyRsaPss } from '../lib/x509';
import { parseRootBoxes, type RootBox } from './bmff';

// cbor-x must not wrap Uint8Array in CBOR tag 64 or JS Maps in tag 259.
const encoder = new Encoder({ tagUint8Array: false, useRecords: false });
const encode = (v: unknown): Uint8Array => encoder.encode(v);

/** COSE algorithm label → display name (RFC 8152 §16; C2PA's allowed list). */
const COSE_ALG_NAMES: Record<number, string> = {
  [-7]: 'ES256',
  [-8]: 'EdDSA',
  [-35]: 'ES384',
  [-36]: 'ES512',
  [-37]: 'PS256',
  [-38]: 'PS384',
  [-39]: 'PS512',
};

/** Reads a CBOR map entry regardless of whether cbor-x returned a Map or a plain object. */
function mapGet(m: unknown, key: unknown): unknown {
  if (m instanceof Map) return m.get(key);
  if (m && typeof m === 'object') return (m as Record<string, unknown>)[String(key)];
  return undefined;
}

/**
 * Normalizes a claim's assertion reference URL to the bare label. Two forms
 * occur: shorthand `self#jumbf=c2pa.assertions/<label>` and store-qualified
 * `self#jumbf=/c2pa/<manifest>/c2pa.assertions/<label>` (c2pa-rs, Truepic).
 * Anything else is returned unchanged, so it matches no box and fails closed.
 */
function assertionRefLabel(url: string): string {
  const m = url.match(/^self#jumbf=(?:\/c2pa\/[^/]+\/)?c2pa\.assertions\/(.+)$/);
  return m ? m[1] : url;
}

// ---------------------------------------------------------------------------
// JUMBF boxes
// ---------------------------------------------------------------------------

const UUID_SUFFIX = [0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
function c2paUuid(prefix: string): Uint8Array {
  return concatBytes(asciiToBytes(prefix), new Uint8Array(UUID_SUFFIX));
}
export const UUID_C2PA = c2paUuid('c2pa');
const UUID_C2MA = c2paUuid('c2ma');
const UUID_C2AS = c2paUuid('c2as');
const UUID_C2CL = c2paUuid('c2cl');
const UUID_C2CS = c2paUuid('c2cs');
const UUID_CBOR = c2paUuid('cbor');
const UUID_JSON = c2paUuid('json');
const UUID_JPEG = c2paUuid('jpeg');

// ---------------------------------------------------------------------------
// Standard assertion labels. Spellings come from the vendored C2PA SDK 2.3
// StandardAssertionLabel enum (modules/c2pa-ios …/Manifest/
// StandardAssertionLabel.swift). Emitted by verifyAssertionBoxes, parsed
// back by parseOneManifest.
// ---------------------------------------------------------------------------
export const LABEL_ACTIONS_V2 = 'c2pa.actions.v2';
export const LABEL_ASSET_TYPE_V2 = 'c2pa.asset-type.v2';
export const LABEL_METADATA = 'c2pa.metadata';
export const LABEL_SOFT_BINDING = 'c2pa.soft-binding';
export const LABEL_THUMBNAIL_CLAIM_JPEG = 'c2pa.thumbnail.claim.jpeg';
export const LABEL_TRAINING_MINING = 'c2pa.training-mining';
/** Signed stereo depth. C2PA 2.2 §18.21 Depthmap, §18.8 Collection Data Hash. */
export const LABEL_DEPTHMAP_GDEPTH = 'c2pa.depthmap.GDepth';
export const LABEL_COLLECTION_HASH = 'c2pa.hash.collection.data';
/**
 * Secondary viewpoint as a standard ingredient (C2PA 2.2 §18.11,
 * ingredient.v3) with relationship 'componentOf'. Its 512px thumbnail rides
 * as c2pa.thumbnail.ingredient.jpeg; the full-res bytes stay in the vault,
 * committed by the ingredient's data hash.
 */
export const LABEL_INGREDIENT_V3 = 'c2pa.ingredient.v3';
export const LABEL_THUMBNAIL_INGREDIENT_JPEG = 'c2pa.thumbnail.ingredient.jpeg';

/** IPTC digitalSourceType URI for an untouched camera capture. */
export const DIGITAL_SOURCE_TYPE_DIGITAL_CAPTURE =
  'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture';

/**
 * Soft-binding algorithm id for the capture pHash (src/lib/phash.ts): 32×32
 * ITU-R 601 luma → 32×32 DCT-II → 8×8 lowest-frequency magnitudes vs their
 * median → 64 bits. Recovery metadata after sidecar loss; the spec forbids
 * treating a soft binding as a hard one.
 */
export const SOFT_BINDING_ALG_PHASH = 'com.verify.phash-dct64/1';

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function box(type: string, content: Uint8Array): Uint8Array {
  return concatBytes(u32be(content.length + 8), asciiToBytes(type), content);
}

/** JUMBF description+content superbox. toggle 0x03: requestable + has children. */
function jumbBox(uuid: Uint8Array, label: string, ...contents: Uint8Array[]): Uint8Array {
  const jumd = box('jumd', concatBytes(uuid, new Uint8Array([0x03]), asciiToBytes(label), new Uint8Array([0])));
  return box('jumb', concatBytes(jumd, ...contents));
}

/** SHA-256 over a jumb box's CONTENT (after its 8-byte header). */
function hashJumbContent(jumb: Uint8Array): Uint8Array {
  return sha256(jumb.subarray(8));
}

// ---------------------------------------------------------------------------
// COSE_Sign1 (RFC 9052), ES256, detached payload — as C2PA requires
// ---------------------------------------------------------------------------

/** CBOR byte-string wrapper. Exported so the verifier can rebuild the exact countersigned message. */
export function bstr(x: Uint8Array): Uint8Array {
  const n = x.length;
  let head: Uint8Array;
  if (n < 24) head = new Uint8Array([0x40 | n]);
  else if (n < 256) head = new Uint8Array([0x58, n]);
  else if (n < 65536) head = new Uint8Array([0x59, (n >> 8) & 0xff, n & 0xff]);
  else head = new Uint8Array([0x5a, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  return concatBytes(head, x);
}

function cborText(s: string): Uint8Array {
  const b = asciiToBytes(s);
  return concatBytes(new Uint8Array([0x60 | b.length]), b);
}

/** tstContainer per C2PA spec (Example 2 CDDL): { tstTokens: [ { val }, ... ] }.
 *  Multiple entries are witness cosigning: independent TSAs countersign the
 *  same signature. */
function tstContainer(tokens: Uint8Array[]): Uint8Array {
  const arr = 0x80 | tokens.length; // up to 23 witnesses; we use 2–3
  return concatBytes(
    new Uint8Array([0xa1]), cborText('tstTokens'), new Uint8Array([arr]),
    ...tokens.map((t) => concatBytes(new Uint8Array([0xa1]), cborText('val'), bstr(t)))
  );
}

/**
 * Exact pad length so the "pad" entry grows the unprotected header by exactly
 * `delta` bytes, or null when no exact pad exists. The CBOR bstr header steps
 * at payload 24 and 256, so entry size 4+h+padLen has two holes: delta 29 and
 * delta 262. Callers treat null as an off-target round and grow past the hole
 * rather than failing the seal.
 */
export function padForDelta(delta: number): number | null {
  for (const h of [3, 2, 1]) {
    const padLen = delta - 4 - h; // 4 = cborText('pad')
    const ok = h === 3 ? padLen >= 256 : h === 2 ? padLen >= 24 && padLen < 256 : padLen >= 0 && padLen < 24;
    if (ok) return padLen;
  }
  return null; // delta 29 and 262 are unrepresentable; delta < 6 needs no pad decision here
}

/**
 * COSE unprotected-header entry for the PQ dual signature:
 * { alg: 'ML-DSA-65', fp: hex fingerprint, sig: 3309 bytes }, over the same
 * Sig_structure as the ES256 signature. The public key lives in the signed
 * record payload (telemetry.pqKey), not here, so stripping this is detectable.
 */
export interface PqCoseEntry {
  alg: string;
  fp: string;
  sig: Uint8Array;
}

function unprotectedHeader(timestampTokens: Uint8Array[], padLen: number, pq?: PqCoseEntry | null): Uint8Array {
  const entries: Uint8Array[] = [];
  // V2 sigTst2 (CTT model): each token countersigns the COSE
  // Countersign_structure over the signature, as c2pa-rs emits and validates.
  if (timestampTokens.length > 0) entries.push(concatBytes(cborText('sigTst2'), tstContainer(timestampTokens)));
  if (pq) entries.push(concatBytes(cborText('verifyPq'), encode({ alg: pq.alg, fp: pq.fp, sig: pq.sig })));
  if (padLen > 0) entries.push(concatBytes(cborText('pad'), bstr(new Uint8Array(padLen))));
  if (entries.length === 0) return new Uint8Array([0xa0]);
  return concatBytes(new Uint8Array([0xa0 | entries.length]), ...entries);
}

/** On-device transcript, embedded as the com.verify.transcript JSON assertion. */
export interface TranscriptAssertion {
  text: string;
  segments: { start: number; duration: number; text: string }[];
  /** Which engine produced the transcript. */
  engine: 'apple-speech-ondevice';
}

export type DigestSigner = (digest: Uint8Array) => Promise<Uint8Array>; // returns DER signature

/** Protected header {1: -7 (ES256), 33: x5chain} — chain[0] is the signing (leaf) cert. */
function protectedHeader(certChain: Uint8Array[]): Uint8Array {
  return concatBytes(
    new Uint8Array([0xa2, 0x01, 0x26, 0x18, 0x21, 0x80 | certChain.length]),
    ...certChain.map(bstr)
  );
}

function sigStructure(protectedBstr: Uint8Array, claimBytes: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([0x84, 0x6a]), asciiToBytes('Signature1'), protectedBstr, new Uint8Array([0x40]), bstr(claimBytes));
}

function assembleCose(protectedBstr: Uint8Array, rawSignature: Uint8Array, timestampTokens: Uint8Array[], padLen: number, pq?: PqCoseEntry | null): Uint8Array {
  return concatBytes(
    new Uint8Array([0xd2, 0x84]),
    protectedBstr,
    unprotectedHeader(timestampTokens, padLen, pq),
    new Uint8Array([0xf6]),
    bstr(rawSignature)
  );
}

/**
 * The message a sigTst2 (CTT) timestamp countersigns, per c2pa-rs
 * (sigtst.rs::cose_countersign_data): the RFC 9052 Countersign_structure
 *
 *   [ "CounterSignature", body_protected, external_aad, payload ]
 *
 * where body_protected is the COSE protected header, external_aad is empty,
 * and payload is the CBOR bstr of the raw signature.
 */
export function timestampMessageForSignature(protectedBstr: Uint8Array, rawSignature: Uint8Array): Uint8Array {
  return concatBytes(
    new Uint8Array([0x84]), cborText('CounterSignature'),
    protectedBstr, new Uint8Array([0x40]),
    bstr(bstr(rawSignature))
  );
}

/**
 * The message a V1 sigTst timestamp countersigns, per c2pa-rs
 * (sigtst.rs::validate_cose_tst_info — TimeStampStorage::V1_sigTst): the
 * RFC 9052 Sig_structure with context "CounterSignature" whose payload is
 * the claim bytes (what the COSE_Sign1 itself signed), not the signature.
 * Matches every sigTst-carrying file in the c2pa test corpus.
 */
export function timestampMessageForClaim(protectedBstr: Uint8Array, claimBytes: Uint8Array): Uint8Array {
  return concatBytes(
    new Uint8Array([0x84]), cborText('CounterSignature'),
    protectedBstr, new Uint8Array([0x40]),
    bstr(claimBytes)
  );
}

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

export interface C2paManifestParams {
  appName: string;          // claim_generator, e.g. "ExhibitA/0.2.0 (com.verify.camera)"
  mime: string;             // dc:format
  title: string;            // dc:title
  instanceId: string;       // "xmp:iid:<hex>"
  telemetry: Record<string, unknown>; // embedded as com.verify.telemetry
  /** Signs a 32-byte digest with the device key (DER in, any backend). */
  signDigest: DigestSigner;
  /**
   * Post-quantum dual signature: when present, the COSE
   * unprotected header carries a `verifyPq` entry — an ML-DSA-65 signature
   * over the exact same Sig_structure the ES256 signature signs. The unprotected
   * header is strippable; the strip is DETECTABLE because the PQ public key is
   * committed inside the signed record payload (telemetry.pqKey), which cannot
   * be removed without breaking the classical signature. Software key — hedges
   * future P-256 cryptanalysis only (src/lib/pq.ts).
   */
  pq?: { publicKey: Uint8Array; fingerprint: string; sign: (message: Uint8Array) => Uint8Array } | null;
  /**
   * Signs sha256(payload) — digest AND signature produced in
   * one hop. When the signer is the Secure Enclave this is a single native
   * call (payload never hashed in JS), narrowing the runtime-instrumentation
   * hook surface. When present it takes precedence over signDigest for the
   * claim signature. The payload is the COSE Sig_structure.
   */
  signPayload?: (payload: Uint8Array) => Promise<Uint8Array>;
  /** x5chain for the COSE protected header — [leaf] self-signed, or [leaf, org CA] with an org credential. */
  certChain: Uint8Array[];
  /** SHA-256 of the clean media file (without any provenance segments). */
  cleanFileSha256: Uint8Array;
  /** Optional RFC 3161 fetcher: given the message (CBOR bstr of the signature), returns a TimeStampToken. */
  /** Returns every witness token obtained (empty array when offline). */
  fetchTimestamp?: (message: Uint8Array) => Promise<Uint8Array[]>;
  /**
 * Sizing-only probe token lengths. Token sizes are TSA-fixed, so
   * the layout probe uses the last observed length per TSA instead of a
   * throwaway network fetch, which would cost a full TSA round per seal.
   * When absent, the probe falls back to fetchTimestamp (lab seam).
   */
  probeTokenSizes?: () => number[];
  /** Optional App Attest binding assertion (JSON: Apple attestation object + challenge + bound signing-key fingerprint) — embedded as com.verify.app-attest. */
  appAttest?: Uint8Array | null;
  /** Optional on-device transcript (audio) — embedded as com.verify.transcript. */
  transcript?: TranscriptAssertion | null;
  /**
   * Sanitized camera EXIF (src/lib/exif.ts — allowlisted, GPS-free) —
   * embedded as com.verify.exif, signed as camera-reported metadata.
   */
  exif?: Record<string, number | string> | null;
  /**
   * Org identity assertion — emitted ONLY when an org
   * credential is active (x5chain length > 1). Modeled on the CAWG identity
   * assertion data model (a named actor countersigning the claim) but
   * vendor-labeled `com.verify.identity` until C2PA conformance testing:
   * we do not claim `cawg.identity` conformance without it. The
   * binding is mechanical — the org credential's key signed this claim and
   * the same x5chain rides the COSE protected header — so it proves WHICH
   * org credential produced the file, never that its contents are true.
   */
  identity?: { org: string; role: string } | null;
  /**
   * Additional project-specific JSON assertions, embedded
   * as proper JUMBF assertion boxes (`c2pa.assertion`-style labels
   * `com.verify.*`) inside the standard assertion store, hashed into the
   * claim via the same assertionHashes path as every other box. Used for
   * com.verify.streamedChunks / contextTree / poseTrace / captureIntegrity.
   * JSON content boxes per C2PA custom-assertion rules. Labels must start
   * with 'com.verify.' and must not collide with the built-in boxes.
   */
  customAssertions?: { label: string; data: unknown }[] | null;
  // ---- 0.16.0 data contract (C2–C5): standard assertions, each emitted
  // only when its param is supplied; the caller omits (and logs) any
  // assertion it cannot build honestly — never a capture/seal failure.
  /**
   * C5: claim thumbnail — a small JPEG (≤512px) of the asset, embedded as
   * c2pa.thumbnail.claim.jpeg (JUMBF jpeg content box, like c2pa-rs).
   */
  thumbnailJpeg?: Uint8Array | null;
  /**
   * C5: asset types for c2pa.asset-type.v2 (SDK 2.3 enum label — the v2
   * JSON-array shape: [{type, version?}]). e.g. ['image'], ['video'], ['audio'].
   */
  assetTypes?: string[] | null;
  /**
   * C5: emit c2pa.training-mining with every standard entry
   * (c2pa.ai_training / c2pa.ai_generative_training / c2pa.data_mining /
   * c2pa.ai_inference) set to the spec's `notAllowed` — declared as the app
   * developer's stance on the captures IT seals, per the locked label
   * decision (c2pa.training-mining, not cawg.training-mining: the vendored
   * enum lacks the latter and our verifier must read back what we emit).
   */
  trainingMiningDenied?: boolean;
  /**
   * C3: the capture-time pHash (16 hex chars, src/lib/phash.ts), embedded
   * as c2pa.soft-binding (CBOR) under SOFT_BINDING_ALG_PHASH — durability
   * against sidecar loss. Rendered downstream as recovery metadata, never
   * as a rung.
   */
  phashHex?: string | null;
  /**
   * C4: when true AND p.exif is present, the standard-supported fields are
   * ALSO emitted as c2pa.metadata (JSON-LD, exif/tiff/exifEX namespaces) —
   * signer-attributed metadata, while com.verify.exif keeps the full
   * sanitized set. "Present in the file" vs "asserted by the signer".
   */
  emitC2paMetadata?: boolean;
  /**
   * C2 conformance: emit c2pa.actions.v2 declaring c2pa.created with
   * digitalSourceType digitalCapture (C2PA 2.1+ requires created/opened;
   * downstream tools check digitalSourceType first). `when` is the capture
   * time (ISO), optional.
   */
  createdDeclaration?: { when?: string | null } | null;
  /**
   * D1 commit half: the capture-side depth artifact as a spec-conformant
   * GDepth depthmap (C2PA 2.2 §18.21, schema mirrors
   * developers.google.com/depthmap-metadata/reference). Optically captured
   * (stereo) — the spec forbids ML-inferred single-image depth here.
   * `near`/`far` are REQUIRED by the CDDL: they are properties of the map
   * encoding only the capture side can know, so a caller without them
   * passes no depthmap at all (absent, never fabricated).
   */
  depthmap?: {
    /** The depth image bytes (GDepth:Data, base64'd into the CBOR). */
    data: Uint8Array;
    mime: 'image/jpeg' | 'image/png';
    /** 'disparity' maps to RangeInverse, 'depth' to RangeLinear (attest side). */
    format: 'RangeInverse' | 'RangeLinear';
    near: number;
    far: number;
    units?: 'm' | 'mm' | null;
    measureType?: 'OpticalAxis' | 'OpticRay' | null;
    confidence?: { data: Uint8Array; mime: string } | null;
    manufacturer?: string | null;
    model?: string | null;
    software?: string | null;
    /** COLOR image dimensions (not the map's) — clients check the map against them. */
    imageWidth?: number | null;
    imageHeight?: number | null;
  } | null;
  /**
   * D1 commit half: the exhibit as a first-class multi-part C2PA object —
 * c2pa.hash.collection.data over the artifact set the exhibit
   * comprises (photo clean bytes + depth map). Set membership itself is
 * sealed: per-entry sha256 over ALL bytes of each member.
   * `uri` is the member's name in the set ('photo.jpg', 'depth.png' …) —
   * no '.'/'..' components (§15.12.5 invalidURI); entries violating that
   * are dropped, and an empty set means no assertion at all.
   */
  collectionAssets?: { uri: string; bytes: Uint8Array; dcFormat?: string | null }[] | null;
  /**
   * The secondary (wide) viewpoint as a componentOf ingredient.
   * `thumbnailJpeg` is the embedded 512px lead; `fullResSha256` commits the
   * measurement-grade bytes that stay in the vault — the claim seals BOTH,
   * so the vault copy and the in-file lead cannot silently diverge. Absent
   * when the session captured no secondary frame (absent, never fabricated).
   */
  secondaryView?: {
    thumbnailJpeg: Uint8Array;
    /** Hex sha256 of the FULL-RES secondary JPEG bytes. */
    fullResSha256: string;
    width?: number | null;
    height?: number | null;
  } | null;
  /**
   * 0.18.5 post-field (video): the periodic synchronized-pair UW stills
   * dumped during recording, each as its own componentOf ingredient — a
   * reviewer weighing a video sees the second camera's frames AT moments
   * across the take, not a hash root alone. The embedded `thumbnailJpeg`
   * IS the vaulted pair JPEG (≤640×480, capture-side byte cap) — lead and
   * measurement coincide, and `fullResSha256` commits the same bytes.
   * Labels stay unique within
   * the claim: the first still reuses the singular ingredient/thumbnail
   * labels when secondaryView is absent (video has none), later stills
   * carry a `.{pairIndex}` suffix. Captured by the capture-side cadence
   * claim (context.stereo-video-*); absent when no pairs were recorded.
   */
  videoStills?: {
    thumbnailJpeg: Uint8Array;
    /** Hex sha256 of the vaulted pair-frame JPEG bytes this leads to. */
    fullResSha256: string;
    /** The capture-side pair sequence number (labels + title). */
    pairIndex: number;
    /** Primary-frame host-clock anchor, seconds (null when unrecorded). */
    hostSeconds: number | null;
  }[] | null;
}

/** §15.12.5: a collection URI must not contain '.' or '..' path components. */
function isValidCollectionUri(uri: string): boolean {
  return uri.length > 0 && !uri.split('/').some((c) => c === '.' || c === '..');
}

// ---------------------------------------------------------------------------
// C4: sanitized EXIF (com.verify.exif keys, src/lib/exif.ts) → standard
// XMP/JSON-LD fields for c2pa.metadata. The mapping is CLOSED, like the
// sanitizer's allowlist: anything unmapped stays only in com.verify.exif.
// ---------------------------------------------------------------------------
const EXIF_TO_METADATA: Record<string, string> = {
  Make: 'tiff:Make',
  Model: 'tiff:Model',
  LensMake: 'exifEX:LensMake',
  LensModel: 'exifEX:LensModel',
  LensSpecification: 'exifEX:LensSpecification',
  ISO: 'exif:ISOSpeedRatings',
  ISOSpeedRatings: 'exif:ISOSpeedRatings',
  ExposureTime: 'exif:ExposureTime',
  ShutterSpeedValue: 'exif:ShutterSpeedValue',
  FNumber: 'exif:FNumber',
  ApertureValue: 'exif:ApertureValue',
  ExposureBiasValue: 'exif:ExposureBiasValue',
  BrightnessValue: 'exif:BrightnessValue',
  FocalLength: 'exif:FocalLength',
  FocalLengthIn35mmFilm: 'exif:FocalLengthIn35mmFilm',
  DigitalZoomRatio: 'exif:DigitalZoomRatio',
  ExposureMode: 'exif:ExposureMode',
  MeteringMode: 'exif:MeteringMode',
  WhiteBalance: 'exif:WhiteBalance',
  Flash: 'exif:Flash',
  SensingMethod: 'exif:SensingMethod',
  SceneCaptureType: 'exif:SceneCaptureType',
  ColorSpace: 'exif:ColorSpace',
  Orientation: 'tiff:Orientation',
  PixelXDimension: 'exif:PixelXDimension',
  PixelYDimension: 'exif:PixelYDimension',
  DateTimeOriginal: 'exif:DateTimeOriginal',
  DateTimeDigitized: 'exif:DateTimeDigitized',
};

/** The JSON-LD context the mapped namespaces resolve against. */
const C2PA_METADATA_CONTEXT = {
  exif: 'http://ns.adobe.com/exif/1.0/',
  exifEX: 'http://cipa.jp/exif/1.0/',
  tiff: 'http://ns.adobe.com/tiff/1.0/',
};

/**
 * Builds the c2pa.metadata JSON-LD body from the sanitized EXIF set, or
 * null when nothing maps (assertion omitted — never an empty shell).
 * Later keys do not overwrite an already-mapped field (ISO before
 * ISOSpeedRatings, PixelXDimension before its ExifImageWidth aliases — the
 * sanitizer's own aliases are excluded from the map for that reason).
 */
function buildC2paMetadataJson(exif: Record<string, number | string>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(exif)) {
    const field = EXIF_TO_METADATA[k];
    if (field && out[field] === undefined) out[field] = v;
  }
  if (Object.keys(out).length === 0) return null;
  return { '@context': C2PA_METADATA_CONTEXT, ...out };
}

/**
 * The box-instance id (En) of the C2PA JUMBF store — the value c2pa-rs
 * uses, so third-party readers group our packets with theirs.
 */
const C2PA_APP11_EN = 0x0211;
const APP11_ENVELOPE_BYTES = 8; // "JP"(2) + En(2) + Z(4)
const MAX_APP11_PAYLOAD = 65533; // 2-byte length includes itself

/**
 * Builds the APP11 segment chain for a JUMBF store: a single segment when
 * it fits, otherwise an ordered ISO 19566-5 packet chain (same En,
 * consecutive 1-based Z) — how C2PA manifests >64KB ride JPEG. Returns the
 * concatenated segments; the caller inserts them as one contiguous run, so
 * the c2pa.hash.data exclusion range covers the whole chain.
 */
function app11Segments(jumbfStore: Uint8Array): Uint8Array {
  const chunkMax = MAX_APP11_PAYLOAD - APP11_ENVELOPE_BYTES;
  const out: Uint8Array[] = [];
  for (let z = 0, off = 0; ; z++) {
    const chunk = jumbfStore.subarray(off, Math.min(off + chunkMax, jumbfStore.length));
    off += chunk.length;
    const seq = z + 1;
    const header = new Uint8Array([
      0x4a, 0x50,
      (C2PA_APP11_EN >> 8) & 0xff, C2PA_APP11_EN & 0xff,
      (seq >>> 24) & 0xff, (seq >>> 16) & 0xff, (seq >>> 8) & 0xff, seq & 0xff,
    ]);
    const payload = concatBytes(header, chunk);
    const length = payload.length + 2;
    out.push(concatBytes(new Uint8Array([0xff, 0xeb, (length >> 8) & 0xff, length & 0xff]), payload));
    if (off >= jumbfStore.length) break;
  }
  return concatBytes(...out);
}

/** Claim CBOR referencing assertion boxes by label, in box order. */
function buildClaimBytes(p: C2paManifestParams, uuid: string, assertionBoxes: Uint8Array[], labels: string[]): Uint8Array {
  return encode({
    claim_generator: p.appName,
    'dc:format': p.mime,
    'dc:title': p.title,
    instanceID: uuid,
    assertions: assertionBoxes.map((b, i) => ({
      url: 'self#jumbf=c2pa.assertions/' + labels[i],
      alg: 'sha256',
      hash: hashJumbContent(b),
    })),
    signature: 'self#jumbf=c2pa.signature',
    alg: 'sha256',
  });
}

/** store = c2pa jumbf superbox wrapping one manifest (claim + assertions + COSE signature). */
function assembleStore(
  manifestLabel: string,
  claimBytes: Uint8Array,
  assertionBoxes: Uint8Array[],
  signed: { protectedBstr: Uint8Array; rawSignature: Uint8Array; pq?: PqCoseEntry | null },
  timestampTokens: Uint8Array[],
  padLen: number
): Uint8Array {
  const coseBytes = assembleCose(signed.protectedBstr, signed.rawSignature, timestampTokens, padLen, signed.pq ?? null);
  const claimBox = jumbBox(UUID_C2CL, 'c2pa.claim', box('cbor', claimBytes));
  const assertionsBox = jumbBox(UUID_C2AS, 'c2pa.assertions', ...assertionBoxes);
  const signatureBox = jumbBox(UUID_C2CS, 'c2pa.signature', box('cbor', coseBytes));
  const manifest = jumbBox(UUID_C2MA, manifestLabel, claimBox, assertionsBox, signatureBox);
  return jumbBox(UUID_C2PA, 'c2pa', manifest);
}

// ---------------------------------------------------------------------------
// Two-phase claim signing
//
// The builders below converge segment sizes with a DUMMY signature — the COSE
// slot holds a fixed-width P1363 signature (64 bytes), so a placeholder has
// exactly the real size — and sign the FINAL claim exactly once. Signing on
// every fixpoint iteration would burn a real signature per round; with a
// biometric-bound key each round would prompt Face ID again. One signature
// per claim, period — which makes per-use biometric evaluation affordable.
// ---------------------------------------------------------------------------

/** Fixed 64-byte P1363 placeholder — the exact size of the real signature. */
const DUMMY_RAW_SIG = new Uint8Array(64);
/** Fixed 3309-byte ML-DSA-65 placeholder — probe assemblies size the PQ entry exactly without signing. */
const DUMMY_PQ_SIG = new Uint8Array(PQ_SIZES.signature);

interface ClaimPlan {
  claimBytes: Uint8Array;
  protectedBstr: Uint8Array;
  /** The COSE Sig_structure; the key signs sha256 of exactly this. */
  sigPayload: Uint8Array;
  /**
   * Tokens fetched over the DUMMY signature. Sizes are TSA-fixed (the imprint
   * is always 32 bytes), so these size the convergence exactly — but they bind
   * the dummy signature, so they are NEVER embedded; finalize re-fetches over
   * the real one.
   */
  probeTokens: Uint8Array[];
}

async function planClaim(claimBytes: Uint8Array, p: C2paManifestParams): Promise<ClaimPlan> {
  const protectedBstr = bstr(protectedHeader(p.certChain));
  const sigPayload = sigStructure(protectedBstr, claimBytes);
  let probeTokens: Uint8Array[] = [];
  if (p.probeTokenSizes) {
    // Sizing dummies — content is irrelevant (never embedded; the finalize
    // step re-fetches real tokens over the real signature), length is all
    // the fixpoint converges on. No network round here.
    probeTokens = p.probeTokenSizes().map((n) => new Uint8Array(Math.max(0, Math.floor(n))));
  } else if (p.fetchTimestamp) {
    probeTokens = (await p.fetchTimestamp(timestampMessageForSignature(protectedBstr, DUMMY_RAW_SIG))) ?? [];
  }
  return { claimBytes, protectedBstr, sigPayload, probeTokens };
}

/** Signs the planned claim ONCE and fetches the witness tokens that bind it. */
async function signPlannedClaim(
  plan: ClaimPlan,
  p: C2paManifestParams
): Promise<{ signed: { protectedBstr: Uint8Array; rawSignature: Uint8Array; pq?: PqCoseEntry | null }; timestampTokens: Uint8Array[] }> {
  const der = p.signPayload ? await p.signPayload(plan.sigPayload) : await p.signDigest(sha256(plan.sigPayload));
  // One commitment, two signatures: the PQ layer signs the exact same
  // Sig_structure. Software signing — no prompt, no extra hop, exactly once.
  const pq = p.pq ? { alg: PQ_ALG, fp: p.pq.fingerprint, sig: p.pq.sign(plan.sigPayload) } : null;
  const signed = { protectedBstr: plan.protectedBstr, rawSignature: derToP1363LowS(der), pq };
  let timestampTokens: Uint8Array[] = [];
  if (p.fetchTimestamp) {
    timestampTokens = (await p.fetchTimestamp(timestampMessageForSignature(signed.protectedBstr, signed.rawSignature))) ?? [];
  }
  return { signed, timestampTokens };
}

/** The telemetry + optional App Attest / transcript boxes every Source Kit manifest carries. */
function verifyAssertionBoxes(p: C2paManifestParams, telemetryJson: Uint8Array): { boxes: Uint8Array[]; labels: string[] } {
  const telemetryBox = jumbBox(UUID_JSON, 'com.verify.telemetry', box('json', telemetryJson));
  const attestBox = p.appAttest ? jumbBox(UUID_JSON, 'com.verify.app-attest', box('json', p.appAttest)) : null;
  const transcriptBox = p.transcript
    ? jumbBox(UUID_JSON, 'com.verify.transcript', box('json', utf8ToBytes(JSON.stringify(p.transcript))))
    : null;
  const exifBox = p.exif && Object.keys(p.exif).length > 0
    ? jumbBox(UUID_JSON, 'com.verify.exif', box('json', utf8ToBytes(JSON.stringify({
        note: 'camera-pipeline-reported, signed as self-reported metadata',
        ...p.exif,
      }))))
    : null;
  // The org identity assertion references the telemetry box by the
  // SAME hash basis the claim uses (hashJumbContent), so a verifier can
  // cross-check the reference against the claim's own assertion list.
  const identityBox = p.identity
    ? jumbBox(UUID_JSON, 'com.verify.identity', box('json', utf8ToBytes(JSON.stringify({
        format: 'com.verify.identity/1',
        cawgAlignment:
          'Modeled on the CAWG identity assertion data model (named-actor countersignature of the claim); ' +
          'vendor-labeled until C2PA conformance testing — no cawg.identity conformance is claimed.',
        namedActor: { org: p.identity.org, role: p.identity.role },
        referenced_assertions: [{
          url: 'self#jumbf=c2pa.assertions/com.verify.telemetry',
          alg: 'sha256',
          hash: bytesToHex(hashJumbContent(telemetryBox)),
        }],
        note:
          'Mechanical binding: the org credential in this claim\'s x5chain signed it. ' +
          'Proves WHICH org credential produced this file — never that its contents are true.',
      }))))
    : null;
  // ---- 0.16.0 standard assertions (C2–C5), first-class allowlist ----
  // Order is fixed so the claim's assertion list is deterministic.
  const standardBoxes: Uint8Array[] = [];
  const standardLabels: string[] = [];
  // C5: claim thumbnail (jpeg content box, like c2pa-rs thumbnails).
  if (p.thumbnailJpeg && p.thumbnailJpeg.length > 0) {
    standardBoxes.push(jumbBox(UUID_JPEG, LABEL_THUMBNAIL_CLAIM_JPEG, box('jpeg', p.thumbnailJpeg)));
    standardLabels.push(LABEL_THUMBNAIL_CLAIM_JPEG);
  }
  // The secondary viewpoint as a componentOf ingredient — its own
  // embedded thumbnail (a lead, self-evidently not the measurement pixels)
  // plus a data hash of the full-res bytes in the vault (the measurement).
  // Both boxes enter the claim's assertion list, so the signature covers the
  // thumbnail bytes AND the full-res commitment: the two cannot silently
  // diverge. Dimensions stay in the context claims — ingredient.v3 has no
  // width/height fields and a standard assertion carries no non-standard keys.
  if (p.secondaryView && p.secondaryView.thumbnailJpeg.length > 0 && /^[0-9a-f]{64}$/i.test(p.secondaryView.fullResSha256)) {
    const secondary = p.secondaryView;
    const thumbnailBox = jumbBox(UUID_JPEG, LABEL_THUMBNAIL_INGREDIENT_JPEG, box('jpeg', secondary.thumbnailJpeg));
    standardBoxes.push(thumbnailBox);
    standardLabels.push(LABEL_THUMBNAIL_INGREDIENT_JPEG);
    standardBoxes.push(jumbBox(UUID_CBOR, LABEL_INGREDIENT_V3, box('cbor', encode({
      title: 'Secondary viewpoint (ultra-wide, simultaneous)',
      format: 'image/jpeg',
      relationship: 'componentOf',
      instanceId: 'xmp:iid:verify-secondary-view',
      thumbnail: {
        identifier: LABEL_THUMBNAIL_INGREDIENT_JPEG,
        alg: 'sha256',
        hash: bytesToHex(hashJumbContent(thumbnailBox)),
      },
      data: {
        alg: 'sha256',
        hash: hexToBytes(secondary.fullResSha256),
        name: 'photo-secondary.jpg',
      },
      description:
        'Simultaneous ultra-wide frame from the same shutter press. The embedded ' +
        'thumbnail is a lead, not the measurement pixels; the data hash commits ' +
        'the full-res bytes held by the capture vault.',
    }))));
    standardLabels.push(LABEL_INGREDIENT_V3);
  }
  // 0.18.5 post-field (video): one componentOf ingredient per periodic
  // pair still — the same lead+measurement discipline as secondaryView,
  // repeated across the take. The first still reuses the singular labels
  // when no secondaryView preceded it (video never carries one); later
  // stills suffix with the pair index so every claim label stays unique.
  if (p.videoStills && p.videoStills.length > 0) {
    const singularFree = !p.secondaryView;
    p.videoStills.forEach((still, position) => {
      if (still.thumbnailJpeg.length === 0 || !/^[0-9a-f]{64}$/i.test(still.fullResSha256)) return;
      const suffix = singularFree && position === 0 ? '' : `.${still.pairIndex}`;
      const thumbLabel = `${LABEL_THUMBNAIL_INGREDIENT_JPEG}${suffix}`;
      const ingredientLabel = `${LABEL_INGREDIENT_V3}${suffix}`;
      const thumbnailBox = jumbBox(UUID_JPEG, thumbLabel, box('jpeg', still.thumbnailJpeg));
      standardBoxes.push(thumbnailBox);
      standardLabels.push(thumbLabel);
      standardBoxes.push(jumbBox(UUID_CBOR, ingredientLabel, box('cbor', encode({
        title: `Secondary viewpoint during video (ultra-wide, pair #${still.pairIndex})`,
        format: 'image/jpeg',
        relationship: 'componentOf',
        instanceId: `xmp:iid:verify-video-secondary-${still.pairIndex}`,
        thumbnail: {
          identifier: thumbLabel,
          alg: 'sha256',
          hash: bytesToHex(hashJumbContent(thumbnailBox)),
        },
        data: {
          alg: 'sha256',
          hash: hexToBytes(still.fullResSha256),
          name: `video-secondary-pair-${still.pairIndex}.jpg`,
        },
        description:
          'Ultra-wide frame from a synchronized stereo pair dumped periodically ' +
          'during this recording (capture-side cadence stated in the signed ' +
          'context claims). The embedded frame IS the vaulted pair JPEG — the ' +
          'data hash commits the same bytes the capture vault holds.',
      }))));
      standardLabels.push(ingredientLabel);
    });
  }
  // C5: asset type(s), v2 JSON-array shape per the SDK 2.3 enum label.
  if (p.assetTypes && p.assetTypes.length > 0) {
    standardBoxes.push(jumbBox(UUID_JSON, LABEL_ASSET_TYPE_V2, box('json', utf8ToBytes(JSON.stringify(p.assetTypes.map((type) => ({ type })))))));
    standardLabels.push(LABEL_ASSET_TYPE_V2);
  }
  // C5: training/data-mining permissions — every standard entry
  // notAllowed, the app developer's stance on its own captures (CBOR map
  // per the spec; the vendored enum reads this label back).
  if (p.trainingMiningDenied) {
    standardBoxes.push(jumbBox(UUID_CBOR, LABEL_TRAINING_MINING, box('cbor', encode({
      entries: {
        'c2pa.ai_training': { use: 'notAllowed' },
        'c2pa.ai_generative_training': { use: 'notAllowed' },
        'c2pa.data_mining': { use: 'notAllowed' },
        'c2pa.ai_inference': { use: 'notAllowed' },
      },
    }))));
    standardLabels.push(LABEL_TRAINING_MINING);
  }
  // C3: soft binding from the capture-time pHash — recovery metadata, NOT
  // a hard binding (the hash.data/bmff assertions remain the only ones).
  if (p.phashHex && /^[0-9a-f]{16}$/i.test(p.phashHex)) {
    standardBoxes.push(jumbBox(UUID_CBOR, LABEL_SOFT_BINDING, box('cbor', encode({
      alg: SOFT_BINDING_ALG_PHASH,
      blocks: [{ scope: {}, value: hexToBytes(p.phashHex) }],
      pad: new Uint8Array(8),
    }))));
    standardLabels.push(LABEL_SOFT_BINDING);
  }
  // C4: standard-supported EXIF fields as signer-attributed c2pa.metadata
  // (JSON-LD); the full sanitized set stays in com.verify.exif.
  if (p.emitC2paMetadata && p.exif) {
    const metadataJson = buildC2paMetadataJson(p.exif);
    if (metadataJson) {
      standardBoxes.push(jumbBox(UUID_JSON, LABEL_METADATA, box('json', utf8ToBytes(JSON.stringify(metadataJson)))));
      standardLabels.push(LABEL_METADATA);
    }
  }
  // D1: GDepth depthmap (CBOR per §18.21 depthmap-gdepth-map). Field names
  // are the GDepth schema's own ('GDepth:*') — spec-mandated, not style.
  if (p.depthmap && p.depthmap.data.length > 0) {
    const d = p.depthmap;
    const gdepth: Record<string, unknown> = {
      'GDepth:Format': d.format,
      'GDepth:Near': d.near,
      'GDepth:Far': d.far,
      'GDepth:Mime': d.mime,
      'GDepth:Data': bytesToBase64(d.data),
    };
    if (d.units) gdepth['GDepth:Units'] = d.units;
    if (d.measureType) gdepth['GDepth:MeasureType'] = d.measureType;
    if (d.confidence && d.confidence.data.length > 0) {
      gdepth['GDepth:ConfidenceMime'] = d.confidence.mime;
      gdepth['GDepth:Confidence'] = bytesToBase64(d.confidence.data);
    }
    if (d.manufacturer) gdepth['GDepth:Manufacturer'] = d.manufacturer;
    if (d.model) gdepth['GDepth:Model'] = d.model;
    if (d.software) gdepth['GDepth:Software'] = d.software;
    if (typeof d.imageWidth === 'number') gdepth['GDepth:ImageWidth'] = d.imageWidth;
    if (typeof d.imageHeight === 'number') gdepth['GDepth:ImageHeight'] = d.imageHeight;
    standardBoxes.push(jumbBox(UUID_CBOR, LABEL_DEPTHMAP_GDEPTH, box('cbor', encode(gdepth))));
    standardLabels.push(LABEL_DEPTHMAP_GDEPTH);
  }
  // D1: collection data hash (CBOR per §18.8 collection-data-hash-map) —
  // the photo + depth map as one sealed set. sha256 over ALL bytes of each
  // member; the photo member hashes the CLEAN bytes (the signed file
  // contains this very manifest — hashing it would be circular; verifiers
  // reconstruct clean bytes via the hash.data exclusion before matching).
  if (p.collectionAssets && p.collectionAssets.length > 0) {
    const uris = p.collectionAssets
      .filter((a) => a.bytes.length > 0 && isValidCollectionUri(a.uri))
      .map((a) => {
        const entry: Record<string, unknown> = { uri: a.uri, hash: sha256(a.bytes), size: a.bytes.length };
        if (a.dcFormat) entry['dc:format'] = a.dcFormat;
        return entry;
      });
    if (uris.length > 0) {
      standardBoxes.push(jumbBox(UUID_CBOR, LABEL_COLLECTION_HASH, box('cbor', encode({ uris, alg: 'sha256' }))));
      standardLabels.push(LABEL_COLLECTION_HASH);
    }
  }
  // C2: actions.v2 declaring c2pa.created + digitalSourceType digitalCapture.
  if (p.createdDeclaration) {
    const action: Record<string, unknown> = {
      action: 'c2pa.created',
      digitalSourceType: DIGITAL_SOURCE_TYPE_DIGITAL_CAPTURE,
    };
    if (p.createdDeclaration.when) action.when = p.createdDeclaration.when;
    standardBoxes.push(jumbBox(UUID_CBOR, LABEL_ACTIONS_V2, box('cbor', encode({ actions: [action] }))));
    standardLabels.push(LABEL_ACTIONS_V2);
  }

  // Project-specific assertions as first-class JUMBF boxes
  // (media parity — the caller emits the same set for photo, video, audio).
  const customBoxes: Uint8Array[] = [];
  const customLabels: string[] = [];
  const taken = new Set(['com.verify.telemetry', 'com.verify.app-attest', 'com.verify.identity', 'com.verify.transcript', 'com.verify.exif', ...standardLabels]);
  for (const ca of p.customAssertions ?? []) {
    if (typeof ca?.label !== 'string' || !ca.label.startsWith('com.verify.')) {
      throw new Error(`custom assertion label '${String(ca?.label)}' must be a com.verify.* label`);
    }
    if (taken.has(ca.label)) throw new Error(`custom assertion label '${ca.label}' collides with a built-in box`);
    if (customLabels.includes(ca.label)) throw new Error(`custom assertion label '${ca.label}' given twice`);
    customBoxes.push(jumbBox(UUID_JSON, ca.label, box('json', utf8ToBytes(JSON.stringify(ca.data)))));
    customLabels.push(ca.label);
  }
  return {
    boxes: [telemetryBox, ...(attestBox ? [attestBox] : []), ...(identityBox ? [identityBox] : []), ...(transcriptBox ? [transcriptBox] : []), ...(exifBox ? [exifBox] : []), ...standardBoxes, ...customBoxes],
    labels: ['com.verify.telemetry', ...(attestBox ? ['com.verify.app-attest'] : []), ...(identityBox ? ['com.verify.identity'] : []), ...(transcriptBox ? ['com.verify.transcript'] : []), ...(exifBox ? ['com.verify.exif'] : []), ...standardLabels, ...customLabels],
  };
}

/**
 * Builds the complete APP11 C2PA segment. Iterates to a size fixpoint: the
 * exclusion range covers the segment itself, so its length must stabilize —
 * and when a timestamp token is requested, its size variance is absorbed by
 * slack + an exact-length CBOR pad entry in the unprotected header.
 */
export async function buildC2paSegment(p: C2paManifestParams, insertOffset: number): Promise<Uint8Array> {
  const uuid = p.instanceId.replace(/^xmp:iid:/i, '');
  const manifestLabel = 'verify:urn:uuid:' + uuid;
  const telemetryJson = utf8ToBytes(JSON.stringify(p.telemetry));

  let exclusionLength = 0;
  // 256 bytes of slack. A TSA that alternates signing certs (or an OTS
  // calendar whose response grows between probe and real fetch) can drift a
  // token by more than 64 bytes; the slack is reserved segment size, not
  // per-capture overhead anyone sees.
  const SLACK = 256; // absorbs TSA token-size variance without a re-sign

  // Per-round sizes, carried to the final throw — an unreachable
  // fixpoint must be diagnosable from the field log alone.
  const rounds: string[] = [];

  for (let i = 0; i < 12; i++) {
    // The exclusion reconstructs the clean file, so the hash is constant —
    // but the exclusion length feeds the CBOR, which feeds the size.
    const hashDataCbor = encode({
      exclusions: [{ start: insertOffset, length: exclusionLength }],
      alg: 'sha256',
      hash: p.cleanFileSha256,
      name: 'jumbf manifest',
      pad: new Uint8Array(10), // required by the HashData schema
    });

    const hashDataBox = jumbBox(UUID_CBOR, 'c2pa.hash.data', box('cbor', hashDataCbor));
    const rest = verifyAssertionBoxes(p, telemetryJson);
    const assertionBoxes = [hashDataBox, ...rest.boxes];
    const labels = ['c2pa.hash.data', ...rest.labels];
    const claimBytes = buildClaimBytes(p, uuid, assertionBoxes, labels);

    // Converge sizes with a fixed-size dummy signature and (if a
    // TSA is configured) probe tokens — no real signature is burned.
    const plan = await planClaim(claimBytes, p);
    const probeSigned = { protectedBstr: plan.protectedBstr, rawSignature: DUMMY_RAW_SIG, pq: p.pq ? { alg: PQ_ALG, fp: p.pq.fingerprint, sig: DUMMY_PQ_SIG } : null };
    const assembleProbe = (padLen: number): Uint8Array =>
      app11Segments(assembleStore(manifestLabel, claimBytes, assertionBoxes, probeSigned, plan.probeTokens, padLen));

    // Convergence rule: exact length, or — once probe
    // tokens reserve slack — a probe PADDED to the exclusion length.
    const probeBare = assembleProbe(0);
    rounds.push(`round ${i}: target=${exclusionLength} probe=${probeBare.length}`);
    let converged = probeBare.length === exclusionLength;
    if (!converged && plan.probeTokens.length > 0 && probeBare.length < exclusionLength) {
      const delta = exclusionLength - probeBare.length;
      // padForDelta null = an unrepresentable delta (29/262) — this round
      // stays unconverged and the target grows past the hole below.
      const pad = delta >= 6 ? padForDelta(delta) : null;
      if (pad !== null && assembleProbe(pad).length === exclusionLength) converged = true;
    }
    if (converged) {
      // Sizes are final — sign the claim exactly once, fetch the
      // real witness tokens, and re-pad from scratch (real tokens can drift
      // a few bytes from the probes; the slack absorbs it).
      const { signed, timestampTokens } = await signPlannedClaim(plan, p);
      const assembleReal = (padLen: number): Uint8Array =>
        app11Segments(assembleStore(manifestLabel, claimBytes, assertionBoxes, signed, timestampTokens, padLen));
      const bare = assembleReal(0);
      rounds[i] += ` signed=${bare.length}`;
      if (bare.length === exclusionLength) return bare;
      const delta = exclusionLength - bare.length;
      const pad = delta >= 6 ? padForDelta(delta) : null;
      if (pad !== null) {
        const segment = assembleReal(pad);
        if (segment.length === exclusionLength) return segment;
      }
      // Token drift beyond the slack is no longer FATAL. The real
      // witness tokens occasionally exceed their probes (TSA cert-chain or
      // calendar-response variance between two fetches seconds apart) —
      // the 2026-08-17 field logs showed this throw on the first pass of
      // nearly every seal, with the queue's blind retry then succeeding.
      // Re-converge instead: grow the target past the signed assembly and
      // iterate — the next pass re-signs with the larger exclusion sealed
      // inside the claim. Bounded by the 12-iteration loop; an unreached
      // fixpoint still throws below.
      exclusionLength = Math.max(bare.length, exclusionLength) + SLACK;
      continue;
    }

    // Grow the target (with slack once a token exists) and iterate.
    exclusionLength = probeBare.length + (plan.probeTokens.length > 0 ? SLACK : 0);
  }
  throw new Error(`C2PA segment did not converge — ${rounds.join(' | ')}`);
}

/**
 * Builds the raw JUMBF store for PNG embedding (inside a caBX chunk), with the
 * asset bound by a c2pa.hash.data byte-exclusion spanning the WHOLE caBX chunk.
 * Identical fixpoint to the JPEG path, but the inserted unit is the caBX chunk
 * (store + 12 bytes of PNG framing: length/type/CRC32), so the exclusion length
 * is store.length + 12 and must stabilize. Returns the store (not the chunk) —
 * the caller wraps it with caBxChunk() and inserts before IEND.
 */
export async function buildC2paStorePng(p: C2paManifestParams, insertOffset: number): Promise<Uint8Array> {
  const uuid = p.instanceId.replace(/^xmp:iid:/i, '');
  const manifestLabel = 'verify:urn:uuid:' + uuid;
  const telemetryJson = utf8ToBytes(JSON.stringify(p.telemetry));
  const CHUNK_OVERHEAD = 12; // length(4) + "caBX"(4) + CRC32(4)
  const SLACK = 256; // 0.18.5: matches buildC2paSegment — see its note

  let exclusionLength = 0;
  const rounds: string[] = []; // per-round sizes for the final throw (0.18.7)

  for (let i = 0; i < 12; i++) {
    const hashDataCbor = encode({
      exclusions: [{ start: insertOffset, length: exclusionLength }],
      alg: 'sha256',
      hash: p.cleanFileSha256,
      name: 'jumbf manifest',
      pad: new Uint8Array(10),
    });
    const hashDataBox = jumbBox(UUID_CBOR, 'c2pa.hash.data', box('cbor', hashDataCbor));
    const rest = verifyAssertionBoxes(p, telemetryJson);
    const assertionBoxes = [hashDataBox, ...rest.boxes];
    const labels = ['c2pa.hash.data', ...rest.labels];
    const claimBytes = buildClaimBytes(p, uuid, assertionBoxes, labels);

    // Converge sizes with the fixed-size dummy signature + probe
    // tokens; phase 2 signs the final claim exactly once (see buildC2paSegment).
    const plan = await planClaim(claimBytes, p);
    const probeSigned = { protectedBstr: plan.protectedBstr, rawSignature: DUMMY_RAW_SIG, pq: p.pq ? { alg: PQ_ALG, fp: p.pq.fingerprint, sig: DUMMY_PQ_SIG } : null };
    const assembleProbe = (padLen: number): Uint8Array =>
      assembleStore(manifestLabel, claimBytes, assertionBoxes, probeSigned, plan.probeTokens, padLen);

    // Convergence rule: exact length, or — once probe
    // tokens reserve slack — a probe PADDED to the exclusion length.
    const probeBare = assembleProbe(0);
    rounds.push(`round ${i}: target=${exclusionLength} probe=${probeBare.length + CHUNK_OVERHEAD}`);
    let converged = probeBare.length + CHUNK_OVERHEAD === exclusionLength;
    if (!converged && plan.probeTokens.length > 0 && probeBare.length + CHUNK_OVERHEAD < exclusionLength) {
      const delta = exclusionLength - (probeBare.length + CHUNK_OVERHEAD);
      // padForDelta null = unrepresentable delta (29/262) — grow past the hole.
      const pad = delta >= 6 ? padForDelta(delta) : null;
      if (pad !== null && assembleProbe(pad).length + CHUNK_OVERHEAD === exclusionLength) converged = true;
    }
    if (converged) {
      const { signed, timestampTokens } = await signPlannedClaim(plan, p);
      const assembleReal = (padLen: number): Uint8Array =>
        assembleStore(manifestLabel, claimBytes, assertionBoxes, signed, timestampTokens, padLen);
      const bare = assembleReal(0);
      rounds[i] += ` signed=${bare.length + CHUNK_OVERHEAD}`;
      if (bare.length + CHUNK_OVERHEAD === exclusionLength) return bare;
      const delta = exclusionLength - (bare.length + CHUNK_OVERHEAD);
      const pad = delta >= 6 ? padForDelta(delta) : null;
      if (pad !== null) {
        const store = assembleReal(pad);
        if (store.length + CHUNK_OVERHEAD === exclusionLength) return store;
      }
      // Same re-converge-instead-of-throw as the JPEG path — see
      // buildC2paSegment's note. Bounded by the 12-iteration loop.
      exclusionLength = Math.max(bare.length + CHUNK_OVERHEAD, exclusionLength) + SLACK;
      continue;
    }

    exclusionLength = probeBare.length + CHUNK_OVERHEAD + (plan.probeTokens.length > 0 ? SLACK : 0);
  }
  throw new Error(`C2PA PNG store did not converge — ${rounds.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// BMFF (MP4/MOV/M4A) hard binding — c2pa.hash.bmff.v2
// ---------------------------------------------------------------------------

/**
 * One entry of a bmff-hash-map exclusions array. Root-level box xpaths only
 * ('/uuid', '/ftyp', '/mfra'); `data` entries require the box bytes at
 * `offset` to equal `value` (used to exclude only the C2PA uuid box).
 */
export interface BmffExclusion {
  xpath: string;
  length?: number;
  data?: { offset: number; value: Uint8Array }[];
}

/** The three exclusions the C2PA spec mandates for every BMFF manifest. */
export function bmffMandatoryExclusions(c2paUuidBytes: Uint8Array): BmffExclusion[] {
  return [
    { xpath: '/uuid', data: [{ offset: 8, value: c2paUuidBytes }] },
    { xpath: '/ftyp' },
    { xpath: '/mfra' },
  ];
}

/** CBOR body of the c2pa.hash.bmff.v2 assertion. Fixed length for a given alg. */
export function bmffHashAssertionCbor(hash: Uint8Array, exclusions: BmffExclusion[]): Uint8Array {
  return encode({
    exclusions: exclusions.map((e) => {
      const m: Record<string, unknown> = { xpath: e.xpath };
      if (e.length !== undefined) m.length = e.length;
      if (e.data) m.data = e.data.map((d) => ({ offset: d.offset, value: d.value }));
      return m;
    }),
    alg: 'sha256',
    hash,
    name: 'jumbf manifest',
  });
}

export function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  const hi = Math.floor(n / 2 ** 32);
  const lo = n % 2 ** 32;
  out[0] = (hi >>> 24) & 0xff; out[1] = (hi >>> 16) & 0xff; out[2] = (hi >>> 8) & 0xff; out[3] = hi & 0xff;
  out[4] = (lo >>> 24) & 0xff; out[5] = (lo >>> 16) & 0xff; out[6] = (lo >>> 8) & 0xff; out[7] = lo & 0xff;
  return out;
}

export function boxExcluded(bytes: Uint8Array, box: RootBox, exclusions: BmffExclusion[]): boolean {
  for (const ex of exclusions) {
    // Root-level paths only; anything deeper is outside what we (and
    // c2pa-rs for monolithic files) ever write — left hashed, which fails
    // closed if a foreign manifest relied on it.
    if (ex.xpath !== '/' + box.type) continue;
    if (ex.length !== undefined && ex.length !== box.size) continue;
    let dataOk = true;
    for (const d of ex.data ?? []) {
      const start = box.start + d.offset;
      if (start + d.value.length > box.start + box.size) { dataOk = false; break; }
      for (let i = 0; i < d.value.length; i++) {
        if (bytes[start + i] !== d.value[i]) { dataOk = false; break; }
      }
      if (!dataOk) break;
    }
    if (dataOk) return true;
  }
  return false;
}

/**
 * c2pa.hash.bmff.v2 over a whole file: for every root box not fully
 * excluded, the hash input is the box's 8-byte big-endian absolute file
 * offset followed by the entire box (header included). Excluded boxes
 * contribute nothing. Because the manifest's own uuid box is fully
 * excluded, there is no circularity — but every other box's offset shifts
 * with the uuid box's size, so the hash is computed over the final layout.
 */
export function hashBmffV2(bytes: Uint8Array, exclusions: BmffExclusion[]): Uint8Array {
  const h = sha256.create();
  for (const b of parseRootBoxes(bytes)) {
    if (boxExcluded(bytes, b, exclusions)) continue;
    h.update(u64be(b.start));
    h.update(bytes.subarray(b.start, b.start + b.size));
  }
  return h.digest();
}

/**
 * Builds the raw JUMBF manifest store for BMFF embedding (no APP11 wrapper),
 * with the asset bound by a c2pa.hash.bmff.v2 assertion.
 *
 * `hashAssertionCbor` must be built with bmffHashAssertionCbor — its length
 * never depends on the hash VALUE (a bstr of fixed size), so the store
 * length is stable across the caller's hash fixpoint. `fixedLength` pins the
 * output size (padding absorbs TSA token variance); when the store cannot
 * be held to it, the oversized/undersized store is returned as-is and the
 * caller re-targets.
 *
 * Two-phase signing: sizing rounds assemble with a fixed-size
 * DUMMY signature and are never part of a returned file (the caller's
 * fixpoint rebuilds); the round that hits the target length signs the claim
 * exactly once. A biometric-bound key therefore prompts once per video, not
 * once per fixpoint round.
 */
export async function buildC2paStoreBmff(
  p: C2paManifestParams,
  hashAssertionCbor: Uint8Array,
  fixedLength: number | null
): Promise<Uint8Array> {
  const uuid = p.instanceId.replace(/^xmp:iid:/i, '');
  const manifestLabel = 'verify:urn:uuid:' + uuid;
  const telemetryJson = utf8ToBytes(JSON.stringify(p.telemetry));
  const SLACK = 256; // 0.18.5: matches buildC2paSegment — see its note

  const hashBox = jumbBox(UUID_CBOR, 'c2pa.hash.bmff.v2', box('cbor', hashAssertionCbor));
  const rest = verifyAssertionBoxes(p, telemetryJson);
  const assertionBoxes = [hashBox, ...rest.boxes];
  const labels = ['c2pa.hash.bmff.v2', ...rest.labels];
  const claimBytes = buildClaimBytes(p, uuid, assertionBoxes, labels);

  const plan = await planClaim(claimBytes, p);
  const probeSigned = { protectedBstr: plan.protectedBstr, rawSignature: DUMMY_RAW_SIG, pq: p.pq ? { alg: PQ_ALG, fp: p.pq.fingerprint, sig: DUMMY_PQ_SIG } : null };
  const assembleProbe = (padLen: number): Uint8Array =>
    assembleStore(manifestLabel, claimBytes, assertionBoxes, probeSigned, plan.probeTokens, padLen);

  const probe = assembleProbe(0);
  // The length this store is contracted to hit. A sizing round (fixedLength
  // null) with tokens reserves slack so the real tokens never outgrow it.
  let target: number | null = fixedLength;
  if (target === null && plan.probeTokens.length > 0) target = probe.length + SLACK;

  // Pad the probe to the target when possible. (The pad entry carries a
  // non-empty byte string, so the smallest real pad is 6 bytes; deltas of
  // 1–5 stay unreachable here and the round simply runs unpadded — the
  // signing round's overshoot guard below is what closes that gap.)
  let probeStore = probe;
  let onTarget = target !== null && probe.length <= target;
  if (onTarget && probe.length < target!) {
    const delta = target! - probe.length;
    const pad = padForDelta(delta); // null at the unrepresentable holes (29, 262) → treat as off-target
    onTarget = delta >= 6 && pad !== null;
    if (onTarget) probeStore = assembleProbe(pad!);
  }

  if (onTarget && target !== null && probeStore.length === target) {
    // Converged — the ONLY round that burns a real signature.
    const { signed, timestampTokens } = await signPlannedClaim(plan, p);
    const store = assembleStore(manifestLabel, claimBytes, assertionBoxes, signed, timestampTokens, 0);
    if (store.length === target) return store;
    let delta = target - store.length;
    // 0.18.6 (field: 'C2PA BMFF embed did not converge'): a store 1–5 bytes
    // UNDER target cannot be re-padded — the pad entry carries a non-empty
    // byte string, so the shortest encodable pad is 6 bytes — and the real
    // TSA tokens are re-fetched fresh every signing round, so the shortfall
    // re-randomizes. The caller's fixpoint could oscillate inside that gap
    // until the round budget ran out. Pad PAST the gap instead: delta+5 is
    // always encodable and lands the store exactly target+5 (any d in the
    // gap), the caller re-pins to that reachable length, and the next round
    // pads exactly. Monotonic, bounded, and padding bytes are inert COSE
    // header content.
    if (delta >= 1 && delta <= 5) delta += 5;
    if (delta >= 5) {
      const pad = padForDelta(delta); // null → no box sequence can cover this growth; stay off-target this round
      if (pad !== null) {
        const padded = assembleStore(manifestLabel, claimBytes, assertionBoxes, signed, timestampTokens, pad);
        if (padded.length === store.length + delta) return padded;
      }
    }
    // Real tokens drifted beyond the slack — off target; the caller's
    // fixpoint re-targets to store.length and rebuilds.
    return store;
  }

  // Sizing round or off-target: dummy signature inside (see the docstring —
  // the caller rebuilds until a round converges; only that round signs).
  return probeStore;
}

// ---------------------------------------------------------------------------
// Reader / verifier
// ---------------------------------------------------------------------------

interface JumbNode {
  label: string;
  /** Content after the jumd description box (concatenated child boxes or payload). */
  body: Uint8Array;
  children: JumbNode[];
  /** Full jumb box bytes including header (for assertion hashing). */
  full: Uint8Array;
}

function parseJumb(jumb: Uint8Array): JumbNode | null {
  // STRICT declared-length parsing. `jumb` spans from this box's start to
  // the end of the enclosing buffer; the box's own DECLARED length governs
  // everything: `full`/`body` are cut at the declared span, and the child
  // walk stops at the first malformed length instead of resyncing forward.
  //
  // History: 0.18.6 briefly carried a physical-tail-tolerant walk with a
  // resync scan, built for a "2022-era writers under-declare container
  // lengths" theory. That theory was WRONG — the apparent under-declaration
  // was the JPEG APP11 multi-segment envelope interleaved into the physical
  // byte stream (ISO 19566-5; see extractC2paStore), not defective boxes.
  // With proper de-segmentation the logical stream is exactly sized, the
  // tolerant walk was dead code for every real file, and its resync made
  // container-length bytes malleable (a flipped length was silently walked
  // past — test-malleability caught it). Strict is smaller, faster to
  // reason about, and closes that hole: the full 27-file c2pa-org
  // public-testfiles sweep passes 28/28 under strict parsing.
  if (jumb.length < 8 || String.fromCharCode(jumb[4], jumb[5], jumb[6], jumb[7]) !== 'jumb') return null;
  const declaredLen = readU32(jumb, 0);
  if (declaredLen < 8) return null;
  const declaredEnd = Math.min(declaredLen, jumb.length);
  const content = jumb.subarray(8, declaredEnd);
  if (content.length < 8 || String.fromCharCode(content[4], content[5], content[6], content[7]) !== 'jumd') return null;
  const jumdLen = readU32(content, 0);
  const jumd = content.subarray(8, jumdLen);
  let q = 17; // uuid(16) + toggle(1)
  while (q < jumd.length && jumd[q] !== 0) q++;
  const label = bytesToUtf8(jumd.subarray(17, q));
  const body = content.subarray(jumdLen); // declared content — hashing/COSE reads use THIS
  const node: JumbNode = { label, body, children: [], full: jumb.subarray(0, declaredEnd) };
  if (jumd[16] & 0x02) {
    let off = 0;
    while (off + 8 <= body.length) {
      const len = readU32(body, off);
      if (len < 8 || off + len > body.length) break; // malformed length — stop, never resync
      const child = parseJumb(body.subarray(off, off + len));
      if (child) node.children.push(child); // leaf boxes ('cbor'/'json'/…) return null — skipped by length
      off += len;
    }
  }
  return node;
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** One entry of a standard C2PA actions assertion (edit history). */
export interface EditAction {
  /** e.g. 'c2pa.edited', 'c2pa.cropped' — or a vendor-specific name. */
  action: string;
  softwareAgent?: string;
  when?: string;
  description?: string;
  /** IPTC digitalSourceType URI (C2PA 2.1+ created/opened actions carry it). */
  digitalSourceType?: string;
}

/** One standard C2PA ingredient assertion (what this file was made from). */
export interface IngredientInfo {
  title?: string;
  format?: string;
  relationship?: string;
  instanceId?: string;
  /** The ingredient's declared data hash (hex), when present — the full-res
      bytes the embedded thumbnail leads to (0.18.6: parsed so a de-identify
      re-seal can carry second-camera stills forward unchanged). */
  dataHashHex?: string;
  /** The ingredient's declared thumbnail assertion identifier, when present. */
  thumbnailIdentifier?: string;
  /** The assertion's own label (c2pa.ingredient, .v2, .v3 — multi-still
      video manifests suffix: c2pa.ingredient.v3.5). */
  label: string;
}

export interface C2paManifest {
  claim: Record<string, unknown>;
  claimBytes: Uint8Array;
  protectedHeader: Uint8Array;
  signature: Uint8Array;
  certDer: Uint8Array;
  /** Full COSE x5chain ([0] = signing leaf) — for real chain verification. */
  certChain: Uint8Array[];
  /** Number of certs in the COSE x5chain (1 = bare self-signed leaf). */
  certChainLength: number;
  hashData: { exclusions: { start: number; length: number }[]; alg: string; hash: Uint8Array } | null;
  /** BMFF hard binding, when the manifest rides in an MP4/MOV/M4A. */
  hashBmff: { exclusions: BmffExclusion[]; alg: string; hash: Uint8Array } | null;
  telemetry: Record<string, unknown> | null;
  manifestLabel: string;
  /** Assertion label → sha256 of its jumb box content (as the claim references). */
  assertionHashes: Record<string, Uint8Array>;
  /** Raw RFC 3161 TimeStampTokens (sigTst2/sigTst) — verified cryptographically downstream; presence alone means nothing. */
  timestampTokens: Uint8Array[];
  /**
   * Which COSE header carried the tokens: v2 sigTst2 (CTT — token imprints
   * the signature) or v1 sigTst (RFC 9052 — token imprints the CLAIM). The
   * countersigned message differs between the two; verification must use
   * the matching construction or every genuine v1 token fails. Null when no
   * tokens are present.
   */
  timestampVersion: 'v2-sigTst2' | 'v1-sigTst' | null;
  /**
   * PQ dual-signature entry from the COSE unprotected header (verifyPq), when
   * present. The signature covers the same Sig_structure as the
   * ES256 signature; the public key is NOT here — it is committed inside the
   * signed record payload (telemetry.pqKey), which doubles as strip detection.
   */
  pq: { alg: string; fingerprint: string; signature: Uint8Array } | null;
  /** Raw content bytes of the com.verify.app-attest assertion, when present. */
  appAttestAssertion: Uint8Array | null;
  /** Signed on-device transcript (audio), when present. */
  transcript: TranscriptAssertion | null;
  /**
   * Assertion labels the SIGNED CLAIM references (its `assertions` list, urls
   * normalized to bare labels). A box present in the store but absent here
   * was attached AFTER signing (box surgery) and carries NO cryptographic
   * weight: every claim-bound report string must gate
   * on membership in this list. Presence in the store is not endorsement.
   */
  referencedAssertionLabels: string[];
  /**
   * Sanitized camera EXIF (com.verify.exif), when present. `referenced` is
   * true ONLY when the signed claim references the box — an unreferenced box
   * still parses (display is fine) but binds to nothing.
   */
  exif: { data: Record<string, unknown>; referenced: boolean } | null;
  /**
   * Org identity assertion (com.verify.identity), when present.
   * `referencedTelemetryHashHex` is the assertion's own claim about which
   * telemetry hash it binds to — verifyManifest cross-checks it against the
   * real assertion hash before any line calls it verified.
   */
  identity: { org: string; role: string; referencedTelemetryHashHex: string } | null;
  /**
   * Parsed JSON bodies of the project-specific custom assertions
   * (com.verify.streamedChunks / contextTree / poseTrace / captureIntegrity),
   * keyed by label. Unknown or malformed bodies are simply absent — the
   * claim's assertion-hash binding (assertionHashes + claimAssertionsMatch)
   * covers their integrity regardless of whether we understand the payload
   * (UNSUPPORTED semantics for future fields). `referenced` is true ONLY
   * when the signed claim references the label (referencedAssertionLabels);
   * an unreferenced box was attached post-signing and proves nothing.
   */
  customAssertions: Record<string, { data: unknown; referenced: boolean }>;
  /**
   * Standard C2PA actions assertion (edit history — c2pa.actions /
   * c2pa.actions.v2), parsed from the ACTIVE manifest. `referenced` is true
   * ONLY when the signed claim references the box: these entries are
   * DECLARED by the sealing software — they show what was declared and
   * cannot prove nothing else happened. Absent entirely when the manifest
   * carries no actions box (Source Kit's own manifests don't).
   */
  actions: { list: EditAction[]; referenced: boolean } | null;
  /**
   * c2pa.metadata — signer-attributed standard metadata
   * (JSON-LD). DECLARED by the sealing software like actions: parsed for
   * display, claim-bound only when `referenced`.
   */
  c2paMetadata: { data: Record<string, unknown>; referenced: boolean } | null;
  /**
   * c2pa.soft-binding — the declared soft binding (alg id +
   * first block value, hex). RECOVERY METADATA, never a hard binding: the
   * spec forbids soft bindings as hard bindings, and no report string may
   * present a match here as asset integrity.
   */
  softBinding: { alg: string; valueHex: string | null; referenced: boolean } | null;
  /**
   * c2pa.training-mining — the declared training/data-mining
   * permissions, property → use (e.g. 'c2pa.ai_generative_training' →
   * 'notAllowed'). The signer/developer's stance, stated; not a runtime
   * enforcement signal.
   */
  trainingMining: { entries: Record<string, string>; referenced: boolean } | null;
  /**
   * c2pa.asset-type / c2pa.asset-type.v2 — declared asset
   * types (e.g. ['image']). v1 (CBOR map) and v2 (JSON array) both parse.
   */
  assetType: { types: string[]; referenced: boolean } | null;
  /**
   * Claim/ingredient thumbnails (c2pa.thumbnail.*.jpeg/.png) — raw image
   * bytes for display, each with its own `referenced` gate; an
   * unreferenced thumbnail is decoration attached post-signing.
   */
  thumbnails: { label: string; bytes: Uint8Array; referenced: boolean }[];
  /**
   * c2pa.depthmap.GDepth — the declared depth map:
   * GDepth envelope fields plus the decoded map image. Optically captured
   * by the signer's claim; parsed for display/coherence, claim-bound only
   * when `referenced`. Self-asserted like every assertion — a scene-match
   * check (spec's depthMap.sceneMismatch) is a desk analyzer's job.
   */
  depthmap: {
    format: string;
    near: number;
    far: number;
    mime: string;
    units: string | null;
    measureType: string | null;
    imageWidth: number | null;
    imageHeight: number | null;
    data: Uint8Array;
    confidence: Uint8Array | null;
    referenced: boolean;
  } | null;
  /**
   * c2pa.hash.collection.data — the declared
   * multi-part set (photo + depth map), per-entry sha256 over ALL bytes of
   * each member. A HARD BINDING over set membership: validate with
   * verifyCollectionHash against the actual artifacts.
   */
  collectionHash: {
    alg: string;
    uris: { uri: string; hashHex: string; size: number | null; dcFormat: string | null }[];
    referenced: boolean;
  } | null;
  /**
   * Standard C2PA ingredient assertions (c2pa.ingredient[.vN]) — the assets
   * this file was made from, as declared by the sealing software. Same
   * declared-not-proven semantics as actions; each carries its own
   * `referenced` flag.
   */
  ingredients: (IngredientInfo & { referenced: boolean })[];
  /** claim_generator — the software that sealed THIS manifest. */
  claimGenerator: string | null;
  /** Manifests in the store. >1 means an update chain; only the active one is verified. */
  manifestCount: number;
}

/** The ISO 19566-5 envelope of an APP11 "JP" payload: En (box-instance) and Z (1-based packet sequence). */
function app11Envelope(payload: Uint8Array): { en: number; z: number } | null {
  if (payload.length < APP11_ENVELOPE_BYTES || payload[0] !== 0x4a || payload[1] !== 0x50) return null;
  const en = (payload[2] << 8) | payload[3];
  const z = readU32(payload, 4); // Z is a u32 packet sequence number (ISO 19566-5)
  return { en, z };
}

/** True if a FIRST packet (Z=1) opens a C2PA JUMBF store ('c2pa' uuid at 24). */
function isC2paStoreFirstPacket(payload: Uint8Array): boolean {
  return (
    payload.length > 40 &&
    payload[12] === 0x6a && payload[13] === 0x75 && payload[14] === 0x6d && payload[15] === 0x62 && // 'jumb'
    payload[24] === 0x63 && payload[25] === 0x32 && payload[26] === 0x70 && payload[27] === 0x61    // 'c2pa' UUID prefix
  );
}

/**
 * Locates the C2PA store inside a JPEG's APP11 segments and reassembles it.
 * A store larger than one segment rides an ISO 19566-5 packet chain (one
 * En, consecutive 1-based Z); the packets are concatenated in Z order.
 * segmentStart/segmentLength span the WHOLE chain, which must be one
 * contiguous run — the hash.data exclusion is a single byte range, and a
 * fragmented chain would make that range a lie. A broken chain (gap,
 * duplicate Z, interleaved packets) is absence, never a guess.
 */
export function extractC2paStore(jpeg: Uint8Array): { payload: Uint8Array; segmentStart: number; segmentLength: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const packets: { en: number; z: number; start: number; length: number; payload: Uint8Array }[] = [];
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) return null;
    const marker = jpeg[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = (jpeg[offset + 2] << 8) | jpeg[offset + 3];
    if (length < 2 || offset + 2 + length > jpeg.length) return null;
    if (marker === 0xeb) {
      const payload = jpeg.subarray(offset + 4, offset + 2 + length);
      const env = app11Envelope(payload);
      if (env && env.z > 0) packets.push({ ...env, start: offset, length: 2 + length, payload });
    }
    offset += 2 + length;
  }
  // Group by En; a C2PA group is one whose FIRST packet (Z=1) opens a c2pa store.
  const groups = new Map<number, typeof packets>();
  for (const p of packets) {
    const g = groups.get(p.en) ?? [];
    g.push(p);
    groups.set(p.en, g);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.z - b.z);
    if (g[0].z !== 1 || !isC2paStoreFirstPacket(g[0].payload)) continue;
    let contiguous = true;
    for (let i = 0; i < g.length; i++) {
      if (g[i].z !== i + 1) { contiguous = false; break; }
      if (i > 0 && g[i].start !== g[i - 1].start + g[i - 1].length) { contiguous = false; break; }
    }
    if (!contiguous) continue; // broken or fragmented chain — stated absence
    // Continuation packets (Z>1) may REPEAT the store's LBox/TBox after the
    // 8-byte CI/En/Z envelope — ISO 19566-5: "all fields except the XLBox
    // field … shall be present in all JPEG XT marker segment representing
    // this box". c2pa-rs and the 2022 Adobe writers duplicate them; our own
    // writer (app11Segments) does not. Strip the duplicate only when it is
    // literally there — a byte-compare against the first packet's store
    // header — so both writer forms reassemble to the exact logical store.
    // Without this, the 8 duplicated bytes land mid-stream and every box
    // straddling a segment boundary hashes wrong (Adobe 2022
    // ingredient thumbnails failed claim-assertion verification for exactly
    // this reason — the foreign store's declared lengths count the LOGICAL
    // stream, not the physical file bytes).
    const storeHeader = g[0].payload.subarray(APP11_ENVELOPE_BYTES, APP11_ENVELOPE_BYTES + 8);
    return {
      payload: concatBytes(...g.map((p, i) => {
        if (
          i > 0 &&
          p.payload.length >= APP11_ENVELOPE_BYTES + 8 &&
          p.payload.subarray(APP11_ENVELOPE_BYTES, APP11_ENVELOPE_BYTES + 8).every((v, k) => v === storeHeader[k])
        ) {
          return p.payload.subarray(APP11_ENVELOPE_BYTES + 8);
        }
        return p.payload.subarray(APP11_ENVELOPE_BYTES);
      })),
      segmentStart: g[0].start,
      segmentLength: g.reduce((n, p) => n + p.length, 0),
    };
  }
  return null;
}

/**
 * Parses the active manifest from a C2PA store payload. Per the C2PA spec
 * the active manifest is the LAST one in the store (each update appends);
 * taking children[0] would let a crafted file show this verifier a benign
 * first manifest while a reference validator reads a different active one —
 * the "two verifiers, two verdicts" confusion attack.
 */
export function parseManifest(storePayload: Uint8Array): C2paManifest | null {
  // Hostile input must never throw here: a manifest whose CBOR/JUMBF does
  // not parse is INVALID CREDENTIALS (callers map null → SIGNATURE_INVALID),
  // not a verifier crash. The corpus's hostile-claim file pins this.
  try {
    return parseManifestInner(storePayload);
  } catch {
    return null;
  }
}

function parseManifestInner(storePayload: Uint8Array): C2paManifest | null {
  // Full payload, NOT cut at the store's declared length: 2022-era writers
  // under-declare the store box too, and parseJumb's physical-tail tolerance
 // needs those trailing bytes to recover the last child.
  const store = parseJumb(storePayload);
  const manifestCount = store?.children.length ?? 0;
  const manifest = store?.children[manifestCount - 1];
  if (!store || !manifest) return null;
  return parseOneManifest(manifest, manifestCount);
}

/**
 * Parses EVERY manifest in the store, in store order (last = active).
 * A manifest whose CBOR/JUMBF does not parse comes back null in place —
 * the caller reports it as invalid credentials for that manifest, never
 * silently skips it. Hostile input never throws.
 */
export function parseManifestChain(storePayload: Uint8Array): { manifests: (C2paManifest | null)[] } | null {
  try {
    const store = parseJumb(storePayload); // full payload — see parseManifestInner
    if (!store || store.children.length === 0) return null;
    const count = store.children.length;
    return {
      manifests: store.children.map((node) => {
        try {
          return parseOneManifest(node, count);
        } catch {
          return null;
        }
      }),
    };
  } catch {
    return null;
  }
}

function parseOneManifest(manifest: JumbNode, manifestCount: number): C2paManifest | null {
  const find = (label: string) => manifest.children.find((c) => c.label === label) ?? null;
  const claimNode = find('c2pa.claim');
  const sigNode = find('c2pa.signature');
  const assertionsNode = find('c2pa.assertions');
  if (!claimNode || !sigNode) return null;
  let appAttestAssertion: Uint8Array | null = null;

  // Claim: body is a single 'cbor' box.
  if (claimNode.body.length < 8) return null;
  const claimBytes = claimNode.body.subarray(8, readU32(claimNode.body, 0));
  const claim = decode(claimBytes) as Record<string, unknown>;

  // Signature: body is a single 'cbor' box containing COSE_Sign1.
  if (sigNode.body.length < 8) return null;
  const cose = sigNode.body.subarray(8, readU32(sigNode.body, 0));
  const decoded = decode(cose) as { tag?: number; value?: unknown[] };
  const arr = (decoded && Array.isArray(decoded.value) ? decoded.value : Array.isArray(decoded) ? decoded : null) as unknown[] | null;
  if (!arr || arr.length !== 4) return null;
  // C2PA requires a DETACHED payload: the payload slot must be CBOR null.
  // Unchecked, that byte is malleable — an embedded payload is
  // non-conformant; reject.
  if (arr[2] !== null && arr[2] !== undefined) return null;
  const protectedHeader = arr[0] as Uint8Array;
  const signature = arr[3] as Uint8Array;

  // x5chain: C2PA 1.x carries it in the PROTECTED header (label 33).
  // 2022-era drafts (Adobe beta, Truepic, Nikon) put it in the UNPROTECTED
  // header under the STRING label 'x5chain'. Reading it from there is sound
  // for signature verification — the signature itself proves possession of
  // the leaf key; the chain merely NAMES which key, and a swapped chain
  // fails the signature. Chain TRUST stays a separate axis downstream
  // (signerTrust), so an unprotected chain cannot launder trust here.
  const headerMap = decode(protectedHeader);
  const chain = (mapGet(headerMap, 33) ?? mapGet(headerMap, 'x5chain') ??
    mapGet(arr[1], 33) ?? mapGet(arr[1], 'x5chain')) as Uint8Array[] | undefined;
  if (!chain || chain.length === 0) return null;
  const certDer = chain[0];

  // The labels the SIGNED CLAIM references — the ONLY boxes claim-bound.
  // Boxes in the store but not in this list were
  // attached after signing: parsed for honest display, carrying no weight.
  const referencedAssertionLabels: string[] = [];
  {
    const refs = mapGet(claim, 'assertions');
    if (Array.isArray(refs)) {
      for (const r of refs) {
        const url = (r as { url?: unknown } | null)?.url;
        if (typeof url === 'string') referencedAssertionLabels.push(assertionRefLabel(url));
      }
    }
  }
  const claimReferences = (label: string): boolean => referencedAssertionLabels.includes(label);

  let hashData: C2paManifest['hashData'] = null;
  let hashBmff: C2paManifest['hashBmff'] = null;
  let telemetry: Record<string, unknown> | null = null;
  let transcript: TranscriptAssertion | null = null;
  let exif: C2paManifest['exif'] = null;
  let identity: C2paManifest['identity'] = null;
  const assertionHashes: Record<string, Uint8Array> = {};
  const customAssertions: C2paManifest['customAssertions'] = {};
  let actions: C2paManifest['actions'] = null;
  let c2paMetadata: C2paManifest['c2paMetadata'] = null;
  let softBinding: C2paManifest['softBinding'] = null;
  let trainingMining: C2paManifest['trainingMining'] = null;
  let assetType: C2paManifest['assetType'] = null;
  let depthmap: C2paManifest['depthmap'] = null;
  let collectionHash: C2paManifest['collectionHash'] = null;
  const thumbnails: C2paManifest['thumbnails'] = [];
  const ingredients: C2paManifest['ingredients'] = [];
  if (assertionsNode) {
    for (const a of assertionsNode.children) {
      assertionHashes[a.label] = sha256(a.full.subarray(8));
      if (a.label === 'c2pa.hash.data' && a.body.length >= 8) {
        const cborBytes = a.body.subarray(8, readU32(a.body, 0));
        // Structural validation, never a blind cast: mutated
        // CBOR can decode to a map missing exclusions/hash — accepting it
        // crashed verifyManifest on .length. Malformed → hashData stays
        // null → asset integrity UNPROVEN and disclosed, never a TypeError.
        const decoded = decode(cborBytes) as { exclusions?: { start: number; length: number }[]; alg?: string; hash?: Uint8Array } | null;
        if (
          decoded &&
          Array.isArray(decoded.exclusions) &&
          decoded.exclusions.every((r) => r && typeof r.start === 'number' && typeof r.length === 'number') &&
          typeof decoded.alg === 'string' &&
          decoded.hash instanceof Uint8Array
        ) {
          hashData = { exclusions: decoded.exclusions, alg: decoded.alg, hash: decoded.hash };
        }
      } else if (a.label === 'c2pa.hash.bmff.v2' && a.body.length >= 8) {
        const cborBytes = a.body.subarray(8, readU32(a.body, 0));
        const decoded = decode(cborBytes) as { exclusions?: BmffExclusion[]; alg?: string; hash?: Uint8Array } | null;
        if (
          decoded &&
          Array.isArray(decoded.exclusions) &&
          typeof decoded.alg === 'string' &&
          decoded.hash instanceof Uint8Array
        ) {
          hashBmff = { exclusions: decoded.exclusions, alg: decoded.alg, hash: decoded.hash };
        }
      } else if (a.label === 'com.verify.app-attest' && a.body.length >= 8) {
        appAttestAssertion = a.body.subarray(8, readU32(a.body, 0));
      } else if (a.label === 'com.verify.transcript' && a.body.length >= 8) {
        try {
          transcript = JSON.parse(bytesToUtf8(a.body.subarray(8, readU32(a.body, 0)))) as TranscriptAssertion;
        } catch { /* non-fatal */ }
      } else if (a.label === 'com.verify.identity' && a.body.length >= 8) {
        try {
          const j = JSON.parse(bytesToUtf8(a.body.subarray(8, readU32(a.body, 0))));
          const ref = Array.isArray(j?.referenced_assertions) ? j.referenced_assertions[0] : null;
          if (typeof j?.namedActor?.org === 'string' && typeof ref?.hash === 'string') {
            identity = {
              org: j.namedActor.org,
              role: typeof j.namedActor.role === 'string' ? j.namedActor.role : 'organization',
              referencedTelemetryHashHex: ref.hash,
            };
          }
        } catch { /* non-fatal — a malformed assertion is absence, not evidence */ }
      } else if (a.label === 'com.verify.exif' && a.body.length >= 8) {
        try {
          exif = {
            data: JSON.parse(bytesToUtf8(a.body.subarray(8, readU32(a.body, 0)))),
            referenced: claimReferences(a.label),
          };
        } catch { /* non-fatal */ }
      } else if (a.label === 'com.verify.telemetry' && a.body.length >= 8) {
        try {
          telemetry = JSON.parse(bytesToUtf8(a.body.subarray(8, readU32(a.body, 0))));
        } catch { /* non-fatal */ }
      } else if ((a.label === 'c2pa.actions' || a.label === 'c2pa.actions.v2') && a.body.length >= 8) {
        // Standard C2PA edit history (CBOR): how a Canon→Photoshop file
        // surfaces its edits here. Structural validation, never a blind
        // cast — malformed CBOR decodes to absence, never a crash.
        try {
          const cborBytes = a.body.subarray(8, readU32(a.body, 0));
          const decoded = decode(cborBytes) as { actions?: unknown } | null;
          if (decoded && Array.isArray(decoded.actions)) {
            const list: EditAction[] = [];
            for (const raw of decoded.actions) {
              if (!raw || typeof raw !== 'object') continue;
              const e = raw as Record<string, unknown>;
              if (typeof e.action !== 'string') continue;
              // softwareAgent is a plain string in v1; v2 allows a map
              // ({name, version}) — take the name either way.
              const sa = e.softwareAgent;
              const softwareAgent =
                typeof sa === 'string' ? sa
                : sa && typeof sa === 'object' && typeof (sa as { name?: unknown }).name === 'string'
                  ? (sa as { name: string }).name
                  : undefined;
              const params = e.parameters && typeof e.parameters === 'object' ? (e.parameters as Record<string, unknown>) : null;
              list.push({
                action: e.action,
                softwareAgent,
                when: typeof e.when === 'string' ? e.when : undefined,
                description: params && typeof params.description === 'string' ? params.description : undefined,
                digitalSourceType: typeof e.digitalSourceType === 'string' ? e.digitalSourceType : undefined,
              });
            }
            actions = { list, referenced: claimReferences(a.label) };
          }
        } catch { /* non-fatal — a malformed assertion is absence, not evidence */ }
      } else if (/^c2pa\.ingredient(\.v\d+)?(\.\d+)?$/.test(a.label) && a.body.length >= 8) {
        // Standard C2PA ingredient (CBOR): an asset this file was made
        // from, as declared by the sealing software. The (.\d+)? suffix is
        // the 0.18.6 multi-still video case — emission suffixes later pair
        // ingredients (c2pa.ingredient.v3.5) to keep claim labels unique;
        // the anchored regex parsed only the first still's ingredient.
        try {
          const cborBytes = a.body.subarray(8, readU32(a.body, 0));
          const decoded = decode(cborBytes) as Record<string, unknown> | null;
          if (decoded && typeof decoded === 'object') {
            // The data hash + thumbnail identifier let a re-seal (the
            // de-identify path) carry the second-camera stills forward —
            // lead bytes and the full-res commitment, unchanged.
            const data = decoded.data as { hash?: unknown } | undefined;
            const thumb = decoded.thumbnail as { identifier?: unknown } | undefined;
            ingredients.push({
              title: typeof decoded.title === 'string' ? decoded.title : undefined,
              format: typeof decoded.format === 'string' ? decoded.format : undefined,
              relationship: typeof decoded.relationship === 'string' ? decoded.relationship : undefined,
              instanceId: typeof decoded.instanceId === 'string' ? decoded.instanceId : undefined,
              dataHashHex: data?.hash instanceof Uint8Array ? bytesToHex(data.hash) : undefined,
              thumbnailIdentifier: typeof thumb?.identifier === 'string' ? thumb.identifier : undefined,
              label: a.label,
              referenced: claimReferences(a.label),
            });
          }
        } catch { /* non-fatal */ }
      } else if (a.label === LABEL_METADATA && a.body.length >= 8) {
        // c2pa.metadata (JSON-LD) — declared metadata, same epistemic
        // weight as actions: display, gated on `referenced`.
        try {
          const j = JSON.parse(bytesToUtf8(a.body.subarray(8, readU32(a.body, 0))));
          if (j && typeof j === 'object' && !Array.isArray(j)) {
            c2paMetadata = { data: j as Record<string, unknown>, referenced: claimReferences(a.label) };
          }
        } catch { /* non-fatal — a malformed assertion is absence, not evidence */ }
      } else if (a.label === LABEL_SOFT_BINDING && a.body.length >= 8) {
        // c2pa.soft-binding (CBOR): { alg, blocks: [{scope, value}], pad }.
        // Structural validation; value surfaced as hex for comparison.
        try {
          const cborBytes = a.body.subarray(8, readU32(a.body, 0));
          const decoded = decode(cborBytes) as { alg?: unknown; blocks?: unknown } | null;
          const blocks = decoded && Array.isArray(decoded.blocks) ? decoded.blocks : [];
          const first = blocks[0] as { value?: unknown } | undefined;
          if (decoded && typeof decoded.alg === 'string') {
            softBinding = {
              alg: decoded.alg,
              valueHex: first && first.value instanceof Uint8Array ? bytesToHex(first.value) : typeof first?.value === 'string' ? first.value : null,
              referenced: claimReferences(a.label),
            };
          }
        } catch { /* non-fatal */ }
      } else if (a.label === LABEL_TRAINING_MINING && a.body.length >= 8) {
        // c2pa.training-mining (CBOR): { entries: { property: { use } } }.
        try {
          const cborBytes = a.body.subarray(8, readU32(a.body, 0));
          const decoded = decode(cborBytes) as { entries?: unknown } | null;
          const entries: Record<string, string> = {};
          if (decoded && decoded.entries && typeof decoded.entries === 'object' && !Array.isArray(decoded.entries)) {
            for (const [prop, v] of Object.entries(decoded.entries as Record<string, unknown>)) {
              const use = v && typeof v === 'object' ? (v as { use?: unknown }).use : undefined;
              if (typeof use === 'string') entries[prop] = use;
            }
            trainingMining = { entries, referenced: claimReferences(a.label) };
          }
        } catch { /* non-fatal */ }
      } else if ((a.label === LABEL_ASSET_TYPE_V2 || a.label === 'c2pa.asset-type') && a.body.length >= 8) {
        // Asset type: v2 is a JSON array [{type}], v1 a CBOR map {type}.
        try {
          const types: string[] = [];
          if (a.label === LABEL_ASSET_TYPE_V2) {
            const j = JSON.parse(bytesToUtf8(a.body.subarray(8, readU32(a.body, 0))));
            if (Array.isArray(j)) {
              for (const e of j) {
                if (e && typeof e === 'object' && typeof (e as { type?: unknown }).type === 'string') types.push((e as { type: string }).type);
              }
            }
          } else {
            const cborBytes = a.body.subarray(8, readU32(a.body, 0));
            const decoded = decode(cborBytes) as { type?: unknown } | null;
            if (decoded && typeof decoded.type === 'string') types.push(decoded.type);
          }
          if (types.length > 0) assetType = { types, referenced: claimReferences(a.label) };
        } catch { /* non-fatal */ }
      } else if (a.label === LABEL_DEPTHMAP_GDEPTH && a.body.length >= 8) {
        // c2pa.depthmap.GDepth (CBOR; §18.21 depthmap-gdepth-map). The
        // required five are validated; the map image is base64-decoded.
        try {
          const cborBytes = a.body.subarray(8, readU32(a.body, 0));
          const decoded = decode(cborBytes) as Record<string, unknown> | null;
          const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
          const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
          if (
            decoded &&
            typeof decoded['GDepth:Format'] === 'string' &&
            num(decoded['GDepth:Near']) !== null &&
            num(decoded['GDepth:Far']) !== null &&
            typeof decoded['GDepth:Mime'] === 'string' &&
            typeof decoded['GDepth:Data'] === 'string'
          ) {
            const confB64 = str(decoded['GDepth:Confidence']);
            depthmap = {
              format: decoded['GDepth:Format'] as string,
              near: num(decoded['GDepth:Near']) as number,
              far: num(decoded['GDepth:Far']) as number,
              mime: decoded['GDepth:Mime'] as string,
              units: str(decoded['GDepth:Units']),
              measureType: str(decoded['GDepth:MeasureType']),
              imageWidth: num(decoded['GDepth:ImageWidth']),
              imageHeight: num(decoded['GDepth:ImageHeight']),
              data: base64ToBytes(decoded['GDepth:Data'] as string),
              confidence: confB64 ? base64ToBytes(confB64) : null,
              referenced: claimReferences(a.label),
            };
          }
        } catch { /* non-fatal — malformed assertion is absence, not evidence */ }
      } else if (a.label === LABEL_COLLECTION_HASH && a.body.length >= 8) {
        // c2pa.hash.collection.data (CBOR; §18.8): { uris: [...], alg }.
        // URIs are validated per §15.12.5 (no '.'/'..' components) at parse
        // time — a hostile set name is dropped, never followed.
        try {
          const cborBytes = a.body.subarray(8, readU32(a.body, 0));
          const decoded = decode(cborBytes) as { uris?: unknown; alg?: unknown } | null;
          if (decoded && typeof decoded.alg === 'string' && Array.isArray(decoded.uris)) {
            const uris: { uri: string; hashHex: string; size: number | null; dcFormat: string | null }[] = [];
            for (const e of decoded.uris) {
              const m = e as { uri?: unknown; hash?: unknown; size?: unknown; 'dc:format'?: unknown } | null;
              if (m && typeof m.uri === 'string' && m.hash instanceof Uint8Array && isValidCollectionUri(m.uri)) {
                uris.push({
                  uri: m.uri,
                  hashHex: bytesToHex(m.hash),
                  size: typeof m.size === 'number' ? m.size : null,
                  dcFormat: typeof m['dc:format'] === 'string' ? m['dc:format'] : null,
                });
              }
            }
            if (uris.length > 0) collectionHash = { alg: decoded.alg, uris, referenced: claimReferences(a.label) };
          }
        } catch { /* non-fatal */ }
      } else if (/^c2pa\.thumbnail\.(claim|ingredient)\.(jpeg|png)(\.\d+)?$/.test(a.label) && a.body.length >= 8) {
        // Multi-still video manifests suffix later pair
        // thumbnails (.1/.2/.3 — emission keeps claim labels unique); the
        // anchored regex dropped every still after the first, so exported
        // videos lost their second-camera frames on inspect.
        // Thumbnails ride as image content boxes (jpeg/png), not json/cbor —
        // the content box IS the image. Kept raw for display, referenced-gated.
        const content = a.body.subarray(8, readU32(a.body, 0));
        if (content.length > 0) thumbnails.push({ label: a.label, bytes: new Uint8Array(content), referenced: claimReferences(a.label) });
      } else if (a.label.startsWith('com.verify.') && a.body.length >= 8) {
        // Project-specific custom assertions (streamedChunks / contextTree /
        // poseTrace / captureIntegrity, and any future com.verify.* label):
        // parsed for consumers that understand them; the claim's assertion
        // hash binds the raw box ONLY when the claim references the label —
        // an unreferenced box parses fine but proves nothing.
        try {
          customAssertions[a.label] = {
            data: JSON.parse(bytesToUtf8(a.body.subarray(8, readU32(a.body, 0)))),
            referenced: claimReferences(a.label),
          };
        } catch { /* non-fatal — malformed JSON is absence, never a crash */ }
      }
    }
  }

  // RFC 3161 countersignatures (sigTst2/sigTst): collect the raw tokens for
  // real cryptographic verification downstream — a token's mere presence
  // says nothing until its imprint, digest, and signature all check out.
  const timestampTokens: Uint8Array[] = [];
  let timestampVersion: C2paManifest['timestampVersion'] = null;
  try {
    const unprotected = arr[1]; // cbor-x already decoded the nested map
    const v2 = mapGet(unprotected, 'sigTst2');
    const container = v2 ?? mapGet(unprotected, 'sigTst');
    if (container) timestampVersion = v2 ? 'v2-sigTst2' : 'v1-sigTst';
    const tokens = container ? (mapGet(container, 'tstTokens') as unknown[] | undefined) : undefined;
    for (const t of tokens ?? []) {
      const val = mapGet(t, 'val') as Uint8Array | undefined;
      if (val) timestampTokens.push(val);
    }
  } catch { /* malformed countersignature container — treated as absent */ }

  // PQ dual signature (verifyPq): shape-checked here, verified
  // cryptographically in verifyManifest — presence alone means nothing.
  let pq: C2paManifest['pq'] = null;
  try {
    const unprotected = arr[1];
    const entry = mapGet(unprotected, 'verifyPq') as { alg?: unknown; fp?: unknown; sig?: unknown } | undefined;
    if (
      entry && entry.alg === PQ_ALG && typeof entry.fp === 'string' &&
      entry.sig instanceof Uint8Array && entry.sig.length === PQ_SIZES.signature
    ) {
      pq = { alg: entry.alg, fingerprint: entry.fp, signature: entry.sig };
    }
  } catch { /* malformed PQ entry — treated as absent */ }

  // claim_generator: the software that sealed THIS manifest ("Adobe
  // Photoshop 26.3", "ExhibitA/0.14.0"). Display only — self-asserted.
  const claimGenerator = typeof claim['claim_generator'] === 'string' ? (claim['claim_generator'] as string) : null;

  return { claim, claimBytes, protectedHeader, signature, certDer, certChain: chain.map((c) => new Uint8Array(c)), certChainLength: chain.length, hashData, hashBmff, telemetry, manifestLabel: manifest.label, assertionHashes, referencedAssertionLabels, timestampTokens, timestampVersion, pq, appAttestAssertion, transcript, exif, identity, customAssertions, actions, c2paMetadata, softBinding, trainingMining, assetType, thumbnails, depthmap, collectionHash, ingredients, claimGenerator, manifestCount };
}

/**
 * SHA-256 of the file with byte ranges removed (c2pa.hash.data exclusion
 * semantics). Foreign signers (Leica, Adobe) routinely emit several
 * exclusions, so the general case is N ranges: sort by start, hash the gaps.
 * Zero-length ranges are no-ops (a manifest whose only exclusion is empty
 * hashes the whole file). Malformed ranges — out of bounds or overlapping —
 * fail closed (null), never a guess.
 */
export function sha256ExcludingRanges(bytes: Uint8Array, ranges: { start: number; length: number }[]): Uint8Array | null {
  const rs = ranges
    .filter((r) => r.length > 0)
    .map((r) => ({ start: r.start, end: r.start + r.length }))
    .sort((a, b) => a.start - b.start);
  const h = sha256.create();
  let cursor = 0;
  for (const r of rs) {
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < cursor || r.end > bytes.length) return null;
    h.update(bytes.subarray(cursor, r.start));
    cursor = r.end;
  }
  h.update(bytes.subarray(cursor));
  return h.digest();
}

export interface C2paVerification {
  /** Tri-state: true = signature verifies over the claim bytes; false = it
      does NOT (proven tamper of the signed content); null = this build could
      not run the check (unsupported COSE alg, unreadable key) — absence of
      proof in both directions, to be reported as "not checked", never red. */
  signatureValid: boolean | null;
  assetHashMatches: boolean;
  /**
   * WHY the asset hash failed, when it did:
   * 'mismatch' — the binding is well-formed and the bytes changed (proven
   * tamper); 'void-binding' — the binding proves NOTHING: the declared
   * exclusions exempt the hash input itself (cover the whole file, omit the
   * manifest's own byte range, or exempt the media boxes), the exclusion set
   * is malformed, the container can't be walked, or the signed claim
   * references no hard-binding assertion at all. A void
   * binding is absence of proof, NOT proven tamper — the report layer must
   * never let it surface as "content modified"; null when the hash matches.
   */
  assetHashFailure: 'mismatch' | 'void-binding' | null;
  claimAssertionsMatch: boolean;
  /** COSE alg from the protected header ('ES256', 'PS256', …), or null if unreadable. */
  alg: string | null;
  /**
   * PQ layer evaluation — null when the manifest carries neither a
   * verifyPq entry nor a committed telemetry pqKey (legacy/foreign). The public
   * key comes from the committed record block; the unprotected entry only
   * carries fingerprint + signature, so keyCommitted=false with present=true
   * means the PQ entry cannot be bound to any committed key — it proves nothing.
   */
  pq: PqLayerCheck | null;
  /**
   * Org identity assertion evaluation — null when the
   * manifest carries no com.verify.identity assertion (personal captures,
   * foreign manifests): absence is neutral, never a failure. When present,
   * telemetryHashMatches says the assertion's binding reference matches the
   * claim's own telemetry assertion hash, and orgMatchesChainTop compares
   * the named org against the x5chain's TOP certificate subject (org ?? CN).
   * The top is read straight from the protected-header order (x5chain is
   * leaf-first by construction), so this check works even when full chain
   * ordering/validity can't be established — chain validity remains a
   * separate, independently reported question. orgMatchesChainTop is null
   * when the top cert can't be parsed or carries no org/CN string (or the
   * assertion names no org): the cross-check then could not run and must be
   * reported as unproven, never silently skipped.
   */
  identity: {
    present: boolean;
    org: string | null;
    telemetryHashMatches: boolean;
    orgMatchesChainTop: boolean | null;
    /** Subject (org ?? CN) of the x5chain's top cert, when parseable — surfaced so reports can name what the org was compared against. */
    chainTopName: string | null;
  } | null;
}

/**
 * Verifies a parsed manifest against the media bytes it rides in (JPEG or
 * BMFF). Mirrors what c2pa-rs does: COSE signature over the claim, assertion
 * hashes, then the hard-binding hash — hash.data exclusions for JPEG,
 * c2pa.hash.bmff.v2 for MP4/MOV/M4A.
 */
export function verifyManifest(
  fileBytes: Uint8Array,
  m: C2paManifest,
  /** The embedded manifest's own byte range in the file (JPEG APP11 segment /
   * PNG caBX chunk / BMFF uuid box), when the caller located one. Used to
   * prove the declared exclusions actually exempt the CREDENTIALS — see the
   * asset-hash guards below. Absent for detached/sidecar verification. */
  manifestRange?: { start: number; length: number }
): C2paVerification {
  // 1. COSE signature over the claim bytes.
  const sigStructure = concatBytes(
    new Uint8Array([0x84, 0x6a]),
    asciiToBytes('Signature1'),
    bstr(m.protectedHeader),
    new Uint8Array([0x40]),
    bstr(m.claimBytes)
  );
  // Tri-state: TRUE proves the claim bytes are exactly what the signer
  // signed; FALSE proves they are not; NULL means this build cannot run the
  // check at all (unsupported alg, unreadable key) — absence of proof in
  // BOTH directions, which the verdict layer must surface as "not checked",
  // never as tamper. Downstream (trustLadder/policyLayer/report) already
  // distinguishes === false from === true; null is the honest middle.
  let signatureValid: boolean | null = null;
  let alg: string | null = null;
  try {
    const headerMap = decode(m.protectedHeader);
    const algId = mapGet(headerMap, 1);
    alg = COSE_ALG_NAMES[algId as number] ?? String(algId ?? 'unknown');
    if (algId === -7) {
      // ES256 — our own files, Leica/Truepic-era foreign files.
      const pub = ecPublicKeyFromCert(m.certDer);
      if (pub) {
        // lowS: false — COSE has no low-S rule (that is a Bitcoin-ism), and
        // real signers ship high-S signatures (truepic-20230212-library.jpg
        // in the c2pa-org public-testfiles does). A high-S malleation still
        // binds the key to the IDENTICAL message, so tamper evidence is
        // unaffected; rejecting it false-reds genuine media.
        signatureValid = p256.verify(m.signature, sha256(sigStructure), pub, { format: 'compact', lowS: false });
      }
    } else if (algId === -37 || algId === -38 || algId === -39) {
      // PS256/PS384/PS512 — RSA-PSS. Adobe's 2022-era files sign this way.
      // The key comes from the light SPKI extractor, NOT the strict chain
      // parser: Adobe signs its certs with RSASSA-PSS, which the strict
      // parser refuses — but here the cert only NAMES the key, and the
      // signature check itself proves possession.
      const key = publicKeyFromCert(m.certDer);
      if (key?.kind === 'rsa') {
        const hashName = algId === -37 ? 'sha256' : algId === -38 ? 'sha384' : 'sha512';
        signatureValid = verifyRsaPss(key, hashName, sigStructure, m.signature);
      }
    }
    // Any other alg (ES384/ES512/EdDSA/…): signatureValid stays null —
    // the report names the alg in checksNotPerformed instead of guessing.
  } catch { signatureValid = null; }

  // 1b. PQ dual signature: ML-DSA-65 over the SAME Sig_structure.
  // The key is taken ONLY from the committed record block (telemetry.pqKey) —
  // never from the strippable unprotected header — and the entry's fingerprint
  // must match it, so a swapped-in foreign PQ signature binds to nothing.
  let pq: PqLayerCheck | null = null;
  const block = m.telemetry ? pqPublicBlockFrom((m.telemetry as Record<string, unknown>).pqKey) : null;
  if (m.pq || block) {
    const keyFingerprintMatches = !!block && pqFingerprint(block.publicKey) === block.fingerprint;
    const signatureValid =
      !!m.pq && !!block && m.pq.fingerprint === block.fingerprint && pqVerify(block.publicKey, sigStructure, m.pq.signature);
    pq = { present: !!m.pq, keyCommitted: !!block, keyFingerprintMatches, signatureValid, custody: PQ_CUSTODY };
  }

  // 2. Asset hash via the hard-binding assertion (hash.data for JPEG/PNG,
  //    c2pa.hash.bmff.v2 for BMFF). Two guards beyond the walk:
  //    the walk proves the hash matches SOME input; the guards prove
  //    the input is the MEDIA. Without them a manifest can declare exclusions
  //    that exempt (almost) the whole file — the hash then commits to a
  //    constant or to nothing and "matches" any media. A file that trips a
  //    guard is NOT proven-tampered: the binding is void, absence of proof.
  let assetHashMatches = false;
  let assetHashFailure: C2paVerification['assetHashFailure'] = null;
  // A binding assertion binds media ONLY when the SIGNED CLAIM references
  // it. A c2pa.hash.* box the claim does not reference could have been
  // attached AFTER signing — self-consistent over arbitrary media —
  // lending that media a false INTACT. An unreferenced binding, a malformed
  // exclusion set, and no binding at all are all the same honest outcome: the
  // credentials commit to nothing → void-binding → UNPROVEN, never tamper.
  const claimAssertionRefs = mapGet(m.claim, 'assertions') as { url?: string }[] | undefined;
  const claimReferencesBinding = (label: string): boolean =>
    Array.isArray(claimAssertionRefs) &&
    claimAssertionRefs.some((r) => typeof r?.url === 'string' && assertionRefLabel(r.url) === label);
  if (m.hashData && m.hashData.alg === 'sha256' && m.hashData.exclusions.length > 0 && claimReferencesBinding('c2pa.hash.data')) {
    // All exclusions are honored — foreign manifests (Leica, Adobe) use
    // several; verifying only the first would false-red genuine media.
    const recomputed = sha256ExcludingRanges(fileBytes, m.hashData.exclusions);
    const walkMatches =
      recomputed !== null &&
      recomputed.length === m.hashData.hash.length &&
      recomputed.every((v, i) => v === m.hashData!.hash[i]);
    // Guard 1: the non-excluded remainder must be non-empty — otherwise the
    // hash input is constant (sha256 of nothing) and binds no media.
    const excludedTotal = m.hashData.exclusions.reduce((n, r) => n + Math.max(0, r.length), 0);
    const remainderNonEmpty = excludedTotal < fileBytes.length;
    // Guard 2: when the manifest's own byte range is known, some exclusion
    // must fully cover it — the exclusion exists to exempt the credentials.
    // Unknown range (detached/legacy callers) skips the guard, never fails it.
    const coversManifest = manifestRange == null
      ? true
      : m.hashData.exclusions.some(
          (r) => r.start <= manifestRange.start && r.start + r.length >= manifestRange.start + manifestRange.length
        );
    if (recomputed === null || !remainderNonEmpty || !coversManifest) {
      // recomputed null = the exclusion set itself is malformed (overlapping /
      // out of bounds) — defective credentials, NOT proven tamper.
      assetHashFailure = 'void-binding';
    } else {
      assetHashMatches = walkMatches;
      if (!walkMatches) assetHashFailure = 'mismatch';
    }
  } else if (m.hashBmff && m.hashBmff.alg === 'sha256' && m.hashBmff.exclusions.length > 0 && claimReferencesBinding('c2pa.hash.bmff.v2')) {
    try {
      const recomputed = hashBmffV2(fileBytes, m.hashBmff.exclusions);
      const walkMatches = recomputed.length === m.hashBmff.hash.length && recomputed.every((v, i) => v === m.hashBmff!.hash[i]);
      // Guards (BMFF shapes of the same attack): at least one root box must
      // contribute to the hash; no mdat (media) box may be excluded; and when
      // the manifest's uuid box is known, it must itself be excluded.
      const rootBoxes = parseRootBoxes(fileBytes);
      const hashedBoxes = rootBoxes.filter((b) => !boxExcluded(fileBytes, b, m.hashBmff!.exclusions));
      const anyHashed = hashedBoxes.length > 0;
      const mdatExempted = rootBoxes.some((b) => b.type === 'mdat' && boxExcluded(fileBytes, b, m.hashBmff!.exclusions));
      const manifestBox = manifestRange == null ? null : rootBoxes.find((b) => b.start === manifestRange.start);
      const manifestExempted = manifestBox == null ? true : boxExcluded(fileBytes, manifestBox, m.hashBmff!.exclusions);
      if (!anyHashed || mdatExempted || !manifestExempted) {
        assetHashFailure = 'void-binding';
      } else {
        assetHashMatches = walkMatches;
        if (!walkMatches) assetHashFailure = 'mismatch';
      }
    } catch {
      // Malformed container — we could not walk it, so we cannot say the bytes
      // changed. UNPROVEN, not proven tamper.
      assetHashMatches = false;
      assetHashFailure = 'void-binding';
    }
  } else {
    // No signed hard binding at all: the claim references
    // no usable c2pa.hash.* assertion — the signature is genuine but commits
    // to NO media bytes. Integrity UNPROVEN; without this guard an attached,
    // self-consistent binding box could lend arbitrary media a false INTACT.
    assetHashFailure = 'void-binding';
  }

  // 3. Claim assertion hashes bind the signed claim to the assertion boxes.
  //    Boxes in the store that the claim does NOT reference are deliberately
  //    NOT a failure here: legitimate third-party
  //    assets carry them, so they are disclosed as unreferenced (see
  //    referencedAssertionLabels) instead of failing closed — a false red
  //    on genuine media is the worse outcome.
  let claimAssertionsMatch = true;
  const refs = mapGet(m.claim, 'assertions') as { url?: string; hash?: Uint8Array }[] | undefined;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (!ref?.url || !ref.hash) { claimAssertionsMatch = false; continue; }
      const label = assertionRefLabel(ref.url);
      const actual = m.assertionHashes[label];
      if (!actual || actual.length !== ref.hash.length || !actual.every((v, i) => v === ref.hash![i])) {
        claimAssertionsMatch = false;
      }
    }
  }

  // 4. Org identity assertion: the assertion's referenced telemetry
  //    hash must equal the claim's own telemetry assertion hash — otherwise
  //    the binding points at nothing. The named org is cross-checked against
  //    the x5chain's TOP certificate subject, read directly from the
  //    protected-header order (leaf-first by construction) — independent of
  //    whether full chain verification can order or validate the certs,
  //    which is reported separately. Unparseable top cert, absent org/CN, or
  //    an org-less assertion → orgMatchesChainTop null = "could not check",
  //    never a silent pass.
  let identity: C2paVerification['identity'] = null;
  if (m.identity) {
    const actual = m.assertionHashes['com.verify.telemetry'];
    let orgMatchesChainTop: boolean | null = null;
    let chainTopName: string | null = null;
    const topDer = m.certChain.length > 1 ? m.certChain[m.certChain.length - 1] : null;
    if (topDer) {
      try {
        const top = parseCertificate(topDer);
        chainTopName = top.subjectOrg ?? top.subjectCN;
      } catch {
        chainTopName = null; // top cert unparseable — cross-check could not run
      }
    }
    orgMatchesChainTop =
      m.identity.org && chainTopName !== null ? chainTopName === m.identity.org : null;
    identity = {
      present: true,
      org: m.identity.org,
      telemetryHashMatches: !!actual && bytesToHex(actual) === m.identity.referencedTelemetryHashHex,
      orgMatchesChainTop,
      chainTopName,
    };
  }

  return { signatureValid, assetHashMatches, assetHashFailure, claimAssertionsMatch, alg, pq, identity };
}

// ---------------------------------------------------------------------------
// c2pa.hash.collection.data validation
// ---------------------------------------------------------------------------

export interface CollectionHashEntryResult {
  uri: string;
  /** 'match' | 'mismatch' | 'missing' — per §15.12.5 failure semantics. */
  status: 'match' | 'mismatch' | 'missing';
}

export interface CollectionHashCheck {
  /** True only when every declared member is present and matches, and the
      presented set is EXACTLY the declared set (§15.12.5's
      assertion.collectionHash.incorrectFileCount otherwise). */
  ok: boolean;
  entries: CollectionHashEntryResult[];
  /** Presented members the declaration doesn't know — set drift, stated. */
  undeclared: string[];
  /** Only sha256 is emitted today; anything else is stated, not guessed. */
  algSupported: boolean;
}

/**
 * Validates a parsed c2pa.hash.collection.data assertion against the
 * actual artifact set: sha256 over ALL bytes of each member, by name.
 * `assets` maps the member URI ('photo.jpg', 'depth.png' …) to its exact
 * bytes. For the photo member the caller presents the CLEAN bytes (the
 * signed file minus the manifest exclusion) — the builder hashes clean
 * bytes because hashing the signed file would be circular.
 */
export function verifyCollectionHash(
  ch: NonNullable<C2paManifest['collectionHash']>,
  assets: { uri: string; bytes: Uint8Array }[]
): CollectionHashCheck {
  const algSupported = ch.alg === 'sha256';
  const byUri = new Map(assets.map((a) => [a.uri, a.bytes]));
  const entries: CollectionHashEntryResult[] = ch.uris.map((u) => {
    const bytes = byUri.get(u.uri);
    if (!bytes) return { uri: u.uri, status: 'missing' as const };
    if (!algSupported) return { uri: u.uri, status: 'mismatch' as const }; // can't confirm — stated as not-matching
    return { uri: u.uri, status: bytesToHex(sha256(bytes)) === u.hashHex ? ('match' as const) : ('mismatch' as const) };
  });
  const declared = new Set(ch.uris.map((u) => u.uri));
  const undeclared = assets.filter((a) => !declared.has(a.uri)).map((a) => a.uri);
  const ok = algSupported && entries.every((e) => e.status === 'match') && undeclared.length === 0;
  return { ok, entries, undeclared, algSupported };
}
