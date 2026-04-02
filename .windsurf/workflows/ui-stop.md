---
description: Stop the Case Pilot UI server (LaunchAgent)
---

1. Unload the LaunchAgent:
// turbo
```bash
launchctl unload ~/Library/LaunchAgents/com.casepilot.ui.plist
```

2. Confirm it stopped:
// turbo
```bash
launchctl list | grep com.casepilot.ui || echo "UI server stopped."
```
