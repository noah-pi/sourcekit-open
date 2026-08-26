// Source Kit 0.1.0 — proof that travels separately from the media
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Detachable proof — proof that travels separately from the media.
 *
 * Three share modes, in increasing order of disclosure:
 *
 *   hash-only   The source-protection primitive. Proves a capture with this
 *               SHA-256 existed, was signed by this key, and was anchored at
 *               these times — without releasing the media, the record, the
 *               location, or anything else. A journalist can hand this to an
 *               editor as a receipt while the media stays unpublished.
 *
 *   proof-only  The full attestation record + embedded C2PA manifest +
 *               OTS receipts, bound to the media by hash — plus, when the
 *               vault holds them, the v2 chunk-map sidecar for desk-side
 *               range verification (absent for stills and legacy
 *               captures, honestly). A desk can verify every claim except
 *               the pixels, and later match the media to this proof (exact
 *               hash, or pHash recovery — docs/RECOVERY.md).
 *
 *   proof+media The signed file itself (it already embeds everything) —
 *               handled by the existing share flow, with de-identify options.
 *
 * Both JSON formats are deliberately plain and human-readable: a desk editor
 * can open them in any text editor and see exactly what is claimed.
 *
 * FORMAT HISTORY: 'exhibit-proof-bundle/2' adds the optional `stereo`
 * section (stereo-capture artifacts, src/provenance/stereoArtifacts.ts) —
 * per-artifact three-state entries (recorded hash+inline bytes / committed
 * error string / never-recorded declaration) plus the primary-frame hash
 * they pair with. The app has never left the lab: there is NO migration
 * and NO legacy reader. '/1' bundles are rejected at the format gate
 * (proofBundleGate) with the version named; re-export from the vault with
 * a current build. '/2' was then extended ADDITIVELY (0.13.0, Spec §8) with
 * the optional `videoStereo` section (periodic video stereo pairs) — an
 * optional field gated by isVideoStereoBundleSection when present, so no
 * format bump: every prior '/2' bundle still validates, and a '/2' bundle
 * without the field is the same honest absence as before.
 */

import type { AttestationRecord, ChunkMapSidecar } from '../provenance/manifest';
import { isAttestationRecord } from '../provenance/manifest';
import { isStereoBundleSection, isVideoStereoBundleSection, type StereoBundleSection, type VideoStereoBundleSection } from '../provenance/stereoArtifacts';
import { payloadDigest } from './sign';
import { bytesToHex } from './bytes';

export const HASH_CLAIM_FORMAT = 'verify-hash-claim/1';
export const PROOF_BUNDLE_FORMAT = 'exhibit-proof-bundle/2';

export interface HashClaim {
  format: typeof HASH_CLAIM_FORMAT;
  createdAt: string;
  /** SHA-256 of the signed media bytes (hex) — the media itself is NOT included. */
  mediaSha256: string;
  /** SHA-256 of the canonical signed payload — what the signature and the OTS receipts commit to. */
  payloadDigestHex: string;
  /** Device-clock capture time (a claim). */
  capturedAt: string;
  signerFingerprint: string;
  /** Ledger state at share time — pending is honest, not hidden. */
  ots: { digestHex: string; states: Array<'pending' | 'confirmed'>; blockHeights: number[] } | null;
}

export interface ProofBundle {
  format: typeof PROOF_BUNDLE_FORMAT;
  createdAt: string;
  media: { sha256: string; bytes: number; mime: string; kind: string };
  payloadDigestHex: string;
  /** The complete attestation record, including OTS receipts. */
  record: AttestationRecord;
  /** The embedded C2PA manifest segment (base64), when the media carried one. */
  c2paManifestBase64: string | null;
  /**
   * The v2 streamedChunks chunk-map sidecar (WS2 Phase 2), exported from
   * the vault's stored chunk maps so a desk can
   * RANGE-VERIFY the delivery file against the signed v2 roots (localize a
   * truncation/tamper to a chunk index) instead of root-only. ABSENT for
   * stills (zero tracks — structural), for captures whose v2 build
   * degraded, and for bundles shared before this field existed — an absent
   * sidecar is honest, never a failure; root-only verification remains.
   */
  chunkMaps?: ChunkMapSidecar;
  /**
   * Stereo-capture artifacts (format /2, Spec-Camera-Module-0.13 §5): the
   * committed geometry INPUTS — secondary frame + calibration + sync
   * timestamps + metadata inline, raw DNG hash-only — each in an explicit
   * three-state entry. ABSENT when the capture path recorded no stereo
   * artifacts at all (legacy single-lens fallback) — an honest absence,
   * stated by the missing field itself, never a failure.
   */
  stereo?: StereoBundleSection;
  /**
   * VIDEO stereo pairs (format /2 extended additively, Spec §8): the
   * committed periodic-pair entries — secondary frame + calibration each in
   * the same three-state contract, PTS anchors verbatim — plus the native
   * pairsCommitted / pairsMissed / hardwareCost counts (a missed pair is a
   * declared count, never suspicion). ABSENT when no pair cadence ran —
   * same honest-absence rule as `stereo`.
   */
  videoStereo?: VideoStereoBundleSection;
}

export function buildHashClaim(record: AttestationRecord): HashClaim {
  return {
    format: HASH_CLAIM_FORMAT,
    createdAt: new Date().toISOString(),
    mediaSha256: record.asset.sha256,
    payloadDigestHex: bytesToHex(payloadDigest(record)),
    capturedAt: record.capturedAt,
    signerFingerprint: record.signer.fingerprint,
    ots: record.ots
      ? {
          digestHex: record.ots.digestHex,
          states: record.ots.submissions.map((s) => s.state),
          blockHeights: record.ots.submissions.filter((s) => s.blockHeight).map((s) => s.blockHeight!),
        }
      : null,
  };
}

export function buildProofBundle(
  record: AttestationRecord,
  c2paManifestBase64: string | null,
  chunkMaps?: ChunkMapSidecar | null,
  stereo?: StereoBundleSection | null,
  videoStereo?: VideoStereoBundleSection | null,
): ProofBundle {
  return {
    format: PROOF_BUNDLE_FORMAT,
    createdAt: new Date().toISOString(),
    media: {
      sha256: record.asset.sha256,
      bytes: record.asset.bytes,
      mime: record.asset.mime,
      kind: record.asset.kind,
    },
    payloadDigestHex: bytesToHex(payloadDigest(record)),
    record,
    c2paManifestBase64,
    // Honest absence: the field is simply omitted when no maps exist.
    ...(chunkMaps ? { chunkMaps } : {}),
    // Same rule for stereo artifacts: omitted when the capture path had no
    // stereo module output at all; when the module ran, every artifact is
    // accounted for inside the section (three states, no silent absence).
    ...(stereo ? { stereo } : {}),
    ...(videoStereo ? { videoStereo } : {}),
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

export function isHashClaim(x: unknown): x is HashClaim {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    r.format === HASH_CLAIM_FORMAT &&
    typeof r.mediaSha256 === 'string' && HEX64.test(r.mediaSha256) &&
    typeof r.payloadDigestHex === 'string' && HEX64.test(r.payloadDigestHex) &&
    typeof r.capturedAt === 'string' &&
    typeof r.signerFingerprint === 'string' && HEX64.test(r.signerFingerprint)
  );
}

export function isProofBundle(x: unknown): x is ProofBundle {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    r.format === PROOF_BUNDLE_FORMAT &&
    typeof r.payloadDigestHex === 'string' && HEX64.test(r.payloadDigestHex) &&
    isAttestationRecord(r.record) &&
    (r.stereo === undefined || isStereoBundleSection(r.stereo)) &&
    (r.videoStereo === undefined || isVideoStereoBundleSection(r.videoStereo))
  );
}

/**
 * The format gate, with the reason named. Any 'exhibit-proof-bundle/*'
 * version this build does not read is REJECTED — the pre-release lab format
 * has no migration path and no legacy reader; the error says so and names
 * both versions. Non-bundle input is told apart from a wrong-version bundle.
 */
export function proofBundleGate(x: unknown): { ok: true; bundle: ProofBundle } | { ok: false; error: string } {
  if (typeof x !== 'object' || x === null) {
    return { ok: false, error: 'not a JSON object, so not an exhibit proof bundle' };
  }
  const format = (x as Record<string, unknown>).format;
  if (typeof format === 'string' && format.startsWith('exhibit-proof-bundle/') && format !== PROOF_BUNDLE_FORMAT) {
    return {
      ok: false,
      error:
        `unsupported proof bundle format '${format}'; this build reads '${PROOF_BUNDLE_FORMAT}'. ` +
        'The pre-release lab format carries no migration path and no legacy reader: ' +
        're-export the bundle from the vault with a current build.',
    };
  }
  if (!isProofBundle(x)) {
    return {
      ok: false,
      error: `not an exhibit proof bundle: the format gate requires format '${PROOF_BUNDLE_FORMAT}', a valid payload digest, and a well-formed attestation record`,
    };
  }
  return { ok: true, bundle: x };
}

// ---------------------------------------------------------------------------
// Vault index export — CSV for the desk spreadsheet, GeoJSON/KML for the map.
// ---------------------------------------------------------------------------

export interface ExportEntry {
  id: string;
  createdAt: string;
  kind: string;
  sha256: string;
  bytes: number;
  fingerprint: string;
  motionVerdict: string | null;
  lat: number | null;
  lon: number | null;
  locationState: 'present' | 'redacted' | 'unavailable';
  otsState: 'none' | 'pending' | 'confirmed';
  otsBlockHeight: number | null;
  assignment: string | null;
}

/**
 * CSV with formula-injection guards: any cell that a spreadsheet would
 * interpret as a formula (=, +, -, @) is quote-prefixed. Media hashes and
 * labels are attacker-influenceable data — treat them that way everywhere.
 */
export function exportEntriesToCsv(entries: ExportEntry[]): string {
  const esc = (v: string): string => {
    let s = v;
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'id,captured_at,kind,sha256,bytes,signer_fingerprint,motion,lat,lon,location_state,ots_state,ots_block,assignment';
  const rows = entries.map((e) =>
    [
      e.id, e.createdAt, e.kind, e.sha256, String(e.bytes), e.fingerprint,
      e.motionVerdict ?? '', e.lat?.toString() ?? '', e.lon?.toString() ?? '',
      e.locationState, e.otsState, e.otsBlockHeight?.toString() ?? '', e.assignment ?? '',
    ].map(esc).join(',')
  );
  return [header, ...rows].join('\n') + '\n';
}

export function exportEntriesToGeoJson(entries: ExportEntry[]): string {
  const features = entries
    .filter((e) => e.lat !== null && e.lon !== null)
    .map((e) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
      properties: {
        id: e.id, capturedAt: e.createdAt, kind: e.kind, sha256: e.sha256,
        signerFingerprint: e.fingerprint, otsState: e.otsState,
        ...(e.assignment ? { assignment: e.assignment } : {}),
      },
    }));
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2) + '\n';
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function exportEntriesToKml(entries: ExportEntry[]): string {
  const placemarks = entries
    .filter((e) => e.lat !== null && e.lon !== null)
    .map(
      (e) => `    <Placemark>
      <name>${xmlEscape(e.kind)} ${xmlEscape(e.createdAt)}</name>
      <description>sha256: ${xmlEscape(e.sha256)}
signer: ${xmlEscape(e.fingerprint)}${e.assignment ? `
assignment: ${xmlEscape(e.assignment)}` : ''}
anchor: ${e.otsState}${e.otsBlockHeight ? ` #${e.otsBlockHeight}` : ''}</description>
      <Point><coordinates>${e.lon},${e.lat},0</coordinates></Point>
    </Placemark>`
    );
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
${placemarks.join('\n')}
  </Document>
</kml>
`;
}
