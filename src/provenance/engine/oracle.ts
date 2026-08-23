// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Differential oracle. Runs both engines over the same bytes, composes each
 * side's verdict through the policy layer, and diffs the composed verdict
 * plus the load-bearing facts. Divergences are whitelisted with a written
 * reason in tests/oracle-whitelist.json.
 *
 * Known divergence classes (Binding-Path §6):
 *  - UNSUPPORTED-for-merkle-aux: upstream fails (algorithm.unsupported or a
 *    hard error) where this engine declines to evaluate. Needs a whitelist
 *    entry.
 *  - A-1 binding guard: upstream fails closed with assertion.undeclared;
 *    policy maps both sides to SIGNATURE_INVALID + void-binding, so the
 *    composed verdicts agree while the raw postures differ.
 *  - Trust tiers: the hand-rolled engine has no C2PA trust-list concept
 *    (trustListHit always 'unknown'), upstream may report untrusted. Trust
 *    codes feed the tier ladder, not the verdict.
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
 * Diff one asset's two engine outcomes: verdict, manifestFound, the
 * signature-side and asset-side facts, and the unsupported posture.
 * Exported so the suite can drive it with synthetic facts.
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
  // Fact-level diffs, so a fact flip under an unchanged verdict still
  // surfaces.
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
  // Unsupported posture: one side declined a structure the other evaluated,
  // recorded even when both land on the same verdict.
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
