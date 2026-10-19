#!/usr/bin/env bash
# First-time setup on an Oracle Always Free Ubuntu ARM VM.
# Run as ubuntu after SSH: bash oracle-setup.sh
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl git

# Docker official install (works on Ubuntu ARM64)
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "Logged out of the docker group until you reconnect SSH once."
fi

sudo systemctl enable --now docker

echo
echo "Next:"
echo "  1. Reconnect SSH if this was the first Docker install"
echo "  2. Clone the private repo into ~/HELPER"
echo "  3. Copy .env and (optional) data/google.json + data/state.json"
echo "  4. cd ~/HELPER && docker compose up -d --build"
echo "  5. docker compose logs -f   # pairing code appears here"
echo "  6. Stop the bot on your home PC before pairing"
echo "  7. Open TCP 3212 in the VCN security list (the home PC dials out to it)."
echo "     Ubuntu images often drop new ports; if so: sudo iptables -I INPUT -p tcp --dport 3212 -j ACCEPT"
