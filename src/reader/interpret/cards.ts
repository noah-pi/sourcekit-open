/**
 * Card grammar enforcement and the agreement matrix.
 *
 * makeCard is the only way a card enters the Reader, and it refuses two
 * shapes:
 *
 *   1. a finding without its full clause: an 'agrees'/'diverges' card
 *      missing prediction, measurement, gap, or interpretation throws;
 *   2. a banned verdict word in finding position, scanned in titles and
 *      interpretations.
 *
 * A check that could not run is a card with a stated reason. makeNotRun /
 * makeInsufficient / makeNotApplicable make that reason a required argument.
 */

import type { AgreementMatrix, CheckState, Claim, EvidenceCard } from '../types';

/**
 * Verdict words banned from finding position. Matched lowercase on word
 * boundaries, so "unverified" and "mistrusted" trip it too.
 */
const BANNED_FINDING_WORDS = [
  'verified', 'authentic', 'trusted', 'proven', 'real', 'secure', 'guaranteed',
];

const BANNED_RE = new RegExp(`\\b(${BANNED_FINDING_WORDS.join('|')})\\b`, 'i');

function assertNoVerdictWords(field: string, text: string, cardId: string): void {
  const hit = BANNED_RE.exec(text);
  if (hit) {
    throw new Error(
      `card "${cardId}": banned verdict word "${hit[1]}" in ${field} — ` +
      'the Reader measures and states consistency; the human concludes',
    );
  }
}

function assertNonEmpty(field: string, text: string | undefined, cardId: string): asserts text is string {
  if (!text || text.trim().length === 0) {
    throw new Error(`card "${cardId}": ${field} is required and must be non-empty`);
  }
}

export interface CardInput {
  id: string;
  title: string;
  state: CheckState;
  prediction?: string;
  measurement?: string;
  gap?: string;
  interpretation?: string;
  gauge?: { value: number; band: [number, number]; units: string };
  strip?: { p10: number | null; median: number; p90: number; units: string };
  method?: string;
  audit?: string;
}

/**
 * Builds one EvidenceCard, enforcing the grammar:
 *   - every card carries a stated gap and interpretation; for
 *     'insufficient'/'not-run'/'not-applicable' these carry the reason;
 *   - 'agrees'/'diverges' also require prediction and measurement;
 *   - no banned verdict word in title or interpretation;
 *   - a gauge, when present, sits on its stated band as a position, not a
 *     score; a position outside the band is a divergence the caller must
 *     already have stated in the gap.
 */
export function makeCard(input: CardInput): EvidenceCard {
  assertNonEmpty('id', input.id, input.id ?? '(unnamed)');
  assertNonEmpty('title', input.title, input.id);
  assertNoVerdictWords('title', input.title, input.id);

  assertNonEmpty('gap', input.gap, input.id);
  assertNonEmpty('interpretation', input.interpretation, input.id);
  assertNoVerdictWords('interpretation', input.interpretation!, input.id);

  if (input.state === 'agrees' || input.state === 'diverges') {
    assertNonEmpty('prediction', input.prediction, input.id);
    assertNonEmpty('measurement', input.measurement, input.id);
  }

  if (input.gauge) {
    const [lo, hi] = input.gauge.band;
    if (!(lo < hi)) {
      throw new Error(`card "${input.id}": gauge band must be ascending`);
    }
    if (!Number.isFinite(input.gauge.value)) {
      throw new Error(`card "${input.id}": gauge value must be finite`);
    }
    assertNonEmpty('gauge.units', input.gauge.units, input.id);
  }
  if (input.strip) {
    const { p10, median, p90 } = input.strip;
    if (!Number.isFinite(median) || !Number.isFinite(p90)) {
      throw new Error(`card "${input.id}": strip median/p90 must be finite`);
    }
    if (p10 !== null && !Number.isFinite(p10)) {
      throw new Error(`card "${input.id}": strip p10 must be finite or null (null = the evidence does not carry it — never interpolate)`);
    }
    if (!(p90 >= median)) {
      throw new Error(`card "${input.id}": strip must be ordered (p90 ≥ median)`);
    }
    if (p10 !== null && !(median >= p10)) {
      throw new Error(`card "${input.id}": strip must be ordered (median ≥ p10)`);
    }
    assertNonEmpty('strip.units', input.strip.units, input.id);
  }

  const card: EvidenceCard = {
    id: input.id,
    title: input.title,
    state: input.state,
    prediction: input.prediction ?? '',
    measurement: input.measurement ?? '',
    gap: input.gap!,
    interpretation: input.interpretation!,
  };
  if (input.gauge) card.gauge = input.gauge;
  if (input.strip) card.strip = input.strip;
  if (input.method) card.method = input.method;
  if (input.audit) card.audit = input.audit;
  return card;
}

/** A check that could not run; the reason is the card. */
export function makeNotRun(
  id: string,
  title: string,
  reason: string,
  extra?: Pick<CardInput, 'method' | 'audit'>,
): EvidenceCard {
  return makeCard({
    id, title, state: 'not-run',
    gap: `not run: ${reason}`,
    interpretation: `this check could not run here (${reason}); absence of this measurement is neutral, so it says nothing in either direction`,
    ...extra,
  });
}

/** A check that ran but cannot decide either way. */
export function makeInsufficient(
  id: string,
  title: string,
  prediction: string,
  measurement: string,
  reason: string,
  extra?: Pick<CardInput, 'gauge' | 'strip' | 'method' | 'audit'>,
): EvidenceCard {
  return makeCard({
    id, title, state: 'insufficient', prediction, measurement,
    gap: `undecidable: ${reason}`,
    interpretation: `the evidence at hand is consistent with both outcomes (${reason})`,
    ...extra,
  });
}

/** A check structurally unavailable for this exhibit. */
export function makeNotApplicable(
  id: string,
  title: string,
  reason: string,
  extra?: Pick<CardInput, 'method' | 'audit'>,
): EvidenceCard {
  return makeCard({
    id, title, state: 'not-applicable',
    gap: `not applicable: ${reason}`,
    interpretation: `this exhibit structurally cannot carry this check (${reason}); the rung is absent, not failed`,
    ...extra,
  });
}

/**
 * Builds the agreement matrix: checks × claims. `claimsFor` names which
 * claims each card bears on, and a card's state is copied into each cell it
 * speaks to. A card with no claim mapping would render as an invisible
 * check, so it throws.
 */
export function buildMatrix(
  cards: EvidenceCard[],
  claimsFor: (card: EvidenceCard) => Claim[],
): AgreementMatrix {
  const cells: AgreementMatrix['cells'] = {};
  for (const card of cards) {
    const claims = claimsFor(card);
    if (claims.length === 0) {
      throw new Error(`card "${card.id}": maps to no claim — a check that speaks to nothing must not exist`);
    }
    const row: Partial<Record<Claim, CheckState>> = {};
    for (const c of claims) row[c] = card.state;
    cells[card.id] = row;
  }
  const claims = [...new Set(cards.flatMap(claimsFor))];
  return { checks: cards.map((c) => c.id), claims, cells };
}
