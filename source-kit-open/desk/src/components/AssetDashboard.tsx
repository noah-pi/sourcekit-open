// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * AssetDashboard — the per-asset dashboard (DESIGN §4.2): custody summary
 * banner above an ALWAYS-rendered four-tab bar (Overview · Signals ·
 * Forensics · AI Forensics). Props are exactly AssetDashboardProps
 * (contracts.ts); the Tier-0 record rides on the item (cached at intake).
 *
 * Ethos laws enforced by the rendering itself:
 *  - The banner is a summary of FACTS, not a verdict (§5.1). Green only when
 *    integrity is intact AND the signer is roster-trusted (L6); brick red
 *    only for bytes-changed / signature-invalid (L5); unsigned is neutral.
 *  - Tabs never hide and never reorder: Forensics and AI Forensics render
 *    honest placeholder/absence states until their waves ship (L4).
 *  - Every measured signal row carries its ⓘ "can show / cannot show" pair
 *    (§10.13) and its own N/A state with a reason (L3).
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { AssetDashboardProps } from '../contracts';
import { DASHBOARD_TABS, type BasisRef, type ConnectorPrefs, type DashboardTabId } from '../contracts-ext';
import { fmtBytes, type DeskItem } from '../core/deskItem';
import { OverviewTab } from './dashboard/OverviewTab';
import { SignalsTab } from './dashboard/SignalsTab';
import { ForensicsTab } from './dashboard/ForensicsTab';
import { AiForensicsTab } from './dashboard/AiForensicsTab';
import '../dashboard.css';

/* ------------------------------------------------------------------ */
/* ⓘ tooltips + signal rows live in ./dashboard/dashUi (leaf module) —  */
/* extracted to break the dashboard↔tabs circular import (TDZ crash).   */
/* Re-exported here for backward compatibility.                         */
/* ------------------------------------------------------------------ */

export { TOOLTIPS, InfoTip, SignalRow } from './dashboard/dashUi';

/* ------------------------------------------------------------------ */
/* Custody summary banner (§5.1 state table + §10.4 strings, verbatim)  */
/* ------------------------------------------------------------------ */

export type BannerTone = 'green' | 'danger' | 'warn' | 'neutral';

export interface Banner {
  tone: BannerTone;
  headline: string;
  sub: string | null;
}

export function bannerFor(props: AssetDashboardProps): Banner {
  const { item, trust, artifact, matches } = props;
  const rostered = trust?.tier === 'roster' && !trust.warning;

  if (item.kind === 'unknown' || item.kind === 'roster') {
    return {
      tone: 'neutral',
      headline: 'Not a checkable file',
      sub: item.error ?? 'Not a JPEG/PNG/MP4/MOV or an Exhibit artifact. Saying so plainly rather than guessing.',
    };
  }

  if (item.kind === 'hash-claim') {
    const exact = matches.filter((m) => m.proofItemId === item.id && m.grade === 'exact');
    if (exact.length > 0) {
      return {
        tone: rostered ? 'green' : 'neutral',
        headline: 'Hash claim matched — exact',
        sub: `${exact[0].mediaName} has the exact SHA-256 this claim commits to. The match itself is cryptographic.`,
      };
    }
    return {
      tone: 'neutral',
      headline: 'Hash-only claim — awaiting its media',
      sub: 'This claim carries hashes and a signer fingerprint only — no media, no signature (source protection, by design). It can only be matched exactly; re-encoded media can never match, and Source Kit Desk will say so rather than approximate.',
    };
  }

  if (item.kind === 'proof-bundle') {
    const ok = artifact && artifact.signatureValid && artifact.fingerprintMatches && artifact.payloadDigestMatches;
    return ok
      ? {
          tone: 'neutral',
          headline: 'Proof bundle internally consistent',
          sub: 'Signature, signer fingerprint, and payload digest all verify. Media is not included — match it to bytes via recovery below.',
        }
      : {
          tone: 'danger',
          headline: 'Proof bundle failed a consistency check',
          sub: 'Something in this bundle does not check out. Treat every claim in it as unchecked.',
        };
  }

  // Media.
  const v = item.report?.verdict;
  switch (v) {
    case 'INTACT':
      return rostered
        ? {
            tone: 'green',
            headline: 'Unchanged since signing — signer on your trusted roster',
            sub: `The bytes match what was signed, the signature is valid, and the signing key was on your trusted roster${
              trust?.membershipState === 'unknown-time'
                ? ' (membership at the signing time could not be evaluated — stated, not assumed)'
                : ' at the countersigned signing time'
            }. That is a custody fact; what the content shows is yours to judge.`,
          }
        : {
            tone: 'neutral',
            headline: 'Unchanged since signing — signer not on your trusted roster',
            sub: 'The bytes match what was signed and the signature is valid. That is an integrity fact; who signed is not established.',
          };
    case 'CONTENT_MODIFIED':
      return {
        tone: 'danger',
        headline: 'The bytes changed after signing',
        sub: 'The signature is valid, but the media bytes no longer match what it sealed. Something altered this file after signing.',
      };
    case 'SIGNATURE_INVALID':
      return {
        tone: 'danger',
        headline: 'The attestation does not check out',
        sub: 'The embedded credentials are malformed or tampered with. Treat every claim in this file as unchecked.',
      };
    case 'NO_ATTESTATION':
      return {
        tone: 'neutral',
        headline: 'No credentials found — this is normal',
        sub: 'No Source Kit or C2PA credentials are embedded. Most files today carry none; an unsigned file is just an unsigned file. What this tool cannot tell you is what the file is.',
      };
    case 'UNSUPPORTED':
    case 'NOT_JPEG':
    case 'NOT_BMFF':
      return {
        tone: 'warn',
        headline: 'Found credentials this build cannot check',
        sub: 'The structure is beyond this build (for example a multi-part update tree). Unchecked — neither condemned nor endorsed.',
      };
    case 'UNREADABLE':
      return {
        tone: 'warn',
        headline: 'This file could not be read',
        sub: item.error ?? null,
      };
    default:
      return {
        tone: 'neutral',
        headline: 'Not a checkable file',
        sub: item.error ?? 'Not a JPEG/PNG/MP4/MOV or an Exhibit artifact. Saying so plainly rather than guessing.',
      };
  }
}

/* ------------------------------------------------------------------ */
/* Header meta line (§4.2)                                              */
/* ------------------------------------------------------------------ */

const KIND_LABEL: Record<DeskItem['kind'], string> = {
  media: 'Media',
  'proof-bundle': 'Proof bundle',
  'hash-claim': 'Hash claim',
  roster: 'Roster file',
  unknown: 'Unrecognized',
};

function formatAdded(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} d ago`;
  return new Date(ms).toLocaleDateString();
}

/* ------------------------------------------------------------------ */
/* The dashboard shell                                                  */
/* ------------------------------------------------------------------ */

export function AssetDashboard(props: AssetDashboardProps & {
  /** W3: declared connector endpoints (Settings), audit sink, and the
      topbar boundary-indicator setter — consumed only by the AI tab. */
  connectorPrefs?: ConnectorPrefs;
  onAudit?: (action: string, detail?: string) => void;
  onBoundarySending?: (host: string | null) => void;
}) {
  const { item } = props;
  const [tab, setTab] = useState<DashboardTabId>('overview');
  const banner = useMemo(() => bannerFor(props), [props]);

  // Assistant deep-links: a sentence's basis jumps to its evidence card.
  const [focus, setFocus] = useState<BasisRef | null>(null);
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(`dash-card-${focus.card}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('dash-card-focus');
      const t = window.setTimeout(() => el.classList.remove('dash-card-focus'), 1600);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [focus, tab]);
  function openBasis(basis: BasisRef) {
    setTab(basis.tab);
    setFocus({ ...basis }); // fresh object: re-tapping the same basis re-scrolls
  }

  return (
    <div>
      <div className="dash-head">
        <div className="dash-name">{item.name}</div>
        <div className="dash-meta">
          {KIND_LABEL[item.kind]} · {item.bytes ? fmtBytes(item.bytes.length) : 'bytes not held'} · added {formatAdded(item.addedAt)}
        </div>
      </div>

      <div id="dash-card-banner" className={`dash-banner tone-${banner.tone}`}>
        {banner.headline}
        {banner.sub && <span className="sub">{banner.sub}</span>}
      </div>

      <div className="dash-tabs" role="tablist" aria-label="Asset dashboard">
        {DASHBOARD_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'overview' && <OverviewTab {...props} />}
        {tab === 'signals' && <SignalsTab item={item} onItemPatched={props.onItemPatched} />}
        {tab === 'forensics' && <ForensicsTab item={item} onItemPatched={props.onItemPatched} />}
        {tab === 'ai' && (
          <AiForensicsTab
            item={item}
            trust={props.trust}
            artifact={props.artifact}
            matches={props.matches}
            custodyMatches={props.custodyMatches}
            prefs={props.connectorPrefs ?? {}}
            onAudit={props.onAudit ?? (() => undefined)}
            onBoundary={props.onBoundarySending ?? (() => undefined)}
            onOpenBasis={openBasis}
          />
        )}
      </div>
    </div>
  );
}
