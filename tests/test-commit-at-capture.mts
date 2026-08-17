// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Commit-at-capture + the burn scheduler.
 *
 *   seal → the context-claim bundle is committed (root rides as
 *   com.verify.contextTree) → openSubset derives salts on demand → burn →
 *   openSubset fails honestly ('burned'). The burn is an ACTION — recorded,
 *   never silent — and the scheduler respects the per-item policy
 *   (default: never).
 *
 * Also: the geohash ladder derivation (prefix truncation, like time), the
 * inventory/master-seed invariants (A-01/A-02, docs/INTEGRITY.md), and
 * the residual-report plumbing in the export path.
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-commit-at-capture.mts
 */
import { fileURLToPath } from 'node:url';
import { randomBytes } from '@noble/hashes/utils';
import { claimsFromCapture, commitCaptureEvidence, sealCaptureDisclosure } from './disclosure-captureCommit.mts';
import {
  applyBurn,
  burnedOpenError,
  createItemState,
  exportForItem,
  openForItem,
  runBurnScheduler,
  shouldBurn,
  BURN_FINALITY_WORDING,
  type DisclosureItemState,
  type DisclosureStore,
} from './disclosure-burn.mts';
import { verifyBundle } from './disclosure-bundle.mts';
import { geohashEncode, coarsen, exactLocationValue } from './disclosure-ladder.mts';
import { attestPhoto } from './attest.mts';
import { computeFlags } from './vaultFs.mts';
import { extractC2paStore, parseManifest } from './c2pa.mts';
import { labSigner } from './deviceKey-shim.mts';
import { bytesToHex, hexToBytes } from './bytes.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};
const section = (t: string) => console.log(`\n— ${t} —`);

// Repo-relative default: stage.mjs copies this suite INTO tests/.staged, so
// the staged dir is this file's own directory. VERIFY_STAGED_DIR overrides
// when running the un-staged source against a lab staged elsewhere.
const STAGED = process.env.VERIFY_STAGED_DIR ?? fileURLToPath(new URL('.', import.meta.url));

const INPUT = {
  capturedAt: '2026-08-06T10:20:30.123Z',
  location: { lat: 37.7749, lon: -122.4194 } as const,
  identity: { author: 'Rana', organization: 'Exhibit Lab' } as const,
  fingerprint: 'ab'.repeat(32),
  sensorLogRecorded: true,
  motionVerdict: 'handheld',
};

function memoryStore(): DisclosureStore & { states: Map<string, DisclosureItemState> } {
  const states = new Map<string, DisclosureItemState>();
  return {
    states,
    async listIds() { return [...states.keys()]; },
    async load(id) { return states.get(id) ?? null; },
    async save(s) { states.set(s.itemId, s); },
  };
}

// ---------------------------------------------------------------------------
section('the geohash ladder: prefix truncation, like time');

{
  const exact = exactLocationValue(37.7749, -122.4194);
  check('exact location is the canonical 6-decimal string', exact === '37.774900,-122.419400', exact);
  const g9 = coarsen('location', exact, 'geohash-9');
  const g7 = coarsen('location', exact, 'geohash-7');
  const g5 = coarsen('location', exact, 'geohash-5');
  check('geohash rungs are 9/7/5 chars', g9.length === 9 && g7.length === 7 && g5.length === 5);
  check('coarse is a strict prefix of fine', g7 === g9.slice(0, 7) && g5 === g9.slice(0, 5));
  check('matches the reference geohash for the lab fixture', g9 === geohashEncode(37.7749, -122.4194, 9) && g9.startsWith('9q8yy'), g9);
  check('coarsen exact round-trips', coarsen('location', exact, 'exact') === exact);
  let threw = '';
  try { coarsen('location', exact, 'country'); } catch (e) { threw = (e as Error).message; }
  check('country/region/grid-region refuse fake derivation (never-recorded instead)',
    threw.includes('reverse geocoding') && threw.includes('never-recorded'), threw);
}

// ---------------------------------------------------------------------------
section('seal → bundle committed → openSubset derives salts');

{
  const seed = randomBytes(32);
  const disc = sealCaptureDisclosure(seed, INPUT);
  const { claims, neverRecordedIds } = claimsFromCapture(INPUT);
  check('19-claim schema: every rung committed or declared never-recorded',
    claims.length + neverRecordedIds.length === 19, `${claims.length}+${neverRecordedIds.length}`);
  check('reverse-geocoded rungs are declared never-recorded, honestly',
    ['location.country', 'location.region', 'location.grid-region', 'identity.roster-status']
      .every((id) => neverRecordedIds.includes(id)));
  check('geohash rungs committed with prefix-truncated values', (() => {
    const g9 = claims.find((c) => c.claimId === 'location.geohash-9')!.value;
    const g5 = claims.find((c) => c.claimId === 'location.geohash-5')!.value;
    return g9.length === 9 && g5 === g9.slice(0, 5);
  })());
  check('identity + time + sensor rungs committed',
    ['identity.key-fingerprint', 'identity.org', 'identity.named', 'time.exact-ms', 'sensor.present', 'sensor.residual-summary']
      .every((id) => claims.some((c) => c.claimId === id)));

  // The default Sealed bundle opens NOTHING and verifies.
  const sealedV = verifyBundle(disc.sealedBundle, disc.root, disc.inventoryAssertion);
  check('the default Sealed-profile bundle verifies', sealedV.ok, JSON.stringify(sealedV.failures));
  check('the Sealed bundle opens zero claims', disc.sealedBundle.opened.length === 0);

  // openSubset derives salts on demand — the short rung-set opens exactly
  // the short rungs, with proofs that verify against the committed root.
  const state = createItemState('item-1', disc);
  const opened = openForItem(state, 'short');
  const jv = verifyBundle(opened.bundle, state.root, state.inventoryAssertion);
  check('short bundle derives + verifies', jv.ok, JSON.stringify(jv.failures));
  const openedIds = opened.bundle.opened.map((l) => l.claim.claimId).sort();
  check('short opens exactly its rung-set',
    JSON.stringify(openedIds) === JSON.stringify(['identity.key-fingerprint', 'time.day', 'time.month', 'time.year'].sort()),
    JSON.stringify(openedIds));
  check('no salt table exists anywhere in the state (A-02)',
    !('salts' in state) && !('saltTable' in state) && !('salts' in opened.bundle));

  // The inventoryDigest meta-leaf (A-01): tampering with the never-recorded
  // declaration (an inventory ENTRY) breaks verification against the same root.
  const tamperedBundle = JSON.parse(JSON.stringify(opened.bundle));
  tamperedBundle.inventoryEntries.find((e: any) => e.claimId === 'location.country').state = 'committed';
  const tv = verifyBundle(tamperedBundle, state.root, state.inventoryAssertion);
  check('a doctored never-recorded declaration is caught (A-01)',
    !tv.ok && tv.failures.some((f) => f.includes('inventory') || f.includes('never-recorded')),
    JSON.stringify(tv.failures));

  // Determinism: the same evidence commits the same claim VALUES (fresh seed
  // changes salts, not values).
  const again = claimsFromCapture(INPUT);
  check('same evidence → same claim values', JSON.stringify(again.claims) === JSON.stringify(claims));

  // Location redacted: every location rung declared never-recorded.
  const redacted = claimsFromCapture({ ...INPUT, location: 'redacted' });
  check('redacted location → all 7 location rungs never-recorded',
    redacted.neverRecordedIds.filter((id) => id.startsWith('location.')).length === 7 &&
    !redacted.claims.some((c) => c.family === 'location'));
}

// ---------------------------------------------------------------------------
section('burn → openSubset fails honestly; the burn is an action');

{
  const store = memoryStore();
  const disc = sealCaptureDisclosure(randomBytes(32), INPUT);
  const created = new Date('2026-08-06T10:00:00.000Z');
  const state = createItemState('item-burn', disc, { burnAfterHours: 24, now: created });
  await store.save(state);

  check('default policy is never-burn',
    !shouldBurn(createItemState('item-keep', sealCaptureDisclosure(randomBytes(32), INPUT)), new Date('2030-01-01T00:00:00Z')));
  check('policy respects the per-item window (not yet due)',
    !shouldBurn(state, new Date('2026-08-06T20:00:00Z')));
  check('policy respects the per-item window (due)',
    shouldBurn(state, new Date('2026-08-08T10:00:00Z')));

  // Opening BEFORE the burn works — and the opened bundle verifies FOREVER
  // after (commitments close; opened evidence survives).
  const opened = openForItem(state, 'full');
  const burnedIds = await runBurnScheduler(store, new Date('2026-08-08T10:00:00Z'));
  check('the scheduler burns exactly the due item', JSON.stringify(burnedIds) === JSON.stringify(['item-burn']));
  const burned = (await store.load('item-burn'))!;
  check('the seed is gone after burn', burned.masterSeedHex === undefined);
  check('the burn is recorded (never silent)',
    burned.events.some((e) => e.type === 'burn') && burned.burnedAt === '2026-08-08T10:00:00.000Z');
  const stillValid = verifyBundle(opened.bundle, burned.root, burned.inventoryAssertion);
  check('evidence opened before the burn still verifies', stillValid.ok, JSON.stringify(stillValid.failures));

  let openErr = '';
  try { openForItem(burned, 'short'); } catch (e) { openErr = (e as Error).message; }
  check('openSubset after burn fails honestly (burned)',
    openErr.startsWith('burned:') && openErr.includes(BURN_FINALITY_WORDING), openErr);
  check('the locked finality wording rides the error', burnedOpenError(burned).message.includes(BURN_FINALITY_WORDING));

  // A second scheduler run: already-burned items are not re-burned (no
  // double event, no silent action).
  const again = await runBurnScheduler(store, new Date('2026-08-09T10:00:00Z'));
  check('the scheduler never burns twice', again.length === 0 &&
    (await store.load('item-burn'))!.events.filter((e) => e.type === 'burn').length === 1);
  let doubleBurn = '';
  try { applyBurn(burned, new Date()); } catch (e) { doubleBurn = (e as Error).message; }
  check('applyBurn on a burned item says already-burned', doubleBurn.includes('already burned'));
  // The locked wording must name what burn truly
  // destroys (the proof material), not overclaim fact erasure.
  check('the locked wording names proof-material destruction, not fact erasure',
    BURN_FINALITY_WORDING ===
      'After burn, withheld details can never be cryptographically disclosed again — the proof material is destroyed. What the record itself already shows remains visible.',
    BURN_FINALITY_WORDING);
}

// ---------------------------------------------------------------------------
section('a failing item cannot abort later burns; failures are recorded (A-M-2)');

{
  const store = memoryStore();
  const created = new Date('2026-08-06T10:00:00.000Z');
  await store.save(createItemState('item-failsave', sealCaptureDisclosure(randomBytes(32), INPUT), { burnAfterHours: 1, now: created }));
  await store.save(createItemState('item-burns', sealCaptureDisclosure(randomBytes(32), INPUT), { burnAfterHours: 1, now: created }));
  // The burn save for the first item throws once (disk-full shape); its
  // failure-recording save succeeds.
  const realSave = store.save.bind(store);
  let throwsLeft = 1;
  const flaky: DisclosureStore = {
    listIds: () => store.listIds(),
    load: (id) => store.load(id),
    save: async (s) => {
      if (s.itemId === 'item-failsave' && s.masterSeedHex === undefined && throwsLeft-- > 0) throw new Error('disk full');
      return realSave(s);
    },
  };
  const burnedIds = await runBurnScheduler(flaky, new Date('2026-08-08T10:00:00Z'));
  check('the later item still burns when an earlier save fails',
    JSON.stringify(burnedIds) === JSON.stringify(['item-burns']), JSON.stringify(burnedIds));
  const failed = await store.load('item-failsave');
  check('the failure is recorded in the item state (never silent)',
    failed?.masterSeedHex !== undefined && failed?.burnFailure?.error.includes('disk full') === true,
    JSON.stringify(failed?.burnFailure ?? null));
  const retry = await runBurnScheduler(flaky, new Date('2026-08-08T11:00:00Z'));
  const retried = await store.load('item-failsave');
  check('the next run retries the burn and clears the failure marker',
    JSON.stringify(retry) === JSON.stringify(['item-failsave']) &&
    retried?.masterSeedHex === undefined && retried?.burnFailure === undefined,
    `retry=${JSON.stringify(retry)} failure=${JSON.stringify(retried?.burnFailure ?? null)}`);
}

// ---------------------------------------------------------------------------
section('E.05 residuals ride the export path');

{
  const disc = sealCaptureDisclosure(randomBytes(32), INPUT);
  const state = createItemState('item-export', disc);
  const clean = exportForItem(state, 'short');
  check('a clean export returns an empty residual list', clean.residuals.length === 0, JSON.stringify(clean.residuals));
  check('the export records the open action', clean.state.events.some((e) => e.type === 'open' && e.profile === 'short'));
  // The residual report IS verifyBundle's failure list: a profile-mismatched
  // bundle (label forged after derivation) produces the named residual.
  const forged = { ...clean.bundle, profile: 'full' as const };
  const residuals = verifyBundle(forged, state.root, state.inventoryAssertion).failures;
  check('a forged profile label yields named residuals', residuals.length > 0, JSON.stringify(residuals));
}

// ---------------------------------------------------------------------------
section('end to end: a real seal commits the context tree');

{
  const key = labSigner();
  const r = await attestPhoto({
    photoUri: `${STAGED}/clean.jpg`,
    context: { location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 } } as any,
    identity: { author: 'Rana', organization: null },
    key,
    capturedAt: '2026-08-06T10:20:30.123Z',
  });
  check('attest returns the disclosure state', !!r.disclosure && r.disclaimer === undefined);
  const m = parseManifest(extractC2paStore(r.signedPhotoBytes!)!.payload)!;
  const ct = m.customAssertions['com.verify.contextTree']?.data as any;
  check('com.verify.contextTree rides the manifest', ct?.version === '1.0.0-ws2');
  check('the manifest root is the disclosure root', ct?.root === r.disclosure!.root);
  check('the root binds the committed claims (+ meta-leaf)', ct?.treeSize === r.disclosure!.claims.length, String(ct?.treeSize));
  check('the inventory declares the full 19-claim schema', ct?.entries?.length === 19, String(ct?.entries?.length));
  // What the vault store would persist, replayed: seal → open → burn → fail.
  const state = createItemState('vault-item-1', r.disclosure!);
  const opened = openForItem(state, 'short');
  check('the sealed capture opens its short rungs',
    verifyBundle(opened.bundle, state.root, state.inventoryAssertion).ok);
  const burned = applyBurn(state, new Date());
  let err = '';
  try { openForItem(burned, 'short'); } catch (e) { err = (e as Error).message; }
  check('after burn the same request fails honestly', err.startsWith('burned:'), err);
  // The sealed bundle from the capture verifies against the manifest root.
  check('the manifest-committed root verifies the Sealed bundle',
    verifyBundle(r.disclosure!.sealedBundle, ct.root, ct).ok);
  // Master seed never touches the manifest (A-02): it must not appear in the signed bytes.
  const seedHex = r.disclosure!.masterSeedHex;
  const seedBytes = hexToBytes(seedHex);
  let found = false;
  outer: for (let i = 0; i + 32 <= r.signedPhotoBytes!.length; i++) {
    for (let j = 0; j < 32; j++) if (r.signedPhotoBytes![i + j] !== seedBytes[j]) continue outer;
    found = true;
    break;
  }
  check('the master seed never appears in the signed asset', !found);
}

// ---------------------------------------------------------------------------
section("the EvidencePath 'never-recorded' sentinel never counts as a recorded sensor log");

{
  // The third EvidencePath state is the STRING literal 'never-recorded'
  // (CaptureKit never opened the sink). A bare typeof-string check would
  // count it as present — these cases drive the sentinel through the REAL
  // attest → commitContextTree path, not a hardcoded boolean.
  const key = labSigner();
  const sentinelEvidence = {
    rawPcmPath: 'never-recorded',
    sensorLogPath: 'never-recorded',
    ringBufferDir: 'never-recorded',
  } as const;
  const baseContext = { location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 } } as any;

  const r = await attestPhoto({
    photoUri: `${STAGED}/clean.jpg`,
    context: { ...baseContext, captureEvidence: { ...sentinelEvidence } },
    identity: { author: 'Rana', organization: null },
    key,
    capturedAt: '2026-08-06T10:20:30.123Z',
  });
  const m = parseManifest(extractC2paStore(r.signedPhotoBytes!)!.payload)!;
  const ct = m.customAssertions['com.verify.contextTree']?.data as any;
  const sensorPresent = r.disclosure!.claims.find((c) => c.claimId === 'sensor.present');
  check("sentinel sensorLogPath commits sensor.present = 'false'",
    sensorPresent?.value === 'false', JSON.stringify(sensorPresent));
  const entries = (ct?.entries ?? r.disclosure!.inventoryAssertion.entries) as { claimId: string; state: string }[];
  check('the sentinel case declares sensor.residual-summary never-recorded',
    entries.some((e) => e.claimId === 'sensor.residual-summary' && e.state === 'never-recorded'),
    JSON.stringify(entries.filter((e) => e.claimId.startsWith('sensor.'))));
  check('the sentinel bundle still verifies against the manifest root',
    verifyBundle(r.disclosure!.sealedBundle, ct.root, ct).ok);

  const r2 = await attestPhoto({
    photoUri: `${STAGED}/clean.jpg`,
    context: { ...baseContext, captureEvidence: { ...sentinelEvidence, sensorLogPath: '/tmp/lab/sensor.jsonl' } },
    identity: { author: 'Rana', organization: null },
    key,
    capturedAt: '2026-08-06T10:20:30.123Z',
  });
  const sensorPresent2 = r2.disclosure!.claims.find((c) => c.claimId === 'sensor.present');
  check("a real sensor-log path commits sensor.present = 'true'",
    sensorPresent2?.value === 'true', JSON.stringify(sensorPresent2));
}

// ---------------------------------------------------------------------------
section("vault badges: the sentinel does not raise the identifying flag");

{
  const recordFor = (sensorLogPath: unknown) =>
    ({
      identity: 'redacted',
      context: {
        location: null,
        captureEvidence: { rawPcmPath: 'never-recorded', sensorLogPath, ringBufferDir: 'never-recorded' },
      },
      captureIntegrity: null,
    }) as any;
  check('sentinel sensorLogPath leaves identifying false',
    computeFlags(recordFor('never-recorded')).identifying === false);
  check('a real sensor-log path raises identifying',
    computeFlags(recordFor('/tmp/lab/sensor.jsonl')).identifying === true);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
