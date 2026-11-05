# HELPER live voice. LiveKit Agents owns the room, the turn detector and barge-in.
# Groq Whisper hears Hebrew. Speech is ElevenLabs when HELPER has a voice, otherwise edge-tts.
# Every reply is a normal HELPER turn: same tools, same WhatsApp approval for send / pay / call / delete.
import asyncio
import os

import aiohttp
from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession, JobProcess
from livekit.plugins import groq, silero

from edge_pcm import edge_pcm, pcm_frames

HELPER = os.environ.get("HELPER_URL", "http://helper:3210").rstrip("/")
SECRET = os.environ.get("LIVEKIT_API_SECRET", "")


def stt_options():
    key = os.environ.get("GROQ_API_KEY") or os.environ.get("LIVE_VOICE_STT_KEY") or ""
    base = os.environ.get("LIVE_VOICE_STT_BASE_URL") or ""
    voice_base = os.environ.get("VOICE_BASE_URL") or ""
    if not key and os.environ.get("VOICE_API_KEY") and ("groq" in voice_base or os.environ.get("STT_MODEL")):
        key = os.environ["VOICE_API_KEY"]
        base = base or voice_base
    base = base or "https://api.groq.com/openai/v1"
    model = os.environ.get("LIVE_VOICE_STT_MODEL") or os.environ.get("STT_MODEL") or "whisper-large-v3-turbo"
    if not key:
        raise RuntimeError("missing GROQ_API_KEY (or VOICE_API_KEY aimed at a Whisper endpoint)")
    os.environ["GROQ_API_KEY"] = key
    return groq.STT(
        model=model,
        api_key=key,
        base_url=base,
        language="he",
        prompt="שיחה בעברית. שמות: הלפר, וובטופ.",
    )


def latest_user(chat_ctx) -> str:
    for item in reversed(list(getattr(chat_ctx, "items", []) or [])):
        if getattr(item, "role", None) != "user":
            continue
        text = getattr(item, "text_content", None) or ""
        if str(text).strip():
            return str(text).strip()
    return ""


async def _post(path: str, payload: dict, timeout: int):
    headers = {"Authorization": f"Bearer {SECRET}"}
    client_timeout = aiohttp.ClientTimeout(total=timeout)
    async with aiohttp.ClientSession(timeout=client_timeout) as session:
        async with session.post(HELPER + path, json=payload, headers=headers) as res:
            kind = res.headers.get("Content-Type", "")
            if "json" in kind or res.status >= 400 and "audio" not in kind:
                try:
                    body = await res.json(content_type=None)
                except Exception:
                    body = {"error": (await res.text())[:300]}
                return res.status, kind, body
            return res.status, kind, await res.read()


async def ask_helper(text: str) -> str:
    try:
        status, _kind, body = await _post("/internal/live/turn", {"text": text[:4000]}, 300)
    except Exception:
        return "אין לי קשר לשרת כרגע."
    if status != 200 or not isinstance(body, dict):
        return "לא הצלחתי להשלים את זה עכשיו."
    return str(body.get("reply") or "").strip() or "אין לי תשובה."


async def speak_pcm(text: str) -> bytes:
    voice = os.environ.get("EDGE_TTS_VOICE") or "he-IL-HilaNeural"
    try:
        status, _kind, body = await _post("/internal/live/tts", {"text": text[:1500]}, 60)
    except Exception:
        return await edge_pcm(text, voice)
    if status == 200 and isinstance(body, (bytes, bytearray)) and body:
        return bytes(body)
    if isinstance(body, dict) and body.get("voice"):
        voice = str(body["voice"])
    if isinstance(body, dict) and body.get("engine") == "empty":
        return b""
    return await edge_pcm(text, voice)


class HelperVoice(Agent):
    def __init__(self):
        super().__init__(
            instructions="אתה HELPER. התשובה המדוברת מגיעה מהשרת של HELPER, לא מכאן.",
            allow_interruptions=True,
        )

    async def on_enter(self):
        await self.session.say("היי, אני כאן.", allow_interruptions=True)

    async def llm_node(self, chat_ctx, tools, model_settings):
        text = latest_user(chat_ctx)
        if not text:
            return
        yield await ask_helper(text)

    async def tts_node(self, text, model_settings):
        parts = []
        async for chunk in text:
            parts.append(str(chunk))
        pcm = await speak_pcm("".join(parts))
        for frame in pcm_frames(pcm):
            yield frame


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load(force_cpu=True)


server = AgentServer(
    num_idle_processes=1,
    setup_fnc=prewarm,
    initialize_process_timeout=60,
    port=8081,
)


@server.rtc_session()
async def helper_voice(ctx: agents.JobContext):
    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=stt_options(),
        allow_interruptions=True,
        min_endpointing_delay=0.35,
        max_endpointing_delay=1.3,
    )
    await session.start(HelperVoice(), room=ctx.room, record=False)


if __name__ == "__main__":
    if os.environ.get("LIVE_VOICE", "").strip().lower() not in {"on", "1", "true", "yes"}:
        print("LIVE_VOICE is off; not starting the voice agent")
        raise SystemExit(0)
    if not os.environ.get("LIVEKIT_API_KEY") or not os.environ.get("LIVEKIT_API_SECRET"):
        raise SystemExit("LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required")
    agents.cli.run_app(server)
