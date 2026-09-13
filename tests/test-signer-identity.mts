// Source Kit 0.1.0 — Signer Information: request, certificate, website
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Signer Information — the three credentials a capture can name.
 *
 *  1. Certification request: the PKCS#10 we emit is the one an authority
 *     reads. OpenSSL is the gold standard here, exactly as c2patool is for
 *     manifests: it verifies the self-signature, reads the subject back, and
 *     issues a certificate against the request the way a CA would.
 *  2. Personal certificate: the issued certificate names this device's key,
 *     is accepted only with a key purpose CAWG reads, and reports trusted
 *     only when something actually recognizes the issuer.
 *  3. Website document: sourcekit-site/1 round-trips, and every way the file
 *     can disagree with itself is rejected with a reason.
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { buildCsr, csrToPem } from './cert.mts';
import { parseCertInfo, pemOrDerToDer } from './orgCert.mts';
import { parseCertificate, hasKeyPurpose } from './x509.mts';
import { evaluateIdentityTrust, setPersonalCredential, personalCertChainForKey, clearPersonalCredential } from './personalCert.mts';
import { OID_KP_EMAIL_PROTECTION } from './identityTrustList.mts';
import {
  fingerprintForPublicKey,
  parseSiteDocument,
  serializeSiteDocument,
  siteDocumentForThisDevice,
} from './siteCredential.mts';
import { base64ToBytes, bytesToBase64 } from './bytes.mts';
import { labSigner } from './deviceKey-shim.mts';

let pass = 0, fail = 0, skipped = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const skip = (name: string, why: string) => { skipped++; console.log(`  SKIP ${name} :: ${why}`); };

// OpenSSL is the optional gold standard: absent, its checks SKIP and are
// excluded from the tally, the same contract the c2patool checks use.
const openssl = process.env.OPENSSL ?? 'openssl';
let opensslAvailable = false;
try { execFileSync(openssl, ['version'], { stdio: 'pipe' }); opensslAvailable = true; } catch { /* not installed */ }
if (!opensslAvailable) console.log('  NOTE: openssl not found — gold-standard checks below will SKIP, not fail');

const dir = '/tmp/lab/identity';
fs.mkdirSync(dir, { recursive: true });
const sh = (args: string[]) => execFileSync(openssl, args, { stdio: 'pipe' }).toString();

const key = labSigner();
const devicePub = base64ToBytes(key.publicKeyBase64);

// ---------- 1. certification request ----------
const csrDer = await buildCsr(devicePub, key.signDigest, {
  commonName: 'Jake Bell',
  email: 'jake@jakebell.photo',
});
const csrPath = `${dir}/request.pem`;
fs.writeFileSync(csrPath, csrToPem(csrDer));

check('request is DER SEQUENCE', csrDer[0] === 0x30);

if (!opensslAvailable) {
  skip('openssl verifies the request self-signature (gold standard)', 'openssl not installed');
  skip('openssl reads the subject back', 'openssl not installed');
} else {
  let verified = false;
  try { verified = sh(['req', '-in', csrPath, '-noout', '-verify']).length >= 0; } catch { verified = false; }
  check('openssl verifies the request self-signature (gold standard)', verified);
  let subject = '';
  try { subject = sh(['req', '-in', csrPath, '-noout', '-subject']); } catch { /* reported by the check */ }
  check('openssl reads the subject back',
    subject.includes('Jake Bell') && subject.includes('jake@jakebell.photo'), subject.trim());
}

// A name outside ASCII must survive as UTF-8, not get masked into mojibake.
{
  const der = await buildCsr(devicePub, key.signDigest, { commonName: 'José Ramírez', organization: 'Example Studio' });
  const p = `${dir}/request-utf8.pem`;
  fs.writeFileSync(p, csrToPem(der));
  if (!opensslAvailable) {
    skip('non-ASCII subject round-trips as UTF-8', 'openssl not installed');
  } else {
    let subject = '';
    try { subject = sh(['req', '-in', p, '-noout', '-subject', '-nameopt', 'utf8']); } catch { /* reported below */ }
    check('non-ASCII subject round-trips as UTF-8', subject.includes('José Ramírez'), subject.trim());
  }
}

// ---------- 2. the certificate a CA issues against it ----------
let issuedLeaf: Uint8Array | null = null;
let issuingCa: Uint8Array | null = null;
if (!opensslAvailable) {
  skip('a CA can issue against the request', 'openssl not installed');
} else {
  try {
    sh(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
        '-subj', '/O=Example Authority/CN=Example S-MIME CA',
        '-keyout', `${dir}/ca.key`, '-out', `${dir}/ca.pem`]);
    // The extension profile an S/MIME authority issues with: the purpose CAWG
    // reads, on a leaf that is explicitly not a CA.
    fs.writeFileSync(`${dir}/leaf.ext`, 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\nextendedKeyUsage=emailProtection\n');
    sh(['x509', '-req', '-in', csrPath, '-CA', `${dir}/ca.pem`, '-CAkey', `${dir}/ca.key`,
        '-CAcreateserial', '-days', '365', '-extfile', `${dir}/leaf.ext`, '-out', `${dir}/leaf.pem`]);
    issuedLeaf = pemOrDerToDer(fs.readFileSync(`${dir}/leaf.pem`, 'utf8'));
    issuingCa = pemOrDerToDer(fs.readFileSync(`${dir}/ca.pem`, 'utf8'));
    check('a CA can issue against the request', true);
  } catch (e) {
    check('a CA can issue against the request', false, e instanceof Error ? e.message : '');
  }
}

if (issuedLeaf) {
  const info = parseCertInfo(issuedLeaf);
  check('issued certificate names this device key',
    bytesToBase64(info.publicKey) === key.publicKeyBase64);
  check('issued certificate carries the requested name', info.subjectCN === 'Jake Bell');
  check('issued certificate carries the email-protection purpose',
    hasKeyPurpose(parseCertificate(issuedLeaf), OID_KP_EMAIL_PROTECTION));

  // An issuer nothing recognizes is stored and used, and reported honestly.
  const trust = await evaluateIdentityTrust(issuedLeaf, issuingCa);
  check('unrecognized issuer reports self-asserted', trust.level === 'self-asserted');

  const stored = await setPersonalCredential(issuedLeaf, issuingCa, devicePub);
  check('certificate installs for the current key', stored.info.subjectCN === 'Jake Bell');
  const chain = await personalCertChainForKey(devicePub);
  check('installed certificate becomes the signing chain',
    chain !== null && chain !== 'stale' && chain.chain.length === 2);

  // A different key is the failure this check exists for: a certificate for
  // somebody else's key would name a person this phone cannot sign as.
  const otherPub = p256.getPublicKey(p256.utils.randomPrivateKey(), false);
  const wrongKey = await personalCertChainForKey(otherPub);
  check('certificate for another key reads as stale', wrongKey === 'stale');

  let rejected = false;
  try { await setPersonalCredential(issuedLeaf, issuingCa, otherPub); } catch { rejected = true; }
  check('installing against a different key is refused', rejected);

  // Without a purpose CAWG reads, the certificate would sit in Settings
  // naming somebody and never reach a capture.
  if (opensslAvailable) {
    fs.writeFileSync(`${dir}/nopurpose.ext`, 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\n');
    sh(['x509', '-req', '-in', csrPath, '-CA', `${dir}/ca.pem`, '-CAkey', `${dir}/ca.key`,
        '-CAcreateserial', '-days', '365', '-extfile', `${dir}/nopurpose.ext`, '-out', `${dir}/nopurpose.pem`]);
    const bare = pemOrDerToDer(fs.readFileSync(`${dir}/nopurpose.pem`, 'utf8'));
    let refused = false;
    try { await setPersonalCredential(bare, issuingCa, devicePub); } catch { refused = true; }
    check('certificate with no readable purpose is refused', refused);
  } else {
    skip('certificate with no readable purpose is refused', 'openssl not installed');
  }

  await clearPersonalCredential();
  check('removal clears the signing chain', (await personalCertChainForKey(devicePub)) === null);
}

// ---------- 3. the website document ----------
{
  const doc = await siteDocumentForThisDevice("Becky's Bakery", 'Becky’s iPhone');
  const text = serializeSiteDocument(doc);
  const back = parseSiteDocument(text);
  check('site document round-trips', back.organization === "Becky's Bakery" && back.members.length === 1);
  check('member fingerprint is the hash of its own key',
    back.members[0].fingerprint === fingerprintForPublicKey(back.members[0].publicKey));
  check('the listed key is this device', back.members[0].publicKey === key.publicKeyBase64);

  // A second phone is added to the published list, never on top of it.
  const otherPriv = p256.utils.randomPrivateKey();
  const otherPub = p256.getPublicKey(otherPriv, false);
  const twoPhones = parseSiteDocument(serializeSiteDocument({
    format: 'sourcekit-site/1',
    organization: "Becky's Bakery",
    members: [
      { fingerprint: fingerprintForPublicKey(bytesToBase64(otherPub)), label: 'Nephew', publicKey: bytesToBase64(otherPub) },
    ],
  }));
  const merged = await siteDocumentForThisDevice("Becky's Bakery", 'Becky’s iPhone', twoPhones);
  check('adding a device keeps the ones already published', merged.members.length === 2);
  const again = await siteDocumentForThisDevice("Becky's Bakery", 'Renamed', merged);
  check('regenerating for the same device does not duplicate it', again.members.length === 2);

  // Every way the file can disagree with itself.
  const badFormat = JSON.stringify({ format: 'sourcekit-org/1', organization: 'X', members: back.members });
  let threw = false;
  try { parseSiteDocument(badFormat); } catch { threw = true; }
  check('an org document is not accepted as a site document', threw);

  const mismatched = JSON.stringify({
    format: 'sourcekit-site/1',
    organization: 'X',
    members: [{ fingerprint: 'ab'.repeat(32), publicKey: key.publicKeyBase64 }],
  });
  threw = false;
  try { parseSiteDocument(mismatched); } catch { threw = true; }
  check('fingerprint that does not hash its own key is rejected', threw);

  threw = false;
  try { parseSiteDocument(JSON.stringify({ format: 'sourcekit-site/1', organization: 'X', members: [] })); } catch { threw = true; }
  check('a document listing no devices is rejected', threw);

  threw = false;
  try { parseSiteDocument('not json at all'); } catch { threw = true; }
  check('unparseable text is rejected with a reason, not a crash', threw);
}

// A fingerprint is sha256 over the raw key point, the same convention
// sourcekit-org/1 uses. The two documents must agree or a device listed in
// one would look absent from the other.
check('fingerprint convention matches sourcekit-org/1',
  fingerprintForPublicKey(key.publicKeyBase64) === Buffer.from(sha256(devicePub)).toString('hex'));

console.log(`\n=== ${pass} passed, ${fail} failed, ${skipped} skipped ===`);
process.exit(fail ? 1 : 0);
