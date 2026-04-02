#!/usr/bin/env node
/**
 * Court Filing Monitor — Case Pilot
 *
 * Scrapes the Tyler Tech Register of Actions portal for new filings,
 * syncs events/hearings to case-tracker.db, downloads new PDFs, and
 * organizes them into the case folder structure.
 *
 * Usage:
 *   node check-court-filings.js              # normal run
 *   node check-court-filings.js --init       # first run: seed DB + download all PDFs
 *   node check-court-filings.js --dry-run    # show what would change, don't write
 *   node check-court-filings.js --skip-pdfs  # scrape events only, no PDF downloads
 *   node check-court-filings.js --skip-ai    # skip AI deadline analysis
 *   node check-court-filings.js --ai-latest  # analyze latest window only (not full backfill)
 *   node check-court-filings.js --force-ai   # force AI analysis even if already run today
 */

const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { analyzeForDeadlines } = require('./deadline-analyzer');
const cfg = require('./case-config');

// ── Config ──────────────────────────────────────────────────────────────────
const ROA_URL = cfg.portal().roaUrl || process.env.ROA_URL || '';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'case-tracker.db');
const TIMELINE_PATH = path.join(PROJECT_ROOT, '00_Case_Overview', 'case_timeline.md');
const LOG_DIR = path.join(PROJECT_ROOT, 'scripts', 'logs');
const CASE_NUMBER = cfg.caseInfo().number || '';

const args = process.argv.slice(2);
const INIT_MODE = args.includes('--init');
const DRY_RUN = args.includes('--dry-run');
const SKIP_PDFS = args.includes('--skip-pdfs');
const SKIP_AI = args.includes('--skip-ai');
const AI_LATEST = args.includes('--ai-latest');
const FORCE_AI = args.includes('--force-ai');

// ── Helpers ─────────────────────────────────────────────────────────────────
const logLines = [];
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  logLines.push(line);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeDate(dateStr) {
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return dateStr;
}

function mapDocType(eventType, description) {
  const t = ((eventType || '') + ' ' + (description || '')).toLowerCase();
  if (t.includes('withdrawal')) return 'NOT';
  if (t.includes('complaint') && t.includes('amended')) return 'COMP';
  if (t.includes('complaint')) return 'COMP';
  if (t.includes('answer') || t.includes('amended pleading') || t.includes('counterclaim')) return 'ANS';
  if (t.includes('motion for summary')) return 'MOT';
  if (t.includes('motion to compel')) return 'MOT';
  if (t.includes('motion to continue')) return 'MOT';
  if (t.includes('motion to extend')) return 'MOT';
  if (t.includes('motion to amend')) return 'MOT';
  if (t.includes('motion to enforce')) return 'MOT';
  if (t.includes('motion for judgment')) return 'MOT';
  if (t.includes('motion to strike')) return 'MOT';
  if (t.includes('motion to vacate')) return 'MOT';
  if (t.includes('motion')) return 'MOT';
  if (t.includes('opposition') || t.includes('objection')) return 'RESP';
  if (t.includes('reply')) return 'REPLY';
  if (t.includes('order to continue')) return 'ORD';
  if (t.includes('order to extend')) return 'ORD';
  if (t.includes('order to compel')) return 'ORD';
  if (t.includes('order')) return 'ORD';
  if (t.includes('notice of hearing')) return 'NOH';
  if (t.includes('notice')) return 'NOT';
  if (t.includes('affidavit')) return 'AFF';
  if (t.includes('subpoena')) return 'SUB';
  if (t.includes('stipulat')) return 'STIP';
  if (t.includes('memorandum')) return 'MEMO';
  if (t.includes('certificate of service')) return 'COS';
  return 'MISC';
}

function mapParty(text) {
  const lower = (text || '').toLowerCase();
  if (lower.includes('defendant') || lower.includes('molz')) return 'DEF';
  if (lower.includes('plaintiff') || lower.includes('sofi') || lower.includes('amin') || lower.includes('cotton') || lower.includes('garcia')) return 'PLT';
  if (lower.includes('judicial officer') || lower.includes('judge')) return 'CRT';
  return 'CRT';
}

function routeToFolder(docType, party) {
  const base = PROJECT_ROOT;
  switch (docType) {
    case 'COMP': return path.join(base, '01_Pleadings', party === 'DEF' ? 'answers' : 'complaints');
    case 'ANS': return path.join(base, '01_Pleadings', 'answers');
    case 'MOT': case 'RESP': case 'REPLY': case 'MEMO':
      return path.join(base, '02_Motions', party === 'DEF' ? 'defendant' : 'plaintiff');
    case 'ORD': case 'STIP': return path.join(base, '05_Court_Orders');
    case 'NOH': case 'NOT': return path.join(base, '06_Correspondence', 'court_notices');
    case 'AFF': case 'EX': return path.join(base, '04_Evidence_Exhibits', party === 'DEF' ? 'defendant' : 'plaintiff');
    case 'COS': return path.join(base, '06_Correspondence', 'service');
    default: return path.join(base, '06_Correspondence', 'misc');
  }
}

function buildFilename(date, indexNum, docType, party, description) {
  const idx = indexNum ? `IDX${String(indexNum).padStart(3, '0')}` : 'IDX000';
  let desc = (description || 'Filing').replace(/[^a-zA-Z0-9\s]/g, '').trim();
  desc = desc.split(/\s+/).slice(0, 5).join('-') || 'Filing';
  return `${date}_${idx}_${docType}_${party}_${desc}.pdf`;
}

// ── Browser Session ─────────────────────────────────────────────────────────
async function openPortal() {
  log('Launching browser...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    javaScriptEnabled: true,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // Auto-close popup tabs from PDF downloads
  context.on('page', async (newPage) => {
    try { await newPage.close(); } catch {}
  });

  log('Navigating to Register of Actions...');
  await page.goto(ROA_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Click "SHOW ALL" if pagination exists
  try {
    const showAll = await page.locator('text=SHOW ALL').first();
    if (await showAll.isVisible({ timeout: 3000 })) {
      log('Clicking SHOW ALL to load all events...');
      await showAll.click();
      await page.waitForTimeout(3000);
    }
  } catch { /* no pagination or already showing all */ }

  return { browser, context, page };
}

// ── Scraping ────────────────────────────────────────────────────────────────
async function scrapeTexts(page) {
  log('Extracting case events...');
  const eventsText = await page.evaluate(() => {
    const section = Array.from(document.querySelectorAll('md-card')).find(c => {
      const h = c.querySelector('.header-text, h1');
      return h && h.innerText.trim() === 'Case Events';
    });
    return section ? section.querySelector('md-card-content')?.innerText?.trim() || '' : '';
  });

  log('Extracting hearings...');
  const hearingsText = await page.evaluate(() => {
    const section = Array.from(document.querySelectorAll('md-card')).find(c => {
      const h = c.querySelector('.header-text, h1');
      return h && h.innerText.trim() === 'Hearings';
    });
    return section ? section.querySelector('md-card-content')?.innerText?.trim() || '' : '';
  });

  const caseInfo = await page.evaluate(() => {
    const section = Array.from(document.querySelectorAll('md-card')).find(c => {
      const h = c.querySelector('.header-text, h1');
      return h && h.innerText.trim() === 'Case Information';
    });
    return section ? section.querySelector('md-card-content')?.innerText?.trim() || '' : '';
  });

  return { eventsText, hearingsText, caseInfo };
}

// ── PDF Download ────────────────────────────────────────────────────────────
async function downloadNewPDFs(page, db, caseId) {
  // Get all events from DOM with their document availability
  const domEvents = await page.evaluate(() => {
    const section = Array.from(document.querySelectorAll('md-card')).find(c => {
      const h = c.querySelector('.header-text, h1');
      return h && h.innerText.trim() === 'Case Events';
    });
    if (!section) return [];

    const eventDivs = section.querySelectorAll('.roa-event-info');
    return Array.from(eventDivs).map((div, i) => {
      const text = div.innerText.trim();
      const dateMatch = text.match(/^(\d{2}\/\d{2}\/\d{4})/);
      const idxMatch = text.match(/Index #\s*(\d+)/);
      const hasDocIcon = div.querySelector('img.roa-icon.roa-clickable') !== null;
      const divHeight = div.getBoundingClientRect().height;

      // Get metadata from Angular scope when available
      const scope = typeof angular !== 'undefined' ? angular?.element(div)?.scope?.() : null;
      const ev = scope?.event;
      const filedBy = ev?.Event?.FiledBy || '';
      const eventType = ev?.Event?.EventType || '';
      const comment = ev?.Event?.Comment || '';

      // Fallback to text parsing
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const textEventType = lines.length > 1 ? lines[1] : '';
      let textDesc = '';
      if (lines.length > 2 && !lines[2].startsWith('Filed By:') && !lines[2].startsWith('Against:') && !lines[2].startsWith('Created:')) {
        textDesc = lines[2];
      }
      const filedByMatch = text.match(/Filed By:\s*([\s\S]*?)(?:Against:|Created:|Index #|$)/);
      const textFiledBy = filedByMatch ? filedByMatch[1].trim().split('\n')[0].trim() : '';

      return {
        domIndex: i,
        date: dateMatch ? dateMatch[1] : null,
        indexNum: idxMatch ? parseInt(idxMatch[1]) : null,
        eventType: eventType || textEventType,
        description: comment || textDesc,
        filedBy: filedBy || textFiledBy,
        hasDocIcon,
        isCollapsed: divHeight === 0
      };
    });
  });

  // Check which events already have PDFs in the DB
  const existingPDFs = new Set(
    db.prepare('SELECT portal_index FROM documents WHERE portal_index IS NOT NULL AND has_pdf = 1')
      .all().map(r => r.portal_index)
  );
  const existingPlaceholders = new Set(
    db.prepare('SELECT portal_index FROM documents WHERE portal_index IS NOT NULL AND has_pdf = 0')
      .all().map(r => r.portal_index)
  );

  const insertDoc = db.prepare(`
    INSERT OR REPLACE INTO documents (case_id, index_number, doc_type, title, file_path, filed_date, party, status, notes, portal_index, has_pdf)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'filed', ?, ?, ?)
  `);

  let downloaded = 0, skipped = 0, placeholders = 0, errors = 0;

  for (const ev of domEvents) {
    if (!ev.date || !ev.indexNum) continue;
    const date = normalizeDate(ev.date);
    const party = mapParty(ev.filedBy);
    const docType = mapDocType(ev.eventType, ev.description);
    const title = ev.description || ev.eventType;

    if (!ev.hasDocIcon) {
      // No PDF — create placeholder if not already exists
      if (!existingPlaceholders.has(ev.indexNum)) {
        insertDoc.run(caseId, `IDX${String(ev.indexNum).padStart(3, '0')}`, docType, title, null, date, party,
          `No PDF available on portal. Event: ${ev.eventType}`, ev.indexNum, 0);
        placeholders++;
      }
      continue;
    }

    // Already downloaded
    if (existingPDFs.has(ev.indexNum)) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      const fn = buildFilename(date, ev.indexNum, docType, party, ev.description || ev.eventType);
      log(`  📄 WOULD download IDX${ev.indexNum} → ${fn}`);
      downloaded++;
      continue;
    }

    // Download the PDF
    try {
      if (ev.isCollapsed) {
        // Force-click via JavaScript for zero-height elements
        await page.evaluate((domIdx) => {
          const section = Array.from(document.querySelectorAll('md-card')).find(c => {
            const h = c.querySelector('.header-text, h1');
            return h && h.innerText.trim() === 'Case Events';
          });
          const divs = section.querySelectorAll('.roa-event-info');
          const div = divs[domIdx];
          if (!div) throw new Error('div not found');
          const icon = div.querySelector('img.roa-icon.roa-clickable');
          if (!icon) throw new Error('no icon');
          div.style.height = 'auto';
          div.style.overflow = 'visible';
          icon.style.width = '16px';
          icon.style.height = '16px';
          icon.click();
        }, ev.domIndex);
      } else {
        // Normal click with scroll into view
        const eventRow = page.locator('.roa-event-info').nth(ev.domIndex);
        const icon = eventRow.locator('img.roa-icon.roa-clickable').first();
        await icon.scrollIntoViewIfNeeded({ timeout: 3000 });
        await page.waitForTimeout(300);
        await Promise.race([
          icon.click(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('click timeout')), 5000))
        ]);
      }

      const download = await page.waitForEvent('download', { timeout: 15000 });

      const filename = buildFilename(date, ev.indexNum, docType, party, ev.description || ev.eventType);
      const folder = routeToFolder(docType, party);
      ensureDir(folder);
      const filePath = path.join(folder, filename);

      await download.saveAs(filePath);
      log(`  ✓ IDX${ev.indexNum} → ${filename}`);

      insertDoc.run(caseId, `IDX${String(ev.indexNum).padStart(3, '0')}`, docType, title, filePath, date, party,
        'Downloaded from Tyler Tech portal', ev.indexNum, 1);
      downloaded++;

      await page.waitForTimeout(1500);

    } catch (err) {
      log(`  ✗ IDX${ev.indexNum} ${date} ${ev.eventType} — ${err.message.substring(0, 80)}`);
      errors++;
    }
  }

  return { downloaded, skipped, placeholders, errors, total: domEvents.length };
}

// ── Parsing ─────────────────────────────────────────────────────────────────
function parseEvents(text) {
  const events = [];
  const blocks = text.split(/(?=\d{2}\/\d{2}\/\d{4}\n)/);

  for (const block of blocks) {
    const lines = block.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    const dateMatch = lines[0].match(/^(\d{2}\/\d{2}\/\d{4})$/);
    if (!dateMatch) continue;

    const date = normalizeDate(dateMatch[1]);
    const indexLine = lines.find(l => /^Index #\s*\d+$/.test(l));
    const indexNum = indexLine ? parseInt(indexLine.match(/\d+/)[0]) : null;

    let eventType = '';
    let description = '';
    const contentLines = lines.slice(1).filter(l => l !== indexLine && !/^Index #/.test(l));
    if (contentLines.length > 0) {
      eventType = contentLines[0];
      const descLine = contentLines[1];
      if (descLine && !descLine.startsWith('Filed By:') && !descLine.startsWith('Against:') && !descLine.startsWith('Created:')) {
        description = descLine;
      }
    }

    const fullBlock = lines.join(' ');
    let filedBy = mapParty(fullBlock);
    const filedByMatch = fullBlock.match(/Filed By:\s*(.*?)(?:Against:|Created:|$)/);
    if (filedByMatch) {
      filedBy = mapParty(filedByMatch[1]);
    } else if (fullBlock.includes('Judicial Officer')) {
      filedBy = 'CRT';
    }

    events.push({
      date, indexNum,
      eventType: eventType.replace(/\s+/g, ' ').trim(),
      description: description.replace(/\s+/g, ' ').trim(),
      filedBy,
      rawText: lines.join('\n')
    });
  }

  return events;
}

function parseHearings(text) {
  const hearings = [];
  const blocks = text.split(/(?=\d{2}\/\d{2}\/\d{4}\n)/);

  for (const block of blocks) {
    const lines = block.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    const dateMatch = lines[0].match(/^(\d{2}\/\d{2}\/\d{4})$/);
    if (!dateMatch) continue;

    const date = normalizeDate(dateMatch[1]);
    const fullText = lines.slice(1).join(' ');
    const timeMatch = fullText.match(/(\d{1,2}:\d{2}\s*[AP]M)/);
    const time = timeMatch ? timeMatch[1] : '';
    const typeLine = lines[1] || '';
    const canceled = typeLine.includes('CANCELED');

    let outcome = '';
    if (fullText.includes('Hearing Held')) outcome = 'Hearing Held';
    else if (fullText.includes('Continued')) outcome = 'Continued';
    else if (canceled) outcome = 'Canceled';
    else if (fullText.includes('Removed')) outcome = 'Removed';
    else if (fullText.includes('Other')) outcome = 'Other';

    hearings.push({
      date, time,
      type: typeLine.replace(/\s+/g, ' ').trim(),
      canceled, outcome,
      description: lines.slice(1, 4).join(' ').replace(/\s+/g, ' ').trim(),
      rawText: lines.join('\n')
    });
  }

  return hearings;
}

// ── Database ────────────────────────────────────────────────────────────────
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS court_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      event_date DATE NOT NULL,
      index_num INTEGER,
      event_type TEXT,
      description TEXT,
      filed_by TEXT,
      raw_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(index_num)
    );
    CREATE TABLE IF NOT EXISTS court_hearings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      hearing_date DATE NOT NULL,
      hearing_time TEXT,
      hearing_type TEXT,
      description TEXT,
      outcome TEXT,
      canceled INTEGER DEFAULT 0,
      raw_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(hearing_date, hearing_type)
    );
    CREATE TABLE IF NOT EXISTS scrape_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      new_events INTEGER DEFAULT 0,
      new_hearings INTEGER DEFAULT 0,
      status TEXT,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS deadline_analysis_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES cases(id),
      run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      mode TEXT,
      trigger_reason TEXT,
      new_events INTEGER DEFAULT 0,
      new_hearings INTEGER DEFAULT 0,
      added INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      error TEXT
    );
  `);
  try { db.exec('ALTER TABLE documents ADD COLUMN portal_index INTEGER'); } catch {}
  try { db.exec('ALTER TABLE documents ADD COLUMN has_pdf INTEGER DEFAULT 0'); } catch {}
}

function getLastDeadlineAiRun(db, caseId) {
  return db.prepare(`
    SELECT run_at, mode, trigger_reason, error
    FROM deadline_analysis_runs
    WHERE case_id = ?
    ORDER BY run_at DESC
    LIMIT 1
  `).get(caseId) || null;
}

function shouldRunDeadlineAi(db, caseId, { newEvents, newHearings, forceAi }) {
  if (forceAi) {
    return { run: true, reason: 'forced by --force-ai' };
  }
  if (newEvents > 0 || newHearings > 0) {
    return { run: true, reason: 'new docket activity' };
  }

  const last = getLastDeadlineAiRun(db, caseId);
  const today = new Date().toISOString().slice(0, 10);
  const lastDate = String(last?.run_at || '').slice(0, 10);
  if (lastDate === today && last?.error) {
    return { run: true, reason: 'retry after earlier AI analysis error' };
  }
  if (lastDate !== today) {
    return { run: true, reason: 'daily verification run' };
  }

  return {
    run: false,
    reason: `already ran today (${last?.run_at || 'unknown'})`,
  };
}

function syncEvents(db, caseId, events) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO court_events (case_id, event_date, index_num, event_type, description, filed_by, raw_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let newCount = 0;
  for (const e of events) {
    if (e.indexNum === null) continue;
    const info = insert.run(caseId, e.date, e.indexNum, e.eventType, e.description, e.filedBy, e.rawText);
    if (info.changes > 0) newCount++;
  }
  return newCount;
}

function syncHearings(db, caseId, hearings) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO court_hearings (case_id, hearing_date, hearing_time, hearing_type, description, outcome, canceled, raw_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let newCount = 0;
  for (const h of hearings) {
    const info = insert.run(caseId, h.date, h.time, h.type, h.description, h.outcome, h.canceled ? 1 : 0, h.rawText);
    if (info.changes > 0) newCount++;
  }
  return newCount;
}

function updateDeadlines(db, caseId, hearings, events) {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = hearings.filter(h => !h.canceled && h.date >= today);
  let added = 0, resolved = 0;

  const check = db.prepare('SELECT id FROM deadlines WHERE case_id = ? AND due_date = ? AND description LIKE ?');
  const insert = db.prepare(`
    INSERT INTO deadlines (case_id, description, due_date, triggered_by, rule_reference, status, priority)
    VALUES (?, ?, ?, ?, ?, 'pending', 'high')
  `);

  for (const h of upcoming) {
    const desc = `Hearing — ${h.type}`;
    const existing = check.get(caseId, h.date, `%${h.type.substring(0, 20)}%`);
    if (!existing) {
      insert.run(caseId, desc, h.date, 'Court portal scrape', 'N/A');
      added++;
    }
  }

  // Auto-resolve deadlines for canceled hearings
  const canceled = hearings.filter(h => h.canceled);
  const resolveDl = db.prepare("UPDATE deadlines SET status = 'moot', notes = ? WHERE case_id = ? AND due_date = ? AND status = 'pending'");
  for (const h of canceled) {
    const info = resolveDl.run(`Hearing canceled per court portal scrape.`, caseId, h.date);
    resolved += info.changes;
  }

  // Auto-resolve deadlines for withdrawn motions
  if (events) {
    const withdrawals = events.filter(e =>
      (e.eventType || '').toLowerCase().includes('withdrawal') ||
      (e.description || '').toLowerCase().includes('withdrawal')
    );
    for (const w of withdrawals) {
      const desc = (w.description || w.eventType || '').substring(0, 30);
      const rows = db.prepare("SELECT id, description FROM deadlines WHERE case_id = ? AND status = 'pending' AND description LIKE ?").all(caseId, `%${desc}%`);
      for (const row of rows) {
        db.prepare("UPDATE deadlines SET status = 'moot', notes = ? WHERE id = ?")
          .run(`Motion withdrawn (${w.date}). Auto-resolved by scraper.`, row.id);
        resolved++;
      }
    }
  }

  return { added, resolved };
}

// ── Timeline ────────────────────────────────────────────────────────────────
function updateTimeline(events) {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  let md = `# Case Timeline: ${CASE_NUMBER}\n\n`;
  md += '| Date | Event | Index | Filed By | Notes |\n';
  md += '|------|-------|-------|----------|-------|\n';

  for (const e of sorted) {
    const idx = e.indexNum ? `IDX${String(e.indexNum).padStart(3, '0')}` : '';
    const desc = (e.description || e.eventType).replace(/\|/g, '/');
    const type = e.eventType.replace(/\|/g, '/');
    md += `| ${e.date} | ${type} | ${idx} | ${e.filedBy} | ${desc} |\n`;
  }

  return md;
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  let browser;
  try {
    ensureDir(LOG_DIR);
    log('=== Court Filing Monitor Run ===');

    // Open browser (stays open for both scraping and PDF downloads)
    const session = await openPortal();
    browser = session.browser;
    const page = session.page;

    // Scrape text content
    const { eventsText, hearingsText, caseInfo } = await scrapeTexts(page);
    const events = parseEvents(eventsText);
    const hearings = parseHearings(hearingsText);
    log(`Parsed ${events.length} case events, ${hearings.length} hearings.`);

    if (DRY_RUN) {
      log('DRY RUN — no database changes.');
      log(`Events: ${events.map(e => `${e.date} IDX${e.indexNum} ${e.eventType}`).join('\n  ')}`);
    } else {
      const db = new Database(DB_PATH);
      ensureSchema(db);

      const caseRow = db.prepare('SELECT id FROM cases WHERE case_number = ?').get(CASE_NUMBER);
      if (!caseRow) { log('ERROR: Case not found in database.'); process.exit(1); }
      const caseId = caseRow.id;

      // Sync events & hearings
      const newEvents = syncEvents(db, caseId, events);
      const newHearings = syncHearings(db, caseId, hearings);
      const deadlineResult = updateDeadlines(db, caseId, hearings, events);

      log(`New events: ${newEvents} | New hearings: ${newHearings} | New deadlines: ${deadlineResult.added} | Resolved deadlines: ${deadlineResult.resolved}`);

      // Update timeline
      const timelineMd = updateTimeline(events);
      fs.writeFileSync(TIMELINE_PATH, timelineMd, 'utf8');
      log('Updated case_timeline.md.');

      // Download new PDFs
      if (!SKIP_PDFS) {
        log('');
        log('── PDF Downloads ──');
        const pdfResult = await downloadNewPDFs(page, db, caseId);
        log(`PDFs: ${pdfResult.downloaded} downloaded, ${pdfResult.skipped} skipped, ${pdfResult.placeholders} placeholders, ${pdfResult.errors} errors`);
      }

      // AI deadline analysis
      if (!DRY_RUN && !SKIP_AI) {
        log('');
        log('── AI Deadline Analysis ──');
        const aiPlan = shouldRunDeadlineAi(db, caseId, {
          newEvents,
          newHearings,
          forceAi: FORCE_AI,
        });
        if (!aiPlan.run) {
          log(`Skipping AI analysis: ${aiPlan.reason}`);
        } else {
          const aiMode = AI_LATEST ? 'latest' : 'backfill';
          log(`Trigger: ${aiPlan.reason} | mode=${aiMode}`);
          let aiResult = { added: 0, skipped: 0, error: null };
          try {
            aiResult = await analyzeForDeadlines(db, caseId, {
              dryRun: false,
              backfill: !AI_LATEST,
              logFn: log,
            });
            log(`AI deadlines: ${aiResult.added} added, ${aiResult.skipped} skipped${aiResult.error ? ` (error: ${aiResult.error})` : ''}`);
          } catch (err) {
            aiResult = { added: 0, skipped: 0, error: err.message };
            log(`AI deadline analysis failed (non-fatal): ${err.message}`);
          }

          db.prepare(`
            INSERT INTO deadline_analysis_runs (case_id, mode, trigger_reason, new_events, new_hearings, added, skipped, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            caseId,
            aiMode,
            aiPlan.reason,
            newEvents,
            newHearings,
            Number(aiResult.added || 0),
            Number(aiResult.skipped || 0),
            aiResult.error || null
          );
        }
      } else if (SKIP_AI) {
        log('AI deadline analysis skipped by --skip-ai');
      }

      // Log the scrape run
      db.prepare('INSERT INTO scrape_log (new_events, new_hearings, status, notes) VALUES (?, ?, ?, ?)')
        .run(newEvents, newHearings, 'success', `Events: ${events.length}, Hearings: ${hearings.length}`);

      // Report new items + filing response reactor
      if (newEvents > 0 || newHearings > 0) {
        log('');
        log('══════ NEW FILINGS DETECTED ══════');
        const recentEvents = db.prepare(
          'SELECT * FROM court_events WHERE case_id = ? ORDER BY created_at DESC LIMIT ?'
        ).all(caseId, newEvents || 1);
        for (const e of recentEvents) {
          log(`  📄 ${e.event_date} | IDX${e.index_num} | ${e.event_type} | ${e.description || ''}`);
        }

        // Filing Response Reactor: auto-alert on new PLT filings
        try {
          const caseTools = require('./case-tools');
          const pltFilings = recentEvents.filter((e) => String(e.filed_by || '').toUpperCase() === 'PLT');
          const existingAlertKeys = new Set(
            caseTools.getRecentAlerts(30)
              .filter((a) => a.type === 'new_plt_filing' && a.alertKey)
              .map((a) => String(a.alertKey)),
          );

          for (const f of pltFilings) {
            const alertKey = [
              String(f.index_num || '').trim(),
              String(f.event_date || '').trim(),
              String(f.event_type || '').trim(),
              String(f.description || '').trim(),
            ].join('|').toLowerCase();

            if (existingAlertKeys.has(alertKey)) {
              log(`  ⚡ Alert skipped (already exists): IDX${f.index_num}`);
              continue;
            }

            const skeleton = caseTools.buildResponseSkeleton(f);
            const saved = caseTools.saveAlert({
              type: 'new_plt_filing',
              message: `New PLT filing: IDX${f.index_num} — ${f.description || f.event_type}. Response (${skeleton.response.docType}) due ${skeleton.response.deadline}.`,
              priority: 'high',
              alertKey,
              filing: skeleton,
            });

            if (saved) {
              existingAlertKeys.add(alertKey);
              log(`  ⚡ Alert created: respond to IDX${f.index_num} by ${skeleton.response.deadline}`);
            } else {
              log(`  ⚠️ Alert save failed for IDX${f.index_num}`);
            }
          }
        } catch (err) {
          log(`  Filing reactor error (non-fatal): ${err.message}`);
        }
      } else {
        log('No new filings since last check.');
      }

      db.close();
    }

    // Close browser
    await browser.close();
    log('Browser closed.');

    // Save log
    const logFile = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(logFile, logLines.join('\n') + '\n\n', 'utf8');
    log(`Log saved to ${logFile}`);

  } catch (err) {
    log(`ERROR: ${err.message}`);
    console.error(err);
    if (browser) try { await browser.close(); } catch {}
    process.exit(1);
  }
})();
