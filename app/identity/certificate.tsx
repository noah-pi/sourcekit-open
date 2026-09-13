// Source Kit 0.1.0 — identity via a certificate authority
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Identity via certificate authority — a certificate that names a person or
 * a masthead, issued for the key this phone already holds.
 *
 * Two issuers, one mechanism. A public authority checks a person's ID; an
 * organization vouches for its own staff. Either way the certificate is made
 * FOR THIS KEY, which is why the request comes first and why nothing can be
 * imported before the phone has produced one. The private half never leaves
 * the Secure Enclave, so an issuer never holds anything that could sign.
 */

import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Alert, Linking, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { colors, spacing, radii, fontSize, useThemedStyles } from '../../src/theme';
import { SubScreen, RowDetail, Step, KeyBox } from '../../src/components/SubScreen';
import { Card, SectionLabel, Button, KeyValueRow, Chip, Divider } from '../../src/components/ui';
import { base64ToBytes } from '../../src/lib/bytes';
import { buildCsr, csrToPem } from '../../src/lib/cert';
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
import {
  clearPersonalCredential,
  getPersonalCredential,
  issuerLabel,
  refreshPersonalTrust,
  setPersonalCredential,
  type PersonalCredential,
} from '../../src/lib/personalCert';
import { ensureIdentityAnchors, identityAnchorState, refreshIdentityAnchors, type AnchorListState } from '../../src/lib/identityTrustList';

/** The Creator Assertions Working Group, which defines the identity
 *  assertion these certificates are read through. It is where someone who
 *  has not met any of this starts. */
const CAWG_URL = 'https://cawg.io/';

export default function CertificateScreen() {
  const styles = useThemedStyles(buildStyles);
  const [cred, setCred] = useState<PersonalCredential | null>(null);
  const [orgCred, setOrgCred] = useState<OrgCredential | null>(null);
  const [orgStale, setOrgStale] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [emailDraft, setEmailDraft] = useState('');
  const [domainDraft, setDomainDraft] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [anchors, setAnchors] = useState<AnchorListState[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const key = await getDeviceKey();
    const [stored, org, chain, lists] = await Promise.all([
      getPersonalCredential(),
      getOrgCredential(),
      orgCertChainForKey(base64ToBytes(key.publicKeyBase64)),
      identityAnchorState(),
    ]);
    setFingerprint(key.fingerprint);
    setCred(stored);
    setOrgCred(org);
    setOrgStale(chain === 'stale');
    setAnchors(lists);
    if (stored?.info.subjectCN) setNameDraft(stored.info.subjectCN);
    if (org?.sourceDomain) setDomainDraft(org.sourceDomain);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        await reload();
        // The lists decide what this screen can call Trusted, so they are
        // brought up to date on the one screen where that matters.
        setAnchors(await ensureIdentityAnchors());
        await refreshPersonalTrust();
        await reload();
      })();
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
      await ensureIdentityAnchors();
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

  /* Kept for the one case a person can act on: an import that could not be
     placed. Not shown as a row — the lists refresh themselves on open. */
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

  const removePersonal = () => {
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
      setOrgCred(c);
      setOrgStale(false);
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
      setOrgCred(c);
      setOrgStale(false);
      Alert.alert('Credential active', "New captures chain into your organization's CA.");
    } catch (e) {
      Alert.alert('Import failed', e instanceof Error ? e.message : 'Could not read that credential file.');
    } finally {
      setBusy(false);
    }
  };

  const removeOrg = () => {
    Alert.alert('Remove organization credential?', 'New captures stop chaining into the organization. Past captures keep their signed chain.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            await clearOrgCredential();
            setOrgCred(null);
            setOrgStale(false);
          })(),
      },
    ]);
  };

  const orgName = orgCred?.info.subjectOrg ?? orgCred?.info.subjectCN ?? orgCred?.info.issuerOrg ?? 'Organization';

  return (
    <SubScreen title="Identity via certificate authority">
      <Card>
        <RowDetail>
          Add a certificate that names you. Certificate authorities and organizations both issue
          them.
        </RowDetail>
      </Card>

      <SectionLabel text="How to get one" />
      <Card style={styles.steps}>
        <Step n={1}>
          Build a request. It names this iPhone&rsquo;s key, and only a certificate made for that key
          will work.
        </Step>
        <Step n={2}>
          Send it to a certificate authority, or to whoever handles credentials at your
          organization.{' '}
          <Text style={styles.link} onPress={() => void Linking.openURL(CAWG_URL)}>
            New to this? Start with CAWG →
          </Text>
        </Step>
        <Step n={3}>Import what they send back.</Step>
      </Card>

      <SectionLabel text="Your key" />
      <Card>
        <KeyBox value={fingerprint} />
        <View style={styles.buttons}>
          <Button small tone="secondary" icon="share-outline" label="Share key" onPress={() => void shareKey()} />
        </View>
        <RowDetail>The public half. It is safe to email.</RowDetail>
      </Card>

      <SectionLabel text="From a certificate authority" />
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
        <View style={styles.buttons}>
          <Button small tone="secondary" icon="create-outline" label={busy ? 'Working…' : 'Build request'} onPress={() => void makeRequest()} disabled={busy} />
          <Button small tone="ghost" icon="download-outline" label="Import certificate" onPress={() => void importCert()} disabled={busy} />
        </View>
      </Card>

      {cred ? (
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
            <Button small tone="secondary" label="Remove" onPress={removePersonal} />
          </View>
        </Card>
      ) : null}

      <SectionLabel text="From your organization" />
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
          <Button small tone="ghost" icon="document-outline" label="Import file" onPress={() => void importFile()} disabled={busy} />
        </View>
        <RowDetail>
          Collected over TLS from your organization&rsquo;s own website, or imported from a file they
          send you. They can withdraw the certificate later without touching your phone.
        </RowDetail>
      </Card>

      {orgCred ? (
        <Card>
          <View style={styles.headRow}>
            <Text style={styles.rowTitle}>{orgName}</Text>
            <Chip label={orgStale ? 'Unused' : 'Active'} tone={orgStale ? 'warn' : 'good'} />
          </View>
          <KeyValueRow label="Issued by" value={orgCred.info.issuerOrg ?? orgCred.info.issuerCN ?? '—'} />
          <KeyValueRow label="Expires" value={new Date(orgCred.info.notAfter).toLocaleDateString()} />
          <Divider />
          <RowDetail>
            {orgStale
              ? 'This credential names a key this phone no longer uses. New captures ignore it.'
              : "New captures chain into the organization's authority."}
          </RowDetail>
          <View style={styles.buttons}>
            <Button small tone="secondary" label="Remove" onPress={removeOrg} />
          </View>
        </Card>
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
      marginBottom: spacing.sm,
    },
    buttons: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.sm, marginBottom: spacing.sm },
    steps: { gap: spacing.sm },
    link: { color: colors.accent, fontWeight: '600' },
    rowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600', flex: 1 },
    headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  });
