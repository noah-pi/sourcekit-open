// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Custody ladder — rung 4 anchors receipts to signed bytes.
 *
 * signedPayload strips `ots` before signing, so record.ots.digestHex sits
 * outside the signature and a holder can set it to anything. The rule pinned
 * here: rung 4 verifies receipts against payloadDigest(record) — the value
 * rung 1 checked the signature over — and diverges when the record names a
 * different digest.
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-custody-ladder.mts
 */
import { sha256 } from '@noble/hashes/sha256';
import { buildRecord } from './manifest.mts';
import { signRecord, verifyRecordSignature, payloadDigest } from './sign.mts';
import { buildProofBundle } from './proofBundle.mts';
import { runCustodyLadder } from './reader-ladder.mts';
import { labSigner } from './deviceKey-shim.mts';
import { bytesToBase64, bytesToHex, utf8ToBytes } from './bytes.mts';
import type { AttestationRecord } from './manifest.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};

const key = labSigner();
const ctx = { capturedAtDeviceClock: new Date().toISOString() } as never;

const base = buildRecord({
  assetSha256: bytesToHex(sha256(utf8ToBytes('media-bytes'))),
  assetBytes: 11,
  mime: 'image/jpeg',
  kind: 'photo',
  capturedAt: new Date().toISOString(),
  appVersion: '0.10.0-lab',
  deviceModel: 'lab',
  platform: 'lab',
  identity: { author: 'Ladder Test', organization: null },
  context: ctx,
  publicKeyBase64: key.publicKeyBase64,
  fingerprint: key.fingerprint,
});

const signed = await signRecord(base, key.signDigest, key.signPayload);
const honestDigest = bytesToHex(payloadDigest(signed));

/** A receipt blob. Rung 4's digest gate runs before any receipt parsing. */
const receipt = bytesToBase64(utf8ToBytes('opentimestamps-receipt-bytes'));
const withOts = (digestHex: string): AttestationRecord => ({
  ...signed,
  ots: {
    digestHex,
    submissions: [{
      calendar: 'https://alice.btc.calendar.opentimestamps.org',
      receipt,
      state: 'pending' as const,
      submittedAt: new Date().toISOString(),
    }],
  },
});

const rung4 = (record: AttestationRecord) =>
  runCustodyLadder({ bundle: buildProofBundle(record, null), rosters: [] })
    .find((r) => r.rung === 4)!;

console.log('— the digest field is outside the signature —');

const forged = withOts('00'.repeat(32));
check('altering ots.digestHex leaves the record signature valid',
  verifyRecordSignature(forged).signatureValid,
  'if this fails the field is signed and the gate is unnecessary');
check('the record names a digest that is not its payload digest',
  forged.ots!.digestHex !== honestDigest);

console.log('— rung 4 anchors to signed bytes —');

const forgedRung = rung4(forged);
// State and reason together: a structurally broken receipt also diverges, so
// the state alone would pass even with the gate removed.
check('a mismatched anchor digest diverges, naming the digest as the reason',
  forgedRung.state === 'diverges' && /not the digest this record's signature covers/.test(forgedRung.detail),
  `${forgedRung.state} :: ${forgedRung.detail}`);

const honestRung = rung4(withOts(honestDigest));
check('a matching anchor digest passes the gate and goes on to the receipts',
  !/not the digest this record's signature covers/.test(honestRung.detail),
  honestRung.detail);

console.log('— no receipts is not a divergence —');
const bare = rung4(signed);
check('a record with no ledger receipts is insufficient, not divergent',
  bare.state === 'insufficient', `state was ${bare.state}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
