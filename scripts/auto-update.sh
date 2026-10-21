#!/bin/sh
# Keeps the cloud HELPER on the latest main from GitHub: every run fetches, and only when main moved does it pull and
# rebuild the container. Run by cron on the server. Install once, from the HELPER folder on the server:
#
#   chmod +x scripts/auto-update.sh
#   (crontab -l 2>/dev/null; echo "*/10 * * * * $PWD/scripts/auto-update.sh >> $HOME/helper-update.log 2>&1") | crontab -
#
# Whatever is merged to main goes live within ten minutes, and the assistant restarts for a few seconds when it does.
# A server with local edits is left alone (the pull is fast-forward only) and the log says why.
set -eu
cd "$(dirname "$0")/.."

# One run at a time: a rebuild can outlast the ten minutes.
LOCK=/tmp/helper-auto-update.lock
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK"' EXIT

git fetch -q origin main
TARGET=$(git rev-parse origin/main)
[ "$(git rev-parse HEAD)" = "$TARGET" ] && exit 0
# A commit that already failed here is not tried again; the next commit on main is.
BAD=.auto-update-bad-commit
[ -f "$BAD" ] && [ "$(cat "$BAD")" = "$TARGET" ] && exit 0

PREVIOUS=$(git rev-parse HEAD)
echo "$(date '+%F %T') updating $(git rev-parse --short HEAD) -> $(git rev-parse --short "$TARGET")"
git merge -q --ff-only origin/main

# The same compose files the server was started with: Tailscale is added when its container is running.
set -- -f docker-compose.yml
if [ -f docker-compose.tailscale.yml ] && docker compose -f docker-compose.yml -f docker-compose.tailscale.yml ps -q tailscale 2>/dev/null | grep -q .; then
  set -- "$@" -f docker-compose.tailscale.yml
fi
# Healthy = the container keeps running and the settings site answers (any HTTP status, even 403, means Node is up).
healthy() {
  i=0
  while [ $i -lt 24 ]; do
    sleep 5
    i=$((i + 1))
    [ "$(docker inspect -f '{{.State.Running}} {{.State.Restarting}}' helper 2>/dev/null)" = "true false" ] || continue
    curl -s -o /dev/null -m 5 http://127.0.0.1:3210/ && return 0
  done
  return 1
}

if docker compose "$@" up -d --build && healthy; then
  rm -f "$BAD"
  echo "$(date '+%F %T') running $(git rev-parse --short HEAD)"
  exit 0
fi

# The new version did not come up within two minutes: go back to the one that worked and say so on WhatsApp.
SHORT=$(git rev-parse --short "$TARGET")
echo "$(date '+%F %T') $SHORT did not start; rolling back to $(git rev-parse --short "$PREVIOUS")"
echo "$TARGET" > "$BAD"
git reset -q --keep "$PREVIOUS"
if docker compose "$@" up -d --build && healthy; then
  printf '%s\n' "⚠️ העדכון האחרון ($SHORT) לא עלה בשרת, אז חזרתי לגרסה הקודמת. Helper עובד כרגיל, והעדכון הבא ב-main ינוסה כרגיל." |
    docker exec -i helper sh -c 'cat > "$HELPER_DATA_DIR/deploy-notice.txt"'
  docker restart helper >/dev/null
  echo "$(date '+%F %T') rolled back, running $(git rev-parse --short HEAD)"
else
  echo "$(date '+%F %T') the rollback did not come up either"
fi
exit 1
