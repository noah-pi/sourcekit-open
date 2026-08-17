// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * assistant.test.ts — golden tests for the Assistant (ARCHITECTURE §9).
 *
 * Representative item states, exact expected paragraph lists:
 *  1. no credentials        — neutral custody sentence + the not-checked close
 *  2. intact + rostered     — the full chain: custody → identity → time →
 *                             declared actions → close
 *  3. bytes changed         — the one brick-red fact, restated calmly
 *  4. video with signals    — Tier-1 rows restated with method versions,
 *                             the un-run analyzers disclosed last
 *
 * Plus the structural invariants: every sentence carries a BasisRef; no
 * banned word (§1.3) in any generated text; the memo key is stable for
 * identical inputs and changes when the evidence changes.
 *
 * Runs under `tsx --test` (node:test) — no test-runner dependency added.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantInput, IntakeReport } from '../contracts-ext';
import type { DeskItem } from './deskItem';
import type { DeskTrust } from './deskCore';
import { resolveDeskTrust } from './deskCore';
import { summarizeAsset, assistantInputKey, ASSISTANT_METHOD_VERSION } from './assistant';
import { bannedWordHits } from './bannedWords';

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const SHA = 'ab'.repeat(32);

function photoItem(report: unknown, extra: Record<string, unknown> = {}): DeskItem {
  return {
    id: 'm1',
    name: 'IMG_4031.jpg',
    kind: 'media',
    addedAt: 0,
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0, 0, 0, 0, 0, 0, 0]),
    sha256Hex: SHA,
    report,
    ...extra,
  } as unknown as DeskItem;
}

function videoItem(report: unknown, extra: Record<string, unknown> = {}): DeskItem {
  return {
    id: 'v1',
    name: 'clip.mp4',
    kind: 'media',
    addedAt: 0,
    bytes: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0]),
    sha256Hex: SHA,
    report,
    ...extra,
  } as unknown as DeskItem;
}

const ROSTERED: DeskTrust = { tier: 'roster', basis: 'Listed as Example Device (capture) — roster "Example roster".', membershipState: 'active' };

function baseInput(item: DeskItem, patch: Partial<AssistantInput> = {}): AssistantInput {
  return { item, trust: null, artifact: null, matches: [], custodyMatches: [], ...patch };
}

/* ------------------------------------------------------------------ */
/* 1. No credentials                                                  */
/* ------------------------------------------------------------------ */

test('golden: no credentials — neutral custody + disclosed not-performed', () => {
  const item = photoItem({
    verdict: 'NO_ATTESTATION',
    record: null,
    checksNotPerformed: ['OpenTimestamps ledger receipts — none attached to this record'],
  });
  const summary = summarizeAsset(baseInput(item));
  assert.deepEqual(summary.paragraphs, [
    {
      text:
        'No credentials were found in this file. That is normal — most files today carry none, and an ' +
        'unsigned file is just an unsigned file.',
      basis: { tab: 'overview', card: 'banner' },
    },
    {
      text:
        'Not performed — disclosed, not hidden: OpenTimestamps ledger receipts — none attached to this record.',
      basis: { tab: 'overview', card: 'checks' },
    },
  ]);
});

/* ------------------------------------------------------------------ */
/* 1b. Unsigned media gets NO signer story (fix A1)                    */
/* ------------------------------------------------------------------ */

test('golden: NO_ATTESTATION with real resolveDeskTrust output — no identity paragraph', () => {
  // The trust the dashboard would actually compute for this item: an
  // unsigned file has no signer fingerprint, so resolveDeskTrust returns
  // null — no tier, no basis, no signer story. The Assistant must then
  // emit NOTHING with a trust basis.
  const item = photoItem({
    verdict: 'NO_ATTESTATION',
    record: null,
    c2pa: null,
    checksNotPerformed: [],
  });
  const trust = resolveDeskTrust(item.report as never, []);
  assert.equal(trust, null, 'no signer fingerprint → no trust object at all');
  const summary = summarizeAsset(baseInput(item, { trust }));
  assert.ok(summary.paragraphs.length > 0, 'custody + not-checked paragraphs still exist');
  assert.equal(
    summary.paragraphs.some((p) => p.basis.card === 'trust'),
    false,
    'unsigned media gets no identity paragraph — absence is not suspicion',
  );
});

test('resolveSignerTrust: no fingerprint resolves to null, never an unknown tier', async () => {
  const { resolveSignerTrust } = await import('./deskCore');
  assert.equal(resolveSignerTrust(null, null, []), null);
  // A fingerprint still resolves to a tier — the null is specifically the
  // no-signer case, not a blanket suppression.
  const withSigner = resolveSignerTrust('ff'.repeat(32), null, []);
  assert.ok(withSigner !== null && withSigner.tier === 'unknown');
});

/* ------------------------------------------------------------------ */
/* 2. Intact + rostered                                               */
/* ------------------------------------------------------------------ */

test('golden: intact + rostered — full chain in the fixed order', () => {
  const intake: IntakeReport = {
    itemId: 'm1',
    computedAt: '2025-07-14T10:00:00Z',
    sha256Hex: SHA,
    classification: 'media',
    byteReads: null,
    jpegStructure: null,
    thumbnail: null,
    c2paSummary: {
      claimGenerator: 'Example Sealer 1.0',
      manifestLabel: null,
      manifestCount: 1,
      actions: [{ action: 'c2pa.cropped', referenced: true }],
      ingredients: [],
      signerFingerprint: 'ff'.repeat(32),
      digitalSourceType: null,
    },
    pHashHex: null,
    custody: { recoveryMatches: 0, exactAfterStrip: 0 },
  };
  const item = photoItem(
    {
      verdict: 'INTACT',
      record: { capturedAt: '2025-07-14T09:31:00Z' },
      c2pa: {
        timestamps: {
          present: 2, valid: 2, trusted: 1, trustedNames: ['Example TSA'],
          earliestValidUtc: '2025-07-14T09:31:05Z', earliestTrustedUtc: '2025-07-14T09:31:05Z',
          tsaNames: ['Example TSA'], failures: [],
        },
      },
      checksNotPerformed: [],
    },
    { intakeReport: intake },
  );
  const summary = summarizeAsset(baseInput(item, { trust: ROSTERED }));
  assert.deepEqual(summary.paragraphs, [
    {
      text:
        'The bytes match exactly what the signing key sealed, the signature checks out, and the signer ' +
        'was on your trusted roster at the countersigned signing time. That is a custody fact; what the ' +
        'content shows is yours to judge.',
      basis: { tab: 'overview', card: 'banner' },
    },
    {
      text: 'The signer is on your trusted roster.',
      basis: { tab: 'overview', card: 'trust' },
    },
    {
      text: 'The device clock claims capture at 2025-07-14T09:31:00Z — a claim by the device, not independently confirmed.',
      basis: { tab: 'overview', card: 'time' },
    },
    {
      text:
        'Authority time (RFC 3161): 2 of 2 tokens cryptographically check out; the earliest valid ' +
        'countersigned time is 2025-07-14T09:31:05Z, and 1 comes from a pinned authority.',
      basis: { tab: 'overview', card: 'time' },
    },
    {
      text:
        "The sealing software (Example Sealer 1.0) declared 1 action: c2pa.cropped. These are the software's " +
        'own declarations — a valid seal cannot show that nothing else happened.',
      basis: { tab: 'overview', card: 'c2pa-actions' },
    },
    {
      text: 'Nothing was left undisclosed — no check applicable to this item is listed as not performed.',
      basis: { tab: 'overview', card: 'checks' },
    },
  ]);
});

/* ------------------------------------------------------------------ */
/* 3. Bytes changed                                                   */
/* ------------------------------------------------------------------ */

test('golden: bytes changed — the one brick-red fact, calmly restated', () => {
  const item = photoItem({
    verdict: 'CONTENT_MODIFIED',
    record: { capturedAt: '2025-07-14T09:31:00Z' },
    checksNotPerformed: ['Bitcoin block binding — requires fetching block headers; enable online checks to perform it'],
  });
  const trust: DeskTrust = { tier: 'unknown', basis: 'Self-signed device certificate, not on any trusted roster.' };
  const summary = summarizeAsset(baseInput(item, { trust }));
  assert.deepEqual(summary.paragraphs, [
    {
      text:
        'The signature checks out, but the media bytes no longer match what it sealed — the bytes changed ' +
        'after signing. Something altered this file.',
      basis: { tab: 'overview', card: 'banner' },
    },
    {
      text: 'The signer is not on any of your trusted rosters. Integrity can be established; who the key belongs to cannot.',
      basis: { tab: 'overview', card: 'trust' },
    },
    {
      text: 'The device clock claims capture at 2025-07-14T09:31:00Z — a claim by the device, not independently confirmed.',
      basis: { tab: 'overview', card: 'time' },
    },
    {
      text:
        'Not performed — disclosed, not hidden: Bitcoin block binding — requires fetching block headers; ' +
        'enable online checks to perform it.',
      basis: { tab: 'overview', card: 'checks' },
    },
  ]);
});

/* ------------------------------------------------------------------ */
/* 4. Video with Tier-1 signals                                       */
/* ------------------------------------------------------------------ */

test('golden: video with signals — rows restated with method versions, un-run disclosed last', () => {
  const item = videoItem(
    {
      verdict: 'INTACT',
      record: { capturedAt: '2025-07-14T09:31:00Z' },
      checksNotPerformed: [],
    },
    {
      tier1Signals: [
        {
          id: 'displaybeat', title: 'Display-beat', version: 'displaybeat/1',
          measurement: 'strongest periodic luma component 60.000 Hz at 12.3 dB SNR — likely display family',
          bound: 'sample rate 2.50 Hz', note: '', limitations: [],
          computedAt: '2025-07-14T10:05:00Z',
        },
        {
          id: 'enf-extract', title: 'ENF extract', version: 'enf-extract/1',
          measurement: 'insufficient — The clip is shorter than 30 s — ENF needs at least that much audio. Not run; stated, not hidden.',
          bound: 'extract-only at Tier 1', note: '', limitations: [],
          computedAt: '2025-07-14T10:06:00Z',
        },
      ],
    },
  );
  const summary = summarizeAsset(baseInput(item, { trust: ROSTERED }));
  assert.deepEqual(summary.paragraphs, [
    {
      text:
        'The bytes match exactly what the signing key sealed, the signature checks out, and the signer ' +
        'was on your trusted roster at the countersigned signing time. That is a custody fact; what the ' +
        'content shows is yours to judge.',
      basis: { tab: 'overview', card: 'banner' },
    },
    {
      text: 'The signer is on your trusted roster.',
      basis: { tab: 'overview', card: 'trust' },
    },
    {
      text: 'The device clock claims capture at 2025-07-14T09:31:00Z — a claim by the device, not independently confirmed.',
      basis: { tab: 'overview', card: 'time' },
    },
    {
      text: 'Display-beat (method displaybeat/1): strongest periodic luma component 60.000 Hz at 12.3 dB SNR — likely display family',
      basis: { tab: 'signals', card: 'signal-displaybeat' },
    },
    {
      text:
        'ENF extract (method enf-extract/1): insufficient — The clip is shorter than 30 s — ENF needs at ' +
        'least that much audio. Not run; stated, not hidden.',
      basis: { tab: 'signals', card: 'signal-enf-extract' },
    },
    {
      text: 'Not performed — disclosed, not hidden: 2 Signals-tab analyzers not run — they run only when you ask.',
      basis: { tab: 'overview', card: 'checks' },
    },
  ]);
});

/* ------------------------------------------------------------------ */
/* 5. Tier-2 fx + re-photo restatements (deep-linked to the fx cards) */
/* ------------------------------------------------------------------ */

test('golden: tier-2 results and re-photo signals are restated with fx basis refs', () => {
  const item = photoItem(
    { verdict: 'INTACT', record: { capturedAt: 'x' }, checksNotPerformed: [] },
    {
      tier2Fx: {
        clone: {
          state: 'measured', params: {}, analyzedWidth: 8, analyzedHeight: 8,
          blocksConsidered: 10, blocksFilteredLowDetail: 0, collidingBuckets: 1,
          candidatePairs: 4, pairsConsidered: 4, pairsTruncated: 0,
          clusters: [{ dx: 5, dy: 5, pairs: 4 }], matchedBlocks: 8,
          overlay: null, debugView: null, methodVersion: '1.0.0-w4', computedAt: 't',
        },
      },
      rephoto: {
        banding: { snrDb: 3.2, strength: 'weak' }, moire: { snrDb: 1.1, strength: 'none' },
        blackFloor: { liftEstimate: 4 }, gamut: { hardSaturatedFraction: 0 },
        analyzedWidth: 8, analyzedHeight: 8,
      },
    },
  );
  const input = baseInput(item, { trust: ROSTERED });
  const summary = summarizeAsset(input);
  const cloneP = summary.paragraphs.find((p) => p.basis.card === 'fx-clone');
  assert.ok(cloneP, 'a clone restatement exists');
  assert.ok(cloneP.text.includes('1 shared-offset cluster'), cloneP.text);
  assert.ok(cloneP.text.includes('a lead, not a verdict'), cloneP.text);
  assert.equal(cloneP.basis.tab, 'forensics');
  const rephotoP = summary.paragraphs.find((p) => p.basis.card === 'fx-rephoto');
  assert.ok(rephotoP, 'a re-photo restatement exists');
  // Every fx sentence still carries no banned word.
  for (const p of summary.paragraphs) assert.deepEqual(bannedWordHits(p.text), [], p.text);
  // A landed fx run regenerates the memo key.
  const bare = baseInput(photoItem({ verdict: 'INTACT', record: { capturedAt: 'x' }, checksNotPerformed: [] }), { trust: ROSTERED });
  assert.notEqual(assistantInputKey(bare), assistantInputKey(input), 'a newly run fx analysis regenerates');
});

/* ------------------------------------------------------------------ */
/* Structural invariants                                              */
/* ------------------------------------------------------------------ */

test('every paragraph carries a basis (tab + card), in every fixture state', () => {
  const items = [
    photoItem({ verdict: 'NO_ATTESTATION', record: null, checksNotPerformed: [] }),
    photoItem({ verdict: 'SIGNATURE_INVALID', record: { capturedAt: 'x' }, checksNotPerformed: [] }),
    videoItem({ verdict: 'INTACT', record: { capturedAt: 'x' }, checksNotPerformed: [] }),
  ];
  for (const item of items) {
    const summary = summarizeAsset(baseInput(item, { trust: ROSTERED }));
    assert.ok(summary.paragraphs.length > 0);
    for (const p of summary.paragraphs) {
      assert.ok(p.text.length > 0, 'sentence text present');
      assert.ok(['overview', 'signals', 'forensics', 'ai'].includes(p.basis.tab), `basis tab: ${p.basis.tab}`);
      assert.ok(p.basis.card.length > 0, 'basis card id present');
    }
  }
});

test('no banned words (§1.3) in any generated sentence', () => {
  const fixtures: AssistantInput[] = [
    baseInput(photoItem({ verdict: 'NO_ATTESTATION', record: null, checksNotPerformed: ['x'] })),
    baseInput(photoItem({ verdict: 'INTACT', record: { capturedAt: 'x' }, checksNotPerformed: [] }), { trust: ROSTERED }),
    baseInput(photoItem({ verdict: 'CONTENT_MODIFIED', record: { capturedAt: 'x' }, checksNotPerformed: [] })),
    baseInput(photoItem({ verdict: 'SIGNATURE_INVALID', record: null, checksNotPerformed: [] })),
    baseInput(videoItem({ verdict: 'INTACT', record: { capturedAt: 'x' }, checksNotPerformed: [] }), { trust: ROSTERED }),
  ];
  for (const input of fixtures) {
    for (const p of summarizeAsset(input).paragraphs) {
      assert.deepEqual(bannedWordHits(p.text), [], `banned word in: ${p.text}`);
    }
  }
});

test('memo key: stable for identical inputs, changes when evidence changes', () => {
  const item = videoItem({ verdict: 'INTACT', record: { capturedAt: 'x' }, checksNotPerformed: [] });
  const a = baseInput(item, { trust: ROSTERED });
  assert.equal(assistantInputKey(a), assistantInputKey(a), 'same input → same key');
  const b = baseInput(
    videoItem({ verdict: 'INTACT', record: { capturedAt: 'x' }, checksNotPerformed: [] }),
    { trust: ROSTERED },
  );
  assert.equal(assistantInputKey(a), assistantInputKey(b), 'equal evidence → same key');

  const withSignal = baseInput(
    videoItem(
      { verdict: 'INTACT', record: { capturedAt: 'x' }, checksNotPerformed: [] },
      {
        tier1Signals: [{
          id: 'displaybeat', title: 'Display-beat', version: 'displaybeat/1',
          measurement: 'm', bound: 'b', note: '', limitations: [], computedAt: 't',
        }],
      },
    ),
    { trust: ROSTERED },
  );
  assert.notEqual(assistantInputKey(a), assistantInputKey(withSignal), 'a newly run signal regenerates');

  const modified = baseInput(photoItem({ verdict: 'CONTENT_MODIFIED', record: null, checksNotPerformed: [] }));
  assert.notEqual(assistantInputKey(a), assistantInputKey(modified), 'a changed verdict regenerates');

  assert.ok(assistantInputKey(a).startsWith(`["${ASSISTANT_METHOD_VERSION}"`), 'method version is part of the key');
});

test('empty state: an item with no computed evidence yields no paragraphs', () => {
  const item = { id: 'u1', name: 'blob.bin', kind: 'unknown', addedAt: 0 } as unknown as DeskItem;
  const summary = summarizeAsset(baseInput(item));
  assert.deepEqual(summary.paragraphs, []);
});

test('deterministic: same input → byte-identical summary', () => {
  const item = photoItem({ verdict: 'NO_ATTESTATION', record: null, checksNotPerformed: ['x'] });
  const input = baseInput(item);
  assert.deepEqual(summarizeAsset(input), summarizeAsset(input));
});
