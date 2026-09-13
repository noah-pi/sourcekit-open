// Source Kit 0.1.0 — type-only stand-in for the detail screens' state shapes
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Type-only stand-in for the shapes src/components/detail/derive.ts takes
 * from DetailBody.tsx and DetailKit.tsx. The label grammar is staged into
 * the lab as real code; the two components beside it render with React
 * Native and are not. Type imports are erased at runtime. Drift from the
 * app's shapes fails the staged strict typecheck.
 */

export type Tone = 'established' | 'neutral' | 'attention' | 'broken';

/** What the seal establishes. */
export interface SealState {
  /** The maker the file names, e.g. "Source Kit on iPhone 15 Pro". */
  device: string;
  key: { value: string };
  app: { value: string };
  establishedBy: string;
  /** Bytes against signature. Only a contradiction is 'altered'. */
  media: 'intact' | 'altered' | 'unsigned';
  /** Who vouches for the signer, when anyone does. */
  signer: string | null;
  attestation: 'proven' | 'refused' | 'none';
  /** Why an attestation was refused, when one was. */
  reason: string | null;
  signedDigest: string | null;
  fileDigest: string | null;
  alg: string | null;
  keyFingerprint: string | null;
}

export interface TimeCheck {
  name: string;
  detail: string;
  met: boolean;
}

export interface TimeState {
  signedAt: string;
  signedAtIso: string | null;
  checks: TimeCheck[];
  tag: string;
  established: boolean;
  authority: { name: string | null; trusted: boolean; at: string | null } | null;
  ledger: { beaconHeight: number | null; anchoredHeight: number | null; pending: boolean } | null;
}

export interface PlaceState {
  coords: string | null;
  accuracy: string | null;
  mapsUrl: string | null;
  placeName: string | null;
  compass: { sealed: string; detail: string; agrees: boolean } | null;
}

export interface SignerIdentityState {
  tag: string;
  tone: Tone;
  name: string;
  by: string | null;
  domain: string | null;
  org?: string | null;
}

/** One row of the label. */
export interface LabelRow {
  id: 'edits' | 'seal' | 'time' | 'place' | 'who';
  question: string;
  answer: string;
  caption: string;
  /** Who says so. Empty for a thing to look at. */
  word: string;
  tone: Tone | 'none';
  mono?: boolean;
  /** A link that ends the caption line. */
  link?: { label: string; url: string };
}

export interface StripItem {
  label: string;
  tone: Tone;
}

export interface StripState {
  maker: string;
  stamps: StripItem[];
}

export interface LabelState {
  /** Null when the file has no seal: there is nothing to stamp. */
  strip: StripState | null;
  rows: LabelRow[];
  unsigned: boolean;
  /** One line above the rows when they describe a file other than this one. */
  notice: string | null;
}
