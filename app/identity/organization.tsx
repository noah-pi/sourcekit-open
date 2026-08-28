// Source Kit 0.1.0 — an organization certifies this device's key
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Organization Credential — an employer certifies the key this phone
 * already holds.
 *
 * Two halves, in the order they are used: send the public key out, then
 * collect the certificate that comes back, either from the organization's
 * own domain over TLS (sourcekit-org/1) or from a file. The private key
 * never leaves the Secure Enclave, so the organization never holds anything
 * that could sign as the person carrying the phone.
 */

import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import { colors, spacing, radii, fontSize, useThemedStyles } from '../../src/theme';
import { SubScreen, RowDetail } from '../../src/components/SubScreen';
import { Card, SectionLabel, Button, KeyValueRow, Chip, Divider } from '../../src/components/ui';
import { base64ToBytes } from '../../src/lib/bytes';
import { getDeviceKey } from '../../src/lib/deviceKey';
import {
  clearOrgCredential,
  getOrgCredential,
  orgCertChainForKey,
  pemOrDerToDer,
  setOrgCredential,
  type OrgCredential,
} from '../../src/lib/orgCert';
import { fetchOrgCredentialFromDomain } from '../../src/lib/orgDirectory';

export default function OrganizationScreen() {
  const styles = useThemedStyles(buildStyles);
  const [cred, setCred] = useState<OrgCredential | null>(null);
  const [stale, setStale] = useState(false);
  const [fingerprint, setFingerprint] = useState('');
  const [domainDraft, setDomainDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        const key = await getDeviceKey();
        const stored = await getOrgCredential();
        const chain = await orgCertChainForKey(base64ToBytes(key.publicKeyBase64));
        if (!alive) return;
        setFingerprint(key.fingerprint);
        setCred(stored);
        setStale(chain === 'stale');
        if (stored?.sourceDomain) setDomainDraft(stored.sourceDomain);
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  const shareKey = async () => {
    const key = await getDeviceKey();
    await Clipboard.setStringAsync(
      JSON.stringify({ fingerprint: key.fingerprint, publicKeyBase64: key.publicKeyBase64 }, null, 2),
    );
    Alert.alert('Key copied', 'Send it to whoever handles credentials. It is the public half, and it is safe to email.');
  };

  const fetchFromDomain = async () => {
    setBusy(true);
    try {
      const c = await fetchOrgCredentialFromDomain(domainDraft);
      setCred(c);
      setStale(false);
      Alert.alert(
        'Credential active',
        `Issued for this device by ${c.info.issuerOrg ?? c.info.issuerCN ?? 'your organization'}. New captures chain into the organization's CA.`,
      );
    } catch (e) {
      Alert.alert('Could not fetch', e instanceof Error ? e.message : 'That domain did not provide a credential for this device.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * The picker filters to JSON — the org-issued credential file carrying the
   * X.509 chain: { "leafDerBase64": "…", "caDerBase64": "…" }. PEM-armored
   * strings under the same keys are accepted. The file vouches for the public
   * key only; there is no path here that accepts a private one.
   */
  const importFile = async () => {
    setBusy(true);
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
        throw new Error('No device certificate in that file. Expected the credential JSON your organization sent, carrying the X.509 chain.');
      }
      const caS = pick('caDerBase64', 'caBase64', 'ca');
      const key = await getDeviceKey();
      const c = await setOrgCredential(decode(leafS), caS ? decode(caS) : null, base64ToBytes(key.publicKeyBase64));
      setCred(c);
      setStale(false);
      Alert.alert('Credential active', "New captures chain into your organization's CA.");
    } catch (e) {
      Alert.alert('Import failed', e instanceof Error ? e.message : 'Could not read that credential file.');
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    Alert.alert('Remove organization credential?', 'New captures stop chaining into the organization. Past captures keep their signed chain.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            await clearOrgCredential();
            setCred(null);
            setStale(false);
          })(),
      },
    ]);
  };

  const orgName = cred?.info.subjectOrg ?? cred?.info.subjectCN ?? cred?.info.issuerOrg ?? 'Organization';

  return (
    <SubScreen title="Organization Credential">
      <Card>
        <RowDetail>
          Your organization issues a certificate for the key already in this iPhone. The key never
          leaves the Secure Enclave, and the organization can withdraw the certificate later without
          touching your phone.
        </RowDetail>
      </Card>

      <SectionLabel text="Your key" />
      <Card>
        <KeyValueRow label="Fingerprint" value={fingerprint || '—'} mono />
        <View style={styles.buttons}>
          <Button small tone="secondary" icon="share-outline" label="Share key" onPress={() => void shareKey()} />
        </View>
        <RowDetail>Send this to whoever handles credentials. It is the public half, and it is safe to email.</RowDetail>
      </Card>

      <SectionLabel text="Organization domain" />
      <Card>
        <TextInput
          style={styles.input}
          placeholder="example-news.com"
          placeholderTextColor={colors.textFaint}
          value={domainDraft}
          onChangeText={setDomainDraft}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <View style={styles.buttons}>
          <Button small tone="secondary" icon="globe-outline" label={busy ? 'Working…' : 'Fetch credential'} onPress={() => void fetchFromDomain()} disabled={busy} />
          <Button small tone="ghost" icon="document-outline" label="Import file instead" onPress={() => void importFile()} disabled={busy} />
        </View>
        <RowDetail>
          Collected over TLS from the organization&rsquo;s own website, or imported from a file they
          send you. Either way the certificate must name this device&rsquo;s key, be in date, and be
          signed by the organization&rsquo;s CA.
        </RowDetail>
      </Card>

      {cred ? (
        <>
          <SectionLabel text="Installed" />
          <Card>
            <View style={styles.headRow}>
              <Text style={styles.rowTitle}>{orgName}</Text>
              <Chip label={stale ? 'Unused' : 'Installed'} tone={stale ? 'warn' : 'good'} />
            </View>
            <KeyValueRow label="Issued by" value={cred.info.issuerOrg ?? cred.info.issuerCN ?? '—'} />
            <KeyValueRow label="Expires" value={new Date(cred.info.notAfter).toLocaleDateString()} />
            {cred.sourceDomain ? <KeyValueRow label="Installed from" value={`${cred.sourceDomain} · over TLS`} /> : null}
            {stale ? (
              <RowDetail>Predates the current signing key, so it goes unused. Ask for a new one issued to the key above.</RowDetail>
            ) : null}
            <Divider />
            <RowDetail>
              Whether a recipient sees this as verified depends on the lists their tool carries.
              Organizations on no public list still work: the name appears, marked self-asserted.
            </RowDetail>
            <View style={styles.buttons}>
              <Button small tone="secondary" label="Remove" onPress={remove} />
            </View>
          </Card>
        </>
      ) : null}
    </SubScreen>
  );
}

const buildStyles = () =>
  StyleSheet.create({
    input: {
      backgroundColor: colors.surface2,
      borderRadius: radii.sm,
      paddingHorizontal: spacing.sm + 4,
      paddingVertical: spacing.sm + 2,
      color: colors.text,
      fontSize: fontSize.md,
    },
    buttons: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
    rowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
    headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  });
