#!/usr/bin/env node
// Extract NC statute text from downloaded HTML files and organize into markdown
// Groups sections by chapter into comprehensive reference files

const fs = require('fs');
const path = require('path');

const TEMP_DIR = '/tmp/nc-statutes-download';
const OUTPUT_DIR = path.join(__dirname, '..', '07_Research', 'statutes');

// Chapter metadata for organizing output
const CHAPTER_INFO = {
  '1': {
    title: 'Chapter 1 — Civil Procedure',
    description: 'Statutes of limitation, general civil procedure provisions',
    file: 'Chapter_1_Civil_Procedure.md',
  },
  '1A': {
    title: 'Chapter 1A — Rules of Civil Procedure',
    description: 'Complete NC Rules of Civil Procedure (Rules 3-68)',
    file: 'Chapter_1A_Rules_of_Civil_Procedure.md',
  },
  '7A': {
    title: 'Chapter 7A — Judicial Department',
    description: 'Court jurisdiction, proper division, venue, transfer of cases',
    file: 'Chapter_7A_Judicial_Department.md',
  },
  '58': {
    title: 'Chapter 58 — Insurance (Article 70: Collection Agencies & Debt Buyers)',
    description: 'Collection Agency Act, debt buyer registration, documentation requirements, litigation restrictions',
    file: 'Chapter_58_Art70_Collection_Agency_Debt_Buyers.md',
  },
  '75': {
    title: 'Chapter 75 — Monopolies, Trusts and Consumer Protection',
    description: 'NC Debt Collection Act (§§ 75-50 to 75-56), Unfair Trade Practices (§ 75-1.1)',
    file: 'Chapter_75_Consumer_Protection_Debt_Collection.md',
  },
  '32C': {
    title: 'Chapter 32C — NC Uniform Power of Attorney Act',
    description: 'POA definitions, agent authority and duties, termination',
    file: 'Chapter_32C_Power_of_Attorney.md',
  },
};

// Section definitions with chapter mapping
const SECTIONS = [
  { ch: '1', sec: 'GS_1-15', name: 'Limitation of personal actions' },
  { ch: '1', sec: 'GS_1-52', name: 'Three years' },
  { ch: '1', sec: 'GS_1-53', name: 'Ten years' },
  { ch: '1', sec: 'GS_1-56', name: 'Counterclaims and cross claims' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_3', name: 'Rule 3. Commencement of action' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_4', name: 'Rule 4. Process' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_5', name: 'Rule 5. Service and filing of pleadings and other papers' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_6', name: 'Rule 6. Time' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_7', name: 'Rule 7. Pleadings allowed; form of motions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_8', name: 'Rule 8. General rules of pleading' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_9', name: 'Rule 9. Pleading special matters' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_10', name: 'Rule 10. Form of pleadings' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_11', name: 'Rule 11. Signing and verification of pleadings' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_12', name: 'Rule 12. Defenses and objections' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_13', name: 'Rule 13. Counterclaim and crossclaim' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_14', name: 'Rule 14. Third-party practice' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_15', name: 'Rule 15. Amended and supplemental pleadings' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_16', name: 'Rule 16. Pre-trial procedure' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_17', name: 'Rule 17. Parties plaintiff and defendant; capacity' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_18', name: 'Rule 18. Joinder of claims' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_19', name: 'Rule 19. Necessary joinder of parties' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_20', name: 'Rule 20. Permissive joinder of parties' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_21', name: 'Rule 21. Misjoinder and nonjoinder of parties' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_22', name: 'Rule 22. Interpleader' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_23', name: 'Rule 23. Class actions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_24', name: 'Rule 24. Intervention' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_25', name: 'Rule 25. Substitution of parties' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_26', name: 'Rule 26. General provisions governing discovery' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_27', name: 'Rule 27. Depositions before action or pending appeal' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_28', name: 'Rule 28. Persons before whom depositions may be taken' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_29', name: 'Rule 29. Stipulations regarding discovery procedure' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_30', name: 'Rule 30. Depositions upon oral examination' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_31', name: 'Rule 31. Depositions upon written questions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_32', name: 'Rule 32. Use of depositions in court proceedings' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_33', name: 'Rule 33. Interrogatories to parties' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_34', name: 'Rule 34. Production of documents and things' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_35', name: 'Rule 35. Physical and mental examination of persons' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_36', name: 'Rule 36. Requests for admission' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_37', name: 'Rule 37. Failure to make discovery; sanctions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_38', name: 'Rule 38. Jury trial of right' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_39', name: 'Rule 39. Trial by jury or by the court' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_40', name: 'Rule 40. Assignment of cases for trial' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_41', name: 'Rule 41. Dismissal of actions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_42', name: 'Rule 42. Consolidation; separate trials' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_43', name: 'Rule 43. Evidence' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_44', name: 'Rule 44. Proof of official record' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_45', name: 'Rule 45. Subpoena' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_46', name: 'Rule 46. Exceptions unnecessary' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_47', name: 'Rule 47. Jurors' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_48', name: 'Rule 48. Juries of less than twelve' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_49', name: 'Rule 49. Verdicts' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_50', name: 'Rule 50. Motion for directed verdict and for judgment notwithstanding the verdict' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_51', name: 'Rule 51. Instructions to jury' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_52', name: 'Rule 52. Findings by the court' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_53', name: 'Rule 53. Referees' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_54', name: 'Rule 54. Judgments' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_55', name: 'Rule 55. Default' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_56', name: 'Rule 56. Summary judgment' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_57', name: 'Rule 57. Declaratory judgments' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_58', name: 'Rule 58. Entry of judgment' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_59', name: 'Rule 59. New trials; amendment of judgments' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_60', name: 'Rule 60. Relief from judgment or order' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_61', name: 'Rule 61. Harmless error' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_62', name: 'Rule 62. Stay of proceedings to enforce a judgment' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_63', name: 'Rule 63. Disability of a judge' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_64', name: 'Rule 64. Seizure of person or property' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_65', name: 'Rule 65. Injunctions' },
  { ch: '1A', sec: 'GS_1A-1,_Rule_68', name: 'Rule 68. Offer of judgment' },
  { ch: '7A', sec: 'GS_7A-146', name: '§ 7A-146. Powers of chief district judge' },
  { ch: '7A', sec: 'GS_7A-190', name: '§ 7A-190. District court jurisdiction in civil actions' },
  { ch: '7A', sec: 'GS_7A-191', name: '§ 7A-191. District court jurisdiction in criminal actions' },
  { ch: '7A', sec: 'GS_7A-240', name: '§ 7A-240. Definitions' },
  { ch: '7A', sec: 'GS_7A-241', name: '§ 7A-241. Jurisdiction of trial divisions in civil actions' },
  { ch: '7A', sec: 'GS_7A-242', name: '§ 7A-242. Original civil jurisdiction of superior court division' },
  { ch: '7A', sec: 'GS_7A-243', name: '§ 7A-243. Proper division; amount in controversy' },
  { ch: '7A', sec: 'GS_7A-244', name: '§ 7A-244. Waiver of proper division' },
  { ch: '7A', sec: 'GS_7A-245', name: '§ 7A-245. Concurrent original jurisdiction in special proceedings' },
  { ch: '7A', sec: 'GS_7A-246', name: '§ 7A-246. Exclusive original general jurisdiction of district court' },
  { ch: '7A', sec: 'GS_7A-247', name: '§ 7A-247. Jurisdiction of magistrates in civil actions' },
  { ch: '7A', sec: 'GS_7A-248', name: '§ 7A-248. Effect of counterclaims' },
  { ch: '7A', sec: 'GS_7A-249', name: '§ 7A-249. Effect of joinder of claims and parties' },
  { ch: '7A', sec: 'GS_7A-250', name: '§ 7A-250. Jurisdiction of uncontested proceedings' },
  { ch: '7A', sec: 'GS_7A-251', name: '§ 7A-251. Exclusive original jurisdiction of probate' },
  { ch: '7A', sec: 'GS_7A-252', name: '§ 7A-252. Appeals from administrative agencies' },
  { ch: '7A', sec: 'GS_7A-253', name: '§ 7A-253. Proper venue in civil actions' },
  { ch: '7A', sec: 'GS_7A-254', name: '§ 7A-254. Consolidation of actions' },
  { ch: '7A', sec: 'GS_7A-255', name: '§ 7A-255. Change of venue' },
  { ch: '7A', sec: 'GS_7A-256', name: '§ 7A-256. Transfer of cases between courts in same division' },
  { ch: '7A', sec: 'GS_7A-257', name: '§ 7A-257. Transfer of cases when improper county' },
  { ch: '7A', sec: 'GS_7A-258', name: '§ 7A-258. Motion to transfer' },
  { ch: '7A', sec: 'GS_7A-259', name: '§ 7A-259. Procedure upon transfer' },
  { ch: '58', sec: 'GS_58-70-1', name: '§ 58-70-1. Definitions' },
  { ch: '58', sec: 'GS_58-70-15', name: '§ 58-70-15. Permit required' },
  { ch: '58', sec: 'GS_58-70-70', name: '§ 58-70-70. Prohibited acts' },
  { ch: '58', sec: 'GS_58-70-90', name: '§ 58-70-90. Civil liability' },
  { ch: '58', sec: 'GS_58-70-115', name: '§ 58-70-115. Debt buyer definitions' },
  { ch: '58', sec: 'GS_58-70-120', name: '§ 58-70-120. Debt buyer registration' },
  { ch: '58', sec: 'GS_58-70-125', name: '§ 58-70-125. Debt buyer collection restrictions' },
  { ch: '58', sec: 'GS_58-70-130', name: '§ 58-70-130. Required disclosures' },
  { ch: '58', sec: 'GS_58-70-145', name: '§ 58-70-145. Statute of limitations' },
  { ch: '58', sec: 'GS_58-70-150', name: '§ 58-70-150. Litigation requirements' },
  { ch: '58', sec: 'GS_58-70-155', name: '§ 58-70-155. Documentation required' },
  { ch: '75', sec: 'GS_75-50', name: '§ 75-50. Definitions' },
  { ch: '75', sec: 'GS_75-51', name: '§ 75-51. Prohibited communication' },
  { ch: '75', sec: 'GS_75-52', name: '§ 75-52. Deceptive representation' },
  { ch: '75', sec: 'GS_75-53', name: '§ 75-53. Threats and coercion' },
  { ch: '75', sec: 'GS_75-54', name: '§ 75-54. Unfair practices' },
  { ch: '75', sec: 'GS_75-55', name: '§ 75-55. Remedies' },
  { ch: '75', sec: 'GS_75-56', name: '§ 75-56. Penalties' },
  { ch: '75', sec: 'GS_75-1.1', name: '§ 75-1.1. Unfair methods of competition and unfair or deceptive acts' },
  { ch: '75', sec: 'GS_75-16', name: '§ 75-16. Civil action; treble damages' },
  { ch: '32C', sec: 'GS_32C-1-102', name: '§ 32C-1-102. Definitions' },
  { ch: '32C', sec: 'GS_32C-1-110', name: '§ 32C-1-110. Agent duties' },
  { ch: '32C', sec: 'GS_32C-1-114', name: '§ 32C-1-114. Agent liability' },
  { ch: '32C', sec: 'GS_32C-2-201', name: '§ 32C-2-201. Authority of agent' },
  { ch: '32C', sec: 'GS_32C-2-205', name: '§ 32C-2-205. Termination' },
];

function stripHtml(html) {
  // Remove script and style tags with content
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove navigation, header, footer
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  // Convert common elements
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');
  text = text.replace(/<h[1-6][^>]*>/gi, '\n\n');
  // Convert bold/italic
  text = text.replace(/<b>|<strong>/gi, '**');
  text = text.replace(/<\/b>|<\/strong>/gi, '**');
  text = text.replace(/<i>|<em>/gi, '*');
  text = text.replace(/<\/i>|<\/em>/gi, '*');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common entities
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
  // Clean up whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  text = text.trim();
  return text;
}

function extractStatuteBody(html) {
  // Try to find the main statute content between common markers
  // ncleg.gov typically has the statute text in the main body area
  let body = html;

  // Try to isolate the body content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1];

  // Strip the text
  return stripHtml(body);
}

function main() {
  console.log('=== Extracting Statutes to Markdown ===\n');

  // Group sections by chapter
  const byChapter = {};
  for (const s of SECTIONS) {
    if (!byChapter[s.ch]) byChapter[s.ch] = [];
    byChapter[s.ch].push(s);
  }

  const stats = { chapters: 0, sections: 0, totalBytes: 0 };

  for (const [ch, info] of Object.entries(CHAPTER_INFO)) {
    const sections = byChapter[ch] || [];
    if (sections.length === 0) continue;

    const lines = [];
    lines.push(`# ${info.title}`);
    lines.push('');
    lines.push(`> ${info.description}`);
    lines.push('');
    lines.push(`Case: Case Pilot research library`);
    lines.push(`Source: https://www.ncleg.gov/Laws/GeneralStatuteSections/Chapter${ch}`);
    lines.push(`Retrieved: 2026-02-23`);
    lines.push(`Sections: ${sections.length}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Table of contents
    lines.push('## Table of Contents');
    lines.push('');
    for (const s of sections) {
      const anchor = s.sec.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      lines.push(`- [${s.name}](#${anchor})`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    // Extract each section
    for (const s of sections) {
      const htmlFile = path.join(TEMP_DIR, `${s.sec}.html`);
      if (!fs.existsSync(htmlFile)) {
        lines.push(`## ${s.name}`);
        lines.push('');
        lines.push('*[Section file not found]*');
        lines.push('');
        lines.push('---');
        lines.push('');
        continue;
      }

      const html = fs.readFileSync(htmlFile, 'utf-8');
      const text = extractStatuteBody(html);

      lines.push(`## ${s.name}`);
      lines.push('');
      lines.push(text);
      lines.push('');
      lines.push('---');
      lines.push('');

      stats.sections++;
    }

    const content = lines.join('\n');
    const outFile = path.join(OUTPUT_DIR, info.file);
    fs.writeFileSync(outFile, content);
    const sizeKb = (content.length / 1024).toFixed(1);
    stats.chapters++;
    stats.totalBytes += content.length;
    console.log(`  ✓ ${info.file} — ${sections.length} sections, ${sizeKb}KB`);
  }

  console.log(`\n=== Complete ===`);
  console.log(`  ${stats.chapters} chapter files`);
  console.log(`  ${stats.sections} sections extracted`);
  console.log(`  ${(stats.totalBytes / 1024).toFixed(0)}KB total`);
  console.log(`  Output: ${OUTPUT_DIR}`);
}

main();
