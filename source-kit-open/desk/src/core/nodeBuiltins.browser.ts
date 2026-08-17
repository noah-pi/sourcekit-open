// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Browser stubs for the node builtins referenced by the WS3 upstream engine
 * (src/provenance/engine/upstreamEngine.ts). The browser desk never loads
 * the upstream engine — these exist only so the vite bundle can be built;
 * any actual call throws, loadEngine catches it, and the engine reports
 * 'unavailable' honestly (stated in the dossier, never faked).
 */

const unavailable = (what: string): never => {
  throw new Error(`${what} is unavailable in the browser desk — the upstream C2PA engine loads on node runtimes only (its absence is disclosed, never hidden)`);
};

export function createRequire(): never {
  return unavailable('node:module createRequire');
}

export function pathToFileURL(): never {
  return unavailable('node:url pathToFileURL');
}

export function readFileSync(): never {
  return unavailable('node:fs readFileSync');
}
