'use strict';
/**
 * Case Config Loader — reads case-config.json from project root.
 *
 * Every script that needs case-specific data should:
 *   const cfg = require('./case-config');
 *   cfg.defendant.name  // → "Jane Doe"
 *
 * If case-config.json is missing, the module exports a clear error
 * message so the user knows to run setup.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'case-config.json');
const EXAMPLE_PATH = path.join(PROJECT_ROOT, 'case-config.example.json');

let _config = null;
let _loadError = null;

function load() {
  if (_config) return _config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    _config = JSON.parse(raw);
    return _config;
  } catch (err) {
    _loadError = err;
    if (err.code === 'ENOENT') {
      console.error(
        '\n⚠  case-config.json not found.\n' +
        '   Copy case-config.example.json → case-config.json and fill in your case details.\n' +
        '   Or run:  node scripts/setup.js\n'
      );
    } else {
      console.error(`\n⚠  Failed to parse case-config.json: ${err.message}\n`);
    }
    return null;
  }
}

function get() {
  const cfg = load();
  if (!cfg) {
    throw new Error('case-config.json is missing or invalid. See case-config.example.json for the required format.');
  }
  return cfg;
}

function safeGet() {
  return load() || {};
}

// ── Convenience accessors ──────────────────────────────────────────────────

function caseInfo() { return get().case || {}; }
function defendant() { return get().defendant || {}; }
function plaintiff() { return get().plaintiff || {}; }
function counsel() { return get().opposingCounsel || {}; }
function defense() { return get().defense || {}; }
function portal() { return get().portal || {}; }
function ui() { return (safeGet().ui) || { title: 'Case Pilot', subtitle: '' }; }

/** All service emails (general + attorney-specific) */
function allServiceEmails() {
  const c = counsel();
  const emails = [...(c.serviceEmails || [])];
  if (c.attorneys) {
    for (const a of c.attorneys) {
      if (a.email && !emails.includes(a.email)) emails.push(a.email);
    }
  }
  return emails;
}

/** Full address line: "123 Main St, Raleigh, NC 27601" */
function defendantFullAddress() {
  const d = defendant();
  return [d.address, d.city, `${d.stateCode || ''} ${d.zip || ''}`.trim()].filter(Boolean).join(', ');
}

/** NC District Court caption block (plain text) */
function captionBlock(docTitle) {
  const c = caseInfo();
  const p = plaintiff();
  const d = defendant();
  const title = docTitle || '[DOCUMENT TITLE IN CAPS]';
  return [
    `STATE OF ${(c.state || 'NORTH CAROLINA').toUpperCase()}                  IN THE ${(c.courtSystem || 'GENERAL COURT OF JUSTICE').toUpperCase()}`,
    `                                         ${(c.division || 'DISTRICT COURT DIVISION').toUpperCase()}`,
    (c.county || '').toUpperCase(),
    `                                         File No.: ${c.number || ''}`,
    '',
    `${p.current || p.original || 'Plaintiff'},`,
    '          Plaintiff,',
    '',
    `     vs.                                 ${title}`,
    '',
    `${d.nameUpper || (d.name || '').toUpperCase()},`,
    '          Defendant.',
  ].join('\n');
}

/** Signature block (plain text) */
function signatureBlock({ day, monthName, year } = {}) {
  const d = defendant();
  const now = new Date();
  const dd = day || now.getDate();
  const mm = monthName || now.toLocaleString('en-US', { month: 'long' });
  const yy = year || now.getFullYear();
  const ord = (n) => {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  return [
    `Respectfully submitted, this the ${ord(dd)} day of ${mm}, ${yy}.`,
    '',
    '',
    '_________________________',
    `${d.name || ''}, ${d.status || 'Pro Se'}`,
    d.address || '',
    [d.city, `${d.stateCode || ''} ${d.zip || ''}`.trim()].filter(Boolean).join(', '),
    d.phone || '',
    d.email || '',
  ].join('\n');
}

/** Certificate of service block (plain text) */
function certificateOfService({ docName, day, monthName, year } = {}) {
  const d = defendant();
  const emails = allServiceEmails();
  const now = new Date();
  const dd = day || now.getDate();
  const mm = monthName || now.toLocaleString('en-US', { month: 'long' });
  const yy = year || now.getFullYear();
  const ord = (n) => {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  return [
    'CERTIFICATE OF SERVICE',
    '',
    `I hereby certify that a true and correct copy of the foregoing ${docName || '[DOCUMENT NAME]'} was served upon counsel for Plaintiff via email to ${emails.join(', ')}, in accordance with N.C. Gen. Stat. § 1A-1, Rule 5, on this the ${ord(dd)} day of ${mm}, ${yy}.`,
    '',
    '',
    '_________________________',
    `${d.name || ''}, ${d.status || 'Pro Se'}`,
  ].join('\n');
}

/** Jurisdictional reservation paragraph */
function jurisdictionalReservation(docType) {
  const d = defense();
  let text = d.jurisdictionalReservation || '';
  if (docType) text = text.replace('[document type]', docType);
  return text;
}

/** Party terms for RAG search weighting */
function partyTerms() {
  const terms = new Set();
  const addWords = (str) => {
    if (!str) return;
    for (const w of String(str).toLowerCase().split(/\s+/)) {
      const clean = w.replace(/[^a-z]/g, '');
      if (clean.length >= 3) terms.add(clean);
    }
  };
  addWords(defendant().name);
  addWords(plaintiff().current);
  addWords(plaintiff().original);
  addWords(counsel().firm);
  return terms;
}

/** UI title */
function appTitle() {
  return ui().title || 'Case Pilot';
}

/** Case summary one-liner: "Plaintiff v. Defendant" */
function caseTitleShort() {
  const p = plaintiff();
  const d = defendant();
  const pName = (p.current || p.original || 'Plaintiff').split(',')[0].trim();
  const dName = (d.name || 'Defendant').split(',')[0].trim();
  return `${pName} v. ${dName}`;
}

module.exports = {
  PROJECT_ROOT,
  CONFIG_PATH,
  load,
  get,
  safeGet,
  caseInfo,
  defendant,
  plaintiff,
  counsel,
  defense,
  portal,
  ui,
  allServiceEmails,
  defendantFullAddress,
  captionBlock,
  signatureBlock,
  certificateOfService,
  jurisdictionalReservation,
  partyTerms,
  appTitle,
  caseTitleShort,
};
