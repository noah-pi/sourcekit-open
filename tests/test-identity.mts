// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Org identity assertion (com.verify.identity). The org-credential install path
 * needs SecureStore, so this drives the C2PA seam directly: buildC2paSegment
 * with an identity param and a two-cert chain, as embedC2paInJpeg assembles it
 * when identityAssertionFor fires (chain > 1 plus record.orgCredential).
 *
 *  1. Emission: assertion box exists, claim references it, parse recovers
 *     org/role/hash, telemetryHashMatches is true.
 *  2. Reporting: verifyPhotoBytes prints the verified line when the org name
 *     matches the chain top, the MISMATCH line when it does not.
 *  3. Tamper: a forged binding reference fails telemetryHashMatches.
 *  4. Neutrality: no identity param gives no assertion and no lines; a deID
 *     copy carries no assertion (ephemeral chain) and still verifies.
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from './bytes.mts';
import { buildSelfSignedCert } from './cert.mts';
import { buildC2paSegment, extractC2paStore, parseManifest, verifyManifest } from './c2pa.mts';
import { deidentifyPhoto } from './attest.mts';
import { verifyPhotoBytes } from './verifyAsset.mts';
import { labSigner } from './deviceKey-shim.mts';

const key = labSigner();
let pass = 0, fail = 0, skipped = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const skip = (name: string, why: string) => { skipped++; console.log(`  SKIP ${name} :: ${why}`); };
// c2patool is the optional gold standard: when absent its checks SKIP and are
// excluded from the pass/fail tally. See README ▸ Requirements.
const c2patoolBin = process.env.C2PATOOL ?? 'c2patool';
let c2patoolAvailable = false;
try { execFileSync(c2patoolBin, ['--version'], { stdio: 'pipe' }); c2patoolAvailable = true; } catch { /* not installed */ }
if (!c2patoolAvailable) console.log('  NOTE: c2patool not found — gold-standard checks below will SKIP, not fail');

// Two certs: the device leaf plus a stand-in "org" cert. Chain validity is the
// x509 suite's job; this one covers the assertion seam.
const devCert = await buildSelfSignedCert(
  Uint8Array.from(atob(key.publicKeyBase64), (c) => c.charCodeAt(0)),
  key.signDigest, new Date(Date.now() - 60_000));
const fakeCaPriv = p256.utils.randomPrivateKey();
const fakeCaCert = await buildSelfSignedCert(
  p256.getPublicKey(fakeCaPriv, false),
  async (d) => p256.sign(d, fakeCaPriv, { lowS: true }).toDERRawBytes(),
  new Date(Date.now() - 60_000));

const clean = new Uint8Array(fs.readFileSync('/tmp/lab/clean.jpg'));

async function signJpegWithIdentity(org: string | null): Promise<Uint8Array> {
  const segment = await buildC2paSegment({
    appName: 'ExhibitA/0.10.0-lab',
    mime: 'image/jpeg',
    title: 'identity-test.jpg',
    instanceId: 'xmp:iid:' + bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16)),
    telemetry: { format: 'lab', note: 'identity seam test' },
    signDigest: key.signDigest,
    signPayload: key.signPayload,
    certChain: [devCert, fakeCaCert],
    cleanFileSha256: sha256(clean),
    identity: org ? { org, role: 'organization' } : null,
  }, 2);
  return concatBytes(clean.subarray(0, 2), segment, clean.subarray(2));
}

// ---------- 1. emission + binding ----------
// The lab cert builder hardcodes the chain top's org (Source Kit) and the
// cross-check requires the assertion to match it, so the lab identity uses the
// same org.
const signed = signJpegWithIdentity ? await signJpegWithIdentity('Source Kit') : null;
fs.writeFileSync('/tmp/lab/identity-signed.jpg', signed);
const store = extractC2paStore(signed);
check('store extracts from identity-bearing JPEG', !!store);
const m = store ? parseManifest(store.payload) : null;
check('manifest parses', !!m);
check('identity assertion parsed', !!m?.identity && m.identity.org === 'Source Kit' && m.identity.role === 'organization');
const v = m ? verifyManifest(signed, m) : null;
check('claim ↔ assertion binding holds with the new box', !!v?.claimAssertionsMatch);
check('identity telemetry hash matches', v?.identity?.telemetryHashMatches === true);
check('manifest signature still valid', v?.signatureValid === true);
check('asset hash still binds', v?.assetHashMatches === true);
if (!c2patoolAvailable) {
  skip('c2patool accepts the identity-bearing JPEG (gold standard)', 'c2patool not installed');
} else try {
  execFileSync(c2patoolBin, ['/tmp/lab/identity-signed.jpg'], { stdio: 'pipe' });
  check('c2patool accepts the identity-bearing JPEG (gold standard)', true);
} catch {
  check('c2patool accepts the identity-bearing JPEG (gold standard)', false);
}

// ---------- 2. reporting ----------
{
  const report = await verifyPhotoBytes(signed);
  check('identity-bearing photo verifies INTACT', report.verdict === 'INTACT', `got ${report.verdict}`);
  check('verified line printed (org matches chain top)',
    report.checksPerformed.some((l) => l.includes('org identity assertion verified: "Source Kit"')));
  check('identity-is-not-truthfulness limit disclosed',
    report.checksNotPerformed.some((l) => l.includes('identity is not truthfulness')));

  const mismatched = await signJpegWithIdentity('The Lab Gazette');
  const mReport = await verifyPhotoBytes(mismatched);
  check('org↔chain mismatch is loud',
    mReport.checksPerformed.some((l) => l.includes('MISMATCH') && l.includes('The Lab Gazette')));
  check('mismatch does not flip the integrity verdict', mReport.verdict === 'INTACT');
}

// ---------- 3. tamper branches ----------
if (m && v) {
  const forged = { ...m, identity: { org: 'Source Kit', role: 'organization', referencedTelemetryHashHex: 'ff'.repeat(32) } };
  const fv = verifyManifest(signed, forged);
  check('forged binding reference fails the hash check', fv.identity?.telemetryHashMatches === false);
}

// ---------- 4. neutrality ----------
{
  const plain = await signJpegWithIdentity(null);
  const pm = parseManifest(extractC2paStore(plain)!.payload);
  const pv = verifyManifest(plain, pm!);
  check('no identity param → no assertion', pm?.identity === null && pv.identity === null);
  const pReport = await verifyPhotoBytes(plain);
  check('absence is neutral — no identity lines, INTACT',
    pReport.verdict === 'INTACT' && !pReport.checksPerformed.some((l) => l.includes('identity assertion')));

  // deID copy of an identity-bearing original: ephemeral chain, no assertion.
  const d = await deidentifyPhoto({ photoUri: '/tmp/lab/identity-signed.jpg', key, capturedAt: new Date().toISOString() });
  const dm = parseManifest(extractC2paStore(d.signedPhotoBytes)!.payload);
  check('deID copy carries NO identity assertion', dm?.identity === null);
  const dReport = await verifyPhotoBytes(d.signedPhotoBytes);
  check('deID copy still verifies INTACT', dReport.verdict === 'INTACT');
}

console.log(`\n=== ${pass} passed, ${fail} failed, ${skipped} skipped ===`);
process.exit(fail ? 1 : 0);
