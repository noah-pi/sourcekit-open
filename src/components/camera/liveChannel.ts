// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Tiny synchronous pub/sub channel for gesture-live values (0.15.0 Drop 2).
 *
 * The camera screen's hard perf rule: a drag gesture must never re-render
 * the viewfinder tree. Gesture sources (pinch, zoom wheel, value ribbon)
 * push their live values into a channel instead of React state; the small
 * leaf components that display them (ZoomHud, ZoomWheel) subscribe via
 * useSyncExternalStore and re-render alone. The screen itself updates only
 * on gesture COMMIT.
 *
 * The snapshot object is replaced wholesale on each emit, so
 * useSyncExternalStore's referential-equality check behaves (no render
 * loop, no stale reads).
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
