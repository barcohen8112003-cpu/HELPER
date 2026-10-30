# Commit list for the post-deploy WhatsApp note. `git pull --ff-only && docker compose up -d --build`
# is enough: this stage reads .git when the build context has it (a normal checkout) and writes
# build-info.json. .git is not copied into the final image. Without .git the build still succeeds and
# GIT_SHA is used; an unknown sha sends no WhatsApp note.
FROM node:24-slim AS notes
RUN apt-get update && apt-get \
    install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN mkdir -p /out && node scripts/write-build-info.mjs --out /out/build-info.json

# The assistant as a container, for running on a server (Render, or anywhere Docker runs).
FROM node:24-slim

# Chromium reads pages that only render with JavaScript. The fonts make Hebrew pages come out as text.
# xvfb gives Google Home a real display: Google often refuses sign-in in a headless browser.
# xauth is required by xvfb-run; without it the virtual screen never starts.
# CLOUD_DESKTOP=1 uses one shared Xvfb, fluxbox, x11vnc on localhost, and noVNC (websockify) on 6080.
# 6080 stays inside the container. Do not publish it.
# Debian's adb package is too old: `adb pair` exits with "unknown command". Current platform-tools
# provides pair and tcpip. The key adb generates lives on the data volume, not in the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fonts-noto-core ca-certificates tini xvfb xauth unzip curl \
      fluxbox wmctrl x11vnc novnc websockify \
 && curl -fsSL -o /tmp/platform-tools.zip https://dl.google.com/android/repository/platform-tools-latest-linux.zip \
 && unzip -q /tmp/platform-tools.zip -d /opt \
 && ln -sf /opt/platform-tools/adb /usr/local/bin/adb \
 && rm -rf /tmp/platform-tools.zip \
 && rm -rf /var/lib/apt/lists/*

ENV ADB_PATH=/opt/platform-tools/adb

# Claude Code: build jobs (sites, scripts) on the user's Claude plan, signed in with CLAUDE_CODE_OAUTH_TOKEN.
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# Optional: Scrapling for fetch_page (py/README.md). Off by default, so a normal build and the auto-update on the
# server do not change. Build with --build-arg INSTALL_SCRAPLING=true, then set SCRAPLING_ENABLED=true in .env.
# Debian's python3 in its own venv; no browsers (scrapling install is not run).
COPY py ./py
ARG INSTALL_SCRAPLING=false
RUN if [ "$INSTALL_SCRAPLING" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
   && rm -rf /var/lib/apt/lists/* \
   && python3 -m venv /opt/scrapling-venv \
   && /opt/scrapling-venv/bin/pip install --no-cache-dir -r py/requirements-scrapling.txt \
   && /opt/scrapling-venv/bin/python -I -c 'from scrapling.fetchers import Fetcher; print("fetcher import OK")' ; \
    fi
ENV SCRAPLING_PYTHON=/opt/scrapling-venv/bin/python
COPY persona.md persona.short.md persona.voice.md ./
COPY --from=notes /out/build-info.json ./build-info.json
ARG GIT_SHA=
ENV GIT_SHA=${GIT_SHA}

# Everything that must survive a restart lives here: the WhatsApp session, connected accounts, memory, watches.
# Mount a persistent disk at this path.
ENV HELPER_DATA_DIR=/var/data \
    TIMEZONE=Asia/Jerusalem \
    COMPUTER_MODE=off \
    PC_BRIDGE_LISTEN=1 \
    PC_BRIDGE_PORT=3212 \
    NODE_ENV=production

# 3210 is the settings site (it proxies the desktop). 3212 is the home bridge. 6080 is not exposed.
EXPOSE 3210 3212

# tini passes signals on, so a stop from the platform closes the WhatsApp connection cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
