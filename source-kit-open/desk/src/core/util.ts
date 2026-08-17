// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * util.ts — small shared helpers, deduplicated (0.15.1 / W1).
 *
 * These used to be triplicated (downloadJson/Text/Bytes in RosterManager,
 * DeskKeyManager, howWeKnow), duplicated (mkId in Intake/App; ageLine in
 * App as rosterAgeLine vs TrustConfig), or both. One implementation now;
 * behavior unchanged. Nothing here touches the network.
 */

/** Collision-resistant-enough session id for library items. */
export function mkId(name: string): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${name.length}`;
}

/** Shared object-URL download: click, then revoke on a timer (never leaked). */
function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadJson(filename: string, obj: unknown): void {
  downloadBlob(filename, new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

export function downloadBytes(filename: string, bytes: Uint8Array, mime: string): void {
  downloadBlob(filename, new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
}

/** Plain-language roster age — a roster's freshness is always visible. */
export function ageLine(issuedAt: string): string {
  const ms = Date.parse(issuedAt);
  if (!Number.isFinite(ms)) return `issued ${issuedAt}`;
  const days = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
  return `issued ${issuedAt.slice(0, 10)} (${days === 0 ? 'today' : days === 1 ? '1 day old' : `${days} days old`})`;
}
