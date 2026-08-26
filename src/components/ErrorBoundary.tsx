// Source Kit 0.1.0 — Catches a render throw and offers a way
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Catches a render throw and offers a way back instead of a blank screen.
 *
 * Deliberately dependency-free: no theme hook, no store, no filesystem. A
 * boundary that can itself throw is worse than none, so it reads `colors`
 * directly and renders inline styles.
 *
 * React only routes render, lifecycle, and constructor errors here. Throws
 * inside event handlers, timers, and promise rejections are unaffected.
 */
import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { colors } from '../theme';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: 'center' }}>
        <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 12 }}>
          This screen stopped
        </Text>
        <Text style={{ color: colors.textDim, fontSize: 15, lineHeight: 21, marginBottom: 16 }}>
          Your captures and sealed exhibits are on disk and untouched. Nothing was
          lost by this.
        </Text>
        {/* The message verbatim: a paraphrase makes a bug report useless. */}
        <ScrollView style={{ maxHeight: 180, marginBottom: 24 }}>
          <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: 'Courier' }}>
            {error.message || String(error)}
          </Text>
        </ScrollView>
        <Pressable
          onPress={this.reset}
          style={{
            backgroundColor: colors.accent,
            paddingVertical: 14,
            borderRadius: 12,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: colors.onAccent, fontSize: 16, fontWeight: '600' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}
