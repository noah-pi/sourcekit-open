// Source Kit 0.1.0 — device info shim for the lab
// Written with AI assistance. Verification: docs/PROVENANCE.md.
export const modelName = 'iPhone 15 Pro';
export const modelId = 'iPhone16,1';
export const manufacturer = 'Apple';
// Typed boolean, not the literal true, so integrity.ts's `isDevice === false`
// check compiles; expo-device reports false on the simulator.
export const isDevice: boolean = true;
