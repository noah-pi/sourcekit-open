// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Runtime switch for the c2pa-swift signing path.
 *
 * The compile-time gate is UPSTREAM_SIGNING_EXPERIMENT in
 * src/provenance/engine/upstreamEngineIos.ts; this is the user-visible half,
 * persisted in settings and hydrated into memory at load. attest.ts checks
 * both.
 *
 * The switch is real: on means the SDK path actually signs, then self-verifies
 * through the same verifier a recipient runs, and falls back to the
 * hand-rolled builder with a diagnostics entry on any failure. The log always
 * names which path sealed a capture.
 */

let active = false;

/** Called by useStore on settings load and on save. */
export function setSdkSigningExperiment(on: boolean): void {
  active = on === true;
}

/** Read by attest.ts at seal time, per capture. */
export function sdkSigningExperimentActive(): boolean {
  return active;
}
