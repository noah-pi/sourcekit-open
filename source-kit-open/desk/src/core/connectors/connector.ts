/**
 * connector.ts — the Tier-3 connector consent plumbing (ARCHITECTURE
 * §5.4/§6.1/§6.2, DESIGN §5.8/§5.9). DOM-free pure logic: the components
 * render the states, this module owns the state machine.
 *
 * The law this file enforces mechanically:
 *  - L10: `run` is NEVER called without a recorded consent. The flow is the
 *    only caller of `connector.run`, and it invokes it exclusively from the
 *    `previewing` state, after writing a `consent-granted` audit entry.
 *  - Consent is per action: there is no persistence of "yes", no
 *    "don't ask again".
 *  - A refusal is honesty evidence: `consent-refused` is written to the
 *    case-file audit trail, and `run` is never invoked on that path.
 *  - Every crossing — granted, refused, completed, failed, aborted — lands
 *    in the audit trail with the exact payload description, the destination
 *    host, and the outcome (§5.4), which powers Settings → "what left this
 *    browser".
 *  - The boundary indicator (§5.9) flips to `topbar.boundary.sending` for
 *    exactly the duration of the request and returns afterwards — the
 *    `boundary` hook is called with the host on send and `null` on settle,
 *    on EVERY path (resolve, reject, abort).
 *
 * State machine (§6.2):
 *   idle → previewing → sending → done | error | aborted
 *                 └→ refused            (refusal never reaches sending)
 * Terminal states (done/error/aborted/refused) return to idle via reset().
 */

import type { Connector, ConnectorConsent, ConnectorResult } from '../../contracts-ext';
import type { DeskItem } from '../deskItem';

export type ConsentState =
  | { phase: 'idle' }
  | { phase: 'previewing'; connector: Connector; item: DeskItem; payload: string; destination: string; host: string }
  | { phase: 'sending'; connector: Connector; item: DeskItem; payload: string; destination: string; host: string }
  | { phase: 'done'; connector: Connector; payload: string; destination: string; result: ConnectorResult }
  | { phase: 'error'; connector: Connector; payload: string; destination: string; result: ConnectorResult }
  | { phase: 'refused'; connector: Connector; payload: string; destination: string }
  | { phase: 'aborted'; connector: Connector; payload: string; destination: string };

export interface ConsentHooks {
  /** Called synchronously on every transition. */
  onState: (state: ConsentState) => void;
  /** Case-file audit sink (appendAudit); must never throw. */
  audit: (action: string, detail?: string) => void;
  /** Boundary-indicator sink: host while sending, null otherwise. */
  boundary: (host: string | null) => void;
  /** ISO clock — injectable for deterministic tests. */
  now?: () => string;
}

/** The host a configured endpoint points at; null when undeclared/invalid. */
export function connectorHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host || null;
  } catch {
    return null;
  }
}

/** "Provider (host)" — the consent dialog's destination line. */
export function connectorDestination(connector: Connector, endpoint: string | null | undefined): string {
  const host = connectorHost(endpoint);
  return host ? `${connector.provider} (${host})` : `${connector.provider} (no endpoint declared)`;
}

function consentDetail(consent: ConnectorConsent, connectorName: string): string {
  return (
    `${connectorName}: consent ${consent.accepted ? 'granted' : 'refused'} — ` +
    `would send ${consent.payloadDescription} to ${consent.destination}`
  );
}

export class ConnectorConsentFlow {
  private state: ConsentState = { phase: 'idle' };
  private controller: AbortController | null = null;

  constructor(private readonly hooks: ConsentHooks) {}

  get current(): ConsentState {
    return this.state;
  }

  private set(state: ConsentState): void {
    this.state = state;
    this.hooks.onState(state);
  }

  private now(): string {
    return this.hooks.now ? this.hooks.now() : new Date().toISOString();
  }

  /**
   * Open the consent dialog for one action. Runs the connector's own N/A
   * gate first: a connector that cannot run on this item answers with its
   * reason and NO dialog opens (L3 — N/A is a state, not an error).
   */
  preview(
    connector: Connector,
    item: DeskItem,
    endpoint: string | null,
  ): { ok: true } | { ok: false; reason: string } {
    const can = connector.canRun(item);
    if (!can.ok) return can;
    const payload = connector.describesPayload(item);
    const destination = connectorDestination(connector, endpoint);
    const host = connectorHost(endpoint) ?? 'no endpoint declared';
    this.set({ phase: 'previewing', connector, item, payload, destination, host });
    return { ok: true };
  }

  /**
   * The user confirmed. Records `consent-granted` FIRST, then — and only
   * then — invokes `connector.run` under an AbortController. Settles to
   * done / error / aborted; the boundary indicator is lowered on every
   * path. A confirm outside `previewing` is a no-op: consent is per action
   * and `run` is never called without one.
   */
  async confirm(): Promise<void> {
    if (this.state.phase !== 'previewing') return;
    const { connector, item, payload, destination, host } = this.state;
    const consent: ConnectorConsent = {
      connectorId: connector.id,
      payloadDescription: payload,
      destination,
      decidedAt: this.now(),
      accepted: true,
    };
    this.hooks.audit('consent-granted', consentDetail(consent, connector.name));

    const controller = new AbortController();
    this.controller = controller;
    this.set({ phase: 'sending', connector, item, payload, destination, host });
    this.hooks.boundary(host);
    try {
      const result = await connector.run(item, controller.signal);
      if (controller.signal.aborted) {
        // The user aborted while a late resolve was in flight — the late
        // answer is discarded, stated plainly.
        this.hooks.audit(
          'external-check',
          `${connector.name} → ${host}: aborted by the user; a late answer was discarded, nothing was computed from it (payload: ${payload})`,
        );
        this.set({ phase: 'aborted', connector, payload, destination });
      } else if (result.ok) {
        this.hooks.audit(
          'external-check',
          `${connector.name} → ${host}: sent ${payload}; outcome: answered (${result.summary.slice(0, 160)})`,
        );
        this.set({ phase: 'done', connector, payload, destination, result });
      } else {
        this.hooks.audit(
          'external-check',
          `${connector.name} → ${host}: sent ${payload}; outcome: no usable answer — ${result.error ?? 'declined'}`,
        );
        this.set({ phase: 'error', connector, payload, destination, result });
      }
    } catch (e) {
      if (controller.signal.aborted) {
        this.hooks.audit(
          'external-check',
          `${connector.name} → ${host}: aborted by the user before completion; nothing was computed from the attempt (payload: ${payload})`,
        );
        this.set({ phase: 'aborted', connector, payload, destination });
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        const result: ConnectorResult = { ok: false, summary: '', error: msg };
        this.hooks.audit(
          'external-check',
          `${connector.name} → ${host}: the attempt itself failed (${msg.slice(0, 160)}); nothing was computed locally (payload: ${payload})`,
        );
        this.set({ phase: 'error', connector, payload, destination, result });
      }
    } finally {
      this.controller = null;
      this.hooks.boundary(null);
    }
  }

  /**
   * The user declined at the dialog. `run` is NEVER called on this path;
   * the refusal itself is written to the audit trail as honesty evidence.
   */
  refuse(): void {
    if (this.state.phase !== 'previewing') return;
    const { connector, payload, destination } = this.state;
    const consent: ConnectorConsent = {
      connectorId: connector.id,
      payloadDescription: payload,
      destination,
      decidedAt: this.now(),
      accepted: false,
    };
    this.hooks.audit('consent-refused', consentDetail(consent, connector.name));
    this.set({ phase: 'refused', connector, payload, destination });
  }

  /** Cancel mid-flight. The in-flight run's settle drives the transition. */
  abort(): void {
    if (this.state.phase !== 'sending' || !this.controller) return;
    this.controller.abort();
  }

  /** Dismiss a terminal state (done/error/aborted/refused) back to idle. */
  reset(): void {
    if (this.state.phase === 'previewing' || this.state.phase === 'sending') return;
    this.set({ phase: 'idle' });
  }
}
