# Offline. Checks what the voice worker prints for a final transcript (LIVE_VOICE_LOG_TRANSCRIPTS).
# agent.py imports livekit at the top, so only the two log helpers are lifted out of it with ast.
import ast
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
WANTED = {"transcripts_logged", "heard_line"}


def load():
    with open(os.path.join(HERE, "agent.py"), encoding="utf-8") as f:
        tree = ast.parse(f.read())
    funcs = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in WANTED]
    assert {f.name for f in funcs} == WANTED, "log helpers missing from agent.py"
    scope = {"os": os}
    exec(compile(ast.Module(body=funcs, type_ignores=[]), "agent.py", "exec"), scope)
    return scope["heard_line"]


def main():
    heard_line = load()
    said = "הסיסמה שלי היא 1234 ותזכיר לי לקנות חלב " * 5
    out = {}
    os.environ.pop("LIVE_VOICE_LOG_TRANSCRIPTS", None)
    out["unset"] = heard_line(said)
    for value in ["off", "0", "", "on", "true", "YES", "1"]:
        os.environ["LIVE_VOICE_LOG_TRANSCRIPTS"] = value
        out[value] = heard_line(said)
    os.environ.pop("LIVE_VOICE_LOG_TRANSCRIPTS", None)
    out["none"] = heard_line(None)
    out["said_len"] = len(said)
    out["said_120"] = said[:120]
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
