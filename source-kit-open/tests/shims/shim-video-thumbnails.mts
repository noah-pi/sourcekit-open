/**
 * Lab shim for expo-video-thumbnails: vaultFs is staged for the disclosure
 * store hygiene suite (deleteItem / destroyVault), which never touches the
 * video thumbnail path. The stub exists so the import resolves; calling it
 * is a test bug — the real thumbnail pipeline is device-only.
 */
export async function getThumbnailAsync(): Promise<{ uri: string }> {
  throw new Error('shim-video-thumbnails: the video thumbnail pipeline is not exercised in the lab');
}
