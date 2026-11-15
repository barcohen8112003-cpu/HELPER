import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from fish_pcm import fish_configured, live_tts_provider, fish_voice, DEFAULT_VOICE


def check(name, cond):
    if not cond:
        raise SystemExit(f"fail: {name}")
    print("ok", name)


check("unset live provider is empty", live_tts_provider({}) == "")
check("does not inherit TTS_PROVIDER", live_tts_provider({"TTS_PROVIDER": "elevenlabs"}) == "")
check("fish aliases", live_tts_provider({"LIVE_TTS_PROVIDER": "FishAudio"}) == "fish")
check("fish-audio alias", live_tts_provider({"LIVE_TTS_PROVIDER": "fish-audio"}) == "fish")
check("not configured without key", fish_configured({}) is False)
check("configured with key", fish_configured({"FISH_AUDIO_API_KEY": "sk-x"}) is True)
check("default voice", fish_voice({}) == DEFAULT_VOICE)
check("custom voice", fish_voice({"FISH_AUDIO_VOICE_ID": "abc"}) == "abc")
print("all ok")
