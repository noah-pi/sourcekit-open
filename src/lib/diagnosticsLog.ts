// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Diagnostics log — because a 3-second toast is not a record.
 *
 * A capture or seal failure can otherwise evaporate: the toast fades, the
 * seal queue keeps its error string on a job nobody renders, and the user is
 * left with an empty Exhibits tab and no explanation. This module is the
 * small, plain memory of what happened: a ring buffer of the last 30
 * capture/seal events, persisted as JSON under documentDirectory, read
 * back newest-first by the Settings screen.
 *
 * Deliberate properties:
 *   - Diagnostics NEVER sink anything. Every write is fire-and-forget and
 *     every read failure is an empty list — a logging bug must not become
 *     a capture failure.
 *   - Messages are verbatim error strings (native or JS). No paraphrase,
 *     no euphemism.
 *   - Plaintext JSON, not vault-sealed: it carries only error strings and
 *     timestamps — the facts a support conversation needs, available even
 *     when the vault is locked. No media, no location, no identity.
 */

import * as FileSystem from 'expo-file-system/legacy';

export interface DiagnosticEvent {
  /** Milliseconds epoch — set by the caller at the moment the event happened. */
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
    // Pure information: native pipeline diagnostics — connection
    // census, format picks, interruption boundaries. Never a failure.
    | 'info';
  /** The verbatim error/reason string, when one exists. */
  message?: string;
}

const MAX_EVENTS = 30;
const FILE = `${FileSystem.documentDirectory}diagnostics.json`;

type Listener = (events: DiagnosticEvent[]) => void;

let events: DiagnosticEvent[] | null = null; // null = not yet loaded; newest-first
// Cold-start guard: concurrent ensureLoaded callers await the SAME in-flight
// read. Without it, two logDiagnostic calls before the first disk read
// resolves would each build their own array and the second would clobber
// the first — a lost event, silently.
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
    // Missing or corrupt file = an empty log, stated as such by the UI.
    events = [];
  }
  return events;
}

function ensureLoaded(): Promise<DiagnosticEvent[]> {
  if (events) return Promise.resolve(events);
  if (!loading) {
    // loadFromDisk never throws (its own catch is the empty-list fallback).
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
 * Record an event. Fire-and-forget by design — callers log and move on;
 * a diagnostics write must never delay, let alone fail, a capture or seal.
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

/** The log, newest first. Never throws — a read failure is an empty list. */
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
  // Settle any in-flight cold-start read first — otherwise it would resolve
  // AFTER the clear and resurrect the cleared events from disk.
  void (async () => {
    await ensureLoaded();
    events = [];
    persist();
    notify();
  })();
}
