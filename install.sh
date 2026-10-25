#!/usr/bin/env bash
# HELPER in one command, on Linux or macOS (a server, a Raspberry Pi):
#
#   curl -fsSL https://raw.githubusercontent.com/barcohen8112003-cpu/HELPER/main/install.sh | bash
#
# Needs Node.js 24+ and git (it says how to get them when missing). Downloads HELPER to ~/HELPER (HELPER_DIR to
# change), installs its packages, adds the "helper" command and starts the setup wizard. Wizard flags go after
# "bash -s --", e.g.  curl … | bash -s -- --yes --api-key=sk-…
set -euo pipefail
REPO="https://github.com/barcohen8112003-cpu/HELPER.git"
DIR="${HELPER_DIR:-$HOME/HELPER}"
BRANCH="${HELPER_BRANCH:-main}"

say() { printf '  %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

printf '\n  \033[36mHELPER — התקנה בפקודה אחת\033[0m\n\n'

command -v node >/dev/null || die "צריך Node.js 24 ומעלה: https://nodejs.org (או: curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs)"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || die "Node.js $(node -v) ישן מדי: צריך 24 ומעלה"
ok "Node.js $(node -v)"
command -v git >/dev/null || die "צריך git (sudo apt-get install -y git)"
ok "$(git --version)"

if [ -f "./package.json" ] && grep -q '"name": *"helper"' ./package.json; then
  DIR="$(pwd)"; ok "משתמש בתיקייה הזו: $DIR"
elif [ -f "$DIR/package.json" ]; then
  ok "כבר קיים: $DIR"; (cd "$DIR" && git pull --ff-only) || true
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"; ok "הורד ל-$DIR"
fi

cd "$DIR"
[ -d node_modules ] || npm install --no-audit --no-fund
ok "החבילות של הבוט"
if npm link --no-audit --no-fund >/dev/null 2>&1 && command -v helper >/dev/null; then ok "הפקודה helper מוכנה"; else say "בלי פקודת helper גלובלית: npm run setup / npm run doctor"; fi

# The wizard reads its answers from the keyboard, also when this script came through a pipe.
if [ -t 1 ] && [ -e /dev/tty ]; then exec node scripts/setup.mjs "$@" < /dev/tty; else exec node scripts/setup.mjs --yes "$@"; fi
