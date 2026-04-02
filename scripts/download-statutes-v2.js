#!/usr/bin/env node
// Download missing NC statute sections identified in gap analysis
// Supplement to the original 116-section download

const https = require('https');
const fs = require('fs');
const path = require('path');

const TEMP_DIR = '/tmp/nc-statutes-download';
fs.mkdirSync(TEMP_DIR, { recursive: true });

const SECTION_BASE = 'https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection';

// GAP SECTIONS — all missing from original download
const SECTIONS = [
  // === GAP 1: Evidence Code (Chapter 8C) — Critical for trial ===
  { ch: '8C', sec: 'GS_8C-1,_Rule_201', name: 'Judicial-Notice' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_401', name: 'Relevance-Definition' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_402', name: 'Relevant-Evidence-Admissible' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_403', name: 'Exclusion-Prejudice' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_408', name: 'Compromise-Offers' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_602', name: 'Personal-Knowledge' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_611', name: 'Mode-Interrogation' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_801', name: 'Hearsay-Definitions' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_802', name: 'Hearsay-Rule' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_803', name: 'Hearsay-Exceptions-Available' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_804', name: 'Hearsay-Exceptions-Unavailable' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_805', name: 'Hearsay-Within-Hearsay' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_901', name: 'Authentication-Requirement' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_902', name: 'Self-Authentication' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_1001', name: 'Best-Evidence-Definitions' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_1002', name: 'Requirement-of-Original' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_1003', name: 'Admissibility-Duplicates' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_1004', name: 'Admissibility-Other-Evidence' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_1005', name: 'Public-Records' },
  { ch: '8C', sec: 'GS_8C-1,_Rule_1006', name: 'Summaries' },

  // === GAP 2: Chapter 32C — Missing critical POA sections ===
  { ch: '32C', sec: 'GS_32C-1-103', name: 'POA-Applicability' },
  { ch: '32C', sec: 'GS_32C-1-104', name: 'POA-Durability' },
  { ch: '32C', sec: 'GS_32C-1-106', name: 'POA-Validity' },
  { ch: '32C', sec: 'GS_32C-1-107', name: 'POA-Meaning-Effect' },
  { ch: '32C', sec: 'GS_32C-1-109', name: 'POA-When-Effective' },
  { ch: '32C', sec: 'GS_32C-1-115', name: 'POA-Exoneration-Agent' },
  { ch: '32C', sec: 'GS_32C-1-116', name: 'POA-Judicial-Relief' },
  { ch: '32C', sec: 'GS_32C-1-117', name: 'POA-Agent-Liability' },
  { ch: '32C', sec: 'GS_32C-2-202', name: 'POA-Incorporation-Authority' },
  { ch: '32C', sec: 'GS_32C-2-203', name: 'POA-Construction-Authority' },
  { ch: '32C', sec: 'GS_32C-2-208', name: 'POA-Banks-Financial-Institutions' },
  { ch: '32C', sec: 'GS_32C-2-212', name: 'POA-Claims-Litigation' },
  { ch: '32C', sec: 'GS_32C-3-301', name: 'POA-Statutory-Form' },

  // === GAP 3: Chapter 58 Art. 70 — Missing debt buyer sections ===
  { ch: '58', sec: 'GS_58-70-135', name: 'Debt-Buyer-Records-Required' },
  { ch: '58', sec: 'GS_58-70-140', name: 'Debt-Buyer-Prohibited-Conduct' },

  // === GAP 4: Costs & Attorney Fees (Chapter 6) ===
  { ch: '6', sec: 'GS_6-20', name: 'Costs-Allowed-To-Parties' },
  { ch: '6', sec: 'GS_6-21', name: 'Costs-Voluntary-Dismissal' },
  { ch: '6', sec: 'GS_6-21.5', name: 'Attorney-Fees-Nonjusticiable' },

  // === GAP 5: Appeals ===
  { ch: '7A', sec: 'GS_7A-27', name: 'Appeals-Right-Trial-Divisions' },
  { ch: '7A', sec: 'GS_7A-28', name: 'Appeals-Right-Appellate' },
  { ch: '1', sec: 'GS_1-277', name: 'Appeal-Interlocutory-Orders' },
  { ch: '1', sec: 'GS_1-278', name: 'Orders-Substantial-Rights' },
  { ch: '1', sec: 'GS_1-294', name: 'Stay-Execution-Pending-Appeal' },

  // === GAP 6: Interest/Damages (Chapter 24) ===
  { ch: '24', sec: 'GS_24-1', name: 'Legal-Rate-of-Interest' },
  { ch: '24', sec: 'GS_24-5', name: 'Finance-Charges-Revolving-Credit' },
  { ch: '24', sec: 'GS_24-10', name: 'Interest-on-Judgments' },

  // === GAP 7: UCC — Assignment/Transfer of Debt ===
  { ch: '25', sec: 'GS_25-3-301', name: 'UCC-Person-Entitled-Enforce' },
  { ch: '25', sec: 'GS_25-3-302', name: 'UCC-Holder-in-Due-Course' },
  { ch: '25', sec: 'GS_25-3-203', name: 'UCC-Transfer-of-Instrument' },
  { ch: '25', sec: 'GS_25-3-305', name: 'UCC-Defenses-Claims-Recoupment' },
  { ch: '25', sec: 'GS_25-9-404', name: 'UCC-Rights-Acquired-Assignee' },
  { ch: '25', sec: 'GS_25-9-406', name: 'UCC-Discharge-Account-Debtor' },

  // === GAP 8: UDAP Attorney Fees ===
  { ch: '75', sec: 'GS_75-16.1', name: 'Attorney-Fees-UDAP' },

  // === GAP 9: Chapter 1 — Assignment/Standing ===
  { ch: '1', sec: 'GS_1-57', name: 'Assignee-Right-to-Sue' },
  { ch: '1', sec: 'GS_1-75.4', name: 'Personal-Jurisdiction' },
];

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Gap Analysis: Downloading Missing Statute Sections ===\n');

  let success = 0;
  let fail = 0;

  for (let i = 0; i < SECTIONS.length; i++) {
    const { ch, sec, name } = SECTIONS[i];
    const url = `${SECTION_BASE}/Chapter_${ch}/${sec}.html`;
    const outFile = path.join(TEMP_DIR, `${sec}.html`);

    // Skip if already downloaded
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 100) {
      console.log(`  [${i + 1}/${SECTIONS.length}] ⊘ ${sec} (already exists)`);
      success++;
      await sleep(50);
      continue;
    }

    try {
      const data = await download(url);
      fs.writeFileSync(outFile, data);
      const sizeKb = (data.length / 1024).toFixed(1);
      console.log(`  [${i + 1}/${SECTIONS.length}] ✓ ${sec} (${name}) - ${sizeKb}KB`);
      success++;
    } catch (err) {
      console.log(`  [${i + 1}/${SECTIONS.length}] ✗ ${sec}: ${err.message}`);
      fail++;
    }
    await sleep(150);
  }

  console.log(`\n=== Complete: ${success} succeeded, ${fail} failed ===`);
}

main().catch(console.error);
