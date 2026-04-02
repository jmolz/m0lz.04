#!/usr/bin/env node
/**
 * sync-calendar-deadlines.js
 *
 * Parse court session schedule PDF(s) and upsert
 * calendar-request deadlines into case-tracker.db.
 *
 * Usage:
 *   node sync-calendar-deadlines.js
 *   node sync-calendar-deadlines.js --dry-run
 *   node sync-calendar-deadlines.js --verbose
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cfg = require('./case-config');

let Database;
try { Database = require('better-sqlite3'); } catch { Database = null; }

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'case-tracker.db');
const LOCAL_RULES_DIR = path.join(PROJECT_ROOT, '07_Research', 'local_rules');
const CALENDAR_DIR = path.join(LOCAL_RULES_DIR, 'calendars');

const CASE_NUMBER = cfg.caseInfo().number || '';
const MANAGED_PREFIX = 'Calendar request due for session beginning';
const TRIGGERED_BY = 'Court session schedule sync';
const RULE_REFERENCE = 'Court Session Schedule / Calendar Request';

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const MONTHS = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function log(msg) {
  if (VERBOSE) console.log(`[calendar-sync] ${msg}`);
}

function toIso(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseSlashDate(token) {
  const m = String(token || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  let yy = Number(m[3]);
  if (yy < 100) yy += 2000;
  if (!mm || !dd || !yy) return null;
  return { iso: toIso(yy, mm, dd), raw: token };
}

function parseMonthToken(token) {
  const m = String(token || '').match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:\s*-\s*(\d{1,2}))?,?\s+(\d{4})$/);
  if (!m) return null;
  const monthName = m[1].toLowerCase();
  const month = MONTHS[monthName];
  const day = Number(m[2]);
  const year = Number(m[4]);
  if (!month || !day || !year) return null;
  const startIso = toIso(year, month, day);
  const endDay = m[3] ? Number(m[3]) : day;
  const endIso = toIso(year, month, endDay);
  return { iso: startIso, startIso, endIso, raw: token };
}

function uniqueDates(list) {
  return Array.from(new Set(list)).sort();
}

function extractDateTokens(line) {
  const out = [];
  const slashMatches = String(line).match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || [];
  for (const token of slashMatches) {
    const parsed = parseSlashDate(token);
    if (parsed?.iso) out.push(parsed.iso);
  }

  const monthMatches = String(line).match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:\s*-\s*\d{1,2})?,?\s+\d{4}\b/gi) || [];
  for (const token of monthMatches) {
    const parsed = parseMonthToken(token);
    if (parsed?.startIso) {
      out.push(parsed.startIso);
      if (parsed.endIso && parsed.endIso !== parsed.startIso) out.push(parsed.endIso);
    }
  }

  return uniqueDates(out);
}

function diffDays(aIso, bIso) {
  const a = new Date(`${aIso}T12:00:00Z`);
  const b = new Date(`${bIso}T12:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function pickDueAndSession(dates) {
  if (!Array.isArray(dates) || dates.length < 2) return null;
  const sorted = uniqueDates(dates);
  let best = null;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const due = sorted[i];
      const session = sorted[j];
      const gap = diffDays(due, session);
      if (gap < 1 || gap > 60) continue;
      if (!best || gap < best.gap) best = { due, session, gap };
    }
  }

  return best ? { dueDate: best.due, sessionStart: best.session } : null;
}

function extractPdfText(pdfPath) {
  const attempts = [
    {
      name: 'pdftotext',
      run: () => spawnSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }),
    },
    {
      name: 'mdls',
      run: () => spawnSync('mdls', ['-name', 'kMDItemTextContent', '-raw', pdfPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }),
    },
  ];

  for (const attempt of attempts) {
    let res;
    try {
      res = attempt.run();
    } catch {
      continue;
    }
    const output = String(res?.stdout || '').trim();
    if (res?.status === 0 && output && /\d{4}/.test(output) && /calendar|session|civil|district/i.test(output)) {
      return { text: output, extractor: attempt.name };
    }
  }

  return { text: '', extractor: 'none' };
}

function inferSeasonLabel(fileName) {
  const cleaned = String(fileName || '').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();
  return cleaned || 'Court Session Schedule';
}

function parseScheduleText(text, sourceLabel) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  const hasCalendarVocabulary = /calendar\s+request|session\s+schedule|civil\s+district/i.test(String(text || ''));

  for (const lineRaw of lines) {
    const line = lineRaw.replace(/\s+/g, ' ').trim();
    if (!line) continue;

    const dates = extractDateTokens(line);
    if (dates.length < 2) continue;

    const lineHasContext = /calendar|session|week|district|9c/i.test(line);
    if (!lineHasContext && !hasCalendarVocabulary) continue;

    const picked = pickDueAndSession(dates);
    if (!picked) continue;

    rows.push({
      dueDate: picked.dueDate,
      sessionStart: picked.sessionStart,
      sourceLabel,
      lineSnippet: line.slice(0, 240),
    });
  }

  // Deduplicate by due_date + session_start
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.dueDate}|${row.sessionStart}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return Array.from(byKey.values()).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function getScheduleFiles() {
  if (!fs.existsSync(CALENDAR_DIR)) return [];
  return fs.readdirSync(CALENDAR_DIR)
    .filter((name) => /session\s*schedule|session-schedule|9c/i.test(name) && /\.pdf$/i.test(name))
    .map((name) => ({
      fileName: name,
      filePath: path.join(CALENDAR_DIR, name),
      seasonLabel: inferSeasonLabel(name),
    }));
}

function ensureDeadlinesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deadlines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      description TEXT NOT NULL,
      due_date DATE NOT NULL,
      triggered_by TEXT,
      rule_reference TEXT,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',
      notes TEXT
    );
  `);
}

function getCaseId(db) {
  const byCase = db.prepare('SELECT id FROM cases WHERE case_number = ?').get(CASE_NUMBER);
  if (byCase?.id) return byCase.id;
  const first = db.prepare('SELECT id FROM cases ORDER BY id LIMIT 1').get();
  if (first?.id) return first.id;
  throw new Error('No case row found in database.');
}

function upsertCalendarDeadlines(db, caseId, rows) {
  const existingManaged = db.prepare(
    `SELECT id, description, due_date, status FROM deadlines
     WHERE case_id = ? AND description LIKE ?`
  ).all(caseId, `${MANAGED_PREFIX}%`);

  const existingKey = new Set(existingManaged.map((r) => `${r.due_date}|${r.description}`));

  const insert = db.prepare(`
    INSERT INTO deadlines (case_id, description, due_date, triggered_by, rule_reference, status, priority, notes)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  const nowIso = new Date().toISOString();
  let added = 0;
  let skipped = 0;

  for (const row of rows) {
    const description = `${MANAGED_PREFIX} ${row.sessionStart}`;
    const key = `${row.dueDate}|${description}`;
    if (existingKey.has(key)) {
      skipped += 1;
      continue;
    }

    const notes = [
      `[CAL_REQ_9C] synced_at=${nowIso}`,
      `season=${row.sourceLabel}`,
      `session_start=${row.sessionStart}`,
      `source_excerpt=${row.lineSnippet}`,
    ].join(' | ');

    const daysOut = diffDays(new Date().toISOString().slice(0, 10), row.dueDate);
    const priority = daysOut <= 14 ? 'high' : daysOut <= 30 ? 'medium' : 'normal';

    if (DRY_RUN) {
      log(`would add ${row.dueDate} -> ${description}`);
      added += 1;
      continue;
    }

    insert.run(caseId, description, row.dueDate, TRIGGERED_BY, RULE_REFERENCE, priority, notes);
    added += 1;
  }

  return { added, skipped, totalParsed: rows.length };
}

function main() {
  if (!Database) {
    console.log('Calendar deadline sync skipped: better-sqlite3 unavailable.');
    return;
  }
  if (!fs.existsSync(DB_PATH)) {
    console.log(`Calendar deadline sync skipped: DB not found at ${DB_PATH}`);
    return;
  }

  const schedules = getScheduleFiles();
  if (!schedules.length) {
    console.log(`Calendar deadline sync skipped: no schedule PDF found in ${CALENDAR_DIR}`);
    return;
  }

  const parsedRows = [];
  for (const schedule of schedules) {
    const { text, extractor } = extractPdfText(schedule.filePath);
    if (!text) {
      log(`no extractable text from ${schedule.fileName}`);
      continue;
    }
    log(`parsed ${schedule.fileName} using ${extractor}`);
    parsedRows.push(...parseScheduleText(text, schedule.seasonLabel));
  }

  if (!parsedRows.length) {
    console.log('Calendar deadline sync complete: no session/deadline rows parsed from schedule PDF(s).');
    return;
  }

  const db = new Database(DB_PATH);
  try {
    ensureDeadlinesTable(db);
    const caseId = getCaseId(db);
    const result = upsertCalendarDeadlines(db, caseId, parsedRows);
    console.log(`Calendar deadline sync complete: ${result.added} added, ${result.skipped} skipped, ${result.totalParsed} parsed.`);
  } finally {
    db.close();
  }
}

main();
