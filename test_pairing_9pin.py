"""Replicate the exact 9-slot config that the user pasted into the Gemini
web app (and that produced a 9/9 correct grid there). Test through the
production Worker to confirm parity.
"""
import base64
import io
import json
import os
import sys
import urllib.request
from pathlib import Path

from PIL import Image

WORKER_URL = os.environ.get(
    "WORKER_URL", "https://emoji-slot-gemini.yazelinj303.workers.dev/"
)

# Matches the prompt the user posted (letter → {exprId, weatherId}).
# Pool IDs:
#   0 ECSTATIC LAUGHTER      2 BAWLING CRY       5 PASSIONATE SHOUT
#  17 MYSTERIOUS SMILE      20 GOOFY WIDE GRIN  23 COQUETTISH SIDE-EYE
#  29 SLEEPY DROWSE         31 FOCUSED         34 NERVOUS GULP
#  35 SILENT SCREAM
#  36 ELECTROCUTED          40 CAUGHT IN SNOWFALL  43 SUN-DAZZLED
SLOTS = [
    {"exprId": 5,  "weatherId": 36},   # A  passionate shout + electrocuted
    {"exprId": 34, "weatherId": 40},   # B  nervous gulp + snow
    {"exprId": 20, "weatherId": 43},   # C  goofy grin + sun
    {"exprId": 35, "weatherId": 40},   # D  silent scream + snow
    {"exprId": 23, "weatherId": 43},   # E  coquettish + sun
    {"exprId": 17, "weatherId": 43},   # F  mysterious + sun
    {"exprId": 2,  "weatherId": 40},   # G  cry + snow
    {"exprId": 31, "weatherNone": True},  # H  focused, no weather
    {"exprId": 0,  "weatherId": 43},   # I  laughter + sun
]

def main():
    if len(sys.argv) < 3:
        sys.exit("usage: test_pairing_9pin.py <selfie.png> <output.png>")
    selfie = Path(sys.argv[1])
    out = Path(sys.argv[2])

    img = Image.open(selfie).convert("RGB")
    scale = min(1.0, 1280 / max(img.size))
    img = img.resize((int(img.size[0] * scale), int(img.size[1] * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    image_b64 = base64.b64encode(buf.getvalue()).decode()

    payload = {"imageBase64": image_b64, "mimeType": "image/jpeg", "slots": SLOTS}
    if model := os.environ.get("MODEL"):
        payload["model"] = model

    req = urllib.request.Request(
        WORKER_URL,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 slot-test/1.0",
        },
        method="POST",
    )
    print(f"POST → {WORKER_URL}")
    with urllib.request.urlopen(req, timeout=240) as resp:
        data = json.loads(resp.read())

    out.write_bytes(base64.b64decode(data["data"]))
    im = Image.open(out)
    print(f"saved {out} ({im.size})")
    print("\nExpected grid (same as the Gemini app output you showed):")
    labels = ["A shout+electrocuted", "B nervous+snow", "C grin+sun",
              "D scream+snow", "E side-eye+sun", "F mysterious+sun",
              "G cry+snow", "H focused (no weather)", "I laughter+sun"]
    for lbl in labels:
        print(f"  {lbl}")


if __name__ == "__main__":
    main()
