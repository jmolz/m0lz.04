'use strict';
/**
 * Programmatic DOCX builder for NC District Court filings.
 * Replaces Pandoc with full control over court-ready formatting:
 *   - Times New Roman 12pt, double-spaced body
 *   - 1-inch margins, letter size, page numbers centered bottom
 *   - Proper two-column caption table
 *   - Bold left-aligned section headings
 *   - Numbered paragraphs with hanging indent
 *   - Signature lines with spacing
 *   - Page break before Certificate of Service
 */

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, Footer, BorderStyle, WidthType,
  convertInchesToTwip, PageNumber, TableLayoutType,
} = require('docx');

// ── Formatting constants ───────────────────────────────────────────────────

const FONT = 'Times New Roman';
const PT = 2; // half-point multiplier
const SIZE = 12 * PT;
const SIZE_SM = 10 * PT;
const DOUBLE = 480;
const SINGLE = 240;
const INCH = 1440;

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = {
  top: NO_BORDER, bottom: NO_BORDER,
  left: NO_BORDER, right: NO_BORDER,
};

// ── Inline formatting ──────────────────────────────────────────────────────

function runs(text, extra) {
  const e = extra || {};
  if (!text) return [new TextRun({ text: '', font: FONT, size: SIZE, ...e })];
  const result = [];
  const parts = text.split(/(\*\*(?:[^*]|\*(?!\*))+\*\*)/g);
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith('**') && p.endsWith('**')) {
      result.push(new TextRun({ text: p.slice(2, -2), font: FONT, size: SIZE, bold: true, ...e }));
    } else {
      result.push(new TextRun({ text: p, font: FONT, size: SIZE, ...e }));
    }
  }
  return result.length ? result : [new TextRun({ text: '', font: FONT, size: SIZE, ...e })];
}

// ── Caption extraction & table ─────────────────────────────────────────────

function findCaptionEnd(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/Defendant\.\s*$/.test(lines[i].trim())) return i;
  }
  return -1;
}

function extractCaption(captionLines) {
  const lines = (Array.isArray(captionLines) ? captionLines : []).map((l) => String(l || '').trim());
  const text = lines.join('\n');
  const d = {
    state: 'STATE OF NORTH CAROLINA',
    county: 'COUNTY',
    court: 'IN THE GENERAL COURT OF JUSTICE',
    division: 'DISTRICT COURT DIVISION',
    fileNo: '',
    plaintiffLines: ['Plaintiff'],
    defendantLines: ['DEFENDANT'],
    title: [],
  };

  const boundary = /^(STATE OF|IN THE GENERAL COURT|COURT OF JUSTICE|DISTRICT COURT|SUPERIOR COURT|COUNTY|File\s+No\.|vs\.?$)/i;

  const fileM = text.match(/File\s+No\.?:?\s*([^\n]+)/i);
  if (fileM) d.fileNo = 'File No.: ' + fileM[1].trim();

  for (let i = 0; i < lines.length; i++) {
    if (/COUNTY\s*$/i.test(lines[i])) {
      d.county = lines[i];
      break;
    }
  }

  const collectPartyLines = (labelRegex, fallbackLines) => {
    const idx = lines.findIndex((line) => labelRegex.test(line));
    if (idx === -1) return fallbackLines;

    const labelLine = lines[idx];
    const inline = labelLine.replace(labelRegex, '').replace(/^\s*,?\s*|\s*,?\s*$/g, '');
    if (inline) return [inline];

    const collected = [];
    for (let i = idx - 1; i >= 0; i -= 1) {
      const t = lines[i];
      if (!t || boundary.test(t)) break;
      if (/\b(plaintiff|defendant)\b/i.test(t)) break;
      collected.unshift(t.replace(/,\s*$/, ''));
    }
    return collected.length ? collected : fallbackLines;
  };

  d.plaintiffLines = collectPartyLines(/^\s*Plaintiff\s*[,.]?\s*$/i, d.plaintiffLines);
  d.defendantLines = collectPartyLines(/^\s*Defendant\s*[,.]?\s*$/i, d.defendantLines);

  const vsIdx = lines.findIndex((line) => /^\s*vs\.?/i.test(line));
  if (vsIdx !== -1) {
    const first = lines[vsIdx].replace(/^\s*vs\.?\s*/i, '').trim();
    if (first) d.title.push(first);
    for (let i = vsIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) {
        if (d.title.length) break;
        continue;
      }
      if (/\bDefendant\b/i.test(t)) break;
      if (/^\s*defendant\b/i.test(t)) break;
      if (boundary.test(t) || /^\s*Plaintiff\b/i.test(t)) continue;
      d.title.push(t);
    }
  }

  return d;
}

function captionCell(lines, width) {
  const paras = lines.map((l) => {
    const item = typeof l === 'string' ? { text: l } : l;
    return new Paragraph({
      children: item.text
        ? [new TextRun({ text: item.text, font: FONT, size: SIZE, bold: !!item.bold })]
        : [],
      spacing: { line: SINGLE, before: 0, after: 0 },
      indent: item.indent ? { left: item.indent } : undefined,
    });
  });
  return new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    children: paras.length
      ? paras
      : [new Paragraph({ spacing: { line: SINGLE, before: 0, after: 0 } })],
  });
}

function captionRow(leftLines, rightLines) {
  return new TableRow({
    children: [
      captionCell(leftLines, 50),
      captionCell(rightLines, 50),
    ],
  });
}

function buildCaptionTable(d) {
  const IND_PARTY = convertInchesToTwip(0.6);
  const IND_VS = convertInchesToTwip(0.3);

  const addTrailingCommaToLast = (items) => {
    const lines = Array.isArray(items) && items.length ? items.slice() : [''];
    const last = lines.length - 1;
    lines[last] = `${String(lines[last] || '').replace(/,\s*$/, '')},`;
    return lines;
  };

  const plaintiffLines = addTrailingCommaToLast(d.plaintiffLines);
  const defendantLines = addTrailingCommaToLast(d.defendantLines);

  const tableRows = [
    // STATE + COUNTY stacked left | COURT + DIVISION stacked right
    captionRow([d.state, d.county], [d.court, d.division]),
    // blank spacer
    captionRow([''], ['']),
    // (empty) | File No.
    captionRow([''], [d.fileNo]),
    // blank separator
    captionRow([''], ['']),
    // Plaintiff name (supports multiline)
    captionRow(plaintiffLines, ['']),
    // "Plaintiff," indented
    captionRow([{ text: 'Plaintiff,', indent: IND_PARTY }], ['']),
    // blank
    captionRow([''], ['']),
    // vs. | document title (all title lines stacked in right cell)
    captionRow(
      [{ text: 'vs.', indent: IND_VS }],
      d.title.length ? d.title.map((t) => ({ text: t, bold: true })) : [''],
    ),
    // Defendant name (supports multiline)
    captionRow(defendantLines, ['']),
    // "Defendant." indented
    captionRow([{ text: 'Defendant.', indent: IND_PARTY }], ['']),
  ];

  return new Table({
    rows: tableRows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: {
      top: NO_BORDER, bottom: NO_BORDER,
      left: NO_BORDER, right: NO_BORDER,
      insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
    },
  });
}

// ── Horizontal rule ────────────────────────────────────────────────────────

function hrParagraph() {
  return new Paragraph({
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 },
    },
    spacing: { before: 120, after: 200 },
  });
}

// ── Body parser ────────────────────────────────────────────────────────────

function parseBody(bodyLines) {
  const elements = [];
  let zone = 'body';

  for (const raw of bodyLines) {
    const t = raw.trim();

    if (!t) { elements.push({ type: 'blank', zone }); continue; }

    if (/^CERTIFICATE OF SERVICE\s*$/i.test(t)) {
      zone = 'cos';
      elements.push({ type: 'cos_heading', text: t });
      continue;
    }

    if (/^_{5,}$/.test(t)) {
      elements.push({ type: 'sig_line', zone });
      continue;
    }

    if (/^Respectfully submitted/i.test(t)) {
      zone = 'signature';
      elements.push({ type: 'para', text: t, zone });
      continue;
    }

    // Bold Roman-numeral section heading: **I. TEXT** or **II. TEXT**
    if (/^\*\*[IVX]+\.\s/.test(t) && /\*\*\s*$/.test(t)) {
      elements.push({ type: 'heading', text: t });
      continue;
    }

    if (/^\*\*WHEREFORE\*\*/.test(t)) {
      elements.push({ type: 'para', text: t, zone: 'body' });
      continue;
    }

    // Numbered paragraph: 1. text
    if (/^\d+\.\s/.test(t)) {
      elements.push({ type: 'numbered', text: t, zone });
      continue;
    }

    // Parenthetical sub-item: (1) through (99) — not phone numbers like (954)
    if (/^\([1-9]\d?\)\s/.test(t)) {
      elements.push({ type: 'sub_item', text: t, zone });
      continue;
    }

    // Bullet: - text or • text
    if (/^[-\u2022]\s/.test(t)) {
      elements.push({ type: 'bullet', text: t.replace(/^[-\u2022]\s*/, ''), zone });
      continue;
    }

    // Horizontal rule markers
    if (/^-{3,}$/.test(t) || /^\*{3,}$/.test(t)) {
      elements.push({ type: 'rule' });
      continue;
    }

    elements.push({ type: 'para', text: t, zone });
  }

  return elements;
}

// ── DOCX element builders ──────────────────────────────────────────────────

function buildDocxChildren(elements) {
  const out = [];
  let prevBlank = false;
  let cosBuffer = [];

  function flushCosBuffer() {
    if (!cosBuffer.length) return;
    const merged = cosBuffer.join(' ');
    out.push(new Paragraph({
      children: runs(merged),
      spacing: { before: 200, after: 0, line: SINGLE },
      alignment: AlignmentType.LEFT,
      keepNext: true,
    }));
    cosBuffer = [];
  }

  for (let idx = 0; idx < elements.length; idx++) {
    const el = elements[idx];
    if (el.type === 'blank') {
      // If we have a COS buffer building, a blank means the paragraph ended
      if (cosBuffer.length) flushCosBuffer();
      prevBlank = true;
      continue;
    }

    const compact = el.zone === 'signature' || el.zone === 'cos';

    // COS zone: merge consecutive para + bullet text into one flowing paragraph
    if (el.zone === 'cos' && (el.type === 'para' || el.type === 'bullet')) {
      cosBuffer.push(el.type === 'bullet' ? el.text + ',' : el.text);
      prevBlank = false;
      continue;
    }

    // Flush any pending COS buffer before rendering other element types
    if (cosBuffer.length) flushCosBuffer();

    switch (el.type) {
      case 'heading':
        out.push(new Paragraph({
          children: runs(el.text),
          alignment: AlignmentType.LEFT,
          spacing: { before: 240, after: 120, line: DOUBLE },
        }));
        break;

      case 'numbered':
        out.push(new Paragraph({
          children: runs(el.text),
          spacing: { before: prevBlank ? 200 : 0, after: 0, line: DOUBLE },
          indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.5) },
          alignment: AlignmentType.JUSTIFIED,
        }));
        break;

      case 'sub_item':
        out.push(new Paragraph({
          children: runs(el.text),
          spacing: { before: 0, after: 0, line: DOUBLE },
          indent: { left: convertInchesToTwip(0.5) },
          alignment: AlignmentType.JUSTIFIED,
        }));
        break;

      case 'bullet':
        out.push(new Paragraph({
          children: runs('\u2022  ' + el.text),
          spacing: { before: 0, after: 0, line: SINGLE },
          indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) },
        }));
        break;

      case 'sig_line':
        out.push(new Paragraph({
          children: [new TextRun({ text: '_________________________', font: FONT, size: SIZE })],
          spacing: { before: 960, after: 0, line: SINGLE },
          keepNext: true,
        }));
        break;

      case 'cos_heading':
        out.push(new Paragraph({
          children: [new TextRun({ text: el.text, font: FONT, size: SIZE, bold: true })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 240, after: 240, line: DOUBLE },
          pageBreakBefore: true,
        }));
        break;

      case 'rule':
        out.push(hrParagraph());
        break;

      case 'para':
        out.push(new Paragraph({
          children: runs(el.text),
          spacing: {
            before: prevBlank ? 200 : 0,
            after: 0,
            line: compact ? SINGLE : DOUBLE,
          },
          alignment: compact ? AlignmentType.LEFT : AlignmentType.JUSTIFIED,
          keepNext: compact || undefined,
        }));
        break;

      default:
        break;
    }

    prevBlank = false;
  }

  // Flush any remaining COS buffer
  if (cosBuffer.length) flushCosBuffer();

  return out;
}

// ── Main export ────────────────────────────────────────────────────────────

async function buildLegalDocx(markdown) {
  const lines = String(markdown || '').split('\n');
  const captionEnd = findCaptionEnd(lines);
  const children = [];

  if (captionEnd >= 0) {
    const captionData = extractCaption(lines.slice(0, captionEnd + 1));
    children.push(buildCaptionTable(captionData));
    children.push(hrParagraph());
    const bodyElements = parseBody(lines.slice(captionEnd + 1));
    children.push(...buildDocxChildren(bodyElements));
  } else {
    const bodyElements = parseBody(lines);
    children.push(...buildDocxChildren(bodyElements));
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: INCH, bottom: INCH, left: INCH, right: INCH },
        },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE_SM }),
            ],
          })],
        }),
      },
      children,
    }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildLegalDocx };
