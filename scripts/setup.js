#!/usr/bin/env node
/**
 * Case Pilot — Setup Script
 *
 * Initializes the project for a new case:
 *   1. Creates folder structure
 *   2. Initializes case-tracker.db with schema
 *   3. Creates starter 00_Case_Overview files from case-config.json
 *
 * Usage:
 *   node scripts/setup.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'case-config.json');
const EXAMPLE_PATH = path.join(PROJECT_ROOT, 'case-config.example.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`  + ${path.relative(PROJECT_ROOT, dir)}/`);
  }
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    console.log(`  ⊘ ${path.relative(PROJECT_ROOT, filePath)} (already exists)`);
    return false;
  }
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`  + ${path.relative(PROJECT_ROOT, filePath)}`);
  return true;
}

// ── 1. Check for case-config.json ──────────────────────────────────────────
console.log('\n=== Case Pilot Setup ===\n');

if (!fs.existsSync(CONFIG_PATH)) {
  if (fs.existsSync(EXAMPLE_PATH)) {
    console.log('⚠  case-config.json not found.');
    console.log('   Copy case-config.example.json → case-config.json and fill in your case details.\n');
    console.log('   cp case-config.example.json case-config.json\n');
  } else {
    console.log('⚠  Neither case-config.json nor case-config.example.json found.');
    console.log('   Something is wrong with the project structure.\n');
  }
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`⚠  Failed to parse case-config.json: ${err.message}`);
  process.exit(1);
}

console.log(`Case: ${cfg.case?.number || '(no case number)'}`);
console.log(`Defendant: ${cfg.defendant?.name || '(not set)'}`);
console.log('');

// ── 2. Create folder structure ─────────────────────────────────────────────
console.log('Creating folder structure...');

const DIRS = [
  '00_Case_Overview',
  '01_Pleadings/complaints', '01_Pleadings/answers', '01_Pleadings/amended',
  '02_Motions/defendant', '02_Motions/plaintiff',
  '03_Discovery/defendant', '03_Discovery/plaintiff',
  '04_Evidence_Exhibits/defendant', '04_Evidence_Exhibits/plaintiff',
  '05_Court_Orders',
  '06_Correspondence/incoming', '06_Correspondence/outgoing',
  '07_Research/statutes', '07_Research/local_rules', '07_Research/case_law', '07_Research/memos',
  '08_Templates',
  '09_Oral_Arguments/prep_notes',
  '10_Arbitration',
  '_Inbox',
  'scripts/logs', 'scripts/ui-state', 'scripts/state',
];

for (const dir of DIRS) {
  ensureDir(path.join(PROJECT_ROOT, dir));
}

// ── 3. Initialize database ─────────────────────────────────────────────────
console.log('\nInitializing database...');

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  console.log('  ⚠  better-sqlite3 not installed. Run: cd scripts && npm install');
  console.log('     Skipping database initialization.\n');
  Database = null;
}

if (Database) {
  const dbPath = path.join(PROJECT_ROOT, 'case-tracker.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_number TEXT UNIQUE NOT NULL,
      court TEXT,
      case_type TEXT,
      status TEXT DEFAULT 'active',
      amount TEXT,
      date_filed TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      filename TEXT NOT NULL,
      doc_type TEXT,
      party TEXT,
      description TEXT,
      date_filed TEXT,
      index_num TEXT,
      portal_index TEXT,
      has_pdf INTEGER DEFAULT 0,
      folder_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS deadlines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      description TEXT NOT NULL,
      due_date DATE NOT NULL,
      triggered_by TEXT,
      rule_reference TEXT,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS court_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      event_date TEXT,
      index_num TEXT,
      description TEXT,
      raw_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS court_hearings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      hearing_date TEXT,
      hearing_time TEXT,
      hearing_type TEXT,
      description TEXT,
      raw_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS filing_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      motion_idx TEXT,
      motion_description TEXT,
      motion_date TEXT,
      filed_by TEXT,
      outcome TEXT,
      outcome_date TEXT,
      outcome_notes TEXT,
      stakes_tier TEXT,
      what_worked TEXT,
      judge TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Insert case row if not exists
  const caseNumber = cfg.case?.number || '';
  if (caseNumber) {
    const existing = db.prepare('SELECT id FROM cases WHERE case_number = ?').get(caseNumber);
    if (!existing) {
      db.prepare(`
        INSERT INTO cases (case_number, court, case_type, amount, date_filed)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        caseNumber,
        cfg.case?.court || '',
        cfg.case?.type || '',
        cfg.case?.amount || '',
        cfg.case?.dateFiled || '',
      );
      console.log(`  + Case row created: ${caseNumber}`);
    } else {
      console.log(`  ⊘ Case row already exists: ${caseNumber}`);
    }
  }

  db.close();
  console.log(`  ✓ Database ready at case-tracker.db`);
}

// ── 4. Create starter 00_Case_Overview files ───────────────────────────────
console.log('\nCreating case overview files...');

const ci = cfg.case || {};
const d = cfg.defendant || {};
const p = cfg.plaintiff || {};
const oc = cfg.opposingCounsel || {};
const def = cfg.defense || {};

writeIfMissing(path.join(PROJECT_ROOT, '00_Case_Overview', 'case_index.md'), [
  `# Case Index: ${p.current || p.original || 'Plaintiff'} v. ${d.name || 'Defendant'}`,
  `**Case No.**: ${ci.number || ''}`,
  `**Court**: ${ci.court || ''}`,
  `**Type**: ${ci.type || ''}`,
  ci.amount ? `**Amount**: ${ci.amount}` : '',
  '',
  '## Status',
  'Active — Pre-Trial',
  '',
  '## Key Defense Arguments',
  ...(def.arguments || []).map((a, i) => `${i + 1}. ${a.label} — ${a.summary}`),
  '',
  '## Next Hearing',
  '(none scheduled)',
  '',
].filter((l) => l !== false).join('\n'));

writeIfMissing(path.join(PROJECT_ROOT, '00_Case_Overview', 'party_info.md'), [
  `# Party Information: ${ci.number || ''}`,
  '',
  '## Defendant',
  `- Name: ${d.name || ''}`,
  `- Status: ${d.status || 'Pro Se'}`,
  d.address ? `- Address: ${d.address}, ${d.city || ''}, ${d.stateCode || ''} ${d.zip || ''}` : '',
  d.phone ? `- Phone: ${d.phone}` : '',
  d.email ? `- Email: ${d.email}` : '',
  '',
  '## Plaintiff',
  `- Name: ${p.current || p.original || ''}`,
  p.original && p.current ? `- Original: ${p.original}` : '',
  p.accountOwner ? `- Account Owner: ${p.accountOwner}` : '',
  '',
  '## Opposing Counsel',
  oc.firm ? `- Firm: ${oc.firm}` : '',
  oc.address ? `- Address: ${oc.address}` : '',
  ...(oc.attorneys || []).map((a) => `- ${a.name}${a.email ? ` — ${a.email}` : ''}`),
  '',
].filter((l) => l !== false).join('\n'));

writeIfMissing(path.join(PROJECT_ROOT, '00_Case_Overview', 'strategy_notes.md'), [
  '# Strategy Notes',
  '',
  '## Defense Arguments',
  ...(def.arguments || []).map((a) => `- **${a.label}**: ${a.summary}`),
  '',
  '## Key Cases',
  ...(def.keyCases || []).map((k) => `- **${k.name}**: ${k.holding}`),
  '',
  '## Strategic Sequencing Rules',
  '(Add your filing sequence and decision trees here)',
  '',
].join('\n'));

writeIfMissing(path.join(PROJECT_ROOT, '00_Case_Overview', 'case_timeline.md'), [
  '# Case Timeline',
  '',
  `| Date | Event | Index |`,
  `|------|-------|-------|`,
  ci.dateFiled ? `| ${ci.dateFiled} | Case filed | IDX001 |` : '',
  '',
].filter((l) => l !== false).join('\n'));

// ── Done ───────────────────────────────────────────────────────────────────
console.log('\n✓ Setup complete. Next steps:');
console.log('  1. Review 00_Case_Overview/ files and add detail');
console.log('  2. Set ANTHROPIC_API_KEY in .env');
console.log('  3. Start the UI: cd scripts && node ui-server.js');
console.log('  4. Open http://127.0.0.1:3210\n');
