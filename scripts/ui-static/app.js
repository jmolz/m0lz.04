const $ = (id) => document.getElementById(id);

function showToast(msg, { type = 'info', duration = 4000 } = {}) {
  const container = $('toastContainer');
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast--out');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

function showModal({ title, body, inputValue, onConfirm, onCancel, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  const overlay = $('modalOverlay');
  $('modalTitle').textContent = title || '';

  if (overlay.__modalKeyHandler) {
    document.removeEventListener('keydown', overlay.__modalKeyHandler);
    overlay.__modalKeyHandler = null;
  }
  overlay.__closeModal = null;

  const bodyEl = $('modalBody');
  bodyEl.innerHTML = '';
  if (typeof body === 'string') {
    const p = document.createElement('div');
    p.textContent = body;
    bodyEl.appendChild(p);
  }

  let inputEl = null;
  if (inputValue !== undefined) {
    inputEl = document.createElement('input');
    inputEl.className = 'input';
    inputEl.value = inputValue;
    bodyEl.appendChild(inputEl);
  }

  const actionsEl = $('modalActions');
  actionsEl.innerHTML = '';

  let keyHandler = null;
  const close = () => {
    overlay.classList.add('is-hidden');
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
    overlay.__modalKeyHandler = null;
    overlay.__closeModal = null;
  };

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = cancelLabel;
  cancelBtn.onclick = () => { close(); if (onCancel) onCancel(); };
  actionsEl.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = danger ? 'btn btn--danger' : 'btn btn--primary';
  confirmBtn.textContent = confirmLabel;
  confirmBtn.onclick = () => {
    const val = inputEl ? inputEl.value.trim() : true;
    close();
    if (onConfirm) onConfirm(val);
  };
  actionsEl.appendChild(confirmBtn);

  overlay.classList.remove('is-hidden');

  overlay.onclick = (e) => { if (e.target === overlay) { close(); if (onCancel) onCancel(); } };

  keyHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
    if (e.key === 'Enter' && inputEl && document.activeElement === inputEl) { e.preventDefault(); confirmBtn.click(); }
  };
  document.addEventListener('keydown', keyHandler);
  overlay.__modalKeyHandler = keyHandler;
  overlay.__closeModal = close;
  if (inputEl) { inputEl.focus(); inputEl.select(); }
}

const state = {
  conversations: [],
  drafts: [],
  activeConversationId: null,
  activeDraftId: null,
  messages: [],
  filingContexts: [],
  composerHint: { mode: '', respondingToIdx: '' },
  showAllDrafts: false,
  streaming: false,
  editorView: 'edit',
  pendingAttachments: [], // { id, filename, contentType, isImage, uploading }
};

const SLASH_COMMANDS = [
  { command: '/deadline-check', kind: 'workflow', description: 'Report pending deadlines with urgency levels.' },
  { command: '/draft-motion', kind: 'workflow', description: 'Draft a complete court-ready NC motion (with verified citations).' },
  { command: '/continuance-form', kind: 'workflow', description: 'Create continuance quick-fill draft from local form context.' },
  { command: '/hearing-prep', kind: 'workflow', description: 'Prepare hearing argument (Jesus Wept + Cutoff formats).' },
  { command: '/intake-files', kind: 'workflow', description: 'Process _Inbox files: classify, rename, move, and flag deadlines.' },
  { command: '/research-issue', kind: 'workflow', description: 'Research a legal issue and generate verified memo output.' },
  { command: '/ui-logs', kind: 'workflow', description: 'Show recent UI server logs.' },
  { command: '/ui-restart', kind: 'workflow', description: 'Restart the UI server.' },
  { command: '/ui-start', kind: 'workflow', description: 'Start the UI server.' },
  { command: '/ui-stop', kind: 'workflow', description: 'Stop the UI server.' },
  { command: '/verify', kind: 'command', description: 'Verify citations in active draft.' },
  { command: '/deadline', kind: 'command', description: 'Calculate deadline. Example: /deadline 30 2026-03-01 mail' },
  { command: '/cl', kind: 'command', description: 'Search CourtListener. Example: /cl debt buyer standing assignment' },
  { command: '/refresh', kind: 'command', description: 'Refresh filing reactor + alerts.' },
  { command: '/hearing', kind: 'command', description: 'Generate hearing prep from description.' },
  { command: '/ops', kind: 'command', description: 'Open advanced Ops page.' },
  { command: '/help', kind: 'command', description: 'Show command center help.' },
];

const slashMenuState = {
  open: false,
  items: [],
  selectedIndex: 0,
};

function getSlashToken(text) {
  const raw = String(text || '');
  const leftTrimmed = raw.replace(/^\s+/, '');
  if (!leftTrimmed.startsWith('/')) return '';
  const token = leftTrimmed.slice(1);
  if (/\s/.test(token)) return '';
  return token.toLowerCase();
}

function hideSlashCommandMenu() {
  const menu = $('slashCommandMenu');
  if (!menu) return;
  menu.classList.add('is-hidden');
  menu.innerHTML = '';
  slashMenuState.open = false;
  slashMenuState.items = [];
  slashMenuState.selectedIndex = 0;
}

function applySlashCommandSelection(item) {
  if (!item) return;
  const input = $('messageInput');
  if (!input) return;
  input.value = `${item.command} `;
  hideSlashCommandMenu();
  input.focus();
}

function renderSlashCommandMenu() {
  const menu = $('slashCommandMenu');
  if (!menu) return;

  if (!slashMenuState.open || !slashMenuState.items.length) {
    hideSlashCommandMenu();
    return;
  }

  const selected = Math.max(0, Math.min(slashMenuState.selectedIndex, slashMenuState.items.length - 1));
  slashMenuState.selectedIndex = selected;

  const rows = [];
  for (let i = 0; i < slashMenuState.items.length; i++) {
    const item = slashMenuState.items[i];
    const activeCls = i === selected ? ' slash-menu__item--active' : '';
    rows.push(`
      <button type="button" class="slash-menu__item${activeCls}" data-idx="${i}" role="option" aria-selected="${i === selected}">
        <span class="slash-menu__cmd">${item.command}</span>
        <span class="slash-menu__kind">${item.kind}</span>
        <span class="slash-menu__desc">${item.description}</span>
      </button>
    `);
  }

  menu.innerHTML = rows.join('');
  menu.classList.remove('is-hidden');
  menu.querySelectorAll('.slash-menu__item').forEach((btn) => {
    btn.onmousedown = (e) => {
      e.preventDefault();
      const idx = Number(btn.dataset.idx);
      if (!Number.isFinite(idx)) return;
      applySlashCommandSelection(slashMenuState.items[idx]);
    };
  });
}

function updateSlashCommandMenuFromInput() {
  const input = $('messageInput');
  if (!input) return;
  const token = getSlashToken(input.value);
  if (!token && String(input.value || '').trim() !== '/') {
    hideSlashCommandMenu();
    return;
  }

  const query = token;
  const filtered = SLASH_COMMANDS.filter((item) => {
    if (!query) return true;
    return item.command.slice(1).toLowerCase().includes(query)
      || item.description.toLowerCase().includes(query)
      || item.kind.toLowerCase().includes(query);
  }).slice(0, 12);

  if (!filtered.length) {
    hideSlashCommandMenu();
    return;
  }

  slashMenuState.open = true;
  slashMenuState.items = filtered;
  slashMenuState.selectedIndex = 0;
  renderSlashCommandMenu();
}

function setComposerHint(patch = {}) {
  state.composerHint = {
    mode: String(patch.mode ?? state.composerHint.mode ?? '').trim(),
    respondingToIdx: String(patch.respondingToIdx ?? state.composerHint.respondingToIdx ?? '').trim(),
  };
  updateComposerMeta();
}

function clearComposerHint() {
  state.composerHint = { mode: '', respondingToIdx: '' };
  updateComposerMeta();
}

function extractIdxFromText(text) {
  const m = String(text || '').match(/\bidx\s*0*(\d{1,4})\b/i);
  if (!m) return '';
  return `IDX${String(Number(m[1]))}`;
}

function inferModeFromContent(content) {
  const hinted = String(state.composerHint?.mode || '').toLowerCase();
  if (hinted === 'oral' || hinted === 'draft') return hinted;

  const lower = String(content || '').toLowerCase();
  const oralCue = /\b(hearing|oral argument|your honor|the cutoff|60-90 seconds|spoken|speakable)\b/i.test(lower);
  return oralCue ? 'oral' : 'draft';
}

function wantsDraftEdit(content) {
  const lower = String(content || '').toLowerCase();
  if (!lower) return false;

  if (/\b(change request|apply (?:this|the)?\s*(?:change|request)?\s*to (?:the )?(?:current )?draft|update (?:the )?(?:current )?draft|revise (?:the )?(?:current )?draft|edit (?:the )?(?:current )?draft|rewrite (?:the )?(?:current )?draft|redraft (?:the )?(?:current )?draft)\b/.test(lower)) {
    return true;
  }

  const editVerb = /\b(update|revise|edit|rewrite|redraft|modify|tighten|expand|add|remove|replace|incorporate|fix)\b/.test(lower);
  const mentionsDraft = /\bdraft\b/.test(lower);
  return editVerb && mentionsDraft;
}

function shouldApplyToDraft({ content, mode }) {
  if (!state.activeDraftId || mode !== 'draft') return false;
  return wantsDraftEdit(content);
}

function inferRespondingToIdx(content) {
  const hinted = normalizeIdxKey(state.composerHint?.respondingToIdx || '');
  if (hinted) return hinted;

  const explicit = normalizeIdxKey(extractIdxFromText(content));
  if (explicit) return explicit;

  const activeDraft = state.drafts.find((d) => d.id === state.activeDraftId);
  const draftIdx = normalizeIdxKey(activeDraft?.meta?.idxNum ? `IDX${activeDraft.meta.idxNum}` : '');
  if (draftIdx) return draftIdx;

  const lower = String(content || '').toLowerCase();
  const asksForResponse = /\b(response|respond|oppose|opposition|reply)\b/i.test(lower);
  if (!asksForResponse) return '';

  const pending = (state.filingContexts || []).filter((f) => String(f?.outcome || '').toLowerCase() === 'pending');
  if (!pending.length) return '';

  const pendingPlt = pending.filter((f) => String(f?.filed_by || '').toUpperCase() === 'PLT');
  if (pendingPlt.length === 1) return normalizeIdxKey(pendingPlt[0]?.motion_idx || '');
  if (pending.length === 1) return normalizeIdxKey(pending[0]?.motion_idx || '');
  return '';
}

function appendLocalMessage(role, content, meta = {}) {
  if (!state.activeConversationId) return;
  const msg = {
    id: `local_${Date.now()}_${role}`,
    conversationId: state.activeConversationId,
    role,
    content: String(content || ''),
    createdAt: new Date().toISOString(),
    meta,
  };
  state.messages.push(msg);
  renderMessages();
}

async function runCommandCenterCommand(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw.startsWith('/')) return false;

  appendLocalMessage('user', raw);

  const [cmdRaw, ...rest] = raw.slice(1).split(/\s+/);
  const cmd = String(cmdRaw || '').toLowerCase();
  const args = rest.join(' ').trim();

  if (!cmd || cmd === 'help') {
    appendLocalMessage('assistant', [
      '**Command Center Commands**',
      '',
      '**Workflows**',
      '- `/deadline-check` — report pending deadlines with urgency levels',
      '- `/draft-motion` — draft a court-ready NC motion',
      '- `/continuance-form` — create continuance quick-fill draft',
      '- `/hearing-prep` — hearing prep (dual oral formats)',
      '- `/intake-files` — process `_Inbox` files',
      '- `/research-issue` — produce verified research memo',
      '- `/ui-logs`, `/ui-restart`, `/ui-start`, `/ui-stop` — UI server workflow helpers',
      '',
      '**Direct Commands**',
      '- `/verify` — verify citations in active draft',
      '- `/deadline [days] [YYYY-MM-DD] [mail] [business]` — calculate deadline',
      '- `/cl <query>` — search CourtListener from chat',
      '- `/refresh` — refresh filing reactor + alerts',
      '- `/hearing <description>` — generate hearing prep',
      '- `/ops` — open advanced Ops page (optional)',
    ].join('\n'));
    return true;
  }

  try {
    if (cmd === 'deadline-check') {
      const data = await api('/api/case/deadlines');
      const list = Array.isArray(data?.deadlines) ? data.deadlines : [];
      if (!list.length) {
        appendLocalMessage('assistant', '**Deadline Check:** No pending deadlines found.');
        return true;
      }
      const lines = ['**Deadline Check:**'];
      for (const d of list.slice(0, 12)) {
        const urgency = String(d.urgency || 'medium').toUpperCase();
        const label = d.daysUntil < 0 ? `${Math.abs(d.daysUntil)}d overdue`
          : d.daysUntil === 0 ? 'TODAY'
            : `${d.daysUntil}d`;
        lines.push(`- [${urgency}] ${d.due_date} (${label}) — ${d.description}`);
      }
      appendLocalMessage('assistant', lines.join('\n'));
      setWorkflowQuickMeta(`Deadline check complete: ${list.length} pending.`, 'ok');
      return true;
    }

    if (cmd === 'draft-motion') {
      const topic = args || 'Motion to [insert requested relief]';
      const prompt = [
        `Draft a complete court-ready motion for this case: ${topic}.`,
        'Requirements:',
        '- NC District Court formatting and caption',
        '- Jesus Wept style (tight, direct, skimmable)',
        '- Include jurisdictional reservation paragraph',
        '- Use only verifiable authorities and flag any unverified citation',
        '- Include signature block + certificate of service',
      ].join('\n');
      $('messageInput').value = prompt;
      setComposerHint({ mode: 'draft' });
      setWorkflowQuickMeta('Draft-motion workflow loaded — press Enter to run.', 'ok');
      return true;
    }

    if (cmd === 'continuance-form') {
      const data = await api('/api/case/deadlines');
      const deadlines = Array.isArray(data?.deadlines) ? data.deadlines : [];
      const preferred = inferContinuanceDeadline(deadlines);
      const result = await startContinuanceForm(preferred, { reason: args || '' });
      if (result?.draft?.id) {
        appendLocalMessage('assistant', [
          '**Continuance quick-fill draft created.**',
          '',
          '- Local form: Motion/Order to Continue',
          `- Draft: ${result.draft.title}`,
          '- Open in right panel, fill bracketed fields, then save/export.',
        ].join('\n'));
        setWorkflowQuickMeta('Continuance quick-fill draft created from local form context.', 'ok');
      }
      return true;
    }

    if (cmd === 'hearing-prep') {
      if (!args) {
        appendLocalMessage('assistant', 'Usage: `/hearing-prep Motion to Dismiss hearing on standing`');
        return true;
      }
      const data = await api('/api/tools/hearing-prep', {
        method: 'POST',
        body: JSON.stringify({ description: args }),
      });
      appendLocalMessage('assistant', data?.prep || 'No hearing prep output returned.');
      setWorkflowQuickMeta('Hearing prep generated in chat.', 'ok');
      return true;
    }

    if (cmd === 'research-issue') {
      if (!args) {
        appendLocalMessage('assistant', 'Usage: `/research-issue standing effect of invalid substitution`');
        return true;
      }
      const prompt = [
        `Research issue: ${args}`,
        'Output a verified research memo with: short answer, analysis, key cases, key statutes, strategic implications, open questions.',
        'Do not fabricate citations. If any authority is uncertain, explicitly flag it.',
      ].join('\n\n');
      $('messageInput').value = prompt;
      setComposerHint({ mode: 'draft' });
      setWorkflowQuickMeta('Research workflow loaded — press Enter to run.', 'ok');
      return true;
    }

    if (cmd === 'intake-files') {
      const prompt = [
        'Process files in _Inbox using case intake protocol.',
        'For each file: classify, rename to naming convention, destination folder, summary, deadlines triggered, strategic notes.',
        'Use conservative deadline calculations and flag uncertainties.',
      ].join('\n\n');
      $('messageInput').value = prompt;
      setComposerHint({ mode: 'draft' });
      setWorkflowQuickMeta('Inbox intake workflow loaded — press Enter to run.', 'ok');
      return true;
    }

    if (cmd === 'ui-logs') {
      appendLocalMessage('assistant', 'Use `/ops` for diagnostics UI, or ask me: "show recent UI logs" and I will fetch stdout/stderr via the workflow.');
      return true;
    }

    if (cmd === 'ui-restart' || cmd === 'ui-start' || cmd === 'ui-stop') {
      appendLocalMessage('assistant', `Workflow command \`/${cmd}\` received. Ask me to execute it and I will run the corresponding server-control workflow step.`);
      return true;
    }

    if (cmd === 'verify') {
      if (!state.activeDraftId) {
        appendLocalMessage('assistant', 'No active draft is open. Open a draft, then run `/verify`.');
        return true;
      }
      const data = await api(`/api/drafts/${state.activeDraftId}/verify-citations`, { method: 'POST' });
      const total = Number(data?.total || 0);
      const verified = Number(data?.verified || 0);
      const unverified = Number(data?.unverified || 0);
      const lines = [
        `**Citation Audit:** ${verified}/${total} verified`,
        unverified > 0 ? `**Unverified:** ${unverified}` : '**All citations verified.**',
      ];
      if (unverified > 0) {
        for (const c of (data.citations || []).filter((x) => !x.verified).slice(0, 8)) {
          lines.push(`- \`${c.raw}\` — ${c.reason || 'Not verified'}`);
        }
      }
      appendLocalMessage('assistant', lines.join('\n'));
      setWorkflowQuickMeta(`Citation check: ${verified}/${total} verified${unverified ? ` (${unverified} unverified)` : ''}.`, unverified ? 'warn' : 'ok');
      return true;
    }

    if (cmd === 'deadline') {
      const dateMatch = args.match(/\b\d{4}-\d{2}-\d{2}\b/);
      const dayMatch = args.match(/\b(\d{1,3})\b/);
      const triggerDate = dateMatch ? dateMatch[0] : new Date().toISOString().slice(0, 10);
      const days = dayMatch ? Number(dayMatch[1]) : 30;
      const mailService = /\bmail\b/i.test(args);
      const businessDays = /\bbusiness\b/i.test(args);
      const data = await api('/api/tools/service-calc', {
        method: 'POST',
        body: JSON.stringify({ triggerDate, days, mailService, businessDays }),
      });
      const lines = [
        `**Deadline:** ${data.deadline}`,
        `Inputs: trigger ${triggerDate}, days ${days}${mailService ? ', +3 mail' : ''}${businessDays ? ', business days' : ''}.`,
      ];
      for (const step of (data.calculation || []).slice(0, 8)) lines.push(`- ${step}`);
      appendLocalMessage('assistant', lines.join('\n'));
      setWorkflowQuickMeta(`Deadline computed: ${data.deadline}`, 'ok');
      return true;
    }

    if (cmd === 'cl' || cmd === 'caselaw') {
      if (!args) {
        appendLocalMessage('assistant', 'Usage: `/cl debt buyer standing assignment`');
        return true;
      }
      const data = await api('/api/tools/courtlistener-search', {
        method: 'POST',
        body: JSON.stringify({ query: args }),
      });
      const results = Array.isArray(data?.results) ? data.results : [];
      if (!results.length) {
        appendLocalMessage('assistant', `No CourtListener results found for: **${args}**`);
        return true;
      }
      const lines = [`**Case Law Search:** ${results.length} result(s) for _${args}_`];
      for (const r of results.slice(0, 5)) {
        const cite = Array.isArray(r.citation) && r.citation.length ? ` — ${r.citation.join(', ')}` : '';
        const link = r.url ? `[${r.caseName}](${r.url})` : `${r.caseName}`;
        lines.push(`- ${link}${cite}`);
      }
      appendLocalMessage('assistant', lines.join('\n'));
      return true;
    }

    if (cmd === 'refresh') {
      const [reactor, alerts] = await Promise.all([
        api('/api/case/response-reactor?force=1'),
        api('/api/case/alerts?force=1'),
      ]);
      const filingCount = Array.isArray(reactor?.filings) ? reactor.filings.length : 0;
      const alertCount = Array.isArray(alerts?.alerts) ? alerts.alerts.length : 0;
      appendLocalMessage('assistant', `**Monitoring refreshed:** ${filingCount} filing trigger(s), ${alertCount} alert(s).`);
      setWorkflowQuickMeta(`Monitoring refreshed: ${filingCount} filing trigger(s), ${alertCount} alert(s).`, 'ok');
      return true;
    }

    if (cmd === 'hearing') {
      if (!args) {
        appendLocalMessage('assistant', 'Usage: `/hearing Motion to Dismiss hearing on standing`');
        return true;
      }
      const data = await api('/api/tools/hearing-prep', {
        method: 'POST',
        body: JSON.stringify({ description: args }),
      });
      appendLocalMessage('assistant', data?.prep || 'No hearing prep output returned.');
      setWorkflowQuickMeta('Hearing prep generated in chat.', 'ok');
      return true;
    }

    if (cmd === 'ops') {
      setTab('tools');
      appendLocalMessage('assistant', 'Opened advanced Ops page. Use this only for deep diagnostics.');
      return true;
    }

    appendLocalMessage('assistant', `Unknown command: \`/${cmd}\`. Run \`/help\` for available commands.`);
    return true;
  } catch (e) {
    appendLocalMessage('assistant', `Command failed: ${e.message}`);
    setWorkflowQuickMeta(`Command failed: ${e.message}`, 'warn');
    return true;
  }
}

function fmtTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

async function saveCaseSummaryMemo() {
  if (!state.activeConversationId) return;
  const raw = $('caseSummary').textContent || '';
  if (!raw.trim()) return;
  const content = ['# Case Summary', '', raw].join('\n');
  const created = await api('/api/drafts', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: state.activeConversationId,
      content,
      meta: { docType: 'MEMO', party: 'DEF', description: 'Case-Summary' },
    }),
  });
  await refreshState();
  setActiveDraft(created.draft.id);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error || data?.message || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function setTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('tab--active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('tabpane--active'));
  $("tab-" + tab).classList.add('tabpane--active');

  const layout = $('layoutRoot');
  if (layout) layout.classList.toggle('layout--wide', tab !== 'chat');

  if (tab === 'case') { loadCaseSummary(); loadNextMoves(); }
  if (tab === 'intel') loadIntelligence();
  if (tab === 'tools') toolsAutoLoad.activate();
  if (tab !== 'tools') toolsAutoLoad.deactivate();
}

// ── Tools Auto-Load + Polling ───────────────────────────────────────────────
const toolsAutoLoad = (() => {
  const POLL_INTERVAL = 60_000;
  const PANELS = [
    { loader: (opts) => loadAssignmentChain(opts), staleId: 'chainStale', key: 'chain' },
    { loader: (opts) => loadPlaintiffPatterns(opts), staleId: 'patternsStale', key: 'patterns' },
    { loader: (opts) => loadDiscoveryCompliance(opts), staleId: 'discoveryStale', key: 'discovery' },
    { loader: (opts) => loadResponseReactor(opts), staleId: 'reactorStale', key: 'reactor' },
    { loader: (opts) => loadAlerts(opts), staleId: 'alertsStale', key: 'alerts' },
  ];
  const timestamps = {};
  let pollTimer = null;
  let staleTimer = null;
  let active = false;

  function updateStaleDisplay() {
    const now = Date.now();
    for (const p of PANELS) {
      const el = $(p.staleId);
      if (!el) continue;
      const ts = timestamps[p.key];
      if (!ts) { el.textContent = ''; el.className = 'tools__stale'; continue; }
      const ago = Math.round((now - ts) / 1000);
      let label, cls;
      if (ago < 10) { label = 'just now'; cls = 'tools__stale tools__stale--fresh'; }
      else if (ago < 60) { label = `${ago}s ago`; cls = 'tools__stale tools__stale--fresh'; }
      else if (ago < 3600) { label = `${Math.floor(ago / 60)}m ago`; cls = ago > 300 ? 'tools__stale tools__stale--warn' : 'tools__stale tools__stale--fresh'; }
      else { label = `${Math.floor(ago / 3600)}h ago`; cls = 'tools__stale tools__stale--warn'; }
      el.textContent = label;
      el.className = cls;
    }
  }

  async function loadAll() {
    const results = await Promise.allSettled(PANELS.map((p) => p.loader()));
    const now = Date.now();
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') timestamps[PANELS[i].key] = now;
    });
    updateStaleDisplay();
  }

  function activate() {
    if (active) return;
    active = true;
    loadAll();
    pollTimer = setInterval(() => loadAll(), POLL_INTERVAL);
    staleTimer = setInterval(() => updateStaleDisplay(), 15_000);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
  }

  function forceRefreshPanel(key) {
    const panel = PANELS.find((p) => p.key === key);
    if (!panel) return;
    panel.loader({ force: true }).then(() => {
      timestamps[key] = Date.now();
      updateStaleDisplay();
    });
  }

  return { activate, deactivate, forceRefreshPanel, loadAll };
})();

function convTitle(id) {
  const c = state.conversations.find((x) => x.id === id);
  return c ? c.title : 'Conversation';
}

function updateTopLabels() {
  const label = $('activeConversationLabel');
  if (!label) return;
  if (!state.activeConversationId) {
    label.textContent = 'Local-only';
    return;
  }
  label.textContent = `Conversation: ${convTitle(state.activeConversationId)}`;
}

function renderConversations() {
  const list = $('conversationsList');
  list.innerHTML = '';

  $('workspaceMeta').textContent = `${state.conversations.length} conversations • ${state.drafts.length} drafts`;

  for (const c of state.conversations) {
    const card = document.createElement('div');
    card.className = c.id === state.activeConversationId ? 'card card--active' : 'card';

    const title = document.createElement('div');
    title.className = 'card__title';
    title.textContent = c.title;

    const meta = document.createElement('div');
    meta.className = 'card__meta';
    meta.textContent = c.id === state.activeConversationId ? 'Active' : `Updated: ${fmtTs(c.updatedAt)}`;

    const actions = document.createElement('div');
    actions.className = 'card__actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn--primary';
    openBtn.textContent = 'Open';
    openBtn.onclick = async () => {
      state.activeConversationId = c.id;
      state.activeDraftId = null;
      await refreshState();
    };

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn';
    renameBtn.textContent = 'Rename';
    renameBtn.onclick = async () => {
      showModal({
        title: 'Rename conversation',
        inputValue: c.title,
        confirmLabel: 'Rename',
        onConfirm: async (val) => {
          if (!val) return;
          await api(`/api/conversations/${c.id}`, { method: 'PATCH', body: JSON.stringify({ title: val }) });
          showToast('Conversation renamed', { type: 'success' });
          await refreshState();
        },
      });
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn--danger';
    delBtn.textContent = 'Delete';
    delBtn.onclick = async () => {
      showModal({
        title: 'Delete conversation',
        body: `Delete "${c.title}"? This removes its messages and drafts.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: async () => {
          await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
          if (state.activeConversationId === c.id) state.activeConversationId = null;
          state.activeDraftId = null;
          showToast('Conversation deleted', { type: 'success' });
          await refreshState();
        },
      });
    };

    actions.appendChild(openBtn);
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

async function refreshAllOpsMonitors() {
  try {
    await Promise.all([
      loadAssignmentChain({ force: true }),
      loadPlaintiffPatterns({ force: true }),
      loadDiscoveryCompliance({ force: true }),
      loadResponseReactor({ force: true }),
      loadAlerts({ force: true }),
    ]);
    setWorkflowQuickMeta('All monitors refreshed (chain, patterns, discovery, reactor, alerts).', 'ok');
    showToast('All Ops monitors refreshed', { type: 'success', duration: 2000 });
  } catch (e) {
    setWorkflowQuickMeta(`Ops monitor refresh failed: ${e.message}`, 'warn');
    showToast(`Ops monitor refresh failed: ${e.message}`, { type: 'error', duration: 4000 });
  }
}

function renderDrafts() {
  const list = $('draftsList');
  list.innerHTML = '';

  const drafts = state.showAllDrafts || !state.activeConversationId
    ? state.drafts
    : state.drafts.filter((d) => d.conversationId === state.activeConversationId);

  $('draftsMeta').textContent = drafts.length
    ? (state.showAllDrafts ? `${drafts.length} across all conversations` : `${drafts.length} in this conversation`)
    : 'None yet';

  for (const d of drafts) {
    const card = document.createElement('div');
    card.className = d.id === state.activeDraftId ? 'card card--active' : 'card';

    const title = document.createElement('div');
    title.className = 'card__title';
    title.textContent = d.title;

    const meta = document.createElement('div');
    meta.className = 'card__meta';
    const where = d.saved?.path ? `Saved: ${d.saved.path}` : (d.suggested?.relPath ? `Suggest: ${d.suggested.relPath}` : `Updated: ${fmtTs(d.updatedAt)}`);
    meta.textContent = state.showAllDrafts ? `${convTitle(d.conversationId)} • ${where}` : where;

    const actions = document.createElement('div');
    actions.className = 'card__actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'btn';
    openBtn.textContent = 'Open';
    openBtn.onclick = () => setActiveDraft(d.id);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn--danger';
    delBtn.textContent = 'Delete';
    delBtn.onclick = () => {
      showModal({
        title: 'Delete draft',
        body: `Delete "${d.title}" from the drafts list? Saved files on disk are not deleted.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: async () => {
          try {
            await api(`/api/drafts/${d.id}`, { method: 'DELETE' });
            if (state.activeDraftId === d.id) clearActiveDraft();
            await refreshState();
            showToast('Draft deleted', { type: 'success', duration: 1800 });
          } catch (e) {
            showToast(`Delete failed: ${e.message}`, { type: 'error', duration: 5000 });
          }
        },
      });
    };

    actions.appendChild(openBtn);
    actions.appendChild(delBtn);

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(actions);

    list.appendChild(card);
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInlineMarkdown(text) {
  const codeTokens = [];
  let out = String(text || '').replace(/`([^`]+?)`/g, (_, code) => {
    const token = `@@INLINE_CODE_${codeTokens.length}@@`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });

  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_m, label, href) => {
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');

  out = out.replace(/@@INLINE_CODE_(\d+)@@/g, (_m, i) => codeTokens[Number(i)] || '');
  return out;
}

function buildCaptionTable(captionLines) {
  const lines = Array.isArray(captionLines)
    ? captionLines.map((l) => String(l || '').trim()).filter(Boolean)
    : [];

  const boundary = /^(STATE OF|IN THE GENERAL COURT|COURT OF JUSTICE|DISTRICT COURT|SUPERIOR COURT|COUNTY|File\s+No\.|vs\.?$)/i;

  const collectPartyLines = (labelRegex, fallbackLines) => {
    const idx = lines.findIndex((line) => labelRegex.test(line));
    if (idx === -1) return fallbackLines;

    const labelLine = lines[idx];
    const inline = labelLine.replace(labelRegex, '').replace(/^\s*,?\s*|\s*,?\s*$/g, '');
    if (inline) return [inline];

    const collected = [];
    for (let i = idx - 1; i >= 0; i -= 1) {
      const t = lines[i].trim();
      if (!t || boundary.test(t)) break;
      if (/\b(plaintiff|defendant)\b/i.test(t)) break;
      collected.unshift(t.replace(/,\s*$/, ''));
    }
    return collected.length ? collected : fallbackLines;
  };

  const plaintiffLines = collectPartyLines(/^\s*plaintiff\s*[,.]?\s*$/i, ['Plaintiff']);
  const defendantLines = collectPartyLines(/^\s*defendant\s*[,.]?\s*$/i, ['DEFENDANT']);

  const vsIdx = lines.findIndex((line) => /^\s*vs\.?/i.test(line));
  const docTitleParts = [];
  if (vsIdx !== -1) {
    const first = lines[vsIdx].replace(/^\s*vs\.?\s*/i, '').trim();
    if (first) docTitleParts.push(first);
    for (let i = vsIdx + 1; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (!t) {
        if (docTitleParts.length) break;
        continue;
      }
      if (/\bdefendant\b/i.test(t)) break;
      if (/^\s*defendant\b/i.test(t)) break;
      if (boundary.test(t) || /^\s*plaintiff\b/i.test(t)) continue;
      docTitleParts.push(t);
    }
  }

  const addTrailingCommaToLast = (items) => {
    const list = Array.isArray(items) ? items.slice() : [];
    if (!list.length) return [''];
    const last = list.length - 1;
    list[last] = `${list[last].replace(/,\s*$/, '')},`;
    return list;
  };

  const plaintiffHtml = addTrailingCommaToLast(plaintiffLines).join('<br>');
  const defendantHtml = addTrailingCommaToLast(defendantLines).join('<br>');
  const docTitle = docTitleParts.join('<br>');

  return [
    '<table class="legal-cap">',
    `<tr><td class="legal-cap__l">${window.__caseConfig?.state || 'STATE OF NORTH CAROLINA'}</td><td class="legal-cap__r">${window.__caseConfig?.courtSystem || 'IN THE GENERAL COURT OF JUSTICE'}<br>${window.__caseConfig?.division || 'DISTRICT COURT DIVISION'}</td></tr>`,
    `<tr><td class="legal-cap__l">${window.__caseConfig?.county || 'COUNTY'}</td><td class="legal-cap__r">File No.: ${window.__caseConfig?.number || ''}</td></tr>`,
    '<tr><td colspan="2">&nbsp;</td></tr>',
    `<tr><td class="legal-cap__l">${plaintiffHtml}<br><br><span class="legal-cap__party">Plaintiff,</span></td><td class="legal-cap__r"></td></tr>`,
    `<tr><td class="legal-cap__l"><span class="legal-cap__vs">vs.</span></td><td class="legal-cap__r"><strong>${docTitle}</strong></td></tr>`,
    `<tr><td class="legal-cap__l">${defendantHtml}<br><br><span class="legal-cap__party">Defendant.</span></td><td class="legal-cap__r"></td></tr>`,
    '</table>',
  ].join('\n');
}

function buildDeadlineEmailPrompt(deadline) {
  const label = deadline.daysUntil < 0 ? `${Math.abs(deadline.daysUntil)} days overdue`
    : deadline.daysUntil === 0 ? 'due today'
    : `due in ${deadline.daysUntil} days`;
  const type = classifyDeadlineWorkType(deadline);

  return [
    'Communication path selected for this deadline.',
    'Draft a ready-to-send email focused on court administration follow-up.',
    '',
    `DEADLINE: ${deadline.description}`,
    `DUE DATE: ${deadline.due_date} (${label})`,
    `PRIORITY: ${deadline.priority || 'unspecified'}`,
    `SOURCE: ${deadline.triggered_by || 'not provided'}`,
    `RULE: ${deadline.rule_reference || 'not provided'}`,
    `NOTES: ${deadline.notes || 'none'}`,
    `WORK TYPE: ${type}`,
    '',
    'Return in this exact structure:',
    '1) Subject line',
    '2) To/CC recommendation (trial court administrator / clerk / opposing counsel as appropriate)',
    '3) Ready-to-send email body (concise facts, specific ask, requested confirmation)',
    '4) 1 follow-up email if no response within 24 hours',
    '',
    'Keep it professional, concise, and practical for your court\'s workflow.',
  ].join('\n');
}

function renderMarkdown(text) {
  let normalized = String(text || '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return '';

  // Legal filing detection: preserve line breaks for proper document structure
  const isLegalFiling = /STATE OF NORTH CAROLINA/.test(normalized) && /GENERAL COURT OF JUSTICE/.test(normalized);
  if (isLegalFiling) {
    normalized = normalized.replace(/\n(?!\n)/g, '\n\n');
  }

  const codeBlocks = [];
  let source = escapeHtml(normalized).replace(/```([a-z0-9_-]*)[ \t]*\n([\s\S]*?)```/gi, (_m, lang, code) => {
    const cls = lang ? ` class="language-${lang}"` : '';
    const token = `@@FENCED_CODE_${codeBlocks.length}@@`;
    codeBlocks.push(`<pre><code${cls}>${code}</code></pre>`);
    return token;
  });

  const lines = source.split('\n');
  const html = [];
  const paragraph = [];
  let inUl = false;
  let inOl = false;
  let inTable = false;
  let tableHeaderDone = false;
  let inCaption = false;
  let captionLines = [];
  let captionDone = false;

  const closeLists = () => {
    if (inUl) { html.push('</ul>'); inUl = false; }
    if (inOl) { html.push('</ol>'); inOl = false; }
  };

  const closeTable = () => {
    if (inTable) {
      html.push('</tbody></table>');
      inTable = false;
      tableHeaderDone = false;
    }
  };

  const parseTableCells = (row) => {
    return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  };

  const isTableRow = (s) => /^\|(.+\|)+\s*$/.test(s + (s.endsWith('|') ? '' : '|'));
  const isSeparatorRow = (s) => /^\|(\s*:?-+:?\s*\|)+\s*$/.test(s + (s.endsWith('|') ? '' : '|'));

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${formatInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph.length = 0;
  };

  for (let li = 0; li < lines.length; li++) {
    const line = String(lines[li] || '');
    const trimmed = line.trim();

    // Caption collection mode — gather all lines until "Defendant."
    if (inCaption) {
      if (!trimmed) continue;
      captionLines.push(trimmed);
      if (captionLines.length > 15) {
        for (const cl of captionLines) html.push(`<p class="legal-caption">${formatInlineMarkdown(cl)}</p>`);
        inCaption = false; captionDone = true; continue;
      }
      if (/defendant\s*[.,]?\s*$/i.test(trimmed)) {
        html.push(buildCaptionTable(captionLines));
        inCaption = false; captionDone = true;
      }
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      // Peek ahead: keep OL/UL open if next content is another list item
      if (inOl || inUl) {
        let nextContent = '';
        for (let peek = li + 1; peek < lines.length; peek++) {
          const p = (lines[peek] || '').trim();
          if (p) { nextContent = p; break; }
        }
        const nextIsOl = /^\d+\.\s+/.test(nextContent);
        const nextIsUl = /^[-*+]\s+/.test(nextContent);
        if (!(inOl && nextIsOl) && !(inUl && nextIsUl)) closeLists();
      }
      closeTable();
      continue;
    }

    if (/^@@FENCED_CODE_\d+@@$/.test(trimmed)) {
      flushParagraph();
      closeLists();
      closeTable();
      html.push(trimmed);
      continue;
    }

    // ── Table detection ──
    if (isTableRow(trimmed)) {
      const nextLine = (lines[li + 1] || '').trim();
      // Start a new table: header row followed by separator
      if (!inTable && isSeparatorRow(nextLine)) {
        flushParagraph();
        closeLists();
        const cells = parseTableCells(trimmed);
        html.push('<table><thead><tr>');
        for (const c of cells) html.push(`<th>${formatInlineMarkdown(c)}</th>`);
        html.push('</tr></thead><tbody>');
        li++; // skip separator row
        inTable = true;
        tableHeaderDone = true;
        continue;
      }
      // Continue an existing table body
      if (inTable && tableHeaderDone) {
        const cells = parseTableCells(trimmed);
        html.push('<tr>');
        for (const c of cells) html.push(`<td>${formatInlineMarkdown(c)}</td>`);
        html.push('</tr>');
        continue;
      }
    } else if (inTable) {
      closeTable();
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      closeLists();
      closeTable();
      const level = headingMatch[1].length;
      html.push(`<h${level}>${formatInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      closeLists();
      closeTable();
      html.push('<hr>');
      continue;
    }

    const quoteMatch = trimmed.match(/^&gt;\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      closeLists();
      closeTable();
      html.push(`<blockquote><p>${formatInlineMarkdown(quoteMatch[1])}</p></blockquote>`);
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      closeTable();
      if (inOl) { html.push('</ol>'); inOl = false; }
      if (!inUl) { html.push('<ul>'); inUl = true; }
      html.push(`<li>${formatInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      closeTable();
      if (inUl) { html.push('</ul>'); inUl = false; }
      if (!inOl) { html.push('<ol>'); inOl = true; }
      html.push(`<li>${formatInlineMarkdown(olMatch[1])}</li>`);
      continue;
    }

    // ── Legal document formatting ──
    // Caption start: STATE OF NORTH CAROLINA
    if (/STATE OF NORTH CAROLINA/i.test(trimmed) && !captionDone) {
      flushParagraph(); closeLists(); closeTable();
      captionLines = [trimmed];
      inCaption = true;
      continue;
    }

    // Roman numeral section heading: I. ...
    const romanMatch = trimmed.match(/^([IVX]+)\.\s+(.+)$/);
    if (romanMatch) {
      const restText = romanMatch[2].trim();
      if (restText.length > 3) {
        flushParagraph(); closeLists(); closeTable();
        html.push(`<h3 class="legal-section">${formatInlineMarkdown(trimmed)}</h3>`);
        continue;
      }
    }

    // ALL CAPS line (≥90% uppercase, ≥3 words): legal heading or caption
    const alpha = trimmed.replace(/[^a-zA-Z]/g, '');
    const upperN = (alpha.match(/[A-Z]/g) || []).length;
    const wordCount = trimmed.split(/\s+/).length;
    if (alpha.length >= 8 && upperN / alpha.length >= 0.9 && wordCount >= 2 && trimmed.length >= 10 && trimmed.length <= 140) {
      flushParagraph(); closeLists(); closeTable();
      const capKw = /STATE OF|IN THE GENERAL COURT|GENERAL COURT OF JUSTICE|DISTRICT COURT|SUPERIOR COURT|COUNTY|FILE NO\.?\s*:/i;
      const cls = capKw.test(trimmed) ? 'legal-caption' : 'legal-heading';
      html.push(`<p class="${cls}">${formatInlineMarkdown(trimmed)}</p>`);
      continue;
    }

    // Caption party lines: "..., Plaintiff," or "..., Defendant." or standalone "vs."
    if (/,?\s*(Plaintiff|Defendant)\s*[,.]?\s*$/i.test(trimmed) || /^\s*vs\.?\s*$/i.test(trimmed)) {
      flushParagraph(); closeLists(); closeTable();
      html.push(`<p class="legal-caption">${formatInlineMarkdown(trimmed)}</p>`);
      continue;
    }

    // Document title line: "vs. DEFENDANT'S MOTION TO..."
    if (/^vs\.\s+DEFENDANT/i.test(trimmed)) {
      flushParagraph(); closeLists(); closeTable();
      html.push(`<p class="legal-caption"><strong>${formatInlineMarkdown(trimmed)}</strong></p>`);
      continue;
    }

    // WHEREFORE clause
    if (/^\*{0,2}WHEREFORE\b/i.test(trimmed)) {
      flushParagraph(); closeLists(); closeTable();
      html.push(`<p class="legal-wherefore"><strong>${formatInlineMarkdown(trimmed)}</strong></p>`);
      continue;
    }

    // NOW COMES intro paragraph
    if (/^NOW COMES\b/i.test(trimmed)) {
      flushParagraph(); closeLists(); closeTable();
      html.push(`<p class="legal-intro">${formatInlineMarkdown(trimmed)}</p>`);
      continue;
    }

    // Respectfully submitted / signature
    if (/^Respectfully submitted/i.test(trimmed)) {
      flushParagraph(); closeLists(); closeTable();
      html.push(`<p class="legal-signature">${formatInlineMarkdown(trimmed)}</p>`);
      continue;
    }

    closeLists();
    closeTable();
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeLists();
  closeTable();

  let out = html.join('\n');
  out = out.replace(/@@FENCED_CODE_(\d+)@@/g, (_m, i) => codeBlocks[Number(i)] || '');
  return out;
}

function splitMultipleFilings(content) {
  const text = String(content || '');
  const lines = text.split('\n');
  const captionStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/STATE OF NORTH CAROLINA/i.test(lines[i]) && /GENERAL COURT OF JUSTICE/i.test(lines.slice(i, i + 3).join(' '))) {
      captionStarts.push(i);
    }
  }
  if (captionStarts.length <= 1) return [text];

  const chunks = [];
  for (let c = 0; c < captionStarts.length; c++) {
    const start = captionStarts[c];
    const end = c + 1 < captionStarts.length ? captionStarts[c + 1] : lines.length;
    let chunk = lines.slice(start, end).join('\n').trim();
    // Strip trailing separator between filings (---, ***, blank runs)
    chunk = chunk.replace(/[\s\n]*[-*_]{3,}\s*$/, '').trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks.length ? chunks : [text];
}

function classifyAssistantDraftIntent(content) {
  const text = String(content || '');
  const lower = text.toLowerCase();
  const hasCaption = lower.includes('state of north carolina') && lower.includes('in the general court of justice');
  const hasWherefore = lower.includes('wherefore');
  const hasService = lower.includes('certificate of service');
  const hasSignature = lower.includes(', pro se') || lower.includes('respectfully submitted');

  const structuralMarkers = [hasCaption, hasWherefore, hasService, hasSignature].filter(Boolean).length;

  let docType = 'MEMO';
  if (/\bmotion\b/.test(lower)) docType = 'MOT';
  else if (/\banswer\b/.test(lower)) docType = 'ANS';
  else if (/\bresponse\b/.test(lower)) docType = 'RESP';
  else if (/\breply\b/.test(lower)) docType = 'REPLY';

  const isFilingDraft = structuralMarkers >= 2;
  return {
    isFilingDraft,
    docType: isFilingDraft ? docType : 'MEMO',
    description: isFilingDraft ? 'Assistant-Filing-Draft' : 'Assistant-Strategy-Memo',
  };
}

function extractFilingRecommendations(content) {
  const text = String(content || '');
  const results = [];
  const seen = new Set();
  const filingWords = /\b(motion|answer|brief|response|reply|complaint|transfer|rule 12|supplemental|amended)\b/i;
  const sectionHeadings = /^(\(\d+\)|risks|fallback|filing priority|opposing|recommended|what|how|why|when|if the|background|analysis|situation|conclusion)/i;

  const add = (raw) => {
    const clean = raw.trim().replace(/^\**|\**$/g, '').replace(/^[-–—]\s*/, '').replace(/\s+/g, ' ').trim();
    if (clean.length < 12 || clean.length > 65) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    if (!filingWords.test(key)) return;
    if (sectionHeadings.test(clean)) return;
    if (/^(the |a |an |if |this |your |you |once |when |but |file |draft |raise |expect |record )/i.test(clean)) return;
    // Skip items that look like analysis sentences (contain verbs/conjunctions mid-string)
    if (/\b(will |would |should |could |because |since |however |although |likely |probably )\b/i.test(clean)) return;
    seen.add(key);
    results.push(clean);
  };

  // 1. Table rows: | 1 | Filing Name | Type | ... |
  let m;
  const tableRow = /\|\s*\d+\s*\|\s*([^|]{12,65})\s*\|/g;
  while ((m = tableRow.exec(text)) !== null) add(m[1]);

  // 2. Lettered items with explicit filing keywords: a. Motion to Transfer...
  const lettered = /(?:^|\n)\s*[a-d]\.\s+(?:File\s+a\s+)?([^\n]{12,65}?)(?:\.|,|\n|$)/gm;
  while ((m = lettered.exec(text)) !== null) add(m[1]);

  return results.slice(0, 4);
}

function makeMessageEl(m) {
  const box = document.createElement('div');
  box.className = `msg msg--${m.role}`;
  if (m.id) box.dataset.msgId = m.id;

  const meta = document.createElement('div');
  meta.className = 'msg__meta';
  const roleLabel = m.role === 'user' ? 'You' : 'Assistant';
  const roleSpan = document.createElement('span');
  roleSpan.textContent = roleLabel;
  const tsSpan = document.createElement('span');
  tsSpan.textContent = fmtTs(m.createdAt);
  meta.appendChild(roleSpan);
  meta.appendChild(tsSpan);

  const content = document.createElement('div');
  content.className = 'msg__content';
  if (m.role === 'assistant') {
    content.classList.add('prose');
    content.innerHTML = renderMarkdown(m.content);
  } else {
    content.textContent = m.content;
  }

  box.appendChild(meta);

  // Render attachment badges for user messages
  const atts = Array.isArray(m.meta?.attachments) ? m.meta.attachments : [];
  if (atts.length) {
    const attRow = document.createElement('div');
    attRow.className = 'msg__attachments';
    for (const a of atts) {
      const badge = document.createElement('span');
      badge.className = 'msg__att-badge';
      const icon = a.isImage ? '\u{1F5BC}' : '\u{1F4C4}';
      badge.textContent = `${icon} ${a.filename}`;
      attRow.appendChild(badge);
    }
    box.appendChild(attRow);
  }

  box.appendChild(content);

  {
    const baselines = Array.isArray(m.meta?.baselinePaths) ? m.meta.baselinePaths : [];
    const ragSrcs = Array.isArray(m.meta?.ragSources) ? m.meta.ragSources : [];
    const legacyPaths = Array.isArray(m.meta?.ragPaths) ? m.meta.ragPaths : [];
    const totalCount = baselines.length + (ragSrcs.length || legacyPaths.length);

    if (m.role === 'assistant' && totalCount > 0) {
      const det = document.createElement('details');
      det.className = 'msg__sources';

      const sum = document.createElement('summary');
      sum.textContent = `Sources (${totalCount})`;
      det.appendChild(sum);

      const inner = document.createElement('div');
      inner.className = 'msg__sources-inner';

      if (baselines.length) {
        const h = document.createElement('div');
        h.className = 'msg__sources-heading';
        h.textContent = `Baseline (${baselines.length})`;
        inner.appendChild(h);
        const ul = document.createElement('ul');
        ul.className = 'msg__sources-list';
        for (const p of baselines) {
          const li = document.createElement('li');
          li.textContent = p;
          ul.appendChild(li);
        }
        inner.appendChild(ul);
      }

      if (ragSrcs.length) {
        const h = document.createElement('div');
        h.className = 'msg__sources-heading';
        h.textContent = `Dynamic RAG (${ragSrcs.length})`;
        inner.appendChild(h);
        const ul = document.createElement('ul');
        ul.className = 'msg__sources-list';
        for (const s of ragSrcs) {
          const li = document.createElement('li');
          const score = typeof s.score === 'number' ? s.score.toFixed(2) : '?';
          const kind = s.kind || 'unknown';
          const ext = s.extracted ? ' extracted' : ' not-extracted';
          const pathSpan = document.createElement('span');
          pathSpan.className = 'src-path';
          pathSpan.textContent = String(s.path || '');
          const metaSpan = document.createElement('span');
          metaSpan.className = 'src-meta';
          metaSpan.textContent = `${kind} · score ${score}${ext}`;
          li.appendChild(pathSpan);
          li.appendChild(document.createTextNode(' '));
          li.appendChild(metaSpan);
          ul.appendChild(li);
        }
        inner.appendChild(ul);
      } else if (legacyPaths.length) {
        const h = document.createElement('div');
        h.className = 'msg__sources-heading';
        h.textContent = `RAG (${legacyPaths.length})`;
        inner.appendChild(h);
        const pre = document.createElement('pre');
        pre.textContent = legacyPaths.join('\n');
        inner.appendChild(pre);
      }

      det.appendChild(inner);
      box.appendChild(det);
    }
  }

  if (m.role === 'assistant' && !m.meta?.streaming && String(m.content || '').trim()) {
    const actions = document.createElement('div');
    actions.className = 'msg__actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn--sm';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(m.content).then(() => {
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    };
    actions.appendChild(copyBtn);

    if (m.meta?.draftUpdated && m.meta?.draftId) {
      const openUpdatedBtn = document.createElement('button');
      openUpdatedBtn.className = 'btn btn--primary';
      openUpdatedBtn.textContent = 'Open updated draft';
      openUpdatedBtn.onclick = async () => {
        await refreshState();
        setActiveDraft(m.meta.draftId);
      };
      actions.appendChild(openUpdatedBtn);

      const reviewBtn = document.createElement('button');
      reviewBtn.className = 'btn btn--sm';
      reviewBtn.textContent = 'Review in preview';
      reviewBtn.onclick = async () => {
        await refreshState();
        setActiveDraft(m.meta.draftId);
        setEditorView('preview');
        const preview = $('draftPreview');
        if (preview) preview.scrollTop = 0;
        showToast('Preview opened for review', { type: 'info', duration: 1800 });
      };
      actions.appendChild(reviewBtn);

      const verifyBtn = document.createElement('button');
      verifyBtn.className = 'btn btn--sm';
      verifyBtn.textContent = 'Verify citations';
      verifyBtn.onclick = async () => {
        await refreshState();
        setActiveDraft(m.meta.draftId);
        await verifyActiveDraftWorkflow();
      };
      actions.appendChild(verifyBtn);
    }

    if (!(m.meta?.draftUpdated && m.meta?.draftId)) {
      const filingChunks = splitMultipleFilings(m.content);
      const draftBtn = document.createElement('button');
      draftBtn.className = 'btn btn--primary';
      draftBtn.textContent = filingChunks.length > 1
        ? `Save as ${filingChunks.length} drafts`
        : 'Save as draft';
      draftBtn.onclick = async () => {
        if (!state.activeConversationId) return;
        let firstId = null;
        for (const chunk of filingChunks) {
          const intent = classifyAssistantDraftIntent(chunk);
          const meta = intent.isFilingDraft
            ? { docType: intent.docType, party: 'DEF', description: intent.description }
            : { docType: 'MEMO', party: 'DEF', description: 'Assistant-Strategy-Draft' };
          const created = await api('/api/drafts', {
            method: 'POST',
            body: JSON.stringify({
              conversationId: state.activeConversationId,
              content: chunk,
              meta,
            }),
          });
          if (!firstId) firstId = created.draft.id;
        }
        await refreshState();
        if (firstId) setActiveDraft(firstId);
        if (filingChunks.length > 1) {
          showToast(`Created ${filingChunks.length} separate drafts from this response`, 'success');
        }
      };
      actions.appendChild(draftBtn);
    }

    box.appendChild(actions);
  }

  return box;
}

function renderMessages() {
  const wrap = $('messages');
  wrap.innerHTML = '';

  for (const m of state.messages) {
    wrap.appendChild(makeMessageEl(m));
  }

  wrap.scrollTop = wrap.scrollHeight;
}

async function postMessageStream({ conversationId, body, onEvent, signal }) {
  const res = await fetch(`/api/conversations/${conversationId}/messages/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  function handleBlock(block) {
    const lines = String(block).split(/\n/);
    let ev = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const dataStr = dataLines.join('\n');
    let data = null;
    try { data = JSON.parse(dataStr); } catch { data = { raw: dataStr }; }
    if (onEvent) onEvent(ev, data);
  }

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    while (true) {
      const sep = buf.indexOf('\n\n');
      if (sep === -1) break;
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      handleBlock(block);
    }
  }
}

async function refreshState() {
  const data = await api('/api/state');
  state.conversations = data.conversations || [];
  state.drafts = data.drafts || [];

  if (!state.activeConversationId && state.conversations.length) {
    state.activeConversationId = state.conversations[0].id;
  }

  renderConversations();
  updateTopLabels();
  await loadConversation(state.activeConversationId);
  renderDrafts();
  renderWorkflowQuickActions();
}

async function loadConversation(convId) {
  if (!convId) {
    state.messages = [];
    renderMessages();
    return;
  }

  state.activeConversationId = convId;
  const data = await api(`/api/conversations/${convId}`);
  state.messages = data.messages || [];
  renderMessages();
  updateTopLabels();

  const drafts = state.drafts.filter((d) => d.conversationId === convId);
  if (state.activeDraftId && !drafts.some((d) => d.id === state.activeDraftId)) {
    clearActiveDraft();
  }
}

function clearActiveDraft() {
  state.activeDraftId = null;
  $('activeDraftMeta').textContent = 'No draft selected';
  $('draftContent').value = '';
  $('draftPreview').innerHTML = '';
  $('saveDraftBtn').disabled = true;
  $('toggleAdvancedBtn').disabled = true;
  $('draftSuggestedMeta').textContent = '';
  $('saveStatus').textContent = '';
  updateComposerMeta();
  const ck = $('completenessChecklist'); if (ck) ck.innerHTML = '';
  const jw = $('jesusWeptMeter'); if (jw) jw.innerHTML = '';
  const vh = $('versionHistory'); if (vh) vh.innerHTML = '';
  const rt = $('redTeamResult'); if (rt) rt.innerHTML = '';
  renderWorkflowQuickActions();
}

function renderDraftPreview() {
  const preview = $('draftPreview');
  const text = $('draftContent').value || '';
  const looksLikeFiling = /STATE OF NORTH CAROLINA/i.test(text)
    && /GENERAL COURT OF JUSTICE/i.test(text)
    && /\bDefendant\.?\s*$/mi.test(text);
  preview.innerHTML = looksLikeFiling
    ? renderDocxAlignedPreview(text)
    : renderMarkdown(text);
}

function renderDocxAlignedPreview(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const html = ['<div class="docx-preview">'];

  let captionEnd = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/\bDefendant\.?\s*$/i.test(String(lines[i] || '').trim())) {
      captionEnd = i;
      break;
    }
  }

  if (captionEnd >= 0) {
    const captionLines = lines
      .slice(0, captionEnd + 1)
      .map((l) => escapeHtml(String(l || '').trim()))
      .filter(Boolean);
    html.push(buildCaptionTable(captionLines));
    html.push('<p class="docx-preview__rule"></p>');
  }

  const bodyLines = captionEnd >= 0 ? lines.slice(captionEnd + 1) : lines;
  let zone = 'body';
  let cosBuffer = [];

  const flushCosBuffer = () => {
    if (!cosBuffer.length) return;
    const merged = formatInlineMarkdown(escapeHtml(cosBuffer.join(' ')));
    html.push(`<p class="docx-preview__compact">${merged}</p>`);
    cosBuffer = [];
  };

  for (const rawLine of bodyLines) {
    const t = String(rawLine || '').trim();
    if (!t) {
      if (cosBuffer.length) flushCosBuffer();
      html.push('<div class="docx-preview__spacer"></div>');
      continue;
    }

    // Horizontal rule: --- or ___ or ***
    if (/^[-_*]{3,}$/.test(t)) {
      if (cosBuffer.length) flushCosBuffer();
      html.push('<div class="docx-preview__hr"></div>');
      continue;
    }

    // Non-filing meta lines (local form reference, form path, assistant notes)
    if (/^\*\*(LOCAL FORM REFERENCE|FORM PATH|ASSISTANT NOTE)/.test(t)) {
      if (cosBuffer.length) flushCosBuffer();
      const metaFormatted = formatInlineMarkdown(escapeHtml(t));
      html.push(`<p class="docx-preview__meta">${metaFormatted}</p>`);
      continue;
    }

    // COS zone: merge consecutive para + bullet text into one flowing paragraph
    if (zone === 'cos' && (/^[-\u2022]\s/.test(t) || !/^_{5,}$/.test(t) && !/^Respectfully submitted/i.test(t) && !/^CERTIFICATE OF SERVICE/i.test(t))) {
      const stripped = t.replace(/^[-\u2022]\s*/, '');
      cosBuffer.push(stripped);
      continue;
    }

    if (cosBuffer.length) flushCosBuffer();

    const formatted = formatInlineMarkdown(escapeHtml(t));

    if (/^CERTIFICATE OF SERVICE\s*$/i.test(t)) {
      zone = 'cos';
      html.push(`<p class="docx-preview__cos-heading"><strong>${formatted}</strong></p>`);
      continue;
    }

    if (/^Respectfully submitted/i.test(t)) {
      zone = 'signature';
      html.push(`<p class="docx-preview__compact">${formatted}</p>`);
      continue;
    }

    if (/^\*\*[IVX]+\.\s/.test(t) && /\*\*\s*$/.test(t)) {
      html.push(`<p class="docx-preview__section">${formatted}</p>`);
      continue;
    }

    if (/^\d+\.\s/.test(t)) {
      html.push(`<p class="docx-preview__numbered">${formatted}</p>`);
      continue;
    }

    if (/^\([1-9]\d?\)\s/.test(t)) {
      html.push(`<p class="docx-preview__subitem">${formatted}</p>`);
      continue;
    }

    if (/^[-\u2022]\s/.test(t)) {
      const bulletText = formatInlineMarkdown(escapeHtml(t.replace(/^[-\u2022]\s*/, '')));
      html.push(`<p class="docx-preview__bullet"><span class="docx-preview__bullet-mark">\u2022</span>${bulletText}</p>`);
      continue;
    }

    if (/^_{5,}$/.test(t)) {
      html.push('<p class="docx-preview__sig-line">_________________________</p>');
      continue;
    }

    const paraClass = zone === 'signature' || zone === 'cos'
      ? 'docx-preview__compact'
      : 'docx-preview__para';
    html.push(`<p class="${paraClass}">${formatted}</p>`);
  }

  if (cosBuffer.length) flushCosBuffer();

  html.push('</div>');
  return html.join('\n');
}

function setEditorView(view) {
  state.editorView = view === 'preview' ? 'preview' : 'edit';
  const isPreview = state.editorView === 'preview';
  $('editorEditViewBtn').classList.toggle('btn--active', !isPreview);
  $('editorPreviewViewBtn').classList.toggle('btn--active', isPreview);
  $('draftContent').classList.toggle('is-hidden', isPreview);
  $('draftPreview').classList.toggle('is-hidden', !isPreview);
  if (isPreview) renderDraftPreview();
}

function setActiveDraft(draftId) {
  state.activeDraftId = draftId;
  const d = state.drafts.find((x) => x.id === draftId);
  if (!d) return;

  $('activeDraftMeta').textContent = d.saved?.path ? `Saved: ${d.saved.path}` : `Updated: ${fmtTs(d.updatedAt)}`;
  $('draftContent').value = d.content || '';
  $('saveDraftBtn').disabled = false;
  $('toggleAdvancedBtn').disabled = false;
  $('saveStatus').textContent = '';

  const suggested = d.suggested?.relPath ? `Suggested: ${d.suggested.relPath}` : '';
  const metaBits = d.meta?.docType ? `${d.meta.docType}/${d.meta.party} • ${d.meta.description}` : '';
  const sourceBits = d.meta?.sourcePacketId
    ? `Source-locked: ${Number(d.meta?.sourceCount || (Array.isArray(d.meta?.sourcePaths) ? d.meta.sourcePaths.length : 0))} sources`
    : '';
  $('draftSuggestedMeta').textContent = [suggested, metaBits, sourceBits].filter(Boolean).join(' • ');

  // Draft mode auto-applies to active draft.
  updateComposerMeta();

  // Reasonable defaults
  $('optDate').value = d.meta?.date || new Date().toISOString().slice(0, 10);
  $('optIdx').value = d.meta?.idxNum ? String(d.meta.idxNum) : '';
  $('optDocType').value = d.meta?.docType || 'MOT';
  $('optParty').value = d.meta?.party || 'DEF';
  $('optDesc').value = d.meta?.description || (d.title || '').replace(/\s+/g, '-');
  renderDraftPreview();
  renderCompleteness();
  renderJesusWeptMeter();
  snapshotDraftVersion(draftId, d.content || '');
  renderVersionHistory();
  renderWorkflowQuickActions();
}

function initEditorResizer() {
  const layout = $('layoutRoot');
  const resizer = $('editorResizer');
  if (!layout || !resizer) return;

  const minWidth = 280;
  const maxWidth = 760;
  const clamp = (n) => Math.max(minWidth, Math.min(maxWidth, n));
  const setWidth = (n) => {
    const next = clamp(n);
    layout.style.setProperty('--editor-col-width', `${next}px`);
    try { localStorage.setItem('editor-col-width', String(next)); } catch { /* ignore */ }
  };

  try {
    const stored = Number(localStorage.getItem('editor-col-width') || 0);
    if (stored) setWidth(stored);
  } catch { /* ignore */ }

  let dragging = false;
  const onMove = (clientX) => {
    const rect = layout.getBoundingClientRect();
    const rightWidth = rect.right - clientX;
    setWidth(rightWidth);
  };

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  resizer.addEventListener('pointerdown', (e) => {
    if (window.matchMedia('(max-width: 1100px)').matches) return;
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    resizer.setPointerCapture?.(e.pointerId);
    onMove(e.clientX);
  });

  resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    onMove(e.clientX);
  });
  resizer.addEventListener('pointerup', stop);
  resizer.addEventListener('pointercancel', stop);

  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = Number(getComputedStyle(layout).getPropertyValue('--editor-col-width').replace('px', '').trim()) || 340;
    const delta = e.key === 'ArrowLeft' ? 24 : -24;
    setWidth(cur + delta);
  });
}

function initLeftResizer() {
  const layout = $('layoutRoot');
  const resizer = $('leftResizer');
  if (!layout || !resizer) return;

  const minWidth = 180;
  const maxWidth = 420;
  const clamp = (n) => Math.max(minWidth, Math.min(maxWidth, n));
  const setWidth = (n) => {
    const next = clamp(n);
    layout.style.gridTemplateColumns = `${next}px minmax(0, 1fr) minmax(280px, var(--editor-col-width))`;
    try { localStorage.setItem('left-col-width', String(next)); } catch { /* ignore */ }
  };

  try {
    const stored = Number(localStorage.getItem('left-col-width') || 0);
    if (stored) setWidth(stored);
  } catch { /* ignore */ }

  let dragging = false;
  const onMove = (clientX) => {
    const rect = layout.getBoundingClientRect();
    const leftWidth = clientX - rect.left;
    setWidth(leftWidth);
  };

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  resizer.addEventListener('pointerdown', (e) => {
    if (window.matchMedia('(max-width: 1100px)').matches) return;
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    resizer.setPointerCapture?.(e.pointerId);
    onMove(e.clientX);
  });

  resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    onMove(e.clientX);
  });
  resizer.addEventListener('pointerup', stop);
  resizer.addEventListener('pointercancel', stop);
}

// ── Attachments ─────────────────────────────────────────────────────────────
function renderAttachmentChips() {
  const container = $('attachmentChips');
  if (!container) return;
  container.innerHTML = '';
  for (const att of state.pendingAttachments) {
    const chip = document.createElement('span');
    chip.className = `att-chip${att.uploading ? ' att-chip--uploading' : ''}`;
    const icon = att.isImage ? '\u{1F5BC}' : '\u{1F4C4}';
    chip.innerHTML = `${icon} ${escapeHtml(att.filename)}`;
    if (!att.uploading) {
      const rm = document.createElement('button');
      rm.className = 'att-chip__remove';
      rm.innerHTML = '&times;';
      rm.onclick = () => { removeAttachment(att.id); };
      chip.appendChild(rm);
    }
    container.appendChild(chip);
  }
}

function removeAttachment(attId) {
  state.pendingAttachments = state.pendingAttachments.filter((a) => a.id !== attId);
  renderAttachmentChips();
}

function clearPendingAttachments() {
  state.pendingAttachments = [];
  renderAttachmentChips();
}

async function uploadFile(file) {
  if (!file) return;
  const maxSize = 15 * 1024 * 1024;
  if (file.size > maxSize) {
    showToast(`File too large: ${file.name} (${Math.round(file.size / 1024 / 1024)}MB max 15MB)`, { type: 'error' });
    return;
  }

  const placeholder = {
    id: `pending_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
    isImage: file.type.startsWith('image/'),
    uploading: true,
  };
  state.pendingAttachments.push(placeholder);
  renderAttachmentChips();

  try {
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });

    const resp = await api('/api/attachments', {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        data: dataBase64,
        conversationId: state.activeConversationId || null,
      }),
    });

    const idx = state.pendingAttachments.findIndex((a) => a.id === placeholder.id);
    if (idx >= 0 && resp?.attachment) {
      state.pendingAttachments[idx] = {
        id: resp.attachment.id,
        filename: resp.attachment.originalFilename || resp.attachment.filename,
        contentType: resp.attachment.contentType,
        isImage: resp.attachment.isImage,
        uploading: false,
      };
    } else if (idx >= 0) {
      state.pendingAttachments.splice(idx, 1);
    }
  } catch (err) {
    showToast(`Upload failed: ${err.message}`, { type: 'error' });
    state.pendingAttachments = state.pendingAttachments.filter((a) => a.id !== placeholder.id);
  }
  renderAttachmentChips();
}

async function handleFileSelection(files) {
  for (const file of Array.from(files)) {
    await uploadFile(file);
  }
}

async function sendMessage(e) {
  e.preventDefault();
  if (!state.activeConversationId) return;

  let content = $('messageInput').value.trim();
  const hasReadyAttachments = state.pendingAttachments.some((a) => !a.uploading);
  if (!content && !hasReadyAttachments) return;
  if (!content && hasReadyAttachments) {
    const names = state.pendingAttachments.filter((a) => !a.uploading).map((a) => a.filename).join(', ');
    content = `Please review the attached: ${names}`;
  }

  if (content.startsWith('/')) {
    $('messageInput').value = '';
    hideSlashCommandMenu();
    await runCommandCenterCommand(content);
    return;
  }

  if (state.streaming) {
    showToast('Please wait for the current response to finish.', { type: 'info', duration: 2500 });
    return;
  }
  state.streaming = true;
  const abortCtrl = new AbortController();
  state.abortController = abortCtrl;

  const sendBtn = $('composer').querySelector('[type="submit"]');
  sendBtn.disabled = false;
  sendBtn.classList.add('btn--sending', 'btn--stop');
  sendBtn.textContent = 'Stop';
  sendBtn.onclick = (ev) => { ev.preventDefault(); abortCtrl.abort(); };
  $('messageInput').value = '';

  // Collect ready attachments and clear pending
  const readyAttachments = state.pendingAttachments.filter((a) => !a.uploading && a.id);
  const attachmentIds = readyAttachments.map((a) => a.id);
  clearPendingAttachments();

  const mode = inferModeFromContent(content);
  const useAI = true;

  const applyToDraft = shouldApplyToDraft({ content, mode });
  const draftId = applyToDraft ? state.activeDraftId : null;
  const draftBeforeUpdate = applyToDraft ? ($('draftContent').value || '') : '';

  try {
    const wrap = $('messages');
    const nowIso = new Date().toISOString();

    const localUser = {
      id: `local_${Date.now()}_user`,
      conversationId: state.activeConversationId,
      role: 'user',
      content,
      createdAt: nowIso,
      meta: readyAttachments.length
        ? { attachments: readyAttachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, isImage: a.isImage })) }
        : undefined,
    };
    state.messages.push(localUser);
    wrap.appendChild(makeMessageEl(localUser));

    const localAsst = {
      id: `local_${Date.now()}_assistant`,
      conversationId: state.activeConversationId,
      role: 'assistant',
      content: '_Thinking…_',
      createdAt: new Date().toISOString(),
      meta: { streaming: true, mode },
    };
    state.messages.push(localAsst);
    const asstEl = makeMessageEl(localAsst);
    wrap.appendChild(asstEl);
    wrap.scrollTop = wrap.scrollHeight;

    const asstContentEl = asstEl.querySelector('.msg__content');
    let asstText = localAsst.content;
    let started = false;
    let scheduled = false;
    const scheduleRender = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        asstContentEl.innerHTML = renderMarkdown(asstText);
        wrap.scrollTop = wrap.scrollHeight;
      });
    };

    scheduleRender();

    let donePayload = null;
    try {
      const respondingToIdx = inferRespondingToIdx(content);
      await postMessageStream({
        conversationId: state.activeConversationId,
        body: { content, mode, useAI, applyToDraft, draftId, respondingToIdx, attachmentIds },
        signal: abortCtrl.signal,
        onEvent: (ev, data) => {
          if (ev === 'delta' && data?.text) {
            if (!started) {
              started = true;
              asstText = '';
            }
            asstText += data.text;
            scheduleRender();
          }
          if (ev === 'done') donePayload = data;
        },
      });
    } catch (abortErr) {
      if (abortErr.name === 'AbortError') {
        asstText += '\n\n_(stopped by user)_';
        scheduleRender();
        showToast('Response stopped.', { type: 'info', duration: 2000 });
      } else {
        throw abortErr;
      }
    }

    clearComposerHint();

    await refreshState();
    if (donePayload?.draft?.id) {
      setActiveDraft(donePayload.draft.id);
      if (applyToDraft) {
        setEditorView('preview');
        const preview = $('draftPreview');
        if (preview) preview.scrollTop = 0;
        const afterWords = countWords($('draftContent').value || '');
        const beforeWords = countWords(draftBeforeUpdate);
        const delta = afterWords - beforeWords;
        const deltaTxt = delta === 0 ? 'word count unchanged' : `${delta > 0 ? '+' : ''}${delta} words`;
        showToast(`Draft updated. Preview opened (${deltaTxt}).`, { type: 'success', duration: 2600 });
      }
    }
  } catch (err) {
    console.error('sendMessage error:', err);
    $('messageInput').value = content;
    try { await refreshState(); } catch { /* ignore */ }
  } finally {
    state.streaming = false;
    state.abortController = null;
    sendBtn.onclick = null;
    sendBtn.disabled = false;
    sendBtn.classList.remove('btn--sending', 'btn--stop');
    sendBtn.textContent = 'Send';
  }
}

async function newConversation() {
  const title = `Drafting ${state.conversations.length + 1}`;
  const created = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ title }) });
  state.activeConversationId = created.conversation.id;
  await refreshState();
}

async function saveDraftToCase() {
  if (!state.activeDraftId) return;

  const d = state.drafts.find((x) => x.id === state.activeDraftId);
  if (!d) return;

  const newContent = $('draftContent').value;
  const payload = {};
  const advancedOpen = !$('advancedSaveBox').classList.contains('is-hidden');
  if (advancedOpen) {
    payload.date = $('optDate').value.trim();
    payload.idxNum = $('optIdx').value.trim() || null;
    payload.docType = $('optDocType').value;
    payload.party = $('optParty').value;
    payload.description = $('optDesc').value.trim() || d.title;
  }

  // Persist content first (server-side save reads from draft content)
  await api(`/api/drafts/${d.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ content: newContent, meta: advancedOpen ? payload : undefined }),
  });

  const saved = await api(`/api/drafts/${d.id}/save`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  $('saveStatus').textContent = `Saved as: ${saved.draft.saved.path}`;
  await refreshState();
  setActiveDraft(d.id);
}

function highlightTerms(text, query) {
  const safe = escapeHtml(String(text || ''));
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(t => t.length >= 2);
  if (!terms.length) return safe;
  const re = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

function fileKindBadge(filePath) {
  const p = String(filePath || '');
  if (p.startsWith('05_Court_Orders')) return { label: 'Order', cls: 'sr__badge--order' };
  if (p.startsWith('01_Pleadings')) return { label: 'Pleading', cls: 'sr__badge--pleading' };
  if (p.startsWith('02_Motions')) return { label: 'Motion', cls: 'sr__badge--motion' };
  if (p.startsWith('07_Research')) return { label: 'Research', cls: 'sr__badge--research' };
  if (p.startsWith('00_Case_Overview')) return { label: 'Overview', cls: 'sr__badge--overview' };
  if (p.startsWith('04_Evidence')) return { label: 'Evidence', cls: 'sr__badge--evidence' };
  if (p.startsWith('06_Correspondence')) return { label: 'Corr.', cls: 'sr__badge--corr' };
  if (p.endsWith('.pdf')) return { label: 'PDF', cls: 'sr__badge--pdf' };
  return { label: 'File', cls: '' };
}

function clearSearch() {
  $('searchInput').value = '';
  $('searchMeta').textContent = '';
  $('searchClearBtn').classList.add('is-hidden');
  $('searchResults').innerHTML = `<div class="onboard">
    <div class="onboard__title">Search</div>
    <p>Searches across <strong>all case folders</strong>: pleadings, motions, court orders, evidence, research memos, correspondence, and case overview docs. PDFs are searched by filename and extracted text.</p>
    <p>Results are <strong>ranked by relevance</strong> — the most on-point documents appear first.</p>
    <p>Type a keyword or phrase above and hit <kbd>Search</kbd> or press <kbd>Enter</kbd>.</p>
    <p class="onboard__examples"><strong>Try:</strong> "standing", "Rule 17", "substitution", "summary judgment", "Intrepid", "POA"</p>
  </div>`;
  $('searchInput').focus();
}

async function doSearch() {
  const q = $('searchInput').value.trim();
  const out = $('searchResults');
  const meta = $('searchMeta');
  out.innerHTML = '';
  meta.textContent = '';
  if (!q) return;

  meta.textContent = 'Searching…';
  const data = await api(`/api/search?q=${encodeURIComponent(q)}`, { method: 'GET' });
  const results = data.results || [];

  $('searchClearBtn').classList.remove('is-hidden');
  meta.textContent = results.length ? `${results.length} result${results.length === 1 ? '' : 's'} for "${q}"` : '';
  out.innerHTML = '';

  if (!results.length) {
    out.innerHTML = `<div class="sr__empty">No results for "<strong>${escapeHtml(q)}</strong>". Try broader terms or check spelling.</div>`;
    return;
  }

  for (const r of results) {
    const card = document.createElement('div');
    card.className = 'sr';

    const badge = fileKindBadge(r.path);
    const score = r.score != null ? Math.round(r.score * 100) : null;

    // Header row: badge + path + score
    const header = document.createElement('div');
    header.className = 'sr__header';
    header.innerHTML = `<span class="sr__badge ${badge.cls}">${badge.label}</span>`
      + `<span class="sr__path">${escapeHtml(r.path)}</span>`
      + (score != null ? `<span class="sr__score">${score}%</span>` : '');
    card.appendChild(header);

    // Snippet with highlighting
    const snippet = document.createElement('div');
    snippet.className = 'sr__snippet';
    const snippetText = String(r.snippet || '').slice(0, 500);
    snippet.innerHTML = highlightTerms(snippetText, q);
    card.appendChild(snippet);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'sr__actions';

    const insertBtn = document.createElement('button');
    insertBtn.className = 'btn btn--sm';
    insertBtn.textContent = 'Quote in Chat';
    insertBtn.onclick = () => {
      const cur = $('messageInput').value;
      $('messageInput').value = (cur + `\n\n> [${r.path}]\n> ${snippetText.slice(0, 300)}\n`).trim();
      setTab('chat');
      $('messageInput').focus();
      showToast('Quoted to composer', { type: 'success', duration: 1500 });
    };
    actions.appendChild(insertBtn);

    const memoBtn = document.createElement('button');
    memoBtn.className = 'btn btn--sm';
    memoBtn.textContent = 'Save as draft';
    memoBtn.onclick = async () => {
      if (!state.activeConversationId) return;
      const content = [`# Reference: ${r.path}`, '', r.snippet].join('\n');
      const created = await api('/api/drafts', {
        method: 'POST',
        body: JSON.stringify({
          conversationId: state.activeConversationId,
          content,
          meta: { docType: 'MEMO', party: 'DEF', description: 'Research-Excerpt' },
        }),
      });
      await refreshState();
      setActiveDraft(created.draft.id);
      showToast('Saved as draft', { type: 'success', duration: 1500 });
    };
    actions.appendChild(memoBtn);

    card.appendChild(actions);
    out.appendChild(card);
  }
}

async function loadCaseSummary() {
  const container = $('caseSummary');
  container.innerHTML = '<div class="cs__loading">Loading case data…</div>';
  const data = await api('/api/case/summary');
  container.innerHTML = '';
  if (!data.ok) {
    container.innerHTML = `<div class="cs__empty">${escapeHtml(data.reason || 'Unavailable')}</div>`;
    return;
  }
  renderCaseSummary(data, container);
}

function renderCaseSummary(data, el) {
  const h = escapeHtml;
  const p = [];
  const c = data.counts || {};

  // ── Header
  p.push('<div class="cs__header">');
  p.push(`<div class="cs__title">${window.__caseConfig?.titleShort || 'Case Summary'}</div>`);
  p.push(`<div class="cs__subtitle">${window.__caseConfig?.number || ''} · ${window.__caseConfig?.court || ''}</div>`);
  p.push('</div>');

  // ── Stats row
  p.push('<div class="cs__stats">');
  p.push(`<div class="cs__stat"><span class="cs__stat-num">${c.court_events || 0}</span><span class="cs__stat-label">Docket Entries</span></div>`);
  p.push(`<div class="cs__stat"><span class="cs__stat-num">${c.court_hearings || 0}</span><span class="cs__stat-label">Hearings</span></div>`);
  p.push(`<div class="cs__stat"><span class="cs__stat-num">${c.documents || 0}</span><span class="cs__stat-label">Documents</span></div>`);
  p.push(`<div class="cs__stat"><span class="cs__stat-num">${c.documents_with_pdf || 0}</span><span class="cs__stat-label">PDFs on File</span></div>`);
  p.push('</div>');

  // ── Upcoming Hearings
  const hearings = (data.recentHearings || []).filter(hr => {
    const d = hr.hearing_date;
    const desc = String(hr.description || hr.hearing_type || '').toUpperCase();
    return d >= new Date().toISOString().slice(0, 10) && !desc.includes('CANCELED');
  });
  if (hearings.length) {
    p.push('<div class="cs__section">');
    p.push('<h3 class="cs__heading">Upcoming Hearings</h3>');
    for (const hr of hearings) {
      const dt = hr.hearing_date;
      const daysOut = Math.ceil((new Date(dt + 'T00:00:00') - new Date()) / 86400000);
      const urgency = daysOut <= 7 ? 'urgent' : daysOut <= 21 ? 'soon' : 'normal';
      const hrDesc = hr.description || hr.hearing_type || '';
      p.push(`<div class="cs__event cs__event--${urgency}">`);
      p.push(`<span class="cs__event-date">${h(dt)}</span>`);
      if (daysOut >= 0) p.push(`<span class="cs__event-days">${daysOut}d</span>`);
      p.push(`<span class="cs__event-desc">${h(hrDesc)}</span>`);
      p.push(`<button class="btn btn--sm btn--primary" onclick="startHearingPrep(this)" data-hearing-date="${h(dt)}" data-hearing-desc="${h(hrDesc)}">Prep</button>`);
      p.push('</div>');
    }
    p.push('</div>');
  }

  // ── Recent Docket Activity
  const events = data.recentEvents || [];
  if (events.length) {
    p.push('<div class="cs__section">');
    p.push('<h3 class="cs__heading">Recent Docket Activity</h3>');
    for (const ev of events.slice(0, 12)) {
      const who = String(ev.description || '').toUpperCase();
      const party = who.includes('DEF') ? 'def' : who.includes('PLT') || who.includes('PLAINTIFF') ? 'plt' : '';
      p.push(`<div class="cs__event">`);
      p.push(`<span class="cs__event-date">${h(ev.event_date || '')}</span>`);
      p.push(`<span class="cs__event-idx">#${ev.index_num || '?'}</span>`);
      if (party) p.push(`<span class="cs__event-party cs__event-party--${party}">${party.toUpperCase()}</span>`);
      p.push(`<span class="cs__event-desc">${h(ev.description || '')}</span>`);
      p.push('</div>');
    }
    p.push('</div>');
  }

  el.innerHTML = p.join('');
}

async function loadIntelligence() {
  const meta = $('intelMeta');
  const dash = $('intelDashboard');
  meta.textContent = 'Loading…';
  dash.innerHTML = '';
  try {
    const data = await api('/api/case/intelligence');
    meta.textContent = '';
    if (!data.ok) {
      dash.innerHTML = `<div class="intel__empty">${escapeHtml(data.reason || 'No data')}</div>`;
      return;
    }
    renderIntelDashboard(data, dash);
  } catch (e) {
    meta.textContent = '';
    dash.innerHTML = `<div class="intel__empty">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderIntelDashboard(data, container) {
  const h = escapeHtml;
  const p = [];

  const cd = data.contested?.def || {};
  const cp = data.contested?.plt || {};
  const pending = data.contested?.pending || [];
  const procPlt = data.procedural?.plt || {};
  const procDef = data.procedural?.def || {};
  const continuances = data.procedural?.continuances || [];
  const judges = data.judges || {};
  const modelFiling = data.modelFiling || [];

  // ── Contested Overview
  p.push('<div class="intel__section intel__section--winrates">');
  p.push('<h3 class="intel__heading">Contested Motions — Win Rates</h3>');
  if (cd.total > 0) {
    const pct = Math.round((cd.granted / cd.total) * 100);
    p.push('<div class="intel__stat-row">');
    p.push(`<span class="intel__label">DEF Win Rate</span>`);
    p.push(`<span class="intel__value intel__value--${pct > 25 ? 'ok' : 'bad'}">${cd.granted}/${cd.total} (${pct}%)</span>`);
    p.push('</div>');
    p.push(`<div class="intel__bar"><div class="intel__bar-fill intel__bar-fill--${pct > 25 ? 'ok' : 'bad'}" style="width:${Math.max(4, pct)}%"></div></div>`);
  }
  if (cp.total > 0) {
    const ppct = Math.round((cp.granted / cp.total) * 100);
    p.push('<div class="intel__stat-row">');
    p.push(`<span class="intel__label">PLT Win Rate</span>`);
    p.push(`<span class="intel__value intel__value--${ppct > 50 ? 'bad' : 'ok'}">${cp.granted}/${cp.total} (${ppct}%)</span>`);
    p.push('</div>');
    p.push(`<div class="intel__bar"><div class="intel__bar-fill intel__bar-fill--${ppct > 50 ? 'bad' : 'ok'}" style="width:${Math.max(4, ppct)}%"></div></div>`);
  }
  p.push('</div>');

  // ── Model Filings (What Worked)
  if (modelFiling.length) {
    p.push('<div class="intel__section intel__section--model">');
    p.push('<h3 class="intel__heading">DEF Wins — What Worked</h3>');
    for (const mf of modelFiling) {
      p.push('<div class="intel__card intel__card--granted">');
      p.push(`<div class="intel__card-title">${h(mf.idx)}: ${h(mf.description)}</div>`);
      if (mf.what_worked) p.push(`<div class="intel__card-detail">${h(mf.what_worked)}</div>`);
      if (mf.lesson) p.push(`<div class="intel__card-lesson">${h(mf.lesson)}</div>`);
      p.push('</div>');
    }
    p.push('</div>');
  }

  // ── Judge Profiles (all filings, not just contested)
  if (Object.keys(judges).length) {
    p.push('<div class="intel__section">');
    p.push('<h3 class="intel__heading">Judge Profiles</h3>');
    for (const [name, j] of Object.entries(judges).sort((a, b) => b[1].total - a[1].total)) {
      const gPct = j.total > 0 ? Math.round((j.granted / j.total) * 100) : 0;
      p.push('<div class="intel__judge">');
      p.push(`<div class="intel__judge-name">${h(name)}</div>`);
      p.push('<div class="intel__stat-row">');
      p.push(`<span class="intel__label">Grant rate (all)</span>`);
      p.push(`<span class="intel__value">${j.granted}/${j.total} (${gPct}%)</span>`);
      p.push('</div>');
      p.push(`<div class="intel__bar"><div class="intel__bar-fill intel__bar-fill--${gPct > 40 ? 'ok' : gPct > 15 ? 'neutral' : 'bad'}" style="width:${Math.max(4, gPct)}%"></div></div>`);
      if (j.contested) p.push(`<div class="intel__detail">Contested: ${j.contested} | Procedural: ${j.procedural || 0}</div>`);

      const granted = (j.filings || []).filter((f) => f.outcome === 'granted');
      const denied = (j.filings || []).filter((f) => f.outcome === 'denied');
      if (granted.length) {
        p.push('<div class="intel__detail intel__detail--granted">');
        for (const f of granted) {
          const badge = f.filed_by === 'DEF' ? 'def' : 'plt';
          p.push(`<span class="intel__badge intel__badge--${badge}">${h(f.filed_by)}</span> ${h(f.idx)} — ${h(f.description)}${f.date ? ` (${h(f.date)})` : ''}<br>`);
        }
        p.push('</div>');
      }
      if (denied.length > 4) {
        p.push(`<div class="intel__detail intel__detail--denied">Denied ${denied.length} motions (batch-filed, multi-issue — all DEF early filings)</div>`);
      } else if (denied.length) {
        p.push('<div class="intel__detail intel__detail--denied">');
        for (const f of denied) {
          p.push(`${h(f.idx)} — ${h(f.description)}<br>`);
        }
        p.push('</div>');
      }
      p.push('</div>');
    }
    p.push('</div>');
  }

  // ── Continuance Pattern
  if (continuances.length) {
    const pltConts = continuances.filter((c) => c.filed_by === 'PLT');
    const defConts = continuances.filter((c) => c.filed_by === 'DEF');
    p.push('<div class="intel__section">');
    p.push('<h3 class="intel__heading">Continuance History</h3>');
    if (pltConts.length) {
      p.push(`<div class="intel__detail"><strong>PLT: ${pltConts.length} continuances</strong> (${pltConts.filter((c) => c.outcome === 'granted').length} granted)</div>`);
    }
    if (defConts.length) {
      p.push(`<div class="intel__detail"><strong>DEF: ${defConts.length} continuance(s)</strong> (${defConts.filter((c) => c.outcome === 'granted').length} granted)</div>`);
    }
    for (const c of continuances) {
      const badge = c.filed_by === 'DEF' ? 'def' : 'plt';
      p.push('<div class="intel__card intel__card--pending">');
      p.push(`<span class="intel__badge intel__badge--${badge}">${h(c.filed_by)}</span> `);
      p.push(`<strong>${h(c.idx)}</strong>: ${h(c.description)}`);
      const meta = [];
      if (c.outcome) meta.push(c.outcome);
      if (c.judge) meta.push(`Judge ${c.judge}`);
      if (c.date) meta.push(c.date);
      if (meta.length) p.push(`<div class="intel__card-meta">${h(meta.join(' · '))}</div>`);
      if (c.lesson) p.push(`<div class="intel__card-lesson">${h(c.lesson)}</div>`);
      p.push('</div>');
    }
    p.push('</div>');
  }

  // ── Procedural Summary
  if (procPlt.total > 0 || procDef.total > 0) {
    p.push('<div class="intel__section">');
    p.push('<h3 class="intel__heading">Procedural Filing Summary</h3>');
    if (procPlt.total) p.push(`<div class="intel__detail">PLT procedural: ${procPlt.granted}/${procPlt.total} granted</div>`);
    if (procDef.total) {
      p.push(`<div class="intel__detail">DEF procedural: ${procDef.granted}/${procDef.total} granted`);
      if (procDef.denied) p.push(` | ${procDef.denied} denied`);
      p.push('</div>');
    }
    p.push('</div>');
  }

  // ── Pending Contested Motions
  if (pending.length) {
    p.push('<div class="intel__section">');
    p.push('<h3 class="intel__heading">Pending Contested Motions</h3>');
    for (const m of pending) {
      p.push('<div class="intel__card intel__card--pending">');
      p.push(`<span class="intel__badge intel__badge--${m.filed_by === 'DEF' ? 'def' : 'plt'}">${h(m.filed_by)}</span> `);
      p.push(`<strong>${h(m.idx)}</strong>: ${h(m.description)}`);
      if (m.notes) p.push(`<div class="intel__card-meta">${h(m.notes)}</div>`);
      p.push('</div>');
    }
    p.push('</div>');
  }

  // ── Drafting Directive
  p.push('<div class="intel__section intel__section--directive">');
  p.push('<h3 class="intel__heading">Drafting Directive</h3>');
  p.push('<ul class="intel__rules">');
  p.push('<li><strong>ONE issue. ONE rule. ONE ask.</strong> Under 350 words body.</li>');
  p.push('<li><strong>Never batch-file.</strong> Each motion must stand alone.</li>');
  p.push('<li><strong>Jesus Wept format</strong> for oral argument. Lead with the procedural violation.</li>');
  p.push('<li><strong>Judge Walczyk:</strong> She batch-processes. Your Cutoff version may be all you get.</li>');
  p.push('<li><strong>Judge Davidian / Williams:</strong> Assigned to continuance orders. Granted PLT amendments — watch for pro-plaintiff lean on dispositive motions.</li>');
  p.push('</ul>');
  p.push('</div>');

  container.innerHTML = p.join('\n');
}

// ── Deadline Tracker ────────────────────────────────────────────────────────
function classifyDeadlineWorkType(deadline) {
  const text = [
    deadline?.description || '',
    deadline?.rule_reference || '',
    deadline?.notes || '',
  ].join(' ').toLowerCase();

  if (/\bhearing\b/.test(text)) return 'hearing';
  if (/\b(answer|response|reply|objection|motion|memorand\w*|brief|affidavit|declaration|pre\s*trial|jury instructions?|exhibit list|witness list)\b/.test(text)) return 'filing';
  if (/\b(proposed order|draft order|order form)\b/.test(text)) return 'order';
  if (/\b(email|service|serve|mail|administrator|trial court administrator|clerk)\b/.test(text)) return 'communication';
  return 'general';
}

function inferDeadlineDraftMeta(deadline) {
  const text = [deadline?.description || '', deadline?.rule_reference || ''].join(' ').toLowerCase();
  if (/\banswer\b/.test(text)) return { docType: 'ANS', party: 'DEF', description: 'Answer-to-Amended-Complaint' };
  if (/\bobjection\b/.test(text)) return { docType: 'RESP', party: 'DEF', description: 'Objection-to-Proposed-Order' };
  if (/\bmotion\b/.test(text)) return { docType: 'MOT', party: 'DEF', description: 'Motion-for-Deadline-Relief' };
  if (/\baffidavit\b|\bdeclaration\b/.test(text)) return { docType: 'AFF', party: 'DEF', description: 'Supporting-Affidavit' };
  if (/\bmemorand\w*\b|\bbrief\b/.test(text)) return { docType: 'MEMO', party: 'DEF', description: 'Memorandum-for-Deadline' };
  return { docType: 'MEMO', party: 'DEF', description: 'Deadline-Strategy-Memo' };
}

function buildDeadlineWorkPrompt(deadline, { createDraft = false } = {}) {
  const label = deadline.daysUntil < 0 ? `${Math.abs(deadline.daysUntil)} days overdue`
    : deadline.daysUntil === 0 ? 'due today'
    : `due in ${deadline.daysUntil} days`;
  const type = classifyDeadlineWorkType(deadline);

  return [
    'Work this deadline now with concrete next steps.',
    '',
    `DEADLINE: ${deadline.description}`,
    `DUE DATE: ${deadline.due_date} (${label})`,
    `PRIORITY: ${deadline.priority || 'unspecified'}`,
    `SOURCE: ${deadline.triggered_by || 'not provided'}`,
    `RULE: ${deadline.rule_reference || 'not provided'}`,
    `NOTES: ${deadline.notes || 'none'}`,
    `WORK TYPE: ${type}`,
    '',
    'Return in this exact structure:',
    '1) Immediate actions (today / next 24h / before deadline)',
    '2) Best path in this court: filing, communication, both, or monitor (with one-sentence reason)',
    '3) If communication is needed, provide a ready-to-send email draft (e.g., trial court administrator if appropriate)',
    '4) If a filing is needed, specify the exact filing title and governing rule',
    '5) Risks if missed and fallback plan',
    '',
    createDraft
      ? 'An open draft is ready. Update it with a complete, filing-ready first draft if filing relief is recommended.'
      : 'No draft is open yet. If filing relief is recommended, include a 5-8 line filing starter block I can convert to a draft.',
  ].join('\n');
}

async function ensureDeadlineConversation(deadline) {
  if (state.activeConversationId) return state.activeConversationId;
  const title = `Deadline ${deadline?.due_date || ''}`.trim() || 'Deadline Work';
  const created = await api('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  state.activeConversationId = created.conversation.id;
  await refreshState();
  return state.activeConversationId;
}

async function createDeadlineDraftShell(deadline) {
  const conversationId = await ensureDeadlineConversation(deadline);
  const meta = inferDeadlineDraftMeta(deadline);
  const title = String(meta.description || 'Deadline-Work').replace(/-/g, ' ');
  const content = [
    `# ${title}`,
    '',
    '## Deadline Context',
    `- Description: ${deadline.description || ''}`,
    `- Due date: ${deadline.due_date || ''}`,
    `- Triggered by: ${deadline.triggered_by || ''}`,
    `- Rule reference: ${deadline.rule_reference || ''}`,
    `- Notes: ${deadline.notes || ''}`,
    '',
    '## Draft',
    '',
  ].join('\n');

  const created = await api('/api/drafts', {
    method: 'POST',
    body: JSON.stringify({ conversationId, content, meta }),
  });

  await refreshState();
  setActiveDraft(created.draft.id);
  return created.draft;
}

async function startDeadlineWork(deadline, { createDraft = false } = {}) {
  if (!deadline || state.streaming) {
    if (state.streaming) showToast('Please wait for current response to finish.', { type: 'info', duration: 2200 });
    return;
  }

  await ensureDeadlineConversation(deadline);
  if (createDraft) {
    await createDeadlineDraftShell(deadline);
  }

  setTab('chat');
  setComposerHint({ mode: 'draft' });

  $('messageInput').value = buildDeadlineWorkPrompt(deadline, { createDraft: Boolean(createDraft && state.activeDraftId) });
  await sendMessage({ preventDefault() {} });
}

function inferContinuanceDeadline(deadlines) {
  const list = Array.isArray(deadlines) ? deadlines : [];
  if (!list.length) return null;
  const scored = list
    .map((d) => {
      const text = `${d?.description || ''} ${d?.rule_reference || ''} ${d?.notes || ''}`.toLowerCase();
      const formCue = /calendar request|session|continuance|hearing|trial|9c/.test(text) ? 100 : 0;
      const urgency = typeof d?.daysUntil === 'number' ? Math.max(0, 30 - Math.min(30, d.daysUntil)) : 0;
      return { deadline: d, score: formCue + urgency };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.deadline || null;
}

function shouldOfferContinuanceForm(deadline) {
  const text = `${deadline?.description || ''} ${deadline?.rule_reference || ''} ${deadline?.notes || ''}`.toLowerCase();
  return /calendar request|session|continuance|hearing|trial|9c/.test(text);
}

async function startContinuanceForm(deadline, { reason = '' } = {}) {
  const fallback = deadline || { due_date: '', description: 'Continuance workflow', rule_reference: '', notes: '' };
  const conversationId = await ensureDeadlineConversation(fallback);
  const payload = {
    conversationId,
    deadline: deadline || null,
    reason: String(reason || '').trim(),
  };
  const result = await api('/api/forms/continuance-quick-fill', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  await refreshState();
  if (result?.draft?.id) {
    setActiveDraft(result.draft.id);
    setEditorView('preview');
  }
  return result;
}

async function startDeadlineEmail(deadline) {
  if (!deadline || state.streaming) {
    if (state.streaming) showToast('Please wait for current response to finish.', { type: 'info', duration: 2200 });
    return;
  }

  await ensureDeadlineConversation(deadline);
  setTab('chat');
  setComposerHint({ mode: 'draft' });
  $('messageInput').value = buildDeadlineEmailPrompt(deadline);
  await sendMessage({ preventDefault() {} });
}

async function loadDeadlines() {
  const container = $('deadlinesContainer');
  if (!container) return;
  try {
    const data = await api('/api/case/deadlines');
    if (!data.ok || !data.deadlines?.length) {
      container.innerHTML = '<div class="dl__empty">No deadlines</div>';
      return;
    }
    container.innerHTML = '';
    for (const d of data.deadlines) {
      const item = document.createElement('div');
      item.className = `dl__item dl__item--${d.urgency}`;
      const label = d.daysUntil < 0 ? `${Math.abs(d.daysUntil)}d overdue`
        : d.daysUntil === 0 ? 'TODAY'
        : `${d.daysUntil}d`;
      const summary = document.createElement('div');
      summary.className = 'dl__summary';
      summary.innerHTML = `<span class="dl__badge">${escapeHtml(label)}</span><span class="dl__text">${escapeHtml(d.description)}</span><span class="dl__date">${escapeHtml(d.due_date)}</span>`;
      item.appendChild(summary);

      const detail = document.createElement('div');
      detail.className = 'dl__detail';
      const detailParts = [`<strong>${escapeHtml(d.description)}</strong>`];
      detailParts.push(`Date: ${escapeHtml(d.due_date)} (${escapeHtml(label)})`);
      if (d.triggered_by) detailParts.push(`Source: ${escapeHtml(d.triggered_by)}`);
      if (d.rule_reference) detailParts.push(`Rule: ${escapeHtml(d.rule_reference)}`);
      if (d.notes) detailParts.push(`${escapeHtml(d.notes)}`);
      if (d.priority) detailParts.push(`Priority: ${escapeHtml(d.priority)}`);
      detail.innerHTML = detailParts.join('<br>');

      const actions = document.createElement('div');
      actions.className = 'dl__actions';

      const workBtn = document.createElement('button');
      workBtn.className = 'btn btn--sm';
      workBtn.textContent = 'Work on this';
      workBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await startDeadlineWork(d, { createDraft: false });
      });

      const draftBtn = document.createElement('button');
      draftBtn.className = 'btn btn--sm btn--primary';
      draftBtn.textContent = 'Create draft';
      draftBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await startDeadlineWork(d, { createDraft: true });
      });

      const emailBtn = document.createElement('button');
      emailBtn.className = 'btn btn--sm';
      emailBtn.textContent = 'Draft email';
      emailBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await startDeadlineEmail(d);
      });

      actions.appendChild(workBtn);
      actions.appendChild(draftBtn);
      actions.appendChild(emailBtn);

      if (shouldOfferContinuanceForm(d)) {
        const contBtn = document.createElement('button');
        contBtn.className = 'btn btn--sm';
        contBtn.textContent = 'Continuance form';
        contBtn.addEventListener('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          await startContinuanceForm(d);
        });
        actions.appendChild(contBtn);
      }

      detail.appendChild(actions);
      item.appendChild(detail);

      summary.addEventListener('click', () => {
        item.classList.toggle('dl__item--expanded');
      });
      container.appendChild(item);
    }
  } catch {
    container.innerHTML = '<div class="dl__empty">Error loading</div>';
  }
}

// ── Filing Completeness Checker ─────────────────────────────────────────────
function checkFilingCompleteness(content) {
  const text = String(content || '');
  const upper = text.toUpperCase();
  const checks = [
    { id: 'caption', label: 'Caption', pass: upper.includes('STATE OF NORTH CAROLINA') && upper.includes('GENERAL COURT OF JUSTICE'), hint: 'Add NC District Court caption block' },
    { id: 'title', label: 'Document title', pass: /DEFENDANT[''\u2019]?S\s+(MOTION|ANSWER|RESPONSE|REPLY|OPPOSITION|MEMORANDUM|BRIEF)/i.test(text) || /^#+ .+/m.test(text), hint: 'Add "DEFENDANT\'S [MOTION/ANSWER/RESPONSE] TO..."' },
    { id: 'signature', label: 'Signature block', pass: upper.includes('RESPECTFULLY SUBMITTED') || upper.includes(', PRO SE'), hint: 'Add "Respectfully submitted" + signature block' },
    { id: 'cos', label: 'Certificate of Service', pass: upper.includes('CERTIFICATE OF SERVICE'), hint: 'Add Certificate of Service with opposing counsel emails' },
    { id: 'reservation', label: 'Jurisdictional reservation', pass: upper.includes('EXPRESSLY PRESERVING') || upper.includes('JURISDICTIONAL RESERVATION') || upper.includes('WITHOUT WAIVING'), hint: 'Add jurisdictional reservation paragraph' },
    { id: 'wherefore', label: 'WHEREFORE clause', pass: upper.includes('WHEREFORE'), hint: 'Add WHEREFORE clause requesting specific relief' },
    { id: 'placeholders', label: 'No placeholders', pass: !/\[(?:TITLE|XX|ADDRESS|PHONE|DATE|NAME|INSERT|TODO|TBD)\]/i.test(text), hint: 'Replace all [PLACEHOLDER] brackets with actual content' },
  ];
  const bodyMatch = text.match(/(?:STATEMENT OF FACTS|ARGUMENT|NOW COMES)([\s\S]*?)(?:WHEREFORE|CERTIFICATE OF SERVICE|Respectfully submitted)/i);
  const bodyWords = bodyMatch ? bodyMatch[1].split(/\s+/).filter(Boolean).length : text.split(/\s+/).filter(Boolean).length;
  checks.push({ id: 'length', label: `Body ~${bodyWords} words (target ≤350)`, pass: bodyWords <= 400, hint: 'Tighten the argument — cut redundant sentences' });
  return checks;
}

function renderCompleteness() {
  const container = $('completenessChecklist');
  if (!container) return;
  const content = $('draftContent').value || '';
  if (!content.trim()) {
    container.innerHTML = '';
    return;
  }
  const checks = checkFilingCompleteness(content);
  const allPass = checks.every((c) => c.pass);
  const failing = checks.filter((c) => !c.pass);
  const parts = checks.map((c) => {
    let html = `<div class="ck__item ck__item--${c.pass ? 'pass' : 'fail'}"><span class="ck__icon">${c.pass ? '\u2713' : '\u2717'}</span> ${escapeHtml(c.label)}`;
    if (!c.pass && c.hint) html += `<span class="ck__hint">${escapeHtml(c.hint)}</span>`;
    html += '</div>';
    return html;
  });
  const header = `<div class="ck__header ck__header--${allPass ? 'pass' : 'warn'}">Filing Check: ${allPass ? 'Ready' : `${failing.length} issue${failing.length > 1 ? 's' : ''}`}</div>`;
  let fixBtn = '';
  if (!allPass) {
    fixBtn = '<button class="btn btn--sm ck__fix" id="ckFixBtn">Fix issues</button>';
  }
  container.innerHTML = header + parts.join('') + fixBtn;
  const fb = $('ckFixBtn');
  if (fb) {
    fb.onclick = () => {
      const issues = failing.map(c => c.hint || c.label).join('; ');
      const prompt = `Fix the following issues in this filing draft. Add or correct the missing elements, keeping the existing content intact:\n\n${issues}\n\nReturn the complete corrected filing.`;
      $('messageInput').value = prompt;
      setTab('chat');
      sendMessage(new Event('submit'));
    };
  }
}

function pushRedTeamToChat(analysis) {
  const wrap = $('messages');
  if (!wrap || !String(analysis || '').trim()) return;
  setTab('chat');
  const msg = {
    id: `local_${Date.now()}_redteam`,
    conversationId: state.activeConversationId,
    role: 'assistant',
    content: `## Red Team Analysis\n\n${analysis}`,
    createdAt: new Date().toISOString(),
    meta: { mode: 'draft' },
  };
  state.messages.push(msg);
  wrap.appendChild(makeMessageEl(msg));
  requestAnimationFrame(() => {
    wrap.scrollTop = wrap.scrollHeight;
  });
}

// ── Red Team Analysis ───────────────────────────────────────────────────────
async function runRedTeam() {
  if (!state.activeDraftId) return;
  const btn = $('redTeamBtn');
  const container = $('redTeamResult');
  if (!container || !btn) return;
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  let seconds = 0;
  const timer = setInterval(() => {
    seconds++;
    container.innerHTML = `<div class="rt__loading">Opposing counsel is reviewing your draft… (${seconds}s)</div>`;
  }, 1000);
  container.innerHTML = '<div class="rt__loading">Opposing counsel is reviewing your draft… (0s)</div>';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);
    const res = await fetch(`/api/drafts/${state.activeDraftId}/redteam`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (data.ok && data.analysis) {
      const analysis = String(data.analysis || '');
      const snippet = escapeHtml(analysis.replace(/\s+/g, ' ').trim().slice(0, 220));
      let resultHtml = '<div class="rt__card">';
      resultHtml += '<div class="rt__summary">';
      resultHtml += '<div class="rt__title">Red Team analysis ready</div>';
      resultHtml += `<div class="rt__snippet">${snippet}${analysis.length > 220 ? '…' : ''}</div>`;
      resultHtml += '</div>';
      resultHtml += '<div class="rt__actions">';
      resultHtml += '<button class="btn btn--sm" id="rtReviewChatBtn">Review in Chat</button>';
      resultHtml += '<button class="btn btn--sm" id="rtExpandBtn">Expand Here</button>';
      resultHtml += '<button class="btn btn--sm" id="rtRefineBtn">Refine Strategy</button>';
      resultHtml += '<button class="btn btn--sm" id="rtStrengthenBtn">Strengthen Filing</button>';
      resultHtml += '</div>';
      resultHtml += `<div class="rt__result prose is-hidden" id="rtInlineResult">${renderMarkdown(analysis)}</div>`;
      resultHtml += '</div>';
      container.innerHTML = resultHtml;

      const reviewChatBtn = $('rtReviewChatBtn');
      if (reviewChatBtn) {
        reviewChatBtn.onclick = () => {
          pushRedTeamToChat(analysis);
          showToast('Red Team moved to chat for side-by-side review', { type: 'info', duration: 2200 });
        };
      }

      const expandBtn = $('rtExpandBtn');
      if (expandBtn) {
        expandBtn.onclick = () => {
          const body = $('rtInlineResult');
          if (!body) return;
          const open = body.classList.toggle('is-hidden');
          expandBtn.textContent = open ? 'Expand Here' : 'Collapse';
        };
      }

      const refineBtn = $('rtRefineBtn');
      if (refineBtn) {
        refineBtn.onclick = () => {
          const prompt = `Based on this opposing counsel Red Team analysis of our filing:\n\n${analysis.slice(0, 3000)}\n\nRefine our strategy:\n1. What arguments should we STRENGTHEN in the written filing?\n2. What arguments are better saved as SURPRISES for oral argument?\n3. What procedural requirements must remain in writing to preserve our rights?\n4. What is our best ambush point that opposing counsel would not expect at hearing?\n5. Are we missing any critical authority (like Intrepid v. Amerex) that could change the outcome?`;
          $('messageInput').value = prompt;
          setTab('chat');
          sendMessage(new Event('submit'));
        };
      }
      const strengthenBtn = $('rtStrengthenBtn');
      if (strengthenBtn) {
        strengthenBtn.onclick = () => {
          const prompt = `Opposing counsel Red Team analysis found these weaknesses in our filing:\n\n${analysis.slice(0, 3000)}\n\nStrengthen the filing to address critical vulnerabilities WITHOUT telegraphing our strongest oral argument points. Fix procedural defects. Tighten citations. Keep our best surprises for the hearing.`;
          $('messageInput').value = prompt;
          setTab('chat');
          sendMessage(new Event('submit'));
        };
      }
    } else {
      container.innerHTML = `<div class="rt__error">Analysis failed: ${escapeHtml(data.error || 'Unknown error')}</div>`;
    }
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Request timed out after 5 minutes. Try again (the model may be busy) or shorten the draft before running Red Team.' : e.message;
    container.innerHTML = `<div class="rt__error">${escapeHtml(msg)}</div>`;
  } finally {
    clearInterval(timer);
    btn.disabled = false;
    btn.textContent = 'Red Team';
  }
}

// ── Jesus Wept Meter ────────────────────────────────────────────────────────
const FILLER_PATTERNS = [
  { re: /it is respectfully submitted/gi, label: 'It is respectfully submitted' },
  { re: /defendant would show/gi, label: 'Defendant would show' },
  { re: /comes now/gi, label: 'Comes now' },
  { re: /\bhereby\b/gi, label: 'hereby' },
  { re: /\bhereinafter\b/gi, label: 'hereinafter' },
  { re: /\baforementioned\b/gi, label: 'aforementioned' },
  { re: /in the instant case/gi, label: 'in the instant case' },
  { re: /it should be noted that/gi, label: 'it should be noted that' },
  { re: /it is worth noting/gi, label: 'it is worth noting' },
  { re: /\bwhereas\b/gi, label: 'whereas' },
];

function computeJesusWeptScore(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 5);
  const words = text.split(/\s+/).filter(Boolean);
  const avgSentLen = sentences.length ? Math.round(words.length / sentences.length) : 0;

  const longSentenceDetails = sentences
    .map((s) => ({ text: s.trim(), wordCount: s.trim().split(/\s+/).length }))
    .filter((s) => s.wordCount > 25);

  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  const longParagraphDetails = paragraphs
    .map((p, i) => {
      const pSentences = p.split(/[.!?]+/).filter((s) => s.trim().length > 5);
      return { index: i + 1, sentenceCount: pSentences.length, snippet: p.trim().slice(0, 80) };
    })
    .filter((p) => p.sentenceCount > 3);

  const fillerMatches = [];
  for (const pat of FILLER_PATTERNS) {
    let m;
    pat.re.lastIndex = 0;
    while ((m = pat.re.exec(text)) !== null) {
      const ctx = text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).trim();
      fillerMatches.push({ phrase: m[0], context: ctx });
    }
  }

  const semicolonSentences = sentences
    .filter((s) => (s.match(/;/g) || []).length >= 2)
    .map((s) => s.trim().slice(0, 100));

  const semicolons = (text.match(/;/g) || []).length;
  let score = 100;
  if (avgSentLen > 20) score -= Math.min(30, (avgSentLen - 20) * 3);
  if (longSentenceDetails.length > 2) score -= longSentenceDetails.length * 5;
  if (longParagraphDetails.length > 1) score -= longParagraphDetails.length * 8;
  if (fillerMatches.length > 0) score -= fillerMatches.length * 10;
  if (semicolons > 3) score -= (semicolons - 3) * 3;
  if (words.length > 400) score -= Math.min(20, Math.floor((words.length - 400) / 50) * 5);
  score = Math.max(0, Math.min(100, score));

  const issues = [];
  for (const s of longSentenceDetails) {
    issues.push({ type: 'long-sentence', desc: `${s.wordCount}-word sentence`, detail: s.text.slice(0, 90) + (s.text.length > 90 ? '…' : '') });
  }
  for (const f of fillerMatches) {
    issues.push({ type: 'filler', desc: `Filler: "${f.phrase}"`, detail: '…' + f.context + '…' });
  }
  for (const p of longParagraphDetails) {
    issues.push({ type: 'long-para', desc: `Paragraph ${p.index}: ${p.sentenceCount} sentences`, detail: p.snippet + '…' });
  }
  for (const s of semicolonSentences) {
    issues.push({ type: 'semicolon', desc: 'Multi-semicolon sentence', detail: s + (s.length >= 100 ? '…' : '') });
  }
  if (words.length > 400) {
    issues.push({ type: 'length', desc: `${words.length} words (target: under 400)`, detail: '' });
  }

  return { score, avgSentLen, longSentences: longSentenceDetails.length, longParagraphs: longParagraphDetails.length, throatClearing: fillerMatches.length, wordCount: words.length, issues };
}

function buildTightenPrompt(content, result) {
  const lines = ['Revise this legal filing to meet the Jesus Wept standard. Preserve every legal argument, citation, and factual claim. Change only the prose style.', ''];
  lines.push('SPECIFIC ISSUES TO FIX:');
  for (const iss of (result.issues || [])) {
    lines.push(`- ${iss.desc}`);
  }
  lines.push('');
  lines.push('RULES:');
  lines.push('- Every word must earn its place. Cut filler phrases entirely.');
  lines.push('- One idea per paragraph. Split multi-idea paragraphs.');
  lines.push('- Short sentences. If a semicolon joins two clauses, make two sentences.');
  lines.push('- Target under 400 words for the body (excluding caption, signature, COS).');
  lines.push('- Do NOT add new arguments or citations. Only tighten existing text.');
  lines.push('- Preserve the caption, signature block, and certificate of service exactly.');
  lines.push('');
  lines.push('FILING TO REVISE:');
  lines.push(content);
  return lines.join('\n');
}

function renderJesusWeptMeter() {
  const container = $('jesusWeptMeter');
  if (!container || !state.activeDraftId) { if (container) container.innerHTML = ''; return; }
  const d = state.drafts.find((x) => x.id === state.activeDraftId);
  if (!d) { container.innerHTML = ''; return; }
  const content = $('draftContent').value;
  const result = computeJesusWeptScore(content);
  if (!result) { container.innerHTML = ''; return; }
  const color = result.score >= 80 ? 'ok' : result.score >= 50 ? 'warn' : 'bad';
  const label = result.score >= 80 ? 'Jesus Wept' : result.score >= 50 ? 'Needs Work' : 'Needs Tightening';
  const hasIssues = result.issues && result.issues.length > 0;

  const html = [
    `<div class="jw__row">`,
    `<span class="jw__label">${label}</span>`,
    `<span class="jw__score jw__score--${color}">${result.score}</span>`,
    `</div>`,
    `<div class="jw__bar"><div class="jw__bar-fill jw__bar-fill--${color}" style="width:${result.score}%"></div></div>`,
    `<div class="jw__detail">${result.wordCount} words \u00b7 avg ${result.avgSentLen} words/sentence${result.throatClearing ? ` \u00b7 ${result.throatClearing} filler phrases` : ''}</div>`,
  ];

  if (hasIssues) {
    html.push(`<div class="jw__actions">`);
    html.push(`<button class="btn btn--sm btn--primary jw__tighten-btn" type="button">Tighten</button>`);
    html.push(`<button class="btn btn--sm btn--ghost jw__details-btn" type="button">${result.issues.length} issue${result.issues.length !== 1 ? 's' : ''}</button>`);
    html.push(`</div>`);
    html.push(`<div class="jw__issues is-hidden">`);
    for (const iss of result.issues) {
      const icon = iss.type === 'filler' ? '\u2718' : iss.type === 'long-sentence' ? '\u2194' : iss.type === 'long-para' ? '\u00b6' : iss.type === 'semicolon' ? ';' : '\u26a0';
      html.push(`<div class="jw__issue"><span class="jw__issue-icon">${icon}</span><div><div class="jw__issue-desc">${escapeHtml(iss.desc)}</div>${iss.detail ? `<div class="jw__issue-detail">${escapeHtml(iss.detail)}</div>` : ''}</div></div>`);
    }
    html.push(`</div>`);
  }

  container.innerHTML = html.join('');

  if (hasIssues) {
    const detailsBtn = container.querySelector('.jw__details-btn');
    const issuesPanel = container.querySelector('.jw__issues');
    if (detailsBtn && issuesPanel) {
      detailsBtn.addEventListener('click', () => {
        issuesPanel.classList.toggle('is-hidden');
        detailsBtn.textContent = issuesPanel.classList.contains('is-hidden')
          ? `${result.issues.length} issue${result.issues.length !== 1 ? 's' : ''}`
          : 'Hide issues';
      });
    }

    const tightenBtn = container.querySelector('.jw__tighten-btn');
    if (tightenBtn) {
      tightenBtn.addEventListener('click', () => {
        const prompt = buildTightenPrompt(content, result);
        setTab('chat');
        $('messageInput').value = prompt;
        $('messageInput').focus();
        showToast('Tighten prompt loaded — hit Send to revise the draft', { type: 'info', duration: 3000 });
      });
    }
  }
}

function filenameFromDisposition(disposition, fallback) {
  const raw = String(disposition || '');
  const utf8 = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8 && utf8[1]) {
    try { return decodeURIComponent(utf8[1]); } catch { /* ignore */ }
  }
  const plain = raw.match(/filename="?([^";]+)"?/i);
  if (plain && plain[1]) return plain[1];
  return fallback;
}

// ── Draft Download ──────────────────────────────────────────────────────────
async function downloadDraft() {
  if (!state.activeDraftId) return;
  const d = state.drafts.find((x) => x.id === state.activeDraftId);
  if (!d) return;

  const content = $('draftContent').value || d.content || '';
  const mdFilename = d.suggested?.filename || `${d.title || 'draft'}.md`;
  const docxFallback = mdFilename.replace(/\.md$/i, '.docx');

  try {
    const res = await fetch(`/api/drafts/${encodeURIComponent(d.id)}/export-docx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        msg = data?.error || msg;
      } catch { /* ignore */ }
      throw new Error(msg);
    }

    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition');
    const filename = filenameFromDisposition(disposition, docxFallback);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const hasReference = (res.headers.get('x-reference-docx') || '').toLowerCase() === 'used';
    showToast(`Downloaded DOCX: ${filename}${hasReference ? '' : ' (no reference template found)'}`, {
      type: 'success',
      duration: 2600,
    });
  } catch (err) {
    // Fallback: keep markdown download available if DOCX conversion fails.
    const blob = new Blob([content], { type: 'text/markdown; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = mdFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`DOCX export failed (${err.message}). Downloaded markdown instead.`, { type: 'error', duration: 5200 });
  }
}

// ── Draft Version History ───────────────────────────────────────────────────
const draftVersions = new Map();

function snapshotDraftVersion(draftId, content) {
  if (!draftId || !content?.trim()) return;
  if (!draftVersions.has(draftId)) draftVersions.set(draftId, []);
  const versions = draftVersions.get(draftId);
  const last = versions.length ? versions[versions.length - 1] : null;
  if (last && last.content === content) return;
  versions.push({ content, timestamp: new Date().toISOString() });
  if (versions.length > 20) versions.shift();
}

function renderVersionHistory() {
  const container = $('versionHistory');
  if (!container || !state.activeDraftId) { if (container) container.innerHTML = ''; return; }
  const versions = draftVersions.get(state.activeDraftId) || [];
  if (versions.length < 2) { container.innerHTML = ''; return; }
  const opts = versions.slice().reverse().map((v, i) => {
    const idx = versions.length - 1 - i;
    const label = i === 0 ? `Current (${fmtTs(v.timestamp)})` : `v${idx + 1} (${fmtTs(v.timestamp)})`;
    return `<option value="${idx}">${escapeHtml(label)}</option>`;
  });
  container.innerHTML = `<select id="versionSelect" class="select select--sm"><option value="">History (${versions.length})</option>${opts.join('')}</select>`;
  $('versionSelect').onchange = (e) => {
    const idx = Number(e.target.value);
    if (Number.isNaN(idx)) return;
    const v = versions[idx];
    if (!v) return;
    showModal({
      title: 'Restore version?',
      body: `Restore draft to version from ${fmtTs(v.timestamp)}? Current content will be saved as a version.`,
      confirmLabel: 'Restore',
      onConfirm: () => {
        snapshotDraftVersion(state.activeDraftId, $('draftContent').value);
        $('draftContent').value = v.content;
        renderDraftPreview();
        renderCompleteness();
        renderJesusWeptMeter();
        renderVersionHistory();
        showToast('Version restored', { type: 'success', duration: 1800 });
      },
    });
    e.target.value = '';
  };
}

// ── Composer Meta ───────────────────────────────────────────────────────────
function updateComposerMeta() {
  const meta = $('composerMeta');
  if (!meta) return;
  const parts = [];
  if (state.activeDraftId) {
    const d = state.drafts.find((x) => x.id === state.activeDraftId);
    if (d?.title) parts.push(`Active draft: ${d.title}`);
  }
  const hintedIdx = normalizeIdxKey(state.composerHint?.respondingToIdx || '');
  if (hintedIdx) parts.push(`Context: ${hintedIdx} (auto)`);
  if (String(state.composerHint?.mode || '') === 'oral') parts.push('Mode: oral (auto)');
  meta.textContent = parts.join(' • ');
  renderWorkflowQuickActions();
}

function setWorkflowQuickMeta(message = '', tone = '') {
  const meta = $('workflowQuickMeta');
  if (!meta) return;
  meta.textContent = String(message || '');
  meta.className = `panel__meta wfq__meta${tone ? ` wfq__meta--${tone}` : ''}`;
}

async function verifyActiveDraftWorkflow() {
  if (!state.activeDraftId) {
    showToast('Open a draft first', { type: 'error' });
    return;
  }
  try {
    const data = await api(`/api/drafts/${state.activeDraftId}/verify-citations`, { method: 'POST' });
    const total = Number(data?.total || 0);
    const verified = Number(data?.verified || 0);
    const unverified = Number(data?.unverified || 0);
    const badge = unverified > 0 ? 'needs attention' : 'all verified';
    setWorkflowQuickMeta(`Citation check: ${verified}/${total} verified (${badge}).`, unverified > 0 ? 'warn' : 'ok');
    if (unverified > 0) {
      const lines = [];
      for (const c of (data.citations || []).filter((x) => !x.verified).slice(0, 10)) {
        lines.push(`• ${c.raw} — ${c.reason || 'Not verified'}`);
      }
      showModal({
        title: `Citation Audit: ${unverified} unverified`,
        body: lines.join('\n') || 'Unverified citations detected.',
        confirmLabel: 'Got it',
      });
      return;
    }
    showToast('All citations verified', { type: 'success', duration: 2000 });
  } catch (e) {
    setWorkflowQuickMeta(`Citation check failed: ${e.message}`, 'warn');
    showToast(`Citation check failed: ${e.message}`, { type: 'error', duration: 4000 });
  }
}

async function refreshWorkflowMonitoring() {
  try {
    const [reactor, alerts] = await Promise.all([
      api('/api/case/response-reactor?force=1'),
      api('/api/case/alerts?force=1'),
    ]);
    const filingCount = Array.isArray(reactor?.filings) ? reactor.filings.length : 0;
    const alertCount = Array.isArray(alerts?.alerts) ? alerts.alerts.length : 0;
    setWorkflowQuickMeta(`Monitoring refreshed: ${filingCount} filing trigger(s), ${alertCount} alert(s).`, 'ok');
    showToast('Workflow monitor refreshed', { type: 'success', duration: 1800 });
  } catch (e) {
    setWorkflowQuickMeta(`Monitoring refresh failed: ${e.message}`, 'warn');
    showToast(`Monitoring refresh failed: ${e.message}`, { type: 'error', duration: 4000 });
  }
}

function renderWorkflowQuickActions() {
  // Quick-action buttons removed — all actions available via slash commands.
}

// ── Filing Context Auto-Loader ──────────────────────────────────────────────
async function loadFilingContextOptions() {
  try {
    const data = await api('/api/case/filings');
    state.filingContexts = Array.isArray(data?.filings) ? data.filings : [];
    updateComposerMeta();
    renderWorkflowQuickActions();
  } catch {
    state.filingContexts = [];
  }
}

// ── Next-Move Recommendations ───────────────────────────────────────────────
async function loadNextMoves() {
  const container = $('nextMovesContainer');
  if (!container) return;
  try {
    const data = await api('/api/case/next-moves');
    if (!data.ok || !data.moves?.length) {
      container.innerHTML = '<div class="nm__empty">No action items</div>';
      return;
    }
    renderNextMoves(data.moves, container);
  } catch {
    container.innerHTML = '<div class="nm__empty">Error loading</div>';
  }
}

function renderNextMoves(moves, el) {
  const h = escapeHtml;
  const p = [];
  p.push('<h3 class="cs__heading">Next Moves</h3>');
  const icons = {
    'hearing-prep': '\uD83C\uDFDB\uFE0F',
    respond: '\u26A0\uFE0F',
    deadline: '\u23F0',
    track: '\uD83D\uDCCC',
    lesson: '\uD83D\uDCA1',
    'follow-up': '\u2705',
  };
  for (const m of moves) {
    const icon = icons[m.type] || '\u2022';
    const cls = m.priority === 'critical' ? 'nm__item--critical' : m.priority === 'high' ? 'nm__item--high' : m.priority === 'low' ? 'nm__item--low' : '';
    p.push(`<div class="nm__item ${cls}">`);
    p.push(`<div class="nm__header">`);
    p.push(`<span class="nm__icon">${icon}</span>`);
    p.push(`<span class="nm__title">${h(m.title)}</span>`);
    p.push(`<span class="nm__badge nm__badge--${h(m.priority)}">${h(m.priority)}</span>`);
    p.push(`</div>`);
    if (m.detail) p.push(`<div class="nm__detail">${h(m.detail)}</div>`);
    if (m.action && m.type === 'hearing-prep') {
      p.push(`<button class="btn btn--sm btn--primary nm__action" data-hearing-date="${h(m.hearingDate || '')}" data-hearing-desc="${h(m.hearingDesc || '')}" onclick="startHearingPrep(this)">Prep Hearing</button>`);
    }
    if (m.action && m.type === 'respond' && m.idx) {
      p.push(`<button class="btn btn--sm btn--primary nm__action" onclick="startFilingResponse('${h(m.idx)}')">Draft Response</button>`);
    }
    p.push(`</div>`);
  }
  el.innerHTML = p.join('');
}

// ── Hearing Prep Mode ───────────────────────────────────────────────────────
function startHearingPrep(btn) {
  const date = btn.dataset.hearingDate || '';
  const desc = btn.dataset.hearingDesc || '';
  setTab('chat');
  const input = $('messageInput');
  input.value = `Generate hearing prep for the ${date} hearing: ${desc}\n\nProduce BOTH versions:\n1. JESUS WEPT full argument (60-90 seconds spoken)\n2. THE CUTOFF nuclear summary (2 sentences max)\n\nInclude the specific relief requested and anticipate likely opposition arguments.`;
  input.focus();
  setComposerHint({ mode: 'oral' });
  showToast('Hearing prep loaded — hit Send when ready', { type: 'info', duration: 3000 });
}

function normalizeIdxKey(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  const digitMatch = raw.match(/(\d+)/);
  if (digitMatch) return `IDX${String(Number(digitMatch[1]))}`;
  return raw.replace(/^IDX0*/i, 'IDX');
}

function startFilingResponse(idx) {
  setTab('chat');
  const target = normalizeIdxKey(idx || '');
  setComposerHint({ mode: 'draft', respondingToIdx: target });
  const input = $('messageInput');
  input.value = `Draft a response to ${target || idx}. Use the auto-loaded filing context. Follow Jesus Wept format: ONE issue, ONE rule, ONE ask. Under 350 words body.`;
  input.focus();
  showToast(`Context loaded for ${target || idx} — hit Send when ready`, { type: 'info', duration: 3000 });
}

// Make hearing prep / filing response available globally for onclick handlers
window.startHearingPrep = startHearingPrep;
window.startFilingResponse = startFilingResponse;

// ── CASE TOOLS ──────────────────────────────────────────────────────────────

async function verifyCitationsForDraft() {
  if (!state.activeDraftId) {
    showToast('No active draft — open a draft first', { type: 'error' });
    return;
  }
  const el = $('citationResults');
  el.innerHTML = '<div class="tools__loading">Verifying citations...</div>';
  try {
    const data = await api(`/api/drafts/${state.activeDraftId}/verify-citations`, { method: 'POST' });
    if (!data.ok) { el.innerHTML = `<div class="tools__error">${escapeHtml(data.error || 'Error')}</div>`; return; }
    const lines = [];
    lines.push(`<div class="tools__summary">`);
    lines.push(`<strong>${data.total}</strong> citations found — `);
    lines.push(`<span class="tools__ok">${data.verified} verified</span>`);
    if (data.unverified > 0) lines.push(` · <span class="tools__warn">${data.unverified} UNVERIFIED</span>`);
    else lines.push(` · <span class="tools__ok">All verified</span>`);
    lines.push(`</div>`);
    for (const c of (data.citations || [])) {
      const icon = c.verified ? '&#x2705;' : '&#x274C;';
      const cls = c.verified ? 'tools__cite--ok' : 'tools__cite--fail';
      lines.push(`<div class="${cls}">${icon} <code>${escapeHtml(c.raw)}</code>`);
      if (c.verified && c.source) lines.push(` <small>(${escapeHtml(c.source)})</small>`);
      if (c.verified && c.match?.url) lines.push(` <small>(<a href="${escapeHtml(c.match.url)}" target="_blank">CL</a>)</small>`);
      if (!c.verified) lines.push(` <small class="tools__warn">${escapeHtml(c.reason || 'Not verified')}</small>`);
      lines.push(`</div>`);
    }
    if (!data.total) lines.push(`<div class="panel__meta">No citations detected in draft text.</div>`);
    el.innerHTML = lines.join('');
  } catch (e) {
    el.innerHTML = `<div class="tools__error">${escapeHtml(e.message)}</div>`;
  }
}

async function calculateServiceDeadline() {
  const triggerDate = $('svcTriggerDate')?.value;
  const days = Number($('svcDays')?.value || 0);
  const mailService = $('svcMailService')?.checked || false;
  const businessDays = $('svcBusinessDays')?.checked || false;
  const el = $('svcCalcResult');
  if (!triggerDate) { showToast('Enter a trigger date', { type: 'error' }); return; }
  try {
    const data = await api('/api/tools/service-calc', {
      method: 'POST',
      body: JSON.stringify({ triggerDate, days, mailService, businessDays }),
    });
    const lines = [`<div class="tools__deadline-result">`];
    lines.push(`<div class="tools__deadline-date"><strong>Deadline: ${escapeHtml(data.deadline)}</strong></div>`);
    lines.push(`<div class="tools__deadline-steps">`);
    for (const step of (data.calculation || [])) {
      lines.push(`<div class="tools__step">${escapeHtml(step)}</div>`);
    }
    lines.push(`</div></div>`);
    el.innerHTML = lines.join('');
  } catch (e) {
    el.innerHTML = `<div class="tools__error">${escapeHtml(e.message)}</div>`;
  }
}

async function searchCourtListener() {
  const query = $('clSearchInput')?.value?.trim();
  const el = $('clSearchResults');
  if (!query) { showToast('Enter a search query', { type: 'error' }); return; }
  el.innerHTML = '<div class="tools__loading">Searching CourtListener...</div>';
  try {
    const data = await api('/api/tools/courtlistener-search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
    if (data.error) { el.innerHTML = `<div class="tools__error">${escapeHtml(data.error)}</div>`; return; }
    const lines = [`<div class="panel__meta">${data.total || 0} results</div>`];
    for (const r of (data.results || [])) {
      lines.push(`<div class="tools__cl-result">`);
      lines.push(`<div class="tools__cl-name">`);
      if (r.url) lines.push(`<a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.caseName)}</a>`);
      else lines.push(escapeHtml(r.caseName));
      if (r.dateFiled) lines.push(` <small>(${escapeHtml(r.dateFiled)})</small>`);
      lines.push(`</div>`);
      if (r.citation?.length) lines.push(`<div class="tools__cl-cite">${r.citation.map(c => escapeHtml(c)).join(', ')}</div>`);
      if (r.snippet) lines.push(`<div class="tools__cl-snippet">${escapeHtml(r.snippet.slice(0, 300))}</div>`);
      lines.push(`</div>`);
    }
    if (!data.results?.length) lines.push(`<div class="panel__meta">No results found.</div>`);
    el.innerHTML = lines.join('');
  } catch (e) {
    el.innerHTML = `<div class="tools__error">${escapeHtml(e.message)}</div>`;
  }
}

async function generateHearingPrep() {
  const description = $('hpDescription')?.value?.trim();
  const hearing_date = $('hpDate')?.value || '';
  const el = $('hpResult');
  if (!description) { showToast('Enter hearing description', { type: 'error' }); return; }
  el.innerHTML = '<div class="tools__loading">Generating hearing prep (AI)...</div>';
  try {
    const data = await api('/api/tools/hearing-prep', {
      method: 'POST',
      body: JSON.stringify({ description, hearing_date }),
    });
    if (data.error) { el.innerHTML = `<div class="tools__error">${escapeHtml(data.error)}</div>`; return; }
    el.innerHTML = `<div class="tools__prep prose">${escapeHtml(data.prep || '').replace(/\n/g, '<br>')}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="tools__error">${escapeHtml(e.message)}</div>`;
  }
}

async function loadAssignmentChain(opts) {
  const el = $('chainResult');
  el.innerHTML = '<div class="tools__loading">Loading...</div>';
  try {
    const data = await api(`/api/case/assignment-chain${opts?.force ? '?force=1' : ''}`);
    const lines = [`<div class="chain">`];
    lines.push(`<div class="chain__amount">Amount claimed: <strong>${escapeHtml(data.amount)}</strong></div>`);
    for (let i = 0; i < (data.chain || []).length; i++) {
      const c = data.chain[i];
      const statusCls = c.status === 'gap' ? 'chain__node--gap' : c.status === 'challenged' ? 'chain__node--challenged' : c.status === 'void' ? 'chain__node--void' : 'chain__node--ok';
      lines.push(`<div class="chain__node ${statusCls}">`);
      lines.push(`<div class="chain__entity"><strong>${escapeHtml(c.entity)}</strong></div>`);
      lines.push(`<div class="chain__role">${escapeHtml(c.role)}</div>`);
      lines.push(`<div class="chain__date">${escapeHtml(c.date)}</div>`);
      if (c.document) lines.push(`<div class="chain__doc">${escapeHtml(c.document)}</div>`);
      lines.push(`<div class="chain__notes">${escapeHtml(c.notes)}</div>`);
      lines.push(`</div>`);
      if (i < data.chain.length - 1) lines.push(`<div class="chain__arrow">&#x25BC;</div>`);
    }
    if (data.gaps?.length) {
      lines.push(`<div class="chain__gaps"><strong>Critical Gaps:</strong><ul>`);
      for (const g of data.gaps) lines.push(`<li>${escapeHtml(g)}</li>`);
      lines.push(`</ul></div>`);
    }
    if (data.keyCase) lines.push(`<div class="chain__key-case"><strong>Key Case:</strong> ${escapeHtml(data.keyCase)}</div>`);
    lines.push(`</div>`);
    el.innerHTML = lines.join('');
  } catch (e) {
    el.innerHTML = `<div class="tools__error">${escapeHtml(e.message)}</div>`;
  }
}

async function loadPlaintiffPatterns(opts) {
  const el = $('patternsResult');
  el.innerHTML = '<div class="tools__loading">Analyzing...</div>';
  try {
    const data = await api(`/api/case/plaintiff-patterns${opts?.force ? '?force=1' : ''}`);
    if (!data.ok) { el.innerHTML = `<div class="panel__meta">${escapeHtml(data.reason || 'No data')}</div>`; return; }
    const lines = [`<div class="patterns">`];
    lines.push(`<div class="patterns__summary">`);
    lines.push(`PLT filings: <strong>${data.totalPlt}</strong> · DEF filings: <strong>${data.totalDef}</strong>`);
    if (data.avgFilingGap) lines.push(` · Avg gap: <strong>${data.avgFilingGap}d</strong>`);
    lines.push(`</div>`);

    if (data.typeFrequency) {
      lines.push(`<div class="patterns__types"><strong>PLT Filing Types:</strong> `);
      lines.push(Object.entries(data.typeFrequency).map(([k, v]) => `${escapeHtml(k)}: ${v}`).join(', '));
      lines.push(`</div>`);
    }
    if (data.continuanceRate > 0) {
      lines.push(`<div class="patterns__cont"><strong>Continuance rate:</strong> ${data.continuanceRate}%</div>`);
    }
    if (data.predictions?.length) {
      lines.push(`<div class="patterns__predictions"><strong>Predictions:</strong><ul>`);
      for (const p of data.predictions) {
        const cls = p.likelihood === 'high' ? 'tools__warn' : '';
        lines.push(`<li class="${cls}"><strong>[${escapeHtml(p.likelihood)}]</strong> ${escapeHtml(p.prediction)}<br><small>${escapeHtml(p.basis)}</small></li>`);
      }
      lines.push(`</ul></div>`);
    }
    if (data.reactions?.length) {
      lines.push(`<div class="patterns__reactions"><strong>PLT Reactions to DEF Filings:</strong>`);
      for (const r of data.reactions.slice(0, 5)) {
        lines.push(`<div class="patterns__reaction"><em>After ${escapeHtml(r.trigger || r.triggerIdx)}:</em>`);
        for (const resp of r.responses) {
          lines.push(` ${escapeHtml(resp.description)} (${resp.daysAfter}d later)`);
        }
        lines.push(`</div>`);
      }
      lines.push(`</div>`);
    }
    lines.push(`</div>`);
    el.innerHTML = lines.join('');
  } catch (e) {
    el.innerHTML = `<div class="tools__error">${escapeHtml(e.message)}</div>`;
  }
}

async function loadDiscoveryCompliance(opts) {
  const el = $('discoveryResult');
  el.innerHTML = '<div class="tools__loading">Loading...</div>';
  try {
    const data = await api(`/api/case/discovery${opts?.force ? '?force=1' : ''}`);
    if (!data.ok) { el.innerHTML = `<div class="panel__meta">${escapeHtml(data.reason || 'No data')}</div>`; return; }
    const s = data.summary || {};
    const lines = [`<div class="discovery">`];
    lines.push(`<div class="discovery__summary">`);
    lines.push(`Total: <strong>${s.total}</strong> · Served: <strong>${s.served}</strong> · Responded: <strong>${s.responded}</strong>`);
    if (s.overdue > 0) lines.push(` · <span class="tools__warn">Overdue: ${s.overdue}</span>`);
    if (s.pending > 0) lines.push(` · Pending: ${s.pending}`);
    lines.push(`</div>`);
    if (data.note) lines.push(`<div class="panel__meta">${escapeHtml(data.note)}</div>`);
    if (data.items?.length) {
      lines.push(`<table class="discovery__table"><tr><th>Type</th><th>Description</th><th>By</th><th>Due</th><th>Status</th></tr>`);
      for (const item of data.items) {
        const cls = item.effectiveStatus === 'overdue' ? 'tools__warn' : '';
        lines.push(`<tr class="${cls}"><td>${escapeHtml(item.type || '')}</td><td>${escapeHtml(item.description || '')}</td>`);
        lines.push(`<td>${escapeHtml(item.served_by || '')}</td><td>${escapeHtml(item.due_date || '')}</td>`);
        lines.push(`<td>${escapeHtml(item.effectiveStatus || item.status || '')}</td></tr>`);
      }
      lines.push(`</table>`);
    }
    lines.push(`</div>`);
    el.innerHTML = lines.join('');
  } catch (e) {
    el.innerHTML = `<div class="tools__error">${escapeHtml(e.message)}</div>`;
  }
}

async function loadResponseReactor(opts) {
  const el = $('reactorResult');
  el.innerHTML = '<div class="tools__loading">Checking...</div>';
  try {
    const data = await api(`/api/case/response-reactor${opts?.force ? '?force=1' : ''}`);
    if (!data.ok) { el.innerHTML = `<div class="panel__meta">${escapeHtml(data.reason || 'No data')}</div>`; return; }
    const filings = data.filings || [];
    if (!filings.length) { el.innerHTML = '<div class="panel__meta">No recent plaintiff filings detected.</div>'; return; }
    const lines = [`<div class="reactor">`];
    lines.push(`<div class="panel__meta">${filings.length} plaintiff filing(s) found</div>`);
    for (const f of filings) {
      lines.push(`<div class="reactor__item">`);
      lines.push(`<div class="reactor__filing"><strong>#${escapeHtml(String(f.filing?.idx || ''))}</strong> ${escapeHtml(f.filing?.description || '')}</div>`);
      lines.push(`<div class="reactor__date">${escapeHtml(f.filing?.date || '')}</div>`);
      lines.push(`<div class="reactor__response">`);
      lines.push(`Response type: <strong>${escapeHtml(f.response?.docType || '')}</strong> · Rule: ${escapeHtml(f.response?.responseRule || '')}`);
      lines.push(`<br>Deadline: <strong>${escapeHtml(f.response?.deadline || '')}</strong>`);
      lines.push(`</div>`);
      lines.push(`<button class="btn btn--sm btn--primary" onclick="startFilingResponse('IDX${escapeHtml(String(f.filing?.idx || ''))}')">Draft Response</button>`);
      lines.push(`</div>`);
    }
    lines.push(`</div>`);
    el.innerHTML = lines.join('');
  } catch (e) {
    el.innerHTML = `<div class="tools__error">${escapeHtml(e.message)}</div>`;
  }
}

async function loadAlerts(opts) {
  const el = $('alertsResult');
  el.innerHTML = '<div class="tools__loading">Loading...</div>';
  try {
    const data = await api(`/api/case/alerts${opts?.force ? '?force=1' : ''}`);
    const alerts = data.alerts || [];
    if (!alerts.length) { el.innerHTML = '<div class="panel__meta">No recent alerts.</div>'; return; }
    const lines = [`<div class="alerts">`];
    for (const a of alerts) {
      const cls = a.priority === 'high' ? 'alerts__item--high' : a.priority === 'critical' ? 'alerts__item--critical' : '';
      lines.push(`<div class="alerts__item ${cls}">`);
      lines.push(`<div class="alerts__msg">${escapeHtml(a.message)}</div>`);
      lines.push(`<div class="alerts__meta">${escapeHtml(a.type || '')} · ${escapeHtml(a.createdAt || '')}</div>`);
      lines.push(`</div>`);
    }
    lines.push(`</div>`);
    el.innerHTML = lines.join('');
  } catch (e) {
    el.innerHTML = `<div class="tools__error">${escapeHtml(e.message)}</div>`;
  }
}

function wire() {
  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => setTab(b.dataset.tab));
  });

  $('refreshBtn').onclick = () => refreshState();
  $('newConversationBtn').onclick = () => newConversation();

  // Accordion toggles for left panel sections
  document.querySelectorAll('.section__toggle').forEach((header) => {
    const section = header.closest('.section');
    if (!section) return;
    const key = section.dataset.section;

    // Restore persisted state
    if (key) {
      try {
        const collapsed = JSON.parse(localStorage.getItem('section_collapsed') || '{}');
        if (collapsed[key]) {
          section.classList.add('is-collapsed');
          header.setAttribute('aria-expanded', 'false');
        }
      } catch { /* ignore */ }
    }

    const toggle = (e) => {
      // Don't toggle when clicking the "All" checkbox inside Drafts header
      if (e.target.closest('label.check') || e.target.tagName === 'INPUT') return;
      const isCollapsed = section.classList.toggle('is-collapsed');
      header.setAttribute('aria-expanded', String(!isCollapsed));
      if (key) {
        try {
          const collapsed = JSON.parse(localStorage.getItem('section_collapsed') || '{}');
          collapsed[key] = isCollapsed;
          localStorage.setItem('section_collapsed', JSON.stringify(collapsed));
        } catch { /* ignore */ }
      }
    };
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
    });
  });

  $('allDraftsCheck').onchange = (e) => {
    state.showAllDrafts = Boolean(e.target.checked);
    renderDrafts();
  };

  // Attachment controls
  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files.length) handleFileSelection(e.target.files);
    e.target.value = '';
  });

  // Drag-and-drop on composer
  const composerEl = $('composer');
  const dropOverlay = $('dropOverlay');
  let dragCounter = 0;
  composerEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.remove('is-hidden');
  });
  composerEl.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.add('is-hidden'); }
  });
  composerEl.addEventListener('dragover', (e) => { e.preventDefault(); });
  composerEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.add('is-hidden');
    if (e.dataTransfer?.files?.length) handleFileSelection(e.dataTransfer.files);
  });

  $('composer').addEventListener('submit', sendMessage);
  $('messageInput').addEventListener('input', () => updateSlashCommandMenuFromInput());
  $('messageInput').addEventListener('focus', () => updateSlashCommandMenuFromInput());
  $('messageInput').addEventListener('blur', () => {
    setTimeout(() => hideSlashCommandMenu(), 120);
  });
  $('messageInput').addEventListener('keydown', (e) => {
    if (slashMenuState.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashMenuState.selectedIndex = Math.min(slashMenuState.selectedIndex + 1, slashMenuState.items.length - 1);
        renderSlashCommandMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashMenuState.selectedIndex = Math.max(slashMenuState.selectedIndex - 1, 0);
        renderSlashCommandMenu();
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        const text = String(($('messageInput') || {}).value || '').trim();
        const hasOnlySlashToken = text.startsWith('/') && !/\s/.test(text.slice(1));
        if (hasOnlySlashToken) {
          e.preventDefault();
          applySlashCommandSelection(slashMenuState.items[slashMenuState.selectedIndex]);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideSlashCommandMenu();
        return;
      }
    }

    if (e.key !== 'Enter') return;
    if (e.shiftKey) return; // Shift+Enter = newline
    if (e.isComposing) return;
    e.preventDefault();
    sendMessage(e);
  });
  $('clearChatBtn').onclick = async () => {
    if (!state.activeConversationId) return;
    try {
      await api(`/api/conversations/${state.activeConversationId}/messages`, { method: 'DELETE' });
      await refreshState();
      showToast('Conversation messages cleared', { type: 'success', duration: 1800 });
    } catch (e) {
      showToast(`Failed to clear messages: ${e.message}`, { type: 'error', duration: 5000 });
    }
  };

  // Quote-selection: floating Quote button on text selection in assistant messages
  const quoteBtn = document.createElement('button');
  quoteBtn.className = 'btn btn--quote is-hidden';
  quoteBtn.textContent = 'Quote';
  document.body.appendChild(quoteBtn);

  let quoteTimeout = null;
  function hideQuoteBtn() { quoteBtn.classList.add('is-hidden'); }

  document.addEventListener('selectionchange', () => {
    clearTimeout(quoteTimeout);
    quoteTimeout = setTimeout(() => {
      const sel = window.getSelection();
      const text = (sel && sel.toString() || '').trim();
      if (!text) { hideQuoteBtn(); return; }

      const anchor = sel.anchorNode;
      const msgEl = anchor && anchor.nodeType === Node.TEXT_NODE
        ? anchor.parentElement.closest('.msg--assistant')
        : anchor instanceof Element ? anchor.closest('.msg--assistant') : null;
      if (!msgEl) { hideQuoteBtn(); return; }

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      quoteBtn.style.top = `${rect.top + window.scrollY - 34}px`;
      quoteBtn.style.left = `${rect.left + window.scrollX + rect.width / 2 - 30}px`;
      quoteBtn.classList.remove('is-hidden');
    }, 200);
  });

  quoteBtn.addEventListener('mousedown', (e) => {
    e.preventDefault(); // keep selection alive
    const sel = window.getSelection();
    const text = (sel && sel.toString() || '').trim();
    if (!text) return;

    const input = $('messageInput');
    const existing = input.value;
    const quote = text.split('\n').map((l) => `> ${l}`).join('\n');
    input.value = (existing ? existing + '\n\n' : '') + quote + '\n\n';
    input.focus();
    input.scrollTop = input.scrollHeight;
    hideQuoteBtn();
    sel.removeAllRanges();
    showToast('Quoted to composer', { type: 'success', duration: 1500 });
  });

  $('saveDraftBtn').onclick = () => saveDraftToCase();
  $('toggleAdvancedBtn').onclick = () => {
    const box = $('advancedSaveBox');
    box.classList.toggle('is-hidden');
  };
  $('editorEditViewBtn').onclick = () => setEditorView('edit');
  $('editorPreviewViewBtn').onclick = () => setEditorView('preview');

  let _editorInputTimer = null;
  $('draftContent').addEventListener('input', () => {
    if (state.editorView === 'preview') renderDraftPreview();
    clearTimeout(_editorInputTimer);
    _editorInputTimer = setTimeout(() => {
      renderCompleteness();
      renderJesusWeptMeter();
      if (state.activeDraftId) snapshotDraftVersion(state.activeDraftId, $('draftContent').value);
      renderVersionHistory();
    }, 600);
  });
  initEditorResizer();
  initLeftResizer();

  $('searchBtn').onclick = () => doSearch();
  $('searchClearBtn').onclick = () => clearSearch();
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  const redTeamBtn = $('redTeamBtn');
  if (redTeamBtn) redTeamBtn.onclick = () => runRedTeam();
  const downloadBtn = $('downloadDraftBtn');
  if (downloadBtn) downloadBtn.onclick = () => downloadDraft();

  // ── Tools tab wiring ────────────────────────────────────────────────────
  const _btn = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  _btn('verifyCitationsBtn', verifyCitationsForDraft);
  _btn('calcDeadlineBtn', calculateServiceDeadline);
  _btn('clSearchBtn', searchCourtListener);
  _btn('hpGenerateBtn', generateHearingPrep);
  _btn('loadChainBtn', () => toolsAutoLoad.forceRefreshPanel('chain'));
  _btn('loadPatternsBtn', () => toolsAutoLoad.forceRefreshPanel('patterns'));
  _btn('loadDiscoveryBtn', () => toolsAutoLoad.forceRefreshPanel('discovery'));
  _btn('loadReactorBtn', () => toolsAutoLoad.forceRefreshPanel('reactor'));
  _btn('loadAlertsBtn', () => toolsAutoLoad.forceRefreshPanel('alerts'));
  _btn('toolsGuideToChatBtn', () => setTab('chat'));
  _btn('toolsGuideVerifyBtn', async () => {
    await verifyActiveDraftWorkflow();
  });
  _btn('toolsGuideRefreshMonitorsBtn', async () => {
    await refreshAllOpsMonitors();
  });

  // Service calc quick-preset buttons
  document.querySelectorAll('[data-svc-days]').forEach((b) => {
    b.addEventListener('click', () => {
      const daysInput = $('svcDays');
      if (daysInput) daysInput.value = b.dataset.svcDays;
      const dateInput = $('svcTriggerDate');
      if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
      $('svcMailService').checked = true;
      calculateServiceDeadline();
    });
  });

  // CourtListener search on Enter
  const clInput = $('clSearchInput');
  if (clInput) clInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchCourtListener(); });

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;

    if (e.key === 's') {
      e.preventDefault();
      if (state.activeDraftId) saveDraftToCase();
    }
    if (e.key === 'p') {
      e.preventDefault();
      setEditorView(state.editorView === 'preview' ? 'edit' : 'preview');
    }
    if (e.key === 'n') {
      e.preventDefault();
      newConversation();
    }
    if (e.key === '1') { e.preventDefault(); setTab('chat'); }
    if (e.key === '2') { e.preventDefault(); setTab('search'); }
    if (e.key === '3') { e.preventDefault(); setTab('case'); }
    if (e.key === '4') { e.preventDefault(); setTab('intel'); }
    if (e.key === '5') { e.preventDefault(); setTab('tools'); }
  });
}

async function updateStatusBar() {
  try {
    const cfg = await api('/api/config');
    const dot = document.getElementById('statusDot');
    const txt = document.getElementById('statusText');
    if (cfg.anthropic?.hasApiKey) {
      dot.className = 'statusbar__dot';
      const t = cfg.anthropic.thinking || {};
      let thinkingLabel = 'thinking off';
      if (t.effectiveMode === 'adaptive') {
        thinkingLabel = t.requestedEffort
          ? `thinking adaptive (requested ${t.requestedEffort})`
          : 'thinking adaptive';
      } else if (t.effectiveMode === 'enabled') {
        thinkingLabel = `thinking manual/${t.budgetTokens || 'n/a'}`;
      }
      txt.textContent = `${cfg.anthropic.model} · max ${cfg.anthropic.maxTokens} tokens · ${thinkingLabel} · localhost:3210`;
    } else {
      dot.className = 'statusbar__dot statusbar__dot--off';
      txt.textContent = 'No API key configured · localhost:3210';
    }
  } catch { /* ignore */ }
}

(async function init() {
  wire();
  setEditorView('edit');
  try {
    // Load case config for dynamic UI elements
    try {
      window.__caseConfig = await api('/api/case/config');
      const brand = document.querySelector('.brand__title');
      if (brand && window.__caseConfig.appTitle) brand.textContent = window.__caseConfig.appTitle;
    } catch { window.__caseConfig = {}; }
    updateStatusBar();
    loadDeadlines();
    loadFilingContextOptions();
    const st = await api('/api/state');
    if (!(st.conversations || []).length) {
      await api('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'Drafting' }),
      });
    }
    await refreshState();
  } catch (e) {
    console.error(e);
    showToast(`Failed to load UI state: ${e.message}`, { type: 'error', duration: 8000 });
  }
})();
