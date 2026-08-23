// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * "Known hand": local collection history at the unidentified floor. Local
 * history attaches only at tier 'unknown', only from two prior captures up,
 * and never promotes the tier.
 *
 *  1. unknown + history ≥ 2  → tier stays 'unknown', localHand attached.
 *  2. unknown + history < 2  → bare 'unknown', no localHand.
 *  3. unknown + no history   → bare 'unknown'.
 *  4. any outside anchor hit (this-device) → no localHand, even with history.
 */
import { resolveSignerTrust } from './trustProvider.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const FP = 'aa'.repeat(32);
const hist2 = { priorCaptures: 2, firstSeen: '2026-03-02T10:00:00.000Z' };
const hist5 = { priorCaptures: 5, firstSeen: '2026-01-15T08:30:00.000Z' };
const hist1 = { priorCaptures: 1, firstSeen: '2026-07-01T00:00:00.000Z' };

// 1. unknown floor + sufficient history → attached, tier unchanged
{
  const t = await resolveSignerTrust({
    fingerprint: FP, ownFingerprint: null, orgChain: null, atMs: null, localHistory: hist5,
  });
  check('known hand: tier stays unknown (history never vouches)', t.tier === 'unknown');
  check('known hand: localHand attached with count and first-seen',
    t.localHand?.priorCaptures === 5 && t.localHand?.firstSeen === hist5.firstSeen);
}

// 2. threshold: exactly 2 attaches, 1 does not
{
  const two = await resolveSignerTrust({
    fingerprint: FP, ownFingerprint: null, orgChain: null, atMs: null, localHistory: hist2,
  });
  check('known hand: two prior captures is a track record', two.localHand?.priorCaptures === 2);

  const one = await resolveSignerTrust({
    fingerprint: FP, ownFingerprint: null, orgChain: null, atMs: null, localHistory: hist1,
  });
  check('known hand: one stray capture is NOT a track record',
    one.tier === 'unknown' && one.localHand === undefined);
}

// 3. no history → bare unknown
{
  const t = await resolveSignerTrust({
    fingerprint: FP, ownFingerprint: null, orgChain: null, atMs: null, localHistory: null,
  });
  check('no history: bare unknown, nothing attached', t.tier === 'unknown' && t.localHand === undefined);
}

// 4. outside anchor hit → history irrelevant, not attached
{
  const t = await resolveSignerTrust({
    fingerprint: FP, ownFingerprint: FP, orgChain: null, atMs: null, localHistory: hist5,
  });
  check('anchor hit: this-device tier, no localHand attached',
    t.tier === 'this-device' && t.localHand === undefined);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
