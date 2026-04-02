---
description: Restart the Case Pilot UI server (unload + load LaunchAgent)
---

1. Unload the LaunchAgent:
// turbo
```bash
launchctl unload ~/Library/LaunchAgents/com.casepilot.ui.plist
```

2. Clear previous logs:
// turbo
```bash
: > scripts/logs/ui-stdout.log && : > scripts/logs/ui-stderr.log
```

3. Reload the LaunchAgent:
// turbo
```bash
launchctl load ~/Library/LaunchAgents/com.casepilot.ui.plist
```

4. Verify it started:
// turbo
```bash
sleep 2 && cat scripts/logs/ui-stdout.log
```
