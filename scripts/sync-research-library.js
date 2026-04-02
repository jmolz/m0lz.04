#!/usr/bin/env node
/**
 * Daily Research Library Sync ("Kron")
 *
 * Goals:
 * - Keep statutes/local rules/case law up to date.
 * - Detect changes and emit log markers for launchd notifications.
 *
 * NOTES:
 * - This script makes network requests.
 * - It is designed to be called by scripts/run-court-check.sh (launchd).
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESEARCH_ROOT = path.join(PROJECT_ROOT, '07_Research');

const STATUTES_DIR = path.join(RESEARCH_ROOT, 'statutes');
const LOCAL_RULES_DIR = path.join(RESEARCH_ROOT, 'local_rules');
const CASE_LAW_DIR = path.join(RESEARCH_ROOT, 'case_law');

const STATE_DIR = path.join(PROJECT_ROOT, 'scripts', 'state');
const STATE_FILE = path.join(STATE_DIR, 'research-sync.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function download(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { files: {}, lastRunAt: null };
  }
}

function saveState(state) {
  ensureDir(STATE_DIR);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function syncFile({ id, url, outPath, archiveDir }) {
  const data = await download(url);
  const hash = sha256(data);

  const exists = fs.existsSync(outPath);
  const prevHash = exists ? sha256(fs.readFileSync(outPath)) : null;

  if (!exists || prevHash !== hash) {
    ensureDir(path.dirname(outPath));

    if (exists && archiveDir) {
      ensureDir(archiveDir);
      const base = path.basename(outPath);
      const stamp = new Date().toISOString().slice(0, 10);
      const archived = path.join(archiveDir, `${stamp}__${base}`);
      fs.copyFileSync(outPath, archived);
    }

    fs.writeFileSync(outPath, data);
    return { id, changed: true, bytes: data.length, hash };
  }

  return { id, changed: false, bytes: data.length, hash };
}

async function syncStatutes(state) {
  // Phase 1: re-sync full chapter HTML for tracked chapters.
  // (We already extract curated markdown files; this keeps the HTML canonical source current.)
  const CHAPTERS = {
    '1': 'Civil_Procedure',
    '1A': 'Rules_of_Civil_Procedure',
    '1C': 'Enforcement_of_Judgments',
    '6': 'Costs_Attorney_Fees',
    '7A': 'Judicial_Department',
    '8C': 'Evidence_Code',
    '24': 'Interest',
    '25': 'UCC',
    '32C': 'Uniform_Power_of_Attorney_Act',
    '58': 'Insurance',
    '75': 'Consumer_Protection',
    // Future: Chapter 66 (UETA) and other additions.
  };

  const base = 'https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByChapter';
  const archiveDir = path.join(STATUTES_DIR, '_archive_html');

  const updates = [];
  for (const [ch, name] of Object.entries(CHAPTERS)) {
    const id = `statute_chapter_html_${ch}`;
    const url = `${base}/Chapter_${ch}.html`;
    const outPath = path.join(STATUTES_DIR, `Chapter_${ch}_${name}.html`);
    const res = await syncFile({ id, url, outPath, archiveDir });
    updates.push(res);
    state.files[id] = { url, outPath, hash: res.hash, updatedAt: new Date().toISOString() };
    console.log(`  ${res.changed ? '✓' : '⊘'} Chapter ${ch} HTML (${name})`);
  }

  const changed = updates.filter((u) => u.changed);
  return { changedCount: changed.length, updates };
}

// ── Local Rules PDF catalog ─────────────────────────────────────────────────
// Curated list of civil-district-relevant PDFs from the local court rules landing page.
// Keys are stable sync IDs; values describe the remote path and local destination.
const LOCAL_RULES_PDFS = {
  // Rules
  'wake_cvd_local_rules': {
    remote: '/assets/documents/local-rules-forms/Civil District Local Rules 3-2025.pdf',
    local: 'rules/Civil-District-Local-Rules-2025.pdf',
    label: 'Civil District Local Rules (2025)',
  },
  // Admin orders
  'wake_admin_audio_video': {
    remote: '/assets/documents/local-rules-forms/2024.06.24 Filed Admin Order[. . .].pdf',
    label: 'Admin Order — Audio/Video Recording (2024)',
    local: 'admin_orders/Admin-Order-Audio-Video-Recording-2024.pdf',
  },
  'wake_admin_briefs': {
    remote: '/assets/documents/local-rules-forms/2024.07.30 Admin Order Filed - Filing Briefs and Memoranda - 24R000573-910.pdf',
    label: 'Admin Order — Filing Briefs & Memoranda (2024)',
    local: 'admin_orders/Admin-Order-Filing-Briefs-Memoranda-2024.pdf',
  },
  'wake_admin_pretrial': {
    remote: '/assets/documents/local-rules-forms/2022.03.15 Admin Order - Pretrial Release Policy.pdf',
    label: 'Admin Order — Pretrial Release Policy (2022)',
    local: 'admin_orders/Admin-Order-Pretrial-Release-Policy-2022.pdf',
  },
  'wake_admin_cvd_assignment': {
    remote: '/assets/documents/local-rules-forms/1720.pdf',
    label: 'Admin Order — Civil District Court Assignment',
    local: 'admin_orders/Admin-Order-Civil-District-Court-Assignment.pdf',
  },
  'wake_admin_calendar_pub': {
    remote: '/assets/documents/local-rules-forms/445.pdf',
    label: 'Admin Order — Calendar Publication/Subscription',
    local: 'admin_orders/Admin-Order-Calendar-Publication-Subscription.pdf',
  },
  // CVD forms
  'wake_cvd_01': {
    remote: '/assets/documents/local-rules-forms/1962.pdf',
    label: 'WAKE-CVD-01 Calendar Request',
    local: 'forms/WAKE-CVD-01-Calendar-Request.pdf',
  },
  'wake_cvd_02': {
    remote: '/assets/documents/local-rules-forms/1963.pdf',
    label: 'WAKE-CVD-02 Motion/Order to Continue',
    local: 'forms/WAKE-CVD-02-Motion-Order-to-Continue.pdf',
  },
  'wake_cvd_03': {
    remote: '/assets/documents/local-rules-forms/1964.pdf',
    label: 'WAKE-CVD-03 Peremptory Setting Request',
    local: 'forms/WAKE-CVD-03-Peremptory-Setting-Request.pdf',
  },
  'wake_cvd_04': {
    remote: '/assets/documents/local-rules-forms/1965.pdf',
    label: 'WAKE-CVD-04 Arbitration Waiver',
    local: 'forms/WAKE-CVD-04-Arbitration-Waiver.pdf',
  },
  'wake_cvd_05': {
    remote: '/assets/documents/local-rules-forms/WAKE-CVD-05 Civil District Order Cover Sheet (Revised April 2023).pdf',
    label: 'WAKE-CVD-05 Order Submission Cover Sheet',
    local: 'forms/WAKE-CVD-05-Order-Submission-Cover-Sheet.pdf',
  },
  'wake_cvd_06': {
    remote: '/assets/documents/local-rules-forms/Form Wake-CVD-6 Updated August 2023.pdf',
    label: 'WAKE-CVD-06 Motion Information Sheet',
    local: 'forms/WAKE-CVD-06-Motion-Information-Sheet.pdf',
  },
  'wake_cvd_9c_spring_2026_schedule': {
    remote: 'https://www.nccourts.gov/assets/inline-files/Civil%20District%20Court%209C%20Spring%202026%20Session%20Schedule.pdf?VersionId=8NP.41pdOfNEFro_qzQkZeRuh10JYo8g',
    label: 'Wake Civil District Court 9C Spring 2026 Session Schedule',
    local: 'calendars/Civil-District-Court-9C-Spring-2026-Session-Schedule.pdf',
  },
};

async function syncLocalRules(state) {
  const NCCOURTS = 'https://www.nccourts.gov';

  // Phase 1 (unchanged): landing page HTML for change detection.
  const landingUrl = `${NCCOURTS}/locations/wake-county/wake-county-local-rules-and-forms`;
  const landingId = 'wake_local_rules_landing_html';
  const landingOut = path.join(LOCAL_RULES_DIR, '_sources', 'wake-local-rules-and-forms.html');
  const landingArchive = path.join(LOCAL_RULES_DIR, '_archive_sources');

  const landingRes = await syncFile({ id: landingId, url: landingUrl, outPath: landingOut, archiveDir: landingArchive });
  state.files[landingId] = { url: landingUrl, outPath: landingOut, hash: landingRes.hash, updatedAt: new Date().toISOString() };
  console.log(`  ${landingRes.changed ? '✓' : '⊘'} Wake local rules landing page`);

  // Phase 2: re-sync curated PDFs with hash comparison and archiving.
  const pdfArchive = path.join(LOCAL_RULES_DIR, '_archive_pdfs');
  const updates = [landingRes];

  for (const [id, entry] of Object.entries(LOCAL_RULES_PDFS)) {
    const url = entry.remote.startsWith('http') ? entry.remote : `${NCCOURTS}${entry.remote}`;
    const outPath = path.join(LOCAL_RULES_DIR, entry.local);
    try {
      const res = await syncFile({ id, url, outPath, archiveDir: pdfArchive });
      state.files[id] = { url, outPath, hash: res.hash, updatedAt: new Date().toISOString() };
      updates.push(res);
      console.log(`  ${res.changed ? '✓' : '⊘'} ${entry.label}`);
    } catch (err) {
      console.log(`  ✗ ${entry.label}: ${err.message}`);
      updates.push({ id, changed: false, error: err.message });
    }
  }

  const changed = updates.filter((u) => u.changed);
  return { changedCount: changed.length, updates };
}

// ── Case Law Sync (CourtListener) ───────────────────────────────────────────
// Searches CourtListener for recent NC appellate opinions relevant to this case.
// Writes markdown digest files under 07_Research/case_law/.
const COURTLISTENER_API = 'https://www.courtlistener.com/api/rest/v4';

// Search queries targeting our defense themes.
// Note: CourtListener API does not support exact-phrase quoting; use plain terms.
const CASE_LAW_QUERIES = [
  { id: 'standing_debt_buyer', q: 'debt buyer standing assignment', label: 'Standing — Debt Buyer' },
  { id: 'power_of_attorney_litigation', q: 'power attorney litigation authority scope', label: 'POA Litigation Authority' },
  { id: 'substitution_of_parties', q: 'substitution parties standing void complaint', label: 'Substitution of Parties' },
  { id: 'real_party_interest_debt', q: 'real party interest debt collection', label: 'Real Party in Interest — Debt' },
  { id: 'district_court_jurisdiction_amount', q: 'district court jurisdiction amount controversy', label: 'District Court Jurisdiction Amount' },
];

// CourtListener does not support comma-separated court IDs; query each separately.
const CL_COURTS = ['ncctapp', 'nc'];

function buildCourtListenerUrl(query, court, afterDate) {
  const params = new URLSearchParams({
    q: query,
    type: 'o',
    court,
    order_by: 'dateFiled desc',
    filed_after: afterDate,
  });
  return `${COURTLISTENER_API}/search/?${params.toString()}`;
}

function downloadJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client
      .get(url, { headers: { 'User-Agent': 'CasePilot-CaseLaw-Sync/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadJson(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        });
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

function opinionToDigest(result) {
  const cite = (result.citation && result.citation.length)
    ? result.citation.join(', ')
    : result.court_citation_string || result.cluster_id || 'N/A';
  const snippet = (result.opinions && result.opinions[0] && result.opinions[0].snippet)
    ? result.opinions[0].snippet
    : '(no snippet available)';
  const lines = [
    `# ${result.caseName || 'Untitled'}`,
    '',
    `- **Citation**: ${cite}`,
    `- **Court**: ${result.court || 'N/A'}`,
    `- **Date Filed**: ${result.dateFiled || 'N/A'}`,
    `- **Docket**: ${result.docketNumber || 'N/A'}`,
    `- **CourtListener URL**: https://www.courtlistener.com${result.absolute_url || ''}`,
    '',
    '## Snippet',
    '',
    snippet.replace(/<\/?mark>/g, '**').replace(/<[^>]+>/g, ''),
    '',
  ];
  return lines.join('\n');
}

async function syncCaseLaw(state) {
  ensureDir(CASE_LAW_DIR);
  ensureDir(path.join(CASE_LAW_DIR, 'digests'));

  // Look back 90 days (or since last run if more recent).
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const lastCaseLawRun = state.caseLawLastRun || ninetyDaysAgo;
  const afterDate = lastCaseLawRun > ninetyDaysAgo ? ninetyDaysAgo : ninetyDaysAgo;

  let totalNew = 0;
  const allUpdates = [];
  const seenIds = new Set(Object.keys(state.caseLawSeen || {}));

  for (const topic of CASE_LAW_QUERIES) {
    let topicNew = 0;
    let topicError = null;

    // Query each court separately and merge (API doesn't support multi-court).
    for (const court of CL_COURTS) {
      const url = buildCourtListenerUrl(topic.q, court, afterDate);
      try {
        const data = await downloadJson(url);
        const results = data.results || [];

        for (const r of results.slice(0, 5)) {
          const opId = String(r.cluster_id || r.id || r.absolute_url || '');
          if (!opId || seenIds.has(opId)) continue;

          seenIds.add(opId);
          const digest = opinionToDigest(r);
          const safeName = (r.caseName || opId).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
          const digestPath = path.join(CASE_LAW_DIR, 'digests', `${safeName}.md`);
          fs.writeFileSync(digestPath, digest);

          if (!state.caseLawSeen) state.caseLawSeen = {};
          state.caseLawSeen[opId] = {
            caseName: r.caseName,
            dateFiled: r.dateFiled,
            topic: topic.id,
            court,
            digestPath,
            syncedAt: new Date().toISOString(),
          };

          topicNew++;
          totalNew++;
        }
      } catch (err) {
        topicError = err;
      }

      // Rate-limit: brief pause between API calls.
      await new Promise((r) => setTimeout(r, 400));
    }

    if (topicError && topicNew === 0) {
      console.log(`  ✗ ${topic.label}: ${topicError.message}`);
      allUpdates.push({ id: topic.id, changed: false, error: topicError.message });
    } else {
      console.log(`  ${topicNew > 0 ? '✓' : '⊘'} ${topic.label}: ${topicNew} new opinion(s)`);
      allUpdates.push({ id: topic.id, changed: topicNew > 0, newCount: topicNew });
    }
  }

  state.caseLawLastRun = new Date().toISOString().slice(0, 10);

  // Write a combined index of all known opinions.
  if (totalNew > 0) {
    const indexLines = ['# Case Law Index', '', `Last updated: ${new Date().toISOString()}`, ''];
    for (const [opId, info] of Object.entries(state.caseLawSeen || {})) {
      indexLines.push(`- **${info.caseName || opId}** (${info.dateFiled || '?'}) — topic: ${info.topic}`);
    }
    fs.writeFileSync(path.join(CASE_LAW_DIR, 'index.md'), indexLines.join('\n'));
  }

  return { changedCount: totalNew, updates: allUpdates };
}

(async () => {
  ensureDir(STATUTES_DIR);
  ensureDir(LOCAL_RULES_DIR);
  ensureDir(CASE_LAW_DIR);

  const state = loadState();

  console.log('── Research Library Sync ──');

  const statutes = await syncStatutes(state);
  const localRules = await syncLocalRules(state);
  const caseLaw = await syncCaseLaw(state);

  const totalChanges = statutes.changedCount + localRules.changedCount + caseLaw.changedCount;
  state.lastRunAt = new Date().toISOString();
  saveState(state);

  console.log('');
  console.log(`Research sync complete. Changes: ${totalChanges}`);

  if (totalChanges > 0) {
    // Marker for scripts/run-court-check.sh to trigger notification.
    console.log('RESEARCH UPDATES DETECTED');
  }
})().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
