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
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0

echo "$(date '+%F %T') updating $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
git merge -q --ff-only origin/main

# The same compose files the server was started with: Tailscale is added when its container is running.
set -- -f docker-compose.yml
if [ -f docker-compose.tailscale.yml ] && docker compose -f docker-compose.yml -f docker-compose.tailscale.yml ps -q tailscale 2>/dev/null | grep -q .; then
  set -- "$@" -f docker-compose.tailscale.yml
fi
docker compose "$@" up -d --build
echo "$(date '+%F %T') running $(git rev-parse --short HEAD)"
