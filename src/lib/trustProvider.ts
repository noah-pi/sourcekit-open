// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * TrustProvider — pluggable trust anchors for verification. Anchors live
 * outside the file being verified; providers run in precedence order and the
 * first hit wins. Tiers: this-device / roster / org / trust-list / unknown.
 * Display keeps them distinct: unsigned renders neutral, valid-but-untrusted
 * does not render green. trust-list has no provider; the report lists it as
 * "not checked".
 */

import { resolveSignerInRosters } from './rosterStore';
import type { RosterResolution } from './roster';

export type TrustTier = 'this-device' | 'roster' | 'org' | 'trust-list' | 'unknown';

/** Local capture history for a hand. Local only; not a trust anchor. */
export interface LocalHandHistory {
  /** Prior exhibits in this device's collection sealed by this fingerprint. */
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
   * Attached only at tier 'unknown'; never promotes the tier. Display carries
   * "on this device".
   */
  localHand?: LocalHandHistory;
}

export interface TrustResolutionInput {
  /** SHA-256 of the signer's public key, hex (from the verified cert/record). */
  fingerprint: string;
  /** The verifying device's own fingerprint, when known. */
  ownFingerprint: string | null;
  /** Org chain detail. Present only when every link verified; a broken chain does not yield 'org'. */
  orgChain?: { linksValid: boolean; topSubject: string | null; issuer: string | null } | null;
  /** Verified signing time (valid RFC 3161 genTime) or null. */
  atMs: number | null;
  /** Device-local capture history; attached only at the 'unknown' floor. */
  localHistory?: LocalHandHistory | null;
}

export interface TrustProvider {
  readonly id: string;
  resolve(input: TrustResolutionInput): Promise<SignerTrust | null>;
}

/** The device's own key. Highest precedence. */
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

/** 'org' only when the chain's links verified. The caller displays the self-asserted-root caveat. */
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
 * slots in above roster; this array is the seam.
 */
export function defaultTrustProviders(): TrustProvider[] {
  return [thisDeviceProvider(), rosterProvider(), orgChainProvider()];
}

/**
 * Resolves a signer to a trust tier. Never throws; resolution failure
 * degrades to 'unknown'.
 */
export async function resolveSignerTrust(input: TrustResolutionInput): Promise<SignerTrust> {
  for (const provider of defaultTrustProviders()) {
    try {
      const hit = await provider.resolve(input);
      if (hit) return hit;
    } catch {
      // A broken provider neither upgrades nor blocks identity; keep looking.
    }
  }
  // Local history stays at the 'unknown' floor. Two-capture threshold keeps a
  // single stray capture from reading as a track record.
  if (input.localHistory && input.localHistory.priorCaptures >= 2) {
    return { tier: 'unknown', localHand: input.localHistory };
  }
  return { tier: 'unknown' };
}
