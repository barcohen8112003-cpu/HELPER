# Default speech for the live-voice worker. edge-tts speaks MP3; ffmpeg turns it into
# 16 kHz mono PCM the LiveKit room plays. Keep choose_voice in step with src/tts.js.
import asyncio
import re
import uuid
from pathlib import Path

DEFAULT_HEBREW_VOICE = "he-IL-HilaNeural"
DEFAULT_RATE = "+0%"

VOICES = {
    "en": "en-US-AriaNeural",
    "fr": "fr-FR-DeniseNeural",
    "de": "de-DE-KatjaNeural",
    "es": "es-ES-ElviraNeural",
    "it": "it-IT-ElsaNeural",
    "pt": "pt-BR-FranciscaNeural",
    "nl": "nl-NL-ColetteNeural",
    "pl": "pl-PL-ZofiaNeural",
    "tr": "tr-TR-EmelNeural",
    "ar": "ar-EG-SalmaNeural",
    "ru": "ru-RU-SvetlanaNeural",
    "uk": "uk-UA-PolinaNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
    "ja": "ja-JP-NanamiNeural",
    "ko": "ko-KR-SunHiNeural",
    "hi": "hi-IN-SwaraNeural",
}

LATIN_WORDS = {
    "fr": ["bonjour", "merci", "vous", "est", "les", "une", "des", "pas", "avec", "pour", "comment", "ça"],
    "de": ["danke", "nicht", "ich", "und", "der", "die", "das", "ein", "ist", "auch"],
    "es": ["hola", "gracias", "que", "por", "una", "los", "las", "como", "muy", "está"],
    "it": ["ciao", "grazie", "che", "non", "una", "per", "sono", "con", "buongiorno"],
    "pt": ["olá", "obrigado", "você", "não", "uma", "para", "com", "bom"],
    "nl": ["hallo", "dank", "niet", "het", "een", "van", "voor"],
    "pl": ["cześć", "dzień", "nie", "się", "jest", "proszę"],
    "tr": ["merhaba", "teşekkür", "bir", "ve", "için", "değil"],
}

_VOICE_RE = re.compile(r"^[\w.-]{1,80}$")
_UK_RE = re.compile(r"[іїєґІЇЄҐ]")


def normalize_rate(raw) -> str:
    s = str(raw or "").strip()
    if not s:
        return DEFAULT_RATE
    ready = re.fullmatch(r"([+-])(\d{1,3})%", s)
    loose = re.fullmatch(r"([+-]?\d{1,3})%?", s)
    if ready:
        n = int(f"{ready.group(1)}{ready.group(2)}")
    elif loose:
        n = int(loose.group(1))
    else:
        return DEFAULT_RATE
    n = max(-50, min(100, n))
    return f"{'+' if n >= 0 else ''}{n}%"


def hebrew_voice(env_voice: str | None = None) -> str:
    import os

    v = (env_voice if env_voice is not None else os.environ.get("EDGE_TTS_VOICE", "")).strip()
    return v if _VOICE_RE.fullmatch(v or "") else DEFAULT_HEBREW_VOICE


def _latin_lang(text: str) -> str:
    words = set(re.findall(r"[a-zà-ÿ]{2,}", text.lower()))
    best, best_score = "en", 0
    for lang, lst in LATIN_WORDS.items():
        score = sum(1 for w in lst if w in words)
        if score > best_score:
            best, best_score = lang, score
    return best if best_score >= 2 else "en"


def detect_lang(text: str) -> str:
    s = str(text or "")

    def n(pat: str) -> int:
        return len(re.findall(pat, s))

    he, ar, cyr = n(r"[\u0590-\u05FF]"), n(r"[\u0600-\u06FF]"), n(r"[\u0400-\u04FF]")
    cjk, kana = n(r"[\u4E00-\u9FFF]"), n(r"[\u3040-\u30FF]")
    hang, deva = n(r"[\uAC00-\uD7AF]"), n(r"[\u0900-\u097F]")
    lat = n(r"[A-Za-z\u00C0-\u024F]")
    scripts = [
        ("he", he),
        ("ar", ar),
        ("cyr", cyr),
        ("ja", kana + cjk if kana else 0),
        ("zh", 0 if kana else cjk),
        ("ko", hang),
        ("hi", deva),
    ]
    scripts.sort(key=lambda item: item[1], reverse=True)
    top, top_n = scripts[0]
    if top_n > 0 and top_n >= lat:
        if top == "cyr":
            return "uk" if _UK_RE.search(s) else "ru"
        return top
    if lat > 0:
        return _latin_lang(s)
    return "he"


def choose_voice(text: str, voice: str | None = None, rate: str | None = None):
    """Return (voice, rate, lang). Hebrew uses EDGE_TTS_VOICE; other languages pick a neural voice."""
    import os

    lang = detect_lang(text)
    chosen_rate = normalize_rate(rate if rate is not None else os.environ.get("EDGE_TTS_RATE", ""))
    if lang == "he":
        chosen = hebrew_voice(voice) if voice is not None else hebrew_voice(None)
    else:
        chosen = VOICES.get(lang) or VOICES["en"]
    return chosen, chosen_rate, lang


def tts_provider() -> str:
    import os

    raw = (os.environ.get("TTS_PROVIDER") or "").strip().lower()
    if raw in {"eleven", "elevenlabs", "11labs"}:
        return "elevenlabs"
    if raw in {"openai", "compatible", "voice"}:
        return "openai"
    return "edge"


async def _iter_pcm(text: str, voice: str, rate: str, sample_rate: int = 16000):
    """Yield s16le chunks as ffmpeg decodes them, so playback can start before the sentence ends."""
    import edge_tts

    line = " ".join(str(text or "").split()).strip()[:1500]
    if not line:
        return
    comm = edge_tts.Communicate(line, voice, rate=rate or DEFAULT_RATE)
    ff = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-probesize",
        "1024",
        "-analyzeduration",
        "0",
        "-f",
        "mp3",
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ar",
        str(sample_rate),
        "-ac",
        "1",
        "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    err = bytearray()

    async def drain_err():
        while True:
            b = await ff.stderr.read(4096)
            if not b:
                break
            if len(err) < 2000:
                err.extend(b)

    async def feed():
        try:
            async for chunk in comm.stream():
                if chunk.get("type") == "audio" and chunk.get("data"):
                    ff.stdin.write(chunk["data"])
                    await ff.stdin.drain()
        finally:
            try:
                ff.stdin.close()
            except Exception:
                pass

    err_task = asyncio.create_task(drain_err())
    feed_task = asyncio.create_task(feed())
    frame = sample_rate * 20 // 1000 * 2
    pending = b""
    code = None
    try:
        # The timeout is per read, so a slow player does not cancel a sentence that is already speaking.
        while True:
            data = await asyncio.wait_for(ff.stdout.read(frame), 45)
            if not data:
                break
            pending += data
            while len(pending) >= frame:
                yield pending[:frame]
                pending = pending[frame:]
        if len(pending) >= 2:
            if len(pending) % 2:
                pending = pending[:-1]
            if pending:
                yield pending
        await asyncio.wait_for(feed_task, 45)
        code = await asyncio.wait_for(ff.wait(), 15)
        await err_task
        if code not in (0, None):
            raise RuntimeError(bytes(err).decode(errors="replace")[:300] or f"ffmpeg exited {code}")
    finally:
        if not feed_task.done():
            feed_task.cancel()
        if ff.returncode is None:
            try:
                ff.kill()
            except ProcessLookupError:
                pass
        if not err_task.done():
            err_task.cancel()


async def iter_pcm(text: str, voice: str = DEFAULT_HEBREW_VOICE, rate: str = DEFAULT_RATE, attempts: int = 2):
    """Stream PCM, retrying the whole request when nothing has been spoken yet."""
    last = None
    for attempt in range(attempts):
        yielded = False
        try:
            async for chunk in _iter_pcm(text, voice, rate):
                yielded = True
                yield chunk
            if yielded:
                return
            last = RuntimeError("edge-tts returned no audio")
        except Exception as e:
            last = e
            if yielded:
                raise
        if attempt + 1 < attempts:
            await asyncio.sleep(0.35 * (attempt + 1))
    # The file path is the retry when streaming never produced a sample.
    pcm = await _file_pcm(text, voice, rate)
    if len(pcm) < 2:
        raise last or RuntimeError("edge-tts returned no audio")
    step = 16000 * 20 // 1000 * 2
    for i in range(0, len(pcm) - (len(pcm) % 2), step):
        yield pcm[i : i + step]


async def _file_pcm(text: str, voice: str, rate: str) -> bytes:
    line = " ".join(str(text or "").split()).strip()[:1500]
    if not line:
        return b""
    mp3 = Path("/tmp") / f"helper-edge-{uuid.uuid4().hex}.mp3"
    speak = await asyncio.create_subprocess_exec(
        "edge-tts",
        "--voice",
        voice,
        "--rate",
        rate or DEFAULT_RATE,
        "--text",
        line,
        "--write-media",
        str(mp3),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await speak.communicate()
    if speak.returncode != 0:
        mp3.unlink(missing_ok=True)
        raise RuntimeError((err or b"").decode(errors="replace")[:300] or "edge-tts failed")
    decode = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(mp3),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, ferr = await decode.communicate()
    mp3.unlink(missing_ok=True)
    if decode.returncode != 0:
        raise RuntimeError((ferr or b"").decode(errors="replace")[:300] or "ffmpeg failed")
    return out


async def edge_pcm(text: str, voice: str = DEFAULT_HEBREW_VOICE, rate: str = DEFAULT_RATE) -> bytes:
    parts = []
    async for chunk in iter_pcm(text, voice, rate):
        parts.append(chunk)
    return b"".join(parts)


def pcm_frames(pcm: bytes, sample_rate: int = 16000, ms: int = 20):
    """Yield (bytes, samples) chunks. LiveKit wants the byte length to match the sample count."""
    from livekit import rtc

    width = 2
    samples = sample_rate * ms // 1000
    step = samples * width
    for i in range(0, len(pcm) - width + 1, step):
        chunk = pcm[i : i + step]
        count = len(chunk) // width
        if count <= 0:
            break
        chunk = chunk[: count * width]
        yield rtc.AudioFrame(chunk, sample_rate, 1, count)
