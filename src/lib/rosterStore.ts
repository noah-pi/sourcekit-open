// Source Kit 0.1.0 — roster storage: the device's copy
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Roster storage: the device's copy of one or more signed newsroom rosters,
 * held in the OS keychain (WHEN_UNLOCKED_THIS_DEVICE_ONLY).
 *
 * A roster is accepted only after its editor signature verifies. Import is
 * explicit (paste or file), and a signer whose fingerprint is not listed is
 * never upgraded.
 */

import * as SecureStore from 'expo-secure-store';
import {
  isRoster,
  resolveInRoster,
  verifyRosterSignature,
  type Roster,
  type RosterResolution,
} from './roster';

const STORE_KEY = 'verify_rosters_v1';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

async function readAll(): Promise<Roster[]> {
  try {
    const raw = await SecureStore.getItemAsync(STORE_KEY, OPTIONS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRoster) : [];
  } catch {
    return [];
  }
}

async function writeAll(rosters: Roster[]): Promise<void> {
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(rosters), OPTIONS);
}

export async function listRosters(): Promise<Roster[]> {
  return readAll();
}

export type RosterImportResult =
  | { ok: true; roster: Roster }
  | { ok: false; error: string };

/**
 * Imports a signed roster from its JSON text. The editor signature must
 * verify; failure states are plain strings for the UI.
 */
export async function importRosterJson(json: string): Promise<RosterImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'not valid JSON; import the roster file exactly as distributed' };
  }
  if (!isRoster(parsed)) {
    return { ok: false, error: 'not a verify-roster/1 file; fields are missing or malformed' };
  }
  const check = verifyRosterSignature(parsed);
  if (!check.valid) {
    return { ok: false, error: check.reason ?? 'editor signature invalid' };
  }
  const all = await readAll();
  // A newer roster from the same editor key replaces the older one; issue
  // time decides, and equal times keep the existing one.
  const rest = all.filter((r) => r.editor.fingerprint !== parsed.editor.fingerprint);
  const existing = all.find((r) => r.editor.fingerprint === parsed.editor.fingerprint);
  if (existing && Date.parse(existing.issuedAt) > Date.parse(parsed.issuedAt)) {
    return { ok: true, roster: existing };
  }
  await writeAll([...rest, parsed]);
  return { ok: true, roster: parsed };
}

export async function removeRoster(editorFingerprint: string): Promise<void> {
  const all = await readAll();
  await writeAll(all.filter((r) => r.editor.fingerprint !== editorFingerprint));
}

/**
 * Resolves a signer against every stored roster; first hit wins, so a key
 * listed in two rosters shows as the first. `atMs` must be a verified
 * signing time or null.
 */
export async function resolveSignerInRosters(
  fingerprint: string,
  atMs: number | null
): Promise<RosterResolution | null> {
  const all = await readAll();
  for (const roster of all) {
    const hit = resolveInRoster(roster, fingerprint, atMs);
    if (hit) return hit;
  }
  return null;
}
