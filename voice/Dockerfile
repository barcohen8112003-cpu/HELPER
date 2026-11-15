# Voice worker. Not part of the default image: `docker compose --profile live-voice build`.
# Silero VAD is the small CPU model shipped with livekit-agents. No GPU.
# edge-tts (requirements.txt) is the default speech engine. ffmpeg turns its MP3 into 16 kHz PCM.
FROM python:3.12-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY agent.py edge_pcm.py ./
RUN python -m py_compile agent.py edge_pcm.py \
 && python -c "from livekit.plugins import silero, groq; silero.VAD.load(force_cpu=True); print('vad ok', groq.__name__)"
ENV PYTHONUNBUFFERED=1
# 8081 is the worker's health port inside this container. Do not publish it.
EXPOSE 8081
CMD ["python", "agent.py", "start"]
