// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Settings — seven sections, top to bottom:
 *   1. Notice (the beta status, bold and verbatim, + feedback link)
 *   2. Device ID (hardware key, App Attest drill-in, copy/rotate, device line)
 *   3. Signer Information (optional byline, organization credential — fetched
 *      over TLS from the org's domain, or imported as a file)
 *   4. What gets recorded — one tight line per toggle, in two explicit
 *      groups: "Identifying — sealed into the file" in muted terracotta
 *      (location, byline, organization, Wi-Fi, transcript) and "Evidence —
 *      about the moment, not you" in sage green (multiple lenses, shutter
 *      burst, raw audio, full-rate motion log). The face check keeps a
 *      third color of its own; the Bitcoin-anchored timestamp row closes
 *      the card.
 *   5. Privacy & Security (app lock, camera roll, Bitcoin anchor status,
 *      erase all data)
 *   6. Appearance (Device / Dark / Light — Device follows the iPhone)
 *   7. Diagnostics (the last 30 capture/seal events, errors verbatim, Clear)
 * One line per row, one sub-line max. Deliberately absent: a Bitcoin on/off
 * switch (anchoring is default-always-on; status stays, read-only) and
 * trust-roster management.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TextInput,
  Alert,
  Pressable,
  Platform,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Device from 'expo-device';
import { sha256 } from '@noble/hashes/sha256';

import { colors, spacing, radii, fontSize, useThemedStyles, type AppearancePreference } from '../../src/theme';
import { useStore } from '../../src/store/useStore';
import { ScreenTitle, Card, SectionLabel, ToggleRow, Button, Divider, Mono, KeyValueRow } from '../../src/components/ui';
import { getDeviceKey, regenerateDeviceKey } from '../../src/lib/deviceKey';
import {
  appAttestSupported,
  attestThisDevice,
  attestThisDeviceLocally,
  clearAttestation,
  getAttestState,
  getAttestServerUrl,
  setAttestServerUrl,
  type AttestState,
} from '../../src/lib/appAttest';
import { fetchOrgCredentialFromDomain } from '../../src/lib/orgDirectory';
import { enclaveGetPublicKey } from '../../src/lib/enclave';
import {
  getOrgCredential, setOrgCredential, clearOrgCredential,
  orgCertChainForKey, pemOrDerToDer, type OrgCredential,
} from '../../src/lib/orgCert';
import { base64ToBytes, bytesToHex } from '../../src/lib/bytes';
import { hasPasscode, removePasscode } from '../../src/vault/passcode';
import { downgradeVaultKeyAcl } from '../../src/vault/vaultFs';
import { pqEnrollmentInfo } from '../../src/lib/pqKeyStore';
import { destroyVault } from '../../src/vault/vaultFs';
import { subscribeDiagnostics, clearDiagnostics, logDiagnostic, type DiagnosticEvent } from '../../src/lib/diagnosticsLog';
import { getExhibitDebugFlags, setExhibitDebugFlag, type ExhibitDebugFlagKey, type ExhibitDebugFlags } from '../../src/lib/exhibitCamera';

/** Fingerprint of the plain Enclave signing key — the key attestation binds. */
function enclaveFingerprint(): string {
  try {
    const pub = enclaveGetPublicKey();
    return pub ? bytesToHex(sha256(pub)) : '';
  } catch {
    return '';
  }
}

/**
 * All 64 hex chars, grouped eight-by-eight — this is the screen where a
 * member reads their fingerprint aloud to an editor, so nothing truncates.
 */
function groupedFingerprint(fp: string): string {
  return (fp.match(/.{1,8}/g) ?? []).join(' ');
}

/**
 * Scroll position, kept at MODULE scope on purpose. Toggling Device
 * appearance flips the effective scheme, and the root layout remounts the
 * navigator on scheme change (app/_layout.tsx `key={scheme}` — load-bearing
 * for module-scope styles, so it stays). That remount is what used to throw
 * this list back to the top. The screen re-mounts, reads the saved offset,
 * and restores it — the list itself is never keyed or remounted here.
 */
let settingsScrollY = 0;

export default function SettingsScreen() {
  const scrollRef = useRef<ScrollView>(null);
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const { settings, saveSettings, passcodeSet, setPasscodeSet, setUnlocked, bumpVault } = useStore();
  const [fingerprint, setFingerprint] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [keyBackend, setKeyBackend] = useState<'secure-enclave-attested' | 'secure-enclave' | 'software' | ''>('');
  const [attestState, setAttestState] = useState<AttestState | null>(null);
  const [attestExpanded, setAttestExpanded] = useState(false);
  const [attestServer, setAttestServer] = useState('');
  const [attestBusy, setAttestBusy] = useState(false);
  const [showRegistryInput, setShowRegistryInput] = useState(false);
  const [orgDomainDraft, setOrgDomainDraft] = useState('');
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [orgCred, setOrgCred] = useState<OrgCredential | null>(null);
  const [orgStale, setOrgStale] = useState(false);
  const [orgBusy, setOrgBusy] = useState(false);
  // Local draft — persisted onBlur so we don't hit disk on every keystroke.
  const [authorDraft, setAuthorDraft] = useState(settings.author);
  // PQ dual-signature layer: enrollment info for display only.
  const [pqInfo, setPqInfo] = useState<{ fingerprint: string; enrolledAt: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  // The diagnostics log: the record of capture/seal events that toasts
  // can't be (they fade; this persists).
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([]);
  // Wave-7 isolation switches — null until the native flags are read.
  const [debugFlags, setDebugFlags] = useState<ExhibitDebugFlags | null>(null);

  useEffect(() => subscribeDiagnostics(setDiagnostics), []);
  useEffect(() => {
    getExhibitDebugFlags().then(setDebugFlags).catch(() => {});
  }, []);

  /**
   * Flip one wave-7 flag. Local state updates ONLY on {applied: true} —
   * a rejected flip leaves the switch where it was (the persisted native
   * value), never an optimistic lie. Applied to the NEXT session build;
   * the footnote under the switches says so.
   */
  const handleDebugFlag = (key: ExhibitDebugFlagKey, value: boolean) => {
    void (async () => {
      const res = await setExhibitDebugFlag(key, value).catch(() => ({ applied: false, reason: 'error' }));
      // 0.18.4-R5: a flip is recorded in the on-device log either way — the
      // log then answers "did my switch take?" without guessing — and a
      // rejection is STATED, never a silent snap-back of the switch.
      logDiagnostic({
        t: Date.now(),
        kind: 'camera',
        outcome: 'info',
        message: res.applied
          ? `diagnostics switch set: ${key}=${value} (applies at next session rebuild)`
          : `diagnostics switch REJECTED: ${key}=${value} (${res.reason ?? 'unknown'}) — stored value unchanged`,
      });
      if (res.applied) {
        setDebugFlags((f) => ({
          photoConnectionRotation: f?.photoConnectionRotation ?? false,
          photoMaxDimensionsPolicy: f?.photoMaxDimensionsPolicy ?? true,
          ...f,
          [key]: value,
        }));
      } else {
        Alert.alert(
          'Switch not applied',
          `The camera module refused ${key}=${value} (${res.reason ?? 'unknown'}). The stored value is unchanged.`,
        );
      }
    })();
  };

  // 0.18.4-R3: which diagnostics switches differ from their native defaults
  // (absent key = default). Drives the banner above the switches.
  const nonDefaultFlags = debugFlags
    ? (Object.keys(DEBUG_FLAG_DEFAULTS) as ExhibitDebugFlagKey[]).filter(
        (k) => (debugFlags[k] ?? DEBUG_FLAG_DEFAULTS[k]) !== DEBUG_FLAG_DEFAULTS[k]
      )
    : [];

  useEffect(() => {
    getDeviceKey().then((k) => {
      setFingerprint(k.fingerprint);
      setPublicKey(k.publicKeyBase64);
      setKeyBackend(k.backend);
    }).catch(() => {});
    // Attestation is set-and-forget (0.18.0): the launch path ensures it
    // silently; here we simply read the stored state for display.
    getAttestState().then(setAttestState).catch(() => {});
    getAttestServerUrl().then((u) => setAttestServer(u ?? ''));
    pqEnrollmentInfo().then(setPqInfo).catch(() => {});
    (async () => {
      const hw = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      setBiometricsAvailable(hw && enrolled);
    })();
    hasPasscode().then(setPasscodeSet);
    (async () => {
      const cred = await getOrgCredential();
      setOrgCred(cred);
      if (cred) {
        const k = await getDeviceKey().catch(() => null);
        if (k) setOrgStale((await orgCertChainForKey(base64ToBytes(k.publicKeyBase64))) === 'stale');
      }
    })();
  }, []);

  /** Copies the public key + fingerprint so it can be published anywhere. */
  const copyPublicKey = async () => {
    await Clipboard.setStringAsync(
      `Source Kit device key\nalg: ES256 (P-256)\nfingerprint (SHA-256): ${fingerprint}\npublic key (base64): ${publicKey}`
    );
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const handleAttest = async () => {
    const url = attestServer.trim().replace(/\/+$/, '');
    setAttestBusy(true);
    try {
      // Registry when one is deliberately configured (orgs); otherwise the
      // local-challenge path — the same binding math, no server at all.
      const state = url
        ? await (async () => { await setAttestServerUrl(url); return attestThisDevice(url); })()
        : await attestThisDeviceLocally();
      setAttestState(state);
      Alert.alert('Hardware attested', 'Apple certified this device and app, and the attestation is now bound to your signing key. Future captures carry it in their C2PA manifest.');
    } catch (e) {
      setAttestState(null);
      Alert.alert('Attestation failed', `${String(e)}\n\nSigning still works; attestation is an upgrade, not a requirement. It retries automatically at every launch.`);
    } finally {
      setAttestBusy(false);
    }
  };

  /** The attestation detail panel's export — the stored state, as JSON. */
  const exportAttestation = async () => {
    if (!attestState) return;
    const path = `${FileSystem.cacheDirectory}exhibit-attestation.json`;
    await FileSystem.writeAsStringAsync(path, JSON.stringify(attestState, null, 2));
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: 'application/json', dialogTitle: 'Export attestation' });
  };

  /**
   * The picker filters to JSON — the org-issued credential file
   * carrying the X.509 chain:
   *   { "leafDerBase64": "…", "caDerBase64": "…" }
   * PEM-armored strings under the same keys are accepted too. The private
   * key never leaves this device — the file only vouches for the public one.
   */
  const doImportOrgCred = async () => {
    setOrgBusy(true);
    try {
      const doc = await DocumentPicker.getDocumentAsync({ type: 'application/json', copyToCacheDirectory: true });
      if (doc.canceled || !doc.assets?.[0]) return;
      const raw = JSON.parse(await FileSystem.readAsStringAsync(doc.assets[0].uri)) as Record<string, unknown>;
      const pick = (...keys: string[]): string | null => {
        for (const k of keys) {
          const v = raw[k];
          if (typeof v === 'string' && v.trim()) return v;
        }
        return null;
      };
      const decode = (s: string): Uint8Array =>
        s.includes('BEGIN CERTIFICATE') ? pemOrDerToDer(s) : base64ToBytes(s.replace(/\s+/g, ''));
      const leafS = pick('leafDerBase64', 'leafBase64', 'leaf', 'certificate');
      if (!leafS) {
        throw new Error('No device certificate found in that file. Expected an org-issued credential JSON containing the X.509 chain.');
      }
      const caS = pick('caDerBase64', 'caBase64', 'ca');
      const key = await getDeviceKey();
      const cred = await setOrgCredential(decode(leafS), caS ? decode(caS) : null, base64ToBytes(key.publicKeyBase64));
      setOrgCred(cred);
      setOrgStale(false);
      Alert.alert('Credential active', 'New captures will chain signatures into your organization’s CA.');
    } catch (e) {
      Alert.alert('Import failed', e instanceof Error ? e.message : 'Could not read that credential file.');
    } finally {
      setOrgBusy(false);
    }
  };

  /** Fetches the org-issued credential from the org's own domain (signet-org/1). */
  const doFetchOrgCred = async () => {
    setOrgBusy(true);
    try {
      const cred = await fetchOrgCredentialFromDomain(orgDomainDraft);
      setOrgCred(cred);
      setOrgStale(false);
      Alert.alert('Credential active', `Issued for this device by ${cred.info.issuerOrg ?? cred.info.issuerCN ?? 'your organization'}, fetched from ${cred.sourceDomain ?? 'the organization domain'} over TLS. New captures will chain signatures into the organization’s CA.`);
    } catch (e) {
      Alert.alert('Could not fetch credential', e instanceof Error ? e.message : 'The organization domain did not provide a credential for this device.');
    } finally {
      setOrgBusy(false);
    }
  };

  /**
   * Each install path explains ITS OWN specifics before it runs (0.18.2 —
   * the dense paragraph under the buttons became one quiet line; the
   * mechanism lives here, at the moment of action). Both alerts state the
   * same enrollment fact: hand the org this device's key; the private key
   * never leaves the device.
   */
  const handleFetchOrgCred = () => {
    const domain = orgDomainDraft.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    Alert.alert(
      'Fetch from your organization',
      `The app downloads ${domain ? `https://${domain}` : 'https://your-org-domain'}/.well-known/signet-org.json over TLS, then checks the credential: it must name this device’s key, be in date, and be signed by your organization’s CA. Anything else is rejected.\n\nEnroll by handing your organization this device’s key (Device ID → Copy key). The private key never leaves this device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Fetch', onPress: () => void doFetchOrgCred() },
      ]
    );
  };

  const handleImportOrgCred = () => {
    Alert.alert(
      'Import a credential file',
      'Open the credential file your organization gave you: JSON carrying the X.509 chain, PEM certificates accepted. The same checks run: this device’s key, in date, signed by the organization’s CA. No network needed.\n\nEnroll by handing your organization this device’s key (Device ID → Copy key). The private key never leaves this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Choose file', onPress: () => void doImportOrgCred() },
      ]
    );
  };

  const handleRemoveOrgCred = () => {
    Alert.alert('Remove organization credential?', 'New captures stop chaining into the organization. Past captures keep their signed chain.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void (async () => { await clearOrgCredential(); setOrgCred(null); setOrgStale(false); })() },
    ]);
  };

  const confirmRotateKey = () => {
    Alert.alert(
      'Rotate signing key?',
      'A new device identity is generated and the old private key is destroyed. Past attestations remain verifiable against the old fingerprint, but new captures will sign with the new key.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Rotate',
          style: 'destructive',
          onPress: async () => {
            const k = await regenerateDeviceKey();
            setFingerprint(k.fingerprint);
            setPublicKey(k.publicKeyBase64);
            setAttestState(await getAttestState().catch(() => null));
            if (orgCred) setOrgStale(true); // credential was issued for the old key
          },
        },
      ]
    );
  };

  const confirmRemovePasscode = () => {
    Alert.alert('Remove passcode?', 'The app will no longer lock on open. The collection stays encrypted at rest.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await removePasscode();
          await downgradeVaultKeyAcl().catch(() => {});
          setPasscodeSet(false);
        },
      },
    ]);
  };

  const confirmEraseAll = () => {
    Alert.alert(
      'Erase everything?',
      'Collection media, attestations, settings, passcode, and the device signing key are permanently destroyed. There is no recovery.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Erase everything',
          style: 'destructive',
          onPress: () => {
            Alert.alert('Are you absolutely sure?', 'This is irreversible.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Yes, erase',
                style: 'destructive',
                onPress: async () => {
                  await destroyVault();
                  await removePasscode();
                  await clearOrgCredential();
                  await clearAttestation().catch(() => {}); // no stale attestation survives the wipe
                  setAttestState(null);
                  setOrgCred(null);
                  setOrgStale(false);
                  await saveSettings({
                    author: '',
                    identityMode: 'anonymous',
                    assignmentId: '',
                    saveToCameraRoll: false,
                    biometricsEnabled: false,
                  });
                  setPasscodeSet(false);
                  setUnlocked(true);
                  const k = await regenerateDeviceKey();
                  setFingerprint(k.fingerprint);
                  setPublicKey(k.publicKeyBase64);
                  bumpVault();
                  Alert.alert('Erased', 'All Source Kit data on this device has been destroyed.');
                },
              },
            ]);
          },
        },
      ]
    );
  };

  /** Face check: the toggle is honest — it can't go on where the check can't run. */
  const handleFaceCheckToggle = (v: boolean) => {
    if (v && !biometricsAvailable) {
      Alert.alert('Face check unavailable in this build', 'Face ID is not set up on this device, so the check cannot run. The toggle stays off.');
      return;
    }
    void saveSettings({ faceCheckEnabled: v });
  };

  const attested = attestState != null;
  const attestationBound = attested && attestState.boundFingerprint === enclaveFingerprint();
  const deviceLine = `${Device.modelName ?? 'This device'} · iOS ${Platform.Version} · reported by this device, not attested.`;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={(e) => {
          settingsScrollY = e.nativeEvent.contentOffset.y;
        }}
        onContentSizeChange={() => {
          // Restore after a scheme-flip remount; a no-op on first mount (0)
          // and effectively a no-op while interacting (the offset tracks the
          // user's own scroll via onScroll).
          if (settingsScrollY > 0) scrollRef.current?.scrollTo({ y: settingsScrollY, animated: false });
        }}
      >
        <ScreenTitle title="Settings" tag="in beta" subtitle="Signed and stored locally. Nothing uploads." />

        {/* 1. Notice — the beta status, bold and first, plus the feedback link. */}
        <Card style={styles.betaCard}>
          <View style={styles.betaRow}>
            <Ionicons name="flask-outline" size={18} color={colors.textDim} />
            <View style={{ flex: 1, gap: spacing.xs }}>
              <Text style={styles.betaLead}>
                PLEASE READ{'  '}
                <Text style={styles.betaText}>
                  The Source Kit camera app is <Text style={styles.betaEm}>in beta</Text>. Its cryptographic and privacy
                  claims cannot be verified until a full security audit is complete.
                </Text>
              </Text>
              <Text style={styles.betaText}>
                Please break it and tell us.
              </Text>
              <Pressable
                onPress={() => void Linking.openURL('mailto:enbenpi@gmail.com?subject=Source%20Kit%20feedback')}
                hitSlop={6}
              >
                <Text style={styles.feedbackLink}>Send feedback →</Text>
              </Pressable>
            </View>
          </View>
        </Card>

        {/* 2. Device ID */}
        <SectionLabel text="Device ID" />
        <Card>
          {/* Two rows, never one bullet-joined badge: where the key lives and
              who attested it are separate facts. */}
          <KeyValueRow
            label="Hardware Key"
            value={
              keyBackend === 'secure-enclave-attested' || keyBackend === 'secure-enclave'
                ? 'Secure Enclave'
                : keyBackend === 'software'
                  ? 'OS keychain (software)'
                  : '…'
            }
          />
          <KeyValueRow
            label="Attestation"
            value={
              keyBackend === 'secure-enclave-attested' || (keyBackend === 'secure-enclave' && attestationBound)
                ? 'Apple Attested'
                : 'Not attested'
            }
          />

          {appAttestSupported() ? (
            attested ? (
              <View style={styles.attestBlock}>
                <Pressable style={styles.rowBetween} onPress={() => setAttestExpanded((e) => !e)} hitSlop={6}>
                  <Text style={styles.rowTitle}>App Attest</Text>
                  <View style={styles.attestRight}>
                    <Text style={styles.attestValue}>Attested</Text>
                    <Ionicons name={attestExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textDim} />
                  </View>
                </Pressable>
                {attestExpanded ? (
                  <View style={styles.attestPanel}>
                    <Text style={styles.rowDetail}>Key fingerprint: all 64 hex digits, grouped for reading aloud:</Text>
                    <Mono size="sm" color={colors.text} style={styles.fpGrouped}>{groupedFingerprint(attestState.boundFingerprint || fingerprint)}</Mono>
                    <KeyValueRow label="Attested at" value={new Date(attestState.registeredAt).toLocaleDateString()} />
                    <KeyValueRow label="Apple chain" value="Checked against Apple’s pinned root" />
                    <KeyValueRow
                      label="Challenge"
                      value={attestState.origin === 'local' ? 'Generated on this device' : attestState.origin === 'registry' ? 'Issued by the registry' : 'Registry (pre-0.18)'}
                    />
                    {!attestationBound ? (
                      <>
                        <Text style={styles.rowDetail}>
                          This attestation predates the current key. Re-attest to bind it to the key in use now.
                        </Text>
                        <View style={styles.rowButtons}>
                          <Button small tone="secondary" icon="shield-checkmark-outline" label={attestBusy ? 'Attesting…' : 'Re-attest'} onPress={() => void handleAttest()} disabled={attestBusy} />
                        </View>
                      </>
                    ) : null}
                    <View style={styles.rowButtons}>
                      <Button small tone="secondary" icon="share-outline" label="Export attestation" onPress={() => void exportAttestation()} />
                      <Button small tone="secondary" icon="refresh-outline" label="Rotate key" onPress={confirmRotateKey} />
                    </View>
                    <Text style={styles.rowDetail}>
                      {pqInfo ? 'Post-quantum dual-signature: on' : 'Post-quantum dual-signature: enrolls on your next capture'}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : (
              <View style={styles.attestBlock}>
                <View style={styles.rowBetween}>
                  <Text style={styles.rowTitle}>App Attest</Text>
                  <Button small tone="secondary" label={attestBusy ? 'Attesting…' : 'Retry now'} onPress={() => void handleAttest()} disabled={attestBusy} />
                </View>
                <Text style={styles.rowDetail}>
                  Runs automatically at every launch. No setup, no server; it retries on its own.
                </Text>
                <Pressable onPress={() => setShowRegistryInput((s) => !s)} hitSlop={6}>
                  <Text style={styles.registryToggle}>{showRegistryInput ? 'Hide registry option' : 'Use an organization registry instead'}</Text>
                </Pressable>
                {showRegistryInput ? (
                  <TextInput
                    style={styles.input}
                    placeholder="Registry URL (your choice; none bundled)"
                    placeholderTextColor={colors.textDim}
                    value={attestServer}
                    onChangeText={setAttestServer}
                    onBlur={() => void setAttestServerUrl(attestServer)}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                  />
                ) : null}
              </View>
            )
          ) : null}

          <View style={styles.fingerprintBox}>
            <Mono size="sm" color={colors.accent}>{fingerprint || '…'}</Mono>
          </View>
          <View style={styles.rowButtons}>
            <Button small tone="secondary" icon="copy-outline" label={copiedKey ? 'Copied' : 'Copy key'} onPress={() => void copyPublicKey()} />
            {!attested ? <Button small tone="secondary" icon="refresh-outline" label="Rotate key" onPress={confirmRotateKey} /> : null}
          </View>
          <Text style={styles.rowDetail}>
            {keyBackend === 'secure-enclave-attested' || attestationBound
              ? 'This device’s App Attest signing key.'
              : 'This device’s signing key.'}
          </Text>

          <Text style={styles.deviceLine}>{deviceLine}</Text>
        </Card>

        {/* 3. Signer Information — who the signature claims to be. */}
        <SectionLabel text="Signer Information" />
        <Card>
          <View style={styles.aliasHeader}>
            <Text style={styles.rowTitle}>Byline</Text>
            <View style={styles.optionalTag}>
              <Text style={styles.optionalTagText}>optional</Text>
            </View>
          </View>
          <TextInput
            style={styles.input}
            placeholder="No name set"
            placeholderTextColor={colors.textFaint}
            value={authorDraft}
            onChangeText={setAuthorDraft}
            onBlur={() => saveSettings({ author: authorDraft })}
            autoCapitalize="words"
          />
          <Text style={styles.rowDetail}>
            Self-declared: a name, never proof of identity. Sealed into captures when the Byline toggle below is on.
          </Text>

          <Divider />
          {/* Same header rank as Alias (0.14.0) — this is a second kind of
              signer identity, not a footnote under it. */}
          <View style={styles.aliasHeader}>
            <Text style={styles.rowTitle}>Organization Credential</Text>
            <View style={styles.optionalTag}>
              <Text style={styles.optionalTagText}>optional</Text>
            </View>
          </View>
          {orgCred ? (
            <>
              <KeyValueRow label="Organization" value={orgCred.info.subjectOrg ?? orgCred.info.subjectCN ?? '—'} />
              <KeyValueRow label="Expires" value={new Date(orgCred.info.notAfter).toLocaleDateString()} />
              {orgCred.sourceDomain ? (
                <KeyValueRow label="Installed from" value={`${orgCred.sourceDomain} · over TLS`} />
              ) : null}
              {orgStale ? (
                <Text style={styles.rowDetail}>
                  Predates the current key and goes unused. Re-issue for the new key.
                </Text>
              ) : null}
              <View style={styles.rowButtons}>
                <Button small tone="secondary" label="Remove" onPress={handleRemoveOrgCred} />
              </View>
            </>
          ) : (
            <Text style={styles.rowDetail}>No organization credential installed.</Text>
          )}
          <View style={{ height: spacing.sm }} />
          <TextInput
            style={styles.input}
            placeholder="Organization domain (e.g. example-news.com)"
            placeholderTextColor={colors.textDim}
            value={orgDomainDraft}
            onChangeText={setOrgDomainDraft}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <View style={styles.rowButtons}>
            <Button
              small
              tone="secondary"
              icon="globe-outline"
              label={orgBusy ? 'Fetching…' : 'Fetch credential'}
              onPress={handleFetchOrgCred}
              disabled={orgBusy}
            />
            <Button
              small
              tone="ghost"
              icon="document-outline"
              label={orgBusy ? 'Importing…' : 'Import file instead'}
              onPress={handleImportOrgCred}
              disabled={orgBusy}
            />
          </View>
          <Text style={styles.rowDetail}>
            Chains your captures to your organization’s certificate.
          </Text>
        </Card>

        {/* 4. What gets recorded — two labeled groups (identifying in amber,
            evidence in the accent), one tight line per toggle. */}
        <SectionLabel text="What gets recorded" />
        <Card>
          {/* Two explicit groups (0.18.1): terracotta marks the toggles that
              seal WHO/WHERE-you-are into the file; sage marks evidence about
              the moment itself. One tight line per toggle. */}
          <GroupLabel tint={IDENTIFYING_TINT} text="Identifying · sealed into the file" />
          <ProofToggle
            icon="location-outline"
            label="Location"
            sub="Exact GPS coordinates at the shutter."
            tint={IDENTIFYING_TINT}
            value={settings.includeLocation}
            onChange={(v) => saveSettings({ includeLocation: v })}
          />
          <ProofToggle
            icon="person-outline"
            label="Byline"
            sub="Your self-declared name, never verified."
            tint={IDENTIFYING_TINT}
            value={settings.includeByline}
            onChange={(v) =>
              saveSettings(v ? { includeByline: true, identityMode: 'named' } : { includeByline: false })
            }
          />
          <ProofToggle
            icon="business-outline"
            label="Organization"
            sub={
              orgCred && !orgStale
                ? `Signed with your ${orgCred.info.subjectOrg ?? orgCred.info.issuerOrg ?? orgCred.info.issuerCN ?? 'organization'} credential.`
                : 'No credential installed; self-certified.'
            }
            tint={IDENTIFYING_TINT}
            value={orgCred != null && !orgStale}
            onChange={() => {}}
            disabled
          />
          <ProofToggle
            icon="wifi-outline"
            label="Wi-Fi"
            sub="Your router's hardware address (BSSID)."
            tint={IDENTIFYING_TINT}
            value={settings.includeWifi}
            onChange={(v) => saveSettings({ includeWifi: v })}
          />
          <ProofToggle
            icon="text-outline"
            label="Transcript"
            sub="Speech-to-text, on device."
            tint={IDENTIFYING_TINT}
            value={settings.includeTranscript}
            onChange={(v) => saveSettings({ includeTranscript: v })}
          />

          <Divider />
          <GroupLabel tint={EVIDENCE_TINT} text="Evidence · about the moment, not you" />
          <ProofToggle
            icon="camera-outline"
            label="Multiple lenses"
            sub="Two rear cameras shoot at once."
            tint={EVIDENCE_TINT}
            recommended
            value={settings.captureEvidence.altView}
            onChange={(v) => saveSettings({ captureEvidence: { ...settings.captureEvidence, altView: v } })}
          />
          <ProofToggle
            icon="copy-outline"
            label="Shutter burst"
            sub="Keeps the frames around the shutter."
            tint={EVIDENCE_TINT}
            value={settings.captureEvidence.ring}
            onChange={(v) => saveSettings({ captureEvidence: { ...settings.captureEvidence, ring: v } })}
          />
          <ProofToggle
            icon="mic-outline"
            label="Raw audio"
            sub="Uncompressed audio during video."
            tint={EVIDENCE_TINT}
            value={settings.captureEvidence.rawPcm}
            onChange={(v) => saveSettings({ captureEvidence: { ...settings.captureEvidence, rawPcm: v } })}
          />
          <ProofToggle
            icon="pulse-outline"
            label="Motion log"
            sub="Full-rate 100 Hz motion at the shutter."
            tint={EVIDENCE_TINT}
            recommended
            value={settings.includeSensors}
            onChange={(v) => saveSettings({ includeSensors: v })}
          />

          <Divider />
          <ProofToggle
            icon="scan-outline"
            label="Face check"
            sub="Face ID at capture. Only pass/fail is sealed."
            tint={FACE_CHECK_TINT}
            value={settings.faceCheckEnabled}
            onChange={handleFaceCheckToggle}
          />

          <Divider />
          <ProofToggle
            icon="logo-bitcoin"
            label="Public-ledger timestamp"
            tint={EVIDENCE_TINT}
            sub={
              'Independent Bitcoin-anchored timestamp. Only a hash leaves the phone, never the file. ' +
              'Usually confirmed a couple of hours after capture.'
            }
            value={settings.otsEnabled}
            onChange={(v) => saveSettings({ otsEnabled: v })}
          />
        </Card>

        {/* 5. Privacy & Security */}
        <SectionLabel text="Privacy & Security" />
        <Card>
          <View style={styles.rowBetween}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>App lock</Text>
              <Text style={styles.rowDetail}>
                {passcodeSet ? 'On · Source Kit locks on open.' : 'No passcode set.'}
              </Text>
            </View>
            {passcodeSet ? (
              <Button small tone="secondary" label="Remove" onPress={confirmRemovePasscode} />
            ) : (
              <Button small tone="secondary" label="Set passcode" onPress={() => router.push('/set-passcode')} />
            )}
          </View>
          {passcodeSet ? (
            <ToggleRow
              label="Unlock with Face ID"
              detail={biometricsAvailable ? 'Face ID can unlock the app instead of the passcode.' : 'Face ID is not set up on this device.'}
              value={settings.biometricsEnabled && biometricsAvailable}
              onChange={(v) => saveSettings({ biometricsEnabled: v })}
            />
          ) : null}
          <Divider />
          <ToggleRow
            label="Save to Photos"
            detail="Keeps an unsigned copy in your camera roll."
            value={settings.saveToCameraRoll}
            onChange={(v) => saveSettings({ saveToCameraRoll: v })}
          />
          <Divider />
          <Button tone="secondary" icon="trash-outline" label="Erase all Source Kit data" onPress={confirmEraseAll} />
        </Card>

        {/* 6. Appearance — the only purely cosmetic setting in the app.
            Three choices, same row language as the rest of the board. */}
        <SectionLabel text="Appearance" />
        <Card>
          <View style={styles.appearanceTrack}>
            {APPEARANCE_OPTIONS.map((opt) => {
              const selected = settings.appearance === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => void saveSettings({ appearance: opt.value })}
                  style={[styles.appearanceOption, selected && styles.appearanceOptionSelected]}
                  hitSlop={4}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <Text style={[styles.appearanceOptionText, selected && styles.appearanceOptionTextSelected]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Card>

        {/* 7. Diagnostics — what happened, newest first. Toasts fade in
            3 s; this log is the plain record of capture and seal events,
            error strings verbatim. */}
        <SectionLabel text="Diagnostics" />
        <Card>
          {/* 0.18.4-R3: a flipped switch persists across app updates (only
              deleting the app resets the suite) and silently changes the
              camera pipeline under test. The banner states WHICH switches
              differ from defaults and how to reset — facts only, no verdict. */}
          {nonDefaultFlags.length > 0 ? (
            <View style={styles.flagNotice}>
              <Ionicons name="information-circle-outline" size={18} color={colors.textDim} />
              <View style={{ flex: 1, gap: spacing.xs }}>
                <Text style={styles.rowDetail}>
                  {`Differs from defaults: ${nonDefaultFlags
                    .map((k) => `${DEBUG_FLAG_LABELS[k]} (${debugFlags?.[k] ? 'on' : 'off'})`)
                    .join(', ')}.`}
                </Text>
                <Text style={styles.rowDetail}>
                  Diagnostics switches persist across app updates. Deleting the app resets them to defaults.
                </Text>
              </View>
            </View>
          ) : null}
          {/* Camera diagnostics switches — persisted natively (UserDefaults
              suite "exhibit.debug"; the 12 MP clamp defaults ON as of
              0.17.2, the others default off). A flip takes effect at the
              NEXT configureSession: the session rebuilds only in the
              camera tab's focus effect (photo connections and policies are
              constructed at session build), so the running session is
              untouched. The footnote says exactly that. */}
          {/* 0.18.5: the rotation (wave 5) and legacy-graph switches are
              GONE — both hunts are settled (the four-run matrix exonerated
              every toggle; the virtual graph is the proven path). The
              native flags still exist for a future bisect, but a switch
              that no longer discriminates anything doesn't earn UI. */}
          <ToggleRow
            label="12 MP photo clamp"
            detail="Full-resolution photos capped at 12 MP. On by default; off reserves the full 48 MP photo stream on a live dual-camera graph, which costs the pipeline real bandwidth."
            value={debugFlags?.photoMaxDimensionsPolicy ?? true}
            onChange={(v) => handleDebugFlag('photoMaxDimensionsPolicy', v)}
          />
          <ToggleRow
            label="Session calibration photo"
            detail="Fires one photo per session to harvest full camera calibration (focal length, distortion). Off by default: a photo capture on a live graph is the maximum-resource moment. With it off, the calibration block states 'unavailable' instead."
            value={debugFlags?.sessionCalibrationPhoto ?? false}
            onChange={(v) => handleDebugFlag('sessionCalibrationPhoto', v)}
          />
          <Text style={styles.rowDetail}>
            Switches apply the next time the camera session rebuilds: leave and reopen the camera tab, or relaunch the app.
          </Text>
          <Divider />
          {diagnostics.length === 0 ? (
            <Text style={styles.rowDetail}>No events recorded.</Text>
          ) : (
            diagnostics.map((e, i) => (
              <View key={`${e.t}-${i}`} style={styles.diagRow}>
                <Mono size="xs" color={colors.text}>
                  {`${new Date(e.t).toLocaleString()} · ${e.kind} · ${e.outcome}`}
                </Mono>
                {e.message ? (
                  <Mono size="xs" color={colors.textDim} style={styles.diagMessage}>{e.message}</Mono>
                ) : null}
              </View>
            ))
          )}
          {diagnostics.length > 0 ? (
            <View style={styles.rowButtons}>
              <Button small tone="secondary" icon="trash-outline" label="Clear" onPress={clearDiagnostics} />
            </View>
          ) : null}
          <Text style={styles.rowDetail}>
            The last 30 capture and seal events on this device. Error strings are verbatim. Nothing here leaves the device.
          </Text>
        </Card>

        <Text style={styles.version}>Source Kit 0.18.5 · beta · on-device · no accounts</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * 0.18.4-R3 (external camera-pipeline review R1): the native defaults for
 * every debug flag, mirrored for the non-default banner. A flag flipped and
 * left in the exhibit.debug suite survives TestFlight updates — only
 * deleting the app resets it — so a stale A/B switch can silently
 * contaminate field runs. The banner names each differing switch.
 */
const DEBUG_FLAG_DEFAULTS: Record<ExhibitDebugFlagKey, boolean> = {
  photoConnectionRotation: false,
  photoMaxDimensionsPolicy: true,
  depthCapture: true,
  sessionCalibrationPhoto: false,
  thirdViewEnabled: false,
  legacyMultiInputGraph: false,
};

/** Display labels for the banner, matching the toggle rows where one exists. */
const DEBUG_FLAG_LABELS: Record<ExhibitDebugFlagKey, string> = {
  photoConnectionRotation: 'Photo-connection rotation',
  photoMaxDimensionsPolicy: '12 MP photo clamp',
  depthCapture: 'Depth capture',
  sessionCalibrationPhoto: 'Session calibration photo',
  thirdViewEnabled: 'Third view',
  legacyMultiInputGraph: 'Legacy dual-input graph',
};

// Toggle-board color language, paralleling the camera HUD icon palette
// (0.18.1): muted terracotta marks the identifying signals, sage green the
// evidence sinks, violet keeps the face check's own lane. No pure yellow,
// no blue — the same anchors the HUD uses.
const IDENTIFYING_TINT = '#C08552'; // warm clay / terracotta
const EVIDENCE_TINT = '#809263';    // sage green
const FACE_CHECK_TINT = '#AF52DE';

/** Appearance choices, in display order. 'device' is the default. */
const APPEARANCE_OPTIONS: { value: AppearancePreference; label: string }[] = [
  { value: 'device', label: 'Device' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

/** Group header inside the toggle card — a tint dot + quiet caps label. */
function GroupLabel({ text, tint }: { text: string; tint: string }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.groupLabelRow}>
      <View style={[styles.groupDot, { backgroundColor: tint }]} />
      <Text style={styles.groupLabel}>{text}</Text>
    </View>
  );
}

/** Toggle row — same icon+label language as the HUD and grid badges.
 *  0.18.2: subs are NEVER truncated (field report: ellipsized copy reads as
 *  a bug). Every sub reserves two lines (proofSubMin) so rows are evenly
 *  spaced whether the copy runs one line or two. */
function ProofToggle({ icon, label, sub, value, onChange, tint, disabled, recommended }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  sub: string;
  value: boolean;
  onChange: (v: boolean) => void;
  tint?: string;
  disabled?: boolean;
  recommended?: boolean;
}) {
  const styles = useThemedStyles(buildStyles);
  const active = tint ?? colors.accent;
  return (
    <View style={[styles.proofRow, disabled && { opacity: 0.55 }]}>
      <Ionicons name={icon} size={20} color={value ? active : colors.textFaint} />
      <View style={styles.proofRowText}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Text style={styles.rowTitle}>{label}</Text>
          {recommended ? (
            <View style={styles.recTag}>
              <Text style={styles.recTagText}>Recommended</Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.rowDetail, styles.proofSubMin]}>{sub}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: colors.border, true: active }}
        thumbColor={colors.text}
      />
    </View>
  );
}

const buildStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  recTag: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  recTagText: { color: colors.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.3 },
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl },
  betaCard: { backgroundColor: colors.surface2 },
  flagNotice: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.surface2,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  betaRow: { flexDirection: 'row', gap: spacing.sm },
  betaLead: { color: colors.text, fontSize: fontSize.sm, lineHeight: 20, fontWeight: '800', letterSpacing: 0.3 },
  betaEm: { fontStyle: 'italic', fontWeight: '700' },
  betaText: { color: colors.text, fontSize: fontSize.sm, lineHeight: 20, fontWeight: '400' },
  feedbackLink: { color: colors.accent, fontSize: fontSize.sm, fontWeight: '700', marginTop: 2 },
  rowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600', letterSpacing: 0.2 },
  rowDetail: { color: colors.textDim, fontSize: fontSize.xs, marginTop: 4, lineHeight: 17 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  attestBlock: { marginTop: spacing.md },
  attestRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  attestValue: { color: colors.accent, fontSize: fontSize.sm, fontWeight: '600' },
  registryToggle: { color: colors.textDim, fontSize: fontSize.xs, fontWeight: '600', marginTop: spacing.sm },
  attestPanel: { marginTop: spacing.sm },
  rowButtons: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.sm },
  deviceLine: { color: colors.textFaint, fontSize: fontSize.xs, marginTop: spacing.md, marginBottom: spacing.xs },
  aliasHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  optionalTag: {
    backgroundColor: colors.accentSoft,
    borderRadius: radii.full,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  optionalTagText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 0.4 },
  proofRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, paddingVertical: spacing.sm },
  // Two lines of rowDetail (lineHeight 17) — reserved on every toggle sub
  // so one-line and two-line rows land at the same height.
  proofSubMin: { minHeight: 34 },
  groupLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, marginBottom: 2 },
  groupDot: { width: 6, height: 6, borderRadius: 3 },
  groupLabel: { color: colors.textFaint, fontSize: 10, fontWeight: '800', letterSpacing: 1.4, textTransform: 'uppercase' },
  // Appearance selector — one inset track, three pills; the selected pill
  // lifts to the card surface (the segmented-control register, no new
  // component for a single row).
  appearanceTrack: {
    flexDirection: 'row',
    backgroundColor: colors.surface2,
    borderRadius: radii.full,
    padding: 3,
    gap: 4,
    marginBottom: spacing.sm,
  },
  appearanceOption: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: radii.full,
  },
  appearanceOptionSelected: { backgroundColor: colors.surface },
  appearanceOptionText: { color: colors.textDim, fontSize: fontSize.sm, fontWeight: '600', letterSpacing: 0.2 },
  appearanceOptionTextSelected: { color: colors.text },
  proofRowText: { flex: 1 },
  piiCallout: { color: colors.warn, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.sm },
  fpGrouped: { marginTop: 2, lineHeight: 18 },
  fingerprintBox: {
    backgroundColor: colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    color: colors.text,
    fontSize: fontSize.md,
    marginTop: spacing.sm,
  },
  diagRow: {
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSoft,
    gap: 2,
  },
  diagMessage: { lineHeight: 15 },
  version: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
});
