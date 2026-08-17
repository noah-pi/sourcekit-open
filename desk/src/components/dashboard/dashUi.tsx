/**
 * dashUi — shared dashboard leaf components: the mandatory ⓘ "can show /
 * cannot show" tooltip map (§10.13), the InfoTip button, and the SignalRow
 * (§5.3). Extracted from AssetDashboard.tsx so the four tab modules can
 * import them WITHOUT importing AssetDashboard — the dashboard imports the
 * tabs, so tabs importing the dashboard was a circular dependency that
 * crashed the bundle at runtime (TDZ on the tooltip map). This module must
 * stay a leaf: no imports from any component that imports the tabs.
 */
import React from 'react';

/* ------------------------------------------------------------------ */
/* ⓘ tooltips — the mandatory "can show / cannot show" pairs (§10.13)   */
/* ------------------------------------------------------------------ */

export const TOOLTIPS = {
  hashMatch: { can: 'The bytes are exactly what was signed', cannot: 'Anything about what happened before signing' },
  signatureValidity: { can: 'The credential is well-formed and its math checks out', cannot: 'That the claims inside it are true' },
  c2paActions: { can: 'What the sealing software declared', cannot: 'That nothing else happened between actions' },
  digitalSourceType: { can: 'What the signing tool says the content is', cannot: 'What the content actually is' },
  phashLead: { can: 'Two files are probably visually similar', cannot: 'That they share custody — confirm visually' },
  thumbnailDiff: { can: 'The embedded preview differs from the current image', cannot: 'Who changed it, or why' },
  quantClass: { can: 'Which family of software last saved the JPEG', cannot: 'Whether any edit was dishonest' },
  enfExtract: { can: 'A grid-frequency trace in the audio', cannot: 'That the trace matches any particular grid (no reference in-browser)' },
  poseMotion: { can: 'The signed gyro trace and the observed motion agree', cannot: 'That the footage is genuine — weak texture defeats it honestly' },
  // W4 (§10.13 mandatory set): the ELA cannot-show names the caveat, which
  // renders non-dismissibly on the same card (fx.ela.caveat).
  ela: { can: 'Where recompression levels differ', cannot: 'Whether the file was manipulated (see the caveat above)' },
  cloneDetection: { can: 'Regions that duplicate each other at these settings', cannot: 'That no duplication exists elsewhere or at other settings' },
  // §10.13 rows (amended deck, verbatim).
  noiseEstimation: {
    can: 'Where the noise texture differs across the picture — oddly smooth or oddly noisy patches are leads for your eyes',
    cannot: 'Whether any patch was retouched — resaving, resizing, and honest recompression change noise too, so a difference is never a finding',
  },
  parallaxRing: {
    can: 'How flat the scene in the provided ring frames is — measured in this tab from the frames and sensor log you supply',
    cannot: 'Anything about this file’s custody — the ring is an outside input you provided, and a genuinely flat scene fits a plane honestly',
  },
  viewingAids: {
    can: 'The same picture shown differently — edges, luminance bands, and gradients made easier for your eyes to inspect',
    cannot: 'Anything by itself — an aid claims nothing; something you notice is a lead for you to weigh, not a finding',
  },
  displaybeat: {
    can: 'A periodic brightness rhythm consistent with filming a screen',
    cannot: 'That the rhythm came from a screen — fans, flicker, and edit rhythms can produce one too',
  },
  rollingShutter: {
    can: 'Row-to-row motion shear consistent with a rolling shutter',
    cannot: 'The sensor’s absolute row time — intrinsics are never assumed',
  },
  avsync: {
    can: 'How far audio and motion onsets line up within ±[n] ms',
    cannot: 'That aligned onsets mean a real event — coincidence aligns too',
  },
  rephoto: {
    can: 'Statistical traces a photo-of-a-screen often leaves (banding, moiré, black floor, gamut)',
    cannot: 'Intent — a photo of a screen can be entirely legitimate',
  },
  // Capture-integrity + JPEG structure rows (existing deck vocabulary).
  captureIntegrity: {
    can: 'What the device self-reports about its own capture — committed under signature',
    cannot: 'That the footage is genuine — a compromised device could fabricate these signals',
  },
  jpegStructure: {
    can: 'The JPEG segment layout and encoding exactly as stored',
    cannot: 'Who arranged it that way, or whether any edit was dishonest',
  },
} as const;

export function InfoTip({ pair }: { pair: { can: string; cannot: string } }) {
  const text = `What this can show: ${pair.can}. What it cannot show: ${pair.cannot}.`;
  return (
    <button type="button" className="dash-info" title={text} aria-label={text}>
      ⓘ
    </button>
  );
}

/** One dashboard signal row (§5.3): label · value · status chip · ⓘ. */
export function SignalRow(props: {
  label: string;
  chip?: { tone: 'neutral' | 'info' | 'warn' | 'danger' | 'accent'; text: string };
  tip?: { can: string; cannot: string };
  children: React.ReactNode;
}) {
  return (
    <div className="dash-signal">
      <span className="dash-signal-label">{props.label}</span>
      <span className="dash-signal-value">{props.children}</span>
      {props.chip && <span className={`dash-chip ${props.chip.tone}`}>{props.chip.text}</span>}
      {props.tip && <InfoTip pair={props.tip} />}
    </div>
  );
}
