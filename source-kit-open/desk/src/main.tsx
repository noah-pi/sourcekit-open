// Written with AI assistance. Verification: docs/PROVENANCE.md.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* One bad file must never white-screen the tab — the boundary says so
        in plain language and offers a fresh start. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
