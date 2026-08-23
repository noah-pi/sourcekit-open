// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Differential oracle.
 *
 * Runs BOTH engines over the same bytes, composes each side's verdict
 * through the policy layer (the only verdict authority), and diffs the
 * composed verdict plus the load-bearing facts. It never decides which side
 * is right — it REPORTS. Divergences are investigated or whitelisted with a
 * written reason (tests/oracle-whitelist.json); they are never silently
 * absorbed.
 *
 * Known intentional divergence CLASSES (Binding-Path §6, ):
 *  - UNSUPPORTED-for-merkle-aux: upstream fails (algorithm.unsupported /
 *    hard error) where we decline to evaluate. Whitelist entry required.
 *  - A-1 binding guard: upstream fails closed with assertion.undeclared —
 *    our policy maps BOTH to SIGNATURE_INVALID + void-binding, so the
 *    composed verdicts agree even though the engines' raw postures differ.
 *  - Trust tiers: the hand-rolled engine has no C2PA trust-list concept
 *    (trustListHit always 'unknown'); upstream may report untrusted against
 *    its built-in list. Verdicts are unaffected — trust codes are inputs
 *    to OUR tier ladder, never verdict failures.
 */

import { readUpstreamAsset, type NormalizedEngineResult } from './upstreamEngine';
import { readHandrolledPhotoAsset, readHandrolledVideoAsset } from './handrolledEngine';
import { policyVerdict, type PolicyResult } from './policyLayer';
import type { VerifyOptions } from '../../c2pa/verifyAsset';

export interface OracleDivergence {
  /** What differed: 'verdict' | 'manifestFound' | 'signatureFacts' | 'assetHashFacts' | 'unsupportedPosture'. */
  aspect: string;
  handrolled: string;
  upstream: string;
}

export interface OracleResult {
  agree: boolean;
  handrolled: { normalized: NormalizedEngineResult; policy: PolicyResult };
  upstream: { normalized: NormalizedEngineResult; policy: PolicyResult };
  divergences: OracleDivergence[];
}

function factsSummary(n: NormalizedEngineResult): string {
  return `sig=${n.signatureValid} assertions=${n.claimAssertionsMatch} asset=${n.assetHashMatches}/${n.assetHashFailure} unsupported=${n.unsupported}`;
}

/**
 * Diff one asset's two engine outcomes — verdict, manifestFound, the
 * signature-side and asset-side FACTS, and the unsupported posture.
 * Exported so the suite can exercise the diff with synthetic facts (an
 * assertion-check flip must surface even when composed verdicts agree).
 */
export function diffOutcomes(
  hand: NormalizedEngineResult,
  handPolicy: PolicyResult,
  upNormalized: NormalizedEngineResult,
  upPolicy: PolicyResult,
): OracleDivergence[] {
  const divergences: OracleDivergence[] = [];
  if (handPolicy.verdict !== upPolicy.verdict) {
    divergences.push({
      aspect: 'verdict',
      handrolled: handPolicy.verdict,
      upstream: upPolicy.verdict,
    });
  }
  if (hand.manifestFound !== upNormalized.manifestFound) {
    divergences.push({
      aspect: 'manifestFound',
      handrolled: String(hand.manifestFound),
      upstream: `${upNormalized.manifestFound} (${upNormalized.rawErrors.join('; ') || 'no errors'})`,
    });
  }
  // Fact-level diffs (without them, a fact flip with an unchanged verdict
  // would produce NO divergence anywhere): signature-side facts and
  // asset-side facts each diff whenever the engines disagree, even when the
  // composed verdicts happen to agree.
  const sigFacts = (n: NormalizedEngineResult) => `sig=${n.signatureValid} assertions=${n.claimAssertionsMatch}`;
  const assetFacts = (n: NormalizedEngineResult) => `asset=${n.assetHashMatches}/${n.assetHashFailure}`;
  if (sigFacts(hand) !== sigFacts(upNormalized)) {
    divergences.push({
      aspect: 'signatureFacts',
      handrolled: sigFacts(hand),
      upstream: sigFacts(upNormalized),
    });
  }
  if (assetFacts(hand) !== assetFacts(upNormalized)) {
    divergences.push({
      aspect: 'assetHashFacts',
      handrolled: assetFacts(hand),
      upstream: assetFacts(upNormalized),
    });
  }
  // UNSUPPORTED posture: one side declined a structure the other evaluated
  // (or failed). Verdict-level diffs are caught above; this records the
  // postural difference even when both sides land on the same verdict.
  if (hand.unsupported !== upNormalized.unsupported) {
    divergences.push({
      aspect: 'unsupportedPosture',
      handrolled: hand.unsupportedReason ?? String(hand.unsupported),
      upstream: upNormalized.unsupportedReason ?? String(upNormalized.unsupported),
    });
  }
  return divergences;
}

/** Run both engines over one asset and diff the composed outcomes. */
export async function oracleVerify(
  bytes: Uint8Array,
  flow: 'photo' | 'video',
  opts?: VerifyOptions,
): Promise<OracleResult> {
  const hand = flow === 'photo'
    ? await readHandrolledPhotoAsset(bytes, opts)
    : await readHandrolledVideoAsset(bytes, opts);
  const handPolicy = await policyVerdict(hand.normalized, {
    trustResolver: opts?.trustResolver,
    handrolledReport: hand.report, // parity assertion: composed == archived verdict
  });

  const upNormalized = await readUpstreamAsset(bytes, flow);
  const upPolicy = await policyVerdict(upNormalized, { trustResolver: opts?.trustResolver });

  const divergences = diffOutcomes(hand.normalized, handPolicy, upNormalized, upPolicy);
  return {
    agree: divergences.length === 0,
    handrolled: { normalized: hand.normalized, policy: handPolicy },
    upstream: { normalized: upNormalized, policy: upPolicy },
    divergences,
  };
}
