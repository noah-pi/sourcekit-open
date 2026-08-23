// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The verdict authority.
 *
 * Engines return normalized facts (NormalizedEngineResult); this module
 * composes them into the verdict codes defined by the archived verifier:
 *
 *   INTACT / CONTENT_MODIFIED / SIGNATURE_INVALID / NO_ATTESTATION /
 *   NOT_JPEG / NOT_BMFF / UNSUPPORTED / UNREADABLE
 *
 * Verdict mapping table (each row is exercised in test-policy-layer.mts):
 * -------------------------------------------------------------------------
 *  # | normalized facts                                            → verdict
 * ---|----------------------------------------------------------------------
 *  1 | engineAvailable = false (unsupportedReason)                 → UNSUPPORTED — the engine could not evaluate at all.
 *  2 | containerRejected = NOT_JPEG / NOT_BMFF                     → NOT_JPEG/NOT_BMFF — container gate, pre-manifest.
 *  3 | manifestFound = false                                       → NO_ATTESTATION — no credentials present.
 *  4 | unreadable = true                                           → UNREADABLE — corrupt file or parse failure.
 *  5 | unsupported = true (and no positive tamper fact)            → UNSUPPORTED — this build's tri-state; upstream has none.
 *    |   classes: algorithm.unsupported, merkle-aux BMFF,
 *    |   assertion.bmffHash.malformed, assertion.boxesHash.unknownBox,
 *    |   unreadable-container/fragmented-MP4 engine errors,
 *    |   engine returned a manifest but no conclusive evaluation (all facts null)
 *  6 | signatureValid = false                                      → SIGNATURE_INVALID — claim/COSE/record signature failed.
 *  7 | claimAssertionsMatch = false                                → SIGNATURE_INVALID — assertion hashes ≠ signed claim.
 *  8 | assetHashFailure = 'void-binding'                           → SIGNATURE_INVALID — A-1 guard: no usable hard binding, so integrity is unproven rather than tampered.
 *  9 | assetHashMatches = false (assetHashFailure = 'mismatch')    → CONTENT_MODIFIED — signature valid, media changed after signing.
 * 10 | signatureValid && claimAssertionsMatch && assetHashMatches  → INTACT — all three must be === true.
 *
 * Evaluation order: rows 1→4, then 6→9, then 5, then the row-10 gate.
 * Positive tamper facts outrank the UNSUPPORTED tri-state, so an unparseable
 * structure alongside a failed rung is reported as tamper, with the
 * unsupported structure still disclosed in the facts.
 *
 * Consume engine outputs only through this layer; callers must not
 * hand-compose verdicts from NormalizedEngineResult fields. resolve.ts is
 * the one no-verdict consumer: it reports engine output verbatim.
 * trustListHit on a non-INTACT result is presentational context only and
 * never upgrades a failed credential.
 *
 * Trust codes (signingCredential.trusted/untrusted, timeStamp.*) are never
 * verdict failures. They feed trustListHit into the trust-tier ladder
 * (unlabeled → unattributed → attested → known hand → named → accessioned)
 * in src/lib/trustLadder.ts. This layer only carries the inputs: engine
 * trustListHit plus the caller's resolver.
 *
 * Parity: for the hand-rolled engine the composed verdict must equal the
 * archived verifier's own verdict; a mismatch throws.
 */

import type { NormalizedEngineResult, TrustListHit } from './upstreamEngine';
import type {
  VerificationReport,
  VerifyOptions,
  VerdictCode,
} from '../../c2pa/verifyAsset';
import type { SignerTrust } from '../../lib/trustProvider';

export type { VerdictCode } from '../../c2pa/verifyAsset';

export interface PolicyResult {
  verdict: VerdictCode;
  /** Which table row produced the verdict (1–10), recorded for audit. */
  mappingRow: number;
  /** One sentence: why this verdict, in the language of the facts. */
  reason: string;
  checksPerformed: string[];
  checksNotPerformed: string[];
  /** Trust-tier inputs, disclosed. */
  trust: {
    trustListHit: TrustListHit;
    /** From the caller's roster resolver (unchanged logic), when supplied. */
    signerTrust: SignerTrust | null;
  };
}

export interface PolicyOptions {
  /** Roster/anchor resolver; same contract as the archived VerifyOptions. */
  trustResolver?: VerifyOptions['trustResolver'];
  /** The archived report, when the hand-rolled engine ran (parity check). */
  handrolledReport?: VerificationReport;
}

function fail(n: NormalizedEngineResult, row: number, verdict: VerdictCode, reason: string, notPerformed: string[]): PolicyResult {
  return {
    verdict, mappingRow: row, reason,
    checksPerformed: [],
    checksNotPerformed: notPerformed,
    trust: { trustListHit: n.trustListHit, signerTrust: null },
  };
}

/** Composes the verdict from normalized engine facts. The only authority. */
export async function policyVerdict(
  n: NormalizedEngineResult,
  opts?: PolicyOptions,
): Promise<PolicyResult> {
  const result = await compose(n, opts);
  // Parity: hand-rolled engine output must compose to the archived verdict
  // on every row. A mismatch is a policy bug and throws.
  if (opts?.handrolledReport && opts.handrolledReport.verdict !== result.verdict) {
    throw new Error(
      `policy-layer parity failure: composed verdict ${result.verdict} ≠ archived verdict ${opts.handrolledReport.verdict} ` +
      `(facts: sig=${n.signatureValid} assertions=${n.claimAssertionsMatch} asset=${n.assetHashMatches}/${n.assetHashFailure} ` +
      `unsupported=${n.unsupported} container=${n.containerRejected} manifestFound=${n.manifestFound})`,
    );
  }
  return result;
}

async function compose(
  n: NormalizedEngineResult,
  opts?: PolicyOptions,
): Promise<PolicyResult> {
  // Row 1 — engine itself unavailable.
  if (!n.engineAvailable) {
    return fail(n, 1, 'UNSUPPORTED',
      `the verification engine could not run (${n.unsupportedReason ?? 'unknown load failure'}) — the asset is UNCHECKED, not condemned`,
      [`everything — engine unavailable: ${n.unsupportedReason ?? 'load failure'}. Not a broken file, not tamper: unchecked.`]);
  }
  // Row 2 — container gate.
  if (n.containerRejected) {
    return fail(n, 2, n.containerRejected,
      n.containerRejected === 'NOT_JPEG'
        ? 'embedded photo attestation requires a JPEG or PNG container'
        : 'embedded attestation requires an MP4/MOV/M4A container',
      ['everything — wrong container for this verification flow']);
  }
  // Row 3 — no manifest.
  if (!n.manifestFound) {
    return fail(n, 3, 'NO_ATTESTATION',
      'no C2PA manifest found — absence of credentials proves nothing either way',
      ['everything — no manifest to verify']);
  }
  // Row 4 — unreadable.
  if (n.unreadable) {
    return fail(n, 4, 'UNREADABLE',
      'the file could not be parsed — corrupt or truncated container',
      n.rawErrors.length > 0 ? n.rawErrors : ['parse failure']);
  }
  // Rows 6–9: positive tamper facts are evaluated before the UNSUPPORTED
  // tri-state, so an unsupported structure alongside a proven failure cannot
  // turn that failure into "unchecked".
  // Row 6 — signature invalid.
  if (n.signatureValid === false) {
    return fail(n, 6, 'SIGNATURE_INVALID',
      'the manifest signature failed — the credentials themselves were tampered with or are malformed',
      n.rawErrors);
  }
  // Row 7 — assertion hashes ≠ claim.
  if (n.claimAssertionsMatch === false) {
    return fail(n, 7, 'SIGNATURE_INVALID',
      'assertion hashes do not match the signed claim — the store was altered after signing',
      n.rawErrors);
  }
  // Row 8 — void binding (A-1): unproven, not proven tamper.
  if (n.assetHashFailure === 'void-binding') {
    return fail(n, 8, 'SIGNATURE_INVALID',
      'the signed claim honors no usable hard binding — the credentials commit to no media bytes, so integrity is UNPROVEN (defective credentials, not proven tamper)',
      ['asset hash binding is VOID — an unreferenced, outside-manifest, or malformed binding proves nothing about the media (A-1 binding guard)']);
  }
  // Row 9 — media changed after signing.
  if (n.assetHashMatches === false) {
    return fail(n, 9, 'CONTENT_MODIFIED',
      'the signature is valid but the media bytes differ from what was signed',
      n.rawErrors);
  }
  // Row 5 — UNSUPPORTED tri-state (upstream has no such verdict). Reached
  // only when no positive tamper fact exists (rows 6–9 above).
  if (n.unsupported) {
    return fail(n, 5, 'UNSUPPORTED',
      `the manifest uses a structure this build cannot check (${n.unsupportedReason ?? 'unsupported structure'}) — not a broken file, not tamper: unchecked`,
      [`everything — ${n.unsupportedReason ?? 'unsupported structure'}. Declining to evaluate is the true statement; "signature invalid" would condemn credentials that were never evaluated.`]);
  }
  // Row 10 gate: INTACT requires positive facts on all three rungs —
  // signature, assertion-store cross-check, and asset hash. A null
  // claimAssertionsMatch means the store was never checked, which composes to
  // the UNSUPPORTED tri-state, not to INTACT.
  if (n.signatureValid !== true || n.claimAssertionsMatch !== true || n.assetHashMatches !== true) {
    return fail(n, 5, 'UNSUPPORTED',
      'the engine produced no conclusive evaluation of this manifest — unchecked, not condemned',
      [`everything conclusive — engine facts incomplete (signatureValid=${n.signatureValid}, claimAssertionsMatch=${n.claimAssertionsMatch}, assetHashMatches=${n.assetHashMatches})`]);
  }
  // Row 10 — everything checked.
  const performed: string[] = [];
  if (n.signatureValid === true) performed.push('manifest signature verified');
  if (n.claimAssertionsMatch === true) performed.push('assertion hashes cross-checked against the signed claim');
  if (n.assetHashMatches === true) performed.push('media re-hashed against the signed hard binding');
  const notPerformed: string[] = [];
  if (n.trustListHit === 'unknown') {
    notPerformed.push('trust-list evaluation not attributable — no caller-pinned anchors (official TL vs frozen ITL undisclosed); the signer is NOT shown as trusted');
  } else if (n.trustListHit === 'none') {
    notPerformed.push('signer is on NEITHER pinned trust list (official TL nor frozen ITL) — valid signature, unattributed signer');
  }

  // Trust-tier inputs: roster resolver plus the engine's list hit.
  let signerTrust: SignerTrust | null = null;
  const fingerprint = signerFingerprintOf(n);
  if (opts?.trustResolver && fingerprint) {
    try {
      signerTrust = await opts.trustResolver({
        fingerprint,
        verifiedAtMs: null,
        orgChain: n.signerChain.length > 0
          ? { linksValid: n.signerChain[0].linksValid ?? false, topSubject: n.signerChain[0].topSubject, issuer: null }
          : null,
      });
    } catch {
      notPerformed.push('signer trust resolution FAILED (resolver threw) — stated, not hidden; treat the signer as unresolved');
    }
  } else if (!opts?.trustResolver) {
    notPerformed.push('signer trust — no resolver supplied; who vouches for this key is UNRESOLVED (never silently green)');
  }

  const result: PolicyResult = {
    verdict: 'INTACT', mappingRow: 10,
    reason: 'signature valid, assertion hashes match the claim, media bytes match the signed binding',
    checksPerformed: performed,
    checksNotPerformed: notPerformed,
    trust: { trustListHit: n.trustListHit, signerTrust },
  };
  return result;
}

function signerFingerprintOf(n: NormalizedEngineResult): string | null {
  const raw = n.raw as VerificationReport | undefined;
  if (raw && typeof raw === 'object' && raw.c2pa && typeof raw.c2pa.signerFingerprint === 'string') {
    return raw.c2pa.signerFingerprint;
  }
  return null;
}
