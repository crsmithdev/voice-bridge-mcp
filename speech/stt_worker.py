#!/usr/bin/env python3
"""Speech to text, local only (spec 4.5, 4.6).

One long-lived process, because the first transcription on CUDA costs about
seven seconds of kernel warmup and every one after it costs a fifth of a
second. The bridge pays that once at startup, never in the middle of a
conversation.

Protocol: one JSON request per line on stdin, one JSON reply per line on
stdout. {"wav": path} -> {"text": str, "seconds": float}.
"""
import json
import sys
import time

import numpy as np
from faster_whisper import WhisperModel


def reply(**fields) -> None:
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


def main() -> None:
    model_name = sys.argv[1]
    root = sys.argv[2]
    model = WhisperModel(model_name, device="cuda", compute_type="float16", download_root=root)

    # the warmup transcription, on a second of silence, so the first real one is fast
    started = time.time()
    list(model.transcribe(np.zeros(16_000, dtype=np.float32), beam_size=1, vad_filter=True)[0])
    reply(ready=True, model=model_name, warmup_seconds=round(time.time() - started, 2))

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            started = time.time()
            # vad_filter drops the parts with no voice in them. Without it whisper
            # writes something for silence anyway -- "you", "Thank you." -- and the
            # bridge sends that phantom to the agent and pays for a turn.
            segments, _ = model.transcribe(request["wav"], beam_size=1, vad_filter=True)
            text = "".join(segment.text for segment in segments).strip()
            reply(text=text, seconds=round(time.time() - started, 3))
        except Exception as error:  # a bad request must not take the worker down
            reply(error=str(error))


main()
