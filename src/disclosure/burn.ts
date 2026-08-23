// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The burn scheduler + per-item disclosure store
 *
 * A vault-level policy. Each sealed item carries a DisclosureItemState:
 * the committed claims, the sealed-profile bundle, the root, and — until
 * a burn — the master seed. `{ burnAfterHours?: number }` per item
 * (default: NEVER). A burn destroys the master seed, making withheld
 * rungs permanently undisclosable — the honesty wording, verbatim for
 * the UI layer (the wording must NOT overclaim —
 * claim values persist in the vault store and the record itself retains
 * its facts; what burn truly destroys is the PROOF MATERIAL for withheld
 * rungs):
 *
 *   "After burn, withheld details can never be cryptographically
 *    disclosed again — the proof material is destroyed. What the
 *    record itself already shows remains visible."
 *
 * Held invariants:
 *   - Burn is an ACTION, never silent: every burn appends a `burn` event
 *     to the item's event log (committed into the stored state).
 *   - A-02 is not regressed: salts are still derived from the seed at
 *     openSubset time only; this module never holds a salt table.
 *   - Opened evidence survives: bundles already exported verify forever
 *     (commitments close, opened evidence doesn't).
 *   - The scheduler is pure policy + injected persistence: it runs on
 *     app foreground (wired from sealQueue.resumeSealQueue) with a
 *     vault-sealed file store; the lab drives the same code with an
 *     in-memory store.
 *
 * Residuals: exporting a non-Sealed profile returns the residual
 * report alongside the bundle — bundle.ts's verifyBundle already names
 * profile mismatches and accounting failures; this module plumbs that
 * list into the export result so the UI layer can render it.
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
  /** The committed claims (values included) — sealed at rest by the store. */
  claims: ContextClaim[];
  inventoryAssertion: CommittedInventoryAssertion;
  /** The default Sealed-profile bundle produced at commit. */
  sealedBundle: DisclosureBundle;
  /**
   * Hex master seed — PRESENT until a burn, ABSENT (deleted) after. The
   * ONLY way any withheld rung can ever be opened (A-02: salts derive
   * from it and exist nowhere else).
   */
  masterSeedHex?: string;
  /** Burn policy: destroy the seed this many hours after createdAt. Absent = never. */
  burnAfterHours?: number;
  /** Set by applyBurn — the seed is gone from this moment on, forever. */
  burnedAt?: string;
  /**
   * Set when a SCHEDULED burn attempt failed (e.g. the store's save threw)
   * — honest, never silent. Cleared by the next
   * successful burn. A failing store can also defeat this recording itself;
   * the scheduler still isolates the failure to the one item either way.
   */
  burnFailure?: { at: string; error: string };
  /** Action log — a burn is an action, never silent. */
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
 * Destroy the master seed: the field is set to `undefined` and the property
 * then deleted from the record object (JS strings are immutable — true
 * secure erase of every transient copy is not expressible in this runtime;
 * the honest guarantee is structural: the seed is never persisted again
 * after this call, and no salt table ever existed to scrub). Burns are
 * idempotent in effect but NOT silent: a second call throws, because
 * "already burned" is a state the caller must know, not an event to
 * re-record.
 */
export function applyBurn(state: DisclosureItemState, now: Date): DisclosureItemState {
  if (state.masterSeedHex === undefined) {
    throw new Error(`burn: item '${state.itemId}' is already burned (${state.burnedAt ?? 'time unknown'}): ${BURN_FINALITY_WORDING}`);
  }
  const at = now.toISOString();
  const next: DisclosureItemState = {
    ...state,
    // Clear-then-delete: the stored record never carries the seed again.
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

/** The honest error thrown when opening a burned item (test-pinned wording). */
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
 * Rebuild the commitment (tree included) from the stored claims + seed.
 * commitContext is deterministic; the rebuilt root MUST equal the stored
 * root — a mismatch means the stored state was tampered with and is a
 * named failure, never a silent re-root.
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
 * Derive a bundle for `profile` on demand from the master seed (the
 * real-burn property: without the seed this is impossible for everyone).
 * After a burn this throws the honest 'burned' error — the withheld rungs
 * are gone, not locked. An 'open' event is recorded on the returned state
 * for the caller to persist (opening is an action too, though a
 * non-destructive one).
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
 * Residual plumbing: the disclosure export path. Derives the
 * requested profile's bundle and runs the full bundle verification
 * against the stored root + inventory — the returned `residuals` list is
 * EXACTLY verifyBundle's named failures (profile mismatch, accounting
 * gaps), empty when the export is clean. The UI layer renders this list.
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
// Persistence + scheduler (injected store — the app wires vault-sealed
// files; the lab wires memory. Policy is identical either way.)
// ---------------------------------------------------------------------------

export interface DisclosureStore {
  listIds(): Promise<string[]>;
  load(itemId: string): Promise<DisclosureItemState | null>;
  save(state: DisclosureItemState): Promise<void>;
}

/**
 * Run due burns. Every burned item is saved WITH its burn event — a burn
 * is an action, never silent, and the event log is the proof. Returns the
 * ids burned this run (an empty run is the normal case and logs nothing).
 *
 * Per-item containment: a failing load/save for ONE
 * item must never abort later items' burns. The failure is recorded in the
 * failing item's own state (`burnFailure`) — honest, never silent — on a
 * best-effort basis: when the store itself is what failed, that recording
 * can fail too, and the scheduler still moves on to the next item.
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
        // The store is failing — the next run retries; the failure is not
        // hidden by choice, the medium to report it is what is broken.
      }
    }
  }
  return burned;
}
