#!/usr/bin/env node
/**
 * Sync research status metadata in 07_Research/README.md.
 *
 * Best-effort goals:
 * 1) Keep "Last Updated" current when memo/todo research sources change.
 * 2) Normalize priority lane language for debt-buyer status.
 *
 * Usage:
 *   node scripts/sync-research-status.js
 *   node scripts/sync-research-status.js --force
 *   node scripts/sync-research-status.js --watch
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const README_PATH = path.join(PROJECT_ROOT, '07_Research', 'README.md');
const TODO_PATH = path.join(PROJECT_ROOT, '00_Case_Overview', 'todo.md');
const MEMOS_DIR = path.join(PROJECT_ROOT, '07_Research', 'memos');

const CANONICAL_PRIORITY_STATUS_BLOCK = [
  'Priority status:',
  '1. **Intrepid v. Amerex** — Standing; complaint as nullity ✅',
  '2. **Rule 25 substitution in nullity posture** — anchored via WLAE/Coderre line ✅',
  '3. **Void ab initio effect on later orders** — anchored via Allred/Cunningham line ✅',
  '4. NC debt buyer standing / documentation requirements — Townes materially verified (precedentially limited); Spencer fit-to-issue still pending ⏳',
  '5. POA scope — when POA authorizes transfer but not litigation ⏳',
].join('\n');

function todayLocalIsoDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function listMemoFiles() {
  try {
    if (!fs.existsSync(MEMOS_DIR)) return [];
    return fs
      .readdirSync(MEMOS_DIR)
      .filter((name) => name.endsWith('.md'))
      .map((name) => path.join(MEMOS_DIR, name));
  } catch {
    return [];
  }
}

function getMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function hasSourceChangedSinceReadme() {
  const readmeMtime = getMtimeMs(README_PATH);
  const sourceFiles = [TODO_PATH, ...listMemoFiles()];
  return sourceFiles.some((filePath) => getMtimeMs(filePath) > readmeMtime);
}

function normalizePriorityStatusBlock(content) {
  const marker = 'Priority status:';
  const start = content.indexOf(marker);
  if (start === -1) {
    throw new Error('Priority status block start marker not found in README.md');
  }

  const end = content.indexOf('\n## ', start + marker.length);
  if (end === -1) {
    throw new Error('Priority status block end marker (next level-2 heading) not found in README.md');
  }

  const before = content.slice(0, start);
  const after = content.slice(end);
  return `${before}${CANONICAL_PRIORITY_STATUS_BLOCK}\n${after}`;
}

function normalizeLastUpdated(content, dateStr) {
  const linePattern = /^Last Updated:\s*\d{4}-\d{2}-\d{2}$/m;
  const replacement = `Last Updated: ${dateStr}`;
  if (linePattern.test(content)) {
    return content.replace(linePattern, replacement);
  }

  const casePattern = /^Case:\s.*$/m;
  if (casePattern.test(content)) {
    return content.replace(casePattern, (m) => `${m}\n${replacement}`);
  }

  return `${replacement}\n\n${content}`;
}

function syncOnce({ force = false, reason = 'manual' } = {}) {
  const current = readFileSafe(README_PATH);
  if (current === null) {
    console.error(`ERROR: README not found at ${README_PATH}`);
    process.exitCode = 1;
    return;
  }

  const sourceChanged = hasSourceChangedSinceReadme();
  let next;

  try {
    next = normalizePriorityStatusBlock(current);
  } catch (err) {
    console.error(`[sync-research-status] ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (force || sourceChanged) {
    next = normalizeLastUpdated(next, todayLocalIsoDate());
  }

  if (next !== current) {
    fs.writeFileSync(README_PATH, next, 'utf8');
    console.log(`[sync-research-status] Updated README (${reason}).`);
  } else {
    console.log(`[sync-research-status] No changes needed (${reason}).`);
  }
}

function startWatch() {
  console.log('[sync-research-status] Watching todo + memos for changes...');

  let timer = null;
  const schedule = (reason) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => syncOnce({ reason }), 350);
  };

  const watchFile = (filePath, label) => {
    if (!fs.existsSync(filePath)) return;
    fs.watch(filePath, () => schedule(label));
  };

  watchFile(TODO_PATH, 'todo-watch');

  if (fs.existsSync(MEMOS_DIR)) {
    fs.watch(MEMOS_DIR, (eventType, filename) => {
      if (!filename || !String(filename).endsWith('.md')) return;
      schedule(`memo-watch:${eventType}`);
    });
  }

  // Initial sync on startup.
  syncOnce({ reason: 'watch-start' });
}

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const watch = args.has('--watch');

if (watch) {
  startWatch();
} else {
  syncOnce({ force, reason: force ? 'force' : 'run' });
}
