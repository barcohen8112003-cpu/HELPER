# HELPER live voice. LiveKit Agents owns the room, the turn detector and barge-in.
# Groq Whisper hears Hebrew. Speech is ElevenLabs when HELPER has a voice, otherwise edge-tts.
# Every reply is a normal HELPER turn: same tools, same WhatsApp approval for send / pay / call / delete.
# A phone call (LiveKit Cloud number) lands in the same agent. Only the owner's number gets HELPER.
import asyncio
import os
import random
import re

import aiohttp
from livekit import agents, rtc
from livekit.agents import Agent, AgentServer, AgentSession, JobProcess
from livekit.plugins import groq, silero

from edge_pcm import edge_pcm, pcm_frames

HELPER = os.environ.get("HELPER_URL", "http://helper:3210").rstrip("/")
SECRET = os.environ.get("LIVEKIT_API_SECRET", "")
# Empty = joins every new room (the docker server). A name = joins only when dispatched (Cloud phone numbers).
AGENT_NAME = os.environ.get("LIVE_VOICE_AGENT_NAME", "").strip()


def _seconds(name: str, default: float) -> float:
    try:
        return max(0.0, float(os.environ.get(name, "") or default))
    except ValueError:
        return default


# When HELPER takes longer than this, a short "רגע" goes out so the line is not silent. 0 = never.
FILLER_AFTER = _seconds("LIVE_VOICE_FILLER_AFTER", 1.2)
FILLERS = ("רגע.", "שנייה.", "רגע, בודק.")
# Sentences are spoken as soon as each is ready, not after the whole reply.
SENTENCE_END = re.compile(r"(?<=[.!?…:;])\s+|\n+")


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


async def caller_allowed(number: str) -> bool:
    # Fails closed: no answer from HELPER means the call is hung up.
    if not number:
        return False
    try:
        status, _kind, body = await _post("/internal/live/caller", {"text": number[:40]}, 10)
    except Exception:
        return False
    return status == 200 and isinstance(body, dict) and body.get("allowed") is True


def split_ready(buf: str):
    """Complete sentences in buf, and the unfinished rest."""
    parts = SENTENCE_END.split(buf)
    if len(parts) == 1:
        return [], buf
    return [p.strip() for p in parts[:-1] if p.strip()], parts[-1]


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
    def __init__(self, greeting: str = "היי, אני כאן."):
        super().__init__(
            instructions="אתה HELPER. התשובה המדוברת מגיעה מהשרת של HELPER, לא מכאן.",
            allow_interruptions=True,
        )
        self.greeting = greeting

    async def on_enter(self):
        await self.session.say(self.greeting, allow_interruptions=True)

    async def llm_node(self, chat_ctx, tools, model_settings):
        text = latest_user(chat_ctx)
        if not text:
            return
        task = asyncio.ensure_future(ask_helper(text))
        try:
            if FILLER_AFTER > 0:
                done, _ = await asyncio.wait({task}, timeout=FILLER_AFTER)
                if not done:
                    yield random.choice(FILLERS) + "\n"
            yield await task
        finally:
            # Barge-in or hang-up: the request closes, and HELPER drops the turn.
            if not task.done():
                task.cancel()

    async def tts_node(self, text, model_settings):
        # Each sentence is synthesized as soon as it is complete; two at a time, played in order.
        gate = asyncio.Semaphore(2)
        jobs: asyncio.Queue = asyncio.Queue()

        async def synth(line: str) -> bytes:
            async with gate:
                return await speak_pcm(line)

        async def read():
            buf = ""
            try:
                async for chunk in text:
                    buf += str(chunk)
                    ready, buf = split_ready(buf)
                    for line in ready:
                        await jobs.put(asyncio.ensure_future(synth(line)))
                if buf.strip():
                    await jobs.put(asyncio.ensure_future(synth(buf.strip())))
            finally:
                await jobs.put(None)

        reader = asyncio.ensure_future(read())
        try:
            while True:
                job = await jobs.get()
                if job is None:
                    break
                for frame in pcm_frames(await job):
                    yield frame
        finally:
            reader.cancel()
            while not jobs.empty():
                job = jobs.get_nowait()
                if job is not None:
                    job.cancel()


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load(force_cpu=True)


server = AgentServer(
    num_idle_processes=1,
    setup_fnc=prewarm,
    initialize_process_timeout=60,
    port=8081,
)


@server.rtc_session(agent_name=AGENT_NAME)
async def helper_voice(ctx: agents.JobContext):
    await ctx.connect()
    greeting = "היי, אני כאן."
    caller = await ctx.wait_for_participant()
    if caller.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
        number = caller.attributes.get("sip.phoneNumber", "")
        if not await caller_allowed(number):
            # Not the owner: hang up before any speech, STT or model call costs anything.
            print("phone call from a number that is not allowed; hanging up")
            await ctx.delete_room()
            return
        greeting = "היי, כאן הלפר."
    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=stt_options(),
        allow_interruptions=True,
        min_endpointing_delay=_seconds("LIVE_VOICE_MIN_ENDPOINT", 0.3),
        max_endpointing_delay=_seconds("LIVE_VOICE_MAX_ENDPOINT", 1.1),
    )
    await session.start(HelperVoice(greeting), room=ctx.room, record=False)


if __name__ == "__main__":
    if os.environ.get("LIVE_VOICE", "").strip().lower() not in {"on", "1", "true", "yes"}:
        print("LIVE_VOICE is off; not starting the voice agent")
        raise SystemExit(0)
    if not os.environ.get("LIVEKIT_API_KEY") or not os.environ.get("LIVEKIT_API_SECRET"):
        raise SystemExit("LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required")
    agents.cli.run_app(server)
