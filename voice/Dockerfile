# Voice worker. Not part of the default image: `docker compose --profile live-voice build`.
# Silero VAD is the small CPU model shipped with livekit-agents. No GPU.
# edge-tts (requirements.txt) is the default speech engine. ffmpeg turns its MP3 into 16 kHz PCM.
FROM python:3.12-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && python - << 'PY'
from pathlib import Path
import livekit.plugins.elevenlabs.stt as stt_mod
p = Path(stt_mod.__file__)
t = p.read_text()
repls = [
    (
        'use_realtime = model == "scribe_v2_realtime"',
        'use_realtime = model in ("scribe_v2_realtime", "scribe_v3_live")',
    ),
    (
        'if self._opts.model_id == "scribe_v2_realtime":',
        'if self._opts.model_id in ("scribe_v2_realtime", "scribe_v3_live"):',
    ),
]
for old, new in repls:
    if old not in t:
        raise SystemExit(f"elevenlabs stt.py patch failed, missing: {old}")
    t = t.replace(old, new)
p.write_text(t)
print("patched", p, "for scribe_v3_live realtime")
PY
COPY agent.py edge_pcm.py fish_pcm.py ./
RUN python -m py_compile agent.py edge_pcm.py fish_pcm.py \
 && python -c "from livekit.plugins import silero, groq, elevenlabs; silero.VAD.load(force_cpu=True); print('vad ok', groq.__name__, elevenlabs.__name__)"
ENV PYTHONUNBUFFERED=1
# 8081 is the worker's health port inside this container. Do not publish it.
EXPOSE 8081
CMD ["python", "agent.py", "start"]
