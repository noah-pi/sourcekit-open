// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Apple App Attestation Root CA, pinned at build time (DER, base64).
 *
 * Source: https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 * Serial: 0BF3BE0EF1CDD2E0FB8C6E721F621798 · valid 2020-03-18 → 2045-03-15 ·
 * P-384 self-signed root. DER SHA-256:
 * 1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932
 *
 * Trust anchor: it ships in the binary and is never fetched, so a network
 * attacker cannot substitute their own root at verify time.
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
 * App ID that attestation is bound to (TEAM_ID.BUNDLE_ID). rpIdHash in a
 * genuine attestation's authData is SHA-256 of this string. Not a secret.
 */
export const VERIFY_APPLE_APP_ID = '7L49FYJH6Q.com.verify.camera';
