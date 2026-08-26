// Source Kit 0.1.0 — app attest shim
// Written with AI assistance. Verification: docs/PROVENANCE.md.
// Lab shim: no Apple attestation off-device, so the assertion is absent —
// the same state as an unattested real device.
export async function getAttestationAssertion(): Promise<Uint8Array | null> { return null; }
