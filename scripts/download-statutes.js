#!/usr/bin/env node
// Download NC General Statutes for legal research library
// Pulls full chapter HTML and individual section HTML from ncleg.gov

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const RESEARCH_DIR = '/Users/jacobmolz/cowork/sofi/07_Research/statutes';
const TEMP_DIR = '/tmp/nc-statutes-download';

fs.mkdirSync(RESEARCH_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

const CHAPTER_BASE = 'https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByChapter';
const SECTION_BASE = 'https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection';

// Full chapters to download
const CHAPTERS = {
  '1': 'Civil_Procedure',
  '1A': 'Rules_of_Civil_Procedure',
  '7A': 'Judicial_Department',
  '58': 'Insurance',
  '75': 'Consumer_Protection',
  '32C': 'Uniform_Power_of_Attorney_Act',
  '8C': 'Evidence_Code',
};

// Individual sections for quick-reference extraction
const SECTIONS = [
  // Chapter 1 - Statute of Limitations
  { ch: '1', sec: 'GS_1-15', name: 'Limitation-Personal-Actions' },
  { ch: '1', sec: 'GS_1-52', name: 'Three-Year-SOL' },
  { ch: '1', sec: 'GS_1-53', name: 'Ten-Year-SOL' },
  { ch: '1', sec: 'GS_1-56', name: 'Counterclaims-SOL' },
  // Chapter 1A - ALL Rules of Civil Procedure
  { ch: '1A', sec: 'GS_1A-1,_Rule_3', name: 'Commencement-of-Action' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_4', name: 'Process' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_5', name: 'Service-Filing-Pleadings' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_6', name: 'Time' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_7', name: 'Pleadings' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_8', name: 'General-Rules-Pleading' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_9', name: 'Pleading-Special-Matters' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_10', name: 'Form-Pleadings' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_11', name: 'Signing-Verification' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_12', name: 'Defenses-Objections' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_13', name: 'Counterclaim-Crossclaim' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_14', name: 'Third-Party-Practice' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_15', name: 'Amended-Supplemental-Pleadings' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_16', name: 'Pre-Trial-Procedure' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_17', name: 'Parties-Plaintiff-Defendant' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_18', name: 'Joinder-Claims' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_19', name: 'Necessary-Joinder-Parties' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_20', name: 'Permissive-Joinder' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_21', name: 'Misjoinder-Nonjoinder' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_22', name: 'Interpleader' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_23', name: 'Class-Actions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_24', name: 'Intervention' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_25', name: 'Substitution-Parties' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_26', name: 'Discovery-General' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_27', name: 'Depositions-Before-Action' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_28', name: 'Persons-Before-Whom-Depositions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_29', name: 'Stipulations-Discovery' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_30', name: 'Depositions-Oral-Examination' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_31', name: 'Depositions-Written-Questions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_32', name: 'Use-Depositions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_33', name: 'Interrogatories' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_34', name: 'Production-Documents' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_35', name: 'Physical-Mental-Examination' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_36', name: 'Requests-Admission' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_37', name: 'Discovery-Sanctions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_38', name: 'Jury-Trial-Right' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_39', name: 'Trial-By-Jury' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_40', name: 'Assignment-Cases-Trial' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_41', name: 'Dismissal-Actions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_42', name: 'Consolidation-Separate-Trials' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_43', name: 'Evidence' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_44', name: 'Proof-Official-Record' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_45', name: 'Subpoena' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_46', name: 'Exceptions-Unnecessary' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_47', name: 'Jurors' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_48', name: 'Juries-Six' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_49', name: 'Verdicts' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_50', name: 'Directed-Verdict-JNOV' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_51', name: 'Instructions-Jury' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_52', name: 'Findings-by-Court' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_53', name: 'Referees' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_54', name: 'Judgments' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_55', name: 'Default' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_56', name: 'Summary-Judgment' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_57', name: 'Declaratory-Judgments' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_58', name: 'Entry-of-Judgment' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_59', name: 'New-Trials-Amendment' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_60', name: 'Relief-from-Judgment' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_61', name: 'Harmless-Error' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_62', name: 'Stay-Proceedings' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_63', name: 'Disability-Judge' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_64', name: 'Seizure-Property' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_65', name: 'Injunctions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_68', name: 'Offer-Judgment' },
  // Chapter 7A - Jurisdiction & Division (Article 24)
  { ch: '7A', sec: 'GS_7A-240', name: 'Definitions-Civil-Actions' },
  { ch: '7A', sec: 'GS_7A-241', name: 'Unlimited-Jurisdiction' },
  { ch: '7A', sec: 'GS_7A-242', name: 'Original-Jurisdiction-Superior' },
  { ch: '7A', sec: 'GS_7A-243', name: 'Proper-Division-Amount' },
  { ch: '7A', sec: 'GS_7A-244', name: 'Waiver-Proper-Division' },
  { ch: '7A', sec: 'GS_7A-245', name: 'Concurrent-Jurisdiction-Special' },
  { ch: '7A', sec: 'GS_7A-246', name: 'Exclusive-Jurisdiction-District' },
  { ch: '7A', sec: 'GS_7A-247', name: 'Jurisdiction-Small-Claims' },
  { ch: '7A', sec: 'GS_7A-248', name: 'Counterclaims-Effect' },
  { ch: '7A', sec: 'GS_7A-249', name: 'Joinder-Effect' },
  { ch: '7A', sec: 'GS_7A-250', name: 'Jurisdiction-Uncontested' },
  { ch: '7A', sec: 'GS_7A-251', name: 'Exclusive-Jurisdiction-Probate' },
  { ch: '7A', sec: 'GS_7A-252', name: 'Appeals-Admin-Agencies' },
  { ch: '7A', sec: 'GS_7A-253', name: 'Proper-Venue' },
  { ch: '7A', sec: 'GS_7A-254', name: 'Consolidation-Actions' },
  { ch: '7A', sec: 'GS_7A-255', name: 'Change-Venue' },
  { ch: '7A', sec: 'GS_7A-256', name: 'Transfer-Cases-Between' },
  { ch: '7A', sec: 'GS_7A-257', name: 'Transfer-Improper-County' },
  { ch: '7A', sec: 'GS_7A-258', name: 'Motion-to-Transfer' },
  { ch: '7A', sec: 'GS_7A-259', name: 'Procedure-Upon-Transfer' },
  // Chapter 7A - District Court General (Article 15)
  { ch: '7A', sec: 'GS_7A-146', name: 'Powers-Chief-District-Judge' },
  { ch: '7A', sec: 'GS_7A-190', name: 'District-Court-Jurisdiction-Civil' },
  { ch: '7A', sec: 'GS_7A-191', name: 'District-Court-Jurisdiction-Criminal' },
  // Chapter 58 - Collection Agency Act (Article 70)
  { ch: '58', sec: 'GS_58-70-1', name: 'Collection-Agency-Definitions' },
  { ch: '58', sec: 'GS_58-70-15', name: 'Collection-Agency-Permit-Required' },
  { ch: '58', sec: 'GS_58-70-70', name: 'Collection-Agency-Prohibited-Acts' },
  { ch: '58', sec: 'GS_58-70-90', name: 'Collection-Agency-Civil-Liability' },
  { ch: '58', sec: 'GS_58-70-115', name: 'Debt-Buyer-Definition' },
  { ch: '58', sec: 'GS_58-70-120', name: 'Debt-Buyer-Registration' },
  { ch: '58', sec: 'GS_58-70-125', name: 'Debt-Buyer-Collection-Restrictions' },
  { ch: '58', sec: 'GS_58-70-130', name: 'Debt-Buyer-Required-Disclosures' },
  { ch: '58', sec: 'GS_58-70-145', name: 'Debt-Buyer-Statute-Limitations' },
  { ch: '58', sec: 'GS_58-70-150', name: 'Debt-Buyer-Litigation' },
  { ch: '58', sec: 'GS_58-70-155', name: 'Debt-Buyer-Documentation-Required' },
  // Chapter 75 - NC Debt Collection Act (§§ 75-50 to 75-56)
  { ch: '75', sec: 'GS_75-50', name: 'Debt-Collection-Definitions' },
  { ch: '75', sec: 'GS_75-51', name: 'Debt-Collection-Communication' },
  { ch: '75', sec: 'GS_75-52', name: 'Debt-Collection-Deception' },
  { ch: '75', sec: 'GS_75-53', name: 'Debt-Collection-Threats' },
  { ch: '75', sec: 'GS_75-54', name: 'Debt-Collection-Unfair-Practices' },
  { ch: '75', sec: 'GS_75-55', name: 'Debt-Collection-Remedies' },
  { ch: '75', sec: 'GS_75-56', name: 'Debt-Collection-Penalties' },
  // Chapter 75 - Unfair Trade Practices
  { ch: '75', sec: 'GS_75-1.1', name: 'Unfair-Trade-Practices' },
  { ch: '75', sec: 'GS_75-16', name: 'Civil-Action-Treble-Damages' },
  // Chapter 32C - Power of Attorney
  { ch: '32C', sec: 'GS_32C-1-102', name: 'POA-Definitions' },
  { ch: '32C', sec: 'GS_32C-1-110', name: 'POA-Agent-Duties' },
  { ch: '32C', sec: 'GS_32C-1-114', name: 'POA-Agent-Liability' },
  { ch: '32C', sec: 'GS_32C-2-201', name: 'POA-Authority-Agent' },
  { ch: '32C', sec: 'GS_32C-2-205', name: 'POA-Termination' },
];

function download(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve).catch(reject);
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
  console.log('=== NC General Statutes Downloader ===\n');

  // Download full chapter HTML files
  console.log('--- Full Chapter HTML Files ---');
  for (const [ch, name] of Object.entries(CHAPTERS)) {
    const url = `${CHAPTER_BASE}/Chapter_${ch}.html`;
    const outFile = path.join(RESEARCH_DIR, `Chapter_${ch}_${name}.html`);
    try {
      const data = await download(url);
      fs.writeFileSync(outFile, data);
      console.log(`  ✓ Chapter ${ch} (${name}): ${data.length} bytes`);
    } catch (err) {
      console.log(`  ✗ Chapter ${ch}: ${err.message}`);
    }
    await sleep(200);
  }

  // Download individual sections
  console.log('\n--- Individual Statute Sections ---');
  let success = 0;
  let fail = 0;
  for (let i = 0; i < SECTIONS.length; i++) {
    const { ch, sec, name } = SECTIONS[i];
    const url = `${SECTION_BASE}/Chapter_${ch}/${sec}.html`;
    const outFile = path.join(TEMP_DIR, `${sec}.html`);
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
  console.log(`Chapter files: ${RESEARCH_DIR}`);
  console.log(`Section files: ${TEMP_DIR}`);
}

main().catch(console.error);
