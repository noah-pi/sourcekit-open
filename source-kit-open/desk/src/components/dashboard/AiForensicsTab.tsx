/**
 * AiForensicsTab — the AI Forensics tab (DESIGN §10.8; ARCHITECTURE §6).
 * Two kinds of help, both honest about what they are:
 *
 *  1. The Assistant card — a PURE, local restatement of this asset's
 *     computed evidence (core/assistant.ts). Every sentence carries its
 *     BasisRef and renders a "show the evidence" link that jumps to the
 *     card it restates (L1/L7). It detects nothing and scores nothing
 *     (L2); the fixed deck disclaimer rides under it. It regenerates off a
 *     memo key of input ids + method versions, so changed evidence always
 *     changes the summary.
 *  2. External checks — declared connectors (core/connectors), each opt-in
 *     per action through the boundary consent dialog (DESIGN §5.8). A
 *     refusal never calls run and is itself recorded; results render
 *     attributed — "[provider] reports: … — their statement, shown as
 *     received" (L9). Nothing here is automatic (L10).
 *
 * The declared-AI flags card (digitalSourceType) stays: a flag is the
 * sealing tool's own self-declaration, never our detection.
 */
import React, { useMemo, useRef, useState } from 'react';
import type { ArtifactCheck, DeskTrust, ManifestCustodyMatch, RecoveryMatch } from '../../core/deskCore';
import type { DeskItem } from '../../core/deskItem';
import type { AssistantInput, BasisRef, ConnectorPrefs, ConnectorResult } from '../../contracts-ext';
import { assistantInputKey, summarizeAsset } from '../../core/assistant';
import { ConnectorConsentFlow, resolveConnectors, type ConsentState } from '../../core/connectors';
import { AI } from '../../core/aiStrings';
import { ConsentDialog } from './ConsentDialog';
import { InfoTip, SignalRow, TOOLTIPS } from './dashUi';

export interface AiForensicsTabProps {
  item: DeskItem;
  trust: DeskTrust | null;
  artifact: ArtifactCheck | null;
  matches: RecoveryMatch[];
  custodyMatches: ManifestCustodyMatch[];
  /** User-declared connector endpoints (Settings; empty = nothing configured). */
  prefs: ConnectorPrefs;
  /** Case-file audit sink (consent + external-check entries). */
  onAudit: (action: string, detail?: string) => void;
  /** Topbar boundary indicator: host while a send is in flight, null after. */
  onBoundary: (host: string | null) => void;
  /** Deep-link: switch tabs and scroll to the sentence's evidence card. */
  onOpenBasis: (basis: BasisRef) => void;
}

/** One rendered Assistant paragraph with its basis link. */
function AssistantParagraphView(props: { text: string; basis: BasisRef; onOpenBasis: (b: BasisRef) => void }) {
  return (
    <p>
      {props.text}
      <button
        type="button"
        className="dash-basis-link"
        onClick={() => props.onOpenBasis(props.basis)}
        aria-label={`${AI.assistant.basisLink} — ${props.basis.card} on the ${props.basis.tab} tab`}
      >
        {AI.assistant.basisLink}
      </button>
    </p>
  );
}

export function AiForensicsTab(props: AiForensicsTabProps) {
  const { item, prefs, onAudit, onBoundary, onOpenBasis } = props;

  /* ---- Assistant: pure, instant, memo-keyed on inputs + versions. ---- */
  const assistantInput: AssistantInput = {
    item,
    trust: props.trust,
    artifact: props.artifact,
    matches: props.matches,
    custodyMatches: props.custodyMatches,
  };
  const memoKey = assistantInputKey(assistantInput);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const summary = useMemo(() => summarizeAsset(assistantInput), [memoKey]);

  /* ---- Connectors: declared list + the consent state machine. -------- */
  const connectors = useMemo(() => resolveConnectors(prefs), [prefs]);
  // ai.connector.none — no endpoint declared for ANY connector (Settings).
  const nothingConfigured = Object.values(prefs).every((p) => !p?.endpoint);

  const [consent, setConsent] = useState<ConsentState>({ phase: 'idle' });
  const [outcomes, setOutcomes] = useState<Record<string, ConnectorResult>>({});
  const flowRef = useRef<ConnectorConsentFlow | null>(null);
  if (!flowRef.current) {
    flowRef.current = new ConnectorConsentFlow({
      onState: (s) => {
        setConsent(s);
        if ((s.phase === 'done' || s.phase === 'error') && s.result) {
          setOutcomes((prev) => ({ ...prev, [s.connector.id]: s.result }));
        }
      },
      audit: onAudit,
      boundary: onBoundary,
    });
  }
  const flow = flowRef.current;

  // If the tab unmounts (surface switch, item removal), the topbar boundary
  // indicator must not be left claiming a send that can no longer be seen.
  React.useEffect(() => () => onBoundary(null), [onBoundary]);

  // F7: switching items resets the connector state — outcomes and any
  // in-flight consent flow belong to the asset they were produced for;
  // showing them under another asset would mis-attribute a statement.
  const lastItemIdRef = useRef(item.id);
  React.useEffect(() => {
    if (lastItemIdRef.current === item.id) return;
    lastItemIdRef.current = item.id;
    setOutcomes({});
    flow.reset();
  }, [item.id, flow]);

  const c2pa = item.intakeReport?.c2paSummary ?? null;
  const c2paObserved = c2pa && !('state' in c2pa) ? c2pa : null;
  const dst = c2paObserved?.digitalSourceType ?? null;

  return (
    <div>
      {/* ai.title / ai.intro */}
      <h2 className="dash-tab-title">{AI.title}</h2>
      <p className="honest-note" style={{ marginTop: 0 }}>{AI.intro}</p>

      {/* ------------------------------------------------ Assistant --- */}
      <div className="card">
        <h2>
          {AI.assistant.title}{' '}
          <InfoTip pair={AI.assistant.tooltip} />
        </h2>
        <p className="honest-note" style={{ marginTop: 0 }}>{AI.assistant.sub}</p>
        {summary.paragraphs.length === 0 ? (
          <p className="dash-absence" style={{ margin: 0 }}>{AI.assistant.empty}</p>
        ) : (
          <div className="dash-assistant">
            {summary.paragraphs.map((p, i) => (
              <AssistantParagraphView key={`${summary.inputKey}-${i}`} text={p.text} basis={p.basis} onOpenBasis={onOpenBasis} />
            ))}
          </div>
        )}
        {/* ai.assistant.disclaimer — fixed, non-removable. */}
        <p className="honest-note" style={{ marginBottom: 0 }}>{AI.assistant.disclaimer}</p>
      </div>

      {/* ------------------------------------- Declared AI flags (L9) - */}
      <div className="card" id="dash-card-declared-flags">
        <h2>Declared AI flags</h2>
        {dst ? (
          <SignalRow label="Digital source type" chip={{ tone: 'info', text: 'Declared' }} tip={TOOLTIPS.digitalSourceType}>
            {dst}
            <div className="honest-note">
              {AI.selfdeclared(c2paObserved?.claimGenerator ?? 'the sealing tool')}
            </div>
          </SignalRow>
        ) : (
          <p className="dash-absence" style={{ margin: 0 }}>
            No declared AI flags (digitalSourceType) were found in this file’s credentials. A flag here
            would be a self-declaration by the sealing tool — Source Kit Desk ships no AI-content detector and
            never infers one.
          </p>
        )}
      </div>

      {/* -------------------------------------------- External checks - */}
      <div className="card">
        <h2>{AI.connectors.title}</h2>
        <p style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--text-dim)' }}>{AI.connectors.sub}</p>
        {nothingConfigured && <p className="dash-absence">{AI.connector.none}</p>}
        {connectors.map((c) => {
          const can = c.canRun(item);
          const name = c.id === 'watermark-check' ? AI.connector.wm.name(c.provider) : c.name;
          const desc = c.id === 'watermark-check' ? AI.connector.wm.desc(c.provider) : AI.connector.ris.desc;
          const outcome = outcomes[c.id] ?? null;
          return (
            <div key={c.id} className="fx-connector">
              <div className="fx-connector-name">{name}</div>
              <div className="fx-connector-desc">{desc}</div>
              {/* §5.8: the card states what would be sent before any click. */}
              <div className="field-note" style={{ marginBottom: 6 }}>{AI.connector.sends(c.describesPayload(item))}</div>
              {!can.ok ? (
                <SignalRow label={name} chip={{ tone: 'neutral', text: 'Not applicable' }}>
                  {AI.connector.notRunnable(can.reason)}
                </SignalRow>
              ) : (
                <div className="btn-row" style={{ marginTop: 2 }}>
                  <button
                    className="btn secondary"
                    disabled={consent.phase === 'previewing' || consent.phase === 'sending'}
                    onClick={() => {
                      flow.preview(c, item, prefs[c.id]?.endpoint ?? null);
                    }}
                  >
                    {AI.connector.send(c.provider)}
                  </button>
                </div>
              )}
              {outcome && (
                outcome.ok ? (
                  <p className="honest-note" style={{ marginBottom: 0 }}>
                    {AI.connector.result(c.provider, outcome.summary)}
                  </p>
                ) : (
                  <p className="honest-note" style={{ marginBottom: 0 }}>
                    {AI.connector.error(c.provider)} {outcome.error ?? ''}
                  </p>
                )
              )}
            </div>
          );
        })}
      </div>

      <ConsentDialog
        state={consent}
        onConfirm={() => void flow.confirm()}
        onRefuse={() => flow.refuse()}
        onAbort={() => flow.abort()}
        onDismiss={() => flow.reset()}
      />
    </div>
  );
}
