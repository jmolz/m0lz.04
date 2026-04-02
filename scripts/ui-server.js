#!/usr/bin/env node
/*
 * Local UI Server (localhost only)
 *
 * Features:
 * - Chat-style workflow for drafting.
 * - Draft objects can be saved/updated, then written into case folders using naming convention.
 * - Optional Anthropic integration via ANTHROPIC_API_KEY (server-side only).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const { buildLegalDocx } = require('./legal-docx-builder');
const caseTools = require('./case-tools');
const cfg = require('./case-config');

const TOOLS_CACHE_DIR = path.join(__dirname, 'ui-state', 'tools-cache');
const TOOLS_CACHE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function readToolsCache(name) {
  try {
    const fp = path.join(TOOLS_CACHE_DIR, `${name}.json`);
    if (!fs.existsSync(fp)) return null;
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!data._cachedAt) return null;
    const age = Date.now() - new Date(data._cachedAt).getTime();
    if (age > TOOLS_CACHE_MAX_AGE_MS) return null;
    return data;
  } catch { return null; }
}

let Database;
try {
  // Optional: only used for /api/case/summary
  // (kept optional so UI still runs if deps aren't installed yet)
  // eslint-disable-next-line global-require
  Database = require('better-sqlite3');
} catch {
  Database = null;
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4000;

function parseIntOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function getAnthropicModel() {
  const model = String(process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL).trim();
  return model || DEFAULT_ANTHROPIC_MODEL;
}

function getAnthropicMaxTokens(override) {
  const raw = override ?? process.env.ANTHROPIC_MAX_TOKENS ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
  const parsed = parseIntOr(raw, DEFAULT_ANTHROPIC_MAX_TOKENS);
  return parsed > 0 ? parsed : DEFAULT_ANTHROPIC_MAX_TOKENS;
}

function supportsAdaptiveThinkingModel(modelId) {
  const model = String(modelId || '').toLowerCase();
  return /claude-(opus|sonnet)-4-6/.test(model);
}

function supportsManualThinkingModel(modelId) {
  const model = String(modelId || '').toLowerCase();
  return /claude-(opus|sonnet|haiku)-4/.test(model) || /claude-3-7-sonnet/.test(model);
}

function normalizeThinkingEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') return effort;
  return 'medium';
}

function isExplicitDraftUpdateRequest(content) {
  const text = String(content || '').toLowerCase();
  if (!text) return false;

  if (/\b(change request|apply (?:this|the)?\s*(?:change|request)?\s*to (?:the )?(?:current )?draft|update (?:the )?(?:current )?draft|revise (?:the )?(?:current )?draft|edit (?:the )?(?:current )?draft|rewrite (?:the )?(?:current )?draft|redraft (?:the )?(?:current )?draft)\b/.test(text)) {
    return true;
  }

  const editVerb = /\b(update|revise|edit|rewrite|redraft|modify|tighten|expand|add|remove|replace|incorporate|fix)\b/.test(text);
  const mentionsDraft = /\bdraft\b/.test(text);
  return editVerb && mentionsDraft;
}

function resolveAnthropicThinking({ model, maxTokens }) {
  const requestedMode = String(process.env.ANTHROPIC_THINKING_MODE || 'auto').trim().toLowerCase();
  const adaptiveSupported = supportsAdaptiveThinkingModel(model);
  const manualSupported = supportsManualThinkingModel(model);
  const effort = normalizeThinkingEffort(process.env.ANTHROPIC_THINKING_EFFORT || 'medium');

  const rawBudget = parseIntOr(
    process.env.ANTHROPIC_THINKING_BUDGET_TOKENS ?? process.env.ANTHROPIC_THINKING_BUDGET,
    4096,
  );
  const maxManualBudget = Math.max(0, Number(maxTokens || 0) - 1);
  const budgetTokens = maxManualBudget >= 1024
    ? Math.min(Math.max(1024, rawBudget), maxManualBudget)
    : null;

  let effectiveMode = 'off';
  let thinking = null;

  if (['off', 'none', 'disabled', 'false', '0'].includes(requestedMode)) {
    effectiveMode = 'off';
  } else if (requestedMode === 'adaptive') {
    if (adaptiveSupported) {
      effectiveMode = 'adaptive';
      // Some Anthropic API deployments reject adaptive effort in payload.
      // Keep adaptive enabled, but omit effort for compatibility.
      thinking = { type: 'adaptive' };
    }
  } else if (requestedMode === 'enabled' || requestedMode === 'manual') {
    if (manualSupported && budgetTokens) {
      effectiveMode = 'enabled';
      thinking = { type: 'enabled', budget_tokens: budgetTokens };
    }
  } else {
    // auto: prefer adaptive when supported (Opus/Sonnet 4.6), otherwise manual thinking on supported models.
    if (adaptiveSupported) {
      effectiveMode = 'adaptive';
      // Omit effort for compatibility with currently enforced API schema.
      thinking = { type: 'adaptive' };
    } else if (manualSupported && budgetTokens) {
      effectiveMode = 'enabled';
      thinking = { type: 'enabled', budget_tokens: budgetTokens };
    }
  }

  return {
    requestedMode,
    effectiveMode,
    thinking,
    effort: null,
    requestedEffort: effectiveMode === 'adaptive' ? effort : null,
    budgetTokens: effectiveMode === 'enabled' ? budgetTokens : null,
    supportsAdaptive: adaptiveSupported,
    supportsManual: manualSupported,
  };
}

async function callAnthropicStream({ system, messages, onTextDelta, shouldAbort }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('Missing ANTHROPIC_API_KEY in environment');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const model = getAnthropicModel();
  const maxTokens = getAnthropicMaxTokens();
  const thinkingCfg = resolveAnthropicThinking({ model, maxTokens });

  const payload = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    stream: true,
  };
  if (thinkingCfg.thinking) payload.thinking = thinkingCfg.thinking;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`Anthropic API error: HTTP ${resp.status} ${text}`);
    err.httpStatus = resp.status;
    throw err;
  }

  let out = '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  function handleEventBlock(block) {
    // SSE block: lines like "event: ..." and "data: {...}"
    const lines = String(block).split(/\n/);
    const dataLines = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) return;
    const dataStr = dataLines.join('\n');
    if (dataStr === '[DONE]') return;

    let evt;
    try {
      evt = JSON.parse(dataStr);
    } catch {
      return;
    }

    if (evt?.type === 'content_block_delta' && evt?.delta?.type === 'text_delta') {
      const t = String(evt.delta.text || '');
      if (!t) return;
      out += t;
      if (onTextDelta) onTextDelta(t);
    }
  }

  // Read and parse SSE frames from Anthropic.
  for (;;) {
    if (shouldAbort && shouldAbort()) break;
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    while (true) {
      const match = buf.match(/\r?\n\r?\n/);
      if (!match) break;
      const sep = match.index;
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + match[0].length);
      handleEventBlock(block);
    }
  }

  try { reader.cancel(); } catch { /* ignore */ }
  return out.trim();
}

const NOTE_LINE_RE = /^\s*(?:\[(?:note|note to user|internal note|drafting note|placeholder)[^\]]*\]|(?:note to user|internal note|drafting note)\s*:)/i;
const DOC_REQUEST_TERMS_RE = /(document|filing|complaint|allegation|paragraph|case file|stored elsewhere|01_pleadings|02_motions|provide .*text|share .*text)/i;
const DIRECT_DOC_REQUEST_RE = /\b(?:can you|could you|do you have|where is|confirm whether|tell me whether)\b/i;
const POLITE_DOC_REQUEST_RE = /\bplease\b.*\b(?:provide|share|send|locate|find|upload|attach|confirm|tell)\b/i;
const LEGAL_PLEADING_LINE_RE = /^\s*please\s+(?:take\s+notice|enter\b|allow\b|this\s+court\b|the\s+court\b)/i;

function isDocumentRequestLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (!DOC_REQUEST_TERMS_RE.test(t)) return false;
  if (LEGAL_PLEADING_LINE_RE.test(t)) return false;
  if (DIRECT_DOC_REQUEST_RE.test(t)) return true;
  if (POLITE_DOC_REQUEST_RE.test(t) && /\b(?:you|your)\b/i.test(t)) return true;
  if (/\?\s*$/.test(t) && /\b(?:you|your)\b/i.test(t) && /\b(?:provide|share|send|locate|find|upload|attach|confirm|tell|have)\b/i.test(t)) {
    return true;
  }
  return false;
}

function sanitizeDraftLines(lines, { mode = 'draft' } = {}, notes = []) {
  const kept = [];
  for (const line of lines) {
    const t = String(line || '').trim();
    if (NOTE_LINE_RE.test(t)) {
      notes.push(t.replace(/^\[|\]$/g, ''));
      continue;
    }
    if ((mode === 'draft' || mode === 'oral') && isDocumentRequestLine(t)) {
      continue;
    }
    kept.push(line);
  }
  return kept;
}

function sanitizeDraftOutput(text, { mode = 'draft' } = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return '';

  const notes = [];
  const kept = sanitizeDraftLines(raw.split(/\r?\n/), { mode }, notes);
  const cleanedBody = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!notes.length) return cleanedBody;

  return [
    cleanedBody,
    '',
    'ASSISTANT NOTE (NOT PART OF FILING):',
    ...notes.map((n) => `- ${n}`),
  ].join('\n').trim();
}

function createStreamingDraftSanitizer({ mode = 'draft', onDelta }) {
  let pending = '';
  let emittedBody = '';
  const notes = [];

  const emit = (text) => {
    const chunk = String(text || '');
    if (!chunk) return;
    if (onDelta) onDelta(chunk);
  };

  const flushCompleteLines = () => {
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() || '';
    if (!parts.length) return;
    const kept = sanitizeDraftLines(parts, { mode }, notes);
    if (kept.length) {
      const chunk = `${kept.join('\n')}\n`;
      emittedBody += chunk;
      emit(chunk);
    }
  };

  return {
    push(text) {
      pending += String(text || '');
      flushCompleteLines();
    },
    finish() {
      if (pending) {
        const kept = sanitizeDraftLines([pending], { mode }, notes);
        if (kept.length) {
          const tail = kept.join('\n');
          emittedBody += tail;
          emit(tail);
        }
      }

      const body = emittedBody.replace(/\n{3,}/g, '\n\n').trim();
      if (!notes.length) return body;

      const noteSection = [
        'ASSISTANT NOTE (NOT PART OF FILING):',
        ...notes.map((n) => `- ${n}`),
      ].join('\n');
      const suffix = `${body ? '\n\n' : ''}${noteSection}`;
      emit(suffix);
      const finalText = `${body}${suffix}`.trim();
      return finalText;
    },
  };
}

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATIC_DIR = path.join(__dirname, 'ui-static');
const STATE_DIR = path.join(__dirname, 'ui-state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SOURCE_PACKET_DIR = path.join(STATE_DIR, 'source-packets');
const ATTACHMENTS_DIR = path.join(STATE_DIR, 'attachments');
const SOURCE_AUDIT_DIRNAME = '_audit_sources';
const CASE_DB_PATH = path.join(PROJECT_ROOT, 'case-tracker.db');
const LOCAL_RULES_ROOT = path.join(PROJECT_ROOT, '07_Research', 'local_rules');

const LOCAL_FORM_REGISTRY = [
  {
    id: 'wake-cvd-01',
    title: 'WAKE-CVD-01 Calendar Request',
    relPath: 'forms/WAKE-CVD-01-Calendar-Request.pdf',
    intents: ['calendar-request', 'session-setting', 'schedule'],
  },
  {
    id: 'wake-cvd-02',
    title: 'WAKE-CVD-02 Motion/Order to Continue',
    relPath: 'forms/WAKE-CVD-02-Motion-Order-to-Continue.pdf',
    intents: ['continuance', 'continue', 'reschedule', 'calendar-extension'],
  },
  {
    id: 'wake-cvd-06',
    title: 'WAKE-CVD-06 Motion Information Sheet',
    relPath: 'forms/WAKE-CVD-06-Motion-Information-Sheet.pdf',
    intents: ['motion', 'hearing', 'calendar'],
  },
];

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3210);

let ENV_LOADED_FROM = null;

function loadDotEnvFile(filePath) {
  if (!filePath) return { loaded: false, path: null };
  if (!fs.existsSync(filePath)) return { loaded: false, path: filePath };

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (!key) continue;

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Do not override explicit environment variables
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return { loaded: true, path: filePath };
}

// Load env from a local .env file (optional). LaunchAgents do NOT load shell rc files,
// so this provides a simple, repeatable place to store secrets locally.
(function loadEnvOnce() {
  const candidates = [
    process.env.CASEPILOT_ENV_FILE,
    path.join(STATE_DIR, '.env'),
    path.join(PROJECT_ROOT, '.env'),
    path.join(os.homedir(), '.config', 'casepilot', '.env'),
  ].filter(Boolean);

  for (const p of candidates) {
    const res = loadDotEnvFile(p);
    if (res.loaded) {
      ENV_LOADED_FROM = res.path;
      break;
    }
  }
})();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function sanitizeToken(input, fallback = 'item') {
  const out = String(input || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  return out || fallback;
}

function sourcePacketPath(packetId) {
  return path.join(SOURCE_PACKET_DIR, `${sanitizeToken(packetId, 'sp')}.json`);
}

function pruneSourcePacketStore({ maxFiles = 1200 } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(SOURCE_PACKET_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => {
      const abs = path.join(SOURCE_PACKET_DIR, e.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { mtimeMs = 0; }
      return { abs, mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  if (files.length <= maxFiles) return;
  const toDelete = files.slice(0, files.length - maxFiles);
  for (const f of toDelete) {
    try { fs.unlinkSync(f.abs); } catch { /* ignore */ }
  }
}

function compactSourcePacketRef(sourcePacket) {
  if (!sourcePacket || !sourcePacket.id) return null;
  return {
    id: sourcePacket.id,
    createdAt: sourcePacket.createdAt || new Date().toISOString(),
    queryHash: sourcePacket.queryHash || null,
    sourceCount: Array.isArray(sourcePacket.sources) ? sourcePacket.sources.length : 0,
  };
}

function persistSourcePacket(sourcePacket) {
  if (!sourcePacket || !sourcePacket.id || !Array.isArray(sourcePacket.sources) || !sourcePacket.sources.length) return null;
  ensureDir(SOURCE_PACKET_DIR);
  const packet = {
    id: sourcePacket.id,
    createdAt: sourcePacket.createdAt || new Date().toISOString(),
    queryHash: sourcePacket.queryHash || null,
    sources: sourcePacket.sources.map((s) => ({
      path: String(s.path || ''),
      score: typeof s.score === 'number' ? s.score : null,
      kind: s.kind || null,
      extracted: Boolean(s.extracted),
      snippet: String(s.snippet || '').slice(0, 2000),
      mtimeMs: typeof s.mtimeMs === 'number' ? s.mtimeMs : null,
      snippetHash: s.snippetHash || null,
      sourceHash: s.sourceHash || null,
    })),
  };
  writeJsonAtomic(sourcePacketPath(packet.id), packet);
  pruneSourcePacketStore();
  return compactSourcePacketRef(packet);
}

function loadPersistedSourcePacket(packetId) {
  if (!packetId) return null;
  const packet = readJsonSafe(sourcePacketPath(packetId), null);
  if (!packet || !Array.isArray(packet.sources) || !packet.sources.length) return null;
  return packet;
}

// ── Attachments ─────────────────────────────────────────────────────────────
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const EXTRACTABLE_TYPES = new Set(['application/pdf']);
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv']);
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB

function sanitizeFilename(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

function saveAttachment({ filename, contentType, dataBase64, conversationId }) {
  const attId = id('att');
  const dir = path.join(ATTACHMENTS_DIR, attId);
  ensureDir(dir);

  const safeName = sanitizeFilename(filename);
  const ext = path.extname(safeName).toLowerCase() || '.bin';
  const filePath = path.join(dir, `original${ext}`);
  const buf = Buffer.from(dataBase64, 'base64');

  if (buf.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File too large (${Math.round(buf.length / 1024 / 1024)}MB). Max is 15MB.`);
  }

  fs.writeFileSync(filePath, buf);

  let extractedText = null;

  if (EXTRACTABLE_TYPES.has(contentType) && ext === '.pdf') {
    try {
      const out = execFileSync('pdftotext', ['-layout', filePath, '-'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
      extractedText = out ? out.toString('utf8').trim() : null;
    } catch { /* pdftotext not available or failed */ }
  } else if (TEXT_TYPES.has(contentType) || ['.md', '.txt', '.csv'].includes(ext)) {
    try {
      extractedText = fs.readFileSync(filePath, 'utf8').trim();
    } catch { /* ignore */ }
  }

  if (extractedText) {
    fs.writeFileSync(path.join(dir, 'extracted.txt'), extractedText, 'utf8');
  }

  const meta = {
    id: attId,
    filename: safeName,
    originalFilename: String(filename || ''),
    contentType: contentType || 'application/octet-stream',
    ext,
    size: buf.length,
    isImage: IMAGE_TYPES.has(contentType),
    hasExtractedText: Boolean(extractedText),
    extractedTextLength: extractedText ? extractedText.length : 0,
    conversationId: conversationId || null,
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(dir, 'meta.json'), meta);
  return meta;
}

function loadAttachment(attId) {
  if (!attId) return null;
  const dir = path.join(ATTACHMENTS_DIR, String(attId));
  return readJsonSafe(path.join(dir, 'meta.json'), null);
}

function loadAttachmentFile(attId) {
  if (!attId) return null;
  const meta = loadAttachment(attId);
  if (!meta) return null;
  const filePath = path.join(ATTACHMENTS_DIR, String(attId), `original${meta.ext}`);
  try { return fs.readFileSync(filePath); } catch { return null; }
}

function loadAttachmentExtractedText(attId) {
  if (!attId) return null;
  const txtPath = path.join(ATTACHMENTS_DIR, String(attId), 'extracted.txt');
  try { return fs.readFileSync(txtPath, 'utf8'); } catch { return null; }
}

function buildAttachmentContentBlocks(attachmentIds) {
  if (!Array.isArray(attachmentIds) || !attachmentIds.length) return [];
  const blocks = [];
  for (const attId of attachmentIds) {
    const meta = loadAttachment(attId);
    if (!meta) continue;

    if (meta.isImage) {
      const buf = loadAttachmentFile(attId);
      if (buf) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: meta.contentType,
            data: buf.toString('base64'),
          },
        });
        blocks.push({ type: 'text', text: `[Attached image: ${meta.originalFilename}]` });
      }
    } else {
      const extracted = loadAttachmentExtractedText(attId);
      if (extracted) {
        blocks.push({
          type: 'text',
          text: `--- ATTACHED DOCUMENT: ${meta.originalFilename} ---\n${extracted.slice(0, 12000)}`,
        });
      } else {
        blocks.push({
          type: 'text',
          text: `[Attached file: ${meta.originalFilename} (${meta.contentType}) — text extraction not available]`,
        });
      }
    }
  }
  return blocks;
}

function loadState() {
  return readJsonSafe(STATE_FILE, { conversations: [], messages: [], drafts: [] });
}

function saveState(state) {
  writeJsonAtomic(STATE_FILE, state);
}

let _stateMutationQueue = Promise.resolve();
function withStateLock(task) {
  const run = _stateMutationQueue.then(() => task());
  _stateMutationQueue = run.catch(() => {});
  return run;
}

function id(prefix) {
  const rand = Math.random().toString(16).slice(2);
  return `${prefix}_${Date.now()}_${rand}`;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    ...extra,
  };
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, securityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  }));
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, securityHeaders({
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  }));
  res.end(text);
}

function badRequest(res, msg) {
  sendJson(res, 400, { error: msg });
}

function unprocessable(res, msg, details) {
  sendJson(res, 422, { error: msg, details: details || null });
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

async function readBodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return { __parseError: true, raw };
  }
}

function safeBasename(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return cleaned || fallback;
}

function normalizeDate(dateStr) {
  // Expect YYYY-MM-DD
  if (!dateStr) return new Date().toISOString().slice(0, 10);
  const m = String(dateStr).match(/^\d{4}-\d{2}-\d{2}$/);
  return m ? dateStr : new Date().toISOString().slice(0, 10);
}

function pickFirstNonEmptyLine(text) {
  if (!text) return '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    return line;
  }
  return '';
}

function inferDocTypeFromText(text) {
  const t = String(text || '').toUpperCase();
  if (t.includes('ANSWER') && (t.includes('COMPLAINT') || t.includes('AMENDED'))) return 'ANS';
  if (t.includes("DEFENDANT'S ANSWER") || t.includes('DEFENDANT\u2019S ANSWER')) return 'ANS';
  if (t.includes('REPLY')) return 'REPLY';
  if (t.includes('RESPONSE')) return 'RESP';
  if (t.includes('MOTION')) return 'MOT';
  if (t.includes('MEMORANDUM')) return 'MEMO';
  if (t.includes('BRIEF')) return 'BRIEF';
  if (t.includes('NOTICE OF HEARING')) return 'NOH';
  if (t.includes('NOTICE')) return 'NOT';
  if (t.includes('ORDER')) return 'ORD';
  if (t.includes('AFFIDAVIT') || t.includes('DECLARATION')) return 'AFF';
  return 'MOT';
}

function inferPartyFromText(text) {
  const t = String(text || '').toUpperCase();
  if (t.includes('PLAINTIFF') && t.includes('DEFENDANT')) return 'DEF';
  // Default: Defendant for this case.
  return 'DEF';
}

function deriveDraftTitle(content) {
  const first = pickFirstNonEmptyLine(content);
  const upper = first.toUpperCase();

  // Skip common caption lines.
  if (upper.startsWith('STATE OF NORTH CAROLINA') || upper.startsWith('IN THE GENERAL COURT')) {
    const lines = String(content || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const maybe = lines.find((l) => l.length <= 80 && /MOTION|ANSWER|RESPONSE|REPLY|NOTICE|BRIEF|MEMORANDUM|AFFIDAVIT/i.test(l));
    if (maybe) return safeBasename(maybe, 'Draft').replace(/-/g, ' ');
  }

  if (first && first.length <= 90) return first;
  const dt = inferDocTypeFromText(content);
  switch (dt) {
    case 'ANS':
      return 'Answer';
    case 'RESP':
      return 'Response';
    case 'REPLY':
      return 'Reply';
    case 'MEMO':
      return 'Memo';
    case 'BRIEF':
      return 'Brief';
    case 'AFF':
      return 'Affidavit';
    default:
      return 'Motion';
  }
}

async function suggestMetadataWithAI({ title, content }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  // Keep this small/cheap; we only need metadata.
  const clipped = String(content || '').slice(0, 6000);

  const sys = [
    'You extract filing metadata for a local-only legal drafting tool.',
    'Return ONLY valid minified JSON (no prose, no code fences).',
    '',
    'Schema:',
    '{"docType":"MOT|RESP|REPLY|ANS|COMP|MEMO|BRIEF|AFF|EX|NOT|NOH|COS|ORD|ORAL","party":"DEF|PLT|CRT","description":"Two-to-five-words-hyphenated","date":"YYYY-MM-DD" (optional),"idxNum":101 (optional)}',
    '',
    'Rules:',
    '- If unsure, choose docType=MOT, party=DEF.',
    '- description MUST be hyphenated, no punctuation, 2-5 words.',
    '- Do not invent index numbers; omit idxNum if unknown.',
  ].join('\n');

  let out = '';
  try {
    out = await callAnthropic({
      system: sys,
      messages: [
        {
          role: 'user',
          content: [
            `TITLE: ${String(title || '').slice(0, 120)}`,
            '',
            'DRAFT (clipped):',
            clipped,
          ].join('\n'),
        },
      ],
    });
  } catch {
    return null;
  }

  const s = String(out || '').trim();
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const json = s.slice(firstBrace, lastBrace + 1);

  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function ensureDraftMeta(draft, { force = false } = {}) {
  if (!draft) return null;
  draft.meta ||= {};

  const hasCore = Boolean(draft.meta.docType && draft.meta.party && draft.meta.description);
  if (hasCore && !force) return draft.meta;

  // Prefer AI if configured.
  const ai = await suggestMetadataWithAI({ title: draft.title, content: draft.content });
  if (ai) {
    const docType = String(ai.docType || '').trim().toUpperCase();
    const party = String(ai.party || '').trim().toUpperCase();
    const description = safeBasename(ai.description, safeBasename(draft.title, 'Draft')).split('-').slice(0, 5).join('-');
    const date = normalizeDate(ai.date);
    const idxNum = Number.isFinite(Number(ai.idxNum)) ? Number(ai.idxNum) : null;

    draft.meta = {
      date,
      idxNum,
      docType: docType || inferDocTypeFromText(draft.content),
      party: party || inferPartyFromText(draft.content),
      description,
    };
    return draft.meta;
  }

  // Heuristics fallback.
  draft.meta = {
    date: normalizeDate(draft.meta.date),
    idxNum: draft.meta.idxNum ? Number(draft.meta.idxNum) : null,
    docType: draft.meta.docType || inferDocTypeFromText(draft.content),
    party: draft.meta.party || inferPartyFromText(draft.content),
    description: safeBasename(draft.meta.description || draft.title, 'Draft').split('-').slice(0, 5).join('-'),
  };
  return draft.meta;
}

function computeDraftSuggested(meta) {
  if (!meta?.docType || !meta?.party) return null;
  const ext = 'md';
  const filename = buildFilename({
    date: normalizeDate(meta.date),
    idxNum: meta.idxNum ? Number(meta.idxNum) : null,
    docType: meta.docType,
    party: meta.party,
    description: meta.description,
    ext,
  });
  const folder = routeToFolder(meta.docType, meta.party);
  const absPath = path.join(folder, filename);
  return {
    filename,
    absPath,
    relPath: absPath.replace(PROJECT_ROOT + path.sep, ''),
  };
}

function buildFilename({ date, idxNum, docType, party, description, ext }) {
  const idx = idxNum ? `IDX${String(idxNum).padStart(3, '0')}` : 'IDX000';
  const desc = safeBasename(description, 'Draft').split('-').slice(0, 5).join('-');
  return `${date}_${idx}_${docType}_${party}_${desc}.${ext}`;
}

function routeToFolder(docType, party) {
  const base = PROJECT_ROOT;
  switch (docType) {
    case 'COMP':
      return path.join(base, '01_Pleadings', party === 'DEF' ? 'answers' : 'complaints');
    case 'ANS':
      return path.join(base, '01_Pleadings', 'answers');
    case 'MOT':
    case 'RESP':
    case 'REPLY':
    case 'MEMO':
    case 'BRIEF':
      return path.join(base, '02_Motions', party === 'DEF' ? 'defendant' : 'plaintiff');
    case 'ORD':
    case 'STIP':
      return path.join(base, '05_Court_Orders');
    case 'NOH':
    case 'NOT':
      return path.join(base, '06_Correspondence', 'court_notices');
    case 'AFF':
    case 'EX':
      return path.join(base, '04_Evidence_Exhibits', party === 'DEF' ? 'defendant' : 'plaintiff');
    case 'COS':
      return path.join(base, '06_Correspondence', 'service');
    case 'ORAL':
      return path.join(base, '09_Oral_Arguments');
    default:
      return path.join(base, '06_Correspondence', 'misc');
  }
}

async function exportMarkdownToDocx(markdown) {
  const buffer = await buildLegalDocx(markdown);
  return { buffer };
}

function getLocalFormsCatalog({ intent = '', deadlineText = '' } = {}) {
  const haystack = `${String(intent || '').toLowerCase()} ${String(deadlineText || '').toLowerCase()}`.trim();
  return LOCAL_FORM_REGISTRY.map((form) => {
    const absPath = path.join(LOCAL_RULES_ROOT, form.relPath);
    const exists = fs.existsSync(absPath);
    const score = haystack
      ? form.intents.reduce((acc, tag) => (haystack.includes(tag) ? acc + 1 : acc), 0)
      : 0;
    return {
      id: form.id,
      title: form.title,
      relPath: `07_Research/local_rules/${form.relPath}`,
      exists,
      intents: form.intents,
      relevance: score,
    };
  }).sort((a, b) => b.relevance - a.relevance || a.title.localeCompare(b.title));
}

function cleanIsoDate(value) {
  const v = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function buildContinuanceQuickFillDraft({ deadline = null, reason = '', currentSettingDate = '', requestedNextDate = '', opposingCounselPosition = '' } = {}) {
  const currentDate = cleanIsoDate(currentSettingDate) || cleanIsoDate(deadline?.due_date) || '_______________';
  const requestedDate = cleanIsoDate(requestedNextDate) || '_______________';
  const reasonLine = String(reason || '').trim() || '[Insert 1-2 sentence compelling reason]';
  const oppLine = String(opposingCounselPosition || '').trim() || '[consent / oppose / unknown]';

  const ci = cfg.caseInfo();
  const df = cfg.defendant();
  const oc = cfg.counsel();
  const leadAttorney = (oc.attorneys && oc.attorneys[0]) ? oc.attorneys[0].name : '';
  const firmName = oc.firm || '';
  const oppName = [leadAttorney, firmName].filter(Boolean).join(' — ');

  return [
    '**MOTION AND ORDER FOR CONTINUANCE**',
    `**Case No.: ${ci.number || ''}**`,
    '',
    '---',
    '',
    '**FORM FIELDS:**',
    '',
    '- **Calendared Hearing / Trial Date:** ' + currentDate,
    '- **Requested Reschedule Date (within 90 days):** ' + requestedDate,
    `- **Opposing Counsel / Party Name:** ${oppName}`,
    `- **Date Case Filed:** ${ci.dateFiled || ''}`,
    '',
    '---',
    '',
    '**COMPELLING REASON (write in form text box):**',
    '',
    reasonLine,
    '',
    '---',
    '',
    '**SERVICE CHECKBOXES — mark all that apply:**',
    '- [x] Distributed copy to all counsel of record via email',
    '- [ ] Conferred or attempted to confer in good faith with all parties',
    '- [ ] Opposing party consents (attach correspondence)',
    '',
    '**Opposing counsel position:** ' + oppLine,
    '',
    '---',
    '',
    '**MOVANT:**',
    `${df.name || ''}, ${df.status || 'Pro Se'}`,
    `${cfg.defendantFullAddress()}`,
    `${df.phone || ''}`,
    '',
    '*Note: Jurisdictional objections are preserved on the record per prior filings and need not be restated on this form.*',
  ].join('\n');
}

const BASELINE_CASE_OVERVIEW_FILES = ['case_index.md', 'party_info.md', 'strategy_notes.md', 'case_timeline.md'];

function loadBaselineContext() {
  const files = BASELINE_CASE_OVERVIEW_FILES;
  const blocks = [];
  const pathsLoaded = [];
  for (const f of files) {
    const abs = path.join(PROJECT_ROOT, '00_Case_Overview', f);
    try {
      const text = fs.readFileSync(abs, 'utf8');
      if (!text.trim()) continue;
      const rel = `00_Case_Overview/${f}`;
      pathsLoaded.push(rel);
      blocks.push(`--- FILE: ${rel} ---\n${text.trim()}`);
    } catch { /* skip missing */ }
  }
  return { context: blocks.join('\n\n'), pathsLoaded };
}

let _baselineCache = null;
let _baselineCacheTime = 0;
function getBaselineContext() {
  const now = Date.now();
  if (_baselineCache && now - _baselineCacheTime < 60_000) return _baselineCache;
  _baselineCache = loadBaselineContext();
  _baselineCacheTime = now;
  return _baselineCache;
}

function draftingSystemPrompt({ mode }) {
  const now = new Date();
  const day = now.getDate();
  const monthName = now.toLocaleString('en-US', { month: 'long' });
  const year = now.getFullYear();

  const c = cfg.caseInfo();
  const d = cfg.defendant();
  const p = cfg.plaintiff();
  const oc = cfg.counsel();
  const def = cfg.defense();
  const emails = cfg.allServiceEmails();
  const captionText = cfg.captionBlock();
  const sigBlock = cfg.signatureBlock({ day, monthName, year });
  const cosEmails = emails.map((e) => `- ${e}`).join('\n');
  const jrText = cfg.jurisdictionalReservation('[document type]');

  const base = [
    `You are a legal drafting assistant for ${d.name} (${d.status || 'pro se'}) in ${c.court || 'District Court'}, ${c.stateShort || c.state || ''}.`,
    `Today is ${monthName} ${day}, ${year}.`,
    '',
    'CRITICAL RULES:',
    '- Do NOT fabricate citations. If a case or statute is in your LOCAL CASE CONTEXT, cite it. If it is not, OMIT the citation entirely. Do NOT write [CITATION NEEDS VERIFICATION] or any bracketed citation notes in draft text. If you are uncertain about a citation, leave the legal point stated without a cite and move on.',
    '- Be concise. Lead with the ask. One idea per paragraph. Short sentences.',
    '- Do NOT use em dashes. Use commas, periods, or semicolons instead.',
    '- For any responsive filing, include a jurisdictional reservation paragraph preserving objections.',
    '- Avoid placeholders like [Address] or [Phone] when the information is known. Only use [BRACKETED FIELDS] when truly unknown.',
    '- If you are given LOCAL CASE CONTEXT excerpts (file snippets), treat them as authoritative. Do not contradict them.',
    '- Do NOT guess numbers, dates, or quoted terms. If the LOCAL CASE CONTEXT does not contain the needed fact, say so plainly.',
    '- Do not say "I do not have X in front of me." Instead say: "The provided context does not include X."',
    '- Do NOT output raw HTML. Output plain text/markdown only.',
    '- Never insert hidden drafting notes inside filing body text (examples: [NOTE TO USER], [INTERNAL NOTE], [PLACEHOLDER]). If a caveat is necessary, put it in a clearly labeled "ASSISTANT NOTE (NOT PART OF FILING)" section at the very end.',
    '- NEVER ask the user to provide documents, filings, or case information. You already have access to the full case file via LOCAL CASE CONTEXT. Use what is provided. If a specific document excerpt is not in the context, say "The provided context does not include [specific item]" and proceed with what you have.',
    '- Never ask the user to locate documents in another folder. If a complaint excerpt is missing, draft the best legally valid response using available context and clearly reserve amendment rights where appropriate.',
    '- Do NOT ask the user "what do you want me to draft" or present a menu of options unless genuinely ambiguous. Start drafting immediately using the case context.',
    '- You have the full case docket, party information, strategy notes, and timeline. USE THEM. Do not pretend you lack information that appears in your context.',
    '',
    'STRATEGIC CONSISTENCY (MANDATORY):',
    '- Your LOCAL CASE CONTEXT includes strategy_notes.md. It contains BINDING strategic sequencing rules. Follow them exactly.',
    '- The STRATEGIC SEQUENCING RULES section in strategy_notes.md is authoritative. Do NOT recommend actions that contradict those rules.',
    '- Before recommending ANY filing or tactical move, CHECK the sequencing rules. If the strategy notes say HOLD a motion, do not recommend filing it.',
    '- If a user asks about timing (when to file X), answer by referencing the sequencing rules and explaining the strategic reasoning behind the timing.',
    '- NEVER flip-flop. If you recommended holding a motion in a previous message, do not recommend filing it in the next unless the POSTURE HAS CHANGED (e.g., a ruling came in). If the posture changed, explicitly say what changed and why it triggers a different recommendation.',
    '- When the strategy notes specify a decision tree (e.g., "if MSJ denied, then file motion to transfer"), follow that tree. Do not skip ahead or improvise alternative sequences.',
    '- If a question falls outside the strategy notes, reason from the case posture and litigation realism rules below, but never contradict an explicit sequencing rule.',
    '',
    'LITIGATION REALISM RULES (ALWAYS APPLY):',
    `- Prioritize what is most likely to be granted in ${c.court || 'this court'} over theoretically possible but low-probability arguments.`,
    '- Before recommending any move, evaluate judge-friction: does this create a clean, easy-to-grant record, or force the Court into procedural friction?',
    '- Always pressure-test strategy against the strongest likely opposition argument and state what opposing counsel can realistically get away with procedurally.',
    '- Do not recommend Hail Mary filings when a narrower, cleaner, more surgical path is available.',
    '- For strategic analysis responses, use this exact structure: (1) Most likely court path, (2) Opposing counsel best response, (3) Recommended move now, (4) Risks if denied, (5) Fallback move.',
    '- Never present predictions as certainty. Use "most likely," "arguments available," and "potential outcomes."',
    '',
    'BREVITY / LENGTH RULES:',
    '- DEFAULT: All standard motions, responses, replies, and pleadings must fit on ONE PAGE (~350 words of body text, excluding caption, signature block, and certificate of service). This is non-negotiable. Cut ruthlessly.',
    '- EXCEPTION: Motions for summary judgment, appellate briefs, memoranda of law, and any filing the user explicitly asks to be longer may exceed one page.',
    '- If a filing would naturally exceed one page, ask yourself: "Can this argument be made in fewer words?" The answer is almost always yes.',
    '- Prefer one devastating point over three adequate ones.',
    '',
    'DRAFTING STRUCTURE RULES:',
    '- In ARGUMENT sections, use numbered paragraphs within each heading (1., 2., 3.) so a skimming judge can track the logic.',
    '- Each numbered paragraph should make ONE point in 1-3 sentences max.',
    '- When listing multiple reasons, factors, or elements, use a lettered or bulleted sub-list, not run-on prose.',
    '- Keep paragraphs to 3 sentences maximum. If longer, split it.',
    '- Roman numeral headings (I., II., III.) for major argument sections. Bold them.',
    '- Every heading should be a complete assertion, not a topic label. Good: "I. THE ORIGINAL COMPLAINT IS A NULLITY." Bad: "I. STANDING".',
    '',
    'WHEREFORE / RELIEF RULES:',
    '- Do NOT include "Award Defendant his costs" in relief requests unless the user specifically asks for it.',
    '- Keep relief requests to the specific substantive relief sought (dismiss, transfer, vacate, strike, etc.).',
    '',
    'CASE DETAILS (use unless user instructs otherwise):',
    `- File No.: ${c.number || ''}`,
    `- Court: ${c.court || ''} ${c.division || ''}`,
    `- Parties (current caption): ${p.current || p.original || 'Plaintiff'} (Plaintiff) v. ${d.name || 'Defendant'} (Defendant)`,
    '',
    'CAPTION (output at the top of any filing/draft):',
    captionText,
    '',
    'SIGNATURE BLOCK (include in filings):',
    sigBlock,
    '',
    'CERTIFICATE OF SERVICE (include in filings):',
    'I hereby certify that a true and correct copy of the foregoing was served upon counsel for Plaintiff via email to:',
    cosEmails,
    cfg.certificateOfService({ day, monthName, year }).split('\n').slice(0, 1).join(''),
    '',
    'JURISDICTIONAL RESERVATION (include in EVERY responsive filing):',
    '- Keep the substance exact, but format as a lead-in sentence followed by separate numbered lines for scanability.',
    '- Use this exact wording and structure:',
    `"${jrText}"`,
    '',
    'Formatting:',
    `- ${c.stateShort || 'NC'} District Court caption style. Times New Roman 12pt, double-spaced body (you can output plain text/markdown; user will format).`,
    '- Output plain text/markdown only. Do NOT wrap filings in code fences.',
    '- Include signature block and certificate of service when appropriate.',
  ].join('\n');

  if (mode === 'oral') {
    return [
      base,
      '',
      'ORAL ARGUMENT OUTPUT REQUIREMENT:',
      '- Provide TWO versions:',
      '  1) "JESUS WEPT" (60-90 seconds spoken)',
      '  2) "THE CUTOFF" (2 sentences max)',
    ].join('\n');
  }

  return base;
}

async function callAnthropic({ system, messages, maxTokens, timeoutMs }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('Missing ANTHROPIC_API_KEY in environment');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const model = getAnthropicModel();
  const resolvedMaxTokens = getAnthropicMaxTokens(maxTokens);
  const thinkingCfg = resolveAnthropicThinking({ model, maxTokens: resolvedMaxTokens });

  const payload = {
    model,
    max_tokens: resolvedMaxTokens,
    system,
    messages,
  };
  if (thinkingCfg.thinking) payload.thinking = thinkingCfg.thinking;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(timeoutMs || process.env.ANTHROPIC_TIMEOUT_MS || 240000));

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error(`Anthropic API error: HTTP ${resp.status} ${text}`);
      err.httpStatus = resp.status;
      throw err;
    }

    const data = JSON.parse(text);
    const out = Array.isArray(data.content)
      ? data.content
          .filter((c) => c && c.type === 'text')
          .map((c) => c.text)
          .join('\n')
      : '';

    return out.trim();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const tErr = new Error('Anthropic request timed out');
      tErr.code = 'ANTHROPIC_TIMEOUT';
      throw tErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

const REDTEAM_REQUIRED_HEADINGS = [
  'triage classification',
  'strongest objection',
  'procedural defects',
  'legal weaknesses',
  'what concerns you',
  'your response strategy',
  'what the filing telegraphs',
  'oral argument prep',
  'surprise risk assessment',
  'threat score',
];

function normalizeHeadingKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getMissingRedTeamHeadings(text) {
  const headings = [];
  const re = /^##\s+(.+)$/gim;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    headings.push(normalizeHeadingKey(match[1]));
  }
  return REDTEAM_REQUIRED_HEADINGS.filter((required) => {
    const req = normalizeHeadingKey(required);
    return !headings.some((h) => h === req || h.startsWith(req) || req.startsWith(h));
  });
}

async function buildRedTeamAnalysis({ system, filingText, maxTokens, timeoutMs }) {
  const userPrompt = [
    'NEW FILING FROM PRO SE DEFENDANT — ROUTE TO LITIGATION TEAM FOR ANALYSIS:',
    '',
    '---',
    '',
    String(filingText || '').slice(0, 10000),
  ].join('\n');

  let analysis = await callAnthropic({
    system,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens,
    timeoutMs,
  });

  const maxContinuations = Math.max(0, Number(process.env.REDTEAM_MAX_CONTINUATIONS || 2));
  let missing = getMissingRedTeamHeadings(analysis);
  for (let i = 0; i < maxContinuations && missing.length; i++) {
    const continuation = await callAnthropic({
      system,
      messages: [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: analysis },
        {
          role: 'user',
          content: [
            'Continue the same analysis from where you stopped.',
            'Do not repeat prior sections.',
            `Start at this exact heading: ## ${missing[0]}`,
            `Still missing headings: ${missing.map((h) => `## ${h.toUpperCase()}`).join(' | ')}`,
            'Return only the missing sections.',
          ].join('\n'),
        },
      ],
      maxTokens,
      timeoutMs,
    });

    if (!String(continuation || '').trim()) break;
    analysis = `${String(analysis || '').trim()}\n\n${String(continuation || '').trim()}`.trim();
    missing = getMissingRedTeamHeadings(analysis);
  }

  return String(analysis || '').trim();
}

function serveStatic(reqUrl, res) {
  const urlPath = decodeURIComponent(reqUrl.pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

  // Prevent path traversal
  const abs = path.normalize(path.join(STATIC_DIR, rel));
  if (!abs.startsWith(STATIC_DIR + path.sep)) return notFound(res);

  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return notFound(res);

  const ext = path.extname(abs).toLowerCase();
  const mime =
    ext === '.html' ? 'text/html; charset=utf-8' :
    ext === '.js' ? 'text/javascript; charset=utf-8' :
    ext === '.css' ? 'text/css; charset=utf-8' :
    'application/octet-stream';

  const data = fs.readFileSync(abs);
  res.writeHead(200, securityHeaders({
    'Content-Type': mime,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  }));
  res.end(data);
}

function archiveIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const dir = path.dirname(filePath);
  const archiveDir = path.join(dir, '_archive_drafts');
  ensureDir(archiveDir);

  const base = path.basename(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const archived = path.join(archiveDir, `${stamp}__${base}`);
  fs.copyFileSync(filePath, archived);
  return archived;
}

function writeSourceAuditForSavedDraft(absDraftPath, { draftId, conversationId, meta, sourcePacket }) {
  const packetId = String(meta?.sourcePacketId || sourcePacket?.id || '').trim();
  if (!packetId) return null;

  const auditDir = path.join(path.dirname(absDraftPath), SOURCE_AUDIT_DIRNAME);
  ensureDir(auditDir);

  const base = `${path.basename(absDraftPath, path.extname(absDraftPath))}.source-audit.json`;
  const auditPath = path.join(auditDir, base);

  const payload = {
    savedAt: new Date().toISOString(),
    draftId: draftId || null,
    conversationId: conversationId || null,
    draftPath: absDraftPath.replace(PROJECT_ROOT + path.sep, ''),
    sourcePacketId: packetId,
    sourceCount: Number(meta?.sourceCount || sourcePacket?.sources?.length || 0),
    sourcePaths: Array.isArray(meta?.sourcePaths)
      ? meta.sourcePaths
      : (Array.isArray(sourcePacket?.sources) ? sourcePacket.sources.map((s) => s.path) : []),
    sourceHashes: Array.isArray(meta?.sourceHashes)
      ? meta.sourceHashes
      : (Array.isArray(sourcePacket?.sources) ? sourcePacket.sources.map((s) => s.sourceHash || null).filter(Boolean) : []),
    strategyGate: meta?.strategyGate || null,
    sourceVerifier: meta?.sourceVerifier || null,
    sourceVerificationAt: meta?.sourceVerificationAt || null,
  };

  writeJsonAtomic(auditPath, payload);
  return auditPath.replace(PROJECT_ROOT + path.sep, '');
}

function getCaseSummary() {
  if (!Database) return { ok: false, reason: 'better-sqlite3 not available' };
  if (!fs.existsSync(CASE_DB_PATH)) return { ok: false, reason: 'case-tracker.db not found' };

  const db = new Database(CASE_DB_PATH, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);

    const out = { ok: true, tables, counts: {}, recentEvents: [], recentHearings: [] };

    if (tables.includes('court_events')) {
      try {
        out.counts.court_events = db.prepare('SELECT COUNT(*) AS n FROM court_events').get().n;
        out.recentEvents = db
          .prepare('SELECT index_num, event_date, event_type, description FROM court_events ORDER BY event_date DESC, index_num DESC LIMIT 10')
          .all();
      } catch { /* schema mismatch — skip */ }
    }

    if (tables.includes('court_hearings')) {
      try {
        out.counts.court_hearings = db.prepare('SELECT COUNT(*) AS n FROM court_hearings').get().n;
        out.recentHearings = db
          .prepare('SELECT hearing_date, hearing_type, description FROM court_hearings ORDER BY hearing_date DESC LIMIT 10')
          .all();
      } catch { /* schema mismatch — skip */ }
    }

    if (tables.includes('documents')) {
      try {
        out.counts.documents = db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
        out.counts.documents_with_pdf = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE has_pdf = 1").get().n;
      } catch { /* schema mismatch — skip */ }
    }

    return out;
  } finally {
    db.close();
  }
}

function getDocketIntelligence() {
  if (!Database) return null;
  if (!fs.existsSync(CASE_DB_PATH)) return null;

  const db = new Database(CASE_DB_PATH, { readonly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='filing_outcomes'").all();
    if (!tables.length) return null;

    const all = db.prepare('SELECT * FROM filing_outcomes WHERE case_id = 1 ORDER BY motion_date').all();
    if (!all.length) return null;

    const contested = all.filter((r) => r.stakes_tier === 'contested');
    const procedural = all.filter((r) => r.stakes_tier === 'procedural');

    const contestedDecided = contested.filter((r) => {
      const outcome = String(r.outcome || '').toLowerCase();
      return outcome === 'granted' || outcome === 'denied';
    });
    const contestedPending = contested.filter((r) => String(r.outcome || '').toLowerCase() === 'pending');

    const defContested = contestedDecided.filter((r) => r.filed_by === 'DEF');
    const defGranted = defContested.filter((r) => r.outcome === 'granted');
    const defDenied = defContested.filter((r) => r.outcome === 'denied');

    const pltContested = contestedDecided.filter((r) => r.filed_by === 'PLT');
    const pltGranted = pltContested.filter((r) => r.outcome === 'granted');

    // All procedural filings with detail
    const allProcedural = procedural.filter((r) => r.outcome);
    const pltProc = allProcedural.filter((r) => r.filed_by === 'PLT');
    const defProc = allProcedural.filter((r) => r.filed_by === 'DEF');
    const continuances = allProcedural.filter((r) =>
      r.motion_description && /continu/i.test(r.motion_description)
    );

    // Judges from ALL decided filings (contested + procedural)
    const allDecided = all.filter((r) => r.outcome && !['pending', 'withdrawn', 'filed'].includes(r.outcome));
    const judges = {};
    for (const r of allDecided) {
      if (!r.ruling_judge) continue;
      const j = r.ruling_judge;
      if (!judges[j]) judges[j] = { total: 0, granted: 0, denied: 0, contested: 0, procedural: 0, filings: [] };
      judges[j].total++;
      if (r.outcome === 'granted') judges[j].granted++;
      if (r.outcome === 'denied') judges[j].denied++;
      if (r.stakes_tier === 'contested') judges[j].contested++;
      if (r.stakes_tier === 'procedural') judges[j].procedural++;
      judges[j].filings.push({
        idx: r.motion_idx, filed_by: r.filed_by, outcome: r.outcome,
        style: r.filing_style, description: r.motion_description,
        tier: r.stakes_tier, date: r.ruling_date,
      });
    }

    const grantedStyles = defGranted.map((r) => r.filing_style).filter(Boolean);
    const deniedStyles = defDenied.map((r) => r.filing_style).filter(Boolean);

    const lessons = all
      .filter((r) => r.strategic_lesson)
      .map((r) => ({ idx: r.motion_idx, lesson: r.strategic_lesson, outcome: r.outcome, tier: r.stakes_tier }));

    const modelFiling = defGranted.length
      ? defGranted.map((r) => ({
          idx: r.motion_idx, description: r.motion_description,
          style: r.filing_style, lesson: r.strategic_lesson,
          what_worked: r.what_worked,
        }))
      : [];

    return {
      contested: {
        def: { total: defContested.length, granted: defGranted.length, denied: defDenied.length },
        plt: { total: pltContested.length, granted: pltGranted.length },
        pending: contestedPending.map((r) => ({
          idx: r.motion_idx, filed_by: r.filed_by, description: r.motion_description,
          notes: r.outcome_notes || null,
        })),
      },
      procedural: {
        plt: { total: pltProc.length, granted: pltProc.filter((r) => r.outcome === 'granted').length },
        def: { total: defProc.length, granted: defProc.filter((r) => r.outcome === 'granted').length, denied: defProc.filter((r) => r.outcome === 'denied').length },
        continuances: continuances.map((r) => ({
          idx: r.motion_idx, filed_by: r.filed_by, description: r.motion_description,
          outcome: r.outcome, judge: r.ruling_judge || null, date: r.ruling_date || null,
          lesson: r.strategic_lesson || null,
        })),
      },
      judges,
      filingPatterns: { grantedStyles, deniedStyles },
      modelFiling,
      lessons,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

let _intelligenceCache = null;
let _intelligenceCacheTime = 0;
function getCachedIntelligence() {
  const now = Date.now();
  if (_intelligenceCache && now - _intelligenceCacheTime < 120_000) return _intelligenceCache;
  _intelligenceCache = getDocketIntelligence();
  _intelligenceCacheTime = now;
  return _intelligenceCache;
}

function parseUsDateToIso(value) {
  const m = String(value || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return '';
  let year = Number(m[3]);
  if (m[3].length === 2) year += year >= 70 ? 1900 : 2000;
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return '';
  const month = String(Number(m[1])).padStart(2, '0');
  const day = String(Number(m[2])).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function deriveSettingLabelFromContinuance(description) {
  const text = String(description || '');
  const paren = text.match(/\(([^)]+)\)/);
  let label = paren ? paren[1] : text.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '');
  label = label.replace(/\s+/g, ' ').replace(/^[\s\-:;,.]+|[\s\-:;,.]+$/g, '').trim();
  if (!label) return 'Continued setting';
  if (/summary judgment|(^| )msj( |$)/i.test(label)) return 'Motion Hearing (MSJ)';
  if (/jury trial|trial de novo/i.test(label)) return 'Jury Trial';
  if (/awaiting ruling on motion to amend/i.test(label)) return 'Jury Trial';
  return label;
}

function normalizeSettingTopic(label) {
  const low = String(label || '').toLowerCase();
  if (/summary judgment|(^| )msj( |$)/.test(low)) return 'msj';
  if (/jury trial|trial de novo/.test(low)) return 'jury_trial';
  if (/motion to enforce/.test(low)) return 'motion_to_enforce';
  const cleaned = low.replace(/[^a-z0-9]+/g, ' ').trim();
  return cleaned ? `other:${cleaned.slice(0, 48)}` : 'other:setting';
}

function getUpcomingSettingsFromContinuanceOrders(db, today) {
  try {
    const rows = db.prepare(
      `SELECT event_date, index_num, description
       FROM court_events
       WHERE case_id = 1
         AND upper(COALESCE(event_type, '')) LIKE '%ORDER TO CONTINUE%'
       ORDER BY event_date DESC, index_num DESC
       LIMIT 60`
    ).all();

    const byTopic = new Map();
    for (const row of rows) {
      const targetDate = parseUsDateToIso(row.description || '');
      if (!targetDate || targetDate < today) continue;

      const hearingType = deriveSettingLabelFromContinuance(row.description || '');
      const topic = normalizeSettingTopic(hearingType);
      if (byTopic.has(topic)) continue;

      byTopic.set(topic, {
        hearing_date: targetDate,
        hearing_type: hearingType,
        description: `${hearingType} (per Order IDX${row.index_num})`,
        order_idx: row.index_num,
        order_date: row.event_date,
      });
    }

    return Array.from(byTopic.values()).sort((a, b) => a.hearing_date.localeCompare(b.hearing_date));
  } catch {
    return [];
  }
}

function getCurrentHearingStatusBlock() {
  if (!Database || !fs.existsSync(CASE_DB_PATH)) return '';
  const db = new Database(CASE_DB_PATH, { readonly: true });
  const today = new Date().toISOString().slice(0, 10);
  try {
    const orderUpcoming = getUpcomingSettingsFromContinuanceOrders(db, today);
    const upcoming = db.prepare(
      `SELECT hearing_date, hearing_type, description
       FROM court_hearings
       WHERE case_id = 1
         AND hearing_date >= ?
         AND COALESCE(canceled, 0) = 0
       ORDER BY hearing_date
       LIMIT 8`
    ).all(today).filter((h) => !/cancel|removed/i.test(`${h.hearing_type || ''} ${h.description || ''}`));

    const canceled = db.prepare(
      `SELECT hearing_date, hearing_type, description
       FROM court_hearings
       WHERE case_id = 1
         AND hearing_date >= date(?, '-120 days')
         AND (
           COALESCE(canceled, 0) = 1
           OR upper(COALESCE(hearing_type, '')) LIKE '%CANCELED%'
           OR upper(COALESCE(description, '')) LIKE '%CANCELED%'
           OR upper(COALESCE(description, '')) LIKE '%REMOVED%'
         )
       ORDER BY hearing_date DESC
       LIMIT 8`
    ).all(today);

    if (!orderUpcoming.length && !upcoming.length && !canceled.length) return '';

    const lines = ['CURRENT HEARING STATUS (order-aligned):'];
    if (orderUpcoming.length) {
      lines.push('Confirmed upcoming settings from signed continuance orders:');
      for (const h of orderUpcoming) {
        const label = String(h.description || h.hearing_type || '').trim();
        lines.push(`- ${h.hearing_date}: ${label}`);
      }
    } else if (upcoming.length) {
      lines.push('Confirmed upcoming settings (no continuance order metadata found):');
      for (const h of upcoming) {
        const label = String(h.description || h.hearing_type || '').trim();
        lines.push(`- ${h.hearing_date}: ${label}`);
      }
    } else {
      lines.push('Confirmed upcoming settings: none listed in court_hearings or continuance orders.');
    }

    if (canceled.length) {
      lines.push('Canceled/removed settings (do not recommend these):');
      for (const h of canceled) {
        const label = String(h.description || h.hearing_type || '').trim();
        lines.push(`- ${h.hearing_date}: ${label}`);
      }
    }

    lines.push('If the Hearings panel conflicts with an Order to Continue, follow the latest signed order.');
    return lines.join('\n');
  } catch {
    return '';
  } finally {
    db.close();
  }
}

function formatIntelligenceBlock(intel) {
  if (!intel) return '';
  const lines = ['DOCKET INTELLIGENCE (derived from case outcome history — use to calibrate strategy):', ''];

  const cd = intel.contested.def;
  if (cd.total > 0) {
    const pct = cd.total > 0 ? Math.round((cd.granted / cd.total) * 100) : 0;
    lines.push(`═══ CONTESTED SUBSTANTIVE MOTIONS ═══`);
    lines.push(`DEF contested win rate: ${cd.granted}/${cd.total} decided = ${pct}%.`);
    if (cd.denied > 0) {
      lines.push(`DEF denied: ${cd.denied} motions. Pattern: batch-filed, multi-issue, broad asks.`);
    }
  }

  if (intel.modelFiling.length) {
    lines.push('');
    lines.push('MODEL FILING (what worked):');
    for (const mf of intel.modelFiling) {
      lines.push(`- ${mf.idx}: ${mf.description}. Style: ${mf.style || 'unknown'}.`);
      if (mf.what_worked) lines.push(`  What worked: ${mf.what_worked}`);
      if (mf.lesson) lines.push(`  Lesson: ${mf.lesson}`);
    }
  }

  const judgeNames = Object.keys(intel.judges);
  if (judgeNames.length) {
    lines.push('');
    lines.push('JUDGE PROFILES (contested motions only):');
    for (const name of judgeNames) {
      const j = intel.judges[name];
      const grantPct = j.total > 0 ? Math.round((j.granted / j.total) * 100) : 0;
      lines.push(`- ${name}: ${j.granted} granted / ${j.total} decided (${grantPct}%).`);
      const grantedFilings = j.filings.filter((f) => f.outcome === 'granted');
      const deniedFilings = j.filings.filter((f) => f.outcome === 'denied');
      if (grantedFilings.length) {
        lines.push(`  Granted: ${grantedFilings.map((f) => `${f.idx} (${f.description})`).join('; ')}`);
      }
      if (deniedFilings.length > 3) {
        lines.push(`  Denied ${deniedFilings.length} motions — batch-filed and multi-issue filings.`);
      } else if (deniedFilings.length) {
        lines.push(`  Denied: ${deniedFilings.map((f) => `${f.idx}`).join(', ')}`);
      }
    }
  }

  const procPlt = intel.procedural?.plt || {};
  const procDef = intel.procedural?.def || {};
  const continuances = intel.procedural?.continuances || [];
  if (procPlt.total > 0 || procDef.total > 0 || continuances.length) {
    lines.push('');
    lines.push(`═══ PROCEDURAL PATTERN ═══`);
    if (procPlt.total) lines.push(`PLT procedural: ${procPlt.granted}/${procPlt.total} granted.`);
    if (procDef.total) lines.push(`DEF procedural: ${procDef.granted}/${procDef.total} granted, ${procDef.denied || 0} denied.`);
    if (continuances.length) {
      const pltConts = continuances.filter((c) => c.filed_by === 'PLT');
      if (pltConts.length) lines.push(`PLT continuances: ${pltConts.length} filed, ${pltConts.filter((c) => c.outcome === 'granted').length} granted. Delay-as-strategy pattern.`);
      for (const c of continuances) {
        lines.push(`- ${c.idx} (${c.filed_by}): ${c.description} — ${c.outcome}${c.judge ? ` (Judge ${c.judge})` : ''}`);
      }
    }
  }

  if (intel.contested.pending.length) {
    lines.push('');
    lines.push('PENDING CONTESTED MOTIONS:');
    for (const p of intel.contested.pending) {
      lines.push(`- ${p.idx} (${p.filed_by}): ${p.description}`);
      if (p.notes) lines.push(`  Context: ${p.notes}`);
    }
  }

  lines.push('');
  lines.push('═══ DRAFTING DIRECTIVE ═══');
  lines.push('For contested motions: ONE issue. ONE rule. ONE ask. Under 350 words body.');
  lines.push('Never batch-file. Each motion must stand alone and be grantable in isolation.');
  lines.push('For oral argument: Lead with the procedural violation. Jesus Wept format.');
  lines.push('If Judge Walczyk: she batch-processes — your Cutoff version may be all you get.');

  return lines.join('\n');
}

function getFilingsForContext() {
  if (!Database || !fs.existsSync(CASE_DB_PATH)) return [];
  const db = new Database(CASE_DB_PATH, { readonly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='filing_outcomes'").all();
    if (!tables.length) return [];
    return db.prepare(`
      SELECT motion_idx, motion_description, filed_by, outcome, stakes_tier, motion_date
      FROM filing_outcomes WHERE case_id = 1
      ORDER BY motion_date DESC, motion_idx DESC
    `).all();
  } catch { return []; } finally { db.close(); }
}

function getFilingContext(idx) {
  if (!Database || !fs.existsSync(CASE_DB_PATH)) return null;
  const db = new Database(CASE_DB_PATH, { readonly: true });
  try {
    const filing = db.prepare('SELECT * FROM filing_outcomes WHERE case_id = 1 AND motion_idx = ?').get(idx);
    if (!filing) return null;

    let relatedEvents = [];
    try {
      relatedEvents = db.prepare(
        "SELECT index_num, event_date, event_type, description FROM court_events WHERE case_id = 1 AND (description LIKE ? OR index_num = ?) ORDER BY event_date"
      ).all(`%${idx}%`, idx.replace('IDX', ''));
    } catch { /* skip */ }

    let relatedHearings = [];
    try {
      relatedHearings = db.prepare(
        "SELECT hearing_date, hearing_type, description, hearing_notes FROM court_hearings WHERE case_id = 1 AND (description LIKE ? OR hearing_notes LIKE ?) ORDER BY hearing_date"
      ).all(`%${idx}%`, `%${idx}%`);
    } catch { /* skip */ }

    let relatedFilings = [];
    try {
      if (filing.motion_description) {
        const keywords = filing.motion_description.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
        if (keywords.length) {
          const like = keywords.map(() => 'motion_description LIKE ?').join(' OR ');
          relatedFilings = db.prepare(
            `SELECT motion_idx, motion_description, filed_by, outcome, ruling_judge, ruling_date
             FROM filing_outcomes WHERE case_id = 1 AND motion_idx != ? AND (${like})
             ORDER BY motion_date`
          ).all(idx, ...keywords.map(k => `%${k}%`));
        }
      }
    } catch { /* skip */ }

    return { filing, relatedEvents, relatedHearings, relatedFilings };
  } catch { return null; } finally { db.close(); }
}

function buildFilingContextBlock(ctx) {
  if (!ctx || !ctx.filing) return '';
  const f = ctx.filing;
  const lines = [
    `══ FILING CONTEXT: ${f.motion_idx} ══`,
    `Motion: ${f.motion_description}`,
    `Filed by: ${f.filed_by} on ${f.motion_date || 'unknown'}`,
    `Stakes: ${f.stakes_tier} | Outcome: ${f.outcome || 'pending'}`,
  ];
  if (f.ruling_judge) lines.push(`Ruling Judge: ${f.ruling_judge} on ${f.ruling_date || 'N/A'}`);
  if (f.filing_style) lines.push(`Filing Style: ${f.filing_style}`);
  if (f.what_worked) lines.push(`What Worked: ${f.what_worked}`);
  if (f.strategic_lesson) lines.push(`Strategic Lesson: ${f.strategic_lesson}`);
  if (f.outcome_notes) lines.push(`Notes: ${f.outcome_notes}`);

  if (ctx.relatedEvents.length) {
    lines.push('', 'Related Docket Events:');
    for (const e of ctx.relatedEvents.slice(0, 8)) {
      lines.push(`- [${e.event_date}] #${e.index_num}: ${e.description}`);
    }
  }
  if (ctx.relatedHearings.length) {
    lines.push('', 'Related Hearings:');
    for (const h of ctx.relatedHearings.slice(0, 5)) {
      lines.push(`- [${h.hearing_date}] ${h.hearing_type}: ${h.description}`);
      if (h.hearing_notes) lines.push(`  Notes: ${h.hearing_notes}`);
    }
  }
  if (ctx.relatedFilings.length) {
    lines.push('', 'Related Filings:');
    for (const rf of ctx.relatedFilings.slice(0, 6)) {
      lines.push(`- ${rf.motion_idx} (${rf.filed_by}): ${rf.motion_description} — ${rf.outcome || 'pending'}${rf.ruling_judge ? ` [Judge ${rf.ruling_judge}]` : ''}`);
    }
  }
  return lines.join('\n');
}

function getNextMoves() {
  if (!Database || !fs.existsSync(CASE_DB_PATH)) return [];
  const db = new Database(CASE_DB_PATH, { readonly: true });
  const today = new Date().toISOString().slice(0, 10);
  const moves = [];

  try {
    // Pending contested motions → action items (exclude moot/withdrawn)
    try {
      const pending = db.prepare(
        "SELECT * FROM filing_outcomes WHERE case_id = 1 AND stakes_tier = 'contested' AND outcome = 'pending' ORDER BY motion_date"
      ).all();
      for (const p of pending) {
        if (p.filed_by === 'PLT') {
          moves.push({
            priority: 'high', type: 'respond',
            title: `Respond to ${p.motion_idx}: ${p.motion_description}`,
            detail: `${p.outcome_notes || 'Plaintiff\'s pending motion requires a response.'}`.trim(),
            action: `Draft response to ${p.motion_idx}`,
            idx: p.motion_idx,
          });
        } else {
          moves.push({
            priority: 'medium', type: 'track',
            title: `Track ${p.motion_idx}: ${p.motion_description}`,
            detail: `${p.outcome_notes || 'Your pending motion awaiting ruling.'}`.trim(),
            idx: p.motion_idx,
          });
        }
      }
    } catch { /* skip */ }

    // Watch items: granted motions with pending follow-up actions
    try {
      const watchItems = db.prepare(
        "SELECT * FROM filing_outcomes WHERE case_id = 1 AND outcome = 'granted' AND outcome_notes LIKE '%NOT yet%' ORDER BY ruling_date DESC LIMIT 5"
      ).all();
      for (const w of watchItems) {
        moves.push({
          priority: 'high', type: 'respond',
          title: `Watch: ${w.motion_idx} granted but action pending`,
          detail: `${w.outcome_notes || ''}`.trim(),
          idx: w.motion_idx,
        });
      }
    } catch { /* skip */ }

    // Upcoming hearings → prep items
    try {
      const orderUpcoming = getUpcomingSettingsFromContinuanceOrders(db, today);
      const hearings = orderUpcoming.length
        ? orderUpcoming
        : db.prepare(
          "SELECT hearing_date, hearing_type, description, canceled FROM court_hearings WHERE case_id = 1 AND hearing_date >= ? AND COALESCE(canceled, 0) = 0 ORDER BY hearing_date LIMIT 5"
        ).all(today);
      for (const h of hearings) {
        const daysOut = Math.ceil((new Date(h.hearing_date + 'T00:00:00') - new Date()) / 86400000);
        const desc = String(h.description || h.hearing_type || '');
        const marker = `${h.hearing_type || ''} ${desc}`;
        if (!orderUpcoming.length && /cancel|removed/i.test(marker)) continue;
        const urgency = daysOut <= 7 ? 'critical' : daysOut <= 21 ? 'high' : 'medium';
        const source = h.order_idx ? ` (Order IDX${h.order_idx})` : '';
        moves.push({
          priority: urgency, type: 'hearing-prep',
          title: `Hearing in ${daysOut} days: ${desc}`,
          detail: `${h.hearing_date}${source} — Prepare oral arguments (Jesus Wept + Cutoff versions). Review related filings.`,
          action: 'Generate hearing prep',
          hearingDate: h.hearing_date,
          hearingDesc: desc,
        });
      }
    } catch { /* skip */ }

    // Overdue/urgent deadlines
    try {
      const deadlines = db.prepare(
        "SELECT * FROM deadlines WHERE case_id = 1 AND status NOT IN ('moot', 'resolved', 'dismissed') AND due_date <= date(?, '+7 days') ORDER BY due_date"
      ).all(today);
      for (const d of deadlines) {
        const daysUntil = Math.ceil((new Date(d.due_date) - new Date(today)) / 86400000);
        moves.push({
          priority: daysUntil < 0 ? 'critical' : daysUntil <= 3 ? 'high' : 'medium',
          type: 'deadline',
          title: daysUntil < 0 ? `OVERDUE: ${d.description}` : `Deadline in ${daysUntil}d: ${d.description}`,
          detail: `Due: ${d.due_date}. ${d.notes || ''}`.trim(),
        });
      }
    } catch { /* skip */ }

    // Recent denied DEF motions → consider lessons
    try {
      const recentDenied = db.prepare(
        "SELECT * FROM filing_outcomes WHERE case_id = 1 AND filed_by = 'DEF' AND outcome = 'denied' AND ruling_date >= date(?, '-30 days') ORDER BY ruling_date DESC LIMIT 3"
      ).all(today);
      for (const d of recentDenied) {
        if (d.strategic_lesson) {
          moves.push({
            priority: 'low', type: 'lesson',
            title: `Lesson from ${d.motion_idx} denial`,
            detail: d.strategic_lesson,
            idx: d.motion_idx,
          });
        }
      }
    } catch { /* skip */ }

    // Granted motions needing follow-up — only recent (60 days) and skip watch items
    try {
      const granted = db.prepare(
        "SELECT * FROM filing_outcomes WHERE case_id = 1 AND filed_by = 'DEF' AND outcome = 'granted' AND ruling_date >= date(?, '-60 days') AND outcome_notes NOT LIKE '%NOT yet%' ORDER BY ruling_date DESC LIMIT 3"
      ).all(today);
      for (const g of granted) {
        moves.push({
          priority: 'low', type: 'follow-up',
          title: `Follow up: ${g.motion_idx} was granted`,
          detail: `${g.motion_description}. ${g.outcome_notes || 'Ensure compliance and leverage this ruling.'}`,
          idx: g.motion_idx,
        });
      }
    } catch { /* skip */ }

    // Sort by priority
    const pOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    moves.sort((a, b) => (pOrder[a.priority] ?? 9) - (pOrder[b.priority] ?? 9));

    return moves;
  } catch { return []; } finally { db.close(); }
}

function librarySearch(q) {
  const query = String(q || '').trim();
  if (!query) return [];

  const roots = [
    path.join(PROJECT_ROOT, '07_Research'),
    path.join(PROJECT_ROOT, '00_Case_Overview'),
  ];

  const results = [];
  const maxResults = 30;
  const lowerQ = query.toLowerCase();

  function walk(dir) {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (results.length >= maxResults) return;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '_archive_html' || ent.name === '_archive_sources') continue;
        walk(abs);
        continue;
      }

      const ext = path.extname(ent.name).toLowerCase();
      if (ext !== '.md' && ext !== '.txt') continue;

      let text;
      try {
        const stat = fs.statSync(abs);
        if (stat.size > 2_000_000) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }

      const idx = text.toLowerCase().indexOf(lowerQ);
      if (idx === -1) continue;

      const start = Math.max(0, idx - 120);
      const end = Math.min(text.length, idx + 200);
      const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();

      results.push({ path: abs.replace(PROJECT_ROOT + path.sep, ''), snippet });
    }
  }

  for (const root of roots) walk(root);
  return results;
}

function ragRoots() {
  return [
    path.join(PROJECT_ROOT, '01_Pleadings'),
    path.join(PROJECT_ROOT, '02_Motions'),
    path.join(PROJECT_ROOT, '04_Evidence_Exhibits'),
    path.join(PROJECT_ROOT, '05_Court_Orders'),
    path.join(PROJECT_ROOT, '06_Correspondence'),
    path.join(PROJECT_ROOT, '07_Research'),
    path.join(PROJECT_ROOT, '00_Case_Overview'),
    ATTACHMENTS_DIR,
  ];
}

function extractTerms(q) {
  const raw = String(q || '')
    .toLowerCase()
    // Normalize common legal abbreviation variants so they survive punctuation stripping.
    .replace(/\bn\s*\.?\s*c\s*\.?\s*g\s*\.?\s*s\.?\b/g, ' ncgs ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'your', 'you', 'are', 'was', 'were',
    'will', 'would', 'should', 'could', 'about', 'into', 'over', 'under', 'then', 'than', 'them', 'they',
    'their', 'what', 'why', 'how', 'does', 'did', 'can', 'cant', 'not', 'but', 'also', 'just', 'like',
  ]);

  const terms = [];
  for (const t of raw) {
    if (terms.length >= 16) break;
    if (t.length < 4) continue;
    if (stop.has(t)) continue;
    if (!terms.includes(t)) terms.push(t);
  }
  return terms;
}

// Terms that appear everywhere in legal pleadings and should not dominate retrieval.
// We downweight them instead of deleting them entirely.
const BOILERPLATE_TERMS = new Set([
  'plaintiff', 'defendant', 'court', 'county', 'district', 'division', 'state', 'north', 'carolina',
  'general', 'justice', 'file', 'number', 'case', 'action', 'civil', 'matter',
]);

const DOC_TYPE_TERMS = new Set([
  'motion', 'motions', 'order', 'orders', 'complaint', 'amended', 'answer', 'response', 'reply',
  'notice', 'hearing', 'exhibit', 'affidavit', 'memorandum', 'brief', 'subpoena', 'summons',
  'dismiss', 'transfer', 'substitution', 'filing', 'filed', 'served', 'service', 'pending',
  'grant', 'granted', 'deny', 'denied', 'continue', 'continued',
]);

const PARTY_TERMS = cfg.partyTerms();

const HIGH_VALUE_QUERY_TERMS = new Set([
  'complaint', 'amended', 'allegation', 'allegations', 'paragraph', 'paragraphs',
  'counterclaim', 'standing', 'jurisdiction', 'assignment', 'substitution',
]);

const STATUS_QUERY_TERMS = new Set([
  'order', 'hearing', 'docket', 'index', 'idx', 'filing', 'filed', 'served', 'service',
  'granted', 'denied', 'pending', 'withdrawal', 'amended', 'complaint',
]);

const RESEARCH_QUERY_TERMS = new Set([
  'statute', 'statutes', 'rule', 'rules', 'ncgs', 'citation', 'citations',
  'precedent', 'holding', 'holdings', 'authority', 'authorities',
]);

function isCaseDocPath(relPathLower) {
  return relPathLower.startsWith('01_pleadings/')
    || relPathLower.startsWith('02_motions/')
    || relPathLower.startsWith('03_discovery/')
    || relPathLower.startsWith('04_evidence_exhibits/')
    || relPathLower.startsWith('05_court_orders/')
    || relPathLower.startsWith('06_correspondence/');
}

function extractIdxKeys(query) {
  const out = [];
  const re = /\bidx\s*0*(\d{1,4})\b/ig;
  for (const m of String(query || '').matchAll(re)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const key = String(n).padStart(3, '0');
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

function parseIdxFromPath(relPathLower) {
  const m = String(relPathLower || '').match(/\bidx\s*0*(\d{1,4})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function idxProximityBoost(relPathLower, idxKeys) {
  if (!Array.isArray(idxKeys) || !idxKeys.length) return 0;
  if (idxKeys.some((k) => String(relPathLower || '').includes(`idx${k}`))) return 3.0;

  const docIdx = parseIdxFromPath(relPathLower);
  if (!docIdx) return 0;

  let best = Number.POSITIVE_INFINITY;
  for (const k of idxKeys) {
    const q = Number(k);
    if (!Number.isFinite(q) || q <= 0) continue;
    const d = Math.abs(docIdx - q);
    if (d < best) best = d;
  }
  if (!Number.isFinite(best)) return 0;
  if (best <= 2) return 1.4;
  if (best <= 5) return 0.8;
  if (best <= 10) return 0.3;
  return 0;
}

function detectRagIntent(query, terms) {
  const lower = String(query || '').toLowerCase();
  const hasIdx = /\bidx\s*0*\d{1,4}\b/i.test(lower);
  const statusHits = terms.filter((t) => STATUS_QUERY_TERMS.has(t)).length;
  const researchHits = terms.filter((t) => RESEARCH_QUERY_TERMS.has(t)).length;
  const explicitProceduralCue = /\b(what happened|status|was it granted|was it denied|when is|hearing|docket|filed|served|service|pending|withdrawal)\b/i.test(lower);
  const explicitResearchCue = /\b(cite|citation|authority|authorities|statute|rule|case law|holding|precedent|research)\b/i.test(lower);

  const proceduralScore = statusHits + (hasIdx ? 3 : 0) + (explicitProceduralCue ? 2 : 0);
  const researchScore = researchHits + (explicitResearchCue ? 3 : 0);
  const delta = proceduralScore - researchScore;
  const absDelta = Math.abs(delta);
  const proceduralStrong = proceduralScore >= 3;
  const researchStrong = researchScore >= 3;

  let mode = 'general';
  if (proceduralStrong && researchStrong && absDelta <= 1) {
    mode = 'hybrid';
  } else if (researchScore >= proceduralScore + 2) {
    mode = 'legal_research';
  } else if (proceduralScore >= researchScore + 2) {
    mode = 'procedural_status';
  } else if (hasIdx && proceduralScore > 0 && delta >= 0) {
    // IDX-directed status queries should default to docket posture unless legal cues clearly dominate.
    mode = 'procedural_status';
  } else if (researchScore > 0 && proceduralScore > 0) {
    mode = delta > 0 ? 'procedural_status' : 'legal_research';
  } else if (researchScore > 0) {
    mode = 'legal_research';
  } else if (proceduralScore > 0) {
    mode = 'procedural_status';
  }

  return {
    mode,
    hasIdx,
    explicitProceduralCue,
    explicitResearchCue,
    proceduralScore,
    researchScore,
  };
}

function intentPathBoost(relPathLower, intentProfile, idxKeys) {
  const mode = intentProfile?.mode || 'general';
  let boost = 0;
  const inResearch = relPathLower.startsWith('07_research/');
  const inCaseDocs = isCaseDocPath(relPathLower);

  if (mode === 'procedural_status') {
    if (inCaseDocs) boost += 2.2;
    if (inResearch) boost -= intentProfile?.explicitResearchCue ? 0.5 : 1.4;
  } else if (mode === 'legal_research') {
    if (inResearch) boost += 1.6;
    if (inCaseDocs) boost -= 1.0;
  } else if (mode === 'hybrid') {
    if (inCaseDocs) boost += 1.3;
    if (inResearch) boost += 1.1;
  }

  if (relPathLower.endsWith('/readme.md') || relPathLower.endsWith('readme.md')) {
    boost -= 1.2;
  }

  boost += idxProximityBoost(relPathLower, idxKeys);

  return boost;
}

function sourceGroupForPath(relPath) {
  const pathLower = String(relPath || '').toLowerCase().replace(/\\/g, '/');
  if (pathLower.startsWith('07_research/')) return 'research';
  if (isCaseDocPath(pathLower)) return 'case_docs';
  return 'other';
}

function sourceFamilyForPath(relPath) {
  const p = String(relPath || '').toLowerCase().replace(/\\/g, '/');
  if (p.startsWith('07_research/statutes/')) return 'research_statutes';
  if (p.startsWith('07_research/case_law/')) return 'research_case_law';
  if (p.startsWith('07_research/local_rules/')) return 'research_local_rules';
  if (p.startsWith('07_research/')) return 'research_other';
  if (p.startsWith('01_pleadings/')) return 'case_pleadings';
  if (p.startsWith('02_motions/')) return 'case_motions';
  if (p.startsWith('03_discovery/')) return 'case_discovery';
  if (p.startsWith('04_evidence_exhibits/')) return 'case_exhibits';
  if (p.startsWith('05_court_orders/')) return 'case_orders';
  if (p.startsWith('06_correspondence/')) return 'case_correspondence';
  return 'other';
}

function capCandidatesByIntent(sortedCandidates, maxResults, intentProfile) {
  if (!Array.isArray(sortedCandidates) || !sortedCandidates.length) return [];

  const mode = intentProfile?.mode || 'general';
  const clampCount = (n) => Math.max(0, Math.min(maxResults, Number(n) || 0));
  const pctCount = (pct, minAbs = 0) => clampCount(Math.max(minAbs, Math.round(maxResults * pct)));

  const floors = { research: 0, case_docs: 0, other: 0 };
  const caps = { research: maxResults, case_docs: maxResults, other: maxResults };

  if (mode === 'procedural_status') {
    floors.case_docs = pctCount(0.4, 3);
    caps.research = intentProfile?.explicitResearchCue
      ? pctCount(0.45, 4)
      : (intentProfile?.hasIdx ? Math.min(2, maxResults) : pctCount(0.3, 3));
    caps.other = pctCount(0.4, 2);
  } else if (mode === 'legal_research') {
    floors.research = pctCount(0.45, 3);
    caps.case_docs = pctCount(0.65, 4);
    caps.other = pctCount(0.4, 2);
  } else if (mode === 'hybrid') {
    floors.research = pctCount(0.3, 2);
    floors.case_docs = pctCount(0.3, 2);
    caps.research = pctCount(0.65, 4);
    caps.case_docs = pctCount(0.65, 4);
    caps.other = pctCount(0.35, 2);
  }

  const defaultFamilyCap = mode === 'procedural_status'
    ? pctCount(0.4, 3)
    : mode === 'hybrid'
      ? pctCount(0.5, 3)
      : pctCount(0.6, 4);
  const familyCaps = {
    research_statutes:
      mode === 'procedural_status'
        ? (intentProfile?.explicitResearchCue ? pctCount(0.4, 3) : pctCount(0.25, 2))
        : mode === 'hybrid'
          ? pctCount(0.45, 3)
          : pctCount(0.65, 4),
    case_motions: mode === 'legal_research' ? pctCount(0.3, 2) : pctCount(0.55, 3),
  };

  // Floors must be satisfiable inside caps.
  for (const group of Object.keys(floors)) {
    if (floors[group] > caps[group]) caps[group] = floors[group];
  }

  const picked = [];
  const pickedSet = new Set();
  const counts = { research: 0, case_docs: 0, other: 0 };
  const familyCounts = Object.create(null);

  function candidateKey(c) {
    return `${String(c.path || '')}|${String(c.kind || '')}|${String(c.snippet || '').slice(0, 64)}`;
  }

  function tryPick(c, ignoreCaps = false) {
    if (!c || picked.length >= maxResults) return false;
    const key = candidateKey(c);
    if (pickedSet.has(key)) return false;
    const group = sourceGroupForPath(c.path);
    if (!ignoreCaps && counts[group] >= caps[group]) return false;

    const family = sourceFamilyForPath(c.path);
    const familyLimit = familyCaps[family] || defaultFamilyCap;
    if (!ignoreCaps && (familyCounts[family] || 0) >= familyLimit) return false;

    pickedSet.add(key);
    picked.push(c);
    counts[group] += 1;
    familyCounts[family] = (familyCounts[family] || 0) + 1;
    return true;
  }

  function buildTopWindowConstraints() {
    const constraints = [];
    if (mode === 'procedural_status' && (intentProfile?.proceduralScore || 0) >= 4) {
      constraints.push({
        window: Math.min(5, maxResults),
        minByGroup: {
          case_docs: intentProfile?.hasIdx ? 3 : 2,
          ...(intentProfile?.explicitResearchCue ? { research: 1 } : {}),
        },
      });
    } else if (mode === 'legal_research' && (intentProfile?.researchScore || 0) >= 4) {
      constraints.push({
        window: Math.min(1, maxResults),
        minByGroup: { research: 1 },
      });
      constraints.push({
        window: Math.min(3, maxResults),
        minByGroup: { research: 2 },
      });
      constraints.push({
        window: Math.min(5, maxResults),
        minByGroup: { research: 3 },
      });
    } else if (mode === 'hybrid') {
      constraints.push({
        window: Math.min(6, maxResults),
        minByGroup: {
          case_docs: intentProfile?.hasIdx ? 3 : 2,
          research: 2,
        },
      });
    }
    return constraints;
  }

  function enforceTopWindowConstraints(items, constraints) {
    if (!Array.isArray(items) || !items.length || !Array.isArray(constraints) || !constraints.length) return items;
    const out = items.slice();

    function windowCounts(window) {
      const c = { research: 0, case_docs: 0, other: 0 };
      for (let i = 0; i < Math.min(window, out.length); i++) {
        const g = sourceGroupForPath(out[i]?.path);
        c[g] = (c[g] || 0) + 1;
      }
      return c;
    }

    function isSatisfied(countsObj, minByGroup) {
      for (const [g, minCount] of Object.entries(minByGroup || {})) {
        if ((countsObj[g] || 0) < minCount) return false;
      }
      return true;
    }

    function applyOne(window, minByGroup) {
      const maxIter = Math.max(6, window * 3);
      for (let iter = 0; iter < maxIter; iter++) {
        const countsObj = windowCounts(window);
        if (isSatisfied(countsObj, minByGroup)) return true;

        let moved = false;
        for (const [needGroup, needCount] of Object.entries(minByGroup || {})) {
          if ((countsObj[needGroup] || 0) >= needCount) continue;

          // Promote highest-ranked candidate outside window from needed group.
          let promoteIdx = -1;
          for (let i = window; i < out.length; i++) {
            if (sourceGroupForPath(out[i]?.path) === needGroup) {
              promoteIdx = i;
              break;
            }
          }
          if (promoteIdx === -1) continue;

          // Demote the lowest-score item in window whose group has surplus.
          let demoteIdx = -1;
          let demoteScore = Number.POSITIVE_INFINITY;
          for (let i = 0; i < Math.min(window, out.length); i++) {
            const g = sourceGroupForPath(out[i]?.path);
            const required = minByGroup[g] || 0;
            if ((countsObj[g] || 0) <= required) continue;
            const score = Number(out[i]?.score || 0);
            if (score < demoteScore) {
              demoteScore = score;
              demoteIdx = i;
            }
          }
          if (demoteIdx === -1) continue;

          const tmp = out[demoteIdx];
          out[demoteIdx] = out[promoteIdx];
          out[promoteIdx] = tmp;
          moved = true;
          break;
        }

        if (!moved) break;
      }
      return isSatisfied(windowCounts(window), minByGroup);
    }

    for (const rule of constraints) {
      const window = Math.max(1, Math.min(Number(rule?.window || 0), out.length));
      const baseMin = rule?.minByGroup || {};
      // Graceful relaxation: try full requirement, then decrement all mins by 1, then by 2.
      let satisfied = false;
      for (let relax = 0; relax <= 2 && !satisfied; relax++) {
        const minByGroup = {};
        for (const [g, v] of Object.entries(baseMin)) {
          minByGroup[g] = Math.max(0, Number(v || 0) - relax);
        }
        satisfied = applyOne(window, minByGroup);
      }
    }

    return out;
  }

  // Pass 1: high-score selection with caps.
  for (const c of sortedCandidates) {
    tryPick(c, false);
    if (picked.length >= maxResults) break;
  }

  // Pass 2: enforce floors (ignore caps if needed, but keep order by score).
  for (const [group, floor] of Object.entries(floors)) {
    if (!floor || picked.length >= maxResults) continue;
    if (counts[group] >= floor) continue;
    for (const c of sortedCandidates) {
      if (picked.length >= maxResults || counts[group] >= floor) break;
      if (sourceGroupForPath(c.path) !== group) continue;
      tryPick(c, true);
    }
  }

  // Pass 3: backfill remaining slots by rank, no caps.
  if (picked.length < maxResults) {
    const strictProceduralIdx = mode === 'procedural_status'
      && Boolean(intentProfile?.hasIdx)
      && !intentProfile?.explicitResearchCue;
    for (const c of sortedCandidates) {
      if (picked.length >= maxResults) break;
      tryPick(c, !strictProceduralIdx);
    }
  }

  return enforceTopWindowConstraints(picked, buildTopWindowConstraints());
}

function termWeight(t) {
  if (BOILERPLATE_TERMS.has(t)) return 0.1;
  if (DOC_TYPE_TERMS.has(t)) return 0.35;
  if (PARTY_TERMS.has(t)) return 0.6;
  return 1.0;
}

function countTermMatches(textLower, terms) {
  let count = 0;
  for (const t of terms) {
    if (textLower.includes(t)) count++;
  }
  return count;
}

function weightedTermScore(textLower, terms) {
  let score = 0;
  for (const t of terms) {
    if (textLower.includes(t)) score += termWeight(t);
  }
  return score;
}

function hasAnyTerm(haystackLower, terms) {
  for (const t of terms) {
    if (haystackLower.includes(t)) return t;
  }
  return null;
}

const _pdfCache = new Map();
function tryPdfToText(pdfPath) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(pdfPath).mtimeMs;
  } catch {
    return null;
  }

  const cached = _pdfCache.get(pdfPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.text;

  try {
    // Optional dependency: if pdftotext isn't installed, this throws and we return null.
    const out = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const text = out ? out.toString('utf8') : '';
    _pdfCache.set(pdfPath, { mtimeMs, text });
    if (_pdfCache.size > 500) {
      const first = _pdfCache.keys().next().value;
      _pdfCache.delete(first);
    }
    return text;
  } catch {
    _pdfCache.set(pdfPath, { mtimeMs, text: null });
    return null;
  }
}

function ragSearch(q, { maxResults = 25 } = {}) {
  const query = String(q || '').trim();
  if (!query) return [];
  const terms = extractTerms(query);
  if (!terms.length) return [];
  const idxKeys = extractIdxKeys(query);
  const intentProfile = detectRagIntent(query, terms);

  // Only do expensive PDF extraction when the query has at least one meaningful term
  // (party name, unique concept) OR the PDF filename matches multiple terms.
  const strongTerms = terms.filter((t) => termWeight(t) >= 0.6 || HIGH_VALUE_QUERY_TERMS.has(t) || t.length >= 9);
  const complaintFocusedQuery = terms.some((t) => HIGH_VALUE_QUERY_TERMS.has(t));
  const MAX_PDF_EXTRACT = 6;
  let pdfExtracts = 0;

  const candidates = [];
  const maxBytes = 1_500_000;

  // Boost scores for high-value document types
  const FOLDER_BOOST = {
    '05_Court_Orders': 2,
    '01_Pleadings': 1.5,
    '02_Motions': 1.5,
    '04_Evidence_Exhibits': 1,
    '07_Research': 0.4,
  };

  function folderBoost(relPath) {
    const rel = String(relPath || '');
    for (const [folder, boost] of Object.entries(FOLDER_BOOST)) {
      if (rel.startsWith(folder)) return boost;
    }
    return 0;
  }

  function push(absPath, snippet, score, extra = {}) {
    const relPath = absPath.replace(PROJECT_ROOT + path.sep, '').replace(/\\/g, '/');
    const relPathLower = relPath.toLowerCase();
    candidates.push({
      path: relPath,
      snippet,
      score: score + folderBoost(relPath) + intentPathBoost(relPathLower, intentProfile, idxKeys),
      ...extra,
    });
  }

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);

      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '_archive_html' || ent.name === '_archive_sources' || ent.name === '_archive_drafts') continue;
        walk(abs);
        continue;
      }

      const ext = path.extname(ent.name).toLowerCase();
      const nameLower = ent.name.toLowerCase();
      const relPathLower = abs.replace(PROJECT_ROOT + path.sep, '').replace(/\\/g, '/').toLowerCase();
      const idxBoost = idxProximityBoost(relPathLower, idxKeys);
      const proceduralIdxFallback = intentProfile?.hasIdx
        && intentProfile?.mode === 'procedural_status'
        && sourceGroupForPath(relPathLower) === 'case_docs'
        && idxBoost > 0;

      // PDFs: cheap filename match first, then optional text extraction.
      if (ext === '.pdf') {
        const nameMatches = countTermMatches(nameLower, terms);
        const complaintishName = nameLower.includes('complaint') || nameLower.includes('amended');
        const forcedComplaintMatch = complaintFocusedQuery && complaintishName;
        if (nameMatches <= 0 && !forcedComplaintMatch && !proceduralIdxFallback) continue;
        const effectiveNameMatches = Math.max(nameMatches, forcedComplaintMatch ? 1 : 0);

        const allowExtract = pdfExtracts < MAX_PDF_EXTRACT && (strongTerms.length > 0 || effectiveNameMatches >= 2 || forcedComplaintMatch);
        if (!allowExtract) {
          push(
            abs,
            `PDF matched by filename (${effectiveNameMatches} term${effectiveNameMatches === 1 ? '' : 's'}).`,
            effectiveNameMatches * 0.35,
            { kind: 'pdf', extracted: false },
          );
          continue;
        }

        pdfExtracts++;
        const pdfText = tryPdfToText(abs);
        if (pdfText === null) {
          push(
            abs,
            `PDF matched by filename (${effectiveNameMatches} term${effectiveNameMatches === 1 ? '' : 's'}) — text extraction unavailable (install poppler).`,
            effectiveNameMatches * 0.35,
            { kind: 'pdf', extracted: false },
          );
        } else {
          const lower = pdfText.toLowerCase();
          const contentScore = weightedTermScore(lower, terms);
          const score = Math.max(effectiveNameMatches * 0.35, contentScore);
          let snippet = '';
          if (complaintFocusedQuery && complaintishName) {
            // Prefer opening text for complaints to avoid anchoring only on attached exhibits.
            snippet = pdfText.slice(0, 2400).replace(/\s+/g, ' ').trim();
          }
          if (!snippet) {
            const bestTerm = strongTerms.find((t) => lower.includes(t)) || terms.find((t) => lower.includes(t)) || terms[0];
            const idx = Math.max(0, lower.indexOf(bestTerm));
            const start = Math.max(0, idx - 300);
            const end = Math.min(pdfText.length, idx + 900);
            snippet = pdfText.slice(start, end).replace(/\s+/g, ' ').trim();
          }
          push(abs, snippet || 'PDF matched (no extractable snippet).', score, { kind: 'pdf', extracted: true });
        }
        continue;
      }

      if (ext !== '.md' && ext !== '.txt') continue;

      let text;
      try {
        const stat = fs.statSync(abs);
        if (stat.size > maxBytes) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }

      const lower = text.toLowerCase();
      const contentMatches = countTermMatches(lower, terms);
      if (contentMatches <= 0 && !proceduralIdxFallback) continue;

      const contentScore = weightedTermScore(lower, terms);
      const nameMatches = countTermMatches(nameLower, terms);
      const score = contentScore + (nameMatches > 0 ? 0.3 : 0);
      if (score < 0.5) continue;

      const bestTerm = strongTerms.find((t) => lower.includes(t)) || terms.find((t) => lower.includes(t)) || terms[0];
      const idx = Math.max(0, lower.indexOf(bestTerm));
      const start = Math.max(0, idx - 400);
      const end = Math.min(text.length, idx + 1200);
      const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
      push(abs, snippet, score, { kind: ext.slice(1) });
    }
  }

  // Skip 00_Case_Overview — it's always injected as baseline context
  for (const root of ragRoots()) {
    if (root.endsWith('00_Case_Overview')) continue;
    walk(root);
  }

  // Sort by score descending, then by path length ascending (shorter = more specific).
  candidates.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return capCandidatesByIntent(candidates, maxResults, intentProfile);
}

function buildRagResult(q) {
  const hits = ragSearch(q, { maxResults: 25 });
  if (!hits.length) return { context: '', paths: [], sources: [], sourcePacket: null };

  const sourcePacket = {
    id: id('sp'),
    createdAt: new Date().toISOString(),
    queryHash: sha256Hex(String(q || '').trim().toLowerCase()),
    sources: hits.map((h) => {
      const relPath = String(h.path || '');
      const snippet = String(h.snippet || '').slice(0, 2000);
      let mtimeMs = null;
      try {
        mtimeMs = fs.statSync(path.join(PROJECT_ROOT, relPath)).mtimeMs;
      } catch {
        mtimeMs = null;
      }
      return {
        path: relPath,
        score: h.score,
        kind: h.kind || null,
        extracted: Boolean(h.extracted),
        snippet,
        mtimeMs,
        snippetHash: sha256Hex(snippet),
        sourceHash: sha256Hex(`${relPath}|${mtimeMs || ''}|${snippet}`),
      };
    }),
  };

  const blocks = hits.map((h) => [
    '---',
    `PATH: ${h.path}`,
    'EXCERPT:',
    String(h.snippet || '').slice(0, 2000),
  ].join('\n'));
  return {
    context: blocks.join('\n\n').slice(0, 26_000),
    paths: hits.map((h) => h.path),
    sources: hits.map((h) => ({ path: h.path, score: h.score, kind: h.kind || null, extracted: Boolean(h.extracted) })),
    sourcePacket,
  };
}

function buildSystemPromptWithContext({ mode, query }) {
  const baseline = getBaselineContext();
  const { context: rag, paths, sources, sourcePacket } = buildRagResult(query);
  const intel = getCachedIntelligence();
  const intelBlock = formatIntelligenceBlock(intel);
  const hearingStatusBlock = getCurrentHearingStatusBlock();
  const contextBlock = [baseline.context, rag].filter(Boolean).join('\n\n');
  return {
    system: [
      draftingSystemPrompt({ mode }),
      intelBlock ? `\n\n${intelBlock}` : '',
      hearingStatusBlock ? `\n\n${hearingStatusBlock}` : '',
      contextBlock
        ? `\n\nLOCAL CASE CONTEXT (verbatim excerpts; cite by PATH when using facts):\n${contextBlock}`
        : 'LOCAL CASE CONTEXT: (none found for this message)',
    ].join('\n'),
    baselinePaths: baseline.pathsLoaded,
    ragPaths: paths,
    ragSources: sources,
    sourcePacket,
  };
}

function normalizeSourceDraftDocType(input) {
  const allowed = new Set(['MOT', 'RESP', 'ANS', 'REPLY', 'MEMO', 'BRIEF', 'NOT', 'NOH']);
  const v = String(input || 'MEMO').trim().toUpperCase();
  return allowed.has(v) ? v : 'MEMO';
}

function parseJsonObjectLoose(text) {
  const s = String(text || '').trim();
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(s.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectLongQuotedPhrases(text) {
  const out = [];
  const input = String(text || '');
  const re = /["“”]([^"“”\n]{35,})["“”]/g;
  for (const match of input.matchAll(re)) {
    const phrase = normalizeForMatch(match[1]);
    const words = phrase.split(/\s+/).filter(Boolean).length;
    if (words >= 6 && phrase.length <= 700) out.push(phrase);
  }
  return Array.from(new Set(out));
}

function resolveSourcePacketFromMeta(meta) {
  if (meta?.sourcePacket && Array.isArray(meta.sourcePacket.sources) && meta.sourcePacket.sources.length) {
    return {
      ...meta.sourcePacket,
      sources: meta.sourcePacket.sources.map((s) => ({ ...s })),
    };
  }
  const packetId = String(meta?.sourcePacketId || meta?.sourcePacket?.id || '').trim();
  if (!packetId) return null;
  return loadPersistedSourcePacket(packetId);
}

async function verifySourceLockedDraft({ sourcePacket, objective, targetType, draftText }) {
  const sourceContext = buildSourcePacketContext(sourcePacket);
  if (!sourceContext.trim()) {
    return { ok: false, reason: 'Missing source context', missingQuotes: [], unsupported: [] };
  }

  const normalizedSource = normalizeForMatch(sourceContext);
  const quotedPhrases = collectLongQuotedPhrases(draftText);
  const missingQuotes = quotedPhrases.filter((q) => !normalizedSource.includes(q));

  const verifierRaw = await callAnthropic({
    system: [
      'You are a strict legal factual verifier.',
      'Return ONLY minified JSON: {"pass":boolean,"unsupported":[{"claim":"...","reason":"..."}]}',
      'Mark unsupported only when the draft assertion is not grounded in the supplied source packet excerpts.',
      'Do not infer outside facts. Be conservative and specific.',
      '',
      'SOURCE PACKET EXCERPTS:',
      sourceContext,
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          `Objective: ${objective}`,
          `Target filing type: ${targetType}`,
          'DRAFT TO VERIFY:',
          String(draftText || '').slice(0, 16_000),
        ].join('\n\n'),
      },
    ],
  });

  const parsed = parseJsonObjectLoose(verifierRaw) || {};
  const unsupported = Array.isArray(parsed.unsupported)
    ? parsed.unsupported
        .map((u) => ({
          claim: String(u?.claim || '').trim(),
          reason: String(u?.reason || '').trim(),
        }))
        .filter((u) => u.claim)
        .slice(0, 8)
    : [];

  const parseOk = typeof parsed.pass === 'boolean';
  const explicitFail = parsed.pass === false;
  const ok = parseOk && !explicitFail && !missingQuotes.length && !unsupported.length;
  return {
    ok,
    missingQuotes,
    unsupported,
    verifierSummary: summarizeStrategyGate(verifierRaw),
  };
}

function buildSourcePacketContext(sourcePacket, { maxChars = 22_000 } = {}) {
  if (!sourcePacket || !Array.isArray(sourcePacket.sources) || !sourcePacket.sources.length) return '';
  const blocks = sourcePacket.sources.map((s) => [
    '---',
    `PATH: ${s.path}`,
    `SOURCE_HASH: ${s.sourceHash || ''}`,
    'EXCERPT:',
    String(s.snippet || '').slice(0, 2000),
  ].join('\n'));
  return blocks.join('\n\n').slice(0, maxChars);
}

function summarizeStrategyGate(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

async function buildSourceLockedDraft({ sourcePacket, objective, targetType, existingDraftContent }) {
  const sourceContext = buildSourcePacketContext(sourcePacket);
  if (!sourceContext.trim()) {
    const err = new Error('No usable source packet context on this message');
    err.code = 'NO_SOURCE_PACKET_CONTEXT';
    throw err;
  }

  const strategyGate = await callAnthropic({
    system: [
      draftingSystemPrompt({ mode: 'draft' }),
      '',
      'SOURCE-LOCKED STRATEGY MODE:',
      '- Use ONLY SOURCE PACKET excerpts below.',
      '- Do not add facts not present in SOURCE PACKET.',
      '- Prioritize the cleanest, most likely-to-be-granted path.',
      '- Pressure-test against opposing counsel and judge-friction.',
      '- Output markdown with EXACT sections and numbering:',
      '## STRATEGY GATE',
      '1) Most likely court path',
      '2) Opposing counsel best response',
      '3) Recommended move now',
      '4) Risks if denied',
      '5) Fallback move',
      '## EVIDENCE LEDGER',
      '- Fact: ... | Path: ... | Quote: ... | Why it matters: ...',
      '',
      `SOURCE PACKET (frozen from assistant message ${sourcePacket.id}):`,
      sourceContext,
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          `Objective: ${objective}`,
          `Target filing type: ${targetType}`,
          existingDraftContent ? `Current draft to consider:\n${existingDraftContent.slice(0, 5000)}` : 'No current draft, create from scratch.',
        ].join('\n\n'),
      },
    ],
  });

  const drafted = await callAnthropic({
    system: [
      draftingSystemPrompt({ mode: 'draft' }),
      '',
      'SOURCE-LOCKED DRAFTING MODE:',
      '- Draft using ONLY facts from STRATEGY GATE and EVIDENCE LEDGER plus SOURCE PACKET excerpts.',
      '- If a needed fact is missing, say "The provided context does not include [item]."',
      '- Do not add authorities or facts absent from provided material.',
      '- Output the FULL final draft only, no prefatory commentary.',
      '',
      `SOURCE PACKET (frozen from assistant message ${sourcePacket.id}):`,
      sourceContext,
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          `Objective: ${objective}`,
          `Target filing type: ${targetType}`,
          existingDraftContent
            ? `CURRENT DRAFT TO UPDATE:\n${existingDraftContent}`
            : 'No current draft. Generate a new complete draft.',
          'STRATEGY GATE + EVIDENCE LEDGER:',
          strategyGate,
        ].join('\n\n'),
      },
    ],
  });

  return {
    strategyGate,
    draftText: sanitizeDraftOutput(drafted, { mode: 'draft' }),
  };
}

async function repairSourceLockedDraft({ sourcePacket, objective, targetType, draftText, verification }) {
  const sourceContext = buildSourcePacketContext(sourcePacket);
  const missingQuoteLines = (verification?.missingQuotes || []).slice(0, 6).map((q) => `- Missing quote support: "${q}"`);
  const unsupportedLines = (verification?.unsupported || []).slice(0, 6).map((u) => `- Unsupported: ${u.claim}${u.reason ? ` | reason: ${u.reason}` : ''}`);
  const failSummary = [...missingQuoteLines, ...unsupportedLines].join('\n') || '- Verification failed, remove unsupported assertions.';

  const repaired = await callAnthropic({
    system: [
      draftingSystemPrompt({ mode: 'draft' }),
      '',
      'SOURCE-LOCKED COMPLIANCE REPAIR MODE:',
      '- Revise the CURRENT DRAFT to remove any unsupported assertions.',
      '- Keep only claims grounded in SOURCE PACKET excerpts.',
      '- If a quote cannot be supported, remove it.',
      '- Do not introduce new authorities or facts.',
      '- Return FULL revised draft only, no commentary.',
      '',
      `SOURCE PACKET (frozen from assistant message ${sourcePacket.id}):`,
      sourceContext,
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          `Objective: ${objective}`,
          `Target filing type: ${targetType}`,
          'CURRENT DRAFT:',
          String(draftText || '').slice(0, 16_000),
          'COMPLIANCE FAILURES TO FIX:',
          failSummary,
        ].join('\n\n'),
      },
    ],
  });

  return sanitizeDraftOutput(repaired, { mode: 'draft' });
}

function autoRenameConversationOnFirstUserMessage(conv, messages, content) {
  const priorUserMsgs = messages.filter((m) => m.conversationId === conv.id && m.role === 'user');
  if (priorUserMsgs.length !== 1) return;
  if (!/^Drafting\s*\d*$/i.test(conv.title)) return;
  const short = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  conv.title = short + (String(content || '').length > 60 ? '…' : '');
}

async function buildDraftPatch(draft, updatedContent) {
  const working = {
    ...draft,
    content: updatedContent,
    updatedAt: new Date().toISOString(),
    meta: { ...(draft.meta || {}) },
  };
  await ensureDraftMeta(working, { force: true });
  working.suggested = computeDraftSuggested(working.meta);
  return {
    id: working.id,
    content: working.content,
    updatedAt: working.updatedAt,
    meta: working.meta,
    suggested: working.suggested,
  };
}

async function persistAssistantResult({ convId, assistantText, mode, applyToDraft, draftPatch, ragPaths, ragSources, baselinePaths, sourcePacket }) {
  return withStateLock(async () => {
    const latest = loadState();
    const conv = latest.conversations.find((c) => c.id === convId);
    if (!conv) return { asstMsg: null, draft: null };

    const sourcePacketRef = persistSourcePacket(sourcePacket)
      || compactSourcePacketRef(sourcePacket)
      || null;

    let draft = null;
    if (draftPatch?.id) {
      draft = latest.drafts.find((d) => d.id === draftPatch.id && d.conversationId === convId) || null;
      if (draft) {
        draft.content = draftPatch.content;
        draft.updatedAt = draftPatch.updatedAt;
        draft.meta = draftPatch.meta;
        draft.suggested = draftPatch.suggested;
      }
    }

    const asstMsg = {
      id: id('msg'),
      conversationId: convId,
      role: 'assistant',
      content: assistantText,
      createdAt: new Date().toISOString(),
      meta: {
        mode,
        draftId: draft ? draft.id : null,
        draftUpdated: Boolean(applyToDraft && draft),
        ragPaths,
        baselinePaths,
        ragSources,
        sourcePacketId: sourcePacketRef?.id || null,
        sourcePacket: sourcePacketRef,
      },
    };

    latest.messages.push(asstMsg);
    conv.updatedAt = new Date().toISOString();
    saveState(latest);
    return { asstMsg, draft };
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${HOST}:${PORT}`);

  // Only allow local requests (defense-in-depth)
  const remote = req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  // API routes
  if (reqUrl.pathname.startsWith('/api/')) {
    const state = loadState();

    // GET /api/state
    if (req.method === 'GET' && reqUrl.pathname === '/api/state') {
      return sendJson(res, 200, {
        conversations: state.conversations,
        drafts: state.drafts,
      });
    }

    // GET /api/forms/local?intent=continuance&deadlineText=...
    if (req.method === 'GET' && reqUrl.pathname === '/api/forms/local') {
      const intent = reqUrl.searchParams.get('intent') || '';
      const deadlineText = reqUrl.searchParams.get('deadlineText') || '';
      const forms = getLocalFormsCatalog({ intent, deadlineText });
      return sendJson(res, 200, { ok: true, forms });
    }

    // POST /api/forms/continuance-quick-fill
    if (req.method === 'POST' && reqUrl.pathname === '/api/forms/continuance-quick-fill') {
      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');

      const conversationId = String(body?.conversationId || '').trim();
      if (!conversationId) return badRequest(res, 'Missing conversationId');

      const content = buildContinuanceQuickFillDraft({
        deadline: body?.deadline || null,
        reason: body?.reason || '',
        currentSettingDate: body?.currentSettingDate || '',
        requestedNextDate: body?.requestedNextDate || '',
        opposingCounselPosition: body?.opposingCounselPosition || '',
      });

      const nowIso = new Date().toISOString();
      const draft = {
        id: id('draft'),
        conversationId,
        title: 'WAKE-CVD-02 Continuance Motion',
        content,
        createdAt: nowIso,
        updatedAt: nowIso,
        saved: null,
        meta: {
          date: normalizeDate(),
          idxNum: null,
          docType: 'MOT',
          party: 'DEF',
          description: 'Motion-to-Continue-WAKE-CVD-02',
          localFormId: 'wake-cvd-02',
          localFormPath: '07_Research/local_rules/forms/WAKE-CVD-02-Motion-Order-to-Continue.pdf',
          localFormQuickFill: true,
          localFormGeneratedAt: nowIso,
        },
        suggested: null,
      };
      draft.suggested = computeDraftSuggested(draft.meta);

      const persisted = await withStateLock(async () => {
        const latest = loadState();
        const conv = latest.conversations.find((c) => c.id === conversationId);
        if (!conv) return null;
        latest.drafts.unshift(draft);
        conv.updatedAt = new Date().toISOString();
        saveState(latest);
        return draft;
      });

      if (!persisted) return badRequest(res, 'Invalid conversationId');
      return sendJson(res, 200, {
        ok: true,
        draft: persisted,
        form: getLocalFormsCatalog({ intent: 'continuance' }).find((f) => f.id === 'wake-cvd-02') || null,
      });
    }

    // POST /api/attachments  { filename, contentType, data (base64), conversationId? }
    if (req.method === 'POST' && reqUrl.pathname === '/api/attachments') {
      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');
      const filename = String(body?.filename || '').trim();
      const contentType = String(body?.contentType || 'application/octet-stream').trim();
      const dataBase64 = String(body?.data || '');
      const conversationId = String(body?.conversationId || '').trim() || null;
      if (!filename || !dataBase64) return badRequest(res, 'filename and data (base64) required');
      try {
        const meta = saveAttachment({ filename, contentType, dataBase64, conversationId });
        return sendJson(res, 200, { ok: true, attachment: meta });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // GET /api/attachments/:id
    const attMatch = reqUrl.pathname.match(/^\/api\/attachments\/([^/]+)$/);
    if (req.method === 'GET' && attMatch) {
      const meta = loadAttachment(attMatch[1]);
      if (!meta) return notFound(res);
      return sendJson(res, 200, { ok: true, attachment: meta });
    }

    // POST /api/conversations
    if (req.method === 'POST' && reqUrl.pathname === '/api/conversations') {
      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');

      const conv = {
        id: id('conv'),
        title: safeBasename(body?.title, 'Conversation').replace(/-/g, ' '),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await withStateLock(async () => {
        const latest = loadState();
        latest.conversations.unshift(conv);
        saveState(latest);
      });
      return sendJson(res, 200, { conversation: conv });
    }

    // PATCH /api/conversations/:id  { title }
    const convPatchMatch = reqUrl.pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (req.method === 'PATCH' && convPatchMatch) {
      const convId = convPatchMatch[1];
      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');

      const title = String(body?.title || '').trim();
      if (!title) return badRequest(res, 'Missing title');

      const updated = await withStateLock(async () => {
        const latest = loadState();
        const conv = latest.conversations.find((c) => c.id === convId);
        if (!conv) return null;
        conv.title = safeBasename(title, conv.title).replace(/-/g, ' ');
        conv.updatedAt = new Date().toISOString();
        saveState(latest);
        return conv;
      });

      if (!updated) return notFound(res);
      return sendJson(res, 200, { conversation: updated });
    }

    // DELETE /api/conversations/:id
    const convDelMatch = reqUrl.pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (req.method === 'DELETE' && convDelMatch) {
      const convId = convDelMatch[1];
      const ok = await withStateLock(async () => {
        const latest = loadState();
        const before = latest.conversations.length;
        latest.conversations = latest.conversations.filter((c) => c.id !== convId);
        if (latest.conversations.length === before) return false;

        // Delete associated messages + drafts.
        latest.messages = (latest.messages || []).filter((m) => m.conversationId !== convId);
        latest.drafts = (latest.drafts || []).filter((d) => d.conversationId !== convId);
        saveState(latest);
        return true;
      });
      if (!ok) return notFound(res);
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/conversations/:id
    const convMatch = reqUrl.pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (req.method === 'GET' && convMatch) {
      const convId = convMatch[1];
      const conv = state.conversations.find((c) => c.id === convId);
      if (!conv) return notFound(res);
      const messages = state.messages.filter((m) => m.conversationId === convId);
      const drafts = state.drafts.filter((d) => d.conversationId === convId);
      return sendJson(res, 200, { conversation: conv, messages, drafts });
    }

    // DELETE /api/conversations/:id/messages
    const convMsgsDelMatch = reqUrl.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (req.method === 'DELETE' && convMsgsDelMatch) {
      const convId = convMsgsDelMatch[1];
      const result = await withStateLock(async () => {
        const latest = loadState();
        const conv = latest.conversations.find((c) => c.id === convId);
        if (!conv) return { found: false, cleared: 0 };
        const before = latest.messages.length;
        latest.messages = latest.messages.filter((m) => m.conversationId !== convId);
        const cleared = before - latest.messages.length;
        conv.updatedAt = new Date().toISOString();
        saveState(latest);
        return { found: true, cleared };
      });

      if (!result.found) return notFound(res);
      return sendJson(res, 200, { ok: true, cleared: result.cleared });
    }

    // POST /api/conversations/:id/messages/stream
    const msgStreamMatch = reqUrl.pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/stream$/);
    if (req.method === 'POST' && msgStreamMatch) {
      const convId = msgStreamMatch[1];

      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');

      const content = String(body?.content || '').trim();
      if (!content) return badRequest(res, 'Missing content');

      const mode = body?.mode === 'oral' ? 'oral' : 'draft';
      const useAI = body?.useAI !== false;
      const applyToDraft = body?.applyToDraft === true && isExplicitDraftUpdateRequest(content);
      const draftId = applyToDraft ? String(body?.draftId || '').trim() : '';
      const respondingToIdx = String(body?.respondingToIdx || '').trim().toUpperCase() || '';
      const attachmentIds = Array.isArray(body?.attachmentIds)
        ? body.attachmentIds.map((a) => String(a).trim()).filter(Boolean)
        : [];

      const prep = await withStateLock(async () => {
        const latest = loadState();
        const conv = latest.conversations.find((c) => c.id === convId);
        if (!conv) return { notFound: true };

        const draft = applyToDraft
          ? latest.drafts.find((d) => d.id === draftId && d.conversationId === convId) || null
          : null;

        const attachmentMetas = attachmentIds.map((aid) => loadAttachment(aid)).filter(Boolean);

        const userMsg = {
          id: id('msg'),
          conversationId: convId,
          role: 'user',
          content,
          createdAt: new Date().toISOString(),
          meta: attachmentMetas.length
            ? { attachments: attachmentMetas.map((a) => ({ id: a.id, filename: a.originalFilename, contentType: a.contentType, isImage: a.isImage })) }
            : undefined,
        };
        latest.messages.push(userMsg);
        autoRenameConversationOnFirstUserMessage(conv, latest.messages, content);
        conv.updatedAt = new Date().toISOString();
        saveState(latest);

        // Build history — inject attachment content blocks for messages that have them
        const rawHistory = latest.messages
          .filter((m) => m.conversationId === convId)
          .slice(-20);
        const history = rawHistory.map((m) => {
          const msgAttIds = m.meta?.attachments?.map((a) => a.id) || [];
          if (m.role === 'user' && msgAttIds.length) {
            const attBlocks = buildAttachmentContentBlocks(msgAttIds);
            return { role: m.role, content: [...attBlocks, { type: 'text', text: m.content }] };
          }
          return { role: m.role, content: m.content };
        });

        return {
          userMsg,
          history,
          draftSnapshot: draft
            ? {
                ...draft,
                meta: { ...(draft.meta || {}) },
                suggested: draft.suggested ? { ...draft.suggested } : null,
              }
            : null,
        };
      });
      if (prep.notFound) return notFound(res);

      res.writeHead(200, securityHeaders({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      }));

      let aborted = false;
      req.on('close', () => { aborted = true; });

      const sendEvent = (event, data) => {
        if (aborted) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent('user', prep.userMsg);
      sendEvent('assistant_start', { ok: true });

      let assistantText = '';
      let aiError = null;
      let ragPaths = [];
      let ragSources = [];
      let baselinePaths = [];
      let sourcePacket = null;
      let draftPatch = null;

      if (useAI) {
        try {
          const localCtx = buildSystemPromptWithContext({ mode, query: content });
          ragPaths = localCtx.ragPaths;
          ragSources = localCtx.ragSources;
          baselinePaths = localCtx.baselinePaths;
          sourcePacket = localCtx.sourcePacket;

          // Inject filing context when responding to a specific filing
          if (respondingToIdx) {
            const fCtx = getFilingContext(respondingToIdx);
            if (fCtx) {
              const block = buildFilingContextBlock(fCtx);
              if (block) localCtx.system = localCtx.system + '\n\n' + block;
            }
          }

          if (applyToDraft && prep.draftSnapshot) {
            const updatedDraft = await callAnthropicStream({
              system: localCtx.system,
              messages: [
                {
                  role: 'user',
                  content: [
                    'Apply the change request to the CURRENT DRAFT. Return the FULL updated draft (no commentary).',
                    '',
                    'CHANGE REQUEST:',
                    content,
                    '',
                    'CURRENT DRAFT:',
                    prep.draftSnapshot.content,
                  ].join('\n'),
                },
              ],
              onTextDelta: () => {},
              shouldAbort: () => aborted,
            });

            const sanitizedUpdated = sanitizeDraftOutput(updatedDraft, { mode });
            draftPatch = await buildDraftPatch(prep.draftSnapshot, sanitizedUpdated);
            assistantText = `Draft updated: **${prep.draftSnapshot.title}**\n\nOpen the draft panel to review changes.`;
            sendEvent('delta', { text: assistantText });
          } else {
            const streamingSanitizer = createStreamingDraftSanitizer({
              mode,
              onDelta: (t) => sendEvent('delta', { text: t }),
            });
            await callAnthropicStream({
              system: localCtx.system,
              messages: prep.history,
              onTextDelta: (t) => streamingSanitizer.push(t),
              shouldAbort: () => aborted,
            });
            assistantText = streamingSanitizer.finish();
          }
        } catch (err) {
          aiError = { message: err.message, code: err.code || null, httpStatus: err.httpStatus || null };
          assistantText =
            err.code === 'NO_API_KEY'
              ? 'ERROR: Missing ANTHROPIC_API_KEY in environment. Start the server with ANTHROPIC_API_KEY set.'
              : `ERROR: ${err.message}`;
          sendEvent('delta', { text: assistantText });
        }
      } else {
        assistantText = 'AI disabled for this message (useAI=false).';
        sendEvent('delta', { text: assistantText });
      }

      const persisted = await persistAssistantResult({
        convId,
        assistantText,
        mode,
        applyToDraft,
        draftPatch,
        ragPaths,
        ragSources,
        baselinePaths,
        sourcePacket,
      });
      const asstMsg = persisted.asstMsg || {
        id: id('msg'),
        conversationId: convId,
        role: 'assistant',
        content: assistantText,
        createdAt: new Date().toISOString(),
        meta: {
          mode,
          draftId: draftPatch?.id || null,
          draftUpdated: Boolean(applyToDraft && draftPatch),
          ragPaths,
          baselinePaths,
          ragSources,
          sourcePacketId: sourcePacket?.id || null,
          sourcePacket: compactSourcePacketRef(sourcePacket),
        },
      };

      sendEvent('done', { assistant: asstMsg, aiError, draft: persisted.draft || null });
      res.end();
      return;
    }

    const msgMatch = reqUrl.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (req.method === 'POST' && msgMatch) {
      const convId = msgMatch[1];

      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');

      const content = String(body?.content || '').trim();
      if (!content) return badRequest(res, 'Missing content');

      const mode = body?.mode === 'oral' ? 'oral' : 'draft';
      const useAI = body?.useAI !== false;
      const applyToDraft = body?.applyToDraft === true && isExplicitDraftUpdateRequest(content);
      const draftId = applyToDraft ? String(body?.draftId || '').trim() : '';
      const respondingToIdx = String(body?.respondingToIdx || '').trim().toUpperCase() || '';
      const attachmentIds = Array.isArray(body?.attachmentIds)
        ? body.attachmentIds.map((a) => String(a).trim()).filter(Boolean)
        : [];

      const prep = await withStateLock(async () => {
        const latest = loadState();
        const conv = latest.conversations.find((c) => c.id === convId);
        if (!conv) return { notFound: true };

        const draft = applyToDraft
          ? latest.drafts.find((d) => d.id === draftId && d.conversationId === convId) || null
          : null;

        const attachmentMetas = attachmentIds.map((aid) => loadAttachment(aid)).filter(Boolean);

        const userMsg = {
          id: id('msg'),
          conversationId: convId,
          role: 'user',
          content,
          createdAt: new Date().toISOString(),
          meta: attachmentMetas.length
            ? { attachments: attachmentMetas.map((a) => ({ id: a.id, filename: a.originalFilename, contentType: a.contentType, isImage: a.isImage })) }
            : undefined,
        };
        latest.messages.push(userMsg);
        autoRenameConversationOnFirstUserMessage(conv, latest.messages, content);
        conv.updatedAt = new Date().toISOString();
        saveState(latest);

        const rawHistory = latest.messages
          .filter((m) => m.conversationId === convId)
          .slice(-20);
        const history = rawHistory.map((m) => {
          const msgAttIds = m.meta?.attachments?.map((a) => a.id) || [];
          if (m.role === 'user' && msgAttIds.length) {
            const attBlocks = buildAttachmentContentBlocks(msgAttIds);
            return { role: m.role, content: [...attBlocks, { type: 'text', text: m.content }] };
          }
          return { role: m.role, content: m.content };
        });

        return {
          userMsg,
          history,
          draftSnapshot: draft
            ? {
                ...draft,
                meta: { ...(draft.meta || {}) },
                suggested: draft.suggested ? { ...draft.suggested } : null,
              }
            : null,
        };
      });
      if (prep.notFound) return notFound(res);

      let assistantText = '';
      let aiError = null;
      let ragPaths = [];
      let ragSources = [];
      let baselinePaths = [];
      let sourcePacket = null;
      let draftPatch = null;

      if (useAI) {
        try {
          const localCtx = buildSystemPromptWithContext({ mode, query: content });
          ragPaths = localCtx.ragPaths;
          ragSources = localCtx.ragSources;
          baselinePaths = localCtx.baselinePaths;
          sourcePacket = localCtx.sourcePacket;

          // Inject filing context when responding to a specific filing
          if (respondingToIdx) {
            const fCtx = getFilingContext(respondingToIdx);
            if (fCtx) {
              const block = buildFilingContextBlock(fCtx);
              if (block) localCtx.system = localCtx.system + '\n\n' + block;
            }
          }

          if (applyToDraft && prep.draftSnapshot) {
            const updatedDraft = await callAnthropic({
              system: localCtx.system,
              messages: [
                {
                  role: 'user',
                  content: [
                    'Apply the change request to the CURRENT DRAFT. Return the FULL updated draft (no commentary).',
                    '',
                    'CHANGE REQUEST:',
                    content,
                    '',
                    'CURRENT DRAFT:',
                    prep.draftSnapshot.content,
                  ].join('\n'),
                },
              ],
            });

            const sanitizedUpdated = sanitizeDraftOutput(updatedDraft, { mode });
            draftPatch = await buildDraftPatch(prep.draftSnapshot, sanitizedUpdated);
            assistantText = `Draft updated: ${prep.draftSnapshot.title}`;
          } else {
            assistantText = await callAnthropic({
              system: localCtx.system,
              messages: prep.history,
            });
            assistantText = sanitizeDraftOutput(assistantText, { mode });
          }
        } catch (err) {
          aiError = { message: err.message, code: err.code || null, httpStatus: err.httpStatus || null };
          assistantText =
            err.code === 'NO_API_KEY'
              ? 'ERROR: Missing ANTHROPIC_API_KEY in environment. Start the server with ANTHROPIC_API_KEY set.'
              : `ERROR: ${err.message}`;
        }
      } else {
        assistantText = 'AI disabled for this message (useAI=false).';
      }

      const persisted = await persistAssistantResult({
        convId,
        assistantText,
        mode,
        applyToDraft,
        draftPatch,
        ragPaths,
        ragSources,
        baselinePaths,
        sourcePacket,
      });
      const asstMsg = persisted.asstMsg || {
        id: id('msg'),
        conversationId: convId,
        role: 'assistant',
        content: assistantText,
        createdAt: new Date().toISOString(),
        meta: {
          mode,
          draftId: draftPatch?.id || null,
          draftUpdated: Boolean(applyToDraft && draftPatch),
          ragPaths,
          baselinePaths,
          ragSources,
          sourcePacketId: sourcePacket?.id || null,
          sourcePacket: compactSourcePacketRef(sourcePacket),
        },
      };

      return sendJson(res, 200, { user: prep.userMsg, assistant: asstMsg, aiError, draft: persisted.draft || null });
    }

    // POST /api/messages/:id/draft-from-sources { objective?, targetType?, applyToDraftId? }
    const sourceDraftMatch = reqUrl.pathname.match(/^\/api\/messages\/([^/]+)\/draft-from-sources$/);
    if (req.method === 'POST' && sourceDraftMatch) {
      const messageId = sourceDraftMatch[1];
      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');

      const objective = String(body?.objective || '').trim()
        || 'Draft the cleanest, most likely-to-be-granted filing supported by the cited source documents.';
      const targetType = normalizeSourceDraftDocType(body?.targetType);
      const applyToDraftId = String(body?.applyToDraftId || '').trim();

      const prep = await withStateLock(async () => {
        const latest = loadState();
        const msg = latest.messages.find((m) => m.id === messageId && m.role === 'assistant');
        if (!msg) return { notFound: true };

        const conv = latest.conversations.find((c) => c.id === msg.conversationId);
        if (!conv) return { notFound: true };

        const sourcePacket = resolveSourcePacketFromMeta(msg.meta || {});
        if (!sourcePacket || !Array.isArray(sourcePacket.sources) || !sourcePacket.sources.length) {
          return { missingPacket: true };
        }

        const draft = applyToDraftId
          ? latest.drafts.find((d) => d.id === applyToDraftId && d.conversationId === msg.conversationId) || null
          : null;
        if (applyToDraftId && !draft) return { draftNotFound: true };

        return {
          conversationId: msg.conversationId,
          sourcePacket: {
            ...sourcePacket,
            sources: sourcePacket.sources.map((s) => ({ ...s })),
          },
          draftSnapshot: draft
            ? {
                ...draft,
                meta: { ...(draft.meta || {}) },
                suggested: draft.suggested ? { ...draft.suggested } : null,
              }
            : null,
        };
      });

      if (prep.notFound) return notFound(res);
      if (prep.missingPacket) return badRequest(res, 'Selected message has no frozen source packet');
      if (prep.draftNotFound) return notFound(res);

      let generated;
      try {
        generated = await buildSourceLockedDraft({
          sourcePacket: prep.sourcePacket,
          objective,
          targetType,
          existingDraftContent: prep.draftSnapshot?.content || '',
        });
      } catch (err) {
        return sendJson(res, 500, { error: err.message, code: err.code || null, httpStatus: err.httpStatus || null });
      }

      let verification;
      try {
        verification = await verifySourceLockedDraft({
          sourcePacket: prep.sourcePacket,
          objective,
          targetType,
          draftText: generated.draftText,
        });
      } catch (err) {
        return sendJson(res, 500, { error: err.message, code: err.code || null, httpStatus: err.httpStatus || null });
      }

      for (let attempt = 0; attempt < 2 && !verification.ok; attempt++) {
        try {
          generated.draftText = await repairSourceLockedDraft({
            sourcePacket: prep.sourcePacket,
            objective,
            targetType,
            draftText: generated.draftText,
            verification,
          });
          verification = await verifySourceLockedDraft({
            sourcePacket: prep.sourcePacket,
            objective,
            targetType,
            draftText: generated.draftText,
          });
        } catch (err) {
          return sendJson(res, 500, { error: err.message, code: err.code || null, httpStatus: err.httpStatus || null });
        }
      }

      if (!verification.ok) {
        return unprocessable(res, 'Source-locked verification failed', {
          missingQuotes: verification.missingQuotes,
          unsupported: verification.unsupported,
          verifierSummary: verification.verifierSummary,
        });
      }

      const sourceMeta = {
        sourcePacketId: prep.sourcePacket.id,
        sourceCount: prep.sourcePacket.sources.length,
        sourcePaths: prep.sourcePacket.sources.map((s) => s.path),
        sourceHashes: prep.sourcePacket.sources.map((s) => s.sourceHash || null).filter(Boolean),
        strategyGate: summarizeStrategyGate(generated.strategyGate),
        sourceVerifier: verification.verifierSummary,
        sourceVerificationAt: new Date().toISOString(),
      };

      let draftToCreate = null;
      let draftPatch = null;

      if (prep.draftSnapshot) {
        draftPatch = await buildDraftPatch(prep.draftSnapshot, generated.draftText);
        draftPatch.meta = {
          ...(draftPatch.meta || {}),
          docType: targetType,
          party: String(draftPatch.meta?.party || 'DEF').trim().toUpperCase() || 'DEF',
          description: safeBasename(draftPatch.meta?.description || 'Source-Locked-Draft', 'Source-Locked-Draft').split('-').slice(0, 5).join('-'),
          ...sourceMeta,
        };
        draftPatch.suggested = computeDraftSuggested(draftPatch.meta);
      } else {
        const nowIso = new Date().toISOString();
        draftToCreate = {
          id: id('draft'),
          conversationId: prep.conversationId,
          title: safeBasename(deriveDraftTitle(generated.draftText), 'Source-Locked-Draft').replace(/-/g, ' '),
          content: generated.draftText,
          createdAt: nowIso,
          updatedAt: nowIso,
          saved: null,
          meta: {
            date: normalizeDate(),
            idxNum: null,
            docType: targetType,
            party: 'DEF',
            description: 'Source-Locked-Draft',
            ...sourceMeta,
          },
          suggested: null,
        };
        draftToCreate.suggested = computeDraftSuggested(draftToCreate.meta);
      }

      const persisted = await withStateLock(async () => {
        const latest = loadState();
        const conv = latest.conversations.find((c) => c.id === prep.conversationId);
        if (!conv) return null;

        if (draftPatch) {
          const draft = latest.drafts.find((d) => d.id === draftPatch.id && d.conversationId === prep.conversationId);
          if (!draft) return null;
          draft.content = draftPatch.content;
          draft.updatedAt = draftPatch.updatedAt;
          draft.meta = draftPatch.meta;
          draft.suggested = draftPatch.suggested;
          conv.updatedAt = new Date().toISOString();
          saveState(latest);
          return draft;
        }

        latest.drafts.unshift(draftToCreate);
        conv.updatedAt = new Date().toISOString();
        saveState(latest);
        return draftToCreate;
      });

      if (!persisted) return notFound(res);
      return sendJson(res, 200, {
        draft: persisted,
        sourcePacketId: prep.sourcePacket.id,
        sourceCount: prep.sourcePacket.sources.length,
        strategyGate: sourceMeta.strategyGate,
      });
    }

    // POST /api/drafts  { conversationId, title?, content, meta? }
    if (req.method === 'POST' && reqUrl.pathname === '/api/drafts') {
      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');

      const conversationId = String(body?.conversationId || '').trim();
      const content = String(body?.content || '').trim();
      if (!conversationId) return badRequest(res, 'Missing conversationId');
      if (!content) return badRequest(res, 'Missing content');

      const derivedTitle = deriveDraftTitle(content);

      const draft = {
        id: id('draft'),
        conversationId,
        title: safeBasename(body?.title || derivedTitle, 'Draft').replace(/-/g, ' '),
        content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        saved: null,
        meta: body?.meta && typeof body.meta === 'object' ? body.meta : {},
        suggested: null,
      };

      await ensureDraftMeta(draft);
      draft.suggested = computeDraftSuggested(draft.meta);
      const persisted = await withStateLock(async () => {
        const latest = loadState();
        const conv = latest.conversations.find((c) => c.id === conversationId);
        if (!conv) return null;
        latest.drafts.unshift(draft);
        conv.updatedAt = new Date().toISOString();
        saveState(latest);
        return draft;
      });
      if (!persisted) return badRequest(res, 'Invalid conversationId');
      return sendJson(res, 200, { draft: persisted });
    }

    // PATCH /api/drafts/:id
    const draftMatch = reqUrl.pathname.match(/^\/api\/drafts\/([^/]+)$/);
    if (req.method === 'PATCH' && draftMatch) {
      const draftId = draftMatch[1];
      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');

      const draftSnapshot = await withStateLock(async () => {
        const latest = loadState();
        const draft = latest.drafts.find((d) => d.id === draftId);
        if (!draft) return null;
        return {
          ...draft,
          meta: { ...(draft.meta || {}) },
          suggested: draft.suggested ? { ...draft.suggested } : null,
        };
      });
      if (!draftSnapshot) return notFound(res);

      if (body?.title) draftSnapshot.title = safeBasename(body.title, draftSnapshot.title);
      if (Object.prototype.hasOwnProperty.call(body || {}, 'content')) {
        draftSnapshot.content = String(body.content ?? '');
      }
      draftSnapshot.updatedAt = new Date().toISOString();

      if (body?.meta && typeof body.meta === 'object') {
        draftSnapshot.meta = { ...(draftSnapshot.meta || {}), ...body.meta };
      }
      await ensureDraftMeta(draftSnapshot);
      draftSnapshot.suggested = computeDraftSuggested(draftSnapshot.meta);

      const persisted = await withStateLock(async () => {
        const latest = loadState();
        const draft = latest.drafts.find((d) => d.id === draftId);
        if (!draft) return null;

        draft.title = draftSnapshot.title;
        draft.content = draftSnapshot.content;
        draft.updatedAt = draftSnapshot.updatedAt;
        draft.meta = draftSnapshot.meta;
        draft.suggested = draftSnapshot.suggested;
        saveState(latest);
        return draft;
      });
      if (!persisted) return notFound(res);
      return sendJson(res, 200, { draft: persisted });
    }

    // DELETE /api/drafts/:id
    if (req.method === 'DELETE' && draftMatch) {
      const draftId = draftMatch[1];
      const removed = await withStateLock(async () => {
        const latest = loadState();
        const idx = latest.drafts.findIndex((d) => d.id === draftId);
        if (idx === -1) return null;

        const [draft] = latest.drafts.splice(idx, 1);
        const conv = latest.conversations.find((c) => c.id === draft.conversationId);
        if (conv) conv.updatedAt = new Date().toISOString();
        saveState(latest);
        return draft;
      });

      if (!removed) return notFound(res);
      return sendJson(res, 200, { ok: true, draftId: removed.id });
    }

    // POST /api/drafts/:id/regenerate  { instructions }
    const regenMatch = reqUrl.pathname.match(/^\/api\/drafts\/([^/]+)\/regenerate$/);
    if (req.method === 'POST' && regenMatch) {
      const draftId = regenMatch[1];
      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');

      const instructions = String(body?.instructions || '').trim();
      if (!instructions) return badRequest(res, 'Missing instructions');

      const mode = body?.mode === 'oral' ? 'oral' : 'draft';

      const draftSnapshot = await withStateLock(async () => {
        const latest = loadState();
        const draft = latest.drafts.find((d) => d.id === draftId);
        if (!draft) return null;
        return {
          ...draft,
          meta: { ...(draft.meta || {}) },
          suggested: draft.suggested ? { ...draft.suggested } : null,
        };
      });
      if (!draftSnapshot) return notFound(res);

      let updated = '';
      try {
        const localCtx = buildSystemPromptWithContext({
          mode,
          query: [instructions, draftSnapshot.title, draftSnapshot.content.slice(0, 1500)].join('\n'),
        });
        updated = await callAnthropic({
          system: localCtx.system,
          messages: [
            {
              role: 'user',
              content: [
                'Update the draft below based on the instructions. Return the FULL updated draft.',
                '',
                'INSTRUCTIONS:',
                instructions,
                '',
                'CURRENT DRAFT:',
                draftSnapshot.content,
              ].join('\n'),
            },
          ],
        });
      } catch (err) {
        return sendJson(res, 500, { error: err.message, code: err.code || null, httpStatus: err.httpStatus || null });
      }

      const draftPatch = await buildDraftPatch(draftSnapshot, sanitizeDraftOutput(updated, { mode }));
      const persisted = await withStateLock(async () => {
        const latest = loadState();
        const latestDraft = latest.drafts.find((d) => d.id === draftId);
        if (!latestDraft) return null;

        latestDraft.content = draftPatch.content;
        latestDraft.updatedAt = draftPatch.updatedAt;
        latestDraft.meta = draftPatch.meta;
        latestDraft.suggested = draftPatch.suggested;
        saveState(latest);
        return latestDraft;
      });

      if (!persisted) return notFound(res);
      return sendJson(res, 200, { draft: persisted });
    }

    // POST /api/drafts/:id/save  { date?, idxNum?, docType?, party?, description? }
    const saveMatch = reqUrl.pathname.match(/^\/api\/drafts\/([^/]+)\/save$/);
    if (req.method === 'POST' && saveMatch) {
      const draftId = saveMatch[1];
      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');

      const draftSnapshot = await withStateLock(async () => {
        const latest = loadState();
        const draft = latest.drafts.find((d) => d.id === draftId);
        if (!draft) return null;
        return {
          ...draft,
          meta: { ...(draft.meta || {}) },
          suggested: draft.suggested ? { ...draft.suggested } : null,
        };
      });
      if (!draftSnapshot) return notFound(res);

      // Start from existing inferred meta, then override with any provided fields.
      await ensureDraftMeta(draftSnapshot);

      const date = normalizeDate(body?.date || draftSnapshot.meta?.date);
      const rawIdxNum = body?.idxNum !== undefined && body?.idxNum !== null && String(body.idxNum).trim() !== ''
        ? body.idxNum
        : draftSnapshot.meta?.idxNum;
      const parsedIdxNum = Number(rawIdxNum);
      const idxNum = Number.isFinite(parsedIdxNum) && parsedIdxNum > 0
        ? Math.trunc(parsedIdxNum)
        : null;

      const docType = String(body?.docType || draftSnapshot.meta?.docType || '').trim().toUpperCase() || inferDocTypeFromText(draftSnapshot.content);
      const party = String(body?.party || draftSnapshot.meta?.party || '').trim().toUpperCase() || inferPartyFromText(draftSnapshot.content);
      const description = String(body?.description || draftSnapshot.meta?.description || '').trim() || draftSnapshot.title;

      const ext = 'md';
      const filename = buildFilename({ date, idxNum, docType, party, description, ext });
      const folder = routeToFolder(docType, party);
      const absPath = path.join(folder, filename);

      const saved = { path: absPath.replace(PROJECT_ROOT + path.sep, ''), filename };
      const updatedAt = new Date().toISOString();
      const sourcePacket = resolveSourcePacketFromMeta(draftSnapshot.meta || {});
      const meta = {
        ...(draftSnapshot.meta || {}),
        date,
        idxNum,
        docType,
        party,
        description: safeBasename(description, 'Draft').split('-').slice(0, 5).join('-'),
      };
      delete meta.sourcePacket;
      const suggested = computeDraftSuggested(meta);

      const persisted = await withStateLock(async () => {
        const latest = loadState();
        const draft = latest.drafts.find((d) => d.id === draftId);
        if (!draft) return null;

        ensureDir(folder);
        archiveIfExists(absPath);
        fs.writeFileSync(absPath, draftSnapshot.content, 'utf8');

        const auditPath = writeSourceAuditForSavedDraft(absPath, {
          draftId,
          conversationId: draft.conversationId,
          meta,
          sourcePacket,
        });

        draft.saved = auditPath ? { ...saved, sourceAuditPath: auditPath } : saved;
        draft.updatedAt = updatedAt;
        draft.meta = meta;
        draft.suggested = suggested;
        saveState(latest);
        return draft;
      });

      if (!persisted) return notFound(res);
      return sendJson(res, 200, { draft: persisted });
    }

    // POST /api/drafts/:id/export-docx { content? }
    const exportDocxMatch = reqUrl.pathname.match(/^\/api\/drafts\/([^/]+)\/export-docx$/);
    if (req.method === 'POST' && exportDocxMatch) {
      const draftId = exportDocxMatch[1];
      const body = await readBodyJson(req);
      if (body?.__parseError) return badRequest(res, 'Invalid JSON');

      const draftSnapshot = await withStateLock(async () => {
        const latest = loadState();
        const draft = latest.drafts.find((d) => d.id === draftId);
        if (!draft) return null;
        return {
          ...draft,
          meta: { ...(draft.meta || {}) },
          suggested: draft.suggested ? { ...draft.suggested } : null,
        };
      });
      if (!draftSnapshot) return notFound(res);

      const content = String(body?.content || draftSnapshot.content || '').trim();
      if (!content) return badRequest(res, 'Draft is empty');

      await ensureDraftMeta(draftSnapshot);
      const suggested = computeDraftSuggested(draftSnapshot.meta);
      const mdFilename = draftSnapshot.saved?.filename || suggested?.filename || `${safeBasename(draftSnapshot.title, 'Draft')}.md`;
      const filename = mdFilename.replace(/\.md$/i, '.docx');

      try {
        const exported = await exportMarkdownToDocx(content);
        res.writeHead(200, securityHeaders({
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Length': exported.buffer.length,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'X-Reference-Docx': 'used',
          'Cache-Control': 'no-store',
        }));
        return res.end(exported.buffer);
      } catch (err) {
        return sendJson(res, 500, { error: `DOCX export failed: ${err.message}` });
      }
    }

    // GET /api/config (safe: no secrets)
    if (req.method === 'GET' && reqUrl.pathname === '/api/config') {
      const model = getAnthropicModel();
      const maxTokens = getAnthropicMaxTokens();
      const thinkingCfg = resolveAnthropicThinking({ model, maxTokens });
      return sendJson(res, 200, {
        ok: true,
        envLoadedFrom: ENV_LOADED_FROM,
        anthropic: {
          hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
          model,
          maxTokens,
          thinking: {
            requestedMode: thinkingCfg.requestedMode,
            effectiveMode: thinkingCfg.effectiveMode,
            effort: thinkingCfg.effort,
            requestedEffort: thinkingCfg.requestedEffort,
            budgetTokens: thinkingCfg.budgetTokens,
            supportsAdaptive: thinkingCfg.supportsAdaptive,
            supportsManual: thinkingCfg.supportsManual,
          },
        },
      });
    }

    // GET /api/case/config — public-safe subset of case config for frontend
    if (req.method === 'GET' && reqUrl.pathname === '/api/case/config') {
      const ci = cfg.caseInfo();
      const d = cfg.defendant();
      const p = cfg.plaintiff();
      return sendJson(res, 200, {
        number: ci.number || '',
        court: ci.court || '',
        county: (ci.county || '').toUpperCase(),
        state: (ci.state || '').toUpperCase(),
        stateShort: ci.stateShort || '',
        courtSystem: (ci.courtSystem || '').toUpperCase(),
        division: (ci.division || '').toUpperCase(),
        titleShort: cfg.caseTitleShort(),
        defendantName: d.name || '',
        defendantNameUpper: d.nameUpper || (d.name || '').toUpperCase(),
        plaintiffCurrent: p.current || p.original || '',
        appTitle: cfg.appTitle(),
      });
    }

    // GET /api/case/summary
    if (req.method === 'GET' && reqUrl.pathname === '/api/case/summary') {
      return sendJson(res, 200, getCaseSummary());
    }

    // GET /api/case/intelligence
    if (req.method === 'GET' && reqUrl.pathname === '/api/case/intelligence') {
      const intel = getDocketIntelligence();
      if (!intel) return sendJson(res, 200, { ok: false, reason: 'No filing outcomes data available' });
      return sendJson(res, 200, { ok: true, ...intel, formatted: formatIntelligenceBlock(intel) });
    }

    // GET /api/case/deadlines
    if (req.method === 'GET' && reqUrl.pathname === '/api/case/deadlines') {
      if (!Database || !fs.existsSync(CASE_DB_PATH)) {
        return sendJson(res, 200, { ok: false, reason: 'Database not available' });
      }
      const db = new Database(CASE_DB_PATH, { readonly: true });
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deadlines'").all();
        if (!tables.length) return sendJson(res, 200, { ok: true, deadlines: [] });
        const rows = db.prepare("SELECT * FROM deadlines WHERE case_id = 1 AND status NOT IN ('moot', 'resolved', 'dismissed') ORDER BY due_date").all();
        const today = new Date().toISOString().slice(0, 10);
        const deadlines = rows.map((r) => {
          const daysUntil = Math.ceil((new Date(r.due_date) - new Date(today)) / 86400000);
          let urgency = 'green';
          if (daysUntil < 0) urgency = 'overdue';
          else if (daysUntil <= 3) urgency = 'red';
          else if (daysUntil <= 7) urgency = 'yellow';
          return { ...r, daysUntil, urgency };
        });
        return sendJson(res, 200, { ok: true, deadlines });
      } catch {
        return sendJson(res, 200, { ok: false, reason: 'Error reading deadlines' });
      } finally {
        db.close();
      }
    }

    // POST /api/drafts/:id/redteam
    const redteamMatch = reqUrl.pathname.match(/^\/api\/drafts\/([^/]+)\/redteam$/);
    if (req.method === 'POST' && redteamMatch) {
      const draftId = redteamMatch[1];
      const draftSnapshot = await withStateLock(async () => {
        const latest = loadState();
        const draft = latest.drafts.find((d) => d.id === draftId);
        if (!draft) return null;
        return { ...draft };
      });
      if (!draftSnapshot) return notFound(res);
      if (!draftSnapshot.content?.trim()) return badRequest(res, 'Draft is empty');

      // Build adversarial intelligence context from live docket intelligence.
      let docketContext = '';
      try {
        const intel = getDocketIntelligence();
        if (intel) {
          const pltWins = intel.contested?.plt || {};
          const defWins = intel.contested?.def || {};
          const pltProc = intel.procedural?.plt || {};
          const contestedPending = Array.isArray(intel.contested?.pending) ? intel.contested.pending : [];
          const pendingLines = contestedPending.length
            ? contestedPending.slice(0, 6).map((p) => `- ${p.idx} (${p.filed_by}): ${p.description}`).join('\n')
            : '- None.';

          const modelFilings = Array.isArray(intel.modelFiling) ? intel.modelFiling : [];
          const defWinLines = modelFilings.length
            ? modelFilings.slice(0, 4).map((m) => `- ${m.idx}: ${m.description}${m.what_worked ? ` | worked: ${m.what_worked}` : ''}`).join('\n')
            : '- None.';

          const judgeLines = Object.entries(intel.judges || {})
            .sort((a, b) => (b[1]?.total || 0) - (a[1]?.total || 0))
            .slice(0, 4)
            .map(([name, stats]) => {
              const total = Number(stats?.total || 0);
              const granted = Number(stats?.granted || 0);
              const pct = total > 0 ? Math.round((granted / total) * 100) : 0;
              return `- ${name}: ${granted}/${total} granted (${pct}%). Contested ${stats?.contested || 0}, procedural ${stats?.procedural || 0}.`;
            })
            .join('\n') || '- No judge profile data.';

          const continuances = Array.isArray(intel.procedural?.continuances) ? intel.procedural.continuances : [];
          const pltContinuances = continuances.filter((c) => c.filed_by === 'PLT');
          const pltContinuancesGranted = pltContinuances.filter((c) => c.outcome === 'granted').length;

          docketContext = [
            '',
            `## YOUR INTERNAL CASE INTELLIGENCE (from ${cfg.counsel().firm || 'opposing counsel'} case management system)`,
            '',
            `Defendant contested filings: ${defWins.total || 0} total, ${defWins.granted || 0} granted, ${defWins.denied || 0} denied (${defWins.total ? Math.round((defWins.denied / defWins.total) * 100) : 0}% denial rate).`,
            `Your firm\'s contested filings: ${pltWins.total || 0} total, ${pltWins.granted || 0} granted.`,
            `Your firm\'s procedural filings: ${pltProc.total || 0} total, ${pltProc.granted || 0} granted (continuances, extensions).`,
            `Plaintiff continuances: ${pltContinuances.length} filed, ${pltContinuancesGranted} granted.`,
            '',
            'PENDING CONTESTED MOTIONS (live):',
            pendingLines,
            '',
            'DEF CONTESTED WINS (live):',
            defWinLines,
            '',
            'JUDGE PROFILES (live):',
            judgeLines,
            '',
            'YOUR FIRM\'S ADVANTAGE:',
            '- Defendant is pro se — no attorney. Emotional arguments likely. May miss procedural requirements.',
            '- Your firm has filed in this division hundreds of times. You know the judges, the clerks, the rhythms.',
            '- You have template responses for every standard pro se argument (standing, jurisdiction, SOL, FDCPA).',
            '- Use the pending-motion list and judge profile above as your current risk map.',
          ].join('\n');
        }
      } catch { /* proceed without docket context */ }

      try {
        const rtCfg = { oc: cfg.counsel(), ci: cfg.caseInfo(), d: cfg.defendant(), p: cfg.plaintiff() };
        const rtFirm = rtCfg.oc.firm || 'Opposing Counsel';
        const rtAttorneys = (rtCfg.oc.attorneys || []).map((a) => a.name).join(', ') || 'attorneys';
        const rtCaseLabel = `${(rtCfg.p.current || rtCfg.p.original || 'Plaintiff')} against ${rtCfg.d.name || 'Defendant'} in ${rtCfg.ci.court || 'District Court'}, Case No. ${rtCfg.ci.number || ''}. Amount claimed: ${rtCfg.ci.amount || 'unknown'}.`;

        const systemPrompt = [
            `# ROLE: ${rtFirm.toUpperCase()} LITIGATION TEAM`,
            '',
            `You are the litigation team at ${rtFirm} — a high-volume debt collection law firm handling hundreds of cases simultaneously. Your attorneys on this case are ${rtAttorneys}.`,
            '',
            `You represent ${rtCaseLabel}`,
            '',
            '# HOW YOUR FIRM ACTUALLY WORKS',
            '',
            'Your firm processes cases through an internal legal operations system:',
            '- **Template library**: You have pre-built response templates for every common pro se argument (standing challenges, jurisdictional objections, SOL defenses, debt validation disputes, FDCPA counterclaims).',
            '- **Triage system**: When a filing comes in, a paralegal flags it by threat level. Low-threat = template response. Medium = attorney review + template customization. High = senior attorney drafts custom response.',
            '- **Cost-benefit analysis**: Your firm bills the client. Every hour spent must be justified. You don\'t over-litigate — you find the fastest path to judgment.',
            '- **Pro se playbook**: You\'ve handled thousands of pro se defendants. You know their patterns: emotional arguments, procedural missteps, missed deadlines, citation errors, constitutional arguments in state debt cases.',
            `- **District Court expertise**: You file in ${rtCfg.ci.county || 'this county'} regularly. You know which arguments judges actually read and which they skip.`,
            '',
            '# YOUR TASK',
            '',
            'A new filing from the pro se defendant just landed in your system. Analyze it the way your firm actually would — through the lens of a high-volume litigation operation that needs to decide: How much attention does this deserve? What\'s the most efficient way to neutralize it?',
            docketContext,
            '',
            '# RETURN YOUR ANALYSIS IN THIS EXACT STRUCTURE',
            '',
            '## TRIAGE CLASSIFICATION',
            'Classify this filing: LOW THREAT (template response) / MEDIUM THREAT (customized response) / HIGH THREAT (senior attorney, custom brief). One sentence explaining why.',
            '',
            '## STRONGEST OBJECTION',
            'The single most damaging legal argument you would raise. Cite the specific NC rule or case law you\'d use.',
            '',
            '## PROCEDURAL DEFECTS',
            'Procedural, formatting, timeliness, or service issues you would exploit. Be specific — cite rules.',
            '',
            '## LEGAL WEAKNESSES',
            'Substantive legal weaknesses in the defendant\'s arguments. Where is the law actually against him, regardless of how well he argues it?',
            '',
            '## WHAT CONCERNS YOU',
            'Be honest: what parts of this filing are actually well-done or could cause problems for your client? What would make a senior partner take notice? If nothing — say so.',
            '',
            '## YOUR RESPONSE STRATEGY',
            'Describe exactly how your firm would respond:',
            '- Which template would you start from?',
            '- What custom additions would you make?',
            '- Would you file a response, a motion to strike, or ignore it?',
            '- Estimated attorney time to neutralize this filing.',
            '',
            '## WHAT THE FILING TELEGRAPHS',
            'What does this filing reveal about the defendant\'s strategy? What arguments is he clearly building toward? Identify any arguments that are conspicuously ABSENT — things you\'d expect a competent attorney to raise that aren\'t here. These gaps tell you either: (a) he doesn\'t know about them, or (b) he\'s saving them for oral argument.',
            '',
            '## ORAL ARGUMENT PREP',
            'If this goes to hearing, what would your attorney say in 60 seconds to the judge? Write the actual script.',
            '',
            '## SURPRISE RISK ASSESSMENT',
            'Based on the defendant\'s filing history and this document, what arguments might he deploy AT HEARING that aren\'t in this filing? What could blindside you? What should you prepare for even though it\'s not written here?',
            '',
            '## THREAT SCORE: [X]/10',
            'How threatening is this filing to obtaining judgment for your client? 1 = waste of paper, 10 = case-ending. Explain the score.',
          ].join('\n');

        const analysis = await buildRedTeamAnalysis({
          system: systemPrompt,
          filingText: draftSnapshot.content,
          maxTokens: Number(process.env.REDTEAM_MAX_TOKENS || 4000),
          timeoutMs: Number(process.env.REDTEAM_TIMEOUT_MS || 240000),
        });
        return sendJson(res, 200, { ok: true, analysis });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /api/case/filings
    if (req.method === 'GET' && reqUrl.pathname === '/api/case/filings') {
      return sendJson(res, 200, { ok: true, filings: getFilingsForContext() });
    }

    // GET /api/case/filing-context/:idx
    const fcMatch = reqUrl.pathname.match(/^\/api\/case\/filing-context\/([A-Z0-9]+)$/i);
    if (req.method === 'GET' && fcMatch) {
      const ctx = getFilingContext(fcMatch[1].toUpperCase());
      if (!ctx) return sendJson(res, 200, { ok: false, reason: 'Filing not found' });
      return sendJson(res, 200, { ok: true, ...ctx, contextBlock: buildFilingContextBlock(ctx) });
    }

    // GET /api/case/next-moves
    if (req.method === 'GET' && reqUrl.pathname === '/api/case/next-moves') {
      return sendJson(res, 200, { ok: true, moves: getNextMoves() });
    }

    // ── CASE TOOLS ENDPOINTS ──────────────────────────────────────────────

    // POST /api/drafts/:id/verify-citations
    const citVerifyMatch = reqUrl.pathname.match(/^\/api\/drafts\/([^/]+)\/verify-citations$/);
    if (req.method === 'POST' && citVerifyMatch) {
      const draftId = citVerifyMatch[1];
      const draft = await withStateLock(async () => {
        const s = loadState();
        return s.drafts.find((d) => d.id === draftId) || null;
      });
      if (!draft) return notFound(res);
      if (!draft.content?.trim()) return badRequest(res, 'Draft is empty');
      try {
        const result = await caseTools.verifyCitations(draft.content);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // POST /api/tools/verify-citations (raw text)
    if (req.method === 'POST' && reqUrl.pathname === '/api/tools/verify-citations') {
      const body = await readBodyJson(req);
      if (!body?.text?.trim()) return badRequest(res, 'No text provided');
      try {
        const result = await caseTools.verifyCitations(body.text);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // POST /api/tools/service-calc
    if (req.method === 'POST' && reqUrl.pathname === '/api/tools/service-calc') {
      const body = await readBodyJson(req);
      if (!body?.triggerDate) return badRequest(res, 'triggerDate required');
      const days = Number(body.days || 0);
      const result = caseTools.calculateDeadline(body.triggerDate, days, {
        mailService: Boolean(body.mailService),
        businessDays: Boolean(body.businessDays),
      });
      return sendJson(res, 200, { ok: true, ...result, commonDeadlines: caseTools.COMMON_DEADLINES });
    }

    // GET /api/tools/common-deadlines
    if (req.method === 'GET' && reqUrl.pathname === '/api/tools/common-deadlines') {
      return sendJson(res, 200, { ok: true, deadlines: caseTools.COMMON_DEADLINES });
    }

    // GET /api/case/assignment-chain
    if (req.method === 'GET' && reqUrl.pathname === '/api/case/assignment-chain') {
      if (!reqUrl.searchParams.has('force')) {
        const cached = readToolsCache('assignment-chain');
        if (cached) return sendJson(res, 200, cached);
      }
      return sendJson(res, 200, { ok: true, ...caseTools.getAssignmentChain() });
    }

    // GET /api/case/discovery
    if (req.method === 'GET' && reqUrl.pathname === '/api/case/discovery') {
      if (!reqUrl.searchParams.has('force')) {
        const cached = readToolsCache('discovery');
        if (cached) return sendJson(res, 200, cached);
      }
      if (!Database || !fs.existsSync(CASE_DB_PATH)) {
        return sendJson(res, 200, { ok: false, reason: 'Database not available' });
      }
      const db = new Database(CASE_DB_PATH, { readonly: true });
      try {
        const result = caseTools.getDiscoveryCompliance(db);
        return sendJson(res, 200, { ok: true, ...result });
      } finally { db.close(); }
    }

    // POST /api/case/discovery (add/update discovery item)
    if (req.method === 'POST' && reqUrl.pathname === '/api/case/discovery') {
      if (!Database || !fs.existsSync(CASE_DB_PATH)) {
        return sendJson(res, 200, { ok: false, reason: 'Database not available' });
      }
      const body = await readBodyJson(req);
      if (!body?.description) return badRequest(res, 'description required');
      const db = new Database(CASE_DB_PATH);
      try {
        db.prepare(`CREATE TABLE IF NOT EXISTS discovery_tracking (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          case_id INTEGER DEFAULT 1,
          type TEXT,
          description TEXT,
          served_by TEXT,
          served_date TEXT,
          served_to TEXT,
          due_date TEXT,
          response_date TEXT,
          status TEXT DEFAULT 'pending',
          notes TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`).run();
        const stmt = db.prepare(`INSERT INTO discovery_tracking (case_id, type, description, served_by, served_date, served_to, due_date, status, notes)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`);
        stmt.run(
          body.type || 'other',
          body.description,
          body.served_by || null,
          body.served_date || null,
          body.served_to || null,
          body.due_date || null,
          body.status || 'pending',
          body.notes || null,
        );
        return sendJson(res, 200, { ok: true, message: 'Discovery item added' });
      } finally { db.close(); }
    }

    // GET /api/case/plaintiff-patterns
    if (req.method === 'GET' && reqUrl.pathname === '/api/case/plaintiff-patterns') {
      if (!reqUrl.searchParams.has('force')) {
        const cached = readToolsCache('plaintiff-patterns');
        if (cached) return sendJson(res, 200, cached);
      }
      if (!Database || !fs.existsSync(CASE_DB_PATH)) {
        return sendJson(res, 200, { ok: false, reason: 'Database not available' });
      }
      const db = new Database(CASE_DB_PATH, { readonly: true });
      try {
        const result = caseTools.analyzePlaintiffPatterns(db);
        if (!result) return sendJson(res, 200, { ok: false, reason: 'No filing data available' });
        return sendJson(res, 200, { ok: true, ...result });
      } finally { db.close(); }
    }

    // POST /api/tools/courtlistener-search
    if (req.method === 'POST' && reqUrl.pathname === '/api/tools/courtlistener-search') {
      const body = await readBodyJson(req);
      if (!body?.query?.trim()) return badRequest(res, 'query required');
      try {
        const result = await caseTools.searchCourtListener(body.query, {
          court: body.court || 'ncapp,nc',
          maxResults: Math.min(Number(body.maxResults || 10), 20),
        });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // POST /api/tools/hearing-prep
    if (req.method === 'POST' && reqUrl.pathname === '/api/tools/hearing-prep') {
      const body = await readBodyJson(req);
      if (!body?.description && !body?.hearing_type) return badRequest(res, 'description or hearing_type required');
      const baseline = getBaselineContext();
      const prompt = caseTools.buildHearingPrepPrompt(body, baseline.context);
      try {
        const result = await callAnthropic({
          system: prompt,
          messages: [{ role: 'user', content: `Generate hearing prep for: ${body.description || body.hearing_type}. Hearing date: ${body.hearing_date || 'TBD'}. Include both Jesus Wept and Cutoff versions plus opposition anticipation.` }],
          maxTokens: 4000,
        });
        return sendJson(res, 200, { ok: true, prep: result });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /api/case/alerts
    if (req.method === 'GET' && reqUrl.pathname === '/api/case/alerts') {
      if (!reqUrl.searchParams.has('force')) {
        const cached = readToolsCache('alerts');
        if (cached) return sendJson(res, 200, cached);
      }
      const alerts = caseTools.getRecentAlerts();
      return sendJson(res, 200, { ok: true, alerts });
    }

    // POST /api/case/alerts (create alert)
    if (req.method === 'POST' && reqUrl.pathname === '/api/case/alerts') {
      const body = await readBodyJson(req);
      if (!body?.message) return badRequest(res, 'message required');
      const saved = caseTools.saveAlert({
        type: body.type || 'manual',
        message: body.message,
        priority: body.priority || 'medium',
      });
      if (!saved) {
        return sendJson(res, 500, { ok: false, error: 'Failed to persist alert' });
      }
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/case/response-reactor (check for new PLT filings needing response)
    if (req.method === 'GET' && reqUrl.pathname === '/api/case/response-reactor') {
      if (!reqUrl.searchParams.has('force')) {
        const cached = readToolsCache('response-reactor');
        if (cached) return sendJson(res, 200, cached);
      }
      if (!Database || !fs.existsSync(CASE_DB_PATH)) {
        return sendJson(res, 200, { ok: false, reason: 'Database not available' });
      }
      const db = new Database(CASE_DB_PATH, { readonly: true });
      try {
        const since = reqUrl.searchParams.get('since') || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const filings = caseTools.detectNewPlaintiffFilings(db, since);
        const skeletons = filings.map((f) => caseTools.buildResponseSkeleton(f));
        return sendJson(res, 200, { ok: true, filings: skeletons });
      } finally { db.close(); }
    }

    // GET /api/search?q=...
    if (req.method === 'GET' && reqUrl.pathname === '/api/search') {
      const q = reqUrl.searchParams.get('q') || '';
      // Use ragSearch (scored, all folders) plus librarySearch (00_Case_Overview, 07_Research) as fallback
      const ragHits = ragSearch(q, { maxResults: 20 });
      const libHits = librarySearch(q);
      // Merge: rag results first, then lib results not already covered
      const seen = new Set(ragHits.map((r) => r.path));
      const merged = [...ragHits];
      for (const h of libHits) {
        if (!seen.has(h.path)) { merged.push({ ...h, score: 0.1 }); seen.add(h.path); }
      }
      merged.sort((a, b) => (b.score || 0) - (a.score || 0));
      return sendJson(res, 200, { q, results: merged.slice(0, 25) });
    }

    return notFound(res);
  }

  // Static
  return serveStatic(reqUrl, res);
});

ensureDir(STATE_DIR);
ensureDir(SOURCE_PACKET_DIR);
ensureDir(ATTACHMENTS_DIR);

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Local UI running: http://${HOST}:${PORT}`);
  if (ENV_LOADED_FROM) console.log(`Loaded .env from: ${ENV_LOADED_FROM}`);

  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const model = getAnthropicModel();
  const maxTokens = getAnthropicMaxTokens();
  const thinkingCfg = resolveAnthropicThinking({ model, maxTokens });

  if (hasKey) {
    let thinkingLabel = 'off';
    if (thinkingCfg.effectiveMode === 'adaptive') {
      thinkingLabel = thinkingCfg.requestedEffort
        ? `adaptive(requested:${thinkingCfg.requestedEffort})`
        : 'adaptive';
    }
    if (thinkingCfg.effectiveMode === 'enabled') thinkingLabel = `enabled(${thinkingCfg.budgetTokens})`;
    console.log(`Anthropic: configured (model=${model}, max_tokens=${maxTokens}, thinking=${thinkingLabel})`);
  } else {
    console.log('Anthropic: NOT configured (missing ANTHROPIC_API_KEY)');
    console.log('Set ANTHROPIC_API_KEY in env (or scripts/ui-state/.env) to enable drafting.');
  }

  console.log(`Config check (safe): http://${HOST}:${PORT}/api/config`);
});
