import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

// The desk tool imports the SAME verification core the app ships — straight
// from the repo sources, never a forked copy. One implementation, two hosts.
// In the repo the core sits at ../src; a standalone copy (preview bundles)
// ships it at ./verify-core. Detect, don't configure.
const repoCore = path.resolve(__dirname, '../src');
const core = fs.existsSync(path.join(repoCore, 'lib', 'bytes.ts'))
  ? repoCore
  : path.resolve(__dirname, 'verify-core');
// The archived hand-rolled verifier: the desk's verification engine,
// living at ../archive. Same detect-don't-configure fallback for
// standalone preview bundles.
const repoArchive = path.resolve(__dirname, '../archive');
const archive = fs.existsSync(path.join(repoArchive, 'handrolled-verifier', 'verifyAsset.ts'))
  ? repoArchive
  : path.resolve(__dirname, 'verify-core-archive');

// The repo sources live OUTSIDE this package, so their bare runtime imports
// (noble, cbor-x) are pinned to this package's node_modules explicitly —
// Node's walk-up resolution would never find them from ../src.
//
// The pin applies only to importers OUTSIDE node_modules: packages that ship
// their own nested dependency copies keep them. @noble/post-quantum pins the
// v2 noble stack (different wire formats than the v1 stack the core uses);
// hijacking its internal imports onto our v1 copies would silently break its
// math, so its internals must resolve their own nested v2.
const pin = (find: RegExp, target: string) => ({
  name: `pin-${find.source.replace(/[^a-z-]/gi, '')}`,
  enforce: 'pre' as const,
  async resolveId(source: string, importer?: string) {
    if (find.test(source) && importer && !importer.includes('node_modules')) {
      // Rewrite, then hand back to the resolver for extension/subpath probing —
      // returning the bare replaced path would skip that and miss extensionless
      // specifiers like '@noble/hashes/sha256'.
      return this.resolve(source.replace(find, target), importer, { skipSelf: true });
    }
    return null;
  },
});

export default defineConfig({
  plugins: [
    react(),
    pin(/^@noble\/post-quantum/, path.resolve(__dirname, 'node_modules/@noble/post-quantum')),
    pin(/^@noble\/hashes/, path.resolve(__dirname, 'node_modules/@noble/hashes')),
    pin(/^@noble\/curves/, path.resolve(__dirname, 'node_modules/@noble/curves')),
    pin(/^@noble\/ciphers/, path.resolve(__dirname, 'node_modules/@noble/ciphers')),
    pin(/^cbor-x$/, path.resolve(__dirname, 'node_modules/cbor-x')),
  ],
  resolve: {
    alias: [
      { find: '@exhibit-archive', replacement: archive },
      { find: '@exhibit', replacement: core },
      // The shared core's rosterStore imports the Expo keychain. The desk
      // has no Expo runtime — resolve it to the desk-local typed storage
      // adapter (localStorage / in-memory). See src/platform/expo-secure-store.ts.
      { find: /^expo-secure-store$/, replacement: path.resolve(__dirname, 'src/platform/expo-secure-store.ts') },
      // The upstream engine chain references node builtins on its load
      // path (node runtimes only). In the browser bundle they resolve
      // to stubs that throw if ever called — the engine then reports itself
      // unavailable honestly. See src/core/nodeBuiltins.browser.ts.
      { find: /^node:module$/, replacement: path.resolve(__dirname, 'src/core/nodeBuiltins.browser.ts') },
      { find: /^node:url$/, replacement: path.resolve(__dirname, 'src/core/nodeBuiltins.browser.ts') },
      { find: /^node:fs$/, replacement: path.resolve(__dirname, 'src/core/nodeBuiltins.browser.ts') },
    ],
  },
  server: { fs: { allow: ['..'] } },
  build: { target: 'es2022' },
});
