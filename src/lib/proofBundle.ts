// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Detachable proof — proof that travels separately from the media.
 *
 * Three share modes, in increasing order of disclosure:
 *
 *   hash-only   Media SHA-256, payload digest, signer fingerprint and anchor
 *               state. Proves the capture existed and was signed without
 *               releasing media, record, or location.
 *
 *   proof-only  Attestation record + embedded C2PA manifest + OTS receipts,
 *               bound to the media by hash, plus the v2 chunk-map sidecar
 *               when the vault holds it. Verifies every claim except the
 *               pixels; media is matched to the proof afterwards by exact
 *               hash or pHash recovery (docs/RECOVERY.md).
 *
 *   proof+media The signed file itself, through the share flow with
 *               de-identify options.
 *
 * Both JSON formats are plain text a desk editor can read directly. Bundles
 * whose 'exhibit-proof-bundle/*' version this build does not read are
 * rejected at proofBundleGate; there is no migration path or legacy reader.
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
   * v2 streamedChunks chunk-map sidecar, exported from the vault's stored
   * chunk maps, so a desk can range-verify the delivery file against the
   * signed v2 roots and localize a truncation to a chunk index. Omitted for
   * stills (zero tracks) and when the v2 build degraded; root-only
   * verification still applies.
   */
  chunkMaps?: ChunkMapSidecar;
  /**
   * Stereo-capture artifacts (Spec-Camera-Module-0.13 §5): the committed
   * geometry inputs — secondary frame, calibration, sync timestamps, metadata
   * inline, raw DNG hash-only — each as an explicit three-state entry.
   * Omitted when the capture path recorded no stereo artifacts.
   */
  stereo?: StereoBundleSection;
  /**
   * Video stereo pairs (Spec §8): committed periodic-pair entries — secondary
   * frame and calibration under the same three-state contract, PTS anchors
   * verbatim — plus the native pairsCommitted / pairsMissed / hardwareCost
   * counts. Omitted when no pair cadence ran.
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
    // Field omitted when no maps exist.
    ...(chunkMaps ? { chunkMaps } : {}),
    // Same for stereo artifacts: omitted when the capture path produced no
    // stereo module output. When it ran, every artifact is accounted for
    // inside the section by one of the three states.
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
 * Format gate. Any 'exhibit-proof-bundle/*' version this build does not read
 * is rejected with both versions named; non-bundle input gets its own error.
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
}

/**
 * CSV with formula-injection guards: any cell a spreadsheet would read as a
 * formula (=, +, -, @) is quote-prefixed. Hashes and labels are
 * attacker-influenceable data.
 */
export function exportEntriesToCsv(entries: ExportEntry[]): string {
  const esc = (v: string): string => {
    let s = v;
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'id,captured_at,kind,sha256,bytes,signer_fingerprint,motion,lat,lon,location_state,ots_state,ots_block';
  const rows = entries.map((e) =>
    [
      e.id, e.createdAt, e.kind, e.sha256, String(e.bytes), e.fingerprint,
      e.motionVerdict ?? '', e.lat?.toString() ?? '', e.lon?.toString() ?? '',
      e.locationState, e.otsState, e.otsBlockHeight?.toString() ?? '',
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
signer: ${xmlEscape(e.fingerprint)}
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
