// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * WS3 hand-rolled engine — a thin ADAPTER exposing the archived verifier
 * (src/c2pa/, moved not deleted) through the same
 * normalized shape as the upstream engine. Refactor only: the archived code
 * is called as-is, with zero behavior change; every existing suite keeps
 * exercising it directly.
 *
 * No verdicts are emitted here either. The archived verifier's rich report
 * (which DOES contain our canonical verdict) is flattened into normalized
 * FACTS; policyLayer re-composes the verdict from those facts and asserts
 * parity with the archived verdict — so a drift between the archive and the
 * policy layer cannot pass silently.
 */

import {
  verifyPhotoBytes,
  verifyVideoBytes,
  type VerificationReport,
  type VerifyOptions,
} from '../../c2pa/verifyAsset';
import {
  baseResultLike,
  type NormalizedEngineResult,
} from './upstreamEngine';

export const HANDROLLED_ENGINE_VERSION = 'archived@WS3-2026-08-06';

/** Facts the handrolled pipeline guarantees, mapped from its report. */
function normalizeReport(report: VerificationReport): NormalizedEngineResult {
  const r = baseResultLike('handrolled', HANDROLLED_ENGINE_VERSION);
  r.raw = report;
  const v = report.verdict;

  if (v === 'NOT_JPEG' || v === 'NOT_BMFF') {
    r.containerRejected = v;
    return r;
  }
  r.manifestFound = report.checks.manifestFound;
  if (!r.manifestFound) return r; // NO_ATTESTATION — nothing more to say

  if (v === 'UNSUPPORTED') {
    r.unsupported = true;
    r.unsupportedReason = report.checksNotPerformed[0] ?? 'structure this build cannot verify';
    return r;
  }
  if (v === 'UNREADABLE') {
    r.unreadable = true;
    return r;
  }

  r.signatureValid = report.checks.signatureValid;
  r.claimAssertionsMatch = report.c2pa ? report.c2pa.claimAssertionsMatch : null;
  r.assetHashFailure = report.c2pa?.assetHashFailure ?? null;
  // void-binding → UNPROVEN (null in the report) is normalized to
  // assetHashMatches=false + assetHashFailure='void-binding' — the policy
  // layer composes SIGNATURE_INVALID from the pair, exactly like the archive.
  r.assetHashMatches =
    r.assetHashFailure === 'void-binding' ? false : report.checks.assetHashMatches;

  // The archive also fails SIGNATURE_INVALID when the INNER Source Kit record's
  // signature is broken (defense in depth) with the claim layer intact. The
  // report doesn't expose that bit directly; when the verdict says
  // SIGNATURE_INVALID and no other fact explains it, that is the cause —
  // surface it as a signature-layer fact so the policy layer composes the
  // same verdict (parity, never drift).
  if (v === 'SIGNATURE_INVALID' && r.signatureValid !== false
      && r.claimAssertionsMatch !== false && r.assetHashFailure !== 'void-binding') {
    r.signatureValid = false;
  }

  if (report.c2pa) {
    r.activeClaim = {
      label: null,
      claimGenerator: report.c2pa.generator,
      title: null,
      format: null,
      instanceId: null,
      claimVersion: null,
      ingredients: [],
      signature: report.c2pa.alg
        ? { alg: report.c2pa.alg, issuer: null, commonName: null, time: null, certChainLength: report.c2pa.certChain?.length ?? 0 }
        : null,
    };
    r.manifests = r.activeClaim ? [r.activeClaim] : [];
    if (report.c2pa.certChain) {
      r.signerChain = [{
        length: report.c2pa.certChain.length,
        linksValid: report.c2pa.certChain.linksValid,
        topSubject: report.c2pa.certChain.topSubject,
      }];
    }
  }

  // Status lines in OUR namespace — the archived engine's vocabulary, kept
  // distinct from upstream spec codes so oracle diffs never confuse the two.
  const statuses: NormalizedEngineResult['validationStatus'] = [];
  if (r.signatureValid === false) {
    statuses.push({ code: 'exhibit.signatureInvalid', severity: 'failure', explanation: 'hand-rolled pipeline: COSE/record signature failed' });
  }
  if (r.claimAssertionsMatch === false) {
    statuses.push({ code: 'exhibit.assertionHashMismatch', severity: 'failure', explanation: 'hand-rolled pipeline: assertion hashes do not match the signed claim' });
  }
  if (r.assetHashFailure === 'void-binding') {
    statuses.push({ code: 'exhibit.voidBinding', severity: 'failure', explanation: 'A-1: the signed claim honors no usable hard binding — integrity UNPROVEN' });
  } else if (r.assetHashMatches === false) {
    statuses.push({ code: 'exhibit.assetHashMismatch', severity: 'failure', explanation: 'hand-rolled pipeline: media bytes differ from the signed hash' });
  }
  if (v === 'SIGNATURE_INVALID' && statuses.length === 0) {
    // Verdict SIGNATURE_INVALID with no claim-layer fact → the INNER Source Kit
    // record's signature failed (defense in depth, claim layer intact).
    statuses.push({ code: 'exhibit.innerRecordSignatureInvalid', severity: 'failure', explanation: 'hand-rolled pipeline: inner Source Kit record signature failed (claim layer intact)' });
  }
  r.validationStatus = statuses;

  // The hand-rolled verifier has NO C2PA trust-list concept (its trust axis
  // is the roster resolver — policy-layer input, untouched). It can never
  // claim official/interim: always 'unknown'.
  r.trustListHit = 'unknown';
  return r;
}

/** Photo flow (JPEG/PNG) — mirrors verifyPhotoBytes. */
export async function readHandrolledPhotoAsset(
  bytes: Uint8Array,
  opts?: VerifyOptions,
): Promise<{ normalized: NormalizedEngineResult; report: VerificationReport }> {
  const report = await verifyPhotoBytes(bytes, opts);
  return { normalized: normalizeReport(report), report };
}

/** Video flow (BMFF) — mirrors verifyVideoBytes. */
export async function readHandrolledVideoAsset(
  bytes: Uint8Array,
  opts?: VerifyOptions,
): Promise<{ normalized: NormalizedEngineResult; report: VerificationReport }> {
  const report = await verifyVideoBytes(bytes, opts);
  return { normalized: normalizeReport(report), report };
}
