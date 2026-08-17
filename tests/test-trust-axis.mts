// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The trust axis lives in the verification DATA MODEL,
 * not only in presentation. verifyPhotoBytes/verifyVideoBytes accept an
 * injected trustResolver and attach the outcome to report.signerTrust, so a
 * desk scripting against the verifier sees the same amber as the UI.
 *
 *  1. No resolver supplied      → signerTrust null, and the omission is
 *     DISCLOSED in checksNotPerformed (never silently green).
 *  2. Resolver, no anchors      → tier 'unknown' in the report itself; the
 *     performed-line states the amber is in the data.
 *  3. Resolver, own fingerprint → tier 'this-device'.
 *  4. Resolver THROWS           → signerTrust null, failure stated in
 *     checksNotPerformed (a broken anchor store can never turn amber green
 *     or red — it is disclosed).
 *  5. Resolver input contract   → fingerprint equals the lab signer's,
 *     verifiedAtMs null without a pinned time authority, orgChain null for
 *     a single-cert chain.
 */
import * as fs from 'node:fs';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from './bytes.mts';
import { buildSelfSignedCert } from './cert.mts';
import { buildC2paSegment } from './c2pa.mts';
import { verifyPhotoBytes } from './verifyAsset.mts';
import { labSigner } from './deviceKey-shim.mts';
import { resolveSignerTrust } from './trustProvider.mts';
import type { SignerTrust } from './trustProvider.mts';

const key = labSigner();
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const devCert = await buildSelfSignedCert(
  Uint8Array.from(atob(key.publicKeyBase64), (c) => c.charCodeAt(0)),
  key.signDigest, new Date(Date.now() - 60_000));
const clean = new Uint8Array(fs.readFileSync('/tmp/lab/clean.jpg'));

const segment = await buildC2paSegment({
  appName: 'ExhibitA/0.11.0-lab',
  mime: 'image/jpeg',
  title: 'trust-axis.jpg',
  instanceId: 'xmp:iid:' + bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16)),
  telemetry: { format: 'lab', note: 'trust axis seam test' },
  signDigest: key.signDigest,
  signPayload: key.signPayload,
  certChain: [devCert],
  cleanFileSha256: sha256(clean),
}, 2);
const signed = concatBytes(clean.subarray(0, 2), segment, clean.subarray(2));
fs.writeFileSync('/tmp/lab/trust-axis-signed.jpg', signed);

// ---------- 1. no resolver → null + disclosed ----------
const bare = await verifyPhotoBytes(signed);
check('verdict INTACT (the bytes are honest — trust is a separate axis)', bare.verdict === 'INTACT', bare.verdict);
check('no resolver: signerTrust null', bare.signerTrust === null || bare.signerTrust === undefined);
check(
  'no resolver: UNRESOLVED disclosed in checksNotPerformed',
  (bare.checksNotPerformed ?? []).some((l) => l.includes('UNRESOLVED') && l.includes('no resolver')),
  JSON.stringify(bare.checksNotPerformed));

// ---------- resolver input contract (capture what the verifier passes) ----------
let seen: { fingerprint: string; verifiedAtMs: number | null; orgChain: unknown } | null = null;
const captureResolver = (input: { fingerprint: string; verifiedAtMs: number | null; orgChain: never }) => {
  seen = input;
  return resolveSignerTrust({ ...input, ownFingerprint: null });
};
await verifyPhotoBytes(signed, { trustResolver: captureResolver });
check('resolver received the lab signer fingerprint', seen !== null && (seen as { fingerprint: string }).fingerprint === key.fingerprint,
  `${(seen as { fingerprint: string } | null)?.fingerprint} vs ${key.fingerprint}`);
check('resolver received verifiedAtMs null (no pinned time authority in fixture)',
  seen !== null && (seen as { verifiedAtMs: number | null }).verifiedAtMs === null);
check('resolver received orgChain null (single-cert chain)',
  seen !== null && (seen as { orgChain: unknown }).orgChain === null);

// ---------- 2. resolver, no anchors → 'unknown' in the data ----------
const unknown = await verifyPhotoBytes(signed, {
  trustResolver: (input) => resolveSignerTrust({ ...input, ownFingerprint: null }),
});
check('resolver, no anchors: tier unknown IN THE REPORT', unknown.signerTrust?.tier === 'unknown',
  String(unknown.signerTrust?.tier));
check(
  'performed-line states the amber is in the data, not just the UI',
  (unknown.checksPerformed ?? []).some((l) => l.includes('unknown') && l.includes('in the data')),
  JSON.stringify(unknown.checksPerformed));

// ---------- 3. resolver, own fingerprint → 'this-device' ----------
const own = await verifyPhotoBytes(signed, {
  trustResolver: (input) => resolveSignerTrust({ ...input, ownFingerprint: key.fingerprint }),
});
check('own fingerprint: tier this-device', own.signerTrust?.tier === 'this-device', String(own.signerTrust?.tier));

// ---------- 4. resolver throws → null + disclosed ----------
const threw = await verifyPhotoBytes(signed, {
  trustResolver: (): SignerTrust => { throw new Error('anchor store on fire'); },
});
check('resolver threw: signerTrust null (never guessed)', threw.signerTrust === null || threw.signerTrust === undefined);
check(
  'resolver threw: failure stated in checksNotPerformed',
  (threw.checksNotPerformed ?? []).some((l) => l.includes('resolver threw')),
  JSON.stringify(threw.checksNotPerformed));
check('resolver threw: verdict still INTACT (trust failure cannot touch byte math)', threw.verdict === 'INTACT', threw.verdict);

console.log(`\ntrust-axis: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
