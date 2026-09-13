// Source Kit 0.1.0 — the second camera's frames as a file carries them
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The second camera's frames as a file carries them: componentOf
 * ingredients with thumbnails, embedded at seal time. Both detail screens
 * read them through this one function, so an exported video and a vaulted
 * one show the same filmstrip from the same bytes.
 */

import type { C2paManifest } from '../../../archive/handrolled-verifier/c2pa';
import { bytesToBase64 } from '../../lib/bytes';
import type { VideoPairFrameRef } from './MultipleLensCard';

/**
 * The sealed telemetry record does not carry the video pair frames; they
 * ride the proof bundle on the device. In the file itself they are the
 * c2pa.thumbnail.ingredient.jpeg{.#} boxes, one per committed pair, and
 * the embedded frame is the vaulted pair JPEG byte for byte, since the
 * ingredient's data hash commits exactly these bytes. This surfaces them:
 * referenced-gated, because an unreferenced box is not claim content, and
 * labeled by the capture-side pair sequence number parsed from the label
 * suffix or the ingredient title. Nothing is fabricated; absent boxes
 * still read "Not recorded".
 */
export function manifestSecondaryFrames(manifest: C2paManifest): VideoPairFrameRef[] {
  const titlePairIndex = new Map<string, number>();
  for (const ing of manifest.ingredients) {
    // Pair sequence number from the ingredient title: 'pair #N' (our
    // writer) or 'verify-pair-N.jpg' (the SDK path).
    const m = ing.title ? (/pair #(\d+)/.exec(ing.title) ?? /verify-pair-(\d+)/.exec(ing.title)) : null;
    if (m && ing.label) {
      // The ingredient's thumbnail identifier is the ingredient label with
      // the same instance suffix — '.N' from our writer, '__N' from
      // c2pa-rs and the c2pa-swift SDK ('c2pa.thumbnail.ingredient__1').
      const sm = /(?:\.(\d+)|__(\d+))$/.exec(ing.label ?? '');
      const suffix = sm ? (sm[1] !== undefined ? `.${sm[1]}` : `__${sm[2]}`) : '';
      titlePairIndex.set(suffix, parseInt(m[1], 10));
    }
  }
  const frames: VideoPairFrameRef[] = [];
  for (const t of manifest.thumbnails) {
    if (!t.referenced) continue;
    // Both emission families: our writer's image content boxes
    // 'c2pa.thumbnail.ingredient.jpeg(.N)', and the SDK's bfdb/bidb
    // resources normalized by c2pa-rs to 'c2pa.thumbnail.ingredient(__N)'.
    const lm = /^c2pa\.thumbnail\.ingredient(?:\.(?:jpeg|png))?((?:\.\d+|__\d+)?)$/.exec(t.label);
    if (!lm) continue;
    if (t.bytes.length === 0) continue;
    const suffix = lm[1] ?? '';
    const pairIndex = titlePairIndex.get(suffix)
      ?? (suffix ? parseInt(suffix.replace(/^\.|^__/, ''), 10) : 0);
    frames.push({
      frame: { dataBase64: bytesToBase64(t.bytes), mime: 'image/jpeg' },
      pairIndex,
    });
  }
  frames.sort((a, b) => a.pairIndex - b.pairIndex);
  return frames;
}
