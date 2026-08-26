// Source Kit 0.1.0 — Lab shim for expo-image-manipulator
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Lab shim for expo-image-manipulator. The disclosure store hygiene suite
 * (deleteItem / destroyVault) never touches the thumbnail path; the stub only
 * exists so the import resolves. Calling it is a test bug.
 */
export const SaveFormat = { JPEG: 'jpeg', PNG: 'png' };

export async function manipulateAsync(
  _uri: string,
  _actions: unknown[],
  _options?: { compress?: number; format?: string; base64?: boolean },
): Promise<{ uri?: string; base64?: string }> {
  throw new Error('shim-image-manipulator: the thumbnail pipeline is not exercised in the lab');
}
