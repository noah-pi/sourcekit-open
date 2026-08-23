// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Commit-at-capture: turns the capture evidence the seal path already holds
 * into the fixed context-claim set, committed under one Merkle root
 * (commit.ts). The root rides in the C2PA manifest as the
 * `com.verify.contextTree` assertion.
 *
 * The default profile is sealed — everything committed, nothing opened.
 * Opening later re-derives salts from the master seed.
 *
 * What can and can't be derived here:
 *   time     — all six rungs come from capturedAt by prefix truncation.
 *   location — geohash-5/7/9 and exact are derived from the GPS fix.
 *              country, region and grid-region need reverse geocoding, which
 *              is a lookup this module can't do, so they are declared
 *              never-recorded rather than fabricated.
 *   identity — key-fingerprint is the signer fingerprint; named and org come
 *              from the byline fields. roster-status is a lookup, not a
 *              seal-time fact, so it is never-recorded.
 *   sensor   — 'present' reflects whether a sensor log was actually written,
 *              never inferred from a motion verdict or poseTrace.
 *              'residual-summary' carries the motion verdict when one exists.
 */
import { coarsen, exactLocationValue, LOCATION_RUNGS, TIME_RUNGS, claimIdFor } from './ladder';
import type { ContextClaim } from './inventory';
import { commitContext, type CommittedContext, type CommittedInventoryAssertion } from './commit';
import { openSubset, profileSelection, type DisclosureBundle } from './bundle';
import { bytesToHex } from '../lib/bytes';

export interface CaptureCommitInput {
  /** Device-clock capture time (ISO-8601). Normalized to exact-ms here. */
  capturedAt: string;
  /** The GPS fix the record carries, or its explicit non-states. */
  location: { lat: number; lon: number } | 'redacted' | 'unavailable' | null;
  /** Byline identity exactly as the record carries it. */
  identity: { author: string | null; organization: string | null } | 'redacted';
  /** Signer key fingerprint (hex) — the identity.key-fingerprint rung. */
  fingerprint: string;
  /** Was a sensor log actually written? Sink presence only, not inferred. */
  sensorLogRecorded: boolean;
  /** Motion verdict string (sensor.residual-summary), when one was computed. */
  motionVerdict?: string | null;
  /**
   * Capture-result context claims (Spec-Camera-Module-0.13 →
   * src/provenance/stereoArtifacts.ts, plus full-res extras from
   * sealQueue): the five `context.stereo-*` claims whose VALUES state each
   * artifact's committed outcome ('sha256:<hex>' / 'error:<string>' /
   * 'never-recorded[:<reason>]'), and the additive `context.fullres-still`,
   * `context.fullres-secondary`, `context.capture-settings` claims. Exactly
   * those claim IDs are admitted — anything else throws, fail-closed.
   * ABSENT when no stereo module ran (legacy single-lens path) — the
   * context family is optional additions, so a non-stereo capture simply
   * carries no stereo claims. When the module ran, all five claims are
   * present: no silent absence.
   */
  stereoClaims?: ContextClaim[];
}

export interface CaptureCommit {
  committed: CommittedContext;
  /** The never-recorded declarations fed to the commit (sorted in the assertion). */
  neverRecordedIds: string[];
}

/**
 * Build the claims + never-recorded declarations for one capture. Pure
 * and deterministic: same evidence → same claim values, so a verifier
 * re-deriving from the same record sees the identical inventory.
 */
export function claimsFromCapture(input: CaptureCommitInput): { claims: ContextClaim[]; neverRecordedIds: string[] } {
  const claims: ContextClaim[] = [];
  const neverRecordedIds: string[] = [];
  const push = (claimId: string, family: ContextClaim['family'], rung: number, value: string) =>
    claims.push({ claimId, family, rung, value });

  // ---- time: every rung derived by prefix truncation --------------------
  const parsed = Date.parse(input.capturedAt);
  if (!Number.isFinite(parsed)) {
    throw new Error(`captureCommit: capturedAt '${input.capturedAt}' is not a parseable ISO timestamp`);
  }
  const exactMs = new Date(parsed).toISOString();
  for (let r = 0; r < TIME_RUNGS.length; r++) {
    push(claimIdFor('time', TIME_RUNGS[r]), 'time', r, coarsen('time', exactMs, r));
  }

  // ---- location: geohash rungs derived; reverse-geocoded rungs honest ----
  const loc = input.location;
  if (loc && typeof loc === 'object') {
    const exact = exactLocationValue(loc.lat, loc.lon);
    for (let r = 0; r < LOCATION_RUNGS.length; r++) {
      const name = LOCATION_RUNGS[r];
      if (name === 'country' || name === 'region' || name === 'grid-region') {
        // Reverse geocoding is a lookup, not a derivation — never recorded
        // by the commitment core, declared so at commit time (immutable).
        neverRecordedIds.push(claimIdFor('location', name));
      } else {
        push(claimIdFor('location', name), 'location', r, coarsen('location', exact, r));
      }
    }
  } else {
    // 'redacted' (signer opted out), 'unavailable' (OS returned nothing),
    // or null (no fix): every rung is declared never-recorded. The STATE is
    // already public in the record's location field — committing nothing.
    for (let r = 0; r < LOCATION_RUNGS.length; r++) {
      neverRecordedIds.push(claimIdFor('location', LOCATION_RUNGS[r]));
    }
  }

  // ---- identity ---------------------------------------------------------
  push('identity.key-fingerprint', 'identity', 0, input.fingerprint);
  // roster-status is a roster-engine lookup result, not a seal-time
  // derivation — declaring it never-recorded beats caching a stale verdict.
  neverRecordedIds.push('identity.roster-status');
  const idn = input.identity;
  if (idn !== 'redacted' && idn.organization) {
    push('identity.org', 'identity', 2, idn.organization);
  } else {
    neverRecordedIds.push('identity.org');
  }
  if (idn !== 'redacted' && idn.author) {
    push('identity.named', 'identity', 3, idn.author);
  } else {
    neverRecordedIds.push('identity.named');
  }

  // ---- sensor -----------------------------------------------------------
  push('sensor.present', 'sensor', 0, input.sensorLogRecorded ? 'true' : 'false');
  if (input.sensorLogRecorded && input.motionVerdict) {
    push('sensor.residual-summary', 'sensor', 1, input.motionVerdict);
  } else {
    neverRecordedIds.push('sensor.residual-summary');
  }

  // ---- capture-result context additions (optional) -----------------------
  // The claims arrive pre-built from commitStereoArtifacts (context.stereo-*)
 // and from sealQueue's full-res extras (context.fullres-still,
  // context.fullres-secondary, context.capture-settings) — all folded into
  // this same signed tree by design. Fail-closed via an EXPLICIT allowlist:
  // anything else throws with the reason named, so junk can never ride the
  // signed tree. buildInventory validates them like any claim, and the
  // inventory meta-leaf binds their entries into the root.
  if (input.stereoClaims) {
    for (const c of input.stereoClaims) {
      const allowed =
        c.family === 'context' &&
        (c.claimId.startsWith('context.stereo-') ||
          c.claimId === 'context.fullres-still' ||
          c.claimId === 'context.fullres-secondary' ||
          c.claimId === 'context.capture-settings');
      if (!allowed) {
        throw new Error(`captureCommit: additive claims must be context.stereo-* / context.fullres-* / context.capture-settings, got '${c?.claimId}'`);
      }
      claims.push(c);
    }
  }

  return { claims, neverRecordedIds };
}

/**
 * Commit the capture's context claims under one root. The master seed is
 * generated by the caller (attest.ts) and handed to the vault store
 * afterwards — it is NEVER returned as part of a salt table (A-02) and
 * never rides in the manifest (only the root does).
 */
export function commitCaptureEvidence(masterSeed: Uint8Array, input: CaptureCommitInput): CaptureCommit {
  const { claims, neverRecordedIds } = claimsFromCapture(input);
  return { committed: commitContext(masterSeed, claims, neverRecordedIds), neverRecordedIds };
}

/**
 * What the vault store (disclosure/burn.ts) persists per sealed item:
 * everything needed to derive any future profile's bundle on demand from
 * the master seed — plus the DEFAULT Sealed-profile bundle itself.
 * masterSeedHex is vault-only: it never rides in the manifest, the proof
 * bundle, or any export.
 */
export interface SealedCaptureDisclosure {
  root: string;
  claims: ContextClaim[];
  inventoryAssertion: CommittedInventoryAssertion;
  sealedBundle: DisclosureBundle;
  masterSeedHex: string;
}

/**
 * Commit the capture evidence AND produce the default Sealed-profile
 * bundle in one pass: everything committed, nothing disclosed beyond what
 * the asset already carries. The Sealed bundle is
 * derived through the same openSubset path as any other profile — there
 * is no privileged construction.
 */
export function sealCaptureDisclosure(masterSeed: Uint8Array, input: CaptureCommitInput): SealedCaptureDisclosure {
  const { committed, neverRecordedIds } = commitCaptureEvidence(masterSeed, input);
  const sealedBundle = openSubset(
    committed.tree,
    committed.leaves,
    masterSeed,
    profileSelection('sealed'),
    'sealed',
    neverRecordedIds,
    committed.inventoryAssertion.entries
  );
  return {
    root: committed.root,
    claims: committed.leaves,
    inventoryAssertion: committed.inventoryAssertion,
    sealedBundle,
    masterSeedHex: bytesToHex(masterSeed),
  };
}
