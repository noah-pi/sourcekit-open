// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Error boundary — one bad file must never white-screen the tab.
 *
 * The fallback says what happened in plain language and offers the two
 * honest exits: reload for a fresh start, or try to keep going (the rest of
 * the workspace state is untouched either way). No verdict vocabulary — a
 * broken viewer says nothing about the file's evidence.
 */
import React from 'react';

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

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Logged locally for debugging; nothing leaves this tab.
    console.error('Source Kit Desk — render failure contained by the error boundary:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 620, margin: '80px auto', padding: '0 24px', fontFamily: 'inherit' }}>
          <div className="card">
            <h2>Something broke the viewer</h2>
            <p style={{ fontSize: 14.5 }}>
              Something in this file broke the viewer — your other exhibits are unaffected.
              Reload to start fresh.
            </p>
            <p className="honest-note">
              A crash here is a Source Kit Desk bug to report, not a finding about your file —
              the viewer failing says nothing about the evidence.
            </p>
            <div className="btn-row">
              <button className="btn" onClick={() => window.location.reload()}>
                Reload this tab
              </button>
              <button className="btn secondary" onClick={() => this.setState({ error: null })}>
                Try to continue without reloading
              </button>
            </div>
            <p className="field-note mono" style={{ marginTop: 12 }}>
              {this.state.error.message}
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
