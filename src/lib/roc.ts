// Source Kit 0.1.0 — Corpus and ROC tooling
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Corpus and ROC tooling. Doc 2's rule: no UI signal without characterized
 * error rates, measured on a labeled corpus of genuine captures and red-team
 * re-photos.
 *
 * The math here:
 *   - sweep a threshold over labeled scores → ROC points (TPR/FPR)
 *   - AUC by trapezoid
 *   - the operating point at a target max FPR
 *
 * The corpus is data: JSONL rows of {id, label, scores} produced by
 * tools/rephoto-corpus. Labels are 'positive' (screen re-photo) or
 * 'negative' (natural capture).
 *
 * RocReport requires the corpus manifest (sizes, sources, collection dates).
 */

export type CorpusLabel = 'positive' | 'negative';

export interface LabeledScore {
  id: string;
  label: CorpusLabel;
  /** Higher means more signal (e.g. banding SNR in dB). */
  score: number;
}

export interface RocPoint {
  threshold: number;
  truePositiveRate: number;
  falsePositiveRate: number;
}

export interface RocReport {
  signal: string;
  corpus: {
    positives: number;
    negatives: number;
    /** Free-text provenance: where the corpus came from, when collected. */
    manifest: string;
  };
  auc: number;
  points: RocPoint[];
}

/** Sweep thresholds across the observed score range. */
export function rocCurve(scores: LabeledScore[]): RocPoint[] {
  const pos = scores.filter((s) => s.label === 'positive');
  const neg = scores.filter((s) => s.label === 'negative');
  if (pos.length === 0 || neg.length === 0) return [];
  // Candidate thresholds: every observed score (firing = score >= threshold).
  const thresholds = [...new Set(scores.map((s) => s.score))].sort((a, b) => a - b);
  const points: RocPoint[] = [];
  for (const t of thresholds) {
    const tp = pos.filter((s) => s.score >= t).length;
    const fp = neg.filter((s) => s.score >= t).length;
    points.push({ threshold: t, truePositiveRate: tp / pos.length, falsePositiveRate: fp / neg.length });
  }
  // Anchor the curve at (0,0): a threshold above every score fires on nothing.
  points.push({ threshold: thresholds[thresholds.length - 1] + 1, truePositiveRate: 0, falsePositiveRate: 0 });
  return points.sort((a, b) => a.falsePositiveRate - b.falsePositiveRate);
}

/** Trapezoid AUC over FPR-sorted points. 1.0 = perfect, 0.5 = coin flip. */
export function auc(points: RocPoint[]): number {
  if (points.length < 2) return 0;
  const sorted = [...points].sort((a, b) => a.falsePositiveRate - b.falsePositiveRate);
  let area = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dx = sorted[i].falsePositiveRate - sorted[i - 1].falsePositiveRate;
    const dy = (sorted[i].truePositiveRate + sorted[i - 1].truePositiveRate) / 2;
    area += dx * dy;
  }
  return area;
}

/**
 * The operating point for a stated maximum false-positive rate: the
 * highest-recall threshold whose FPR does not exceed `maxFpr`. Returns null
 * when no threshold satisfies the constraint.
 */
export function operatingPoint(points: RocPoint[], maxFpr: number): RocPoint | null {
  const feasible = points.filter((p) => p.falsePositiveRate <= maxFpr);
  if (feasible.length === 0) return null;
  return feasible.reduce((best, p) => (p.truePositiveRate > best.truePositiveRate ? p : best));
}

export function buildRocReport(signal: string, scores: LabeledScore[], manifest: string): RocReport {
  const points = rocCurve(scores);
  return {
    signal,
    corpus: {
      positives: scores.filter((s) => s.label === 'positive').length,
      negatives: scores.filter((s) => s.label === 'negative').length,
      manifest,
    },
    auc: auc(points),
    points,
  };
}
