"""Send the EXACT raw prompt (the one that worked in test_raw_vertex.py) via
the Worker's `prompt` override field. If this succeeds but buildPrompt-
generated requests fail, the difference isn't prompt content — it's
elsewhere (image bytes, timing, upstream routing). If this also fails,
something in the Worker → Vertex forwarding path is broken.
"""
import base64
import io
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

from PIL import Image

WORKER_URL = os.environ.get(
    "WORKER_URL", "https://emoji-slot-gemini.yazelinj303.workers.dev/"
)

RAW_PROMPT = re.search(
    r'PROMPT = """(.*?)"""', Path("test_raw_vertex.py").read_text(), re.DOTALL
).group(1)


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: test_worker_rawprompt.py <selfie.png> <output.png>")
    selfie = Path(sys.argv[1])
    out = Path(sys.argv[2])

    img = Image.open(selfie).convert("RGB")
    scale = min(1.0, 1280 / max(img.size))
    img = img.resize((int(img.size[0] * scale), int(img.size[1] * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    image_b64 = base64.b64encode(buf.getvalue()).decode()

    payload = {
        "imageBase64": image_b64,
        "mimeType": "image/jpeg",
        "prompt": RAW_PROMPT,  # force the exact prompt, skip buildPrompt
    }
    req = urllib.request.Request(
        WORKER_URL,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 slot-test/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=240) as resp:
        data = json.loads(resp.read())
    out.write_bytes(base64.b64decode(data["data"]))
    im = Image.open(out)
    print(f"saved {out} ({im.size})")


if __name__ == "__main__":
    main()
