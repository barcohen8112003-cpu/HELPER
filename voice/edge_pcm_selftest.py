# Offline. Compares choose_voice with the fixtures src/tts-selftest.js sends on stdin.
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from edge_pcm import choose_voice


def main():
    texts = json.load(sys.stdin)
    out = []
    for text in texts:
        voice, rate, lang = choose_voice(text)
        out.append({"text": text, "voice": voice, "rate": rate, "lang": lang})
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
