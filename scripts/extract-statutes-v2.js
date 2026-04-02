#!/usr/bin/env node
// Extract gap-analysis statute sections into markdown
// Creates new chapter files and updates existing ones

const fs = require('fs');
const path = require('path');

const TEMP_DIR = '/tmp/nc-statutes-download';
const OUTPUT_DIR = path.join(__dirname, '..', '07_Research', 'statutes');

// New chapter files to create
const NEW_CHAPTERS = {
  '8C': {
    title: 'Chapter 8C — NC Rules of Evidence',
    description: 'Authentication, hearsay, business records, best evidence — critical for challenging plaintiff\'s documentary evidence',
    file: 'Chapter_8C_Evidence_Code.md',
    sections: [
      { sec: 'GS_8C-1,_Rule_201', name: 'Rule 201. Judicial notice of adjudicative facts' },
      { sec: 'GS_8C-1,_Rule_401', name: 'Rule 401. Definition of "relevant evidence"' },
      { sec: 'GS_8C-1,_Rule_402', name: 'Rule 402. Relevant evidence generally admissible' },
      { sec: 'GS_8C-1,_Rule_403', name: 'Rule 403. Exclusion of relevant evidence on grounds of prejudice' },
      { sec: 'GS_8C-1,_Rule_408', name: 'Rule 408. Compromise and offers to compromise' },
      { sec: 'GS_8C-1,_Rule_602', name: 'Rule 602. Lack of personal knowledge' },
      { sec: 'GS_8C-1,_Rule_611', name: 'Rule 611. Mode and order of interrogation and presentation' },
      { sec: 'GS_8C-1,_Rule_801', name: 'Rule 801. Definitions and exception for admissions' },
      { sec: 'GS_8C-1,_Rule_802', name: 'Rule 802. Hearsay rule' },
      { sec: 'GS_8C-1,_Rule_803', name: 'Rule 803. Hearsay exceptions; availability of declarant immaterial' },
      { sec: 'GS_8C-1,_Rule_804', name: 'Rule 804. Hearsay exceptions; declarant unavailable' },
      { sec: 'GS_8C-1,_Rule_805', name: 'Rule 805. Hearsay within hearsay' },
      { sec: 'GS_8C-1,_Rule_901', name: 'Rule 901. Requirement of authentication or identification' },
      { sec: 'GS_8C-1,_Rule_902', name: 'Rule 902. Self-authentication' },
      { sec: 'GS_8C-1,_Rule_1001', name: 'Rule 1001. Definitions (best evidence)' },
      { sec: 'GS_8C-1,_Rule_1002', name: 'Rule 1002. Requirement of original' },
      { sec: 'GS_8C-1,_Rule_1003', name: 'Rule 1003. Admissibility of duplicates' },
      { sec: 'GS_8C-1,_Rule_1004', name: 'Rule 1004. Admissibility of other evidence of contents' },
      { sec: 'GS_8C-1,_Rule_1005', name: 'Rule 1005. Public records' },
      { sec: 'GS_8C-1,_Rule_1006', name: 'Rule 1006. Summaries' },
    ],
  },
  '6': {
    title: 'Chapter 6 — Costs and Attorney Fees',
    description: 'Costs allocation, attorney fees in nonjusticiable cases — relevant if standing/jurisdiction defense prevails',
    file: 'Chapter_6_Costs_Attorney_Fees.md',
    sections: [
      { sec: 'GS_6-20', name: '§ 6-20. Costs allowed to parties' },
      { sec: 'GS_6-21', name: '§ 6-21. Allowance of costs to defendant upon voluntary dismissal' },
      { sec: 'GS_6-21.5', name: '§ 6-21.5. Attorneys\' fees; nonjusticiable cases' },
    ],
  },
  '24': {
    title: 'Chapter 24 — Interest',
    description: 'Legal rate of interest, finance charges, prejudgment/postjudgment interest — relevant to plaintiff\'s claimed damages',
    file: 'Chapter_24_Interest.md',
    sections: [
      { sec: 'GS_24-1', name: '§ 24-1. Legal rate of interest' },
      { sec: 'GS_24-5', name: '§ 24-5. Finance charge rates on revolving credit' },
      { sec: 'GS_24-10', name: '§ 24-10. Rate of interest on judgments and decrees' },
    ],
  },
  '25': {
    title: 'Chapter 25 — Uniform Commercial Code (Selected Provisions)',
    description: 'UCC Article 3 (negotiable instruments) and Article 9 (secured transactions) — assignment/transfer of debt, holder in due course, defenses',
    file: 'Chapter_25_UCC_Selected.md',
    sections: [
      { sec: 'GS_25-3-203', name: '§ 25-3-203. Transfer of instrument; rights acquired by transfer' },
      { sec: 'GS_25-3-301', name: '§ 25-3-301. Person entitled to enforce instrument' },
      { sec: 'GS_25-3-302', name: '§ 25-3-302. Holder in due course' },
      { sec: 'GS_25-3-305', name: '§ 25-3-305. Defenses and claims in recoupment' },
      { sec: 'GS_25-9-404', name: '§ 25-9-404. Rights acquired by assignee; claims and defenses against assignee' },
      { sec: 'GS_25-9-406', name: '§ 25-9-406. Discharge of account debtor; notification of assignment' },
    ],
  },
};

// Sections to append to EXISTING chapter files
const APPEND_CHAPTERS = {
  '32C': {
    file: 'Chapter_32C_Power_of_Attorney.md',
    sections: [
      { sec: 'GS_32C-1-103', name: '§ 32C-1-103. Applicability' },
      { sec: 'GS_32C-1-104', name: '§ 32C-1-104. Power of attorney is durable' },
      { sec: 'GS_32C-1-106', name: '§ 32C-1-106. Validity of power of attorney' },
      { sec: 'GS_32C-1-107', name: '§ 32C-1-107. Meaning and effect of power of attorney' },
      { sec: 'GS_32C-1-109', name: '§ 32C-1-109. When power of attorney effective' },
      { sec: 'GS_32C-1-115', name: '§ 32C-1-115. Exoneration of agent' },
      { sec: 'GS_32C-1-116', name: '§ 32C-1-116. Judicial relief' },
      { sec: 'GS_32C-1-117', name: '§ 32C-1-117. Agent\'s liability' },
      { sec: 'GS_32C-2-202', name: '§ 32C-2-202. Incorporation of authority' },
      { sec: 'GS_32C-2-203', name: '§ 32C-2-203. Construction of authority, generally' },
      { sec: 'GS_32C-2-208', name: '§ 32C-2-208. Banks and other financial institutions' },
      { sec: 'GS_32C-2-212', name: '§ 32C-2-212. Claims and litigation' },
      { sec: 'GS_32C-3-301', name: '§ 32C-3-301. Statutory form power of attorney' },
    ],
  },
  '7A': {
    file: 'Chapter_7A_Judicial_Department.md',
    sections: [
      { sec: 'GS_7A-27', name: '§ 7A-27. Appeals of right from courts of trial divisions' },
      { sec: 'GS_7A-28', name: '§ 7A-28. Appeals of right from Court of Appeals' },
    ],
  },
  '75': {
    file: 'Chapter_75_Consumer_Protection_Debt_Collection.md',
    sections: [
      { sec: 'GS_75-16.1', name: '§ 75-16.1. Civil action; attorney fees' },
    ],
  },
  '1': {
    file: 'Chapter_1_Civil_Procedure.md',
    sections: [
      { sec: 'GS_1-57', name: '§ 1-57. Assignee of thing in action' },
      { sec: 'GS_1-75.4', name: '§ 1-75.4. Personal jurisdiction, grounds for generally' },
      { sec: 'GS_1-277', name: '§ 1-277. Appeal lies from any interlocutory order or determination' },
      { sec: 'GS_1-278', name: '§ 1-278. Orders affecting a substantial right' },
      { sec: 'GS_1-294', name: '§ 1-294. Stay of execution pending appeal' },
    ],
  },
};

function stripHtml(html) {
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');
  text = text.replace(/<h[1-6][^>]*>/gi, '\n\n');
  text = text.replace(/<b>|<strong>/gi, '**');
  text = text.replace(/<\/b>|<\/strong>/gi, '**');
  text = text.replace(/<i>|<em>/gi, '*');
  text = text.replace(/<\/i>|<\/em>/gi, '*');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&apos;/g, "'");
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&sect;/g, '§');
  text = text.replace(/&mdash;/g, '—');
  text = text.replace(/&ndash;/g, '–');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&#160;/g, ' ');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  return text.trim();
}

function extractBody(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return stripHtml(bodyMatch ? bodyMatch[1] : html);
}

function readSection(sec) {
  const htmlFile = path.join(TEMP_DIR, `${sec}.html`);
  if (!fs.existsSync(htmlFile)) return '*[Section file not found]*';
  return extractBody(fs.readFileSync(htmlFile, 'utf-8'));
}

function buildChapterMd(info) {
  const lines = [];
  lines.push(`# ${info.title}`);
  lines.push('');
  lines.push(`> ${info.description}`);
  lines.push('');
  lines.push(`Case: Case Pilot research library`);
  lines.push(`Retrieved: 2026-02-23`);
  lines.push(`Sections: ${info.sections.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Table of Contents');
  lines.push('');
  for (const s of info.sections) {
    const anchor = s.sec.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    lines.push(`- [${s.name}](#${anchor})`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const s of info.sections) {
    lines.push(`## ${s.name}`);
    lines.push('');
    lines.push(readSection(s.sec));
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

function appendSections(filePath, sections) {
  let existing = fs.readFileSync(filePath, 'utf-8');

  // Update section count in header
  const countMatch = existing.match(/Sections: (\d+)/);
  if (countMatch) {
    const oldCount = parseInt(countMatch[1]);
    const newCount = oldCount + sections.length;
    existing = existing.replace(`Sections: ${oldCount}`, `Sections: ${newCount}`);
  }

  // Add new TOC entries before the second ---
  const tocEndIdx = existing.indexOf('---', existing.indexOf('## Table of Contents'));
  if (tocEndIdx > 0) {
    const newTocEntries = sections.map(s => {
      const anchor = s.sec.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      return `- [${s.name}](#${anchor})`;
    }).join('\n');
    existing = existing.slice(0, tocEndIdx) + newTocEntries + '\n\n' + existing.slice(tocEndIdx);
  }

  // Append sections at end
  const appendLines = [];
  for (const s of sections) {
    appendLines.push(`## ${s.name}`);
    appendLines.push('');
    appendLines.push(readSection(s.sec));
    appendLines.push('');
    appendLines.push('---');
    appendLines.push('');
  }
  existing += '\n' + appendLines.join('\n');

  fs.writeFileSync(filePath, existing);
  return sections.length;
}

function main() {
  console.log('=== Extracting Gap-Analysis Sections ===\n');

  let totalNew = 0;

  // Create new chapter files
  console.log('--- New Chapter Files ---');
  for (const [ch, info] of Object.entries(NEW_CHAPTERS)) {
    const content = buildChapterMd(info);
    const outFile = path.join(OUTPUT_DIR, info.file);
    fs.writeFileSync(outFile, content);
    const sizeKb = (content.length / 1024).toFixed(1);
    console.log(`  ✓ ${info.file} — ${info.sections.length} sections, ${sizeKb}KB`);
    totalNew += info.sections.length;
  }

  // Append to existing chapter files
  console.log('\n--- Updated Existing Chapter Files ---');
  for (const [ch, info] of Object.entries(APPEND_CHAPTERS)) {
    const filePath = path.join(OUTPUT_DIR, info.file);
    if (!fs.existsSync(filePath)) {
      console.log(`  ✗ ${info.file} not found, skipping`);
      continue;
    }
    const count = appendSections(filePath, info.sections);
    const sizeKb = (fs.statSync(filePath).size / 1024).toFixed(1);
    console.log(`  ✓ ${info.file} — +${count} sections (now ${sizeKb}KB)`);
    totalNew += count;
  }

  console.log(`\n=== Complete: ${totalNew} new sections added ===`);
}

main();
