/**
 * consent.test.ts — the Tier-3 consent state machine (ARCHITECTURE §6.2,
 * DESIGN §5.8/§5.9), driven with a MOCK connector: no network anywhere.
 *
 * The laws under test:
 *  - refusal NEVER calls run, and writes a consent-refused audit entry;
 *  - a grant writes consent-granted BEFORE run is invoked, and the
 *    external-check outcome lands after;
 *  - the boundary indicator hook sees exactly [host, null] per send, on
 *    every settle path (answer, failure, abort);
 *  - mid-flight abort settles to `aborted` with an audit entry;
 *  - confirm outside `previewing` never runs (consent is per action);
 *  - the shipped stubs are honest with no endpoint configured
 *    (N/A-with-reason from canRun; no fetch anywhere in this build).
 *
 * Runs under `tsx --test` (node:test) — no test-runner dependency added.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connector, ConnectorResult } from '../../contracts-ext';
import type { DeskItem } from '../deskItem';
import {
  ConnectorConsentFlow,
  connectorHost,
  connectorDestination,
  type ConsentState,
} from './connector';
import { CONNECTORS, resolveConnectors } from './index';
import { NO_ENDPOINT_REASON } from './reverseImageSearch';

/* ------------------------------------------------------------------ */
/* Harness                                                            */
/* ------------------------------------------------------------------ */

const ITEM = {
  id: 'm1',
  name: 'IMG_4031.jpg',
  kind: 'media',
  addedAt: 0,
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]),
  sha256Hex: 'ab'.repeat(32),
} as unknown as DeskItem;

const ENDPOINT = 'https://images.example.com/search';

interface Rec {
  states: ConsentState[];
  audit: { action: string; detail?: string }[];
  boundary: (string | null)[];
}

function harness() {
  const rec: Rec = { states: [], audit: [], boundary: [] };
  const flow = new ConnectorConsentFlow({
    onState: (s) => rec.states.push(s),
    audit: (action, detail) => rec.audit.push({ action, detail }),
    boundary: (host) => rec.boundary.push(host),
    now: () => '2025-01-01T00:00:00.000Z',
  });
  return { flow, rec };
}

/** A mock connector: counts run() calls; settle behavior is scriptable. */
function mockConnector(behavior: 'answer' | 'hang-then-abort' | 'fail'): Connector & { runCalls: number } {
  const c: Connector & { runCalls: number } = {
    id: 'mock',
    name: 'Mock check',
    provider: 'Mock Provider',
    payloadKind: 'hash',
    runCalls: 0,
    describesPayload: () => 'the file’s SHA-256 hash',
    canRun: () => ({ ok: true }),
    async run(_item: DeskItem, signal: AbortSignal): Promise<ConnectorResult> {
      c.runCalls++;
      if (behavior === 'answer') {
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, summary: 'two sightings found on the web' };
      }
      if (behavior === 'fail') {
        await new Promise((r) => setTimeout(r, 5));
        return { ok: false, summary: '', error: 'the service declined the request' };
      }
      // hang-then-abort: settles only when the AbortSignal fires.
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted by user')));
      });
      return { ok: false, summary: '', error: 'unreachable' };
    },
  };
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fresh read of the current phase (function boundary: no TS narrowing). */
function phaseOf(flow: ConnectorConsentFlow): ConsentState['phase'] {
  return flow.current.phase;
}

/* ------------------------------------------------------------------ */
/* The state machine                                                  */
/* ------------------------------------------------------------------ */

test('refusal never calls run, writes consent-refused, and leaves the boundary silent', async () => {
  const { flow, rec } = harness();
  const c = mockConnector('answer');
  assert.deepEqual(flow.preview(c, ITEM, ENDPOINT), { ok: true });
  assert.equal(phaseOf(flow), 'previewing');

  flow.refuse();
  assert.equal(phaseOf(flow), 'refused');
  assert.equal(c.runCalls, 0, 'run must never be invoked on a refusal');

  assert.equal(rec.audit.length, 1);
  assert.equal(rec.audit[0].action, 'consent-refused');
  assert.ok(rec.audit[0].detail?.includes('the file’s SHA-256 hash'), 'exact payload in the audit entry');
  assert.ok(rec.audit[0].detail?.includes('Mock Provider (images.example.com)'), 'destination in the audit entry');
  assert.deepEqual(rec.boundary, [], 'no send — the indicator never flips');

  flow.reset();
  assert.equal(phaseOf(flow), 'idle');
});

test('grant: consent-granted precedes the run; outcome lands as external-check; boundary flips and returns', async () => {
  const { flow, rec } = harness();
  const c = mockConnector('answer');
  flow.preview(c, ITEM, ENDPOINT);
  await flow.confirm();

  assert.equal(phaseOf(flow), 'done');
  assert.equal(c.runCalls, 1);
  assert.deepEqual(
    rec.audit.map((a) => a.action),
    ['consent-granted', 'external-check'],
  );
  assert.ok(rec.audit[1].detail?.includes('answered'), 'the outcome is recorded');
  assert.deepEqual(rec.boundary, ['images.example.com', null], 'indicator flips for the send and returns');
  const phases = rec.states.map((s) => s.phase);
  assert.deepEqual(phases, ['previewing', 'sending', 'done']);
});

test('a failed answer settles to error with the boundary lowered', async () => {
  const { flow, rec } = harness();
  const c = mockConnector('fail');
  flow.preview(c, ITEM, ENDPOINT);
  await flow.confirm();
  assert.equal(phaseOf(flow), 'error');
  assert.equal(rec.audit[1].action, 'external-check');
  assert.ok(rec.audit[1].detail?.includes('no usable answer'));
  assert.deepEqual(rec.boundary, ['images.example.com', null]);
});

test('mid-flight abort settles to aborted, audits it, and lowers the boundary', async () => {
  const { flow, rec } = harness();
  const c = mockConnector('hang-then-abort');
  flow.preview(c, ITEM, ENDPOINT);
  const pending = flow.confirm();
  // Let confirm() reach the in-flight await, then abort mid-flight.
  await sleep(1);
  assert.equal(phaseOf(flow), 'sending');
  flow.abort();
  await pending;

  assert.equal(phaseOf(flow), 'aborted');
  assert.equal(c.runCalls, 1, 'the run began; the abort cancelled it in flight');
  assert.equal(rec.audit[1].action, 'external-check');
  assert.ok(rec.audit[1].detail?.includes('aborted by the user'));
  assert.deepEqual(rec.boundary, ['images.example.com', null], 'the indicator always returns');
});

test('confirm outside previewing never runs — consent is per action', async () => {
  const { flow, rec } = harness();
  const c = mockConnector('answer');
  // idle: confirm is a no-op.
  await flow.confirm();
  assert.equal(c.runCalls, 0);
  assert.equal(rec.audit.length, 0);

  // After a completed action, a stray confirm does not re-run.
  flow.preview(c, ITEM, ENDPOINT);
  await flow.confirm();
  assert.equal(phaseOf(flow), 'done');
  await flow.confirm();
  assert.equal(c.runCalls, 1, 'no repeat send without a fresh consent');
});

test('canRun gates the dialog: N/A-with-reason, no state change', () => {
  const { flow } = harness();
  const gated: Connector = {
    ...mockConnector('answer'),
    canRun: () => ({ ok: false, reason: 'this item’s bytes are not held in this tab' }),
  };
  const res = flow.preview(gated, ITEM, ENDPOINT);
  assert.deepEqual(res, { ok: false, reason: 'this item’s bytes are not held in this tab' });
  assert.equal(phaseOf(flow), 'idle', 'no dialog state for a connector that cannot run');
});

/* ------------------------------------------------------------------ */
/* The shipped stubs — honest with no endpoint (no network anywhere)  */
/* ------------------------------------------------------------------ */

test('shipped connectors are unconfigured and say so with a reason, not error theater', () => {
  assert.equal(CONNECTORS.length, 2);
  for (const c of CONNECTORS) {
    const can = c.canRun(ITEM);
    assert.equal(can.ok, false);
    if (!can.ok) assert.ok(can.reason.includes('Settings'), `reason names the fix: ${can.reason}`);
  }
});

test('stub run() reports the missing endpoint honestly and never fetches', async () => {
  const [ris, wm] = resolveConnectors({});
  const r1 = await ris.run(ITEM, new AbortController().signal);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, NO_ENDPOINT_REASON);
  const r2 = await wm.run(ITEM, new AbortController().signal);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, NO_ENDPOINT_REASON);
});

test('a stub with a declared endpoint is N/A-with-reason and never solicits consent (E26)', () => {
  // No request implementation → there is nothing a consent could authorize,
  // so canRun answers N/A with the reason: no dialog, no audit entry, and
  // (via the flow's canRun gate) no transition at all.
  const [ris] = resolveConnectors({ 'reverse-image-search': { endpoint: ENDPOINT } });
  const can = ris.canRun(ITEM);
  assert.equal(can.ok, false);
  if (!can.ok) {
    assert.ok(can.reason.includes('no request implementation') || can.reason.includes('No request implementation'), can.reason);
    assert.ok(can.reason.includes('nothing can be sent'), can.reason);
  }
  const { flow, rec } = harness();
  const res = flow.preview(ris, ITEM, ENDPOINT);
  assert.equal(res.ok, false);
  assert.equal(phaseOf(flow), 'idle', 'no dialog state for a no-op');
  assert.equal(rec.audit.length, 0, 'no consent audit entry for a no-op');
});

test('a stub run, if invoked anyway, still makes no request in this build', async () => {
  const [ris] = resolveConnectors({ 'reverse-image-search': { endpoint: ENDPOINT } });
  const res = await ris.run(ITEM, new AbortController().signal);
  assert.equal(res.ok, false);
  assert.ok(res.error?.includes('No request was made'), 'honest: nothing was transmitted');
  assert.ok(res.error?.includes('nothing left this tab'));
});

test('payload declarations are exact, never "data"', () => {
  const [ris, wm] = CONNECTORS;
  assert.equal(ris.payloadKind, 'bytes');
  assert.equal(ris.describesPayload(ITEM), 'the image bytes (8 B)');
  assert.equal(wm.payloadKind, 'hash');
  assert.equal(wm.describesPayload(ITEM), 'the file’s SHA-256 hash');
});

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

test('connectorHost / connectorDestination', () => {
  assert.equal(connectorHost(ENDPOINT), 'images.example.com');
  assert.equal(connectorHost(null), null);
  assert.equal(connectorHost('not a url'), null);
  const [ris] = CONNECTORS;
  assert.equal(connectorDestination(ris, ENDPOINT), 'the configured search service (images.example.com)');
  assert.equal(connectorDestination(ris, null), 'the configured search service (no endpoint declared)');
});
