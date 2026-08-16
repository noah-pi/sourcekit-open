// Lab shim: no Apple attestation exists off-device, so the assertion box is
// simply absent — the same state as an unattested real device.
export async function getAttestationAssertion(): Promise<Uint8Array | null> { return null; }
