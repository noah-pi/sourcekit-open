// Source Kit 0.1.0 — anchors for the certificate that signs a manifest
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * signerTrustList — anchors for the certificate that signs a manifest,
 * SHA-256 over cert DER, the same shape as tsaTrustList.
 *
 * A chain this verifier can walk proves structure. Whether the root is one
 * anybody vouches for is a separate fact, and it comes from a published
 * list: the C2PA Trust List, and the interim known-certificate list the
 * Content Credentials Verify site uses until the C2PA publishes a public
 * one. A signer that chains to an anchor here reads as verified; one that
 * does not reads as a certificate, named, and nothing more.
 */

export interface PinnedSigner {
  name: string;
  certSha256: string;
  source: string;
}

const C2PA_SIGNER_SRC =
  'C2PA Trust List (github.com/c2pa-org/conformance-public, trust-list/C2PA-TRUST-LIST.pem), pinned 2026-09-06';
const VERIFY_SITE_SRC =
  'Content Credentials Verify known certificate list (github.com/contentauth/verify-site, static/trust/anchors.pem), pinned 2026-09-06';

export const PINNED_SIGNERS: PinnedSigner[] = [
  { name: 'Google C2PA Media Services 1P ICA G3', certSha256: '24213596a832efb823864eacf5b2428c3d472435e38991cd805ce72af4bb9924', source: C2PA_SIGNER_SRC },
  { name: 'Google C2PA Mobile A 1P ICA G3 L1', certSha256: '93202c5d038c04b65e360b364943811eb55d2f4abd0f702404b9e6ba100d078e', source: C2PA_SIGNER_SRC },
  { name: 'Google C2PA Mobile A 1P ICA G3', certSha256: '6bfc731b77117fe3cacc7070b42cd6bbe1086f62f76c15e1a89694cf7ac36b99', source: C2PA_SIGNER_SRC },
  { name: 'Google C2PA Mobile B 1P ICA G3 L1', certSha256: 'a42581572fc1cb92b850b5b4da269f254d78e46da69b7fdbe0743626359f599e', source: C2PA_SIGNER_SRC },
  { name: 'Google C2PA Mobile B 1P ICA G3', certSha256: '9309d5a82b43b9d975ce8ccc0c41b2c2f3097083c7af99f2aa9cffc25498f97d', source: C2PA_SIGNER_SRC },
  { name: 'Google C2PA Root CA G3', certSha256: 'e383a91825ff2a0944857f2e0c1bebb3bdf84a3e430bb505fef8e4023ed8a3c7', source: C2PA_SIGNER_SRC },
  { name: 'SSL.com C2PA RSA Root CA 2025', certSha256: '4c8ad434e01f769ac96dffc9729d702a0f20e55d891ebd86443c5cc8c2fab47c', source: C2PA_SIGNER_SRC },
  { name: 'SSL.com C2PA ECC Root CA 2025', certSha256: '8a8b023beed955f5d337070568e3329a5e76ae9ed3f1821090f5605e1ffdb050', source: C2PA_SIGNER_SRC },
  { name: 'Trufo C2PA Root CA (2025, ECC P384)', certSha256: 'a09208ebd885d89c3fc6c32519d16a57509acc63f9ebcc0a4a094432daee1480', source: C2PA_SIGNER_SRC },
  { name: 'vivo Content Provenance and Authenticity Root CA', certSha256: '62e8faec4a1a7674a9437aa1affb20580615986e6c10a08d1aa093428aa087ab', source: C2PA_SIGNER_SRC },
  { name: 'Xiaomi Root CA(EC-P384)', certSha256: '974fe7db4d39f349f6b44196a0b969cf0bacb772f42af8a5776d52c5e60be305', source: C2PA_SIGNER_SRC },
  { name: 'DigiCert RSA4096 Root for C2PA G1', certSha256: '0bb9164513ada25b47b92dee48f4ce31fb458097074fb0a35596938ededf4dc2', source: C2PA_SIGNER_SRC },
  { name: 'DigiCert ECC P384 Root for C2PA G1', certSha256: '795b3d3206e8066658b01bfd0dd8c5abbe47ffe8f1a0782ae1baeec7debb3bae', source: C2PA_SIGNER_SRC },
  { name: 'DigiCert RSA4096 L1 Claim Signing ICA for C2PA G1', certSha256: 'ac6a530262e9738b23137c90404837b6a6c618e55537ae7f2a93efeed02a0764', source: C2PA_SIGNER_SRC },
  { name: 'DigiCert ECC P384 L1 Claim Signing ICA for C2PA G1', certSha256: 'e3f586629a0ba187ce9feb67eb81381c367b7ff288842706b941114fde5a0f71', source: C2PA_SIGNER_SRC },
  { name: 'Adobe Product Issuing CA vault-a-or2.adobe.net cai', certSha256: 'b3a47548314f3cdc8537d35fa382e0935b93381cf8ee9baea99ec81c8c76f6d2', source: C2PA_SIGNER_SRC },
  { name: 'Irdeto C2PA Root CA G1', certSha256: '413b08353828bdb436fd6457fddab2bf5098a59a2182321111852377c69398f1', source: C2PA_SIGNER_SRC },
  { name: 'Tauth Root CA', certSha256: 'f3ff22e4caac4cdf5c47dac08ccca0e71e415be8e9c00c3b7ad7e293469f8ec3', source: C2PA_SIGNER_SRC },
  { name: 'HUAWEI C2PA ECC384 Root CA E346', certSha256: 'a7bf75564e899940d3e8e8a85369b4efe3b92956bc58dd97302ef26e7345922d', source: C2PA_SIGNER_SRC },
  { name: 'Huanyu Trust C2PA EC-384 Root CA', certSha256: '8c32d62a262d2bc419bf2342cf03a95a19aef782a7d538ff98f5e974aee1e4c5', source: C2PA_SIGNER_SRC },
  { name: 'Verimago Root CA', certSha256: '67683e192a428f70eb8b116781a3eb966c3d1e3aed4ef70a2aff88208bf19cb6', source: C2PA_SIGNER_SRC },
  { name: 'Verimago Claim Signing Issuing CA', certSha256: '10d4fba28cd37aff41dc776c8c46e398a4d366d40640094cca8a1aa87ebad0d0', source: C2PA_SIGNER_SRC },
  { name: 'Snowball ECC P384 Root CA for C2PA G1', certSha256: 'c7c19abe03866247732df7c509caa8d6454af29a9c3a137afe77d37c4e0e68be', source: C2PA_SIGNER_SRC },
  { name: 'Snowball ECC P384 Claim Signing ICA for C2PA G1', certSha256: '35a8b33c209655b32404a017c2d1f3ee28c123702ec1539d8c2f1d6c60209f93', source: C2PA_SIGNER_SRC },
  { name: 'Encypher C2PA Root CA 2026', certSha256: 'a3a229e56b60cbc964e78e221fe9e6373048325240e4e20ea5ef52115bba826c', source: C2PA_SIGNER_SRC },
  { name: 'Encypher C2PA Issuing CA 2026', certSha256: '7c82d82b416d87cb357477710c27c028685d2c3274585dd9814a697fd18b6d2c', source: C2PA_SIGNER_SRC },
  { name: 'TrustAsia C2PA RSA Root CA', certSha256: '67a5a52af341d284c188f0416bc38d91aec75b9f69d51643bd3430ec1f2ec07f', source: C2PA_SIGNER_SRC },
  { name: 'TrustAsia C2PA ECC Root CA', certSha256: '8cb6572df304ce2baf1d3e93fcb604d5eec8501feeac6af763efd4dd7aa4ecc5', source: C2PA_SIGNER_SRC },
  { name: 'RealReel C2PA Root CA', certSha256: '5559383ddd6666eb38ff746d592c5f6686b1c3340f4fdd584076d32e60b5e858', source: C2PA_SIGNER_SRC },
  { name: 'Castlabs C2PA ECC P-384 Root CA', certSha256: 'fa4d2a19fd5f940c9f6e160beb31aeba9ac786735a1e92d748f63d72f333dce6', source: C2PA_SIGNER_SRC },
  { name: 'Leica C2PA Root CA', certSha256: 'c60f849915aced77b2ac1d2b4a6d1b4bbeed6e2ebf29e1c759dba555afcaa31b', source: VERIFY_SITE_SRC },
  { name: 'Microsoft Supply Chain RSA Root CA 2022', certSha256: '23ffe2b8bdb9a1711515d4cffda04bc7f793d513c76c243f1020507d8669b7db', source: VERIFY_SITE_SRC },
  { name: 'Adobe Root CA G2', certSha256: '458e0e219698b18d2d4093d6336a12547953a54c05dd967c3a5a268b772d1b22', source: VERIFY_SITE_SRC },
  { name: 'RootCA', certSha256: 'd4238a521f5d88edae53709c956475b158afe3e0eb74a4e8d1bd76e83fd59b78', source: VERIFY_SITE_SRC },
  { name: 'Microsoft Identity Verification Root Certificate Authority 2020', certSha256: '5367f20c7ade0e2bca790915056d086b720c33c1fa2a2661acf787e3292e1270', source: VERIFY_SITE_SRC },
  { name: 'ContentSign Root CA', certSha256: '804f46daf0da8aa38ed0edc549ab4ad711b8d77521c2dd0b6cc19fe385d153b7', source: VERIFY_SITE_SRC },
  { name: 'Samsung corporation', certSha256: 'cb27e0a4eaf6c683e6a914ab4c599d65c2938050d08d18c312ae35579d1858da', source: VERIFY_SITE_SRC },
  { name: 'MetaphysicRootCA', certSha256: '82d24ce4d1746189cc0a4d135cdc87f7b5c61d53faca933d2bab73912481cc43', source: VERIFY_SITE_SRC },
  { name: 'Canon C2PA Root CA', certSha256: '07f892d3737a8165b3a656877e372338c4987f5559569351ff1d8f88b358432f', source: VERIFY_SITE_SRC },
  { name: 'FUJIFILM C2PA Root CA G1', certSha256: 'ba3da9f67d5c46b782cc72557a05a627b244a6a451fbb3da6388707f69a698be', source: VERIFY_SITE_SRC },
  { name: 'Pinterest Root Certificate Authority', certSha256: '552bf7884bb524069f3e3396b0d054eb6bed31ecd23cb1bbd10127f327126cde', source: VERIFY_SITE_SRC },
  { name: 'ATOM root CA v1', certSha256: '7d0c6ac8cd0ca6316b7419188d91c4ebec61cd48e8eca55306630b2ff9b3cc3a', source: VERIFY_SITE_SRC },
  { name: 'trufo.ai', certSha256: '5e6d46c2fc99564dbf59ca18935e94d206eac0f83a759594090b478f68eb5de5', source: VERIFY_SITE_SRC },
  { name: 'vivo Content Provenance and Authenticity Root CA', certSha256: '2fdc1433dc5d0005625d47c374e871ac5da01b6336abc6ff0d6164c6cd92f9be', source: VERIFY_SITE_SRC },
  { name: 'Nikon C2PA Root CA', certSha256: 'd5c6d933a09616a641618be2d49294ade77bf8c48130219ec158e1bdca7fe968', source: VERIFY_SITE_SRC },
  { name: 'SONY C2PA Root CA G2', certSha256: '3e752debad2484295bc450a6fae2cd21f79845b26065b06bdeeab015a8b9adcf', source: VERIFY_SITE_SRC },
  { name: 'Cybertrust iTrust C2PA Root Certification Authority G1', certSha256: '6ce0bf83c14334971363761864d12477fd9f9cef79435d53a979fb4cdef90c2d', source: VERIFY_SITE_SRC },
  { name: 'Bria Artificial Intelligence C2PA Root CA', certSha256: 'e7c4a47e899900408e3e22a5378b2ede5d3527c6d547c46d9958d4806c0e14a5', source: VERIFY_SITE_SRC },
  { name: 'Microsoft C2PA AL2 Root CA 2025', certSha256: '4e23b06b3d76c0742fd2593ae94f478528d2ac27a243dde9f3d5a6cfeb4ae9be', source: VERIFY_SITE_SRC },
  { name: 'Microsoft C2PA Claims AL2 PCA 2025', certSha256: '9252fb534eaaa977ff5a4aaa7e5f670dbe8f37085213065d5a5afb68d0333cf3', source: VERIFY_SITE_SRC },
];

/** The first pinned anchor matching any certificate in a chain, or null. */
export function pinnedSignerFor(chainFingerprints: string[]): PinnedSigner | null {
  if (chainFingerprints.length === 0) return null;
  const seen = new Set(chainFingerprints.map((f) => f.toLowerCase()));
  return PINNED_SIGNERS.find((p) => seen.has(p.certSha256)) ?? null;
}
