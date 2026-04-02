#!/bin/bash
# Wrapper script for launchd to run the daily Case Pilot monitor + research sync
# Logs stdout/stderr to the scripts/logs directory

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

DATE=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/${DATE}.log"

echo "=== Court Filing Check: $(date) ===" >> "$LOG_FILE"
node "$SCRIPT_DIR/check-court-filings.js" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "ERROR: Script exited with code $EXIT_CODE" >> "$LOG_FILE"
  # Send macOS notification on failure
  osascript -e "display notification \"Court filing check failed — see log\" with title \"Case Pilot\" sound name \"Basso\""
else
  # Check if new filings were found (grep the log)
  if grep -q "NEW FILINGS DETECTED" "$LOG_FILE"; then
    osascript -e "display notification \"New court filings detected!\" with title \"Case Pilot\" sound name \"Glass\""
  fi

  echo "" >> "$LOG_FILE"
  echo "=== Research Library Sync: $(date) ===" >> "$LOG_FILE"
  node "$SCRIPT_DIR/sync-research-library.js" >> "$LOG_FILE" 2>&1
  SYNC_EXIT=$?

  if [ $SYNC_EXIT -ne 0 ]; then
    echo "ERROR: Research sync exited with code $SYNC_EXIT" >> "$LOG_FILE"
    osascript -e "display notification \"Research library sync failed — see log\" with title \"Case Pilot\" sound name \"Basso\""
  else
    echo "" >> "$LOG_FILE"
    echo "=== Calendar Deadline Sync: $(date) ===" >> "$LOG_FILE"
    node "$SCRIPT_DIR/sync-calendar-deadlines.js" >> "$LOG_FILE" 2>&1
    CAL_EXIT=$?
    if [ $CAL_EXIT -ne 0 ]; then
      echo "ERROR: Calendar deadline sync exited with code $CAL_EXIT" >> "$LOG_FILE"
      osascript -e "display notification \"Calendar deadline sync failed — see log\" with title \"Case Pilot\" sound name \"Basso\""
    fi

    echo "" >> "$LOG_FILE"
    echo "=== Research Status Metadata Sync: $(date) ===" >> "$LOG_FILE"
    node "$SCRIPT_DIR/sync-research-status.js" >> "$LOG_FILE" 2>&1
    STATUS_EXIT=$?
    if [ $STATUS_EXIT -ne 0 ]; then
      echo "ERROR: Research status sync exited with code $STATUS_EXIT" >> "$LOG_FILE"
      osascript -e "display notification \"Research status sync failed — see log\" with title \"Case Pilot\" sound name \"Basso\""
    fi

    if grep -q "RESEARCH UPDATES DETECTED" "$LOG_FILE"; then
      osascript -e "display notification \"Research library updated (laws/rules/case law)\" with title \"Case Pilot\" sound name \"Glass\""
    fi
  fi
fi
