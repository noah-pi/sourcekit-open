/**
 * Lab shim for expo-image-manipulator: vaultFs is staged for the disclosure
 * store hygiene suite (deleteItem / destroyVault), which never touches the
 * thumbnail path. The stub exists so the import resolves; calling it is a
 * test bug — the real thumbnail pipeline is device-only.
 */
export const SaveFormat = { JPEG: 'jpeg', PNG: 'png' };

export async function manipulateAsync(): Promise<{ base64?: string }> {
  throw new Error('shim-image-manipulator: the thumbnail pipeline is not exercised in the lab');
}
