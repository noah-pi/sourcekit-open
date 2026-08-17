// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * ProvenanceChain — the provenance timeline (DESIGN §5.7, law L11:
 * "gaps are drawn"). Nodes are signed events, attributed to their signer
 * or declared source; edges are attested intervals. An interval no
 * credential covers is rendered as a VISIBLY BROKEN segment (dashed, with
 * the gap label "not covered by any credential") — a chain that only shows
 * signed links would overclaim continuity.
 *
 * States (§5.7, exhaustive):
 *  - none: the file carries no credentials → the absence card (L4 copy),
 *    never an empty box.
 *  - single-manifest: capture (device claim) → broken capture→seal gap →
 *    the one seal.
 *  - multi-manifest: further seals linked in order; the links are drawn
 *    from the declared chain and labeled as declarations, not as
 *    independently re-checked math.
 *  - detached-manifest: an exact-after-strip custody match adds the
 *    detached manifest as a signed node whose edge to this file IS
 *    attested (the reconstruction is cryptographic).
 *  - hash-claim / proof-bundle: the signed node that exists, plus the
 *    broken segment to the media it cannot alone bridge.
 *
 * Data feeds: item.report / item.bundle / item.claim (deskCore), the
 * Tier-0 c2paSummary on item.intakeReport (declared manifest chain), and
 * the cross-library custodyMatches App already computes.
 */
import React from 'react';
import type { C2paSummary } from '../../contracts-ext';
import type { DeskTrust, ManifestCustodyMatch } from '../../core/deskCore';
import type { DeskItem } from '../../core/deskItem';

const shortFp = (fp: string | null | undefined): string =>
  fp ? `${fp.slice(0, 16)}…` : 'unknown signer';

function Node(props: { title: string; sub?: string | null }) {
  return (
    <div className="dash-chain-node">
      <div className="dash-chain-node-title">{props.title}</div>
      {props.sub && <div className="dash-chain-node-sub">{props.sub}</div>}
    </div>
  );
}

/**
 * Edge styles say exactly what they are (§5.7 + L6):
 *  - default (solid, --text-dim): an interval a credential attests — an
 *    integrity fact, stated in neutral.
 *  - 'declared' (dotted, --info): a link the later manifest declares; we
 *    draw it as a declaration, not as independently re-checked math.
 *  - 'trusted' (solid, --accent): the attested interval AND its signer is
 *    roster-trusted — the only green the chain may ever show (L6).
 *  - broken (dashed, --text-faint): an interval no credential covers (L11).
 */
function Edge(props: { broken?: boolean; variant?: 'declared' | 'trusted'; label?: string | null }) {
  return (
    <div className={`dash-chain-edge${props.broken ? ' broken' : ''}${props.variant ? ` ${props.variant}` : ''}`} aria-hidden="true">
      {props.label && <span className="dash-chain-gap">{props.label}</span>}
    </div>
  );
}

/** Deck ov.provenance.gap — the mandatory broken-segment label (L11). */
const GAP_LABEL = 'not covered by any credential';

/**
 * The legend: every edge style states exactly what it means — never
 * overclaiming (an attested edge is an integrity fact, not a verdict; a
 * declared link is the manifest's own statement; green is L6's double lock).
 */
const CHAIN_LEGEND =
  'A solid line is an interval a credential attests — green only when the signer is on your trusted roster. ' +
  'A dotted line is a declaration by the manifest chain, drawn as a declaration, not re-checked. ' +
  'A dashed segment is an interval no credential covers — drawn so the chain never overclaims continuity.';

function AbsenceCard({ reason }: { reason?: string | null }) {
  return (
    <div className="card">
      <h2>Provenance chain</h2>
      <div className="dash-absence">
        {/* Deck ov.provenance.none (L4 — absence is normal). */}
        {reason ?? 'No signed chain — this file carries no credentials. This is normal.'}
        <div className="dash-absence-scope">
          A chain only ever shows what credentials attest; it says nothing about what the file is.
        </div>
      </div>
    </div>
  );
}

export function ProvenanceChain(props: {
  item: DeskItem;
  custodyMatches: ManifestCustodyMatch[];
  /** Trust resolution for the item's signer — gates the only green (L6). */
  trust?: DeskTrust | null;
}) {
  const { item, custodyMatches } = props;
  // The double lock, exactly as bannerFor() computes it: roster tier with
  // no warning. Anything else renders in neutral, never green.
  const rosterTrusted = props.trust?.tier === 'roster' && !props.trust.warning;
  const summary: C2paSummary | null =
    item.intakeReport?.c2paSummary && !('state' in item.intakeReport.c2paSummary)
      ? item.intakeReport.c2paSummary
      : null;

  // Detached-manifest custody: a bundle's stripped/excluded reconstruction
  // commits to this file's exact bytes — that edge is attested.
  const detached = custodyMatches.filter((m) => m.mediaItemId === item.id);
  const asBundle = custodyMatches.filter((m) => m.bundleItemId === item.id);

  /* ------------------------------- media ------------------------------- */
  if (item.kind === 'media') {
    const record = item.report?.record ?? null;
    const signedNode: React.ReactNode = (
      <Node
        key="seal"
        title={`Seal — signed by ${shortFp(record?.signer?.fingerprint ?? summary?.signerFingerprint)}`}
        sub={
          summary?.claimGenerator
            ? `${summary.manifestLabel ?? 'active manifest'} · sealing software declared as ${summary.claimGenerator}`
            : summary?.manifestLabel ?? 'Source Kit record'
        }
      />
    );

    if (!record && !summary) {
      // Update-chain manifests can still exist without a Source Kit record;
      // the Tier-0 summary covers that case. Anything else: absence card.
      return <AbsenceCard />;
    }

    const chain: React.ReactNode[] = [];
    if (record) {
      chain.push(
        <Node key="capture" title={`Capture — ${record.capturedAt}`} sub="declared by the device; not independently checked" />,
        // The capture→seal interval is self-reported by the device (the
        // capture-integrity card says why). No credential covers it: broken.
        <Edge key="gap-capture" broken label={GAP_LABEL} />,
        signedNode,
      );
    } else {
      chain.push(signedNode);
    }

    // Multi-manifest update chain: later seals are DECLARED by the chain —
    // drawn as their own nodes with the link labeled as a declaration.
    if (summary && summary.manifestCount > 1) {
      for (let i = 1; i < summary.manifestCount; i++) {
        chain.push(
          <Edge key={`link-${i}`} label="linked by the later manifest's declaration" />,
          <Node key={`m-${i}`} title={`Update ${i + 1} of ${summary.manifestCount}`} sub="declared by the manifest chain" />,
        );
      }
    }

    // Declared ingredients whose own credentials are not embedded: the hop
    // to them is a broken segment, per ingredient (capped for display).
    const missingIngredients = (summary?.ingredients ?? []).filter((ing) => !ing.referenced).slice(0, 3);
    for (const ing of missingIngredients) {
      chain.push(
        <Edge key={`ing-gap-${ing.title ?? 'untitled'}`} broken label={GAP_LABEL} />,
        <Node
          key={`ing-${ing.title ?? 'untitled'}`}
          title={`Declared ingredient — ${ing.title ?? 'untitled'}`}
          sub="declared by the sealing software; its own credential is not embedded"
        />,
      );
    }

    // Detached-manifest custody: the strip hop is broken (a platform removed
    // the credentials — drawn, never smoothed over), and the detached
    // manifest's edge back to these bytes is attested by the reconstruction.
    for (const m of detached) {
      chain.push(
        <Edge key={`det-gap-${m.bundleItemId}`} broken label={`credentials stripped in transit — ${GAP_LABEL}`} />,
        <Node
          key={`det-${m.bundleItemId}`}
          title={`Detached manifest in ${m.bundleName}`}
          sub={`${m.manifestLabel} — commits to these exact bytes after the strip; that binding is cryptographic`}
        />,
      );
    }

    return (
      <div className="card">
        <h2>Provenance chain</h2>
        <div className="dash-chain">{chain}</div>
        <p className="honest-note" style={{ marginBottom: 0 }}>
          {CHAIN_LEGEND} Every node names its source.
        </p>
      </div>
    );
  }

  /* ---------------------------- proof bundle ---------------------------- */
  if (item.kind === 'proof-bundle') {
    const fp = item.bundle?.record?.signer?.fingerprint ?? null;
    const chain: React.ReactNode[] = [
      <Node key="rec" title={`Record — signed by ${shortFp(fp)}`} sub="media is not included in a proof bundle" />,
    ];
    if (asBundle.length > 0) {
      for (const m of asBundle) {
        chain.push(
          <Edge
            key={`att-${m.mediaItemId}`}
            variant={rosterTrusted ? 'trusted' : undefined}
            label="attested — commits to the exact bytes after the strip"
          />,
          <Node key={`media-${m.mediaItemId}`} title={m.mediaName} sub="exact-after-strip custody match — cryptographic" />,
        );
      }
    } else {
      chain.push(
        <Edge key="gap-media" broken label={GAP_LABEL} />,
        <Node key="media" title="Media — not in this bundle" sub="bridge it via recovery matching, or it stays unbridged" />,
      );
    }
    return (
      <div className="card">
        <h2>Provenance chain</h2>
        <div className="dash-chain">{chain}</div>
        <p className="honest-note" style={{ marginBottom: 0 }}>
          {CHAIN_LEGEND}
        </p>
      </div>
    );
  }

  /* ---------------------------- hash claim ------------------------------ */
  if (item.kind === 'hash-claim') {
    return (
      <div className="card">
        <h2>Provenance chain</h2>
        <div className="dash-chain">
          <Node
            title={`Hash claim — signer ${shortFp(item.claim?.signerFingerprint)}`}
            sub="no signature, by design (source protection)"
          />
          <Edge broken label={GAP_LABEL} />
          <Node title="Media" sub="only an exact SHA-256 match can bridge this segment" />
        </div>
        <p className="honest-note" style={{ marginBottom: 0 }}>
          A hash claim is deliberately one unsigned node: it can attest to nothing until its media
          arrives and matches exactly.
        </p>
      </div>
    );
  }

  /* ------------------------ unknown / roster file ----------------------- */
  return <AbsenceCard reason="Not applicable — this item carries no credentials to chain." />;
}
