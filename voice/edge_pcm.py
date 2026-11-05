# Free Hebrew speech (he-IL) when ElevenLabs is not configured. edge-tts speaks MP3;
# ffmpeg turns it into 16 kHz mono PCM the LiveKit room can play. Audio never touches a GPU.
import asyncio
import uuid
from pathlib import Path


async def edge_pcm(text: str, voice: str = "he-IL-HilaNeural") -> bytes:
    line = " ".join(str(text or "").split()).strip()
    if not line:
        return b""
    mp3 = Path("/tmp") / f"helper-edge-{uuid.uuid4().hex}.mp3"
    speak = await asyncio.create_subprocess_exec(
        "edge-tts",
        "--voice",
        voice,
        "--text",
        line[:1500],
        "--write-media",
        str(mp3),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await speak.communicate()
    if speak.returncode != 0:
        raise RuntimeError((err or b"").decode()[:300] or "edge-tts failed")
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
        raise RuntimeError((ferr or b"").decode()[:300] or "ffmpeg failed")
    return out


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
