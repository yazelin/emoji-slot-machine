"""Ping the deployed Worker with a concrete slot config and save the result.
Every cell gets a unique, visually distinct weather so we can verify at a
glance whether positions are being respected.
"""
import base64
import io
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

from PIL import Image

import os
WORKER_URL = os.environ.get(
    "WORKER_URL", "https://emoji-slot-gemini.yazelinj303.workers.dev/"
)

# A unique weather per cell so mismatches are obvious.
SLOTS = [
    {"weatherId": 37},   # A  top-left      STRUCK BY LIGHTNING
    {"weatherId": 39},   # B  top-centre    DRENCHED IN RAIN
    {"weatherId": 41},   # C  top-right     SHIVERING COLD
    {"weatherId": 38},   # D  middle-left   STRONG WIND
    {"weatherId": 42},   # E  middle-centre SWELTERING HEAT
    {"weatherId": 40},   # F  middle-right  CAUGHT IN SNOWFALL
    {"weatherId": 36},   # G  bottom-left   ELECTROCUTED
    {"weatherId": 43},   # H  bottom-centre SUN-DAZZLED
    {"weatherId": 44},   # I  bottom-right  GOOSEBUMPS GASP
]

def main() -> None:
    if len(sys.argv) < 3:
        sys.exit("usage: test_positional.py <selfie.png> <output.png>")
    selfie = Path(sys.argv[1])
    out = Path(sys.argv[2])

    # Resize to <= 1280px and re-encode as JPEG to match frontend behaviour.
    img = Image.open(selfie).convert("RGB")
    scale = min(1.0, 1280 / max(img.size))
    img = img.resize((int(img.size[0] * scale), int(img.size[1] * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    image_b64 = base64.b64encode(buf.getvalue()).decode()
    print(f"uploading {len(buf.getvalue()) // 1024} KB JPEG")

    payload = {
        "imageBase64": image_b64,
        "mimeType": "image/jpeg",
        "slots": SLOTS,
    }
    if model := os.environ.get("MODEL"):
        payload["model"] = model
        print(f"using model: {model}")
    body = json.dumps(payload).encode()

    req = urllib.request.Request(
        WORKER_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 slot-test/1.0",
        },
        method="POST",
    )
    print(f"POST → {WORKER_URL} (9 pinned weathers)")
    try:
        with urllib.request.urlopen(req, timeout=240) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        print(f"HTTP {exc.code}:", exc.read().decode(errors="replace")[:800])
        raise

    if "data" not in data:
        sys.exit(f"failed: {data}")

    out.write_bytes(base64.b64decode(data["data"]))
    print(f"saved {out} ({out.stat().st_size // 1024} KB)")
    print("\nExpected layout:")
    names = [
        "A top-left      lightning ⚡",
        "B top-centre    rain ☔",
        "C top-right     cold 🥶",
        "D middle-left   wind 💨",
        "E middle-centre heat 🥵",
        "F middle-right  snow ❄",
        "G bottom-left   electrocuted ⚡",
        "H bottom-centre sun-dazzle ☀",
        "I bottom-right  goosebumps",
    ]
    for n in names:
        print("  ", n)

if __name__ == "__main__":
    main()
