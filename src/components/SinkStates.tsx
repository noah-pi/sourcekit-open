// Source Kit 0.1.0 — renders the capture-evidence sinks
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * SinkStates — renders the capture-evidence sinks. Each sink is in one of
 * three states (manifest.ts EvidencePath):
 *
 *   string           — recorded; the drawer shows the on-device path
 *   null             — enabled but failed at capture
 *   'never-recorded' — toggle off, session did not run, or not applicable
 *
 * Rows are tap-to-open drawers holding the captured data. Row order:
 * Multiple Lenses, Sensor Log, Location, Raw Audio Master, Frames around the
 * shutter. Records without a captureEvidence block get the legacy notice
 * instead of the path sinks; the lens and location rows derive from other
 * signed sections and still render.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radii, fontSize, type, useThemedStyles, useEffectiveScheme } from '../theme';
import type { AttestationRecord, CaptureEvidencePaths, EvidencePath } from '../provenance/manifest';

// ---------------------------------------------------------------------------
// Derived sinks (their states live outside captureEvidence).
// ---------------------------------------------------------------------------

/**
 * Multiple Lenses — the second camera's committed evidence. States come from
 * the record's stereo sections (stereoArtifacts.ts): recorded, error, or
 * never-recorded.
 */
export interface AltViewSink {
  state: 'recorded' | 'failed' | 'never-recorded';
  detail: string;
  /** Committed native error string, verbatim. Present when state is 'failed'
      and the record carries one. Rendered in the drawer as-is. */
  error?: string;
}

export function deriveAltViewSink(record: AttestationRecord | null): AltViewSink | null {
  if (!record) return null;
  const kind = record.asset?.kind;
  const vs = record.videoStereo ?? null;
  const st = record.stereo ?? null;

  if (kind === 'audio') {
    return {
      state: 'never-recorded',
      detail: 'Multiple Lenses applies to photos and video; this is an audio capture.',
    };
  }

  // Video: the section restates the native stop result. Zero committed pairs
  // means unsupported, toggled off, or thermal-detached, and is neutral, not
  // a failure (STEREO_VIDEO_BUNDLE_NOTE).
  if (kind === 'video') {
    if (!vs) {
      return {
        state: 'never-recorded',
        detail: 'This record predates multi-lens commitment (written before 0.13). An old record, not a claim that nothing was recorded.',
      };
    }
    if (vs.pairsCommitted > 0) {
      return {
        state: 'recorded',
        detail:
          `${vs.pairsCommitted} synchronized second-camera views committed` +
          (vs.pairsMissed > 0 ? ` · ${vs.pairsMissed} missed (a declared count)` : '') +
          '. Scene geometry from these is a lead for later review, not a verdict.',
      };
    }
    return {
      state: 'never-recorded',
      detail: 'No paired views were committed: unsupported on this device, toggled off, or detached under thermal pressure.',
    };
  }

  // Photo: the paired frame's committed state drives the row.
  if (!st) {
    return {
      state: 'never-recorded',
      detail: 'This record predates multi-lens commitment (written before 0.13). An old record, not a claim that nothing was recorded.',
    };
  }
  const frame = st.artifacts?.secondaryFrame;
  if (frame?.state === 'recorded') {
    return {
      state: 'recorded',
      detail: 'A synchronized second-camera frame is committed. Scene geometry from it is a lead for later review, not a verdict.',
    };
  }
  if (frame?.state === 'error') {
    return {
      state: 'failed',
      detail: 'Enabled but failed at capture; the record commits the native error string verbatim.',
      error: typeof frame.error === 'string' && frame.error.length > 0 ? frame.error : undefined,
    };
  }
  return {
    state: 'never-recorded',
    detail: frame?.reason
      ? `Not recorded: ${frame.reason}.`
      : 'Not recorded: unsupported on this device, toggled off, or unreached.',
  };
}

/**
 * Location — device-reported, captured at seal time and committed under
 * signature, never independently confirmed. 'removed' is the de-identified
 * case, where the absence is part of the signed record.
 */
export interface LocationSink {
  state: 'recorded' | 'never-recorded' | 'removed';
  detail: string;
  coords?: string;
}

export function deriveLocationSink(record: AttestationRecord | null): LocationSink | null {
  if (!record) return null;
  const loc = record.context?.location;
  if (loc && typeof loc === 'object') {
    return {
      state: 'recorded',
      detail: 'Device-reported, sealed as a claim.',
      coords: `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`,
    };
  }
  if (loc === 'redacted') {
    return {
      state: 'removed',
      detail: 'Removed from this de-identified copy; the removal itself is part of the signed record.',
    };
  }
  if (loc === 'unavailable') {
    return {
      state: 'never-recorded',
      detail: 'Unavailable at capture: the phone reported no fix.',
    };
  }
  return {
    state: 'never-recorded',
    detail: 'Not recorded: the Location toggle was off.',
  };
}

// ---------------------------------------------------------------------------
// Three-state presentation shared by every row.
// ---------------------------------------------------------------------------

type Tone = 'good' | 'bad' | 'neutral';

function pathState(p: EvidencePath): { tone: Tone; headline: string; detail: string } {
  // 'never-recorded' is itself a string, so test it before the generic
  // string (recorded path) case.
  if (p === 'never-recorded') {
    return {
      tone: 'neutral',
      headline: 'Not recorded',
      detail: 'The toggle was off, or this evidence does not apply to this kind of capture.',
    };
  }
  if (p === null) {
    return {
      tone: 'bad',
      headline: 'Enabled but failed',
      detail: 'Turned on, but it errored at capture time. A failure, stated as one.',
    };
  }
  return {
    tone: 'good',
    headline: 'Recorded',
    detail: 'Device-reported. The signed record carries the on-device path:',
  };
}

const TONE_COLOR = { good: colors.accent, bad: colors.danger, neutral: colors.textDim } as const;
const TONE_ICON = { good: 'checkmark-circle', bad: 'alert-circle', neutral: 'remove-circle-outline' } as const;

/** The three path sinks, named explicitly: the digests that sit beside them
    in CaptureEvidencePaths are not sinks and must not be listed here. */
type PathSinkKey = 'sensorLogPath' | 'rawPcmPath' | 'ringBufferDir';

const PATH_SINKS: { key: PathSinkKey; icon: keyof typeof Ionicons.glyphMap; label: string; appliesTo: string }[] = [
  { key: 'sensorLogPath', icon: 'pulse-outline', label: 'Sensor Log (Device-reported)', appliesTo: 'Every capture' },
  { key: 'rawPcmPath', icon: 'mic-outline', label: 'Raw Audio Master', appliesTo: 'Video only' },
  { key: 'ringBufferDir', icon: 'images-outline', label: 'Frames around the shutter', appliesTo: 'Photos only' },
];

/** Extra explainer line appended to the ring sink's drawer detail. */
const RING_EXPLAINER = 'About 8 frames captured just before and after the shutter fired, for reviewing depth and timing later.';

/** One sink row. Header is always visible (icon, label, scope, state badge);
 *  the captured data sits behind the chevron drawer. */
function SinkRow({ icon, label, appliesTo, tone, headline, detail, path, mono, committedError }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  appliesTo: string;
  tone: Tone;
  headline: string;
  detail: string;
  path?: string;
  mono?: boolean;
  /** Committed native error string, shown verbatim in a mono block. */
  committedError?: string;
}) {
  const styles = useThemedStyles(buildStyles);
  const [open, setOpen] = useState(false);
  const c = TONE_COLOR[tone];
  return (
    <View style={styles.row}>
      <Pressable style={styles.rowHead} onPress={() => setOpen((o) => !o)} hitSlop={6} accessibilityLabel={`${label} details`}>
        <Ionicons name={icon} size={15} color={colors.textDim} style={{ marginTop: 1 }} />
        <View style={{ flex: 1 }}>
          <Text style={styles.sinkLabel}>{label}</Text>
          <Text style={styles.applies}>{appliesTo}</Text>
        </View>
        <View style={[styles.badge, { backgroundColor: tone === 'good' ? colors.accentSoft : tone === 'bad' ? colors.dangerSoft : colors.surface2 }]}>
          <Text style={[styles.badgeText, { color: c }]}>{headline}</Text>
        </View>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={13} color={colors.textFaint} />
      </Pressable>
      {open ? (
        <View style={styles.drawer}>
          <Text style={styles.detail}>{detail}</Text>
          {path ? (
            <Text selectable style={[styles.path, mono ? { fontFamily: type.mono } : null]}>{path}</Text>
          ) : null}
          {committedError ? (
            <View>
              <Text style={styles.errorLabel}>Committed error:</Text>
              <Text selectable style={styles.path}>{committedError}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function SinkStates({ captureEvidence, altView, location, sensorSummary }: {
  captureEvidence?: CaptureEvidencePaths | null;
  /** Multiple Lenses — derived via deriveAltViewSink. Rendered first. */
  altView?: AltViewSink | null;
  /** Location — derived via deriveLocationSink. */
  location?: LocationSink | null;
  /** What the sensor log captured (samples, rates, channels), built from the
   *  sealed context. Replaces the on-device path in the drawer. */
  sensorSummary?: string | null;
}) {
  const styles = useThemedStyles(buildStyles);
  const rows: React.ReactNode[] = [];

  if (altView) {
    const tone: Tone = altView.state === 'recorded' ? 'good' : altView.state === 'failed' ? 'bad' : 'neutral';
    rows.push(
      <SinkRow
        key="lenses"
        icon="camera-outline"
        label="Multiple Lenses"
        appliesTo="Photos + video · dual-camera devices"
        tone={tone}
        headline={altView.state === 'recorded' ? 'Recorded' : altView.state === 'failed' ? 'Enabled but failed' : 'Not recorded'}
        detail={altView.detail}
        committedError={altView.error}
      />
    );
  }

  if (captureEvidence) {
    // Sensor Log first among the path sinks, then the media-specific masters.
    const sensor = PATH_SINKS[0];
    const sp = captureEvidence[sensor.key];
    const sst = pathState(sp);
    const recorded = typeof sp === 'string' && sp !== 'never-recorded';
    rows.push(
      <SinkRow
        key={sensor.key}
        icon={sensor.icon}
        label={sensor.label}
        appliesTo={sensor.appliesTo}
        tone={sst.tone}
        headline={sst.headline}
        // With a summary, show the data; without one, fall back to the path.
        detail={recorded && sensorSummary ? sensorSummary : sst.detail}
        path={recorded && !sensorSummary ? sp as string : undefined}
        mono
      />
    );
  }

  if (location) {
    const tone: Tone = location.state === 'recorded' ? 'good' : 'neutral';
    rows.push(
      <SinkRow
        key="location"
        icon="location-outline"
        label="Location (Device-reported)"
        appliesTo="Every capture · toggle in Settings"
        tone={tone}
        headline={location.state === 'recorded' ? 'Recorded' : location.state === 'removed' ? 'Removed' : 'Not recorded'}
        detail={location.detail}
        path={location.coords}
        mono
      />
    );
  }

  if (captureEvidence) {
    for (const s of PATH_SINKS.slice(1)) {
      const p = captureEvidence[s.key];
      const st = pathState(p);
      rows.push(
        <SinkRow
          key={s.key}
          icon={s.icon}
          label={s.label}
          appliesTo={s.appliesTo}
          tone={st.tone}
          headline={st.headline}
          detail={s.key === 'ringBufferDir' && typeof p === 'string' && p !== 'never-recorded' ? `${st.detail} ${RING_EXPLAINER}` : s.key === 'ringBufferDir' ? RING_EXPLAINER : st.detail}
          path={typeof p === 'string' && p !== 'never-recorded' ? p : undefined}
          mono
        />
      );
    }
  }

  return (
    <View>
      {!captureEvidence ? (
        <View style={styles.legacy}>
          <Ionicons name="time-outline" size={14} color={colors.textDim} />
          <Text style={styles.legacyText}>
            The path-based sinks (sensor log, raw audio, frames) were declared starting with 1.0.0; this
            record predates that declaration. An old record is not a claim that nothing was recorded.
          </Text>
        </View>
      ) : null}
      {rows}
    </View>
  );
}

const buildStyles = () => StyleSheet.create({
  legacy: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', marginBottom: spacing.sm },
  legacyText: { flex: 1, color: colors.textDim, fontSize: fontSize.sm, lineHeight: 19 },
  row: {
    backgroundColor: colors.surface2,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  sinkLabel: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
  applies: { color: colors.textFaint, fontSize: fontSize.xs, marginTop: 1 },
  badge: { borderRadius: radii.full, paddingHorizontal: 9, paddingVertical: 4 },
  badgeText: { fontSize: fontSize.xs, fontWeight: '700' },
  drawer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  detail: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17 },
  errorLabel: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.xs, fontWeight: '600' },
  path: {
    fontFamily: type.mono,
    color: colors.textDim,
    fontSize: fontSize.xs,
    marginTop: spacing.xs,
    letterSpacing: 0.2,
  },
});
