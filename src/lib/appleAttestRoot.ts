// Source Kit 0.1.0 — Apple App Attestation Root CA, pinned at build
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The Apple App Attestation Root CA, pinned at build time (DER, base64).
 *
 * Source: https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 * Serial: 0BF3BE0EF1CDD2E0FB8C6E721F621798 · valid 2020-03-18 → 2045-03-15 ·
 * P-384 self-signed root.
 *
 * Pinning matters: fetching the root over the network at verify time would
 * let a network attacker substitute their own "Apple" root and validate
 * anything. This is a trust anchor — it ships in the binary and is never
 * fetched. DER SHA-256:
 * 1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932
 */

import { base64ToBytes } from './bytes';

export const APPLE_ATTEST_ROOT_DER = base64ToBytes(
  'MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBs' +
  'ZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2Fs' +
  'aWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFw' +
  'cCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y' +
  'bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAH' +
  'GbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9T' +
  'gS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNV' +
  'HQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn' +
  '53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganm' +
  'rduC1bmTBGwD',
);

/**
 * The Apple App IDs an attestation may legitimately name.
 *
 * Attestation is bound to TEAM_ID.BUNDLE_ID: the rpIdHash in every genuine
 * attestation's authData is SHA-256 of one of these strings. Neither is a
 * secret — both appear in every attestation the corresponding build makes.
 *
 * There are two because the app ships as two: the App Store build and the
 * staging build that proves a release before it becomes one. They are
 * different apps to Apple, so they hold different App Attest keys and mint
 * attestations naming different App IDs. A verifier that knew only one of
 * them called every capture from the other "minted for a different app",
 * which was true of the string and false of the fact.
 *
 * The list is exact and closed. Matching is against these two values, never
 * against a prefix and never against whatever bundle the reading device
 * happens to be — a verifier that trusted its own identity could be made to
 * accept an attestation from any app at all.
 */
export const VERIFY_APPLE_APP_IDS = [
  '7L49FYJH6Q.com.verify.camera',
  '7L49FYJH6Q.com.verify.camera.staging',
] as const;

/** The App Store build's App ID — the canonical one, for anything that has
 *  to name a single app rather than test membership. */
export const VERIFY_APPLE_APP_ID = VERIFY_APPLE_APP_IDS[0];

/** Which of the recognized App IDs an rpIdHash names, or null for none.
 *  Returning the name rather than a boolean lets the report say which build
 *  sealed a capture instead of only that some Source Kit did. */
export function appIdForRpIdHash(rpIdHash: Uint8Array, sha256: (b: Uint8Array) => Uint8Array, ascii: (s: string) => Uint8Array): string | null {
  for (const id of VERIFY_APPLE_APP_IDS) {
    const want = sha256(ascii(id));
    if (rpIdHash.length === want.length && rpIdHash.every((b, i) => b === want[i])) return id;
  }
  return null;
}

/**
 * Domain separator for the per-capture App Attest assertion's clientDataHash:
 *
 *   SHA256(domain ‖ cleanFileSha256 ‖ signingPublicKey)
 *
 * Separate from the registration binding, which hashes a challenge instead,
 * so bytes Apple signed for one can never be presented as the other. Both
 * the capture path and the verifier read this constant.
 */
export const CAPTURE_ASSERTION_DOMAIN = 'sourcekit-capture-v1';
