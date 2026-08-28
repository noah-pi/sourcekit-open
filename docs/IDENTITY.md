<!-- Source Kit 0.1.0 — who a capture says made it, and who vouches for that -->
# Identity — who a capture says made it

A record carries a name only when the device holds a credential that name
came from. Nothing typed into the app reaches a capture, so a name in a
record is always something a verifier can go and check.

Three modes, chosen per capture in Settings.

## Anonymous

The identity reads `redacted`. The signature still chains to the device's
own key, so the capture is still bound to one device; the record just says
nothing about a person.

## Personal

Either of two credentials, whichever is installed. They are different
claims and the app never presents one as the other.

**A personal certificate.** The device builds a PKCS#10 request and signs it
with the Secure Enclave key. A certificate authority checks the person and
issues a certificate for that public key. The C2PA `x5chain` then names a
person a third party has actually verified.

The certificate belongs to the person, not to this app: it is issued against
their own subscription, and any tool that writes CAWG identity assertions can
use it. The key cannot move, because a Secure Enclave key is not exportable,
so a second device needs its own certificate for its own key.

**A website credential** — `sourcekit-site/1`, for a person who wants a name
on their work without a certificate authority. They publish one static file
on a domain they control:

```
https://<domain>/.well-known/sourcekit-site.json
```

listing the signing keys that domain claims. TLS vouches for the domain.
Nothing in the file is signed, so a verifier that finds a capture's key
listed there learns that whoever controls the domain published that key, and
nothing more. That ceiling is why it is a separate type in the code from an
organization credential.

## Organization

The organization's own CA issues a certificate for the device's public key.
Every signature's `x5chain` is then `[org-issued device cert, org CA cert]`,
and the record carries no personal name. Revocation is standard and
verifier-side: the CA publishes OCSP and CRL endpoints in the certificates it
issues, and the app surfaces each certificate's serial number and expiry so a
desk can ask whether it is still good.

## What is recognized, and by whom

Recognition follows the CAWG interim trust model in force until 31 March
2027. A certificate carrying the document-signing purpose is recognized
outright; the specification requires that purpose and names no anchors for
it. One carrying email protection is recognized only when its chain reaches
an anchor list the device holds — the Mozilla root store with the S/MIME
trust bit, or the IPTC Origin Verified News Publishers List.

Anchors are pinned by SHA-256 over the certificate DER. The pinned list ships
empty and is fetched at runtime, so until a list is fetched every issuer
reads as self-asserted. That is the honest report of what this device can
check, not a verdict on the certificate: a recipient's tool may hold lists
this one does not.

## What none of this proves

- A credential says who signed, never what happened in front of the lens.
- A private key that is offered as a credential is a liability. The app
  accepts certificates only, never keys.
- A credential that no longer matches the active signing key is ignored and
  flagged, never quietly used.
