#!/usr/bin/env node
/**
 * AI Deadline Analyzer — Case Pilot
 *
 * Post-scrape step: feeds new court events/hearings through Claude to detect
 * triggered deadlines, then inserts them into the deadlines table.
 *
 * Called from check-court-filings.js after sync, or standalone for backfill.
 *
 * Usage (standalone):
 *   node deadline-analyzer.js              # analyze latest events/hearings
 *   node deadline-analyzer.js --backfill   # re-analyze all events
 *   node deadline-analyzer.js --dry-run    # show what would be added
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const cfg = require('./case-config');

// ── Config ──────────────────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'case-tracker.db');
const ENV_PATH = path.join(__dirname, 'ui-state', '.env');

// Load API key from .env
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const API_KEY = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
const MODEL = env.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

// ── Case Context (built from case-config.json) ──────────────────────────────────────────
function buildCaseContext() {
  const ci = cfg.caseInfo();
  const d = cfg.defendant();
  const p = cfg.plaintiff();
  const oc = cfg.counsel();
  const attorneys = (oc.attorneys || []).map((a) => a.name).join(', ');
  return [
    `CASE: ${p.original || p.current || 'Plaintiff'} v. ${d.name || 'Defendant'}`,
    `CASE NO: ${ci.number || ''}`,
    `COURT: ${ci.court || ''}, ${ci.stateShort || ''}`,
    `DEFENDANT: ${d.name || ''} (${d.status || 'Pro Se'})`,
    `PLAINTIFF COUNSEL: ${attorneys} — ${oc.firm || ''}`,
  ].join('\n');
}
const CASE_CONTEXT = buildCaseContext();

const RULES_CONTEXT = `
KEY RULES AND LOCAL RULES FOR DEADLINE DETECTION:

1. LOCAL RULE 16.9(c) — Proposed Orders Following a Hearing:
   Within 20 days of the Court rendering its decision, the attorney directed to draft
   the order shall submit the proposed order to opposing counsel/self-represented persons.
   Opposing party has 5 business days to object to form after receipt.

2. N.C. R. Civ. P. 12(a) — Answer deadlines:
   30 days after service of summons/complaint to answer. Same applies to amended complaints
   once served. If motion under Rule 12 is filed, answer due within 10 days of order ruling
   on the motion (or service of amended pleading if amendment is the ruling).

3. N.C. R. Civ. P. 15(a) — Amended Pleadings:
   When leave to amend is granted, the amended pleading becomes operative once the written
   order is entered. Opposing party must respond within the time remaining for response to
   the original pleading, or 30 days after service, whichever is longer.

4. N.C. R. Civ. P. 56 — Summary Judgment:
   Motion must be served at least 10 days before hearing. Opposing affidavits may be served
   prior to the day of hearing.

5. LOCAL RULE 3.4 — Memoranda:
   Parties shall file memoranda of law at least 2 business days prior to hearing on any
   motion seeking final determination. Affidavits for/against MSJ per Rule 56.

6. LOCAL RULE 6.2 — Pre-Trial Orders and Jury Instructions:
   Required in every jury trial. Due to Trial Court Administrator by 5:00 PM on the
   Wednesday prior to the trial session. Must include: stipulations, witness list,
   exhibit list, issues for jury.

7. N.C. R. Civ. P. 58 — Entry of Judgment:
   Judgment is entered when reduced to writing, signed by judge, filed with clerk.
   Party preparing judgment shall serve copy within 3 days after entry.

8. N.C. R. Civ. P. 59 — Motion for New Trial:
   Must be served within 10 days after entry of judgment.

9. GENERAL DEADLINE RULES:
   - When service is by mail, add 3 days (Rule 6(e))
   - Weekends/holidays: if deadline falls on weekend or holiday, extends to next business day
   - Discovery responses: 30 days after service (Rule 33, 34, 36)
   - Motion responses: typically heard on noticed hearing date; opposition filed before hearing

10. LOCAL RULE 6.4 — Exhibits:
    Pre-mark with sequential numbers. Provide exhibit list to courtroom clerk at start of trial.
`.trim();

// ── Anthropic API ───────────────────────────────────────────────────────────
async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

// ── Dedup Helpers ───────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'at', 'by',
  'is', 'be', 'must', 'shall', 'should', 'may', 'will', 'with', 'from', 'as',
  'all', 'any', 'both', 'each', 'this', 'that', 'not', 'no', 'if', 'after',
  'before', 'prior', 'least', 'parties', 'party', 'court', 'file', 'serve',
  'filed', 'served', 'days', 'day', 'business', 'hearing', 'date',
]);

function extractKeywords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyDeadlineType(text) {
  const t = normalizeText(text);
  if (!t) return 'other';
  if (t.startsWith('hearing ') || t.startsWith('hearing')) return 'hearing';
  if (/\baffidavit\b|\bdeclaration\b/.test(t)) return 'affidavit';
  if (/\bmemorand\w*\b|\bbrief\b/.test(t)) return 'memorandum';
  if (/\bproposed order\b|\bdraft order\b/.test(t)) return 'proposed_order';
  if (/\bobject(?:ion)?\b.*\bform\b|\bform objection\b/.test(t)) return 'order_form_objection';
  if (/\banswer\b|\brespond to amended complaint\b/.test(t)) return 'answer';
  if (/\binterrogator\w*\b|\brequest for production\b|\brequest for admission\b|\bdiscovery\b/.test(t)) return 'discovery';
  if (/\bpre ?trial\b|\bjury instructions?\b|\bexhibit list\b|\bwitness list\b/.test(t)) return 'trial_prep';
  return 'other';
}

function extractObligatedParty(deadlineLike) {
  const direct = String(deadlineLike?.obligated_party || '').trim().toUpperCase();
  if (direct === 'DEF' || direct === 'PLT' || direct === 'BOTH') return direct;

  const notes = String(deadlineLike?.notes || '');
  const m = notes.match(/\[(DEF|PLT|BOTH)\]/i);
  return m ? m[1].toUpperCase() : '';
}

function isSemanticDuplicate(candidate, existing) {
  const candidateType = classifyDeadlineType(candidate.description);
  const existingType = classifyDeadlineType(existing.description);
  if (candidateType !== existingType) return false;

  const candidateParty = extractObligatedParty(candidate);
  const existingParty = extractObligatedParty(existing);
  if (
    candidateParty
    && existingParty
    && candidateParty !== existingParty
    && candidateParty !== 'BOTH'
    && existingParty !== 'BOTH'
  ) {
    return false;
  }

  const candidateText = normalizeText(candidate.description);
  const existingText = normalizeText(existing.description);
  if (candidateText && candidateText === existingText) return true;

  const candidateKeywords = new Set(extractKeywords(candidate.description));
  const existingKeywords = new Set(extractKeywords(existing.description));
  if (!candidateKeywords.size || !existingKeywords.size) return false;

  let overlap = 0;
  for (const keyword of candidateKeywords) {
    if (existingKeywords.has(keyword)) overlap++;
  }

  const smallerSet = Math.min(candidateKeywords.size, existingKeywords.size);
  const unionSize = new Set([...candidateKeywords, ...existingKeywords]).size;
  const overlapRatio = overlap / smallerSet;
  const jaccard = overlap / unionSize;

  return overlap >= 3 && (overlapRatio >= 0.7 || jaccard >= 0.6);
}

function getDateWindow(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  const start = new Date(d);
  start.setDate(start.getDate() - days);
  const end = new Date(d);
  end.setDate(end.getDate() + days);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function chunkArray(items, size) {
  if (!Array.isArray(items) || !items.length) return [[]];
  if (!Number.isFinite(size) || size <= 0) return [items.slice()];
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ── Core Analysis ───────────────────────────────────────────────────────────
async function analyzeForDeadlines(db, caseId, options = {}) {
  const { dryRun = false, backfill = false, logFn = console.log } = options;

  if (!API_KEY) {
    logFn('WARNING: No ANTHROPIC_API_KEY found. Skipping AI deadline analysis.');
    return { added: 0, skipped: 0 };
  }

  if (backfill) {
    logFn('Backfill mode enabled: analyzing full event and hearing history.');
  }

  // Gather context from DB
  const eventLimitClause = backfill ? '' : 'LIMIT 50';
  const hearingLimitClause = backfill ? '' : 'LIMIT 20';

  const events = db.prepare(`
    SELECT index_num, event_date, event_type, description, filed_by
    FROM court_events WHERE case_id = ?
    ORDER BY event_date DESC
    ${eventLimitClause}
  `).all(caseId);

  const hearings = db.prepare(`
    SELECT hearing_date, hearing_time, hearing_type, description, raw_text, outcome
    FROM court_hearings WHERE case_id = ?
    ORDER BY hearing_date DESC
    ${hearingLimitClause}
  `).all(caseId);

  const fetchExistingDeadlines = () => db.prepare(`
    SELECT description, due_date, status, priority, notes
    FROM deadlines WHERE case_id = ?
    ORDER BY due_date
  `).all(caseId);

  const insert = db.prepare(`
    INSERT INTO deadlines (case_id, description, due_date, triggered_by, rule_reference, status, priority, notes)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  async function runBatch(batchEvents, batchHearings, batchIndex, batchCount) {
    const existingDeadlines = fetchExistingDeadlines();
    const today = new Date().toISOString().slice(0, 10);
    const batchLabel = batchCount > 1 ? `\nBACKFILL BATCH: ${batchIndex}/${batchCount}` : '';

    const prompt = `You are a legal deadline analyst for a North Carolina civil case. Your job is to identify ALL deadlines, obligations, and action items triggered by court events and hearings.

${CASE_CONTEXT}

TODAY'S DATE: ${today}${batchLabel}

${RULES_CONTEXT}

RECENT COURT EVENTS (most recent first):
${batchEvents.map(e => `  ${e.event_date} | IDX${e.index_num} | ${e.event_type} | ${e.description || ''} | Filed by: ${e.filed_by || 'unknown'}`).join('\n') || '  (none)'}

HEARINGS:
${batchHearings.map(h => `  ${h.hearing_date} | ${h.hearing_time || ''} | ${h.hearing_type || ''} | ${h.description || ''} | Outcome: ${h.outcome || 'none recorded'} | ${(h.raw_text || '').substring(0, 200)}`).join('\n') || '  (none)'}

EXISTING DEADLINES ALREADY TRACKED:
${existingDeadlines.map(d => `  ${d.due_date} | ${d.status} | ${d.description}`).join('\n') || '  (none)'}

INSTRUCTIONS — READ CAREFULLY:

WHAT TO INCLUDE:
1. Only HARD DEADLINES imposed by rules, statutes, or court orders. A deadline must have a specific triggering event that HAS ALREADY OCCURRED and a rule that creates a calculable due date.
2. Consider obligations for BOTH parties (defendant AND plaintiff).
3. Valid deadline types: response deadlines, order submission deadlines, pre-trial filing deadlines, discovery deadlines, compliance deadlines, service deadlines.

WHAT TO EXCLUDE:
4. DO NOT include strategic advice or recommendations (e.g., "DEF should consider filing a supplemental brief"). Those are not deadlines.
5. DO NOT include deadlines contingent on events that have NOT yet happened (e.g., "If MSJ is granted, then Rule 59 motion due in 10 days"). Only add these AFTER the triggering event occurs.
6. DO NOT include deadlines that are already satisfied (e.g., if a motion was filed 60+ days before a hearing, do NOT flag the 10-day service requirement as a deadline).
7. DO NOT include items where your own analysis concludes "no action needed."
8. DO NOT duplicate existing deadlines. Check CAREFULLY against the existing deadlines list — match by MEANING, not just exact wording. If an existing deadline covers the same obligation on the same or adjacent date (+/- 2 days), DO NOT include it in your output. If you find yourself writing "Already tracked" or "Already partially tracked" in the notes, that means you should NOT include the item.
9. DO NOT include conditional deadlines where the obligation may already be satisfied and you cannot confirm it from the docket (e.g., "if memorandum was not already filed with motion"). Either confirm the obligation exists or omit it.

DATE CALCULATION:
10. Calculate all dates precisely, accounting for weekends and holidays. If a deadline falls on a Saturday, it extends to Monday. If on a Sunday, it extends to Monday.
11. Add 3 days for mail service per Rule 6(e) when applicable.
12. If a deadline depends on a future event (like service of a document not yet served), do NOT estimate a speculative date. Instead, set due_date to the EARLIEST POSSIBLE date and mark it clearly in notes as "DATE DEPENDS ON: [specific trigger event]."

RULE CITATION ACCURACY:
13. Cite the CORRECT rule. Common mistakes to avoid:
    - Rule 58 applies to JUDGMENTS (final dispositions), NOT interlocutory orders. For service of orders, cite Rule 5(a).
    - Rule 56(c) governs MSJ timing — opposing affidavits "prior to the day of hearing."
    - Local Rule 3.4 governs memoranda — 2 business days before hearing.
    - Local Rule 16.9(c) governs proposed orders — 20 days after ruling.
    - Local Rule 6.2 governs pre-trial orders — 5pm Wednesday before trial week.
14. If you are unsure of the correct rule, say so in the notes field rather than citing the wrong rule.

OUTPUT FORMAT:
Respond with ONLY a JSON array of deadline objects. Each object must have:
- "description": concise description of the specific obligation (not strategic advice)
- "due_date": "YYYY-MM-DD" format
- "triggered_by": the specific event/hearing that created this obligation (with IDX number if applicable)
- "rule_reference": the exact rule or statute — must be correct
- "priority": "high" (hard deadline with consequences) or "medium" (soft deadline or best practice) or "low"
- "notes": important context; if date is estimated, explain what it depends on
- "obligated_party": "DEF" or "PLT" or "BOTH"

If there are no new deadlines to add, return an empty array: []

Return ONLY valid JSON, no markdown fences, no explanation.`;

    let response;
    try {
      response = await callClaude(prompt);
    } catch (err) {
      logFn(`ERROR calling Anthropic API: ${err.message}`);
      return { added: 0, skipped: 0, error: err.message };
    }

    let deadlines;
    try {
      let cleaned = response.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      deadlines = JSON.parse(cleaned);
    } catch (err) {
      logFn(`ERROR parsing AI response: ${err.message}`);
      logFn(`Raw response: ${response.substring(0, 500)}`);
      return { added: 0, skipped: 0, error: 'parse_error' };
    }

    if (!Array.isArray(deadlines)) {
      logFn('ERROR: AI response is not an array.');
      return { added: 0, skipped: 0, error: 'not_array' };
    }

    logFn(`AI identified ${deadlines.length} potential deadline(s) for batch ${batchIndex}/${batchCount}.`);

    const existingSet = new Set(
      existingDeadlines.map(d => `${d.due_date}|${d.description.substring(0, 40).toLowerCase()}`)
    );

    let added = 0;
    let skipped = 0;

    for (const dl of deadlines) {
      if (!dl.description || !dl.due_date) {
        logFn(`  SKIP (missing fields): ${JSON.stringify(dl).substring(0, 100)}`);
        skipped++;
        continue;
      }

      const key = `${dl.due_date}|${dl.description.substring(0, 40).toLowerCase()}`;
      if (existingSet.has(key)) {
        logFn(`  SKIP (duplicate): ${dl.due_date} — ${dl.description.substring(0, 60)}`);
        skipped++;
        continue;
      }

      const dateWindow = getDateWindow(dl.due_date, 2);
      const nearbyExisting = db.prepare(
        "SELECT id, description, notes FROM deadlines WHERE case_id = ? AND due_date BETWEEN ? AND ?"
      ).all(caseId, dateWindow.start, dateWindow.end);

      let isDuplicate = false;
      for (const existing of nearbyExisting) {
        if (isSemanticDuplicate(dl, existing)) {
          logFn(`  SKIP (semantic dup of #${existing.id}): ${dl.due_date} — ${dl.description.substring(0, 60)}`);
          isDuplicate = true;
          break;
        }
      }
      if (isDuplicate) { skipped++; continue; }

      if (dl.notes && /already\s+(?:tracked|partially\s+tracked)/i.test(dl.notes)) {
        logFn(`  SKIP (self-identified dup): ${dl.due_date} — ${dl.description.substring(0, 60)}`);
        skipped++;
        continue;
      }

      const party = dl.obligated_party ? ` [${dl.obligated_party}]` : '';
      const notes = (dl.notes || '') + party;

      if (dryRun) {
        logFn(`  WOULD ADD: ${dl.due_date} | ${dl.priority || 'high'} | ${dl.description}`);
        if (dl.notes) logFn(`            Notes: ${dl.notes}`);
        added++;
      } else {
        insert.run(
          caseId,
          dl.description,
          dl.due_date,
          dl.triggered_by || '',
          dl.rule_reference || '',
          dl.priority || 'high',
          notes
        );
        logFn(`  ADDED: ${dl.due_date} | ${dl.priority || 'high'} | ${dl.description}`);
        added++;
      }

      existingSet.add(key);
    }

    return { added, skipped };
  }

  const eventBatches = backfill ? chunkArray(events, 50) : [events];
  const hearingBatches = backfill ? chunkArray(hearings, 20) : [hearings];
  const batchCount = Math.max(eventBatches.length, hearingBatches.length);

  logFn(`Analyzing ${events.length} events and ${hearings.length} hearings for deadlines across ${batchCount} batch(es)...`);

  let totalAdded = 0;
  let totalSkipped = 0;
  for (let i = 0; i < batchCount; i++) {
    const batchEvents = eventBatches[i] || [];
    const batchHearings = hearingBatches[i] || [];
    if (!batchEvents.length && !batchHearings.length) continue;

    const result = await runBatch(batchEvents, batchHearings, i + 1, batchCount);
    totalAdded += Number(result.added || 0);
    totalSkipped += Number(result.skipped || 0);
    if (result.error) {
      return { added: totalAdded, skipped: totalSkipped, error: result.error };
    }
  }

  logFn(`Deadline analysis complete: ${totalAdded} added, ${totalSkipped} skipped.`);
  return { added: totalAdded, skipped: totalSkipped };
}

// ── Exports ─────────────────────────────────────────────────────────────────
module.exports = { analyzeForDeadlines };

// ── Standalone CLI ──────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const backfill = args.includes('--backfill');

  (async () => {
    const db = new Database(DB_PATH);
    const caseRow = db.prepare('SELECT id FROM cases WHERE case_number = ?').get(cfg.caseInfo().number || '');
    if (!caseRow) { console.error('Case not found.'); process.exit(1); }

    const result = await analyzeForDeadlines(db, caseRow.id, {
      dryRun,
      backfill,
      logFn: console.log,
    });

    console.log('\nResult:', result);
    db.close();
  })();
}
