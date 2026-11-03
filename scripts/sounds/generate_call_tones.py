#!/usr/bin/env python3
"""Generate the call sounds in packages/pwa/public/sounds/ from code.

The sounds are plain synthesized tones, so they carry no third-party rights and
are covered by this repository's license. Output is deterministic: the same
script always writes byte-identical files.

usage:
  python3 scripts/sounds/generate_call_tones.py          # (re)write the files
  python3 scripts/sounds/generate_call_tones.py --check  # exit 1 if a file differs
"""

import io
import math
import struct
import sys
import wave
from pathlib import Path

SAMPLE_RATE = 44100
OUT_DIR = Path(__file__).resolve().parents[2] / "packages" / "pwa" / "public" / "sounds"

# Note frequencies (Hz)
E5, G5, C6 = 659.26, 783.99, 1046.50

# Soft bell timbre: fundamental plus two quieter harmonics
BELL_PARTIALS = ((1, 1.0), (2, 0.35), (3, 0.12))


def silence(seconds):
    return [0.0] * round(seconds * SAMPLE_RATE)


def bell(freq, seconds, decay):
    """One struck note: 5 ms attack, exponential decay, 5 ms fade-out."""
    n = round(seconds * SAMPLE_RATE)
    attack = round(0.005 * SAMPLE_RATE)
    out = []
    for i in range(n):
        t = i / SAMPLE_RATE
        env = min(1.0, i / attack) * math.exp(-decay * t) * min(1.0, (n - i) / attack)
        out.append(env * sum(a * math.sin(2 * math.pi * freq * k * t) for k, a in BELL_PARTIALS))
    return out


def dual_tone(f1, f2, seconds):
    """Steady telephone tone with 10 ms fades so it never clicks."""
    n = round(seconds * SAMPLE_RATE)
    fade = round(0.010 * SAMPLE_RATE)
    return [
        min(1.0, i / fade, (n - i) / fade)
        * 0.5 * (math.sin(2 * math.pi * f1 * i / SAMPLE_RATE) + math.sin(2 * math.pi * f2 * i / SAMPLE_RATE))
        for i in range(n)
    ]


def mix(total_seconds, events):
    """Place (start_seconds, samples) events on a silent track of fixed length."""
    track = silence(total_seconds)
    for start, samples in events:
        offset = round(start * SAMPLE_RATE)
        for i, s in enumerate(samples[: len(track) - offset]):
            track[offset + i] += s
    return track


def normalize(samples, peak):
    top = max(abs(s) for s in samples)
    return [s * peak / top for s in samples]


def ringtone():
    """Incoming call, looped: two rising three-note chimes, then a pause (2.0 s)."""
    phrase = [(0.00, E5), (0.12, G5), (0.24, C6)]
    events = [(base + t, bell(f, 0.45, 7.0)) for base in (0.0, 0.6) for t, f in phrase]
    return normalize(mix(2.0, events), 0.70)


def ringback():
    """Caller waiting, looped: 440 + 480 Hz for 1 s, then 2 s silence (3.0 s)."""
    return normalize(dual_tone(440.0, 480.0, 1.0) + silence(2.0), 0.45)


def connect():
    """Call connected: short rising two-note chime (0.6 s)."""
    return normalize(mix(0.6, [(0.00, bell(G5, 0.5, 8.0)), (0.10, bell(C6, 0.5, 8.0))]), 0.60)


def hangup():
    """Call ended: short falling three-note chime (0.8 s)."""
    events = [(0.00, bell(C6, 0.45, 9.0)), (0.12, bell(G5, 0.45, 9.0)), (0.24, bell(E5, 0.5, 9.0))]
    return normalize(mix(0.8, events), 0.55)


SOUNDS = {
    "ringtone.wav": ringtone,
    "ringback.wav": ringback,
    "connect.wav": connect,
    "hangup.wav": hangup,
}


def to_wav_bytes(samples):
    """16-bit stereo WAV at 44.1 kHz (same format as the files it replaces)."""
    frames = bytearray()
    for s in samples:
        v = max(-32767, min(32767, round(s * 32767)))
        frames += struct.pack("<hh", v, v)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(bytes(frames))
    return buf.getvalue()


def main(argv):
    check = "--check" in argv
    mismatched = []
    for name, build in SOUNDS.items():
        data = to_wav_bytes(build())
        path = OUT_DIR / name
        if check:
            if not path.exists() or path.read_bytes() != data:
                mismatched.append(name)
        else:
            path.write_bytes(data)
            print(f"wrote {path.relative_to(OUT_DIR.parents[3])} ({len(data)} bytes)")
    if check:
        if mismatched:
            print("differs from the generator: " + ", ".join(mismatched), file=sys.stderr)
            return 1
        print(f"all {len(SOUNDS)} call sounds match the generator")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
