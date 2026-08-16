/**
 * Minimal PDF writer for desk reports — zero dependencies.
 *
 * Multi-page, Helvetica text, ASCII-safe (non-ASCII folded to '?': the desk
 * report is English by convention, and honesty beats typography). No images,
 * no fonts embedded — the base-14 Helvetica every PDF reader ships.
 * Deliberately tiny: a report PDF is a convenience rendering of the signed
 * JSON, which remains the canonical artifact.
 */

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN = 54;
const LINE_H = 14;
const FONT_SIZE = 10;
const TITLE_SIZE = 16;
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LINE_H);

export interface PdfLine {
  text: string;
  bold?: boolean;
}

function escapePdf(s: string): string {
  // Sensible folds first (typography the report actually uses), then any
  // remaining non-ASCII becomes '?'. Control chars are dropped outright.
  return s
    .replace(/[—–]/g, '-')
    .replace(/…/g, '...')
    .replace(/↔/g, '<->')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/×/g, 'x')
    .replace(/é/g, 'e')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) > maxChars) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** Renders report lines to a complete PDF file (as bytes). */
export function buildPdf(title: string, subtitle: string, body: PdfLine[]): Uint8Array {
  const maxChars = 92;
  const logical: PdfLine[] = [
    { text: title, bold: true },
    { text: subtitle },
    { text: '' },
    ...body,
  ];
  // Wrap long lines, then paginate.
  const wrapped: PdfLine[] = [];
  for (const l of logical) {
    const parts = l.text ? wrap(l.text, maxChars) : [''];
    parts.forEach((text, i) => wrapped.push({ text, bold: l.bold && i === 0 }));
  }
  const pages: PdfLine[][] = [];
  for (let i = 0; i < wrapped.length; i += LINES_PER_PAGE) {
    pages.push(wrapped.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push([]);

  // Object numbering: 1 catalog, 2 pages tree, 3 font, 4 font-bold,
  // then per page: content stream obj + page obj.
  const objects: string[] = [];
  const pageRefs: string[] = [];

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';

  let nextId = 5;
  const pageObjs: { contentId: number; pageId: number }[] = [];
  for (const pageLines of pages) {
    const contentId = nextId++;
    const pageId = nextId++;
    pageObjs.push({ contentId, pageId });

    let y = PAGE_H - MARGIN;
    const ops: string[] = [];
    for (const l of pageLines) {
      const font = l.bold ? 'F2' : 'F1';
      const size = l.bold ? TITLE_SIZE : FONT_SIZE;
      if (l.text) {
        ops.push(`BT /${font} ${size} Tf ${MARGIN} ${y} Td (${escapePdf(l.text)}) Tj ET`);
      }
      y -= l.bold ? LINE_H * 1.6 : LINE_H;
    }
    const stream = ops.join('\n');
    objects[contentId - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objects[pageId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    pageRefs.push(`${pageId} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>`;

  // Assemble with a real xref table.
  let out = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
