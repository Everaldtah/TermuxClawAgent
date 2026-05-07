#!/data/data/com.termux/files/usr/bin/bash
# Solis watchdog — keeps telegram-agent-bridge.mjs running forever.
# Restarts on crash, backs off if it keeps failing fast.

TERMUX_HOME="/data/data/com.termux/files/home"
AGENT="${TERMUX_HOME}/TermuxClawAgent/telegram-agent-bridge.mjs"
LOG="${TERMUX_HOME}/agent-bot.log"
FAIL_COUNT=0
LAST_START=0

rotate_log() {
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 2097152 ]; then
    tail -c 524288 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Log rotated." >> "$LOG"
  fi
}

while true; do
  rotate_log

  NOW=$(date +%s)
  UPTIME=$(( NOW - LAST_START ))
  LAST_START=$NOW

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Solis gateway (attempt after ${UPTIME}s back-off)..." | tee -a "$LOG"

  node "$AGENT" >> "$LOG" 2>&1
  EXIT=$?

  # If it ran for more than 30s, treat as healthy — reset fail counter
  RUN_TIME=$(( $(date +%s) - LAST_START ))
  if [ "$RUN_TIME" -gt 30 ]; then
    FAIL_COUNT=0
  else
    FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  fi

  # Exponential back-off: 5s 10s 20s 40s cap 60s
  BACKOFF=$(( 5 * (1 << (FAIL_COUNT < 4 ? FAIL_COUNT : 4)) ))
  [ "$BACKOFF" -gt 60 ] && BACKOFF=60

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Agent exited (code $EXIT, ran ${RUN_TIME}s, fails=$FAIL_COUNT). Restart in ${BACKOFF}s..." | tee -a "$LOG"
  sleep "$BACKOFF"
done
