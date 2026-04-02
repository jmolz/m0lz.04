# Scripts

This directory contains automation scripts for Case Pilot — court filing monitor and legal research library.

## Daily launchd entrypoint

- `run-court-check.sh` (called by launchd)
  - Runs `check-court-filings.js` (Tyler Tech portal scrape + PDF downloads)
  - Runs `sync-research-library.js` (statutes + local rules + case law update)
  - Runs `sync-calendar-deadlines.js` (parses 9C session schedule PDFs into tracked calendar-request deadlines)

## Statutes

- `download-statutes.js` / `extract-statutes.js` — original statutes pipeline
- `download-statutes-v2.js` / `extract-statutes-v2.js` — expanded coverage pipeline

## Local UI (localhost only)

- `ui-server.js` — serves a local drafting UI at <http://127.0.0.1:3210>
  - Conversations + messages stored in `scripts/ui-state/state.json`
  - Draft workflow:
    - Create a draft from an assistant message
    - Save draft into the case folder structure using the naming convention
    - Regenerate/update a draft via Anthropic using update instructions

Run:

```bash
cd scripts
ANTHROPIC_API_KEY=... npm run ui
```

Alternatively (recommended for LaunchAgents): create a local env file at `scripts/ui-state/.env`:

```env
ANTHROPIC_API_KEY=YOUR_KEY_HERE
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
ANTHROPIC_MAX_TOKENS=4000
ANTHROPIC_THINKING_MODE=auto
ANTHROPIC_THINKING_EFFORT=medium
# Optional for manual thinking mode:
# ANTHROPIC_THINKING_BUDGET_TOKENS=4096
```

Then you can run `npm run ui` without pasting the key each time.

Notes:

- `ANTHROPIC_MAX_TOKENS` is the per-response output cap. You can raise it for long drafts, but very large values can be slow/expensive and may be rejected by the API.
- `ANTHROPIC_THINKING_MODE` supports `auto`, `adaptive`, `enabled` (`manual`), and `off`.
- For `claude-opus-4-6` / `claude-sonnet-4-6`, `auto` prefers adaptive thinking (`thinking: {type: "adaptive"}`).
- `ANTHROPIC_THINKING_EFFORT` supports `low`, `medium`, `high`, `max`.
- `ANTHROPIC_THINKING_BUDGET_TOKENS` is used for manual mode and must be less than `ANTHROPIC_MAX_TOKENS`.

## Daily Research Sync

`sync-research-library.js` runs three sync phases:

1. **Statutes** — re-downloads NC statute chapter HTML for tracked chapters; archives old versions on change
2. **Local Rules PDFs** — re-downloads curated civil district court PDFs (rules, admin orders, CVD forms) from the Wake County portal; hash-compares and archives old versions on change
3. **Case Law** — queries CourtListener API for recent NC Supreme Court and Court of Appeals opinions matching case-relevant search terms (standing, debt buyer, POA, substitution, jurisdiction); writes markdown digest files to `07_Research/case_law/digests/`

## Calendar Request Deadline Sync

`sync-calendar-deadlines.js` reads Civil District 9C session schedule PDFs from:

- `07_Research/local_rules/calendars/`

It extracts schedule rows and inserts/upserts deadline entries in `case-tracker.db` so they appear in:

- `GET /api/case/deadlines`
- `/deadline-check` command output
