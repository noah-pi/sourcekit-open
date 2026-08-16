/**
 * aiStrings.ts — the AI Forensics copy deck, as data.
 *
 * The §10.8 strings are NORMATIVE, verbatim (DESIGN §10.8 / §10.10): they
 * live here once so the components render them string-for-string and the
 * copy test (copy.test.ts) can sweep every AI-tab string against the
 * banned-word list (§1.3) without scraping JSX. DOM-free pure data.
 *
 * Interpolations follow the deck's [var] convention via small formatters.
 */

export const AI = {
  title: 'AI Forensics',
  intro:
    'Two kinds of help. The Assistant reads this asset’s computed evidence and explains it in plain ' +
    'language — it runs here and sends nothing. Connectors ask outside services for information — ' +
    'each one is opt-in, per action, and shows exactly what would be sent before anything leaves.',
  assistant: {
    title: 'Assistant',
    sub:
      'A plain-language reading of the evidence above. Computed locally from the same numbers you ' +
      'can inspect — it adds no new facts.',
    empty: 'Nothing to summarize yet — open this asset after intake finishes, or run a signal first.',
    disclaimer:
      'This summary restates computed checks. It is not a detection, not a score, and not a ' +
      'conclusion — custody, not reality.',
    /** §10.13 tooltip row "Assistant summary". */
    tooltip: {
      can: 'The evidence, restated plainly',
      cannot: 'Any fact not already on this dashboard',
    },
    /** Link affordance on each sentence — jumps to its basis card. */
    basisLink: 'show the evidence',
  },
  connectors: {
    title: 'External checks',
    sub:
      'Each check sends something to an outside service. The offline boundary is the default; ' +
      'crossing it is your call, one action at a time.',
  },
  connector: {
    ris: {
      name: 'Reverse image search',
      desc: 'Asks a search engine where else this image appears on the web.',
    },
    wm: {
      /** ai.connector.wm.name — "Watermark check ([provider])". */
      name: (provider: string) => `Watermark check (${provider})`,
      desc: (provider: string) =>
        `Asks ${provider} whether this file carries its watermark. Their answer is their statement, ` +
        'labeled as such — Source Kit Desk does not detect watermarks itself.',
    },
    send: (provider: string) => `Check with ${provider}…`,
    sends: (payload: string) => `Sends: ${payload}`,
    where: (provider: string, host: string) => `To: ${provider} (${host})`,
    fixed: 'This action leaves your browser. Everything else in Source Kit Desk stays offline.',
    confirm: 'Send and check',
    cancel: 'Cancel',
    sending: (host: string) => `Sending to ${host}…`,
    result: (provider: string, result: string) =>
      `${provider} reports: ${result} — their statement, shown as received`,
    error: (provider: string) =>
      `${provider} could not be reached, or declined. Nothing was computed locally from this ` +
      'attempt; the rest of your evidence is untouched.',
    none: 'No connectors configured. Connectors are declared in Settings and always stay opt-in.',
    /** What comes back — consent dialog line 3 (DESIGN §5.8). */
    returns:
      'What comes back: the service’s own statement, shown to you attributed to them and labeled ' +
      'as received — never merged into this asset’s local evidence.',
    /** Shown when a connector is declared but not runnable on this item. */
    notRunnable: (reason: string) => `Not applicable — ${reason}`,
    /** Expandable raw payload label (L9 — "as received"). */
    rawLabel: 'Raw response, as received',
  },
  selfdeclared: (tool: string) => `Declared by ${tool} — a self-declaration, not our detection.`,
} as const;

/**
 * Settings → connectors card (§10.10 slot; the deck reserves the wording
 * pattern of ai.connector.none: connectors are declared here and always
 * stay opt-in). Every string restates the boundary in plain language.
 */
export const SETTINGS_CONNECTORS = {
  title: 'External connectors',
  intro:
    'Declared connectors for the AI Forensics tab. Always opt-in: nothing is sent unless you ' +
    'confirm a specific action on an asset, and the action shows exactly what would be sent ' +
    'before anything leaves.',
  endpointField: 'Endpoint URL',
  endpointPlaceholder: 'https://…',
  endpointNote:
    'Stored in this browser only (exhibitC.connectors.v1) and wiped by “Clear this browser’s ' +
    'local data”. This build ships the boundary scaffolding without a request implementation — ' +
    'a declared endpoint proves the consent flow; no bytes are transmitted.',
  configured: 'Declared',
  notConfigured: 'Not declared — the connector stays off',
  sendsLabel: 'Would send:',
} as const;

/** Settings → Local data: the "what left this browser" list (DESIGN §5.9). */
export const SETTINGS_BOUNDARY_LOG = {
  title: 'What left this browser',
  empty:
    'Nothing has left this browser. Every external-check consent you give — or refuse — is ' +
    'recorded here from the session audit trail.',
  colWhen: 'When',
  colEntry: 'Audit entry',
} as const;
