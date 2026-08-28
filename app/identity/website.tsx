// Source Kit 0.1.0 — connect a website you control
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Website — the certificate-free identity. Type a domain, publish one file,
 * test that it went live.
 *
 * The file is the whole mechanism, so the screen says what it is before it
 * says what to do with it: the folder is a standard place, the contents are
 * public, and nothing a visitor sees changes.
 */

import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { colors, spacing, radii, fontSize, useThemedStyles } from '../../src/theme';
import { SubScreen, RowDetail } from '../../src/components/SubScreen';
import { Card, SectionLabel, Button, KeyValueRow, Chip, Divider, Mono } from '../../src/components/ui';
import {
  SITE_WELL_KNOWN_PATH,
  clearSiteCredential,
  connectSite,
  fetchSiteDocument,
  getSiteCredential,
  normalizeSiteDomain,
  serializeSiteDocument,
  siteDocumentForThisDevice,
  type SiteCredential,
  type SiteDocument,
} from '../../src/lib/siteCredential';

export default function WebsiteScreen() {
  const styles = useThemedStyles(buildStyles);
  const [cred, setCred] = useState<SiteCredential | null>(null);
  const [domainDraft, setDomainDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        const c = await getSiteCredential();
        if (!alive) return;
        setCred(c);
        if (c) {
          setDomainDraft(c.domain);
          setNameDraft(c.organization);
        }
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  /**
   * Writes the file to publish. A document already live at the domain is
   * read first and this device is added to it, so generating a file for a
   * second phone never drops the first.
   */
  const generate = async () => {
    setBusy(true);
    try {
      const domain = normalizeSiteDomain(domainDraft);
      const name = nameDraft.trim() || domain;
      let existing: SiteDocument | null = null;
      try {
        existing = await fetchSiteDocument(domain);
      } catch {
        // Nothing published yet, or unreachable. Either way this is the
        // first file for that domain and starting a new list is correct.
      }
      const doc = await siteDocumentForThisDevice(name, 'This iPhone', existing);
      const path = `${FileSystem.cacheDirectory}sourcekit-site.json`;
      await FileSystem.writeAsStringAsync(path, serializeSiteDocument(doc));
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, {
          mimeType: 'application/json',
          dialogTitle: 'sourcekit-site.json',
        });
      }
      Alert.alert(
        'File ready',
        `Upload it to ${domain}${SITE_WELL_KNOWN_PATH} — the .well-known folder goes at the top level of the site, next to the home page. Then come back and tap Test.`,
      );
    } catch (e) {
      Alert.alert('Could not build the file', e instanceof Error ? e.message : 'Check the website address.');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const c = await connectSite(domainDraft);
      setCred(c);
      setNameDraft(c.organization);
      Alert.alert('Connected', `${c.domain} publishes this iPhone's key. Captures can now carry that address.`);
    } catch (e) {
      Alert.alert('Not connected', e instanceof Error ? e.message : 'The website did not answer.');
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    Alert.alert('Disconnect this website?', 'New captures stop carrying the address. Past captures keep what they were signed with, and the file stays on your site until you delete it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            await clearSiteCredential();
            setCred(null);
          })(),
      },
    ]);
  };

  return (
    <SubScreen title="Website">
      <Card>
        <RowDetail>
          Publishing one file lets anyone match a photo&rsquo;s signature to your address. It replaces
          nothing on your site and shows up nowhere a visitor would look. Several devices can connect
          to the same website.
        </RowDetail>
      </Card>

      <SectionLabel text="Your website" />
      <Card>
        <TextInput
          style={styles.input}
          placeholder="beckysbakery.com"
          placeholderTextColor={colors.textFaint}
          value={domainDraft}
          onChangeText={setDomainDraft}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <TextInput
          style={styles.input}
          placeholder="Name to show (optional)"
          placeholderTextColor={colors.textFaint}
          value={nameDraft}
          onChangeText={setNameDraft}
          autoCapitalize="words"
        />
        <View style={styles.buttons}>
          <Button small tone="secondary" icon="document-outline" label={busy ? 'Working…' : 'Save file'} onPress={() => void generate()} disabled={busy} />
          <Button small tone="ghost" icon="globe-outline" label="Test" onPress={() => void test()} disabled={busy} />
        </View>
        <RowDetail>Fetched over HTTPS, the same way a verifier will. The certificate already on your website is what ties the file to you.</RowDetail>
      </Card>

      <SectionLabel text="What you are adding" />
      <Card>
        <Text style={styles.rowTitle}>A folder called .well-known</Text>
        <RowDetail>
          A standard place websites keep small files for other software to read. Yours lists which
          phones may sign as you, and holds their public keys. Nothing private goes in it.
        </RowDetail>
        <Mono size="sm">{`https://<your site>${SITE_WELL_KNOWN_PATH}`}</Mono>
      </Card>

      {cred ? (
        <>
          <SectionLabel text="Connected" />
          <Card>
            <View style={styles.headRow}>
              <Text style={styles.rowTitle}>{cred.organization}</Text>
              <Chip label="Self-asserted" tone="neutral" />
            </View>
            <KeyValueRow label="Website" value={cred.domain} />
            <KeyValueRow label="Devices listed" value={String(cred.memberCount)} />
            <KeyValueRow label="Last tested" value={new Date(cred.verifiedAt).toLocaleString()} />
            <Divider />
            <RowDetail>
              A website shows control of the address. It is not an identity check the way a
              certificate is, so recipients see the address and no claim beyond it.
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
