// Source Kit 0.1.0 — diagnostics log: a ring buffer of the last
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Diagnostics log: a ring buffer of the last 30 capture/seal events,
 * persisted as JSON under documentDirectory and read back newest-first by
 * the Settings screen.
 *
 *   - Writes are fire-and-forget and read failures return an empty list, so
 *     a logging bug cannot become a capture failure.
 *   - Messages are verbatim error strings, native or JS.
 *   - Plaintext JSON, not vault-sealed: error strings and timestamps only,
 *     readable while the vault is locked. No media, location, or identity.
 */

import * as FileSystem from 'expo-file-system/legacy';

export interface DiagnosticEvent {
  /** Milliseconds epoch, set by the caller when the event happened. */
  t: number;
  kind: 'photo' | 'video' | 'audio' | 'seal' | 'camera';
  outcome:
    | 'captured'
    | 'captured-degraded'
    | 'failed'
    | 'sealed'
    | 'seal-failed'
    | 'retry'
    | 'discard'
    // Vault locked at seal time (auth window, not a seal fault): the job
    // stays pending and seals after the next unlock.
    | 'seal-deferred'
    // Native pipeline diagnostics: connection census, format picks,
    // interruption boundaries. Not a failure.
    | 'info';
  /** The verbatim error or reason string, when one exists. */
  message?: string;
}

const MAX_EVENTS = 30;
const FILE = `${FileSystem.documentDirectory}diagnostics.json`;

type Listener = (events: DiagnosticEvent[]) => void;

let events: DiagnosticEvent[] | null = null; // null = not yet loaded; newest-first
// Cold-start guard: concurrent ensureLoaded callers await the same in-flight
// read. Without it two logDiagnostic calls before the first disk read
// resolves each build their own array and one clobbers the other.
let loading: Promise<DiagnosticEvent[]> | null = null;
// Serializes persists so two log lines can't interleave a partial write.
let writing: Promise<unknown> = Promise.resolve();
const listeners = new Set<Listener>();

function isEvent(x: unknown): x is DiagnosticEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as Partial<DiagnosticEvent>;
  return (
    typeof e.t === 'number' &&
    (e.kind === 'photo' || e.kind === 'video' || e.kind === 'audio' || e.kind === 'seal' || e.kind === 'camera') &&
    typeof e.outcome === 'string'
  );
}

async function loadFromDisk(): Promise<DiagnosticEvent[]> {
  try {
    const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(FILE));
    events = Array.isArray(parsed) ? parsed.filter(isEvent).slice(0, MAX_EVENTS) : [];
  } catch {
    // Missing or corrupt file reads as an empty log.
    events = [];
  }
  return events;
}

function ensureLoaded(): Promise<DiagnosticEvent[]> {
  if (events) return Promise.resolve(events);
  if (!loading) {
    // loadFromDisk never throws; its own catch falls back to an empty list.
    loading = loadFromDisk().then((v) => {
      loading = null;
      return v;
    });
  }
  return loading;
}

function snapshot(): DiagnosticEvent[] {
  return (events ?? []).map((e) => ({ ...e }));
}

function notify(): void {
  const s = snapshot();
  listeners.forEach((l) => l(s));
}

function persist(): void {
  const body = JSON.stringify(events ?? []);
  writing = writing.then(() => FileSystem.writeAsStringAsync(FILE, body)).catch(() => {});
}

/**
 * Record an event. Fire-and-forget: a diagnostics write must never delay or
 * fail a capture or seal.
 */
export function logDiagnostic(event: DiagnosticEvent): void {
  void (async () => {
    const list = await ensureLoaded();
    list.unshift(event);
    if (list.length > MAX_EVENTS) list.length = MAX_EVENTS;
    persist();
    notify();
  })();
}

/** The log, newest first. Never throws; a read failure is an empty list. */
export async function readDiagnostics(): Promise<DiagnosticEvent[]> {
  await ensureLoaded();
  return snapshot();
}

/** Mirrors subscribeSeals: immediate snapshot on subscribe, then live updates. */
export function subscribeDiagnostics(l: Listener): () => void {
  listeners.add(l);
  ensureLoaded()
    .then(notify)
    .catch(() => {});
  return () => listeners.delete(l);
}

/** User-initiated clear (Settings). Empties memory and disk. */
export function clearDiagnostics(): void {
  // Settle any in-flight cold-start read first, or it resolves after the
  // clear and resurrects the cleared events from disk.
  void (async () => {
    await ensureLoaded();
    events = [];
    persist();
    notify();
  })();
}
