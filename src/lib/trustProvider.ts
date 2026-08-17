// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * TrustProvider — pluggable trust anchors for VERIFICATION. Anchors live
 * OUTSIDE the file being verified; providers run in precedence order and the
 * first hit wins. Tiers (this-device / roster / org / trust-list / unknown)
 * are always displayed as distinct states: unsigned files render NEUTRAL,
 * valid-but-untrusted NEVER renders green. trust-list is NOT SHIPPED — the
 * report says so under "not checked".
 */

import { resolveSignerInRosters } from './rosterStore';
import type { RosterResolution } from './roster';

export type TrustTier = 'this-device' | 'roster' | 'org' | 'trust-list' | 'unknown';

/** Local capture history for a hand — purely local, never vouching. */
export interface LocalHandHistory {
  /** Prior exhibits in THIS device's collection sealed by this fingerprint. */
  priorCaptures: number;
  /** ISO timestamp of the earliest such exhibit. */
  firstSeen: string;
}

export interface SignerTrust {
  tier: TrustTier;
  /** Roster detail when tier === 'roster'. */
  roster?: RosterResolution;
  /** Org credential detail when tier === 'org' (from the verified chain). */
  org?: { subject: string | null; issuer: string | null };
  /**
   * Attached ONLY at tier 'unknown' — local history never vouches and never
   * promotes the tier. Display must always carry "on this device".
   */
  localHand?: LocalHandHistory;
}

export interface TrustResolutionInput {
  /** SHA-256 of the signer's public key, hex (from the verified cert/record). */
  fingerprint: string;
  /** The verifying device's own fingerprint, when known. */
  ownFingerprint: string | null;
  /** Org chain detail — present only when all links verified; a broken chain NEVER yields 'org'. */
  orgChain?: { linksValid: boolean; topSubject: string | null; issuer: string | null } | null;
  /** Verified signing time (valid RFC 3161 genTime) or null. */
  atMs: number | null;
  /** Device-local capture history; attached only at the 'unknown' floor, never an anchor. */
  localHistory?: LocalHandHistory | null;
}

export interface TrustProvider {
  readonly id: string;
  resolve(input: TrustResolutionInput): Promise<SignerTrust | null>;
}

/** The device's own key — the strongest anchor there is. */
export function thisDeviceProvider(): TrustProvider {
  return {
    id: 'this-device',
    resolve: async (input) =>
      input.ownFingerprint && input.fingerprint === input.ownFingerprint
        ? { tier: 'this-device' }
        : null,
  };
}

/** Signed newsroom rosters stored on this device (editor-vouched). */
export function rosterProvider(): TrustProvider {
  return {
    id: 'roster',
    resolve: async (input) => {
      const hit = await resolveSignerInRosters(input.fingerprint, input.atMs);
      return hit ? { tier: 'roster', roster: hit } : null;
    },
  };
}

/** 'org' only when the chain's links verified; the self-asserted-root caveat is the caller's display duty. */
export function orgChainProvider(): TrustProvider {
  return {
    id: 'org',
    resolve: async (input) =>
      input.orgChain && input.orgChain.linksValid
        ? { tier: 'org', org: { subject: input.orgChain.topSubject, issuer: input.orgChain.issuer } }
        : null,
  };
}

/**
 * Default provider chain, in precedence order. A C2PA Trust List provider
 * slots in ABOVE roster when one ships — the seam is this array.
 */
export function defaultTrustProviders(): TrustProvider[] {
  return [thisDeviceProvider(), rosterProvider(), orgChainProvider()];
}

/**
 * Resolves a signer to a trust tier. Never throws — resolution failure
 * degrades to 'unknown', the honest floor.
 */
export async function resolveSignerTrust(input: TrustResolutionInput): Promise<SignerTrust> {
  for (const provider of defaultTrustProviders()) {
    try {
      const hit = await provider.resolve(input);
      if (hit) return hit;
    } catch {
      // A broken provider must never upgrade OR block identity — keep looking.
    }
  }
  // Local history lives at the 'unknown' floor — it never vouches. Threshold
  // of two keeps a single stray capture from reading as a track record.
  if (input.localHistory && input.localHistory.priorCaptures >= 2) {
    return { tier: 'unknown', localHand: input.localHistory };
  }
  return { tier: 'unknown' };
}
