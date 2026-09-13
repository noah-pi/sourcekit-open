<!-- Source Kit 0.1.0 — the label: five questions, one word each -->
# The label

Both detail screens, Inspect and the exhibit page, state what a file
establishes as a label: up to five questions, one answer each, and beside
each answer one word naming who says so. The grammar is
`src/components/detail/derive.ts`, and it runs in the lab as shipped
(`tests/test-verification.mts`, the label block).

## The questions

| Row | Question | Answer | The word |
|---|---|---|---|
| edits | What was done to it? | The edits the file declares, when it declares any | *Declared*, in amber |
| seal | Changed since it was sealed? | No, or Yes | Who vouches for the key and the app |
| time | When was it sealed? | The countersigned time, or the device clock | The authority that countersigned |
| place | Where was it taken? | The sealed coordinates, with a map link | *Device-reported*, or *Inconsistent* |
| who | Who sealed it? | The name, or Signer unknown | The credential |

For a file another signer sealed the time question reads *When was it
taken?*, or *When was it made?* when the file declares edits. Declared edits
lead, because they change how every row under them is read.

## The colors

- **Green.** Somebody outside the phone vouches for that answer: Apple for a
  key held in hardware and an app it attested, a timestamp authority for the
  time, a domain or a certificate on a list for a name.
- **Gray.** Only the phone or the software says so.
- **Amber.** A claim that could mislead if read as more than it is: a bare
  name, an attestation that was refused, a compass that disagrees with the
  sealed location, an edit the file declares.
- **Red.** The bytes contradict the signature.

None of the four is a verdict on the picture.

## The words

**Seal.** *Apple* when the key is held in hardware and the app was attested,
in green. *This device* otherwise: gray when nothing was claimed, amber when
an attestation was refused, red when the bytes changed. A file another
signer sealed names its maker when the signing chain reaches the pinned list.

**Time.** The authority's name from the pinned list, with *· Bitcoin* when a
ledger anchor holds, in green. *Name · unlisted*, in gray, for a token from an
authority on no list this build carries: it verifies against its own key and
is disclosed as unvetted. *Device-reported* when there is no countersignature.

**Place.** *Device-reported*. *Inconsistent*, in amber, when the sealed
compass declination disagrees with the sealed coordinates.

**Who.** *Not provided* when no name was attached, the normal state of an
anonymous seal, in gray. *Redacted* when a name was taken out of a
de-identified copy. *Self reported*, in amber, for a bare name or a
self-signed certificate. *Domain verified* for a website that publishes the
key. *Certified* for an organization's certificate that reaches a list the
app carries, *Verified* for a person's. *Certificate* when the chain holds
but reaches no list.

## The strip

On the picture's edge: the maker the file names, then the stamps the file
earned. *Sealed* or *Changed*. *Attested* for a hardware-attested key, or
*Certified* for a foreign chain on the list. *Countersigned* when a listed
authority signed the time. *Anchored* when a ledger height is sealed. A
cropped screenshot of the picture still carries the finding.

## What it never says

The label never says real, authentic, or verified about the picture. An
unsigned file is one row and no strip: absence is not suspicion. A stripped
file cannot be passed off as sealed, and a sealed file cannot be read as
more than what its rows state.
