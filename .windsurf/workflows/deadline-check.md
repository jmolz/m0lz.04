---
name: deadline-check
description: Report all pending deadlines with urgency levels
---

Steps:
1. Query case-tracker.db: SELECT * FROM deadlines WHERE status = 'pending' ORDER BY due_date ASC.
2. For each: calculate days remaining from today.
3. Labels: OVERDUE (past due), CRITICAL (≤7 days), URGENT (≤14 days), NORMAL (>14 days).
4. Show: description, due date, days remaining, urgency label, triggering event, rule reference, required action.
5. Recommend priority actions.
