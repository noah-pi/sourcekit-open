// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * watermarkCheck.ts — the watermark-check connector STUB (same contract as
 * reverseImageSearch.ts: complete boundary UX, no endpoint, no request
 * implementation, N/A-with-reason instead of error theater).
 *
 * Payload declaration: the file's SHA-256 hash — the privacy-preserving
 * option; the media bytes themselves are never part of this connector's
 * declared payload. Any provider answer would be THEIR statement, labeled
 * "shown as received" (L9): Source Kit Desk does not detect watermarks itself.
 */

import type { Connector, ConnectorResult } from '../../contracts-ext';
import type { DeskItem } from '../deskItem';
import { AI } from '../aiStrings';
import { NO_ENDPOINT_REASON } from './reverseImageSearch';

export function createWatermarkCheckConnector(endpoint: string | null): Connector {
  const provider = 'the configured watermark provider';
  return {
    id: 'watermark-check',
    name: 'Watermark check',
    provider,
    payloadKind: 'hash',
    describesPayload(): string {
      return 'the file’s SHA-256 hash';
    },
    canRun(item: DeskItem) {
      if (!item.sha256Hex) {
        return { ok: false as const, reason: 'no SHA-256 was computed for this item' };
      }
      if (!endpoint) {
        return { ok: false as const, reason: NO_ENDPOINT_REASON };
      }
      return { ok: true as const };
    },
    async run(_item: DeskItem, _signal: AbortSignal): Promise<ConnectorResult> {
      // No network in this wave — by design, not by omission (§5.4).
      if (!endpoint) return { ok: false, summary: '', error: NO_ENDPOINT_REASON };
      return {
        ok: false,
        summary: '',
        error:
          `No request was made to ${provider}: this build ships the consent boundary without a ` +
          'request implementation for this connector. Your consent was recorded in the audit ' +
          'trail, and nothing left this tab.',
      };
    },
  };
}

/** Deck name/desc with the provider interpolated (ai.connector.wm.*). */
export const watermarkCheckDisplay = {
  name: (provider: string) => AI.connector.wm.name(provider),
  desc: (provider: string) => AI.connector.wm.desc(provider),
};
