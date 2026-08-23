#!/usr/bin/env node
/**
 * Prose checker — finds comments and copy that describe the project's history
 * instead of the project.
 *
 * Not a CI gate. Every rule has legitimate exceptions, and a gate would either
 * be ignored or start rewarding evasion. Run it before publishing a change:
 *
 *   node scripts/check-prose.mjs
 *
 * THE STANDARD
 *
 * A reader arrives knowing nothing. They have not seen a previous version,
 * they were not in the room, and they have no idea what was hard. Every line
 * should be true and useful to that person.
 *
 * Seven tests. The first four are the ones that actually catch things.
 *
 *  1. Time-travel   — does this only parse if you know an earlier version?
 *                     "used to", "now checks", "as of 0.18.8", "retired".
 *  2. Version tag   — does a build number appear in a sentence about behavior?
 *                     A version is a fact about a release, not about the app.
 *  3. Process       — workstream IDs, phase numbers, spec section marks, audit
 *                     finding numbers. Meaningless outside the team.
 *  4. Meta          — narrating the writing rather than doing it. "Worth
 *                     stating plainly", "said out loud", "deserves its own
 *                     sentence". If it is worth saying, say it.
 *  5. Self-grade    — the text marking its own homework. "Elegant", "the
 *                     interesting part", "a genuine achievement".
 *  6. Apology       — "unfortunately", "admittedly", "to be fair".
 *  7. Rebuttal      — naming a difficulty in order to dismiss it. This one
 *                     hides best. Removing a sentence about what changed often
 *                     leaves an argument against it: "fails rather than being
 *                     ignored", "there is nowhere to put one". The reader never
 *                     raised the objection; do not hand them one to take away.
 *
 * The test that catches what the regexes cannot: read the line and ask whether
 * it would survive if the thing it refers to had always been this way. If the
 * sentence disappears, it was about the change, not the app.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Each rule: [name, regex, verdict]
// 'cut'    — almost always noise; remove on sight
// 'review' — often noise, sometimes load-bearing; read it
const RULES = [
  ['process-residue', /\b(WS\d|W\d\.\d|Phase \d\b|SPEC §|audit [A-Z]-\d|Drop \d\b|research §|copy v\d|\d\.\d+\.x lesson)/, 'cut'],
  ['time-travel', /\b(used to|previously|originally|at first|has since|as of \d+\.\d|we (added|removed|changed)|this change|the old |retired|is now |are now |now (checks|reads|says|does|enforces))\b/i, 'cut'],
  ['version-tag', /\((?:0|1)\.\d+\.\d+[^)]*\)|\b(?:0|1)\.\d+\.\d+:/, 'cut'],
  // 'said out loud' / 'stated plainly' are this project's words for disclosing
  // rather than hiding — behaviour, not commentary. Only the writing-about-the-
  // writing forms are flagged.
  ['meta-commentary', /\b(worth stating|worth saying|say this plainly|it should be said|deserves its own|to be clear,)/i, 'cut'],
  ['self-grade', /\b(elegant|genuine achievement|the interesting (part|work)|cleverly|beautifully|honestly,|obviously|of course,)/i, 'cut'],
  ['apology', /\b(sorry|apolog|unfortunately|forgive|admittedly|to be fair|for what it'?s worth)\b/i, 'cut'],
  ['rebuttal', /\b(rather than being|not a blocker|nowhere to put|could not have put|it isn'?t\.|nothing (about|here) (depends|requires))/i, 'review'],
];

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n')
  .filter(f => /\.(ts|tsx|mts|mjs|md|html)$/.test(f) && !f.startsWith('tests/.staged'));

const hits = {};
for (const f of files) {
  let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
  text.split('\n').forEach((line, i) => {
    const isComment = /^\s*(\/\/|\*|\/\*|<!--)/.test(line);
    const isMd = f.endsWith('.md');
    // HTML: prose only — skip <text>/<title> inside SVG, class names, attributes
    const isHtmlProse = f.endsWith('.html') && /<p[ >]|<li[ >]|<summary|<h\d/.test(line);
    if (!isComment && !isMd && !isHtmlProse) return;
    for (const [name, re, verdict] of RULES) {
      if (re.test(line)) (hits[name] ??= { verdict, list: [] }).list.push(`${f}:${i + 1}  ${line.trim().slice(0, 92)}`);
    }
  });
}
let total = 0;
for (const [name, { verdict, list }] of Object.entries(hits).sort((a, b) => b[1].list.length - a[1].list.length)) {
  total += list.length;
  console.log(`\n### ${name} [${verdict}] — ${list.length}`);
  list.slice(0, 4).forEach(l => console.log('  ' + l));
  if (list.length > 4) console.log(`  … ${list.length - 4} more`);
}
console.log(`\nTOTAL: ${total}`);
