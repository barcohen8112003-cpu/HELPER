# Lean LiveKit SFU. The binary is the upstream release; this image only adds a shell so the
# key and the public IP can come from the environment instead of a committed config.
FROM alpine:3.21
ARG LIVEKIT_VERSION=1.13.11
RUN apk add --no-cache ca-certificates curl \
 && arch="$(uname -m)" \
 && case "$arch" in \
      x86_64) file=livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz; sha=1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb ;; \
      aarch64) file=livekit_${LIVEKIT_VERSION}_linux_arm64.tar.gz; sha=2af6ce091d6b3c79d1677f8ff1bbb91a8007f40b2325c059b52d38383c0830b6 ;; \
      *) echo "unsupported architecture $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/livekit.tgz "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/${file}" \
 && echo "${sha}  /tmp/livekit.tgz" | sha256sum -c - \
 && tar -xzf /tmp/livekit.tgz -C /usr/local/bin \
 && rm /tmp/livekit.tgz \
 && chmod 755 /usr/local/bin/livekit-server
COPY livekit-entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
EXPOSE 7880 7881 50000-50019/udp
ENTRYPOINT ["/entrypoint.sh"]
