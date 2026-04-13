<p align="center">
  <img src="branch-mark.svg" width="48" height="48" alt="m0lz.04 branch mark — case-pilot variant">
</p>

<h1 align="center">m0lz.04</h1>

<p align="center">
  <strong>Case Pilot</strong> — AI-powered legal case management for pro se litigants<br>
  Court filing monitor, deadline tracker, citation verification, red team analysis<br>
  <a href="https://m0lz.dev/writing/case-pilot">m0lz.dev/writing/case-pilot</a>
</p>

---

# Case Pilot

AI-powered legal case management for pro se litigants. Built for North Carolina District Court but adaptable to any jurisdiction.

## What It Does

Case Pilot is a local-first, privacy-focused tool that helps self-represented parties manage their litigation. It runs entirely on your machine — no cloud, no third-party access to your case files.

**Core Features:**
- **AI Drafting** — Claude-powered motion/response drafting with full case context (RAG over your local documents)
- **Court Filing Monitor** — Scrapes Tyler Tech Register of Actions portal for new filings, downloads PDFs, organizes into case folders
- **Deadline Tracker** — AI-analyzed deadlines from court events with urgency coloring
- **Citation Verification** — Checks NC case citations against CourtListener, statutes against local library
- **Filing Completeness Checker** — Real-time checks for caption, signature block, certificate of service, jurisdictional reservation
- **Red Team Analysis** — Opposing counsel simulation to stress-test your filings
- **Hearing Prep Generator** — Dual-format oral arguments (full 90-second + nuclear 2-sentence cutoff)
- **DOCX Export** — Court-ready Word documents with proper legal formatting
- **Research Library Sync** — Auto-downloads NC statutes, local rules, and recent case law
- **Assignment Chain Visualizer** — Visual chain-of-title analysis with gap detection

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/jmolz/m0lz.04.git
cd m0lz.04
cd scripts && npm install
```

### 2. Configure your case

```bash
cp case-config.example.json case-config.json
cp .env.example .env
```

Edit `case-config.json` with your case details (parties, case number, court, counsel info). Edit `.env` with your Anthropic API key.

### 3. Initialize the database

```bash
node scripts/setup.js
```

### 4. Start the UI

```bash
cd scripts && node ui-server.js
```

Open http://127.0.0.1:3210 in your browser.

## Project Structure

```
m0lz.04/
├── case-config.example.json   # Template — copy to case-config.json
├── .env.example               # Template — copy to .env
├── 00_Case_Overview/          # Your case index, timeline, strategy notes
├── 01_Pleadings/              # Complaints, answers, amended pleadings
├── 02_Motions/                # Motions, responses, replies
├── 03_Discovery/              # Discovery requests and responses
├── 04_Evidence_Exhibits/      # Evidence and exhibits
├── 05_Court_Orders/           # Court orders
├── 06_Correspondence/         # Letters, emails
├── 07_Research/               # Statutes, local rules, case law, memos
├── 08_Templates/              # Filing templates (motion, notice, COS)
├── 09_Oral_Arguments/         # Hearing prep scripts
├── 10_Arbitration/            # Arbitration materials
├── _Inbox/                    # Drop zone for new documents
├── scripts/
│   ├── ui-server.js           # Main UI server
│   ├── ui-static/             # Frontend (HTML/CSS/JS)
│   ├── case-config.js         # Config loader module
│   ├── case-tools.js          # Citation verification, hearing prep, etc.
│   ├── check-court-filings.js # Tyler Tech portal scraper
│   ├── deadline-analyzer.js   # AI deadline analysis
│   ├── legal-docx-builder.js  # DOCX export engine
│   ├── sync-research-library.js # Statute/rules/case law sync
│   └── run-court-check.sh     # Daily automation wrapper
└── .windsurf/                 # IDE workflows (optional)
```

## Configuration

### case-config.json

All case-specific details live in `case-config.json` (gitignored). See `case-config.example.json` for the full schema:

- **case** — number, court, county, state, division, amount, date filed
- **defendant** — name, address, phone, email, status (Pro Se)
- **plaintiff** — current name, original name, account owner
- **opposingCounsel** — firm, attorneys, service emails
- **portal** — Tyler Tech ROA URL for your case
- **defense** — arguments, jurisdictional reservation, key cases
- **assignmentChain** — chain of title nodes with gap/challenge status

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for AI features |
| `ANTHROPIC_MODEL` | No | Model override (default: claude-3-5-sonnet) |
| `ANTHROPIC_MAX_TOKENS` | No | Max tokens per response (default: 4000) |
| `PORT` | No | UI server port (default: 3210) |

## Daily Automation (macOS)

Create a LaunchAgent at `~/Library/LaunchAgents/com.casepilot.ui.plist` to run the UI server, and use `scripts/run-court-check.sh` for daily filing checks + research sync via a separate LaunchAgent.

## Privacy

- **100% local** — no data leaves your machine except Anthropic API calls (your case context is sent to Claude for drafting)
- **No telemetry** — no analytics, no tracking
- **Gitignored by default** — case-config.json, case-tracker.db, all case document folders, and runtime state are excluded from version control

## License

MIT — see [LICENSE](LICENSE).
