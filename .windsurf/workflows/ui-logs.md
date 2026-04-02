---
description: Show recent Case Pilot UI server logs (stdout + stderr)
---

1. Show the last 30 lines of stdout:
// turbo
```bash
echo "=== STDOUT ===" && tail -30 scripts/logs/ui-stdout.log
```

2. Show the last 30 lines of stderr (errors):
// turbo
```bash
echo "=== STDERR ===" && tail -30 scripts/logs/ui-stderr.log
```
