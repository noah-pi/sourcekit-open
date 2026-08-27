// Source Kit 0.1.0 — app attest shim
// Written with AI assistance. Verification: docs/PROVENANCE.md.
// Lab shim: no Apple attestation off-device, so the assertion is absent —
// the same state as an unattested real device. The media hash is accepted
// and ignored, because the per-capture assertion it would bind needs the
// Enclave that is not here either.
export async function getAttestationAssertion(_cleanFileSha256?: Uint8Array | null): Promise<Uint8Array | null> { return null; }
