// Source Kit 0.1.0 — which engine seals which media kind
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Sealing-engine gate (0.20.0 test build → 0.22.0 default). The compile-time
 * master gate lives in src/provenance/engine/upstreamEngineIos.ts
 * (UPSTREAM_SIGNING_EXPERIMENT); THIS flag was the user-visible half of the
 * A/B, persisted in settings.json and hydrated at settings load.
 *
 * 0.22.0: the experiment is over — ZERO quarantines across the field trial,
 * so the SDK path is now the default for photo and video and the settings
 * toggle is gone (a toggle that must never be turned off is not a choice).
 * The exported name is kept so attest.ts reads one stable symbol; it now
 * returns a constant. The fallback contract is UNCHANGED: any SDK failure
 * falls back to the hand-rolled builder with a Diagnostics entry, audio
 * always seals with the legacy hand-rolled engine, and the Diagnostics log
 * always says which path sealed each capture.
 */

/** Read by attest.ts at seal time, per capture. Constant ON since 0.22.0. */
export function sdkSigningExperimentActive(): boolean {
  return true;
}
