---
name: draft-motion
description: Draft a complete court-ready motion with NC formatting, research, and verified citations
---

Steps:
1. Ask the user: motion type, rule/authority, relief requested, arguments to emphasize.
2. Search local-rag for relevant case documents. Search CourtListener for NC case law. Search DuckDuckGo/fetch for statutes.
3. Draft full motion in markdown at 02_Motions/defendant/ following ALL legal-drafting rules AND the Jesus Wept standard: every word earns its place, lead with the ask, one idea per paragraph, short sentences, no string citations, bold key phrases, WHEREFORE readable as standalone. Target 3-5 pages for the body — shorter is better.
4. Verify every citation via CourtListener. Flag any unverifiable ones.
5. Convert to DOCX via Pandoc using 08_Templates/legal-reference.docx.
6. Create Notice of Hearing draft if needed.
7. Add document to case-tracker.db. Add opposing counsel response deadlines.
8. ALSO produce a "CUTOFF" (2-sentence oral summary) and "JESUS WEPT" (60-90 second oral argument) for the motion, saved to 09_Oral_Arguments/prep_notes/.
9. Present complete draft. Highlight unverified citations, strategic choices, next steps.
