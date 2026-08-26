// Source Kit 0.1.0 — the app entry point
// Written with AI assistance. Verification: docs/PROVENANCE.md.
// Entry point. The CSPRNG polyfill must be installed before any module that
// could invoke noble crypto at import time; require() (not import) for the
// router entry guarantees that order.
import { ensureCryptoPolyfill } from './src/lib/rand';

ensureCryptoPolyfill();

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('expo-router/entry');
