// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Offline verification of the com.verify.app-attest assertion — the check
 * the badge always implied but nobody performed.
 *
 * The assertion carries everything needed (emulated key attestation):
 *   { format, attestationBase64, challengeBase64, boundFingerprint }
 *
 * We verify, fully offline:
 *   1. The x5c chain walks to the PINNED Apple App Attestation root
 *      (signatures, CA flags, validity at attestation-MINT time — Apple
 *      issues App Attest credential certificates with windows measured in
 *      days; the attestation is an enrollment-time artifact and is never
 *      re-dated by the signing time of the media it later vouches for).
 *   2. authData's rpIdHash is SHA-256 of our Apple App ID — the attestation
 *      was minted for a genuine Source Kit build, not another app.
 *   3. The nonce Apple signed into the leaf certificate's extension
 *      1.2.840.113635.100.8.2 equals
 *        SHA256(authData ‖ SHA256(challenge ‖ signingPublicKey))
 *      where signingPublicKey is the key in the manifest's own signing
 *      certificate — so Apple's hardware certificate vouches for THE key
 *      that signed this file, not some other key.
 *   4. boundFingerprint equals SHA-256 of that same signing key.
 *
 * Anything less than all four is reported as failed with the reason — a
 * forged or foreign attestation is evidence against the file, never noise.
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
  /** What was checked — surfaced verbatim in the verbose panel. */
  checksPerformed: string[];
  /**
   * Which Apple authenticator minted the attestation — 'production' or
   * 'development' (aaguid). Surfaced so the trust ladder can say which
   * environment vouches; null when absent or unparseable.
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
  // Expected shape: SEQUENCE { [1] { OCTET STRING (32) } } — but tolerate an
  // extra SEQUENCE layer inside [1]; require EXACTLY ONE 32-byte octet
  // string inside the extension, and only within context tag [1].
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
 * @param assertion  com.verify.app-attest payload — the decoded object
 *                   (0.20.4: our writer's 'json' boxes and the c2pa-swift
 *                   SDK's 'cbor' boxes decode to the SAME object upstream;
 *                   the carrier byte is not evidence) or raw content bytes
 *                   (undecodable carrier — parsed as JSON here so garbage
 *                   still fails red on parse merit). Null = absent.
 * @param signerPublicKey uncompressed point from the manifest's signing cert
 */
export function verifyAppAttestAssertion(
  assertion: Record<string, unknown> | Uint8Array | null,
  signerPublicKey: Uint8Array | null,
): AppAttestVerification {
  if (!assertion) return NOT_PRESENT;
  const checks: string[] = [];
  let attestationEnv: 'production' | 'development' | null = null;
  let mintWindow: { notBeforeMs: number; notAfterMs: number } | null = null;
  const fail = (reason: string): AppAttestVerification => ({ present: true, valid: false, reason, checksPerformed: checks, attestationEnv, mintWindow });

  let payload: { format?: string; attestationBase64?: string; challengeBase64?: string; boundFingerprint?: string };
  if (assertion instanceof Uint8Array) {
    try {
      payload = JSON.parse(bytesToUtf8(assertion));
    } catch {
      return fail('attestation assertion is not the expected JSON payload');
    }
  } else {
    // Pre-decoded (JSON or CBOR carrier — both land here as the same map).
    payload = assertion as typeof payload;
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

  // Chain validity is evaluated at attestation-MINT time, never at the
  // media's signing time. Apple issues App Attest credential certificates
  // with validity windows measured in days: the attestation is an
  // enrollment-time artifact, verified once at mint, and Apple does not
  // re-date it for the media it later vouches for. Checking the chain at the
  // TSA-anchored signing time therefore false-fails every genuine file
  // captured more than a few days after enrollment. The correct check: the
  // chain's validity windows must have a non-empty intersection — there existed a moment when
  // every link was simultaneously valid — and the short-lived leaf's window
  // bounds when Apple minted this attestation.
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

  // 2. rpIdHash binds the attestation to THIS app.
  const authData = new Uint8Array(att.authData);
  const rpIdOk = equalBytes(authData.subarray(0, 32), sha256(asciiToBytes(VERIFY_APPLE_APP_ID)));
  checks.push(`attestation minted for this app (rpIdHash = SHA-256 of ${VERIFY_APPLE_APP_ID})`);
  if (!rpIdOk) return fail('attestation was minted for a different app');

  // 2b. Attested credential data:
  //   aaguid(16) | credIdLen(2) | credId | credPublicKey(COSE)
  // The aaguid identifies a genuine Apple App Attest authenticator
  // (production vs development); the credential ID must be SHA-256 of the
  // credential key (Apple's construction); and the leaf certificate's key
  // must BE that credential key — binding the x5c chain to this authData,
  // which blocks mix-and-match of two genuine attestations.
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

  // 3. The nonce binds Apple's certificate to THE signing key of this file.
  // base64ToBytes is strict — a garbage challenge must fail
  // the attestation cleanly, never throw through the whole verification.
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
