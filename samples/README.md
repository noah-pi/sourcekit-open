# Sample files

Five files and what each one should do. Run them through this
repository's verifier, through `c2patool`, or through Adobe's Content
Credentials page, and compare.

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
| `sealed-photo.jpg` | `72267f586eca19590502ea58a63c0fcb280cbab63c2547acfe8766d2be7c0dfd` |
| `altered-photo.jpg` | `2254f48c69b7d30df711474e7161ddd222d991704688000f299298e6418ff7c6` |
| `sealed-video.mp4` | `250314f8a2fb1215a6ebe45c911aff0defe266fd6c0a9d0134852a9bccc50397` |
| `altered-video.mp4` | `4c6de315008868d363bc7f7d51539c36974e14353b9b218afdab49632beb96f2` |
| `attacked-manifest.jpg` | `19bdc929c495263ae9c89a155fe22076737f642f7f52a646ee1d3250f477d3ef` |

**`sealed-photo.jpg`** — A sealed capture. The signature covers the media bytes and the assertion contents.

**`altered-photo.jpg`** — The same file with the low bit of byte 26700 flipped — one bit, inside the picture. The signature still verifies; the media no longer matches what it covers.

**`sealed-video.mp4`** — A sealed video. Same manifest, carried in a C2PA uuid box after ftyp.

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
