#!/usr/bin/env bash
# Runs the assistant on an Android phone (Termux) or any Linux machine, and restarts it if it stops.
# The phone version of start.bat. Unlike there, nobody is watching the screen, so a crash loop does not end
# the run: after a string of quick crashes it waits a few minutes (Wi-Fi down, say) and tries again.
#   ./start.sh        in the foreground, to see the pairing code and the log
#   ./start.sh --bg   in the background, logging to data/helper.log (what the boot script uses)
cd "$(dirname "$0")" || exit 1
mkdir -p data

if [ "$1" = "--bg" ]; then
  nohup "$0" >>data/helper.log 2>&1 &
  echo "העוזר רץ ברקע. הלוג: data/helper.log"
  exit 0
fi

# Android puts the phone to sleep and stops background apps; a wake lock keeps the assistant running.
command -v termux-wake-lock >/dev/null && termux-wake-lock
[ -d node_modules ] || npm ci --omit=dev --omit=peer

fails=0
while true; do
  node src/index.js
  code=$?
  # 2 = needs you (missing setup, already running). Restarting will not help.
  [ $code -eq 2 ] && exit 2
  # 3 = restart asked for from the settings site.
  [ $code -eq 3 ] && continue
  # The assistant writes data/healthy after five minutes of running: a crash after a good run starts the count over.
  if [ -f data/healthy ]; then
    fails=0
    rm -f data/healthy
  fi
  fails=$((fails + 1))
  if [ $fails -gt 3 ]; then
    echo "$(date '+%F %T') crash loop: waiting 5 minutes after $fails crashes" | tee -a data/crash.log
    sleep 300
    fails=0
  else
    echo "נפל. מפעיל מחדש בעוד 10 שניות (ניסיון $fails מתוך 3)."
    sleep 10
  fi
done
