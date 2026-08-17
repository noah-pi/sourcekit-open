/**
 * @exhibit/reader — M0 card model.
 *
 * The Reader's religion: the camera commits, the Reader measures, the human
 * concludes. A check never produces a verdict; it produces a GAP between a
 * prediction (what the committed evidence says should hold) and a
 * measurement (what this Reader observed), with an error bound, and an
 * interpretation of what that gap is CONSISTENT WITH — never what it proves.
 *
 * Vocabulary law, enforced here and in interpret/cards.ts:
 *   - no fused scores, anywhere;
 *   - no verdict words in finding position (verified / authentic / trusted /
 *     proven / real / secure / guaranteed are banned from findings);
 *   - a check that could not run renders as a card with a stated reason,
 *     never as an absence.
 *
 * Pure types — no React, no DOM, no RN. Platform-agnostic by construction.
 */

/**
 * The five honest states of one check.
 *
 *   agrees          the gap sits inside the stated error band — the
 *                   measurement is consistent with the prediction
 *   diverges        the gap sits OUTSIDE the band — a finding, stated
 *                   plainly, still never a verdict on the exhibit
 *   insufficient    the check ran but the evidence at hand cannot decide
 *                   either way (absence of proof is neutral, said out loud)
 *   not-run         the check could not run at all — the reason is part of
 *                   the card, never hidden
 *   not-applicable  the check is structurally unavailable for this exhibit
 *                   (e.g. hardware attestation on a de-identified copy)
 */
export type CheckState = 'agrees' | 'diverges' | 'insufficient' | 'not-run' | 'not-applicable';

/**
 * The claims a check can bear on. Fixed and small on purpose: the agreement
 * matrix crosses checks against these and nothing else.
 */
export type Claim = 'time' | 'place' | 'device' | 'scene';

export const CLAIMS: readonly Claim[] = ['time', 'place', 'device', 'scene'];

/**
 * One evidence card — the unit the human reads.
 *
 * Grammar (enforced by interpret/cards.ts):
 *   - state 'agrees' or 'diverges'  → prediction, measurement, gap AND
 *     interpretation are all required;
 *   - state 'insufficient' or 'not-run' → gap and interpretation carry the
 *     stated reason;
 *   - 'not-applicable' carries the reason in interpretation.
 */
export interface EvidenceCard {
  /** Stable, namespaced id — e.g. 'custody.seal', 'coherence.epipolar'. */
  id: string;
  /** The check's name, not its outcome. */
  title: string;
  state: CheckState;
  /** What the committed evidence says should hold. */
  prediction: string;
  /** What this Reader observed, with its number when there is one. */
  measurement: string;
  /** prediction − measurement, with the error band; or the stated reason. */
  gap: string;
  /** What the gap is CONSISTENT WITH. Never what it proves. */
  interpretation: string;
  /**
   * The one permitted numeric display: a value on a stated band, in stated
   * units. Never a score — a position.
   */
  gauge?: { value: number; band: [number, number]; units: string };
  /**
   * Distribution data for a strip widget (p10 / median / p90) — explicitly
   * NOT a progress bar: there is no "100%", and a distribution hugging its
   * own end is suspicious, not good. A null p10 means the underlying
   * evidence does not carry that percentile — an honest absence in the
   * data, rendered as a gap in the strip, never interpolated.
   */
  strip?: { p10: number | null; median: number; p90: number; units: string };
  /** "Read ▸ …" — how the measurement was made, for the method line. */
  method?: string;
  /** "Audit ▸ …" — where the raw material behind the measurement lives. */
  audit?: string;
}

/**
 * One rung of the custody ladder. A rung is a projection of checks already
 * performed by verify-core — it computes no new cryptography and fuses
 * nothing into a score.
 */
export interface RungResult {
  /** 1-based position on the ladder. */
  rung: number;
  /** The rung's name, not its status. */
  title: string;
  state: CheckState;
  /**
   * One honest clause naming WHAT was compared or WHY the rung did not run
   * or could not decide. Never a verdict word.
   */
  detail: string;
  /** Optional checkable rows (fingerprints, digests, counts) the UI lists. */
  rows?: { label: string; value: string }[];
}

/**
 * checks × claims — which check bears on which claim, and how it landed.
 * Sparse: a cell exists only where the check actually speaks to the claim.
 */
export interface AgreementMatrix {
  checks: string[];
  claims: Claim[];
  cells: Record<string, Partial<Record<Claim, CheckState>>>;
}
