// Source Kit 0.1.0 — Synchronous pub/sub channel for gesture-live values
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Synchronous pub/sub channel for gesture-live values. Gesture sources
 * (pinch, zoom wheel, value ribbon) push here instead of React state so a
 * drag never re-renders the viewfinder tree; leaf readouts subscribe via
 * useSyncExternalStore and the screen updates only on gesture commit.
 * Emit replaces the snapshot object wholesale, which is what
 * useSyncExternalStore's referential-equality check requires.
 */
export class LiveChannel<T> {
  private snapshot: T;
  private listeners = new Set<() => void>();

  constructor(initial: T) {
    this.snapshot = initial;
  }

  get = (): T => this.snapshot;

  emit(next: T): void {
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** Live zoom readout payload: the relative-to-wide factor and whether a
 *  zoom gesture (pinch or wheel) is currently driving it. */
export interface LiveZoom {
  factor: number;
  active: boolean;
}
