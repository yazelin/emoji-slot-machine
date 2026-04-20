"""Test whether explicit emotion+weather pairs survive one call.

Config: three VERY DISTINCT pairs, rest random no-weather. If Gemini
respects pairing, we should see:
  - A tile that is BOTH laughing AND drenched in rain
  - A tile that is BOTH crying AND on fire (sweltering heat)
  - A tile that is BOTH yawning/sleepy AND in snow
…even if those tiles land in arbitrary positions.
"""

import base64
import io
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

from PIL import Image

WORKER_URL = os.environ.get("WORKER_URL", "http://localhost:8787/")
MODEL = os.environ.get("MODEL")

# Pool IDs:
#   0 ECSTATIC LAUGHTER
#   2 BAWLING CRY
#  29 SLEEPY DROWSE
#  39 DRENCHED IN RAIN
#  42 SWELTERING HEAT
#  40 CAUGHT IN SNOWFALL
SLOTS = [
    {"exprId": 0, "weatherId": 39},   # laughter + rain
    {"exprId": 2, "weatherId": 42},   # cry + heat
    {"exprId": 29, "weatherId": 40},  # sleepy + snow
    None, None, None, None, None, None,
]

def main() -> None:
    if len(sys.argv) < 3:
        sys.exit("usage: test_pairing.py <selfie.png> <output.png>")
    selfie = Path(sys.argv[1])
    out = Path(sys.argv[2])

    img = Image.open(selfie).convert("RGB")
    scale = min(1.0, 1280 / max(img.size))
    img = img.resize((int(img.size[0] * scale), int(img.size[1] * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    image_b64 = base64.b64encode(buf.getvalue()).decode()

    payload = {"imageBase64": image_b64, "mimeType": "image/jpeg", "slots": SLOTS}
    if MODEL:
        payload["model"] = MODEL
    body = json.dumps(payload).encode()

    req = urllib.request.Request(
        WORKER_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 slot-test/1.0",
        },
        method="POST",
    )
    print(f"POST → {WORKER_URL}")
    try:
        with urllib.request.urlopen(req, timeout=240) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        print(f"HTTP {exc.code}:", exc.read().decode(errors="replace")[:800])
        raise

    out.write_bytes(base64.b64decode(data["data"]))
    print(f"saved {out} ({out.stat().st_size // 1024} KB)")
    print("\nExpected pairs (position doesn't matter — just look for co-occurrence):")
    print("  1. Laughing face + rain droplets")
    print("  2. Crying face + sweat/flushed (heat)")
    print("  3. Sleepy/yawning face + snow flakes")

if __name__ == "__main__":
    main()
