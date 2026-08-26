// Source Kit 0.1.0 — burn scheduler and per-item disclosure store
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Burn scheduler and per-item disclosure store.
 *
 * Each sealed item carries a DisclosureItemState: committed claims, the
 * sealed-profile bundle, the root, and, until a burn, the master seed.
 * `burnAfterHours` is per item and defaults to never. A burn destroys the
 * master seed, so withheld rungs can no longer be disclosed. Claim values
 * still live in the vault store; what burn destroys is the proof material
 * for withheld rungs. The UI wording is BURN_FINALITY_WORDING below.
 *
 * Invariants:
 *   - Every burn appends a `burn` event to the item's event log.
 *   - Salts derive from the seed at openSubset time only; this module
 *     never holds a salt table.
 *   - Bundles already exported keep verifying after a burn.
 *   - The scheduler is policy plus an injected store: the app runs it on
 *     foreground (from sealQueue.resumeSealQueue) against a vault-sealed
 *     file store, the lab against memory.
 *
 * Exporting a non-Sealed profile returns verifyBundle's residual list
 * alongside the bundle for the UI to render.
 */

import { commitContext } from './commit';
import {
  openSubset,
  profileSelection,
  verifyBundle,
  type DisclosureBundle,
  type DisclosureProfile,
} from './bundle';
import type { CommittedInventoryAssertion } from './commit';
import type { ContextClaim } from './inventory';

/** The honesty sentence the UI shows before and after a burn (locked wording). */
export const BURN_FINALITY_WORDING =
  'After burn, withheld details can never be cryptographically disclosed again — the proof material is destroyed. What the record itself already shows remains visible.';

export interface DisclosureEvent {
  type: 'commit' | 'open' | 'burn';
  at: string;
  /** Present on 'open' events: which profile was derived. */
  profile?: DisclosureProfile;
}

export interface DisclosureItemState {
  itemId: string;
  createdAt: string;
  /** Merkle root committed in the manifest's com.verify.contextTree assertion. */
  root: string;
  /** The committed claims, values included; sealed at rest by the store. */
  claims: ContextClaim[];
  inventoryAssertion: CommittedInventoryAssertion;
  /** The default Sealed-profile bundle produced at commit. */
  sealedBundle: DisclosureBundle;
  /**
   * Hex master seed: present until a burn, deleted after. The only way a
   * withheld rung can be opened (salts derive from it and exist
   * nowhere else).
   */
  masterSeedHex?: string;
  /** Burn policy: destroy the seed this many hours after createdAt. Absent = never. */
  burnAfterHours?: number;
  /** Set by applyBurn; the seed is gone from this moment on. */
  burnedAt?: string;
  /**
   * Set when a scheduled burn attempt failed (e.g. the store's save threw).
   * Cleared by the next successful burn. A failing store can also defeat
   * this recording; the scheduler isolates the failure to the one item.
   */
  burnFailure?: { at: string; error: string };
  /** Action log: commit, open, and burn events. */
  events: DisclosureEvent[];
}

export interface CommittedCaptureForStore {
  root: string;
  claims: ContextClaim[];
  inventoryAssertion: CommittedInventoryAssertion;
  sealedBundle: DisclosureBundle;
  masterSeedHex: string;
}

/** Build the stored state for a freshly sealed item (commit event recorded). */
export function createItemState(
  itemId: string,
  capture: CommittedCaptureForStore,
  opts?: { burnAfterHours?: number; now?: Date }
): DisclosureItemState {
  const at = (opts?.now ?? new Date()).toISOString();
  const state: DisclosureItemState = {
    itemId,
    createdAt: at,
    root: capture.root,
    claims: capture.claims,
    inventoryAssertion: capture.inventoryAssertion,
    sealedBundle: capture.sealedBundle,
    masterSeedHex: capture.masterSeedHex,
    events: [{ type: 'commit', at }],
  };
  if (opts?.burnAfterHours !== undefined) state.burnAfterHours = opts.burnAfterHours;
  return state;
}

/** Is this item's seed due for destruction at `now`? Default policy: never. */
export function shouldBurn(state: DisclosureItemState, now: Date): boolean {
  if (state.burnedAt !== undefined || state.masterSeedHex === undefined) return false;
  if (state.burnAfterHours === undefined) return false; // default: never
  const dueMs = Date.parse(state.createdAt) + state.burnAfterHours * 3600_000;
  return now.getTime() >= dueMs;
}

/**
 * Destroy the master seed: the field is set to undefined and the property
 * deleted from the record. JS strings are immutable, so transient copies
 * cannot be scrubbed; the guarantee is that the seed is never persisted
 * again and no salt table exists. A second call throws rather than
 * re-recording a burn.
 */
export function applyBurn(state: DisclosureItemState, now: Date): DisclosureItemState {
  if (state.masterSeedHex === undefined) {
    throw new Error(`burn: item '${state.itemId}' is already burned (${state.burnedAt ?? 'time unknown'}): ${BURN_FINALITY_WORDING}`);
  }
  const at = now.toISOString();
  const next: DisclosureItemState = {
    ...state,
    // Clear-then-delete so the stored record never carries the seed again.
    // A successful burn also clears any earlier recorded burn failure.
    masterSeedHex: undefined,
    burnFailure: undefined,
    burnedAt: at,
    events: [...state.events, { type: 'burn', at }],
  };
  delete next.masterSeedHex;
  delete next.burnFailure;
  return next;
}

const BURNED_OPEN_ERROR = `burned: the master seed was destroyed. ${BURN_FINALITY_WORDING}`;

/** Error thrown when opening a burned item (test-pinned wording). */
export function burnedOpenError(state: DisclosureItemState): Error {
  return new Error(
    `${BURNED_OPEN_ERROR} (item '${state.itemId}', burned at ${state.burnedAt ?? 'unknown time'})`
  );
}

function hexToSeed(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('burn: stored master seed is malformed');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Rebuild the commitment (tree included) from the stored claims and seed.
 * commitContext is deterministic, so the rebuilt root must equal the stored
 * root; a mismatch means the stored state was altered and throws.
 */
function rebuildCommitment(state: DisclosureItemState, seed: Uint8Array) {
  const committed = commitContext(seed, state.claims, state.inventoryAssertion.neverRecorded);
  if (committed.root !== state.root) {
    throw new Error(
      `burn: stored state for '${state.itemId}' does not recompute to its committed root ` +
      `(${committed.root} ≠ ${state.root}); the vault record was altered after commit`
    );
  }
  return committed;
}

/**
 * Derive a bundle for `profile` on demand from the master seed; without the
 * seed it is impossible for anyone, so after a burn this throws the 'burned'
 * error. An 'open' event is recorded on the returned state for the caller to
 * persist.
 */
export function openForItem(
  state: DisclosureItemState,
  profile: DisclosureProfile,
  customClaimIds?: string[],
  now: Date = new Date()
): { bundle: DisclosureBundle; state: DisclosureItemState } {
  if (state.masterSeedHex === undefined) throw burnedOpenError(state);
  const seed = hexToSeed(state.masterSeedHex);
  const committed = rebuildCommitment(state, seed);
  const bundle = openSubset(
    committed.tree,
    committed.leaves,
    seed,
    profileSelection(profile, customClaimIds),
    profile,
    state.inventoryAssertion.neverRecorded,
    state.inventoryAssertion.entries,
    profile === 'custom' ? customClaimIds : undefined
  );
  return {
    bundle,
    state: { ...state, events: [...state.events, { type: 'open', at: now.toISOString(), profile }] },
  };
}

/**
 * Disclosure export path: derives the requested profile's bundle and verifies
 * it against the stored root and inventory. `residuals` is verifyBundle's
 * named failures (profile mismatch, accounting gaps), empty when clean.
 */
export function exportForItem(
  state: DisclosureItemState,
  profile: DisclosureProfile,
  customClaimIds?: string[],
  now: Date = new Date()
): { bundle: DisclosureBundle; residuals: string[]; state: DisclosureItemState } {
  const opened = openForItem(state, profile, customClaimIds, now);
  const residuals = verifyBundle(opened.bundle, state.root, state.inventoryAssertion).failures;
  return { bundle: opened.bundle, residuals, state: opened.state };
}

// ---------------------------------------------------------------------------
// Persistence and scheduler. The store is injected: vault-sealed files in the
// app, memory in the lab. Policy is identical either way.
// ---------------------------------------------------------------------------

export interface DisclosureStore {
  listIds(): Promise<string[]>;
  load(itemId: string): Promise<DisclosureItemState | null>;
  save(state: DisclosureItemState): Promise<void>;
}

/**
 * Run due burns. Every burned item is saved with its burn event. Returns the
 * ids burned this run; an empty run is the normal case.
 *
 * Per-item containment: a failing load/save for one item never aborts later
 * items. The failure is recorded in that item's own `burnFailure` on a
 * best-effort basis, since a broken store can also fail that write.
 */
export async function runBurnScheduler(store: DisclosureStore, now: Date = new Date()): Promise<string[]> {
  const burned: string[] = [];
  for (const id of await store.listIds()) {
    try {
      const state = await store.load(id);
      if (!state || !shouldBurn(state, now)) continue;
      await store.save(applyBurn(state, now));
      burned.push(id);
    } catch (err) {
      try {
        const state = await store.load(id);
        if (state && state.masterSeedHex !== undefined) {
          await store.save({
            ...state,
            burnFailure: { at: now.toISOString(), error: err instanceof Error ? err.message : String(err) },
          });
        }
      } catch {
        // The store itself is failing; the next run retries.
      }
    }
  }
  return burned;
}
