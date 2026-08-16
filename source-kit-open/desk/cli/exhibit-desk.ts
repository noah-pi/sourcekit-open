/**
 * DEPRECATED entry point (rename migration, ARCHITECTURE §7): the CLI is now
 * `exhibit-c` (cli/exhibit-c.ts). This shim forwards to it after a one-line
 * stderr deprecation note. Removed next minor release.
 */
console.error('exhibit-desk is now exhibit-c — this shim forwards to cli/exhibit-c.ts and goes away next minor release.');
await import('./exhibit-c');

export {};
