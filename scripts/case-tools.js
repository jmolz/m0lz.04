#!/usr/bin/env node
/**
 * Case Tools — backend utilities for competitive-advantage features.
 *
 * Exports functions consumed by ui-server.js API endpoints.
 */

const fs = require('fs');
const path = require('path');

const cfg = require('./case-config');
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── 1. Citation Verification ───────────────────────────────────────────────

const NC_CASE_RE = /(\b[A-Z][A-Za-z'.]+(?:\s+(?:v|vs)\.?\s+)[A-Z][A-Za-z'.]+),?\s*(\d{1,3})\s+N\.C\.(?:\s+App\.)?\s+(\d{1,4})(?:,\s*(\d{1,3})\s+S\.E\.2d\s+(\d{1,4}))?\s*\((\d{4})\)/g;
const NC_STATUTE_RE = /N\.C\.(?:G\.S\.|Gen\.?\s*Stat\.?)\s*§\s*([\d]+[A-Za-z]?)[-–](\d+(?:\.\d+)?(?:\([a-z0-9]+\))*)/g;
const NC_RULE_RE = /N\.C\.?\s*(?:R\.|Rule(?:s)?)\s*(?:Civ\.\s*P\.\s*)?(\d+)(?:\(([a-z0-9]+)\))?/gi;
const FEDERAL_STATUTE_RE = /(\d{1,2})\s+U\.S\.C\.?\s*§+\s*(\d+[a-z]?(?:\([a-z0-9]+\))*)/g;

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCaseName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}

function isNameCompatible(inputName, resultName) {
  const input = normalizeCaseName(inputName);
  const result = normalizeCaseName(resultName);
  if (!input || !result) return false;
  return result.includes(input) || input.includes(result);
}

function getCitationTexts(result) {
  if (Array.isArray(result?.citation)) {
    return result.citation.map((c) => String(c || ''));
  }
  if (result?.citation) return [String(result.citation)];
  return [];
}

function hasCitationMatch(caseCite, result) {
  const citations = getCitationTexts(result);
  if (!citations.length) return false;

  const ncReporterPattern = new RegExp(
    `\\b${escapeRegExp(caseCite.volume)}\\s+N\\.C\\.(?:\\s+App\\.)?\\s+${escapeRegExp(caseCite.page)}\\b`,
    'i',
  );
  const hasNcReporter = citations.some((c) => ncReporterPattern.test(c));
  if (!hasNcReporter) return false;

  if (caseCite.seVolume && caseCite.sePage) {
    const seReporterPattern = new RegExp(
      `\\b${escapeRegExp(caseCite.seVolume)}\\s+S\\.E\\.2d\\s+${escapeRegExp(caseCite.sePage)}\\b`,
      'i',
    );
    const hasSeReporter = citations.some((c) => seReporterPattern.test(c));
    if (!hasSeReporter) return false;
  }

  const resultYear = String(result?.dateFiled || result?.date_filed || '').slice(0, 4);
  if (caseCite.year && resultYear && caseCite.year !== resultYear) return false;

  return true;
}

function toCourtListenerUrl(absoluteUrl) {
  if (!absoluteUrl) return null;
  try {
    return new URL(String(absoluteUrl), 'https://www.courtlistener.com').toString();
  } catch {
    return null;
  }
}

function extractCitations(text) {
  const cites = [];
  const seen = new Set();
  const raw = String(text || '');

  // NC case citations
  let m;
  while ((m = NC_CASE_RE.exec(raw)) !== null) {
    const key = `case:${m[1].trim()}:${m[2]}:${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cites.push({
      type: 'nc_case',
      raw: m[0],
      caseName: m[1].trim(),
      volume: m[2],
      page: m[3],
      seVolume: m[4] || null,
      sePage: m[5] || null,
      year: m[6],
    });
  }

  // NC statutes
  while ((m = NC_STATUTE_RE.exec(raw)) !== null) {
    const key = `statute:${m[1]}-${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cites.push({
      type: 'nc_statute',
      raw: m[0],
      chapter: m[1],
      section: m[2],
      fullRef: `${m[1]}-${m[2]}`,
    });
  }

  // NC Rules of Civil Procedure
  while ((m = NC_RULE_RE.exec(raw)) !== null) {
    const key = `rule:${m[1]}${m[2] || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cites.push({
      type: 'nc_rule',
      raw: m[0],
      ruleNum: m[1],
      subsection: m[2] || null,
    });
  }

  // Federal statutes
  while ((m = FEDERAL_STATUTE_RE.exec(raw)) !== null) {
    const key = `federal:${m[1]}usc${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cites.push({
      type: 'federal_statute',
      raw: m[0],
      title: m[1],
      section: m[2],
    });
  }

  return cites;
}

async function verifyOnCourtListener(caseCite) {
  const query = encodeURIComponent(`${caseCite.caseName} ${caseCite.volume} N.C. ${caseCite.page} ${caseCite.year}`);
  const url = `https://www.courtlistener.com/api/rest/v4/search/?q=${query}&type=o&court=ncapp+nc&format=json`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CasePilot/1.0 (legal research tool)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { verified: false, reason: `API returned ${resp.status}` };
    const data = await resp.json();
    const results = data.results || [];
    if (!results.length) return { verified: false, reason: 'No results found on CourtListener' };

    for (const r of results.slice(0, 10)) {
      const candidateName = r.caseName || r.case_name || '';
      if (!isNameCompatible(caseCite.caseName, candidateName)) continue;
      if (!hasCitationMatch(caseCite, r)) continue;

      return {
        verified: true,
        match: {
          caseName: candidateName,
          citation: Array.isArray(r.citation) ? (r.citation[0] || null) : (r.citation || null),
          url: toCourtListenerUrl(r.absolute_url),
        },
      };
    }
    return { verified: false, reason: 'No matching reporter/page/year found in CourtListener results' };
  } catch (err) {
    return { verified: false, reason: `CourtListener error: ${err.message}` };
  }
}

function verifyStatuteInLibrary(cite) {
  const researchDir = path.join(PROJECT_ROOT, '07_Research');
  try {
    const files = fs.readdirSync(researchDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(researchDir, file), 'utf8');
      if (cite.type === 'nc_statute') {
        const pattern = `§ ${cite.chapter}-${cite.section}`;
        const altPattern = `${cite.chapter}-${cite.section}`;
        if (content.includes(pattern) || content.includes(altPattern)) {
          return { verified: true, source: `07_Research/${file}` };
        }
      }
      if (cite.type === 'nc_rule') {
        const pattern = `Rule ${cite.ruleNum}`;
        if (content.includes(pattern)) {
          return { verified: true, source: `07_Research/${file}` };
        }
      }
      if (cite.type === 'federal_statute') {
        const pattern = `${cite.title} U.S.C. § ${cite.section}`;
        const altPattern = `${cite.title} U.S.C. §${cite.section}`;
        if (content.includes(pattern) || content.includes(altPattern)) {
          return { verified: true, source: `07_Research/${file}` };
        }
      }
    }
  } catch { /* skip */ }
  return { verified: false, reason: 'Not found in local research library' };
}

async function verifyCitations(text) {
  const cites = extractCitations(text);
  const results = [];

  for (const cite of cites) {
    if (cite.type === 'nc_case') {
      const cl = await verifyOnCourtListener(cite);
      results.push({ ...cite, ...cl });
    } else {
      const lib = verifyStatuteInLibrary(cite);
      results.push({ ...cite, ...lib });
    }
  }

  const verified = results.filter((r) => r.verified).length;
  const unverified = results.filter((r) => !r.verified);
  return {
    total: results.length,
    verified,
    unverified: unverified.length,
    allVerified: unverified.length === 0 && results.length > 0,
    citations: results,
  };
}

// ─── 2. Service Date Calculator ─────────────────────────────────────────────

const NC_HOLIDAYS_2025_2026 = [
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27',
  '2025-11-28', '2025-12-24', '2025-12-25', '2025-12-26',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26',
  '2026-11-27', '2026-12-24', '2026-12-25',
];
const HOLIDAY_SET = new Set(NC_HOLIDAYS_2025_2026);

function isWeekend(d) {
  const day = d.getDay();
  return day === 0 || day === 6;
}

function isHoliday(d) {
  return HOLIDAY_SET.has(d.toISOString().slice(0, 10));
}

function isBusinessDay(d) {
  return !isWeekend(d) && !isHoliday(d);
}

function addCalendarDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d;
}

function nextBusinessDay(d) {
  const result = new Date(d);
  while (!isBusinessDay(result)) {
    result.setDate(result.getDate() + 1);
  }
  return result;
}

/**
 * Calculate a deadline per NC Rule 6.
 * @param {string} triggerDate - YYYY-MM-DD of the triggering event
 * @param {number} days - number of days allowed
 * @param {object} opts
 * @param {boolean} opts.mailService - add 3 days for mail service (Rule 6(e))
 * @param {boolean} opts.businessDays - count business days only (periods < 7 days)
 * @returns {{ deadline: string, calculation: string[] }}
 */
function calculateDeadline(triggerDate, days, opts = {}) {
  const { mailService = false, businessDays = false } = opts;
  const steps = [];
  steps.push(`Trigger date: ${triggerDate}`);

  let effectiveDays = days;
  if (mailService) {
    effectiveDays += 3;
    steps.push(`+3 days for mail service (Rule 6(e)): ${effectiveDays} days total`);
  }

  let deadline;
  if (businessDays) {
    let d = new Date(triggerDate + 'T12:00:00');
    let counted = 0;
    while (counted < effectiveDays) {
      d.setDate(d.getDate() + 1);
      if (isBusinessDay(d)) counted++;
    }
    deadline = d;
    steps.push(`${effectiveDays} business days from trigger`);
  } else {
    deadline = addCalendarDays(triggerDate, effectiveDays);
    steps.push(`${effectiveDays} calendar days from trigger`);
  }

  const raw = deadline.toISOString().slice(0, 10);
  if (!isBusinessDay(deadline)) {
    const adjusted = nextBusinessDay(deadline);
    steps.push(`${raw} falls on weekend/holiday → next business day: ${adjusted.toISOString().slice(0, 10)} (Rule 6(a))`);
    deadline = adjusted;
  }

  return {
    deadline: deadline.toISOString().slice(0, 10),
    calculation: steps,
  };
}

const COMMON_DEADLINES = [
  { label: 'Answer to complaint', days: 30, rule: 'Rule 12(a)' },
  { label: 'Answer to amended complaint', days: 30, rule: 'Rule 12(a), Rule 15' },
  { label: 'Response to motion', days: 21, rule: 'Local Rule / Practice' },
  { label: 'Reply to response', days: 14, rule: 'Local Rule / Practice' },
  { label: 'Discovery responses', days: 30, rule: 'Rule 33(b), 34(b), 36(a)' },
  { label: 'Notice of appeal', days: 30, rule: 'N.C.R. App. P. 3(c)' },
  { label: 'Objections to proposed order', days: 10, rule: 'Practice' },
  { label: 'Motion to set aside default', days: 0, rule: 'Rule 55(d) — no fixed limit, act promptly' },
];

// ─── 3. Chain of Assignment Visualizer ──────────────────────────────────────

function getAssignmentChain() {
  const configChain = cfg.safeGet().assignmentChain;
  const keyCases = (cfg.defense().keyCases || []).map((k) => `${k.name} — ${k.holding}`).join('; ') || '';
  if (configChain && configChain.length) {
    return {
      chain: configChain,
      gaps: configChain.filter((n) => n.status === 'gap').map((n) => n.notes),
      keyCase: keyCases,
      amount: cfg.caseInfo().amount || '',
    };
  }
  return {
    chain: [],
    gaps: ['Assignment chain not configured. Add assignmentChain to case-config.json.'],
    keyCase: keyCases,
    amount: cfg.caseInfo().amount || '',
  };
}

// ─── 4. Discovery Compliance ────────────────────────────────────────────────

function getDiscoveryCompliance(db) {
  if (!db) return null;
  const today = new Date().toISOString().slice(0, 10);

  // Check if discovery_tracking table exists; create if not
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_tracking'").all();
  if (!tables.length) {
    return {
      items: [],
      summary: { total: 0, served: 0, responded: 0, overdue: 0, pending: 0 },
      note: 'Discovery tracking table not yet created. Use POST /api/case/discovery to add items.',
    };
  }

  const items = db.prepare(`
    SELECT * FROM discovery_tracking WHERE case_id = 1
    ORDER BY due_date ASC
  `).all();

  let overdue = 0;
  let pending = 0;
  let responded = 0;
  const enriched = items.map((item) => {
    const daysUntil = item.due_date
      ? Math.ceil((new Date(item.due_date) - new Date(today)) / 86400000)
      : null;
    let status = item.status || 'pending';
    if (status === 'pending' && daysUntil !== null && daysUntil < 0) {
      status = 'overdue';
    }
    if (status === 'overdue') overdue++;
    else if (status === 'pending') pending++;
    else if (status === 'responded' || status === 'complete') responded++;
    return { ...item, daysUntil, effectiveStatus: status };
  });

  return {
    items: enriched,
    summary: {
      total: items.length,
      served: items.filter((i) => i.served_date).length,
      responded,
      overdue,
      pending,
    },
  };
}

// ─── 5. Plaintiff Pattern Predictor ─────────────────────────────────────────

function analyzePlaintiffPatterns(db) {
  if (!db) return null;

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='filing_outcomes'").all();
  if (!tables.length) return null;

  const all = db.prepare("SELECT * FROM filing_outcomes WHERE case_id = 1 ORDER BY motion_date").all();
  if (!all.length) return null;

  const pltFilings = all.filter((r) => r.filed_by === 'PLT');
  const defFilings = all.filter((r) => r.filed_by === 'DEF');

  // Filing cadence analysis
  const pltDates = pltFilings.map((r) => r.motion_date).filter(Boolean).sort();
  const gaps = [];
  for (let i = 1; i < pltDates.length; i++) {
    const diff = Math.ceil((new Date(pltDates[i]) - new Date(pltDates[i - 1])) / 86400000);
    gaps.push(diff);
  }
  const avgGap = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;

  // Motion type frequency
  const typeFreq = {};
  for (const f of pltFilings) {
    const desc = String(f.motion_description || '').toLowerCase();
    let type = 'other';
    if (/continu/i.test(desc)) type = 'continuance';
    else if (/substit/i.test(desc)) type = 'substitution';
    else if (/amend/i.test(desc)) type = 'amendment';
    else if (/summary/i.test(desc)) type = 'summary_judgment';
    else if (/dismiss/i.test(desc)) type = 'dismissal';
    else if (/default/i.test(desc)) type = 'default_judgment';
    else if (/discover/i.test(desc)) type = 'discovery';
    else if (/compel/i.test(desc)) type = 'motion_to_compel';
    typeFreq[type] = (typeFreq[type] || 0) + 1;
  }

  // Reaction patterns: what PLT does after DEF filings
  const reactions = [];
  for (const defFiling of defFilings) {
    const defDate = defFiling.motion_date;
    if (!defDate) continue;
    const pltReactions = pltFilings.filter((p) => {
      if (!p.motion_date) return false;
      const diff = Math.ceil((new Date(p.motion_date) - new Date(defDate)) / 86400000);
      return diff > 0 && diff <= 30;
    });
    if (pltReactions.length) {
      reactions.push({
        trigger: defFiling.motion_description,
        triggerIdx: defFiling.motion_idx,
        responses: pltReactions.map((p) => ({
          description: p.motion_description,
          idx: p.motion_idx,
          daysAfter: Math.ceil((new Date(p.motion_date) - new Date(defDate)) / 86400000),
        })),
      });
    }
  }

  // Continuance pattern
  const continuances = pltFilings.filter((r) => /continu/i.test(r.motion_description || ''));
  const continuanceRate = pltFilings.length > 0
    ? Math.round((continuances.length / pltFilings.length) * 100)
    : 0;

  // Predictions
  const predictions = [];
  const lastPltFiling = pltFilings[pltFilings.length - 1];
  const lastDefFiling = defFilings[defFilings.length - 1];

  if (continuanceRate > 20) {
    predictions.push({
      likelihood: 'high',
      prediction: 'Plaintiff will likely request another continuance',
      basis: `${continuanceRate}% of plaintiff filings have been continuances (${continuances.length}/${pltFilings.length})`,
    });
  }

  if (lastDefFiling) {
    const daysSinceDef = Math.ceil((new Date() - new Date(lastDefFiling.motion_date)) / 86400000);
    if (daysSinceDef < 21) {
      predictions.push({
        likelihood: 'medium',
        prediction: 'Expect plaintiff response/opposition within 14-21 days',
        basis: `DEF filed ${lastDefFiling.motion_description} ${daysSinceDef} days ago`,
      });
    }
  }

  if (typeFreq.summary_judgment) {
    predictions.push({
      likelihood: 'medium',
      prediction: 'Plaintiff may file motion for summary judgment if standing challenge fails',
      basis: 'Standard debt collection litigation progression',
    });
  }

  return {
    totalPlt: pltFilings.length,
    totalDef: defFilings.length,
    avgFilingGap: avgGap,
    typeFrequency: typeFreq,
    continuanceRate,
    reactions,
    predictions,
    lastPltFiling: lastPltFiling ? { idx: lastPltFiling.motion_idx, date: lastPltFiling.motion_date, desc: lastPltFiling.motion_description } : null,
    lastDefFiling: lastDefFiling ? { idx: lastDefFiling.motion_idx, date: lastDefFiling.motion_date, desc: lastDefFiling.motion_description } : null,
  };
}

// ─── 6. CourtListener Search ────────────────────────────────────────────────

async function searchCourtListener(query, { court = 'ncapp,nc', maxResults = 10 } = {}) {
  const q = encodeURIComponent(String(query || '').trim());
  if (!q) return { results: [], total: 0 };

  const url = `https://www.courtlistener.com/api/rest/v4/search/?q=${q}&type=o&court=${court}&format=json&page_size=${maxResults}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CasePilot/1.0 (legal research tool)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { results: [], total: 0, error: `API returned ${resp.status}` };
    const data = await resp.json();
    const results = (data.results || []).map((r) => ({
      caseName: r.caseName || r.case_name || '',
      dateFiled: r.dateFiled || r.date_filed || '',
      citation: Array.isArray(r.citation) ? r.citation : [],
      court: r.court || '',
      url: toCourtListenerUrl(r.absolute_url),
      snippet: String(r.snippet || '').replace(/<[^>]+>/g, '').slice(0, 500),
      status: r.status || '',
    }));
    return { results, total: data.count || results.length };
  } catch (err) {
    return { results: [], total: 0, error: err.message };
  }
}

// ─── 7. Hearing Prep Generator ──────────────────────────────────────────────

function buildHearingPrepPrompt(hearingInfo, caseContext) {
  const d = cfg.defendant();
  const ci = cfg.caseInfo();
  const p = cfg.plaintiff();
  const oc = cfg.counsel();
  const defArgs = (cfg.defense().arguments || []).map((a, i) => `${i + 1}. ${a.label}: ${a.summary}`).join('\n');

  return [
    `You are preparing ${d.name} (${d.status || 'pro se'} defendant) for a court hearing in ${ci.court || 'District Court'}.`,
    '',
    `Case: ${cfg.caseTitleShort()}, ${ci.number || ''}`,
    ci.amount ? `Amount: ${ci.amount}` : '',
    '',
    `HEARING: ${hearingInfo.description || hearingInfo.hearing_type || 'Court hearing'}`,
    `DATE: ${hearingInfo.hearing_date || 'TBD'}`,
    `TIME: ${hearingInfo.hearing_time || 'TBD'}`,
    hearingInfo.notes ? `NOTES: ${hearingInfo.notes}` : '',
    '',
    'CORE DEFENSE ARGUMENTS (use as applicable):',
    defArgs || '(See strategy_notes.md in case context)',
    '',
    caseContext ? `CASE CONTEXT:\n${caseContext}` : '',
    '',
    'PRODUCE EXACTLY TWO VERSIONS:',
    '',
    '## VERSION 1: JESUS WEPT — Full Argument (60-90 seconds spoken)',
    '- Open with: "Your Honor, [one sentence stating what you are asking for]."',
    '- 2-3 strongest points, one sentence each.',
    '- Close with the specific relief requested.',
    '- Must be speakable in under 90 seconds at normal pace.',
    '- Written for the EAR, not the eye — short punchy sentences.',
    '',
    '## VERSION 2: THE CUTOFF — Nuclear Summary (2 sentences max)',
    '- Sentence 1: What happened (the problem).',
    '- Sentence 2: What the court should do about it (the relief).',
    `- Must be memorizable. ${d.name ? d.name.split(' ')[0] : 'You'} can say it without notes while being interrupted.`,
    '',
    '## ANTICIPATE OPPOSITION',
    `- What will ${oc.firm || 'opposing counsel'}\'s attorney likely argue?`,
    '- What is their strongest point?',
    '- What is the one-sentence rebuttal for each likely argument?',
    '',
    '## JUDGE NOTES',
    '- If you have any info on the presiding judge\'s tendencies, include it.',
    `- ${ci.court || 'District Court'} judges batch-process. Brevity wins.`,
  ].filter(Boolean).join('\n');
}

// ─── 8. Filing Response Reactor ─────────────────────────────────────────────

function detectNewPlaintiffFilings(db, sinceDate) {
  if (!db) return [];
  try {
    const since = String(sinceDate || '').trim() || null;
    const events = db.prepare(`
      SELECT index_num, event_date, event_type, description, filed_by, created_at
      FROM court_events
      WHERE case_id = 1
        AND filed_by = 'PLT'
        AND (
          ? IS NULL
          OR (created_at IS NOT NULL AND substr(created_at, 1, 10) >= ?)
          OR (created_at IS NULL AND event_date IS NOT NULL AND event_date >= ?)
        )
      ORDER BY COALESCE(created_at, event_date) DESC, index_num DESC
    `).all(since, since, since);
    return events;
  } catch {
    return [];
  }
}

function buildResponseSkeleton(filing) {
  const desc = String(filing.description || '').toUpperCase();
  let docType = 'RESP';
  let responseRule = 'N.C. R. Civ. P. 6';
  let days = 21;

  if (/MOTION/.test(desc)) {
    docType = 'RESP';
    responseRule = 'Local practice — 21 days';
    days = 21;
  }
  if (/AMENDED COMPLAINT/.test(desc)) {
    docType = 'ANS';
    responseRule = 'N.C. R. Civ. P. 12(a) — 30 days';
    days = 30;
  }
  if (/DISCOVERY|INTERROGATOR|REQUEST FOR/.test(desc)) {
    docType = 'RESP';
    responseRule = 'N.C. R. Civ. P. 33(b)/34(b)/36(a) — 30 days';
    days = 30;
  }
  if (/SUMMARY JUDGMENT/.test(desc)) {
    docType = 'RESP';
    responseRule = 'Practice — opposition due before hearing';
    days = 21;
  }

  const triggerDate = filing.event_date || new Date().toISOString().slice(0, 10);
  const deadline = calculateDeadline(triggerDate, days, { mailService: true });

  return {
    filing: {
      idx: filing.index_num,
      date: filing.event_date,
      description: filing.description,
      type: filing.event_type,
    },
    response: {
      docType,
      responseRule,
      deadline: deadline.deadline,
      calculation: deadline.calculation,
    },
  };
}

// ─── 9. Push Notification Helpers ───────────────────────────────────────────

const ALERTS_DIR = path.join(PROJECT_ROOT, 'scripts', 'ui-state', 'alerts');

function sanitizeAlertType(type) {
  const safe = String(type || 'alert')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return safe || 'alert';
}

function saveAlert(alert) {
  try {
    if (!fs.existsSync(ALERTS_DIR)) fs.mkdirSync(ALERTS_DIR, { recursive: true });
    const alertType = sanitizeAlertType(alert?.type);
    const filename = `${new Date().toISOString().replace(/[:.]/g, '')}_${alertType}.json`;
    fs.writeFileSync(
      path.join(ALERTS_DIR, filename),
      JSON.stringify({ ...alert, createdAt: new Date().toISOString() }, null, 2),
    );
    return true;
  } catch {
    return false;
  }
}

function getRecentAlerts(maxAge = 7) {
  try {
    if (!fs.existsSync(ALERTS_DIR)) return [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAge);

    const files = fs.readdirSync(ALERTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 50);

    const alerts = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(ALERTS_DIR, f), 'utf8'));
        if (new Date(data.createdAt) >= cutoff) {
          alerts.push({ ...data, file: f });
        }
      } catch { /* skip corrupt */ }
    }
    return alerts;
  } catch {
    return [];
  }
}

module.exports = {
  extractCitations,
  verifyCitations,
  verifyOnCourtListener,
  verifyStatuteInLibrary,
  calculateDeadline,
  COMMON_DEADLINES,
  getAssignmentChain,
  getDiscoveryCompliance,
  analyzePlaintiffPatterns,
  searchCourtListener,
  buildHearingPrepPrompt,
  detectNewPlaintiffFilings,
  buildResponseSkeleton,
  saveAlert,
  getRecentAlerts,
};
