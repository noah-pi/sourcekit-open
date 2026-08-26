// Source Kit 0.1.0 — Reader card model
/**
 * Reader card model. A check emits a prediction, a measurement, the gap
 * between them with an error bound, and what that gap is consistent with.
 *
 * Vocabulary rules, enforced in interpret/cards.ts: no fused scores; no
 * verdict words (verified, authentic, trusted, proven, real, secure,
 * guaranteed) in finding position; a check that could not run renders as a
 * card with a stated reason rather than being omitted.
 *
 * Pure types: no React, no DOM, no RN.
 */

/**
 * The five states of one check.
 *
 *   agrees          gap sits inside the stated error band
 *   diverges        gap sits outside the band
 *   insufficient    check ran, evidence cannot decide either way
 *   not-run         check could not run; the reason goes on the card
 *   not-applicable  check is structurally unavailable for this exhibit
 *                   (e.g. hardware attestation on a de-identified copy)
 */
export type CheckState = 'agrees' | 'diverges' | 'insufficient' | 'not-run' | 'not-applicable';

/**
 * The claims a check can bear on. The agreement matrix crosses checks
 * against these and nothing else.
 */
export type Claim = 'time' | 'place' | 'device' | 'scene';

export const CLAIMS: readonly Claim[] = ['time', 'place', 'device', 'scene'];

/**
 * One evidence card.
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
  /** What the gap is consistent with, not what it proves. */
  interpretation: string;
  /** A value on a stated band, in stated units. A position, not a score. */
  gauge?: { value: number; band: [number, number]; units: string };
  /**
   * Distribution for the strip widget (p10 / median / p90), not a progress
   * bar. A null p10 means the evidence carries no such percentile; the
   * strip renders a gap there rather than interpolating.
   */
  strip?: { p10: number | null; median: number; p90: number; units: string };
  /** "Read ▸ …" — how the measurement was made, for the method line. */
  method?: string;
  /** "Audit ▸ …" — where the raw material behind the measurement lives. */
  audit?: string;
}

/**
 * One rung of the custody ladder: a projection of checks already performed
 * by verify-core. Computes no new cryptography.
 */
export interface RungResult {
  /** 1-based position on the ladder. */
  rung: number;
  /** The rung's name, not its status. */
  title: string;
  state: CheckState;
  /**
   * One clause naming what was compared, or why the rung did not run or
   * could not decide. No verdict words.
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
