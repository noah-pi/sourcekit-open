// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * InspectGuide — the FAQ at the bottom of the Inspect tab.
 *
 * Truly an FAQ: every question sits behind its own dropdown, answers are the
 * approved plain declarative facts. No question is answered before it's asked.
 *
 * Closing line, always: custody, not reality — this app proves the file's
 * history; what the file shows is for the viewer to weigh.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, useThemedStyles } from '../theme';
import { Card, SectionLabel } from './ui';

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Why does this file have no seal?',
    a: 'Most photos don’t have one, and messaging apps strip the ones that do. Ask for the file straight off the camera or phone: AirDrop, email, or a file transfer.',
  },
  {
    q: 'What does a green verdict mean?',
    a: 'The bytes match the seal, the signature is valid, and a certificate authority vouches for the signing key. Nothing about the file has changed since it was sealed.',
  },
  {
    q: 'Why is a valid seal sometimes amber?',
    a: 'The seal holds, but nothing outside the file vouches for the signer. A signer can claim any name, so an unknown key shows amber, never green. If an organization signed it, ask them for their fingerprint directly and compare all 64 characters.',
  },
  {
    q: 'What if the file was edited after sealing?',
    a: 'The seal and the file no longer match, and the verdict says so. Keep the file; don’t re-save or re-share it.',
  },
  {
    q: 'What does the hardware check mean?',
    a: 'On an iPhone, the signing key lives in Apple’s secure hardware, and App Attest vouches for it. Other devices and apps seal with their own hardware checks; this build reads App Attest only.',
  },
  {
    q: 'Can a seal be faked?',
    a: 'A seal is a signature; forging one means forging a private key that never leaves the phone’s secure hardware. What a signature can’t vouch for is everything around it: a signer can claim any name, and time, place and motion are the phone’s own reports. Each is labelled as such, in place.',
  },
  {
    q: 'Why was a check skipped?',
    a: 'A check that can’t run says so, in place. Location off at the shutter means no sun position. Nothing is hidden by an empty space.',
  },
  {
    q: 'What leaves the phone?',
    a: 'Only what you share, plus an anonymous hash if the public-ledger timestamp is on. Inspection happens on the device holding the file.',
  },
];

function FaqRow({ q, a, last }: { q: string; a: string; last: boolean }) {
  const styles = useThemedStyles(buildStyles);
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={styles.qRow}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.qText}>{q}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textFaint} />
      </Pressable>
      {open ? <Text style={styles.aText}>{a}</Text> : null}
      {!last ? <View style={styles.rule} /> : null}
    </View>
  );
}

export function InspectGuide() {
  const styles = useThemedStyles(buildStyles);
  return (
    <View>
      <SectionLabel text="FAQ" />
      <Card>
        {FAQ.map((item, i) => (
          <FaqRow key={item.q} q={item.q} a={item.a} last={i === FAQ.length - 1} />
        ))}
      </Card>
      <Text style={styles.closing}>
        Custody, not reality: this app proves the file’s history. What the file shows is for you to weigh.
      </Text>
    </View>
  );
}

const buildStyles = () => StyleSheet.create({
  qRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  qText: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700', flex: 1 },
  aText: {
    color: colors.textDim,
    fontSize: fontSize.sm,
    lineHeight: 20,
    paddingBottom: spacing.sm,
  },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  closing: {
    color: colors.textDim,
    fontSize: fontSize.xs,
    lineHeight: 17,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
});
