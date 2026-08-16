/**
 * reverseImageSearch.ts — the reverse-image-search connector STUB
 * (ARCHITECTURE §6.1/§11: the UI and consent flow ship complete; no
 * endpoint and no request implementation ship — that is deliberate, the
 * scaffolding proves the boundary UX without picking a service).
 *
 * Honesty contract: `canRun` answers N/A-with-reason (L3) for every case
 * where nothing can happen — no media, no bytes in the tab, no endpoint
 * declared — so the card shows a reason instead of error theater. `run`
 * contains NO fetch: it reports plainly that no request was made and that
 * the recorded consent was not used to transmit anything.
 */

import type { Connector, ConnectorResult } from '../../contracts-ext';
import { fmtBytes, type DeskItem } from '../deskItem';
import { AI } from '../aiStrings';

export const NO_ENDPOINT_REASON = 'No endpoint configured — declare one in Settings.';
/**
 * E26: a stub never solicits consent. With no request implementation there
 * is NOTHING a consent could authorize, so the connector answers N/A with
 * the reason — no dialog, no audit entry, no error theater for a no-op.
 */
export const NO_IMPLEMENTATION_REASON =
  'No request implementation in this build — the consent boundary is proven, nothing can be sent.';

/** The stub's honest outcome when a user confirms an action anyway. */
function stubResult(provider: string): ConnectorResult {
  return {
    ok: false,
    summary: '',
    error:
      `No request was made to ${provider}: this build ships the consent boundary without a ` +
      'request implementation for this connector. Your consent was recorded in the audit trail, ' +
      'and nothing left this tab.',
  };
}

export function createReverseImageSearchConnector(endpoint: string | null): Connector {
  const provider = 'the configured search service';
  return {
    id: 'reverse-image-search',
    name: AI.connector.ris.name,
    provider,
    payloadKind: 'bytes',
    describesPayload(item: DeskItem): string {
      return item.bytes
        ? `the image bytes (${fmtBytes(item.bytes.length)})`
        : 'the image bytes (not held in this tab)';
    },
    canRun(item: DeskItem) {
      if (item.kind !== 'media') {
        return { ok: false as const, reason: 'this item carries no media to search with' };
      }
      if (!item.bytes) {
        return { ok: false as const, reason: 'this item’s bytes are not held in this tab' };
      }
      if (!endpoint) {
        return { ok: false as const, reason: NO_ENDPOINT_REASON };
      }
      return { ok: false as const, reason: NO_IMPLEMENTATION_REASON };
    },
    async run(_item: DeskItem, _signal: AbortSignal): Promise<ConnectorResult> {
      // No network in this wave — by design, not by omission (§5.4).
      if (!endpoint) return { ok: false, summary: '', error: NO_ENDPOINT_REASON };
      return stubResult(provider);
    },
  };
}
