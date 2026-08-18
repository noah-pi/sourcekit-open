// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Renders an attestation record — used by the exhibit detail screen and the
 * Inspect result screen. Every field is labeled as what it is: a *claim*
 * recorded at signing time, bound by the signature. No verdict language.
 */

import { View, Text, StyleSheet } from 'react-native';
import type { AttestationRecord } from '../provenance/manifest';
import { Card, SectionLabel, KeyValueRow, Divider, Mono, Chip } from './ui';
import { colors, spacing, fontSize, useThemedStyles, useEffectiveScheme } from '../theme';

function motionLabel(v: string): string {
  switch (v) {
    case 'handheld': return 'Handheld motion';
    case 'steady': return 'Device still';
    case 'moving': return 'Device moving';
    default: return 'Insufficient data';
  }
}

export function AttestationView({ record, ownFingerprint }: {
  record: AttestationRecord;
  /** The viewing device's fingerprint — used for the "signed by this device" chip. */
  ownFingerprint?: string | null;
}) {
  const styles = useThemedStyles(buildStyles);
  const { context, signer, identity } = record;
  const loc = context.location;
  const isOwnKey = ownFingerprint != null && ownFingerprint === signer.fingerprint;

  return (
    <View>
      <Card>
        <SectionLabel text="Signer" />
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm, flexWrap: 'wrap' }}>
          <Chip
            label={isOwnKey ? 'Signed by this device' : 'Signed by another device'}
            tone={isOwnKey ? 'info' : 'neutral'}
            icon="key-outline"
          />
          <Chip label={`ES256 · P-256`} tone="neutral" />
          {record.pqKey && record.pqSignature ? (
            <Chip label="ML-DSA-65 · software key" tone="neutral" icon="key-outline" />
          ) : null}
          {record.orgCredential ? (
            <Chip label={`Org credential · ${record.orgCredential.issuer ?? 'org-issued'}`} tone="good" icon="business-outline" />
          ) : null}
          {record.biometricBound ? (
            <Chip label="Face ID–approved" tone="good" icon="scan-outline" />
          ) : null}
          {record.deidentified ? (
            <Chip label="De-identified copy" tone="warn" icon="eye-off-outline" />
          ) : null}
          {record.assignment ? (
            <Chip label={`Assignment key · ${record.assignment.label}`} tone="neutral" icon="briefcase-outline" />
          ) : null}
        </View>
        {/* the PQ explainer text and the device-integrity
            self-report row were removed from this page — footnote-grade
            material that cost more attention than it returned. The ML-DSA
            chip above still says the second signature exists; the signed
            record still carries both blocks for a desk. */}
        {record.captureIntegrity ? (
          <>
            <KeyValueRow
              label="Shutter → signature"
              value={
                record.captureIntegrity.captureToSignatureMs < 1000
                  ? `${record.captureIntegrity.captureToSignatureMs} ms`
                  : `${(record.captureIntegrity.captureToSignatureMs / 1000).toFixed(1)} s`
              }
            />
            {record.captureIntegrity.sensorTiming ? (
              <KeyValueRow
                label="Sensor-frame timing"
                value={`${record.captureIntegrity.sensorTiming.samples} samples · regularity ${record.captureIntegrity.sensorTiming.intervalCv}`}
              />
            ) : null}
            {record.context.poseTrace ? (
              <>
                <KeyValueRow
                  label="Pose trace"
                  value={`${record.context.poseTrace.samples} samples @ ${record.context.poseTrace.hz} Hz · gyro + fused attitude`}
                />
                <Text style={styles.integrityNote}>
                  The signed motion of the device around the shutter: evidence a desk cross-checks
                  against the footage (near detail should move with the gyro). It is weighed by a
                  person; the app does not claim an automated verdict from it.
                </Text>
              </>
            ) : null}
            <Text style={styles.integrityNote}>
              Timing signals are device-reported, sealed as claims.
            </Text>
          </>
        ) : null}
        {record.orgCredential ? (
          <>
            <KeyValueRow label="Issued by" value={record.orgCredential.issuer ?? '—'} />
            <KeyValueRow label="Cert serial" value={record.orgCredential.serialHex} mono />
            <KeyValueRow label="Valid until" value={new Date(record.orgCredential.notAfter).toLocaleDateString()} />
          </>
        ) : null}
        <View style={styles.fingerprintBox}>
          <Mono size="sm" color={colors.accent}>{signer.fingerprint}</Mono>
        </View>
        <Text style={styles.fingerprintCaption}>
          Key fingerprint: compare all 64 characters with the sender's device.
        </Text>
      </Card>

      <Card>
        <SectionLabel text="Claims recorded at signing" />
        <KeyValueRow label="Captured" value={new Date(record.capturedAt).toLocaleString()} />
        <KeyValueRow label="Device clock" value="UTC, device-reported" />
        <Divider />
        {identity === 'redacted' ? (
          <KeyValueRow label="Identity" value="Redacted by signer" />
        ) : (
          <>
            <KeyValueRow label="Author" value={identity.author ?? '—'} />
            {/* Legacy records can still carry a typed-in org claim; new records never do. */}
            {identity.organization ? <KeyValueRow label="Organization" value={identity.organization} /> : null}
          </>
        )}
        <Divider />
        {loc === 'redacted' ? (
          <KeyValueRow label="Location" value="Redacted by signer" />
        ) : loc === 'unavailable' ? (
          <KeyValueRow label="Location" value="Unavailable at capture" />
        ) : (
          <>
            <KeyValueRow label="Location" value={`${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`} />
            {loc.accuracyM != null ? <KeyValueRow label="GPS accuracy" value={`±${loc.accuracyM} m`} /> : null}
          </>
        )}
        {context.wifi === 'redacted' ? (
          <KeyValueRow label="Wi-Fi network" value="Redacted by signer" />
        ) : context.wifi === 'unavailable' ? (
          <KeyValueRow label="Wi-Fi network" value="Unavailable at capture" />
        ) : context.wifi ? (
          <>
            <KeyValueRow label="Wi-Fi network" value={context.wifi.ssid ?? '(none reported)'} />
            {context.wifi.bssid ? <KeyValueRow label="Wi-Fi router (BSSID)" value={context.wifi.bssid} /> : null}
            <Text style={styles.integrityNote}>
              Reported by the phone; anyone can name a network anything. A lead to
              corroborate, never proof of place. A desk can look up the BSSID; the app never does.
            </Text>
          </>
        ) : null}
        {context.headingDeg != null ? <KeyValueRow label="Heading" value={`${context.headingDeg}°`} /> : null}
        {context.pressureHPa != null ? <KeyValueRow label="Pressure" value={`${context.pressureHPa} hPa`} /> : null}
        {context.altitudeM != null ? <KeyValueRow label="Altitude (baro.)" value={`${context.altitudeM} m`} /> : null}
        {context.motion ? (
          <KeyValueRow
            label="Motion signal"
            value={`${motionLabel(context.motion.verdict)} · ${context.motion.peakHz} Hz peak`}
          />
        ) : null}
        <Divider />
        <KeyValueRow label="Device model" value={record.device.model ?? '—'} />
        <KeyValueRow label="App" value={`${record.app.name} ${record.app.version} · ${record.device.platform}`} />
        {record.ots && record.ots.submissions.length > 0 ? (
          <>
            <Divider />
            {/* Ledger time (Bitcoin) is a separate claim from authority time
                (RFC 3161) and from the device clock — never merged. */}
            {(() => {
              const confirmed = record.ots!.submissions.filter((s) => s.state === 'confirmed');
              const delay = record.ots!.submissions.find((s) => s.queueDelayMs !== undefined)?.queueDelayMs;
              if (confirmed.length > 0) {
                const best = confirmed.reduce((a, b) => ((a.blockHeight ?? 0) <= (b.blockHeight ?? 0) ? a : b));
                return (
                  <KeyValueRow
                    label="Ledger time"
                    value={`Bitcoin block #${best.blockHeight} · anchored via OpenTimestamps`}
                  />
                );
              }
              return (
                <KeyValueRow
                  label="Ledger time"
                  value={`Submitted to ${record.ots!.submissions.length} calendar${record.ots!.submissions.length > 1 ? 's' : ''} · awaiting Bitcoin confirmation${
                    delay !== undefined && delay > 60_000 ? ` · queued offline for ${Math.round(delay / 60_000)} min` : ''
                  }`}
                />
              );
            })()}
          </>
        ) : null}
      </Card>

      <Card>
        <SectionLabel text="Signed media" />
        <KeyValueRow label="Type" value={`${record.asset.kind} · ${record.asset.mime}`} />
        <KeyValueRow label="Size" value={`${(record.asset.bytes / 1024 / 1024).toFixed(2)} MB`} />
        <View style={{ marginTop: spacing.xs }}>
          <Text style={styles.hashLabel}>SHA-256</Text>
          <Mono size="sm" color={colors.textDim}>{record.asset.sha256}</Mono>
        </View>
      </Card>

      <Text style={styles.disclaimer}>
        A valid signature shows these bytes are unchanged since signing and were signed by the
        key above. Timestamps, location, Wi-Fi, and sensor readings are claims the device made at
        capture: evidence to weigh, not facts.
        {record.deidentified
          ? ' This copy was deliberately de-identified by the signer: ' + record.deidentified.fields.join(', ') + ' were removed before sharing.'
          : ''}
      </Text>
    </View>
  );
}

const buildStyles = () => StyleSheet.create({
  fingerprintBox: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    padding: spacing.sm + 2,
    marginTop: spacing.xs,
  },
  fingerprintCaption: { color: colors.textFaint, fontSize: fontSize.xs, marginTop: spacing.sm, lineHeight: 16 },
  integrityNote: { color: colors.textFaint, fontSize: fontSize.xs, marginTop: 2, lineHeight: 16 },
  hashLabel: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    letterSpacing: 1.2,
    fontWeight: '700',
    marginBottom: 4,
  },
  disclaimer: {
    color: colors.textFaint,
    fontSize: fontSize.sm,
    lineHeight: 20,
    paddingHorizontal: spacing.xs,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
});
