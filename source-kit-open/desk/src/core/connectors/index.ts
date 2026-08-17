// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * connectors/index.ts — the connector registry (ARCHITECTURE §6.1).
 *
 * CONNECTORS holds the declared connectors in their SHIPPED state: no
 * endpoint configured, always opt-in. resolveConnectors(prefs) rebuilds
 * the same list with the user's declared endpoints merged in (Settings →
 * connectors card, exhibitC.connectors.v1). No connector here performs any
 * network call — this build ships the boundary scaffolding only.
 */

import type { Connector, ConnectorPrefs } from '../../contracts-ext';
import { createReverseImageSearchConnector } from './reverseImageSearch';
import { createWatermarkCheckConnector } from './watermarkCheck';

/** The declared connectors as shipped — unconfigured, opt-in. */
export const CONNECTORS: Connector[] = [
  createReverseImageSearchConnector(null),
  createWatermarkCheckConnector(null),
];

/** The registry with user-declared endpoints merged in. */
export function resolveConnectors(prefs: ConnectorPrefs): Connector[] {
  return [
    createReverseImageSearchConnector(prefs['reverse-image-search']?.endpoint ?? null),
    createWatermarkCheckConnector(prefs['watermark-check']?.endpoint ?? null),
  ];
}

export { ConnectorConsentFlow, connectorHost, connectorDestination } from './connector';
export type { ConsentState, ConsentHooks } from './connector';
