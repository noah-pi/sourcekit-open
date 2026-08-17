// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Case-session helpers — building and restoring the desk's .exhibitcase
 * snapshots (the format itself, the chain, and the fail-closed parse live in
 * caseFile.ts; this module is the thin desk-side mapping).
 *
 * Two standing rules:
 *  - Bytes never go into a case file. Items are recorded by path + SHA-256 +
 *    verdict snapshot + the parsed report/artifact JSON. Re-opening a case
 *    restores REFERENCES; re-verifying against the original bytes means
 *    re-dropping the file, and the desk says exactly that.
 *  - Trust restored from a file is re-proven, never inherited: rosters from
 *    a case's trust snapshot are trusted only after their editor signature
 *    verifies HERE, and the online-checks opt-in is never restored from a
 *    file (the network stays per-session).
 */

import type { VerificationReport } from '@exhibit-archive/handrolled-verifier/verifyAsset';
import { isProofBundle, isHashClaim } from '@exhibit/lib/proofBundle';
import { isRoster, type Roster } from '@exhibit/lib/roster';
import type { ExhibitCase, CaseNote } from './caseFile';
import type { DeskItem } from './deskItem';

/** What the desk stores per item: the verdict snapshot and the parsed artifact. */
function reportPayloadFor(item: DeskItem): unknown {
  if (item.kind === 'media') return item.report ?? null;
  if (item.kind === 'proof-bundle') return item.bundle ?? null;
  if (item.kind === 'hash-claim') return item.claim ?? null;
  return null;
}

/**
 * Overlay the live session onto the case (whose auditTrail is maintained
 * incrementally) to produce the object serializeCase() writes. The audit
 * trail passes through by reference — appends keep chaining onto it.
 */
export function buildCaseSnapshot(
  base: ExhibitCase,
  session: {
    items: DeskItem[];
    trustedRosters: Roster[];
    thresholds: { likely: number; possible: number };
    notes: CaseNote[];
    notice: string | null;
  },
): ExhibitCase {
  return {
    ...base,
    modifiedAt: new Date().toISOString(),
    items: session.items
      .filter((i) => typeof i.sha256Hex === 'string' && i.sha256Hex.length === 64)
      .map((i) => ({
        path: i.name,
        sha256: i.sha256Hex!,
        verdictSnapshot: {
          kind: i.kind,
          verdict: i.report?.verdict ?? null,
          headline: i.error ?? null,
        },
        report: reportPayloadFor(i),
      })),
    trustConfigSnapshot: {
      trustedRosters: session.trustedRosters,
      thresholds: session.thresholds,
      note: 'onlineChecks is deliberately NOT saved — the network opt-in is per-session and is never restored from a file.',
    },
    notices: session.notice ? [session.notice] : [],
    notes: session.notes,
  };
}

/**
 * Restore case items as desk intake items — references, not bytes. Media
 * items carry their parsed report (the dossier renders from it); proof
 * bundles and hash claims re-run their consistency checks on arrival like
 * any intake. Items without a restorable artifact come back as honest
 * 'unknown' references.
 */
export function restoreCaseItems(c: ExhibitCase): DeskItem[] {
  return c.items.map((ci, i) => {
    const base = {
      id: `case-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      name: ci.path,
      sha256Hex: ci.sha256,
      // DeskItem.addedAt: a restore enters the workspace now — the
      // case format saves no intake times, so restore time is the honest value.
      addedAt: Date.now(),
    };
    const rep = ci.report;
    if (rep && isProofBundle(rep)) return { ...base, kind: 'proof-bundle' as const, bundle: rep };
    if (rep && isHashClaim(rep)) return { ...base, kind: 'hash-claim' as const, claim: rep };
    if (rep && typeof rep === 'object' && 'verdict' in rep) {
      return { ...base, kind: 'media' as const, report: rep as VerificationReport };
    }
    return {
      ...base,
      kind: 'unknown' as const,
      error:
        'Restored from a case file: only the SHA-256 and verdict snapshot were saved for this item. ' +
        'Re-drop the original file to check it again — Source Kit Desk never treats a saved snapshot as fresh evidence.',
    };
  });
}

/**
 * Read the trust snapshot out of an opened case. Rosters are returned
 * UNTRUSTED — the caller must verify each signature before trusting. The
 * online-checks flag is never read back (per-session by design).
 */
export function readTrustSnapshot(c: ExhibitCase): {
  rosters: Roster[];
  thresholds: { likely: number; possible: number } | null;
} {
  const t = c.trustConfigSnapshot;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { rosters: [], thresholds: null };
  const rec = t as Record<string, unknown>;
  const rosters = Array.isArray(rec.trustedRosters)
    ? (rec.trustedRosters as unknown[]).filter((r): r is Roster => isRoster(r))
    : [];
  const th = rec.thresholds as { likely?: unknown; possible?: unknown } | null | undefined;
  const thresholds =
    th && typeof th.likely === 'number' && typeof th.possible === 'number' &&
    th.likely >= 1 && th.possible >= th.likely && th.possible <= 32
      ? { likely: th.likely, possible: th.possible }
      : null;
  return { rosters, thresholds };
}
