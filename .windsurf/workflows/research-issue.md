---
name: research-issue
description: Research a legal issue and produce a verified research memo
---

Steps:
1. Ask the user: specific legal question, starting cases/statutes, depth level.
2. Search local-rag for case file context.
3. Search CourtListener for NC appellate decisions (Supreme Court first, then CoA, then 4th Circuit federal).
4. Search DuckDuckGo/fetch for statute text from ncleg.gov.
5. Verify every citation.
6. Write research memo per format in research-protocol rules.
7. Save to 07_Research/memos/YYYY-MM-DD_Topic.md.
8. Store findings in memory and research_notes table.
9. Present summary with strategic implications.
