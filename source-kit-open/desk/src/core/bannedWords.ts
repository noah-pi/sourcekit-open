/**
 * bannedWords.ts — the DESIGN §1.3 banned-word list, as checkable data.
 *
 * §1.3 (ethos law): never in a banner, chip, badge, grade, or any summary
 * position: verified, authentic, trusted, proven, real, secure, guaranteed
 * — and any fused score. "Trusted roster" survives as a NOUN (the user's
 * own list), never as a judgment about a file.
 *
 * DOM-free; consumed by the copy/ethos tests (assistant.test.ts,
 * copy.test.ts) so the banned list lives in exactly one place.
 */

export const BANNED_VERDICT_WORDS = [
  'verified',
  'authentic',
  'trusted',
  'proven',
  'real',
  'secure',
  'guaranteed',
] as const;

/**
 * Banned-word hits in a piece of copy. The single licensed compound —
 * "trusted roster(s)" — is scrubbed before the sweep; any other use of a
 * banned word, in any casing, is a hit. Word-boundary matching, so
 * "reality" is not "real" and "unverified" is not swept here (a negation
 * is not a verdict; the human copy review owns those).
 */
export function bannedWordHits(text: string): string[] {
  const scrubbed = text.replace(/\btrusted roster(s)?\b/gi, 'roster');
  return BANNED_VERDICT_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(scrubbed));
}
