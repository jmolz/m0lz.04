#!/usr/bin/env node
// refresh-tools-cache.js — Pre-compute tool panel data and write to ui-state/tools-cache/
// Run via launchd/cron every 5-10 minutes for instant panel loads.
// Usage: node scripts/refresh-tools-cache.js [--verbose]

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CASE_DB_PATH = path.join(PROJECT_ROOT, 'case-tracker.db');
const CACHE_DIR = path.join(PROJECT_ROOT, 'scripts', 'ui-state', 'tools-cache');
const VERBOSE = process.argv.includes('--verbose');

let Database;
try { Database = require('better-sqlite3'); } catch { Database = null; }

const caseTools = require('./case-tools');

function log(msg) {
  if (VERBOSE) console.log(`[tools-cache] ${msg}`);
}

function writeCache(name, data) {
  const payload = { ...data, _cachedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(CACHE_DIR, `${name}.json`), JSON.stringify(payload, null, 2));
  log(`  wrote ${name}.json`);
}

function refreshAssignmentChain() {
  try {
    const result = caseTools.getAssignmentChain();
    writeCache('assignment-chain', { ok: true, ...result });
  } catch (err) {
    log(`  chain error: ${err.message}`);
  }
}

function refreshAlerts() {
  try {
    const alerts = caseTools.getRecentAlerts();
    writeCache('alerts', { ok: true, alerts });
  } catch (err) {
    log(`  alerts error: ${err.message}`);
  }
}

function refreshWithDb(name, fn) {
  if (!Database || !fs.existsSync(CASE_DB_PATH)) {
    writeCache(name, { ok: false, reason: 'Database not available' });
    return;
  }
  const db = new Database(CASE_DB_PATH, { readonly: true });
  try {
    const result = fn(db);
    if (result) {
      writeCache(name, { ok: true, ...result });
    } else {
      writeCache(name, { ok: false, reason: 'No data available' });
    }
  } catch (err) {
    log(`  ${name} error: ${err.message}`);
  } finally {
    db.close();
  }
}

function refreshDiscovery(db) {
  return caseTools.getDiscoveryCompliance(db);
}

function refreshPatterns(db) {
  return caseTools.analyzePlaintiffPatterns(db);
}

function refreshReactor(db) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const filings = caseTools.detectNewPlaintiffFilings(db, since);
  const skeletons = filings.map((f) => caseTools.buildResponseSkeleton(f));
  return { filings: skeletons };
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const start = Date.now();
  log(`Refreshing tools cache → ${CACHE_DIR}`);

  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  refreshAssignmentChain();
  refreshAlerts();
  refreshWithDb('discovery', refreshDiscovery);
  refreshWithDb('plaintiff-patterns', refreshPatterns);
  refreshWithDb('response-reactor', refreshReactor);

  const elapsed = Date.now() - start;
  log(`Done in ${elapsed}ms`);

  // Write a manifest so the server knows cache freshness
  fs.writeFileSync(
    path.join(CACHE_DIR, '_manifest.json'),
    JSON.stringify({ refreshedAt: new Date().toISOString(), elapsedMs: elapsed }, null, 2),
  );
}

main();
