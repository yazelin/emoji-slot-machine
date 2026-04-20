"""Call Vertex AI REST directly with the exact prompt the user pasted into
the Gemini app. Bypasses our Worker and all our generationConfig extras so
we can see what differs between our setup and what the app does by default.
"""
import base64
import io
import json
import os
import sys
import urllib.request
from pathlib import Path

from PIL import Image

MODEL = os.environ.get("MODEL", "gemini-3.1-flash-image-preview")
API_KEY = os.environ.get("VERTEX_API_KEY") or sys.exit("set VERTEX_API_KEY")

# The exact prompt the user pasted into the Gemini app (and that worked there).
PROMPT = """Create a single 3×3 grid image: 3 rows × 3 columns of 9 equal-size square portraits of the same subject from the reference image. Each tile shows a dramatically different, theatrical, exaggerated facial expression — the nine must be obviously distinct at a glance.

CRITICAL — match the reference's ART STYLE exactly. Whatever the reference is, keep it:
• If reference is a photograph → output photo-realistic portraits.
• If reference is anime / manga → output anime illustrations in the same line-art and shading.
• If reference is a cartoon / chibi → stay cartoon, same linework and palette.
• If reference is 3D-rendered / CGI → stay 3D-rendered.
• If reference is a painting / sketch / watercolor → match that medium.
• If reference is a statue / deity / sculpture → keep sculptural look.
Do NOT "upgrade" the reference into photography. Do NOT turn illustrations into real humans. The 9 tiles must look like they came from the SAME artist / camera / render pipeline as the reference.

The 3×3 layout uses the following cell labels (A..I). Each cell must show EXACTLY the expression listed for its letter — do not swap cells, do not merge, do not skip any cell:

```
+------+------+------+
|  A   |  B   |  C   |   ← top row
+------+------+------+
|  D   |  E   |  F   |   ← middle row
+------+------+------+
|  G   |  H   |  I   |   ← bottom row
+------+------+------+
   ↑      ↑      ↑
 left  centre right
```

  [A] top-left cell → passionate shout — mouth wide open yelling, eyes flashing with intensity, veins on temple, lost in the moment + electrocuted — hair comically standing on end from static, pupils tiny with mouth agape in a dazed 'o', soft yellow spark halos around the head
  [B] top-centre cell → nervous gulp — wide anxious eyes, mouth in a small tight circle, a single sweat bead, tense + caught in snowfall — snowflakes resting on eyelashes and hair, cheeks and nose tipped pink with cold, a soft puff of visible breath, gentle smile
  [C] top-right cell → goofy wide grin — huge teeth-showing grin stretching ear to ear, squinty happy eyes, cheeks pushed up + sun-dazzled — squinting hard against blinding light, one eye more squeezed shut than the other, tiny sparkles of sun glare on the skin
  [D] middle-left cell → silent scream — mouth stretched wide in horror, eyes bulging, but completely mute + caught in snowfall — snowflakes resting on eyelashes and hair, cheeks and nose tipped pink with cold, a soft puff of visible breath, gentle smile
  [E] middle-centre cell → coquettish side-eye — eyes glancing sideways with a knowing look, lips slightly parted, flirty and sly + sun-dazzled — squinting hard against blinding light, one eye more squeezed shut than the other, tiny sparkles of sun glare on the skin
  [F] middle-right cell → mysterious smile — cryptic closed-lip curve, one eye half-closed, as if hiding a secret + sun-dazzled — squinting hard against blinding light, one eye more squeezed shut than the other, tiny sparkles of sun glare on the skin
  [G] bottom-left cell → bawling cry — eyes tightly shut with visible tears streaming down cheeks, eyebrows slanted up in the middle, mouth open in a wailing square shape + caught in snowfall — snowflakes resting on eyelashes and hair, cheeks and nose tipped pink with cold, a soft puff of visible breath, gentle smile
  [H] bottom-centre cell → focused concentration — brows furrowed in thought, lips pressed together tightly (or biting lower lip), laser-focused eyes
  [I] bottom-right cell → ecstatic laughter — head tilted back slightly, eyes squeezed shut, mouth wide open showing upper teeth, big joyful grin + sun-dazzled — squinting hard against blinding light, one eye more squeezed shut than the other, tiny sparkles of sun glare on the skin

A cell written as "<state> + <weather>" means that tile shows both at once — e.g. "ecstatic laughter + drenched in rain" = the subject laughing while being poured on. Render both layers in the reference's own style (cartoon rain for a cartoon, photoreal rain for a photo, etc.).

Identity stays constant across every cell: same face/features, colours, hairstyle, clothing, and background treatment as the reference. Weather states (lightning, rain, snow, wind, heat, cold, electrocution, sun-dazzle, goosebumps) MAY temporarily change hair (wet, windblown, standing on end) and skin/surface (wet, flushed, frosted, cracked) — that is expected. The SUBJECT must still be clearly the same character.

OUTPUT RULES — strictly enforced:
- Final image is a 3×3 photographic grid only. Do NOT render any text, letters, numbers, labels, captions, subtitles, callouts, watermarks, emoji, arrows, or the letter labels (A..I) anywhere on the image.
- Do NOT write the expression names on the tiles. The layout above is instruction for you, not text to paint.
- No visible borders, gutters, dividers, or ASCII lines between tiles — it is one seamless 1:1 image.
- Each cell must correspond to EXACTLY the state mapped to its letter in the layout above. No swapping, no re-ordering, no skipping.
- Two cells with the same mouth shape or same eye state are NOT allowed.
- The art style MUST match the reference."""


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: test_raw_vertex.py <selfie.png> <output.png> [--config <name>]")
    selfie = Path(sys.argv[1])
    out = Path(sys.argv[2])
    config_name = "minimal"
    if "--config" in sys.argv:
        config_name = sys.argv[sys.argv.index("--config") + 1]

    # Resize selfie the same way the frontend does
    img = Image.open(selfie).convert("RGB")
    scale = min(1.0, 1280 / max(img.size))
    img = img.resize((int(img.size[0] * scale), int(img.size[1] * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    image_b64 = base64.b64encode(buf.getvalue()).decode()

    # Four config variants to test
    CONFIGS = {
        "minimal": {
            "responseModalities": ["IMAGE"],
        },
        "text_image": {
            "responseModalities": ["TEXT", "IMAGE"],
        },
        "with_imageconfig_1k": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": "1:1", "imageSize": "1K"},
        },
        "with_imageconfig_2k": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": "1:1", "imageSize": "2K"},
        },
    }
    gen_cfg = CONFIGS[config_name]
    print(f"model={MODEL}  config={config_name}  → {gen_cfg}")

    body = {
        "contents": [{
            "role": "user",
            "parts": [
                {"inlineData": {"mimeType": "image/jpeg", "data": image_b64}},
                {"text": PROMPT},
            ],
        }],
        "generationConfig": gen_cfg,
    }
    url = f"https://aiplatform.googleapis.com/v1/publishers/google/models/{MODEL}:generateContent?key={API_KEY}"
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=240) as resp:
        data = json.loads(resp.read())

    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    image_part = next((p for p in parts if "inlineData" in p), None)
    if not image_part:
        print("no image. response:", json.dumps(data)[:1500])
        return
    out.write_bytes(base64.b64decode(image_part["inlineData"]["data"]))
    im = Image.open(out)
    print(f"saved {out} ({out.stat().st_size // 1024} KB, {im.size})")


if __name__ == "__main__":
    main()
