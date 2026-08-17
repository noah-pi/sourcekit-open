// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Lab shim for expo-image-manipulator: vaultFs is staged for the disclosure
 * store hygiene suite (deleteItem / destroyVault), which never touches the
 * thumbnail path. The stub exists so the import resolves; calling it is a
 * test bug — the real thumbnail pipeline is device-only.
 */
export const SaveFormat = { JPEG: 'jpeg', PNG: 'png' };

export async function manipulateAsync(
  _uri: string,
  _actions: unknown[],
  _options?: { compress?: number; format?: string; base64?: boolean },
): Promise<{ uri?: string; base64?: string }> {
  throw new Error('shim-image-manipulator: the thumbnail pipeline is not exercised in the lab');
}
