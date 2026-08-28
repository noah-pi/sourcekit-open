// Source Kit 0.1.0 — a certificate authority certifies a person
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Verified Identity — an authority checks a person's ID and certifies the
 * key this phone already holds.
 *
 * The request is built here and signed by the Enclave key itself, which is
 * how a certification request proves it controls the key it names. Nothing
 * exportable leaves the device, so the whole exchange is one block of text
 * out and one certificate back.
 */

import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { colors, spacing, radii, fontSize, useThemedStyles } from '../../src/theme';
import { SubScreen, RowDetail } from '../../src/components/SubScreen';
import { Card, SectionLabel, Button, KeyValueRow, Chip, Divider } from '../../src/components/ui';
import { base64ToBytes } from '../../src/lib/bytes';
import { buildCsr, csrToPem } from '../../src/lib/cert';
import { getDeviceKey } from '../../src/lib/deviceKey';
import { pemOrDerToDer } from '../../src/lib/orgCert';
import {
  clearPersonalCredential,
  getPersonalCredential,
  issuerLabel,
  refreshPersonalTrust,
  setPersonalCredential,
  type PersonalCredential,
} from '../../src/lib/personalCert';
import { identityAnchorState, refreshIdentityAnchors, type AnchorListState } from '../../src/lib/identityTrustList';

export default function VerifiedIdentityScreen() {
  const styles = useThemedStyles(buildStyles);
  const [cred, setCred] = useState<PersonalCredential | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [emailDraft, setEmailDraft] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [anchors, setAnchors] = useState<AnchorListState[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [key, stored, lists] = await Promise.all([getDeviceKey(), getPersonalCredential(), identityAnchorState()]);
    setFingerprint(key.fingerprint);
    setCred(stored);
    setAnchors(lists);
    if (stored?.info.subjectCN) setNameDraft(stored.info.subjectCN);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const makeRequest = async () => {
    setBusy(true);
    try {
      const name = nameDraft.trim();
      if (!name) throw new Error('Enter the name the certificate should carry.');
      const key = await getDeviceKey();
      const pem = csrToPem(
        await buildCsr(base64ToBytes(key.publicKeyBase64), key.signDigest, {
          commonName: name,
          email: emailDraft.trim() || null,
        }),
      );
      await Clipboard.setStringAsync(pem);
      const path = `${FileSystem.cacheDirectory}signing-request.pem`;
      await FileSystem.writeAsStringAsync(path, pem);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, { mimeType: 'application/x-pem-file', dialogTitle: 'Signing request' });
      }
      Alert.alert(
        'Request copied',
        'Send it to a certificate authority and ask for a personal S/MIME certificate with individual validation. They check your ID and send a certificate back.',
      );
    } catch (e) {
      Alert.alert('Could not build the request', e instanceof Error ? e.message : 'Check the name and try again.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Accepts what an authority actually sends: a PEM certificate, or a bundle
   * with the issuing CA after it. The second certificate in the file is
   * treated as the issuer, which is the order every authority ships.
   */
  const importCert = async () => {
    setBusy(true);
    try {
      const doc = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (doc.canceled || !doc.assets?.[0]) return;
      const text = await FileSystem.readAsStringAsync(doc.assets[0].uri);
      const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
      if (!blocks || blocks.length === 0) {
        throw new Error('No certificate in that file. Save what the authority sent as a .pem or .crt and try again.');
      }
      const key = await getDeviceKey();
      const c = await setPersonalCredential(
        pemOrDerToDer(blocks[0]),
        blocks[1] ? pemOrDerToDer(blocks[1]) : null,
        base64ToBytes(key.publicKeyBase64),
      );
      setCred(c);
      Alert.alert(
        c.trust.level === 'trusted' ? 'Certificate installed' : 'Certificate installed, not recognized here',
        c.trust.level === 'trusted' ? `Recognized by ${c.trust.recognizedBy}.` : c.trust.reason,
      );
    } catch (e) {
      Alert.alert('Import failed', e instanceof Error ? e.message : 'Could not read that certificate.');
    } finally {
      setBusy(false);
    }
  };

  const updateLists = async () => {
    setBusy(true);
    try {
      const state = await refreshIdentityAnchors();
      await refreshPersonalTrust();
      await reload();
      Alert.alert('Lists updated', `${state.list.name}: ${state.count} anchors.`);
    } catch (e) {
      Alert.alert('Could not update', e instanceof Error ? e.message : 'The list did not answer.');
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    Alert.alert('Remove this certificate?', 'New captures stop carrying your certified name. Past captures keep their signed chain.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            await clearPersonalCredential();
            setCred(null);
          })(),
      },
    ]);
  };

  return (
    <SubScreen title="Verified Identity">
      <Card>
        <RowDetail>
          A certificate authority checks your ID and issues a certificate in your legal name. Other
          verification tools read it as a CAWG identity and show it as verified rather than
          self-declared. The certificate is issued to you, not to this app, and keeps working
          anywhere you can use it.
        </RowDetail>
      </Card>

      <SectionLabel text="Signing request" />
      <Card>
        <TextInput
          style={styles.input}
          placeholder="Name for the certificate"
          placeholderTextColor={colors.textFaint}
          value={nameDraft}
          onChangeText={setNameDraft}
          autoCapitalize="words"
        />
        <TextInput
          style={styles.input}
          placeholder="Email the authority will check"
          placeholderTextColor={colors.textFaint}
          value={emailDraft}
          onChangeText={setEmailDraft}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
        <KeyValueRow label="Key" value={fingerprint || '—'} mono />
        <View style={styles.buttons}>
          <Button small tone="secondary" icon="create-outline" label={busy ? 'Working…' : 'Build request'} onPress={() => void makeRequest()} disabled={busy} />
          <Button small tone="ghost" icon="download-outline" label="Import certificate" onPress={() => void importCert()} disabled={busy} />
        </View>
        <RowDetail>
          The request is signed by the key it names, which is how it proves this iPhone holds that
          key. The private half stays in the Secure Enclave.
        </RowDetail>
      </Card>

      {cred ? (
        <>
          <SectionLabel text="Installed" />
          <Card>
            <View style={styles.headRow}>
              <Text style={styles.rowTitle}>{cred.info.subjectCN ?? cred.info.subjectOrg ?? 'Certificate'}</Text>
              <Chip
                label={cred.trust.level === 'trusted' ? 'Trusted' : 'Self-asserted'}
                tone={cred.trust.level === 'trusted' ? 'good' : 'neutral'}
              />
            </View>
            <KeyValueRow label="Issued by" value={issuerLabel(cred.info)} />
            <KeyValueRow label="Expires" value={new Date(cred.info.notAfter).toLocaleDateString()} />
            <Divider />
            <RowDetail>
              {cred.trust.level === 'trusted' ? `Recognized by ${cred.trust.recognizedBy}.` : cred.trust.reason}
            </RowDetail>
            <View style={styles.buttons}>
              <Button small tone="secondary" label="Remove" onPress={remove} />
            </View>
          </Card>
        </>
      ) : null}

      <SectionLabel text="Lists this device carries" />
      <Card>
        {anchors.map((a) => (
          <KeyValueRow
            key={a.list.id}
            label={a.list.name}
            value={a.fetchedAt ? `${a.count} anchors · ${new Date(a.fetchedAt).toLocaleDateString()}` : 'Not downloaded'}
          />
        ))}
        <View style={styles.buttons}>
          <Button small tone="secondary" icon="refresh-outline" label={busy ? 'Working…' : 'Update lists'} onPress={() => void updateLists()} disabled={busy} />
        </View>
        <RowDetail>
          These decide what this device calls Trusted. A recipient&rsquo;s tool carries its own, so a
          certificate unrecognized here can still be recognized there.
        </RowDetail>
      </Card>
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
    rowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600', flex: 1 },
    headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  });
