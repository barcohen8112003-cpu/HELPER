# The assistant as a container, for running on a server (Render, or anywhere Docker runs).
FROM node:24-slim

# Chromium reads pages that only render with JavaScript. The fonts make Hebrew pages come out as text.
# xvfb gives Google Home a real display: Google often refuses sign-in in a headless browser.
# xauth is required by xvfb-run; without it the virtual screen never starts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-core ca-certificates tini xvfb xauth \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY persona.md persona.short.md ./

# Everything that must survive a restart lives here: the WhatsApp session, connected accounts, memory, watches.
# Mount a persistent disk at this path.
ENV HELPER_DATA_DIR=/var/data \
    TIMEZONE=Asia/Jerusalem \
    COMPUTER_MODE=off \
    PC_BRIDGE_LISTEN=1 \
    PC_BRIDGE_PORT=3212 \
    NODE_ENV=production

EXPOSE 3210 3212

# tini passes signals on, so a stop from the platform closes the WhatsApp connection cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
