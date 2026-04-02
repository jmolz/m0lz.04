---
name: intake-files
description: Process new documents in _Inbox — review, rename, organize, index, flag deadlines
---

Steps:
1. List all files in _Inbox/. If empty, report and stop.
2. For each file: read contents, determine type/party/date/index/description.
3. Rename per convention: YYYY-MM-DD_IDXNNN_DocType_Party_Description.ext
4. Move to correct subfolder per file-management rules.
5. Add record to documents table in case-tracker.db.
6. Ingest into local-rag for semantic search.
7. Store key entities/facts in memory knowledge graph.
8. Check if document triggers deadlines (motions needing response = 30 days + 3 mail; discovery = 30 days; check notices for hearing dates). Add deadlines to case-tracker.db.
9. Update 00_Case_Overview/case_timeline.md and case_index.md.
10. Report for each file: old→new name, destination, summary, deadlines, strategic observations.
