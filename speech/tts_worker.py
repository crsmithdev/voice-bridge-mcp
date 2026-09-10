#!/usr/bin/env python3
"""Text to speech, local only (spec 4.5, 4.9).

One long-lived process: loading the voice costs about 1.3 seconds and
synthesis costs about a tenth of a second a sentence, so the bridge loads
once and then speaks at twenty times real time.

Protocol: one JSON request per line on stdin, one JSON reply per line on
stdout. {"text": str, "wav": path} -> {"wav": path, "seconds": float}.
"""
import json
import sys
import time
import wave

from piper import PiperVoice


def reply(**fields) -> None:
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


def main() -> None:
    voice = PiperVoice.load(sys.argv[1])
    reply(ready=True, sample_rate=voice.config.sample_rate)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            started = time.time()
            with wave.open(request["wav"], "wb") as out:
                voice.synthesize_wav(request["text"], out)
            reply(wav=request["wav"], seconds=round(time.time() - started, 3))
        except Exception as error:
            reply(error=str(error))


main()
