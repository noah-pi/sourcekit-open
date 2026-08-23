// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Offline verification of the com.verify.app-attest assertion. The payload
 * is { format, attestationBase64, challengeBase64, boundFingerprint }.
 *
 * Four checks, all offline:
 *   1. The x5c chain walks to the pinned Apple App Attestation root
 *      (signatures, CA flags, validity at attestation-mint time).
 *   2. authData's rpIdHash is SHA-256 of the Apple App ID.
 *   3. The nonce in leaf extension 1.2.840.113635.100.8.2 equals
 *        SHA256(authData ‖ SHA256(challenge ‖ signingPublicKey))
 *      where signingPublicKey comes from the manifest's signing cert.
 *   4. boundFingerprint equals SHA-256 of that same signing key.
 *
 * Any failure returns valid:false with the reason.
 */

import { decode } from 'cbor-x';
import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToHex, bytesToUtf8, concatBytes, equalBytes } from '../../src/lib/bytes';
import { asciiToBytes } from '../../src/lib/bytes';
import { APPLE_ATTEST_ROOT_DER, VERIFY_APPLE_APP_ID } from '../../src/lib/appleAttestRoot';
import { parseCertificate, readTlv, verifyChain, OID_APPLE_ATTEST_NONCE } from '../../src/lib/x509';

export interface AppAttestVerification {
  present: boolean;
  /** All checks passed. False whenever present but anything failed. */
  valid: boolean;
  /** Plain-English outcome for the report (null when valid). */
  reason: string | null;
  /** What was checked; surfaced verbatim in the verbose panel. */
  checksPerformed: string[];
  /**
   * Which Apple authenticator minted the attestation, from the aaguid.
   * Null when absent or unparseable.
   */
  attestationEnv: 'production' | 'development' | null;
  /**
   * The window in which Apple minted this attestation: the intersection of
   * the x5c chain's validity windows, bounded by the short-lived leaf.
   * Null when not computed.
   */
  mintWindow: { notBeforeMs: number; notAfterMs: number } | null;
}

const NOT_PRESENT: AppAttestVerification = { present: false, valid: false, reason: null, checksPerformed: [], attestationEnv: null, mintWindow: null };

/** Extracts the 32-byte nonce from the Apple extension's extnValue. */
function extractAppleNonce(extnValue: Uint8Array): Uint8Array | null {
  // Shape: SEQUENCE { [1] { OCTET STRING (32) } }, tolerating an extra
  // SEQUENCE inside [1]. Requires exactly one 32-byte octet string, and
  // only within context tag [1].
  const found: Uint8Array[] = [];
  const walk = (b: Uint8Array, insideA1: boolean): void => {
    let o = 0;
    while (o < b.length) {
      let tlv;
      try { tlv = readTlv(b, o); } catch { return; }
      o = tlv.next;
      if (tlv.tag === 0x04 && insideA1 && tlv.content.length === 32) found.push(tlv.content);
      else if (tlv.tag === 0xa1) walk(tlv.content, true);
      else if (tlv.tag === 0x30) walk(tlv.content, insideA1);
    }
  };
  walk(extnValue, false);
  return found.length === 1 ? found[0] : null;
}

/**
 * @param assertionBytes  raw json-box content of com.verify.app-attest (null when absent)
 * @param signerPublicKey uncompressed point from the manifest's signing cert
 */
export function verifyAppAttestAssertion(
  assertionBytes: Uint8Array | null,
  signerPublicKey: Uint8Array | null,
): AppAttestVerification {
  if (!assertionBytes) return NOT_PRESENT;
  const checks: string[] = [];
  let attestationEnv: 'production' | 'development' | null = null;
  let mintWindow: { notBeforeMs: number; notAfterMs: number } | null = null;
  const fail = (reason: string): AppAttestVerification => ({ present: true, valid: false, reason, checksPerformed: checks, attestationEnv, mintWindow });

  let payload: { format?: string; attestationBase64?: string; challengeBase64?: string; boundFingerprint?: string };
  try {
    payload = JSON.parse(bytesToUtf8(assertionBytes));
  } catch {
    return fail('attestation assertion is not the expected JSON payload');
  }
  if (payload.format !== 'exhibit-app-attest/2' || !payload.attestationBase64 || !payload.challengeBase64 || !payload.boundFingerprint) {
    return fail('attestation assertion has an unrecognized format');
  }
  if (!signerPublicKey) return fail('no signer public key to bind against');

  // 1. Parse the attestation object and walk its chain to the pinned root.
  let att: { fmt?: string; attStmt?: { x5c?: unknown[] }; authData?: Uint8Array };
  try {
    att = decode(base64ToBytes(payload.attestationBase64)) as typeof att;
  } catch {
    return fail('attestation object is not valid CBOR');
  }
  if (att.fmt !== 'apple-appattest') return fail('not an apple-appattest statement');
  const x5c = att.attStmt?.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2 || !att.authData) return fail('attestation is missing its certificate chain or authData');

  const chain = verifyChain(x5c.map((c) => new Uint8Array(c as Uint8Array)), [APPLE_ATTEST_ROOT_DER], null);
  checks.push(`Apple certificate chain → pinned Apple App Attestation root (${chain.linkCount} certs)`);
  if (!chain.linksValid) return fail(`Apple certificate chain broken: ${chain.reason}`);
  if (!chain.anchored) return fail('certificate chain does not reach the Apple App Attestation root');

  // Chain validity is evaluated at attestation-mint time, not at the media's
  // signing time: Apple's App Attest credential certs live for days, so
  // checking at the TSA-anchored signing time false-fails any file captured
  // after enrollment. The check is that the chain's validity windows
  // intersect; the short-lived leaf bounds the mint window.
  let mintEarliest = -Infinity;
  let mintLatest = Infinity;
  for (const c of x5c) {
    let pc;
    try {
      pc = parseCertificate(new Uint8Array(c as Uint8Array));
    } catch {
      return fail('a certificate in the attestation chain failed to parse');
    }
    if (pc.notBeforeMs > mintEarliest) mintEarliest = pc.notBeforeMs;
    if (pc.notAfterMs < mintLatest) mintLatest = pc.notAfterMs;
  }
  if (!(mintEarliest <= mintLatest)) {
    return fail('attestation certificates were never simultaneously valid — not a genuine Apple issuance');
  }
  mintWindow = { notBeforeMs: mintEarliest, notAfterMs: mintLatest };
  checks.push(
    `chain valid at attestation-mint time — the chain-wide validity intersection (${new Date(mintEarliest).toISOString().slice(0, 10)} → ${new Date(mintLatest).toISOString().slice(0, 10)}) bounds when Apple minted this attestation; an enrollment artifact is not re-dated by the media's signing time`,
  );

  // 2. rpIdHash binds the attestation to this app. An unset app id cannot
  // establish that binding, so the check fails rather than passing vacuously.
  const authData = new Uint8Array(att.authData);
  if (!VERIFY_APPLE_APP_ID) {
    return fail('app id is not configured in this build (VERIFY_APPLE_APP_ID in src/lib/appleAttestRoot.ts), so the attestation cannot be bound to an app');
  }
  const rpIdOk = equalBytes(authData.subarray(0, 32), sha256(asciiToBytes(VERIFY_APPLE_APP_ID)));
  checks.push(`attestation minted for this app (rpIdHash = SHA-256 of ${VERIFY_APPLE_APP_ID})`);
  if (!rpIdOk) return fail('attestation was minted for a different app');

  // 2b. Attested credential data:
  //   aaguid(16) | credIdLen(2) | credId | credPublicKey(COSE)
  // aaguid names the authenticator (production or development), credId must
  // be SHA-256 of the credential key, and the leaf cert's key must be that
  // credential key. The last binding blocks mixing two genuine attestations.
  if (authData.length < 55) return fail('authData too short for attested credential data');
  const flags = authData[32];
  if (!(flags & 0x40)) return fail('attested credential data flag not set in authData');
  const aaguid = authData.subarray(37, 53);
  const isProd = equalBytes(aaguid, concatBytes(asciiToBytes('appattest'), new Uint8Array(7)));
  const isDev = equalBytes(aaguid, asciiToBytes('appattestdevelop'));
  if (!isProd && !isDev) return fail('unrecognized aaguid — not an Apple App Attest authenticator');
  attestationEnv = isProd ? 'production' : 'development';
  checks.push(`genuine Apple App Attest authenticator (aaguid: ${isProd ? 'production build' : 'development build'})`);
  const credIdLen = (authData[53] << 8) | authData[54];
  const credId = authData.subarray(55, 55 + credIdLen);
  let credPub: Uint8Array;
  try {
    const credKey = decode(authData.subarray(55 + credIdLen)) as Map<number, unknown> | Record<string, unknown>;
    const get = (m: Map<number, unknown> | Record<string, unknown>, k: number) =>
      (m instanceof Map ? m.get(k) : m[String(k)]) as Uint8Array | undefined;
    const cx = get(credKey, -2), cy = get(credKey, -3);
    if (!cx || !cy || cx.length !== 32 || cy.length !== 32) throw new Error('bad point');
    credPub = concatBytes(new Uint8Array([0x04]), cx, cy);
  } catch {
    return fail('credential public key in authData is not a valid COSE P-256 key');
  }
  if (!equalBytes(credId, sha256(credPub))) {
    return fail('credential ID is not SHA-256 of the credential public key');
  }
  checks.push('credential ID = SHA-256 of the attested key (authData internally consistent)');

  // 3. The nonce binds Apple's certificate to this file's signing key.
  // base64ToBytes is strict, so a garbage challenge is caught here rather
  // than thrown out of the whole verification.
  let clientDataHash: Uint8Array;
  try {
    clientDataHash = sha256(concatBytes(base64ToBytes(payload.challengeBase64), signerPublicKey));
  } catch {
    return fail('attestation challenge is not valid base64');
  }
  const expectedNonce = sha256(concatBytes(authData, clientDataHash));
  let leaf;
  try {
    leaf = parseCertificate(new Uint8Array(x5c[0] as Uint8Array));
  } catch {
    return fail('attestation leaf certificate failed to parse');
  }
  if (leaf.keyAlg.kind !== 'ec' || !equalBytes(leaf.keyAlg.point, credPub)) {
    return fail('attestation certificate key does not match the attested credential key');
  }
  checks.push('attestation certificate and authData vouch for the same Apple hardware key');
  const ext = leaf.extensions.get(OID_APPLE_ATTEST_NONCE);
  if (!ext) return fail('Apple nonce extension missing from the attestation certificate');
  const nonce = extractAppleNonce(ext.value);
  checks.push('Apple-signed nonce extension parsed from the attestation certificate (real DER, not substring match)');
  if (!nonce) return fail('could not parse a unique nonce from the Apple extension');
  if (!equalBytes(nonce, expectedNonce)) {
    return fail("attestation is not bound to this file's signing key (nonce mismatch)");
  }
  checks.push('nonce = SHA256(authData ‖ SHA256(challenge ‖ signing key)) — Apple vouches for THE key that signed this file');

  // 4. The declared fingerprint matches the signing key.
  const fpOk = payload.boundFingerprint === bytesToHex(sha256(signerPublicKey));
  checks.push('bound fingerprint equals SHA-256 of the manifest signing key');
  if (!fpOk) return fail('bound fingerprint does not match the signing key');

  return { present: true, valid: true, reason: null, checksPerformed: checks, attestationEnv, mintWindow };
}
