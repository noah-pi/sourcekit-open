// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * RESOLVE — parse-any-manifest for the desk.
 *
 * The upstream-engine Reader over ARBITRARY C2PA assets (any producer, not
 * just Source Kit captures), returning a normalized manifest summary: producer,
 * claim generator, ingredients, trust-list status, validation status.
 *
 * NO VERDICTS HERE. RESOLVE answers "what credentials does this asset carry
 * and what did the official engine say about them" — the verdict authority
 * is the policy layer (src/provenance/engine/policyLayer.ts); the CLI
 * exposes it as the `resolve` subcommand.
 *
 * Engine binding: @contentauth/c2pa-node@0.8.1 on node>=22, wasm fallback
 * (@contentauth/c2pa-wasm@0.11.1, pinned) on the node-20 harness — see
 * upstreamEngine.ts. Trust material is caller-pinned and offline; the
 * result DISCLOSES which trust-list basis was used (official TL vs frozen
 * ITL vs none vs unknown) per C2PA's own product-messaging guidance.
 */

import {
  readUpstreamAsset,
  UPSTREAM_ENGINE_PINS,
  type EngineTrustOptions,
  type NormalizedEngineResult,
  type TrustListHit,
} from '@exhibit/provenance/engine/upstreamEngine';

export interface ResolvedManifestSummary {
  label: string | null;
  /** Who produced this manifest (claim_generator), any tool in the ecosystem. */
  producer: string | null;
  title: string | null;
  format: string | null;
  instanceId: string | null;
  claimVersion: number | null;
  ingredients: { label: string | null; title: string | null; format: string | null; relationship: string | null }[];
  signature: {
    alg: string | null;
    issuer: string | null;
    commonName: string | null;
    time: string | null;
    certChainLength: number;
  } | null;
}

export interface ResolveResult {
  /** False when no C2PA manifest was found (or the engine could not run). */
  resolved: boolean;
  engine: NormalizedEngineResult['engine'];
  engineVersion: string;
  manifests: ResolvedManifestSummary[];
  /** The active (most recent) manifest — the one C2PA verdicts rest on. */
  activeManifest: ResolvedManifestSummary | null;
  /** Engine validation codes (failure + informational), upstream vocabulary. */
  validationStatus: { code: string; severity: string; explanation: string | null }[];
  /** Engine validation_state when present (Trusted/Valid/Invalid). */
  validationState: string | null;
  /**
   * Trust-list basis of THIS resolution — disclosed, never implied:
   * 'official' (pinned official C2PA TL) | 'interim' (pinned frozen ITL) |
   * 'none' (evaluated, signer on neither list) | 'unknown' (not evaluated
   * against caller-pinned anchors).
   */
  trustListStatus: TrustListHit;
  /** Plain disclosure lines for anything NOT established. */
  disclosures: string[];
  errors: string[];
}

export interface ResolveOptions {
  /** Pinned trust anchors (PEM) + which list the caller says they are. */
  trust?: EngineTrustOptions;
}

/**
 * Resolve an arbitrary C2PA asset. Container-agnostic: photo containers
 * (JPEG/PNG) and BMFF (MP4/MOV/M4A) are both tried — the flow gate inside
 * the engine is deterministic, so the second attempt costs nothing when the
 * first rejects the container.
 */
export async function resolveAsset(bytes: Uint8Array, opts?: ResolveOptions): Promise<ResolveResult> {
  let n = await readUpstreamAsset(bytes, 'photo', { trust: opts?.trust });
  if (n.containerRejected === 'NOT_JPEG') {
    n = await readUpstreamAsset(bytes, 'video', { trust: opts?.trust });
  }

  const disclosures: string[] = [];
  if (n.trustListHit === 'unknown') {
    disclosures.push(
      'trust not evaluated against caller-pinned anchors — no claim is made about the official C2PA Trust List or the frozen ITL; the signer is NOT shown as trusted',
    );
  } else if (n.trustListHit === 'none') {
    disclosures.push('signer chains to NEITHER pinned trust list (official TL nor frozen ITL) — valid-but-unattributed is the honest label');
  }
  if (!n.engineAvailable) {
    disclosures.push(`upstream engine unavailable in this runtime (${UPSTREAM_ENGINE_PINS.c2paWasmFallbackReason})`);
  }

  const raw = n.raw as Record<string, unknown> | undefined;
  return {
    resolved: n.manifestFound,
    engine: n.engine,
    engineVersion: n.engineVersion,
    manifests: n.manifests.map((m) => ({ ...m, producer: m.claimGenerator })),
    activeManifest: n.activeClaim ? { ...n.activeClaim, producer: n.activeClaim.claimGenerator } : null,
    validationStatus: n.validationStatus.map((s) => ({ code: s.code, severity: s.severity, explanation: s.explanation })),
    validationState: (raw?.validation_state as string) ?? null,
    trustListStatus: n.trustListHit,
    disclosures,
    errors: n.rawErrors,
  };
}

/** Engine pins, re-exported so the CLI report can record them per run. */
export const RESOLVE_ENGINE_PINS = UPSTREAM_ENGINE_PINS;
