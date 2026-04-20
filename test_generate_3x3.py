#!/usr/bin/env python3
"""Test script: call Vertex AI Express to generate a 3x3 expression grid.

Usage:
    export VERTEX_API_KEY=<your_new_key>
    python3 test_generate_3x3.py /path/to/selfie.jpg

Output: test_3x3_output.png in cwd.
"""
import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_PROMPT = """Create ONE single square image that is a 3x3 grid (3 rows × 3 columns, 9 equal square tiles) of portraits of the SAME person from the reference photo. Each tile must show a DRAMATICALLY different, theatrical, exaggerated facial expression. The nine expressions must look OBVIOUSLY different at a glance — no two tiles should be confusable.

Tile-by-tile specification (mouth shape + eyes + brows must all differ):

1. ECSTATIC LAUGHTER — head tilted back slightly, eyes squeezed shut, mouth wide open showing upper teeth, big grin.
2. BAWLING CRY — eyes tightly shut with visible tears streaming down cheeks, eyebrows slanted up in the middle, mouth open in a wailing square shape.
3. FURIOUS ANGER — brows pulled sharply down and together, nostrils flared, teeth gritted and bared, eyes glaring hard.
4. TERRIFIED SHOCK — eyes bulging wide open (whites visible), eyebrows raised high, mouth stretched into a large round "O", face tense.
5. REVOLTED DISGUST — nose heavily scrunched up, upper lip curled, tongue sticking out as if saying "yuck", one eye half closed.
6. BAFFLED CONFUSION — one eyebrow sharply raised (other lowered), eyes looking up and to the side, lips pursed tight to one side.
7. DEVIOUS SMIRK — only one corner of mouth pulled up in a sly half-smile, eyes narrowed and looking sideways, one brow cocked. Looks mischievous.
8. BLOWING A KISS — lips puckered forward in a clear kiss shape, eyes soft and half-closed, one hand NOT visible (portrait only), dreamy romantic vibe.
9. BLANK ZONE-OUT — completely vacant stare, eyes unfocused looking into the distance, mouth slightly agape, zero emotion, totally spaced-out.

Critical requirements:
- Each expression must be EXAGGERATED and theatrical (like acting class, not subtle). A passing viewer should instantly tell every tile apart.
- Keep the SAME person, same hairstyle (black hair with bangs, loose strands), same white t-shirt, same lighting, same light-gray background across ALL 9 tiles.
- Do NOT repeat a similar expression. No two tiles with the same mouth shape or eye state.
- Output: ONE seamless 1:1 square image of the 3x3 grid. No borders, no captions, no text, no numbers.
"""

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", help="path to reference selfie")
    parser.add_argument("-o", "--output", default="test_3x3_output.png")
    parser.add_argument(
        "--model",
        default="gemini-2.5-flash-image",
        help="Vertex AI model name (try gemini-3-pro-image-preview for better quality)",
    )
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    args = parser.parse_args()

    api_key = os.environ.get("VERTEX_API_KEY")
    if not api_key:
        sys.exit("error: set VERTEX_API_KEY env var before running this script")

    img_path = Path(args.image)
    if not img_path.is_file():
        sys.exit(f"error: image not found: {img_path}")
    img_bytes = img_path.read_bytes()
    mime = mimetypes.guess_type(str(img_path))[0] or "image/jpeg"
    b64 = base64.b64encode(img_bytes).decode()

    url = (
        f"https://aiplatform.googleapis.com/v1/publishers/google/models/"
        f"{args.model}:generateContent?key={api_key}"
    )
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inlineData": {"mimeType": mime, "data": b64}},
                    {"text": args.prompt},
                ],
            }
        ],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {
                "aspectRatio": "1:1",
                "imageSize": "2K",
            },
        },
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    print(f"calling {args.model} with {img_path.name} ({len(img_bytes)//1024} KB)...")
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:1500]
        sys.exit(f"HTTP {exc.code}: {detail}")

    parts = (
        data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    )
    image_parts = [p for p in parts if "inlineData" in p]
    if not image_parts:
        print("no image in response. raw response (truncated):", file=sys.stderr)
        print(json.dumps(data, indent=2)[:2000], file=sys.stderr)
        sys.exit(1)

    out = Path(args.output)
    out.write_bytes(base64.b64decode(image_parts[0]["inlineData"]["data"]))
    print(f"saved {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
