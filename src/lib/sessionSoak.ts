// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Session soak — the multi-cam lifecycle, on demand, on a device.
 *
 * The camera's failure mode is not a wrong value; it is an ordering bug
 * between queues nobody here owns, and it is invisible to a typechecker,
 * invisible to the suites (the shims replace every native import), and
 * invisible to the compile gate. It only appears when a session is really
 * configured and really stopped, on real hardware, enough times.
 *
 * The session itself is never deallocated — see the native module — so what
 * this loop exercises is the rewire: strip the graph, build a new one in
 * place, start, stop. Alternating cameras is what makes it worth running,
 * because a facing flip is a full teardown and rebuild of every input,
 * output, and connection on a live session.
 *
 * Watch for three things this run can catch and nothing else can. A stop
 * that creeps longer each cycle means outputs are accumulating rather than
 * being stripped. An error event that fires twice for one fault means a
 * session-lifetime observer was attached more than once. And a first frame
 * showing the previous camera means the preview's stale-frame shield did not
 * re-arm across the rewire.
 *
 * What this does NOT cover: the background-and-foreground path. iOS decides
 * when an app is suspended, so a loop cannot drive it. Backgrounding by hand
 * mid-soak is still worth doing, and the caller's copy says so.
 */
import { configureSession, stopSession, onSessionError, type ExhibitFacing } from './exhibitCamera';
import { logDiagnostic } from './diagnosticsLog';

/** One completed configure-and-stop, and how long the pair took. */
export interface SoakCycle {
  index: number;
  facing: ExhibitFacing;
  openMs: number;
  closeMs: number;
}

export interface SoakReport {
  /** Cycles that configured and stopped without an error event. */
  completed: number;
  /** Cycles asked for. A short run means something stopped it. */
  requested: number;
  /** The first error that stopped the run, verbatim. */
  stoppedBy: string | null;
  /** Slowest configure and stop seen, milliseconds. A stop that creeps
   *  across cycles means the graph is not being fully stripped. */
  slowestOpenMs: number;
  slowestCloseMs: number;
  totalMs: number;
}

export interface SoakOptions {
  /** Configure-and-stop pairs. Each cycle alternates the camera. */
  cycles?: number;
  /** Called after every cycle so the screen can count up. */
  onCycle?: (c: SoakCycle) => void;
  /** Set true to stop early; checked between cycles. */
  shouldStop?: () => boolean;
}

const DEFAULT_CYCLES = 40;

/**
 * Runs the loop. Resolves with a report whether it finished or stopped;
 * rejects only if the very first configureSession throws, which means the
 * camera was never available and there is nothing to soak.
 */
export async function runSessionSoak(opts: SoakOptions = {}): Promise<SoakReport> {
  const requested = Math.max(1, opts.cycles ?? DEFAULT_CYCLES);
  const startedAt = Date.now();

  // Session errors arrive on their own channel, not as a rejected promise, so
  // the loop watches the channel and stops on the first one.
  let firstError: string | null = null;
  const unsubscribe = onSessionError((e) => {
    if (firstError === null) firstError = `${e.code}: ${e.message}`;
  });

  let completed = 0;
  let slowestOpenMs = 0;
  let slowestCloseMs = 0;

  try {
    for (let i = 0; i < requested; i++) {
      if (firstError !== null || opts.shouldStop?.()) break;

      const facing: ExhibitFacing = i % 2 === 0 ? 'back' : 'front';

      const openStart = Date.now();
      await configureSession({ facing, stereo: true });
      const openMs = Date.now() - openStart;

      const closeStart = Date.now();
      await stopSession();
      const closeMs = Date.now() - closeStart;

      if (openMs > slowestOpenMs) slowestOpenMs = openMs;
      if (closeMs > slowestCloseMs) slowestCloseMs = closeMs;
      completed = i + 1;
      opts.onCycle?.({ index: i, facing, openMs, closeMs });
    }
  } catch (e) {
    if (firstError === null) firstError = e instanceof Error ? e.message : String(e);
  } finally {
    unsubscribe();
    // Leave the camera closed however the run ended.
    try {
      await stopSession();
    } catch {
      // Already closed, or closed by the failure being reported.
    }
  }

  const report: SoakReport = {
    completed,
    requested,
    stoppedBy: firstError,
    slowestOpenMs,
    slowestCloseMs,
    totalMs: Date.now() - startedAt,
  };

  logDiagnostic({
    t: Date.now(),
    kind: 'camera',
    outcome: report.stoppedBy === null ? 'info' : 'failed',
    message:
      report.stoppedBy === null
        ? `Session soak: ${report.completed} open/close cycles, no errors. Slowest close ${report.slowestCloseMs} ms.`
        : `Session soak stopped at cycle ${report.completed} of ${report.requested}: ${report.stoppedBy}`,
  });

  return report;
}

/** The one-line result, for the screen and for a screenshot. */
export function describeSoak(r: SoakReport): string {
  if (r.stoppedBy !== null) {
    return `Stopped at cycle ${r.completed} of ${r.requested} — ${r.stoppedBy}`;
  }
  return `${r.completed} cycles, no errors · slowest open ${r.slowestOpenMs} ms, slowest close ${r.slowestCloseMs} ms`;
}
