---
description: Start the Case Pilot UI server (LaunchAgent)
---

1. Load the LaunchAgent:
// turbo
```bash
launchctl load ~/Library/LaunchAgents/com.casepilot.ui.plist
```

2. Wait a moment and verify it is running:
// turbo
```bash
sleep 2 && launchctl list | grep com.casepilot.ui && echo "---" && lsof -ti :3210 && echo "UI server is running on http://127.0.0.1:3210"
```
