// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Adapter exposing the hand-rolled verifier in src/c2pa/ through the same
 * normalized shape as the upstream engine. It emits no verdicts: the report
 * is flattened into facts, and policyLayer recomposes the verdict from them
 * and asserts parity with the hand-rolled verdict, so drift cannot pass
 * silently.
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

export const HANDROLLED_ENGINE_VERSION = 'handrolled@2026-08-06';

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
  // void-binding reports assetHashMatches=null; normalize it to false so the
  // policy layer composes SIGNATURE_INVALID from the pair.
  r.assetHashMatches =
    r.assetHashFailure === 'void-binding' ? false : report.checks.assetHashMatches;

  // A broken inner Source Kit record signature also yields SIGNATURE_INVALID,
  // and the report exposes no bit for it. When no other fact explains the
  // verdict, that is the cause; surface it as a signature-layer fact.
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

  // Status lines in the `exhibit.` namespace, kept distinct from upstream
  // spec codes so oracle diffs cannot confuse the two.
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
    // SIGNATURE_INVALID with no claim-layer fact means the inner Source Kit
    // record signature failed while the claim layer stayed intact.
    statuses.push({ code: 'exhibit.innerRecordSignatureInvalid', severity: 'failure', explanation: 'hand-rolled pipeline: inner Source Kit record signature failed (claim layer intact)' });
  }
  r.validationStatus = statuses;

  // No C2PA trust-list concept here; the trust axis is the roster resolver,
  // so this is always 'unknown'.
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
