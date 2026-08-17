// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * tsaTrustList — pinned time-stamping authorities. A valid RFC 3161
 * token proves only that SOME TSA signed it — anyone can run a TSA and mint
 * any genTime (e.g. to backdate a capture around a revocation) — so time
 * claims anchor only against this bundled pin list (SHA-256 over cert DER):
 * the C2PA TSA Trust List plus FreeTSA (root AND leaf pinned; the root
 * survives leaf rotation). Unpinned authorities still display as genuine but
 * never anchor roster/validity evaluation; stale pins fail safe, never error.
 */

export interface PinnedTsa {
  /** Display name (certificate subject CN / org). */
  name: string;
  /** SHA-256 of the certificate DER, lowercase hex. */
  certSha256: string;
  /** Provenance of the pin — where the certificate came from and when. */
  source: string;
}

const C2PA_SRC =
  'C2PA TSA Trust List (github.com/c2pa-org/conformance-public, trust-list/C2PA-TSA-TRUST-LIST.pem), pinned 2026-08-03';
const FREETSA_SRC =
  'freetsa.org published certificate (freetsa.org/files/tsa.crt, cacert.pem), pinned 2026-08-03';

export const PINNED_TSAS: PinnedTsa[] = [
  // --- C2PA TSA Trust List ---
  { name: 'Google C2PA Core Time-Stamping ICA G3', certSha256: '8376cbff1b9a621103e55759f926ff2253eea8913f7660a9cb5a3cdf59811b69', source: C2PA_SRC },
  { name: 'Google C2PA Pixel Time-Stamping ICA G3', certSha256: '98cd380e90ae4145f34baa2daee7f6da3dca01fa2a09e3abc3886885e1c1f12c', source: C2PA_SRC },
  { name: 'Google C2PA Root CA G3', certSha256: 'e383a91825ff2a0944857f2e0c1bebb3bdf84a3e430bb505fef8e4023ed8a3c7', source: C2PA_SRC },
  { name: 'SSL.com C2PA RSA Root CA 2025', certSha256: '4c8ad434e01f769ac96dffc9729d702a0f20e55d891ebd86443c5cc8c2fab47c', source: C2PA_SRC },
  { name: 'SSL.com C2PA ECC Root CA 2025', certSha256: '8a8b023beed955f5d337070568e3329a5e76ae9ed3f1821090f5605e1ffdb050', source: C2PA_SRC },
  { name: 'Trufo C2PA Root CA', certSha256: 'a09208ebd885d89c3fc6c32519d16a57509acc63f9ebcc0a4a094432daee1480', source: C2PA_SRC },
  { name: 'DigiCert RSA4096 TSA ICA for C2PA G1', certSha256: '0e31a1c77cd470d41c31be46c5da2488bcfdae1c6e7f63826de6a8ba4e9d215a', source: C2PA_SRC },
  { name: 'DigiCert ECC P384 TSA ICA for C2PA G1', certSha256: '6f74dc6db421ada40cff724ca949f586ed382130eef86da19f3c314b7ee44574', source: C2PA_SRC },
  { name: 'DigiCert ECC P384 Root for C2PA G1', certSha256: '795b3d3206e8066658b01bfd0dd8c5abbe47ffe8f1a0782ae1baeec7debb3bae', source: C2PA_SRC },
  { name: 'DigiCert RSA4096 Root for C2PA G1', certSha256: '0bb9164513ada25b47b92dee48f4ce31fb458097074fb0a35596938ededf4dc2', source: C2PA_SRC },
  { name: 'Irdeto C2PA Root CA G1', certSha256: '413b08353828bdb436fd6457fddab2bf5098a59a2182321111852377c69398f1', source: C2PA_SRC },
  { name: 'vivo Content Provenance and Authenticity Root CA', certSha256: '62e8faec4a1a7674a9437aa1affb20580615986e6c10a08d1aa093428aa087ab', source: C2PA_SRC },
  { name: 'Tauth Root CA', certSha256: 'f3ff22e4caac4cdf5c47dac08ccca0e71e415be8e9c00c3b7ad7e293469f8ec3', source: C2PA_SRC },
  { name: 'HUAWEI C2PA ECC384 Root CA E346', certSha256: 'a7bf75564e899940d3e8e8a85369b4efe3b92956bc58dd97302ef26e7345922d', source: C2PA_SRC },
  { name: 'Huanyu Trust C2PA EC-384 Root CA', certSha256: '8c32d62a262d2bc419bf2342cf03a95a19aef782a7d538ff98f5e974aee1e4c5', source: C2PA_SRC },
  { name: 'Snowball ECC P384 Root CA for C2PA G1', certSha256: 'c7c19abe03866247732df7c509caa8d6454af29a9c3a137afe77d37c4e0e68be', source: C2PA_SRC },
  { name: 'Snowball ECC P384 TSA ICA for C2PA G1', certSha256: '3916d5510e806bba5ed2850ed01948a8c62e41b134372d2777250afd87a9cc66', source: C2PA_SRC },
  { name: 'Encypher C2PA Root CA 2026', certSha256: 'a3a229e56b60cbc964e78e221fe9e6373048325240e4e20ea5ef52115bba826c', source: C2PA_SRC },
  { name: 'Encypher C2PA TSA Issuing CA 2026', certSha256: 'f10ef27b800604dd5ab41e02ef61398c8e59e621abcb3dae97533f2c395dbf99', source: C2PA_SRC },
  { name: 'TrustAsia C2PA RSA Root CA', certSha256: '67a5a52af341d284c188f0416bc38d91aec75b9f69d51643bd3430ec1f2ec07f', source: C2PA_SRC },
  { name: 'TrustAsia C2PA ECC Root CA', certSha256: '8cb6572df304ce2baf1d3e93fcb604d5eec8501feeac6af763efd4dd7aa4ecc5', source: C2PA_SRC },
  // --- FreeTSA (root + current leaf; the root survives leaf rotation) ---
  { name: 'FreeTSA Root CA (www.freetsa.org)', certSha256: 'a6379e7cecc05faa3cbf076013d745e327bbbaa38c0b9af22469d4701d18aabc', source: FREETSA_SRC },
  { name: 'FreeTSA (www.freetsa.org)', certSha256: '32e841a95cc1164101ffde41298ef2fc75c1c4372ef095e88a6bbd47dfb191fc', source: FREETSA_SRC },
];

/**
 * Returns the first pinned anchor matching ANY certificate fingerprint in a
 * token's chain (signer first), or null when the authority is unpinned.
 */
export function pinnedTsaFor(chainFingerprints: string[]): PinnedTsa | null {
  if (chainFingerprints.length === 0) return null;
  const seen = new Set(chainFingerprints.map((f) => f.toLowerCase()));
  return PINNED_TSAS.find((p) => seen.has(p.certSha256)) ?? null;
}
