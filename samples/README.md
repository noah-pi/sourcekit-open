# Sample files

Five files and what each one should do. Run them through this
repository's verifier, through `c2patool`, or through Adobe's Content
Credentials page, and compare.

## What these are not

The pictures are generated test patterns, and they were sealed by a
lab key rather than by a Secure Enclave on a real phone. So there is
no hardware attestation behind them, no sensor context, and nothing
was photographed.

None of that changes what they demonstrate, because a signature never
claimed otherwise: **INTACT means these bytes are the bytes that were
signed**, not that a real thing was in front of a real lens. A test
pattern verifies exactly as cleanly as a photograph would, and so
would a picture of a screen. What these files show is the container
format and how a verifier behaves — nothing about the world.

A capture from an actual device carries more: an Enclave signature, an
Apple attestation, a sensor record. Those cannot be generated here.

| File | This verifier | c2patool 0.14.0 | Bytes |
|---|---|---|---|
| `sealed-photo.jpg` | INTACT | `no failures` | 35,601 |
| `altered-photo.jpg` | CONTENT_MODIFIED | `assertion.dataHash.mismatch` | 35,601 |
| `sealed-video.mp4` | INTACT | `no failures` | 26,048 |
| `altered-video.mp4` | CONTENT_MODIFIED | `assertion.bmffHash.mismatch` | 26,048 |
| `attacked-manifest.jpg` | SIGNATURE_INVALID | `assertion.hashedURI.mismatch` | 35,601 |

These hashes are of the files in this release, not of a
reproducible build. Regenerating them produces different bytes: an
ECDSA signature varies in DER length run to run, and a capture
carries the time it was made. The hashes are here so you can tell
whether the file you downloaded is the file that was published.

| File | SHA-256 |
|---|---|
| `sealed-photo.jpg` | `a27fe0d2d97aaee1c8e4ecc2e487a0f462892bf7d66d9da4c351968de7a798f6` |
| `altered-photo.jpg` | `6e1118ab2c511624d0684106382676bd18c0e871d28a49c34e149f347e8647df` |
| `sealed-video.mp4` | `51e626dc64e044c3afcdad3d022623f60b04aef9cab226c216848c1330f3408a` |
| `altered-video.mp4` | `8857df1a2b916f8263ce7d83c4d9f8404ada72f4aaf9001baa984320093b23a7` |
| `attacked-manifest.jpg` | `2056fdbb9a25fe9533549dcedc5c3e4be7707192a69c122f332bb6c6a8fccde9` |

**`sealed-photo.jpg`** — A sealed file. The signature covers the media bytes and the assertion contents.

**`altered-photo.jpg`** — The same file with the low bit of byte 26700 flipped — one bit, inside the picture. The signature still verifies; the media no longer matches what it covers.

**`sealed-video.mp4`** — A sealed video. Same manifest, carried in a C2PA uuid box after ftyp rather than a JPEG segment.

**`altered-video.mp4`** — The same file with the low bit of byte 19536 flipped.

**`attacked-manifest.jpg`** — The sealed photo with the low bit of byte 4683 flipped, inside the credential rather than the picture. The claim commits a hash of every assertion, so an edited assertion no longer matches what the claim says it is — the credential contradicts itself. A different failure from an edited picture, and both tools say so in their own vocabulary.

## What another C2PA tool will say

The signing certificate is self-signed by the device. No authority on
the C2PA conformance list issued it, so every third-party verifier
reports the signer as untrusted while confirming the signature and the
media binding. That is the expected result, not a failure: it is a
statement about *who* signed, never about *whether* the signature held.

The failure codes in the table above are what c2patool actually
printed when these files were built, not what anyone expected it to
print. They differ by container and by which part of the credential
was attacked, and that is the useful part: a JPEG whose picture
changed, a video whose picture changed, and a credential that was
edited are three different findings, not one.
