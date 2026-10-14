#!/usr/bin/env bash
# One-time setup of the assistant on an Android phone, inside Termux. Run it from the HELPER folder:
#   bash termux-setup.sh
# Installs Node.js, the assistant's packages, and a boot script so the assistant starts with the phone.
set -e
cd "$(dirname "$0")"

echo "== מתקין Node.js =="
pkg update -y
pkg install -y nodejs-lts git

echo "== מתקין את החבילות של העוזר =="
# --omit=peer skips sharp (image thumbnails), which has no build for Android. WhatsApp sends images without it.
npm ci --omit=dev --omit=peer

chmod +x start.sh

# Termux:Boot (a separate app, from the same store as Termux) runs every script in ~/.termux/boot at start-up.
mkdir -p ~/.termux/boot
cat >~/.termux/boot/helper.sh <<EOF
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
"$PWD/start.sh" --bg
EOF
chmod +x ~/.termux/boot/helper.sh

echo
if [ -f .env ]; then
  echo "== מוכן. להפעלה: ./start.sh =="
else
  echo "== חסר קובץ .env =="
  echo "העתק את .env מהמחשב לתיקייה הזאת (או: cp .env.example .env ומלא אותו), ואז: ./start.sh"
fi
