// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * copy.test.ts — the ethos guard for the W3 surfaces (ARCHITECTURE §9,
 * DESIGN §1.3): every AI-tab string, every Assistant template, and every
 * connector/consent string swept against the banned-word list, plus the
 * normative §10.8 strings pinned verbatim so no one softens or sharpens
 * them by accident.
 *
 * "Every rendered string id exists in the copy module": the AI tab renders
 * from core/aiStrings.ts only, so sweeping that module sweeps the tab.
 *
 * Runs under `tsx --test` (node:test) — no test-runner dependency added.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI, SETTINGS_CONNECTORS, SETTINGS_BOUNDARY_LOG } from './aiStrings';
import { bannedWordHits } from './bannedWords';
import { summarizeAsset } from './assistant';

/* ------------------------------------------------------------------ */
/* Flatten the copy modules into individual strings                    */
/* ------------------------------------------------------------------ */

function flatten(value: unknown, path: string, out: { id: string; text: string }[]): void {
  if (typeof value === 'string') {
    out.push({ id: path, text: value });
  } else if (typeof value === 'function') {
    // Interpolated deck strings: exercised with representative args.
    out.push({ id: `${path}([var])`, text: (value as (...a: string[]) => string)('Example Provider') });
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out);
  }
}

function allAiCopy(): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  flatten(AI, 'ai', out);
  flatten(SETTINGS_CONNECTORS, 'set.connectors', out);
  flatten(SETTINGS_BOUNDARY_LOG, 'set.boundary', out);
  return out;
}

/* ------------------------------------------------------------------ */
/* Banned-word sweep (§1.3)                                            */
/* ------------------------------------------------------------------ */

test('no banned words in any AI-tab / Settings-connector string', () => {
  const copy = allAiCopy();
  assert.ok(copy.length > 20, 'the sweep actually covers the module');
  for (const { id, text } of copy) {
    assert.deepEqual(bannedWordHits(text), [], `${id}: banned word in "${text}"`);
  }
});

test('no banned words in Assistant templates (generated across fixture states)', () => {
  // The assistant templates are exercised end-to-end in assistant.test.ts;
  // here the sweep guards the template pool itself via generated text.
  const item = {
    id: 'm1', name: 'a.jpg', kind: 'media', addedAt: 0,
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    sha256Hex: 'ab'.repeat(32),
    report: { verdict: 'INTACT', record: { capturedAt: 'x' }, checksNotPerformed: [] },
    tier1Signals: [
      { id: 'displaybeat', title: 'Display-beat', version: 'v/1', measurement: 'm', bound: 'b', note: '', limitations: [], computedAt: 't' },
    ],
    intakeReport: {
      itemId: 'm1', computedAt: 't', sha256Hex: 'ab'.repeat(32), classification: 'media',
      byteReads: null, jpegStructure: null, thumbnail: null,
      c2paSummary: {
        claimGenerator: 'G', manifestLabel: null, manifestCount: 1,
        actions: [{ action: 'c2pa.edited', referenced: true }], ingredients: [{ referenced: true }],
        signerFingerprint: null, digitalSourceType: 'trainedAlgorithmicMedia',
      },
      pHashHex: null, custody: { recoveryMatches: 0, exactAfterStrip: 0 },
    },
  } as unknown as Parameters<typeof summarizeAsset>[0]['item'];
  const summary = summarizeAsset({
    item,
    trust: { tier: 'roster', basis: 'b', membershipState: 'unknown-time' },
    artifact: null,
    matches: [{ proofItemId: 'p', proofName: 'proof.json', mediaItemId: 'm1', mediaName: 'a.jpg', grade: 'exact', distance: null }],
    custodyMatches: [{ mediaItemId: 'm1', mediaName: 'a.jpg', bundleItemId: 'b1', bundleName: 'b.json', how: 'stripped-container', manifestLabel: 'l' }],
  });
  assert.ok(summary.paragraphs.length >= 8, 'the sweep covers every template family');
  for (const p of summary.paragraphs) {
    assert.deepEqual(bannedWordHits(p.text), [], `banned word in: ${p.text}`);
  }
});

/* ------------------------------------------------------------------ */
/* Normative strings, pinned verbatim (§10.8 string-for-string)        */
/* ------------------------------------------------------------------ */

test('§10.8 normative strings are verbatim', () => {
  assert.equal(AI.title, 'AI Forensics');
  assert.equal(
    AI.intro,
    'Two kinds of help. The Assistant reads this asset’s computed evidence and explains it in plain ' +
      'language — it runs here and sends nothing. Connectors ask outside services for information — ' +
      'each one is opt-in, per action, and shows exactly what would be sent before anything leaves.',
  );
  assert.equal(AI.assistant.title, 'Assistant');
  assert.equal(
    AI.assistant.sub,
    'A plain-language reading of the evidence above. Computed locally from the same numbers you ' +
      'can inspect — it adds no new facts.',
  );
  assert.equal(
    AI.assistant.empty,
    'Nothing to summarize yet — open this asset after intake finishes, or run a signal first.',
  );
  assert.equal(
    AI.assistant.disclaimer,
    'This summary restates computed checks. It is not a detection, not a score, and not a ' +
      'conclusion — custody, not reality.',
  );
  assert.equal(AI.connectors.title, 'External checks');
  assert.equal(
    AI.connectors.sub,
    'Each check sends something to an outside service. The offline boundary is the default; ' +
      'crossing it is your call, one action at a time.',
  );
  assert.equal(AI.connector.ris.name, 'Reverse image search');
  assert.equal(AI.connector.ris.desc, 'Asks a search engine where else this image appears on the web.');
  assert.equal(AI.connector.wm.name('Acme'), 'Watermark check (Acme)');
  assert.equal(
    AI.connector.wm.desc('Acme'),
    'Asks Acme whether this file carries its watermark. Their answer is their statement, ' +
      'labeled as such — Source Kit Desk does not detect watermarks itself.',
  );
  assert.equal(AI.connector.send('Acme'), 'Check with Acme…');
  assert.equal(AI.connector.sends('the file’s SHA-256 hash'), 'Sends: the file’s SHA-256 hash');
  assert.equal(AI.connector.where('Acme', 'wm.example.com'), 'To: Acme (wm.example.com)');
  assert.equal(AI.connector.fixed, 'This action leaves your browser. Everything else in Source Kit Desk stays offline.');
  assert.equal(AI.connector.confirm, 'Send and check');
  assert.equal(AI.connector.cancel, 'Cancel');
  assert.equal(AI.connector.sending('wm.example.com'), 'Sending to wm.example.com…');
  assert.equal(
    AI.connector.result('Acme', 'no watermark found'),
    'Acme reports: no watermark found — their statement, shown as received',
  );
  assert.equal(
    AI.connector.error('Acme'),
    'Acme could not be reached, or declined. Nothing was computed locally from this ' +
      'attempt; the rest of your evidence is untouched.',
  );
  assert.equal(AI.connector.none, 'No connectors configured. Connectors are declared in Settings and always stay opt-in.');
  assert.equal(AI.selfdeclared('Tool X'), 'Declared by Tool X — a self-declaration, not our detection.');
});
