// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Selective-disclosure core suite.
 *
 * The disclosure library commits context claims under a Merkle root and
 * opens subsets of them. The honesty invariants pinned here:
 *
 *   - Withheld means ABSENT: a withheld leaf is simply not opened; the
 *     bundle carries a count, never ciphertext.
 *   - Burn is real: without the master seed no leaf can be opened again
 *     by anyone — "I can't", not "I won't" — while bundles already
 *     produced verify forever.
 *   - Never-recorded is declared AT COMMIT TIME, immutable, and distinct
 *     from withheld in every output.
 *   - No verdicts: failures are named, never booleaned away.
 *
 * src/disclosure is NOT in stage.mjs's module list, so this suite
 * mini-stages the real sources itself:
 * it copies src/disclosure/*.ts next to the staged modules applying the
 * SAME import-flattening rewrite stage.mjs uses ('../lib/x' → './x.mts',
 * './x' → './disclosure-x.mts'), then imports the copies. The lab
 * exercises the real code; bare @noble imports resolve from the staged
 * node_modules like every other staged module. Run after `node stage.mjs`
 * (in-place runs copy into tests/.staged, which must exist).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const SRC = ['../src/disclosure', '../../src/disclosure']
  .map((c) => path.resolve(here, c))
  .find((d) => fs.existsSync(path.join(d, 'commit.ts')));
if (!SRC) throw new Error('cannot locate src/disclosure');
const OUT = fs.existsSync(path.join(here, 'node_modules'))
  ? here // staged: tests/.staged
  : path.resolve(here, '.staged'); // in-place: tests/ → copy into the staged lab
if (!fs.existsSync(path.join(OUT, 'node_modules'))) {
  throw new Error('staged lab not found — run `node stage.mjs` first (see tests/stage.mjs)');
}

const MODULES = ['ladder', 'inventory', 'salts', 'tree', 'bundle', 'commit'];
for (const name of MODULES) {
  const src = fs.readFileSync(path.join(SRC, name + '.ts'), 'utf8')
    .replace(/from '\.\.\/lib\/(\w+)'/g, "from './$1.mts'")
    .replace(/from '\.\/(\w+)'/g, "from './disclosure-$1.mts'");
  fs.writeFileSync(path.join(OUT, `disclosure-${name}.mts`), src);
}
const mod = (n: string) => import(pathToFileURL(path.join(OUT, `disclosure-${n}.mts`)).href);

const { commitContext } = await mod('commit');
const { openSubset, profileSelection, verifyBundle } = await mod('bundle');
const { buildInventory, inventoryDigest } = await mod('inventory');
const { buildTree, inclusionProof, verifyInclusion, EMPTY_ROOT } = await mod('tree');
const { deriveLeafSalt, leafDigest } = await mod('salts');
const { coarsen, expectedClaimIds, ladderFor, rungIndex } = await mod('ladder');
const { bytesToHex } = await import(pathToFileURL(path.join(OUT, 'bytes.mts')).href);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// --- the fixture: a full-inventory capture ----------------------------------
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const EXACT_TIME = '2026-03-02T10:05:07.123Z';
const TIME_ORDER = ['year', 'month', 'day', 'hour', 'minute', 'exact-ms'];
const time = (r: string) => ({
  claimId: `time.${r}`, family: 'time', rung: TIME_ORDER.indexOf(r), value: coarsen('time', EXACT_TIME, r),
});
const LOC_ORDER = ['grid-region', 'country', 'region', 'geohash-5', 'geohash-7', 'geohash-9', 'exact'];
const loc = (r: string, v: string) => ({ claimId: `location.${r}`, family: 'location', rung: LOC_ORDER.indexOf(r), value: v });

const makeClaims = () => [
  loc('grid-region', 'NA-NE'), loc('country', 'US'), loc('region', 'US-CA'),
  loc('geohash-5', '9q8yy'), loc('geohash-7', '9q8yyk8'), loc('geohash-9', '9q8yyk8p2'),
  loc('exact', '37.421998,-122.084000'),
  time('year'), time('month'), time('day'), time('hour'), time('minute'), time('exact-ms'),
  { claimId: 'identity.key-fingerprint', family: 'identity', rung: 0, value: 'sha256:3b5c2e' },
  { claimId: 'identity.roster-status', family: 'identity', rung: 1, value: 'active' },
  { claimId: 'identity.org', family: 'identity', rung: 2, value: 'The Lab Gazette' },
  { claimId: 'sensor.present', family: 'sensor', rung: 0, value: 'gyro+accel+baro' },
  { claimId: 'context.weather-summary', family: 'context', rung: 0, value: 'clear-night' },
];
const NEVER = ['identity.named', 'sensor.residual-summary'];
/** Golden root: pins canonicalization + HKDF + tree conventions + the inventory meta-leaf against drift. */
const GOLDEN_ROOT = 'c970f45fa0f5e51ba1dea36bcc5344278b95daba3190aaa58abb5f78378e5438';

const committed = commitContext(SEED, makeClaims(), NEVER);
const tree = committed.tree;
const INV = committed.inventoryAssertion.entries;
const open = (sel: any, profile?: any, customIds?: string[]) =>
  openSubset(tree, committed.leaves, SEED, sel, profile, NEVER, INV, customIds);

// --- 1. round trip: commit → open short → verify ------------------------------
{
  check('commit: root matches the golden vector (canon + HKDF + tree + inventory meta-leaf pinned)',
    committed.root === GOLDEN_ROOT, committed.root);
  check('commit: inventory assertion is camera.contextTree with every claim accounted for',
    committed.inventoryAssertion.label === 'camera.contextTree' &&
    committed.inventoryAssertion.entries.length === expectedClaimIds().length + 1 &&
    committed.inventoryAssertion.treeSize === 18);
  check('commit: NO salt table is returned (burn is real — the seed is the only way to open)',
    !('salts' in committed) && (committed as any).salts === undefined);
  check('commit: tree holds 18 claim leaves + the inventory meta-leaf at index 0',
    tree.layers[0].length === 19 &&
    bytesToHex(tree.layers[0][0]) === bytesToHex(inventoryDigest(INV)));

  const bundle = open(profileSelection('short'), 'short');
  const v = verifyBundle(bundle, committed.root, committed.inventoryAssertion);
  check('round trip: short bundle verifies against root + inventory', v.ok, v.failures.join(' | '));

  const openedIds = v.openedClaims.map((c: any) => c.claimId).sort();
  check('short: exactly the coarse rungs open (location ≤ country, time ≤ day, identity fingerprint)',
    JSON.stringify(openedIds) === JSON.stringify([
      'identity.key-fingerprint', 'location.country', 'location.grid-region',
      'time.day', 'time.month', 'time.year',
    ].sort()), openedIds.join(','));
  check('short: coarse values are ladder prefixes of the exact value',
    v.openedClaims.find((c: any) => c.claimId === 'time.day').value === '2026-03-02' &&
    v.openedClaims.find((c: any) => c.claimId === 'time.year').value === '2026' &&
    v.openedClaims.find((c: any) => c.claimId === 'time.month').value === '2026-03' &&
    coarsen('time', EXACT_TIME, 'minute') === '2026-03-02T10:05' &&
    EXACT_TIME.startsWith(coarsen('time', EXACT_TIME, 'hour')));
  check('ladder helpers: rungIndex + ladderFor agree with the schema',
    rungIndex('location', 'country') === 1 && ladderFor('context').length === 0 &&
    rungIndex('time', 'day') === 2);
}

// --- 2. withheld leaf is ABSENT, never encrypted -------------------------------
{
  const bundle = open(profileSelection('short'), 'short');
  const json = JSON.stringify(bundle);
  check('withheld: count = committed minus opened (never-recorded not counted)',
    bundle.withheldCount === committed.leaves.length - bundle.opened.length && bundle.withheldCount === 12);
  // Withheld VALUES appear nowhere. Withheld claimIds DO ride in
  // inventoryEntries — they are the fixed public schema (ladder.ts names
  // every expected claimId for every capture), so naming them discloses
  // nothing, and the root now binds that declaration.
  check('withheld: withheld claim VALUES appear NOWHERE in the bundle',
    !json.includes('9q8yy') && !json.includes('37.421998') &&
    !json.includes('The Lab Gazette') && !json.includes('clear-night') && !json.includes('2026-03-02T10:05'));
  check('withheld: no salts or proofs for withheld leaves (absence, not encryption)',
    bundle.opened.every((o: any) => !['location.exact', 'location.geohash-5', 'identity.org', 'context.weather-summary'].includes(o.claim.claimId)));
  check('withheld: no ciphertext fields anywhere (absence, not encryption)',
    !/cipher|encrypted|"ct"|blob/i.test(json));
  check('withheld: only opened-leaf material is hex (root, salts, proofs — all lowercase hex)',
    [...json.matchAll(/"(?:salt|root)":\s*"([0-9a-f]{64})"/g)].length === bundle.opened.length + 1 &&
    bundle.opened.every((o: any) => o.proof.every((p: string) => /^[0-9a-f]{64}$/.test(p))));
  const v = verifyBundle(bundle, committed.root, committed.inventoryAssertion);
  check('withheld: a bundle with 12 withheld leaves still verifies', v.ok, v.failures.join(' | '));
}

// --- 3. burn: seed gone → no new opening; old bundles verify forever -----------
{
  const before = open(profileSelection('full'), 'full');

  // The property pinned here: commitContext returns NO salt table, and
  // openSubset takes the master SEED, deriving each selected leaf's salt
  // on demand.
  // So once the seed is destroyed there is literally nothing left to open
  // with — no surviving array to scrub, no second copy. What remains
  // testable in JS: (a) opening requires the seed; (b) any other seed
  // derives different salts; (c) a bundle built from wrong-seed salts
  // fails by name; (d) pre-burn bundles verify forever.
  const burnedSeed = Uint8Array.from(SEED);
  burnedSeed.fill(0);
  const saltBefore = deriveLeafSalt(SEED, 'time.day', 2);
  const saltAfterBurn = deriveLeafSalt(burnedSeed, 'time.day', 2);
  check('burn: a zeroed/wrong seed derives DIFFERENT salts — opening is unrecoverable',
    bytesToHex(saltBefore) !== bytesToHex(saltAfterBurn));

  // openSubset's only salt source is the seed it is given: after the burn
  // the best anyone can do is call it with a wrong seed, and the result
  // fails verification by name — the commitment is closed for everyone,
  // us included. "I can't", not "I won't".
  const forged = openSubset(tree, committed.leaves, burnedSeed, profileSelection('short'), 'short', NEVER, INV);
  const vf = verifyBundle(forged, committed.root);
  check('burn: post-burn opening attempt fails, failure NAMED (I can\'t, not I won\'t)',
    !vf.ok && vf.failures.some((f: string) => f.includes('leaf commitment mismatch')),
    vf.failures[0] ?? 'no failures');
  check('burn: every forged leaf fails — none slips through', vf.openedClaims.length === 0);

  // The bundle produced BEFORE the burn still verifies: commitments close,
  // opened evidence doesn't.
  const vb = verifyBundle(before, committed.root, committed.inventoryAssertion);
  check('burn: pre-burn full bundle STILL verifies (opened leaves stay open forever)',
    vb.ok && vb.openedClaims.length === committed.leaves.length, vb.failures.join(' | '));
}

// --- 4. tamper: every flip is NAMED, never booleaned away ----------------------
{
  const good = open(profileSelection('short'), 'short');
  const clone = () => JSON.parse(JSON.stringify(good));

  const badValue = clone();
  badValue.opened[0].claim.value = 'EVIL';
  const v1 = verifyBundle(badValue, committed.root);
  check('tamper: flipped value → named leaf commitment mismatch',
    !v1.ok && v1.failures.some((f: string) => f.includes('leaf commitment mismatch') && f.includes(badValue.opened[0].claim.claimId)));

  const badSalt = clone();
  badSalt.opened[0].salt = '0'.repeat(64);
  const v2 = verifyBundle(badSalt, committed.root);
  check('tamper: flipped salt → named leaf commitment mismatch',
    !v2.ok && v2.failures.some((f: string) => f.includes('leaf commitment mismatch')));

  const badProof = clone();
  badProof.opened[0].proof[0] = '0'.repeat(64);
  const v3 = verifyBundle(badProof, committed.root);
  check('tamper: flipped proof element → named leaf commitment mismatch',
    !v3.ok && v3.failures.some((f: string) => f.includes('leaf commitment mismatch')));

  const badIndex = clone();
  badIndex.opened[0].leafIndex = (badIndex.opened[0].leafIndex + 2) % badIndex.treeSize;
  const v4 = verifyBundle(badIndex, committed.root);
  check('tamper: moved leafIndex → named leaf commitment mismatch (slot is bound)',
    !v4.ok && v4.failures.some((f: string) => f.includes('leaf commitment mismatch')));

  const badCount = clone();
  badCount.withheldCount = 0;
  const v5 = verifyBundle(badCount, committed.root);
  check('tamper: lied withheldCount → named withheld-count-mismatch',
    !v5.ok && v5.failures.some((f: string) => f.includes('withheld-count-mismatch')));

  const v6 = verifyBundle(good, '0'.repeat(64));
  check('tamper: wrong expected root → named root-mismatch',
    !v6.ok && v6.failures.some((f: string) => f.includes('root-mismatch')));

  const badNever = clone();
  badNever.neverRecorded = ['identity.key-fingerprint'];
  const v7 = verifyBundle(badNever, committed.root, committed.inventoryAssertion);
  check('tamper: rewriting never-recorded → named mismatch + opened-conflict',
    !v7.ok && v7.failures.some((f: string) => f.includes('never-recorded-mismatch')) &&
    v7.failures.some((f: string) => f.includes('never-recorded-opened-conflict')));

  const extraKey = clone();
  extraKey.opened[0].claim.stealth = 'smuggled';
  const v8 = verifyBundle(extraKey, committed.root);
  check('tamper: unexpected claim key → named malformed claim (schema-pinned canonical form)',
    !v8.ok && v8.failures.some((f: string) => f.includes('unexpected key')), v8.failures.join(' | '));

  check('tamper: the good bundle has NO failures (ok is just absence of named failures)',
    verifyBundle(good, committed.root).ok && verifyBundle(good, committed.root).failures.length === 0);
}

// --- 4b. never-recorded is BOUND by the root ------------
{
  const good = open(profileSelection('short'), 'short');
  const clone = () => JSON.parse(JSON.stringify(good));

  // (b) state confusion: append a committed+withheld claim to neverRecorded
  // WITHOUT touching the inventory — the denormalized list disagrees with
  // the root-bound entries.
  const relabel = clone();
  relabel.neverRecorded = [...relabel.neverRecorded, 'location.exact'];
  const r1 = verifyBundle(relabel, committed.root);
  check('root-binding: withheld→never-recorded relabel fails by name',
    !r1.ok && r1.failures.some((f: string) => f.includes('never-recorded-mismatch')), r1.failures.join(' | '));

  // (b′) the count-preserving swap: relabel location.exact as
  // never-recorded AND flip
  // identity.named to 'committed' inside the inventory entries, keeping
  // the committed count at 18. The inventory digest changes, so the
  // meta-leaf no longer proves inclusion — named failure.
  const swap = clone();
  swap.neverRecorded = [...swap.neverRecorded.filter((id: string) => id !== 'identity.named'), 'location.exact'].sort();
  swap.inventoryEntries = swap.inventoryEntries.map((e: any) =>
    e.claimId === 'location.exact' ? { ...e, state: 'never-recorded' }
    : e.claimId === 'identity.named' ? { ...e, state: 'committed' }
    : e);
  const r2 = verifyBundle(swap, committed.root, committed.inventoryAssertion);
  check('root-binding: count-preserving inventory swap FAILS (the root binds the declaration, not just its cardinality)',
    !r2.ok && r2.failures.some((f: string) => f.includes('inventory-commitment-mismatch')), r2.failures.join(' | '));

  // A forged inventory proof element fails the meta-leaf check too.
  const badProof = clone();
  badProof.inventoryProof[0] = '0'.repeat(64);
  const r3 = verifyBundle(badProof, committed.root);
  check('root-binding: flipped inventory-proof element → named inventory-commitment-mismatch',
    !r3.ok && r3.failures.some((f: string) => f.includes('inventory-commitment-mismatch')));

  // The meta-leaf is never openable: a claim shaped like it fails schema.
  const meta = clone();
  meta.opened.push({
    claim: { claimId: '\x00inventory', family: 'context', rung: 0, value: 'x' },
    salt: '0'.repeat(64), proof: [], leafIndex: 0,
  });
  const r4 = verifyBundle(meta, committed.root);
  check('root-binding: the inventory meta-leaf cannot be opened as a claim',
    !r4.ok && r4.failures.some((f: string) => f.includes('malformed')), r4.failures.join(' | '));
}

// --- 4c. the profile label is verified, never decorative -----
{
  const short = open(profileSelection('short'), 'short');
  const clone = () => JSON.parse(JSON.stringify(short));

  const relabel = clone();
  relabel.profile = 'full'; // 12 leaves still withheld
  const p1 = verifyBundle(relabel, committed.root, committed.inventoryAssertion);
  check('profile: short→full relabel FAILS by name (withheld-as-complete is a lie)',
    !p1.ok && p1.failures.some((f: string) => f.includes('profile-mismatch')), p1.failures.join(' | '));

  const bogus = clone();
  bogus.profile = 'executive-summary';
  const p2 = verifyBundle(bogus, committed.root);
  check('profile: out-of-enum label FAILS by name',
    !p2.ok && p2.failures.some((f: string) => f.includes('unknown-profile')), p2.failures.join(' | '));

  const sealedAsShort = open(profileSelection('sealed'), 'short');
  const p3 = verifyBundle(sealedAsShort, committed.root);
  check('profile: sealed selection labeled short FAILS by name',
    !p3.ok && p3.failures.some((f: string) => f.includes('profile-mismatch')), p3.failures.join(' | '));

  // custom: opened set must equal customClaimIds exactly.
  const customIds = ['location.exact', 'time.exact-ms'];
  const custom = open(profileSelection('custom', customIds), 'custom', customIds);
  const p4 = verifyBundle(custom, committed.root, committed.inventoryAssertion);
  check('profile: custom bundle whose opened set == customClaimIds verifies',
    p4.ok, p4.failures.join(' | '));

  const customNoIds = open(profileSelection('custom', customIds), 'custom');
  const p5 = verifyBundle(customNoIds, committed.root);
  check('profile: custom without customClaimIds FAILS by name',
    !p5.ok && p5.failures.some((f: string) => f.includes('customClaimIds')), p5.failures.join(' | '));

  const customLied = JSON.parse(JSON.stringify(custom));
  customLied.customClaimIds = ['location.exact'];
  const p6 = verifyBundle(customLied, committed.root);
  check('profile: custom with a mismatched customClaimIds FAILS by name',
    !p6.ok && p6.failures.some((f: string) => f.includes('profile-mismatch')), p6.failures.join(' | '));
}

// --- 5. never-recorded: commit-time, immutable, distinct from withheld --------
{
  const entries = committed.inventoryAssertion.entries;
  check('never-recorded: declared in the inventory assertion at commit time',
    entries.filter((e: any) => e.state === 'never-recorded').map((e: any) => e.claimId).join(',') === NEVER.join(','));
  check('never-recorded: no leaf exists for it (not in the tree, not withholdable)',
    !committed.leaves.some((c: any) => NEVER.includes(c.claimId)) &&
    committed.inventoryAssertion.treeSize === committed.leaves.length);

  const bundle = open(profileSelection('full'), 'full');
  check('never-recorded: distinct from withheld in the bundle (separate list, not counted)',
    bundle.neverRecorded.join(',') === NEVER.join(',') && bundle.withheldCount === 0 &&
    bundle.opened.length === committed.leaves.length);

  let threw = '';
  try { commitContext(SEED, makeClaims(), ['identity.key-fingerprint']); }
  catch (e) { threw = (e as Error).message; }
  check('never-recorded: a claim cannot be both committed and never-recorded',
    threw.includes('both committed and never-recorded'), threw);

  threw = '';
  try { buildInventory(makeClaims().filter((c: any) => c.claimId !== 'time.year'), NEVER); }
  catch (e) { threw = (e as Error).message; }
  check('fixed schema: an unaccounted expected claim fails the commit, gap named',
    threw.includes("'time.year'") && threw.includes('unaccounted'), threw);

  threw = '';
  try {
    commitContext(SEED, makeClaims().filter((c: any) => c.claimId !== 'context.weather-summary'),
      [...NEVER, 'context.weather-summary']);
  } catch (e) { threw = (e as Error).message; }
  check('never-recorded: only expected-set claims can be declared (no free labels)',
    threw.includes('not in the expected claim set'), threw);
}

// --- 6. determinism -------------------------------------------------------------
{
  const again = commitContext(Uint8Array.from(SEED), makeClaims(), [...NEVER]);
  check('determinism: two independent commits → same root', again.root === committed.root);
  check('determinism: leaf order + tree are identical across constructions',
    again.leaves.map((c: any) => c.claimId).join(',') === committed.leaves.map((c: any) => c.claimId).join(',') &&
    JSON.stringify(again.tree.layers.map((l: any) => l.map(bytesToHex))) ===
    JSON.stringify(committed.tree.layers.map((l: any) => l.map(bytesToHex))));
  check('determinism: HKDF salt matches the pinned golden vector',
    bytesToHex(deriveLeafSalt(new Uint8Array(32).fill(0x11), 'time.day', 2)) ===
    'f3198bddea67ab6709d8e483976c77f3765a2197cf38f8343b02c59b235e6e27');
}

// --- 7. tree edge cases ---------------------------------------------------------
{
  const leaf = (b: number) => new Uint8Array(32).fill(b);
  check('tree: 0 leaves → SHA-256 of empty input (StreamingHasher convention)',
    EMPTY_ROOT === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' &&
    buildTree([]).root === EMPTY_ROOT);

  const one = buildTree([leaf(7)]);
  check('tree: 1 leaf is its own root', one.root === bytesToHex(leaf(7)));
  check('tree: 1-leaf proof is empty and verifies',
    inclusionProof(one, 0).length === 0 && verifyInclusion(one.root, leaf(7), [], 0, 1));

  const three = buildTree([leaf(1), leaf(2), leaf(3)]);
  check('tree: odd leaf promoted — all 3 proofs verify',
    [0, 1, 2].every((i) =>
      verifyInclusion(three.root, leaf(i + 1), inclusionProof(three, i), i, 3)));
  check('tree: promoted odd leaf carries NO sibling at its level',
    inclusionProof(three, 2).length === 1);

  const five = buildTree([1, 2, 3, 4, 5].map(leaf));
  check('tree: 5 leaves — all proofs verify',
    [0, 1, 2, 3, 4].every((i) =>
      verifyInclusion(five.root, leaf(i + 1), inclusionProof(five, i), i, 5)));

  check('tree: right proof, WRONG index → rejected (positional parents bind the slot)',
    !verifyInclusion(five.root, leaf(1), inclusionProof(five, 0), 1, 5) &&
    !verifyInclusion(five.root, leaf(1), inclusionProof(five, 0), 2, 5));
  check('tree: right proof, wrong treeSize → rejected (path no longer consumes the proof)',
    !verifyInclusion(five.root, leaf(1), inclusionProof(five, 0), 0, 4));
  check('tree: foreign digest → rejected',
    !verifyInclusion(five.root, leaf(9), inclusionProof(five, 0), 0, 5));
}

// --- 8. sealed profile: root + never-recorded only, still verifies --------------
{
  const sealed = open(profileSelection('sealed'), 'sealed');
  check('sealed: opened = [] and everything committed is withheld',
    sealed.opened.length === 0 && sealed.withheldCount === committed.leaves.length);
  check('sealed: bundle is root + counts + never-recorded, nothing else to read',
    sealed.neverRecorded.join(',') === NEVER.join(',') && sealed.root === committed.root);
  const v = verifyBundle(sealed, committed.root, committed.inventoryAssertion);
  check('sealed: verifies against the root with zero opened leaves', v.ok && v.openedClaims.length === 0,
    v.failures.join(' | '));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
