#!/usr/bin/env node
/**
 * Migration: Create filing_outcomes table and seed with historical docket data.
 *
 * Run once:  node scripts/migrate-filing-outcomes.js
 * Safe to re-run — uses UPSERT and keeps seeded rows authoritative.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.resolve(__dirname, '..', 'case-tracker.db');
const db = new Database(DB_PATH);

// ── Schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS filing_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER REFERENCES cases(id),

    -- Filing identification
    motion_idx TEXT NOT NULL,
    motion_date DATE,
    motion_type TEXT,
    motion_description TEXT,
    filed_by TEXT,

    -- Stakes segmentation
    stakes_tier TEXT NOT NULL DEFAULT 'contested',
    contested_by TEXT,
    opposition_idx TEXT,

    -- Disposition
    ruling_idx TEXT,
    ruling_date DATE,
    ruling_judge TEXT,
    outcome TEXT,
    outcome_notes TEXT,

    -- Hearing data
    hearing_date DATE,
    hearing_notes TEXT,
    oral_arg_duration_sec INTEGER,
    oral_arg_format TEXT,
    judge_questions TEXT,
    judge_demeanor TEXT,

    -- Filing characteristics
    word_count INTEGER,
    num_arguments INTEGER,
    filing_style TEXT,

    -- Post-mortem
    strategic_lesson TEXT,
    what_worked TEXT,
    what_failed TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(motion_idx)
  );
`);

console.log('✓ filing_outcomes table created (or already exists).');

// ── Seed Data ───────────────────────────────────────────────────────────────
const CASE_ID = 1;

const outcomes = [
  // ═══════════════════════════════════════════════════════════════════════════
  // IDX047 batch — Walczyk denied all DEF motions from May/June in one order
  // Hearing: July 10, 2025. All contested substantive motions.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    motion_idx: 'IDX021', motion_date: '2025-05-02', motion_type: 'MOT',
    motion_description: 'Motion for Costs from Arbitration Proceeding',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    filing_style: 'multi_issue',
    outcome_notes: 'Denied as part of blanket order denying multiple motions.',
    strategic_lesson: 'Filed in a batch of 4 motions on same day. Judge batch-denied all. Single-issue filings may fare better.',
  },
  {
    motion_idx: 'IDX022', motion_date: '2025-05-02', motion_type: 'MOT',
    motion_description: 'Motion for Bond Requirement',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    filing_style: 'multi_issue',
    outcome_notes: 'Denied in same blanket order as IDX021.',
    strategic_lesson: 'Part of May 2 batch filing. Unusual ask for District Court debt case.',
  },
  {
    motion_idx: 'IDX023', motion_date: '2025-05-02', motion_type: 'MOT',
    motion_description: 'Motion for More Definite Statement',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    filing_style: 'multi_issue',
    outcome_notes: 'Denied in same blanket order.',
    strategic_lesson: 'Part of May 2 batch. Rule 12(e) motions rarely granted in NC District Court.',
  },
  {
    motion_idx: 'IDX025', motion_date: '2025-05-14', motion_type: 'MOT',
    motion_description: 'Motion for Reasonable Accommodations Under ADA',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    filing_style: 'multi_issue',
    outcome_notes: 'Denied in blanket order. Filed in batch of 4 on May 14.',
    strategic_lesson: 'Part of second batch filing (4 motions on May 14). ADA accommodation request may have been better as standalone letter to clerk.',
  },
  {
    motion_idx: 'IDX026', motion_date: '2025-05-14', motion_type: 'MOT',
    motion_description: 'Motion for Protective Order Limiting Depositions',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    filing_style: 'multi_issue',
    outcome_notes: 'Denied in blanket order.',
    strategic_lesson: 'Part of May 14 batch. Premature — no deposition had been noticed.',
  },
  {
    motion_idx: 'IDX027', motion_date: '2025-05-14', motion_type: 'MOT',
    motion_description: 'Motion for Appointment of Rule 706 Expert Witness',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    filing_style: 'multi_issue',
    outcome_notes: 'Denied in blanket order.',
    strategic_lesson: 'Rule 706 expert appointment is extremely rare in District Court civil. High judge-friction ask.',
  },
  {
    motion_idx: 'IDX028', motion_date: '2025-05-14', motion_type: 'MOT',
    motion_description: 'Motion for Sanctions for Coordinated Refusal to Accept Service',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    filing_style: 'multi_issue',
    outcome_notes: 'Denied in blanket order.',
    strategic_lesson: 'Sanctions motions against opposing counsel create judge-friction without proportional benefit in District Court.',
  },
  {
    motion_idx: 'IDX035', motion_date: '2025-06-04', motion_type: 'MOT',
    motion_description: 'Emergency Motion to Vacate Ex Parte Orders and For Sanctions',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    filing_style: 'emergency',
    outcome_notes: 'Denied in blanket order. Emergency hearing held June 11 (IDX045) but substantive ruling deferred to July 10.',
    strategic_lesson: 'Emergency motions that get deferred to regular calendar lose their urgency framing. Either the emergency is real enough for immediate relief or it should be filed as routine.',
  },
  {
    motion_idx: 'IDX036', motion_date: '2025-06-04', motion_type: 'MOT',
    motion_description: 'Emergency Motion to Compel Discovery, For Sanctions, and For Contempt',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    filing_style: 'multi_issue',
    outcome_notes: 'Denied in blanket order. Three asks in one motion (compel + sanctions + contempt).',
    strategic_lesson: 'Compel/sanctions/contempt combined = too many asks. The later standalone Motion to Compel (IDX049) was GRANTED. Lesson: one ask per motion.',
  },
  {
    motion_idx: 'IDX041', motion_date: '2025-06-05', motion_type: 'MOT',
    motion_description: 'Opposition to Motion to Strike & Motion for Rule 11 Sanctions',
    filed_by: 'DEF', stakes_tier: 'contested',
    contested_by: 'PLT', opposition_idx: 'IDX040',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    filing_style: 'multi_issue',
    outcome_notes: 'Combined opposition + affirmative sanctions request. Denied.',
    strategic_lesson: 'Responsive filings should respond. Embedding an affirmative sanctions motion inside an opposition dilutes both.',
  },
  {
    motion_idx: 'IDX044', motion_date: '2025-06-09', motion_type: 'MOT',
    motion_description: 'Emergency Relief: Immediate Vacatur of Void Orders Entered Without Notice',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    filing_style: 'emergency',
    outcome_notes: 'Denied. Second emergency motion on same topic (vacatur). First was IDX035.',
    strategic_lesson: 'Filing multiple emergency motions on the same issue signals desperation, not urgency. One clean emergency motion or none.',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DEF Motion to Compel — THE ONE WIN (Walczyk granted)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    motion_idx: 'IDX049', motion_date: '2025-07-16', motion_type: 'MOT',
    motion_description: 'Motion to Compel Discovery',
    filed_by: 'DEF', stakes_tier: 'contested',
    contested_by: 'PLT', opposition_idx: 'IDX054',
    ruling_idx: 'IDX080', ruling_date: '2025-12-10', ruling_judge: 'WALCZYK',
    outcome: 'granted', hearing_date: '2025-12-10',
    filing_style: 'single_issue',
    outcome_notes: 'Granted. Same judge (Walczyk) who denied the earlier batch. Single issue, clear rule violation, narrow ask. IMPORTANT FOLLOW-THROUGH: Plaintiff-side proposed order/final compliance lagged materially after ruling and required repeated follow-up (including Trial Court Administrator outreach) before completion.',
    strategic_lesson: 'THE MODEL FILING. Single issue (discovery non-compliance). One rule (Rule 37). One ask (compel responses). Filed standalone, not in a batch. Walczyk granted despite denying 11 prior motions. Practical reality: in this division, merits can carry the ruling, but post-ruling timing compliance may still require persistent follow-up to force closure.',
    what_worked: 'Single issue. Clear rule violation by opposing party. Narrow relief. No sanctions request bundled in.',
    what_failed: null,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PLT procedural motions — extensions, continuances (all granted)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    motion_idx: 'IDX029', motion_date: '2025-06-02', motion_type: 'MOT',
    motion_description: 'Motion for Extension of Time to Respond to Discovery',
    filed_by: 'PLT', stakes_tier: 'procedural',
    contested_by: 'DEF', opposition_idx: 'IDX037',
    ruling_idx: 'IDX034', ruling_date: '2025-06-03', ruling_judge: null,
    outcome: 'granted',
    outcome_notes: 'Granted next day. DEF opposition (IDX037) filed day after ruling — too late.',
    strategic_lesson: 'Extensions are rubber-stamped. Opposing them burns credibility for zero gain unless there is demonstrable prejudice.',
  },
  {
    motion_idx: 'IDX032', motion_date: '2025-06-02', motion_type: 'MOT',
    motion_description: 'Motion to Extend Time to Respond to Counterclaims',
    filed_by: 'PLT', stakes_tier: 'procedural',
    contested_by: 'DEF', opposition_idx: 'IDX038',
    ruling_idx: 'IDX033', ruling_date: '2025-06-03', ruling_judge: null,
    outcome: 'granted',
    outcome_notes: 'Granted next day. Pattern: ex parte extension orders granted before opposition can be filed.',
    strategic_lesson: 'Same-day or next-day grants on extensions. If you plan to oppose, you must file a preemptive objection or call chambers.',
  },
  {
    motion_idx: 'IDX064', motion_date: '2025-08-22', motion_type: 'MOT',
    motion_description: 'Motion to Continue Jury Trial September 8, 2025',
    filed_by: 'PLT', stakes_tier: 'procedural',
    contested_by: 'DEF', opposition_idx: 'IDX065',
    ruling_idx: 'IDX066', ruling_date: '2025-08-27', ruling_judge: 'HAUTER',
    outcome: 'granted',
    outcome_notes: 'Granted despite DEF objection (IDX065). Trial continued.',
    strategic_lesson: 'Continuances are granted over objection. Standard in NC District Court.',
  },
  {
    motion_idx: 'IDX077', motion_date: '2025-12-08', motion_type: 'MOT',
    motion_description: 'Motion to Continue',
    filed_by: 'PLT', stakes_tier: 'procedural',
    contested_by: 'DEF', opposition_idx: 'IDX078',
    ruling_idx: 'IDX081', ruling_date: '2025-12-10', ruling_judge: 'BAKER',
    outcome: 'granted',
    outcome_notes: 'Granted despite DEF opposition (IDX078).',
    strategic_lesson: 'PLT continuance pattern continues. 4th granted continuance.',
  },
  {
    motion_idx: 'IDX096', motion_date: '2026-01-13', motion_type: 'MOT',
    motion_description: 'Motion to Continue MSJ Hearing',
    filed_by: 'PLT', stakes_tier: 'procedural',
    contested_by: 'DEF', opposition_idx: 'IDX093',
    ruling_idx: 'IDX099', ruling_date: '2026-01-16', ruling_judge: 'DAVIDIAN',
    outcome: 'granted',
    outcome_notes: 'MSJ hearing continued to 03/26/26.',
    strategic_lesson: '5th PLT continuance granted. Pattern is now established — potential prejudice-from-delay argument.',
  },
  {
    motion_idx: 'IDX097', motion_date: '2026-01-13', motion_type: 'MOT',
    motion_description: 'Motion to Continue Jury Trial',
    filed_by: 'PLT', stakes_tier: 'procedural',
    contested_by: 'DEF', opposition_idx: 'IDX092',
    ruling_idx: 'IDX098', ruling_date: '2026-01-16', ruling_judge: 'WILLIAMS',
    outcome: 'granted',
    outcome_notes: 'Trial continued to 03/30/26 awaiting ruling on motion to amend.',
    strategic_lesson: '6th PLT continuance granted. Over a year of delay from original filing.',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DEF procedural motions
  // ═══════════════════════════════════════════════════════════════════════════
  {
    motion_idx: 'IDX048', motion_date: '2025-07-14', motion_type: 'MOT',
    motion_description: 'Motion to Continue',
    filed_by: 'DEF', stakes_tier: 'procedural',
    ruling_idx: 'IDX050', ruling_date: '2025-07-17', ruling_judge: null,
    outcome: 'granted',
    outcome_notes: 'Trial date 7/21/25 continued.',
    strategic_lesson: 'DEF continuances also granted when unopposed.',
  },
  {
    motion_idx: 'IDX058', motion_date: '2025-08-11', motion_type: 'MOT',
    motion_description: 'Motion for Extension of Time to Respond to Discovery',
    filed_by: 'DEF', stakes_tier: 'procedural',
    ruling_idx: 'IDX062', ruling_date: '2025-08-14', ruling_judge: 'BAKER',
    outcome: 'denied',
    outcome_notes: 'Denied by Baker. Unusual — extensions are typically granted.',
    strategic_lesson: 'Baker denied DEF extension but later granted PLT continuance. May reflect bias or may reflect different circumstances. Note for judge profile.',
  },
  {
    motion_idx: 'IDX067', motion_date: '2025-08-28', motion_type: 'MOT',
    motion_description: 'Motion for Leave to File Second Amended Answer',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: null, ruling_date: '2025-10-03', ruling_judge: 'WALCZYK',
    outcome: 'granted',
    outcome_notes: 'Implicitly granted — Second Amended Answer filed as IDX071 on 2025-10-03.',
    strategic_lesson: 'Unopposed leave-to-amend motions are often granted. File early and keep amendment narrow.',
    what_worked: 'Leave to amend granted, allowing DEF to cure and refine pleading posture before dispositive motion phase.',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Pending contested motions
  // ═══════════════════════════════════════════════════════════════════════════
  {
    motion_idx: 'IDX040', motion_date: '2025-06-05', motion_type: 'MOT',
    motion_description: 'Pre-Reply Motion to Strike Counterclaims',
    filed_by: 'PLT', stakes_tier: 'contested',
    contested_by: 'DEF', opposition_idx: 'IDX041',
    ruling_idx: 'IDX047', ruling_date: '2025-07-10', ruling_judge: 'WALCZYK',
    outcome: 'denied', hearing_date: '2025-07-10',
    outcome_notes: 'Denied in Judge Walczyk\'s multi-motion hearing/order context (IDX047: Order on Denying Multiple Motions).',
  },
  {
    motion_idx: 'IDX053', motion_date: '2025-07-21', motion_type: 'MOT',
    motion_description: 'Motion to Strike Defenses from PLT Reply to Counterclaims',
    filed_by: 'DEF', stakes_tier: 'contested',
    outcome: 'moot',
    outcome_notes: 'Superseded by subsequent pleading amendments. DEF filed Second Amended Answer (IDX071, 10/03/25). PLT Motion to Amend (IDX075) granted 02/12/26. Original reply defenses no longer operative.',
  },
  {
    motion_idx: 'IDX055', motion_date: '2025-08-07', motion_type: 'MOT',
    motion_description: 'Motion for Judgment on Pleadings — Mandatory Statutory Dismissal',
    filed_by: 'DEF', stakes_tier: 'contested',
    ruling_idx: null, ruling_date: '2025-08-21', ruling_judge: null,
    outcome: 'denied', hearing_date: '2025-08-21',
    outcome_notes: 'Denied at 08/21/25 hearing (court hearing notes reflect DEF motion for judgment on pleadings denied).',
    strategic_lesson: 'Mandatory-dismissal framing did not carry at hearing; tighten rule trigger and relief sequencing.',
  },
  {
    motion_idx: 'IDX072', motion_date: '2025-11-07', motion_type: 'MOT',
    motion_description: 'Motion for Summary Judgment and Memorandum of Law',
    filed_by: 'DEF', stakes_tier: 'contested',
    contested_by: 'PLT', opposition_idx: 'IDX095',
    outcome: 'pending',
    outcome_notes: 'DEF MSJ filed 11/07/25. Hearing continued to 03/26/26 per Order IDX099 (Judge Davidian). PLT filed opposition memo (IDX095). NOTE: PLT Motion to Amend (IDX075) was granted 02/12/26 but amended complaint not yet filed/served — MSJ may become moot if complaint is substantively amended. Hearing date confirmed by court order but subject to change if amendment alters claims.',
  },
  {
    motion_idx: 'IDX075', motion_date: '2025-12-08', motion_type: 'MOT',
    motion_description: 'Motion to Amend Complaint',
    filed_by: 'PLT', stakes_tier: 'contested',
    contested_by: 'DEF', opposition_idx: 'IDX079',
    ruling_idx: null, ruling_date: '2026-02-12', ruling_judge: 'DAVIDIAN',
    outcome: 'granted', hearing_date: '2026-02-12',
    outcome_notes: 'PLT Motion to Amend granted 02/12/26 by Judge Davidian. Attorney Garcia-Davis appeared. However, the actual amended complaint has NOT yet been filed/served. Clock for DEF response has not started. Trial continued to 03/30/26 per IDX098 (Judge Williams) was awaiting ruling on motion to amend — that ruling is now complete. WATCH COMPLIANCE: Plaintiff counsel had a deadline to circulate/file the proposed order and performance appears late; one draft was reportedly circulated by opposing counsel but not promptly filed, requiring repeated follow-up. Watch for: (1) entry of written order, (2) filing/service of operative amended complaint, (3) potential impact on pending MSJs if claims change substantively.',
    strategic_lesson: 'PLT successfully obtained leave to amend before dispositive rulings. Key question: will amendment substantively change claims or just cure technical defects? If substantive, DEF MSJ may need supplemental briefing. Also, do not assume post-hearing paperwork will be timely absent pressure, monitor and memorialize delays.',
  },
  {
    motion_idx: 'IDX085', motion_date: '2026-01-13', motion_type: 'MOT',
    motion_description: 'Plaintiff Motion for Summary Judgment',
    filed_by: 'PLT', stakes_tier: 'contested',
    outcome: 'pending',
    outcome_notes: 'PLT MSJ filed 01/13/26 with affidavit (IDX086). Hearing set for 03/26/26 per Order IDX099 (Judge Davidian). DEF cross-MSJ (IDX072) also pending. NOTE: PLT Motion to Amend (IDX075) granted 02/12/26 but amended complaint not yet filed/served — if amendment substantively changes claims, both MSJs may need to be refiled or supplemented.',
  },
  {
    motion_idx: 'IDX094', motion_date: '2026-01-14', motion_type: 'MOT',
    motion_description: 'Motion to Enforce Order to Compel',
    filed_by: 'DEF', stakes_tier: 'contested',
    outcome: 'withdrawn',
    outcome_notes: 'Withdrawn by DEF (IDX101, 2026-02-23).',
    strategic_lesson: 'Enforcement motion withdrawn — may indicate discovery compliance achieved or strategic pivot.',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Ministerial — tracked for completeness, excluded from win rate
  // ═══════════════════════════════════════════════════════════════════════════
  {
    motion_idx: 'IDX009', motion_date: '2025-02-24', motion_type: 'COS',
    motion_description: 'Certificate of Service — Answer',
    filed_by: 'DEF', stakes_tier: 'ministerial', outcome: 'filed',
  },
  {
    motion_idx: 'IDX083', motion_date: '2025-12-30', motion_type: 'STIP',
    motion_description: 'Stipulated Protective Order',
    filed_by: 'CRT', stakes_tier: 'ministerial', outcome: 'entered',
  },
  {
    motion_idx: 'IDX101', motion_date: '2026-02-23', motion_type: 'NOT',
    motion_description: 'Withdrawal of Motion to Enforce Order to Compel',
    filed_by: 'DEF', stakes_tier: 'ministerial', outcome: 'filed',
  },
];

// ── Insert ──────────────────────────────────────────────────────────────────
const columns = [
  'case_id', 'motion_idx', 'motion_date', 'motion_type', 'motion_description',
  'filed_by', 'stakes_tier', 'contested_by', 'opposition_idx',
  'ruling_idx', 'ruling_date', 'ruling_judge', 'outcome', 'outcome_notes',
  'hearing_date', 'hearing_notes', 'oral_arg_duration_sec', 'oral_arg_format',
  'judge_questions', 'judge_demeanor',
  'word_count', 'num_arguments', 'filing_style',
  'strategic_lesson', 'what_worked', 'what_failed',
];

const placeholders = columns.map(() => '?').join(', ');
const updateAssignments = columns
  .filter((col) => col !== 'motion_idx')
  .map((col) => `${col}=excluded.${col}`)
  .join(', ');
const insert = db.prepare(`
  INSERT INTO filing_outcomes (${columns.join(', ')})
  VALUES (${placeholders})
  ON CONFLICT(motion_idx) DO UPDATE SET ${updateAssignments}
`);

const tx = db.transaction(() => {
  let applied = 0;
  for (const o of outcomes) {
    const values = columns.map((col) => {
      if (col === 'case_id') return CASE_ID;
      return o[col] ?? null;
    });
    const info = insert.run(...values);
    if (info.changes > 0) applied++;
  }
  return applied;
});

const applied = tx();
const totalRows = db.prepare('SELECT COUNT(*) AS n FROM filing_outcomes WHERE case_id = ?').get(CASE_ID).n;
console.log(`✓ Applied ${applied} filing outcomes (${outcomes.length} seeds processed, ${totalRows} rows present for case ${CASE_ID}).`);

// ── Verify ──────────────────────────────────────────────────────────────────
const stats = db.prepare(`
  SELECT
    stakes_tier,
    outcome,
    COUNT(*) as cnt
  FROM filing_outcomes
  WHERE case_id = ?
  GROUP BY stakes_tier, outcome
  ORDER BY stakes_tier, outcome
`).all(CASE_ID);

console.log('\nOutcome summary:');
for (const row of stats) {
  console.log(`  ${row.stakes_tier.padEnd(14)} ${(row.outcome || 'null').padEnd(16)} ${row.cnt}`);
}

const contested = db.prepare(`
  SELECT filed_by, outcome, COUNT(*) as cnt
  FROM filing_outcomes
  WHERE case_id = ? AND stakes_tier = 'contested' AND LOWER(outcome) IN ('granted', 'denied')
  GROUP BY filed_by, outcome
  ORDER BY filed_by, outcome
`).all(CASE_ID);

console.log('\nContested outcomes (granted/denied only):');
for (const row of contested) {
  console.log(`  ${row.filed_by.padEnd(5)} ${row.outcome.padEnd(16)} ${row.cnt}`);
}

db.close();
console.log('\n✓ Migration complete.');
