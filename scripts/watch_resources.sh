#!/usr/bin/env bash
# Logs CPU% and RSS memory for the ai-camera systemd services at a fixed
# interval, so a multi-hour run can be checked afterward for leaks (RSS that
# keeps climbing instead of leveling off).
set -euo pipefail

INTERVAL="${1:-60}"
LOG="${2:-$HOME/ai-camera-resource-log.csv}"
SERVICES=(ai-camera-bridge ai-camera-data-api ai-camera-detector)

if [ ! -f "$LOG" ]; then
  echo "timestamp,service,pid,cpu_pct,rss_kb" > "$LOG"
fi

echo "Logging every ${INTERVAL}s to $LOG (Ctrl+C to stop)"

while true; do
  ts="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  for svc in "${SERVICES[@]}"; do
    pid="$(systemctl show -p MainPID --value "$svc" 2>/dev/null || echo 0)"
    if [ -n "$pid" ] && [ "$pid" != "0" ]; then
      read -r cpu rss < <(ps -o %cpu=,rss= -p "$pid" 2>/dev/null || echo "NA NA")
      echo "$ts,$svc,$pid,${cpu:-NA},${rss:-NA}" >> "$LOG"
    else
      echo "$ts,$svc,,NA,NA" >> "$LOG"
    fi
  done
  sleep "$INTERVAL"
done
