# Fish Audio speech for live phone calls. Yields 16 kHz mono s16le, same as edge_pcm.
# Selected with LIVE_TTS_PROVIDER, not TTS_PROVIDER, so WhatsApp voice notes stay on ElevenLabs.
import asyncio
import os

FISH_TTS_URL = "https://api.fish.audio/v1/tts"
DEFAULT_VOICE = "98914d63d57c4c459ec9fe25b521c6e6"  # Friendly Hebrew Speaker
PAID_MODEL = "s2.1-pro"
FREE_MODEL = "s2.1-pro-free"
SAMPLE_RATE = 16000
FRAME = SAMPLE_RATE * 20 // 1000 * 2  # 20 ms s16le

# After a 402, remember the free model so later sentences skip the paid attempt.
_active_model = None
_model_lock = asyncio.Lock()


def fish_configured(env=None) -> bool:
    env = os.environ if env is None else env
    key = (env.get("FISH_AUDIO_API_KEY") or "").strip()
    return bool(key)


def live_tts_provider(env=None) -> str:
    env = os.environ if env is None else env
    raw = (env.get("LIVE_TTS_PROVIDER") or "").strip().lower()
    if raw in {"fish", "fishaudio", "fish-audio"}:
        return "fish"
    return ""


def fish_voice(env=None) -> str:
    env = os.environ if env is None else env
    v = (env.get("FISH_AUDIO_VOICE_ID") or DEFAULT_VOICE).strip()
    return v if v else DEFAULT_VOICE


def _preferred_model(env=None) -> str:
    env = os.environ if env is None else env
    raw = (env.get("FISH_AUDIO_TTS_MODEL") or PAID_MODEL).strip()
    return raw or PAID_MODEL


async def _models(env=None):
    global _active_model
    async with _model_lock:
        if _active_model:
            return [_active_model]
    preferred = _preferred_model(env)
    if preferred == FREE_MODEL:
        return [FREE_MODEL]
    return [preferred, FREE_MODEL]


async def _remember(model: str):
    global _active_model
    async with _model_lock:
        _active_model = model


async def iter_fish_pcm(text: str):
    """Stream s16le chunks from Fish Audio. Raises if nothing was spoken."""
    import aiohttp

    line = " ".join(str(text or "").split()).strip()[:1500]
    if not line:
        return
    key = (os.environ.get("FISH_AUDIO_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("missing FISH_AUDIO_API_KEY")
    voice = fish_voice()
    body = {
        "text": line,
        "format": "pcm",
        "sample_rate": SAMPLE_RATE,
        "latency": "balanced",
        "reference_id": voice,
    }
    last_error = None
    for model in await _models():
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "model": model,
        }
        timeout = aiohttp.ClientTimeout(total=45, sock_read=30)
        yielded = False
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(FISH_TTS_URL, json=body, headers=headers) as res:
                    if res.status == 402:
                        err = (await res.text())[:200]
                        last_error = RuntimeError(f"Fish Audio 402 on {model}")
                        print(f"fish-audio {model} needs API credit; trying {FREE_MODEL}" if model != FREE_MODEL else f"fish-audio 402: {err}")
                        continue
                    if res.status != 200:
                        err = (await res.text())[:200]
                        last_error = RuntimeError(f"Fish Audio {res.status}: {err}")
                        # Don't retry free on a non-credit failure of the same request shape
                        # unless this was the paid model and we still have free to try.
                        if model != FREE_MODEL and res.status in (401, 403, 404, 422):
                            break
                        continue
                    await _remember(model)
                    pending = b""
                    async for data in res.content.iter_chunked(FRAME):
                        if not data:
                            continue
                        pending += data
                        while len(pending) >= FRAME:
                            yielded = True
                            yield pending[:FRAME]
                            pending = pending[FRAME:]
                    if len(pending) >= 2:
                        if len(pending) % 2:
                            pending = pending[:-1]
                        if pending:
                            yielded = True
                            yield pending
            if yielded:
                return
            last_error = RuntimeError("Fish Audio returned no audio")
        except Exception as e:
            last_error = e
            if yielded:
                raise
    raise last_error or RuntimeError("Fish Audio returned no audio")
