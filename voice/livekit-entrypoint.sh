#!/bin/sh
# Writes a LiveKit config from the environment and starts the server.
# Signaling stays on 7880 inside the docker network. Only the WebRTC ports are published.
set -eu
flag() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    on|1|true|yes) return 0 ;;
    *) return 1 ;;
  esac
}
if ! flag "${LIVE_VOICE:-}"; then
  echo "livekit: LIVE_VOICE is off, not listening"
  exit 0
fi
if [ -z "${LIVEKIT_API_KEY:-}" ] || [ -z "${LIVEKIT_API_SECRET:-}" ] || [ -z "${LIVEKIT_NODE_IP:-}" ]; then
  echo "livekit: need LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_NODE_IP (the public address, for example 37.60.240.231)"
  exit 1
fi
case "${LIVEKIT_API_KEY}${LIVEKIT_API_SECRET}${LIVEKIT_NODE_IP}" in
  *[\"]*|*" "*) echo "livekit: key, secret and node ip must not contain quotes or spaces. Use hex." ; exit 1 ;;
esac
UDP_START="${LIVEKIT_UDP_START:-50000}"
UDP_END="${LIVEKIT_UDP_END:-50019}"
TCP_PORT="${LIVEKIT_TCP_PORT:-7881}"
cat > /tmp/livekit.yaml << EOF
port: 7880
rtc:
  tcp_port: ${TCP_PORT}
  port_range_start: ${UDP_START}
  port_range_end: ${UDP_END}
  node_ip: ${LIVEKIT_NODE_IP}
  use_external_ip: false
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
logging:
  level: info
EOF
exec /usr/local/bin/livekit-server --config /tmp/livekit.yaml
