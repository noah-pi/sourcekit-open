#!/usr/bin/env bash
# Source Kit 0.1.0 — fetches and verifies the C2PA framework
# Fetch the C2PAC.xcframework the c2pa-ios module links against.
#
# The binary is not in this repository. It is downloaded from the c2pa-swift
# release that publishes it and checked against the SHA-256 upstream pins in
# its own Package.swift, so what you build against is the artifact Adobe
# shipped rather than a copy anyone here re-hosted.
#
# Usage:  ./scripts/fetch-c2pa-framework.sh
# Then:   npx eas build --platform ios --profile production
set -euo pipefail

VERSION="v0.0.12"
URL="https://github.com/contentauth/c2pa-swift/releases/download/${VERSION}/C2PAC.xcframework.zip"
SHA256="a038bc316f7a890d1233e156cc743854cee98e24359a6176fb107088359fe0a8"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${REPO_ROOT}/modules/c2pa-ios/ios/Frameworks"
CACHE="${TMPDIR:-/tmp}/C2PAC-${VERSION}.zip"

# CocoaPods rejects an xcframework whose slices mix static and dynamic
# linkage. The two iOS slices are static; the macOS and Mac Catalyst slices
# are dynamic, and nothing here builds for either platform.
DROP_SLICES=(macos-arm64_x86_64 ios-arm64_x86_64-maccatalyst)

sha_of() {
  if command -v shasum > /dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

if [ -f "$CACHE" ] && [ "$(sha_of "$CACHE")" = "$SHA256" ]; then
  echo "cached  $CACHE"
else
  echo "fetching ${URL}"
  echo "         387 MB, one time"
  curl -fL --progress-bar -o "$CACHE" "$URL"
fi

got="$(sha_of "$CACHE")"
if [ "$got" != "$SHA256" ]; then
  echo "CHECKSUM MISMATCH — refusing to install" >&2
  echo "  expected $SHA256" >&2
  echo "  got      $got" >&2
  rm -f "$CACHE"
  exit 1
fi
echo "verified sha256 $got"

rm -rf "${DEST:?}/C2PAC.xcframework"
mkdir -p "$DEST"
unzip -q "$CACHE" -d "$DEST"

FW="${DEST}/C2PAC.xcframework"
for slice in "${DROP_SLICES[@]}"; do
  rm -rf "${FW:?}/${slice}"
done

# Drop the removed slices from AvailableLibraries so the xcframework's own
# manifest matches what is on disk.
python3 - "$FW/Info.plist" "${DROP_SLICES[@]}" <<'PY'
import plistlib, sys
path, drop = sys.argv[1], set(sys.argv[2:])
with open(path, 'rb') as f:
    plist = plistlib.load(f)
before = len(plist.get('AvailableLibraries', []))
plist['AvailableLibraries'] = [
    lib for lib in plist.get('AvailableLibraries', [])
    if lib.get('LibraryIdentifier') not in drop
]
with open(path, 'wb') as f:
    plistlib.dump(plist, f)
print(f"slices {before} -> {len(plist['AvailableLibraries'])}: "
      + ", ".join(l['LibraryIdentifier'] for l in plist['AvailableLibraries']))
PY

echo "installed ${FW#"$REPO_ROOT"/}"
