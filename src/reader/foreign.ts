// Source Kit 0.1.0 — what any C2PA manifest says about itself, read without a record
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * What any C2PA manifest says about itself, read without a Source Kit record.
 *
 * A file from a Pixel, a Leica, Photoshop or any other signer carries no
 * telemetry record, but it does carry a claim generator, a signing
 * certificate, declared actions with times, and sometimes declared metadata
 * with a location. This module reads those and nothing else, so the detail
 * screens can describe a foreign file in the same sections they use for a
 * sealed one.
 *
 * Every value here is declared by the signer. The certificate names who
 * signed; it does not say the name is true. A created action's time is the
 * signer's clock. A location in c2pa.metadata is what the software wrote.
 * The callers keep that register.
 *
 * No React Native imports: this runs in the verification suite as-is.
 */

import type { C2paManifest } from '../../archive/handrolled-verifier/c2pa';
import { parseCertificate } from '../lib/x509';
import { bytesToHex } from '../lib/bytes';
import { sha256 } from '@noble/hashes/sha256';
import { pinnedSignerFor } from '../lib/signerTrustList';

/** The manifest fields this module reads. Structural, so a test can hand
 *  in a plain object. */
export type ForeignManifest = Pick<
  C2paManifest,
  | 'claimGenerator'
  | 'certDer'
  | 'certChain'
  | 'certChainLength'
  | 'actions'
  | 'c2paMetadata'
  | 'assetType'
  | 'ingredients'
  | 'timestampTokens'
  | 'manifestCount'
  | 'manifestLabel'
  | 'referencedAssertionLabels'
  | 'trainingMining'
  | 'hashData'
  | 'hashBmff'
  | 'claimVersion'
>;

export interface ForeignSigner {
  /** The certificate's common name, when it has one. */
  name: string | null;
  /** The certificate's organization, when it has one. */
  org: string | null;
  issuer: string | null;
  issuerOrg: string | null;
  validFromIso: string | null;
  validUntilIso: string | null;
  /** 1 means a bare self-signed leaf. */
  chainLength: number;
  /** The published anchor the chain reaches, when it reaches one. Whether
   *  the links between hold is the verifier's finding, not this one. */
  anchor: { name: string } | null;
}

export interface ForeignFacts {
  /** "Adobe Photoshop 25.0" from "Adobe Photoshop/25.0 (Windows)". */
  generator: string | null;
  signer: ForeignSigner | null;
  /** The declared creation time, ISO, from a c2pa.created action or
   *  declared metadata. The signer's clock. */
  createdAt: string | null;
  /** A declared coordinate from c2pa.metadata, when the software wrote one. */
  location: { lat: number; lon: number } | null;
  /** The digest the signature covers, hex, for either binding. */
  signedDigestHex: string | null;
  assertions: string[];
  /** Countersignatures present. Presence, not validity. */
  timestampTokens: number;
  manifestCount: number;
  manifestLabel: string;
  claimVersion: 1 | 2;
  assetTypes: string[];
  ingredients: { title: string | null; relationship: string | null; format: string | null }[];
  /** Top-level scalar entries of c2pa.metadata, in declaration order. */
  metadata: [key: string, value: string][];
  trainingMining: [use: string, stance: string][];
}

export function readForeignManifest(m: ForeignManifest): ForeignFacts {
  return {
    generator: humanGenerator(m.claimGenerator),
    signer: readSigner(m.certDer, m.certChainLength, m.certChain),
    createdAt: declaredCreatedAt(m),
    location: declaredLocation(m.c2paMetadata?.data ?? null),
    signedDigestHex: m.hashData ? bytesToHex(m.hashData.hash) : m.hashBmff ? bytesToHex(m.hashBmff.hash) : null,
    assertions: [...m.referencedAssertionLabels],
    timestampTokens: m.timestampTokens.length,
    manifestCount: m.manifestCount,
    manifestLabel: m.manifestLabel,
    claimVersion: m.claimVersion,
    assetTypes: m.assetType?.types ?? [],
    ingredients: m.ingredients.map((i) => ({
      title: i.title ?? null,
      relationship: i.relationship ?? null,
      format: i.format ?? null,
    })),
    metadata: scalarEntries(m.c2paMetadata?.data ?? null),
    trainingMining: m.trainingMining ? Object.entries(m.trainingMining.entries) : [],
  };
}

/**
 * "Adobe Photoshop/25.0 (Windows)" becomes "Adobe Photoshop 25.0". The
 * spec's form is name/version with an optional parenthetical; the slash is
 * a separator, not part of the name, and the platform note is noise on a
 * line that names the maker.
 */
export function humanGenerator(g: string | null): string | null {
  if (!g) return null;
  const bare = g.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const slash = bare.indexOf('/');
  if (slash < 0) return bare || null;
  const name = bare.slice(0, slash).trim();
  const version = bare.slice(slash + 1).trim();
  return [name, version].filter(Boolean).join(' ') || null;
}

function readSigner(der: Uint8Array, chainLength: number, chain: Uint8Array[]): ForeignSigner | null {
  if (!der || der.length === 0) return null;
  try {
    const c = parseCertificate(der);
    const iso = (ms: number) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
    return {
      name: c.subjectCN,
      org: c.subjectOrg,
      issuer: c.issuerCN,
      issuerOrg: c.issuerOrg,
      validFromIso: iso(c.notBeforeMs),
      validUntilIso: iso(c.notAfterMs),
      chainLength: Math.max(1, chainLength),
      anchor: (() => { const a = pinnedSignerFor((chain ?? []).map((c) => bytesToHex(sha256(c)))); return a ? { name: a.name } : null; })(),
    };
  } catch {
    // A certificate this parser cannot read is absence, not evidence.
    return null;
  }
}

/**
 * The created action's `when` first: it is the one moment a signer states
 * on purpose. Declared metadata's create date is the fallback.
 */
function declaredCreatedAt(m: ForeignManifest): string | null {
  const created = m.actions?.list.find((a) => /c2pa\.created$/.test(a.action) && a.when);
  if (created?.when) return created.when;
  const d = m.c2paMetadata?.data;
  if (d) {
    for (const k of ['xmp:CreateDate', 'exif:DateTimeOriginal', 'photoshop:DateCreated']) {
      const v = d[k];
      if (typeof v === 'string' && v) return v;
    }
  }
  return null;
}

/**
 * exif:GPSLatitude in JSON-LD comes in three shapes in the wild: a decimal
 * number, a decimal string, or the XMP form "48,12.34N" / "48,12,20.4N".
 * A sign may also ride in a separate exif:GPSLatitudeRef. Anything that
 * does not parse cleanly to a coordinate in range is absent.
 */
export function declaredLocation(d: Record<string, unknown> | null): { lat: number; lon: number } | null {
  if (!d) return null;
  const lat = coordinate(d['exif:GPSLatitude'], d['exif:GPSLatitudeRef'], 90);
  const lon = coordinate(d['exif:GPSLongitude'], d['exif:GPSLongitudeRef'], 180);
  if (lat == null || lon == null) return null;
  return { lat, lon };
}

function coordinate(raw: unknown, ref: unknown, limit: number): number | null {
  let value: number | null = null;
  let hemisphere: string | null = typeof ref === 'string' ? ref.trim().toUpperCase() : null;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    const tail = s.slice(-1).toUpperCase();
    const body = /[NSEW]/.test(tail) ? s.slice(0, -1) : s;
    if (/[NSEW]/.test(tail)) hemisphere = tail;
    const parts = body.split(',').map((p) => Number(p.trim()));
    if (parts.some((p) => !Number.isFinite(p))) return null;
    if (parts.length === 1) value = parts[0];
    else if (parts.length === 2) value = parts[0] + parts[1] / 60;
    else if (parts.length === 3) value = parts[0] + parts[1] / 60 + parts[2] / 3600;
    else return null;
  }
  if (value == null || !Number.isFinite(value)) return null;
  if (hemisphere === 'S' || hemisphere === 'W') value = -Math.abs(value);
  if (Math.abs(value) > limit) return null;
  return value;
}

function scalarEntries(d: Record<string, unknown> | null): [string, string][] {
  if (!d) return [];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith('@')) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out.push([k, String(v)]);
  }
  return out;
}
