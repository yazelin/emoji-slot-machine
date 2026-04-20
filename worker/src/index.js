// Cloudflare Worker: proxy for Vertex AI image generation.
// Frontend calls us with { imageBase64, mimeType, prompt? }.
// We add the API key (stored as a Worker Secret) and forward to Vertex AI,
// then return the generated image as base64.

const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
const MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10 MB decoded image size

const DEFAULT_PROMPT = `Create ONE single square image that is a 3x3 grid (3 rows × 3 columns, 9 equal square tiles) of portraits of the SAME person from the reference photo. Each tile must show a DRAMATICALLY different, theatrical, exaggerated facial expression. The nine expressions must look OBVIOUSLY different at a glance — no two tiles should be confusable.

Tile-by-tile specification (mouth shape + eyes + brows must all differ):

1. ECSTATIC LAUGHTER — head tilted back slightly, eyes squeezed shut, mouth wide open showing upper teeth, big grin.
2. BAWLING CRY — eyes tightly shut with visible tears streaming down cheeks, eyebrows slanted up in the middle, mouth open in a wailing square shape.
3. FURIOUS ANGER — brows pulled sharply down and together, nostrils flared, teeth gritted and bared, eyes glaring hard.
4. TERRIFIED SHOCK — eyes bulging wide open (whites visible), eyebrows raised high, mouth stretched into a large round "O", face tense.
5. REVOLTED DISGUST — nose heavily scrunched up, upper lip curled, tongue sticking out as if saying "yuck", one eye half closed.
6. BAFFLED CONFUSION — one eyebrow sharply raised (other lowered), eyes looking up and to the side, lips pursed tight to one side.
7. DEVIOUS SMIRK — only one corner of mouth pulled up in a sly half-smile, eyes narrowed and looking sideways, one brow cocked. Looks mischievous.
8. BLOWING A KISS — lips puckered forward in a clear kiss shape, eyes soft and half-closed, dreamy romantic vibe.
9. BLANK ZONE-OUT — completely vacant stare, eyes unfocused looking into the distance, mouth slightly agape, zero emotion, totally spaced-out.

Critical requirements:
- Each expression must be EXAGGERATED and theatrical (like acting class, not subtle). A passing viewer should instantly tell every tile apart.
- Keep the SAME person, same hairstyle, same clothing, same lighting, same clean background across ALL 9 tiles.
- Do NOT repeat a similar expression. No two tiles with the same mouth shape or eye state.
- Output: ONE seamless 1:1 square image of the 3x3 grid. No borders, no captions, no text, no numbers.`;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method === "GET") {
      return json({ ok: true, service: "emoji-slot-gemini" }, 200, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405, cors);
    }

    if (!env.VERTEX_API_KEY) {
      return json({ error: "server misconfigured: VERTEX_API_KEY missing" }, 500, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400, cors);
    }

    const { imageBase64, mimeType = "image/jpeg", prompt, model } = body || {};
    if (typeof imageBase64 !== "string" || imageBase64.length < 100) {
      return json({ error: "imageBase64 is required" }, 400, cors);
    }
    if (imageBase64.length * 0.75 > MAX_INPUT_BYTES) {
      return json({ error: "image too large (max ~7.5 MB)" }, 413, cors);
    }

    const chosenModel = (model || env.DEFAULT_MODEL || DEFAULT_MODEL).trim();
    const chosenPrompt = typeof prompt === "string" && prompt.trim()
      ? prompt
      : DEFAULT_PROMPT;

    const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(chosenModel)}:generateContent?key=${env.VERTEX_API_KEY}`;

    const payload = {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            { text: chosenPrompt },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: "1:1", imageSize: "2K" },
      },
    };

    let upstream;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return json({ error: "upstream fetch failed", detail: String(err) }, 502, cors);
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      return json(
        { error: "upstream error", status: upstream.status, detail: text.slice(0, 1500) },
        502,
        cors,
      );
    }

    const data = await upstream.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p) => p.inlineData);
    if (!imagePart) {
      return json(
        { error: "no image in response", raw: JSON.stringify(data).slice(0, 1500) },
        502,
        cors,
      );
    }

    return json(
      {
        mimeType: imagePart.inlineData.mimeType || "image/png",
        data: imagePart.inlineData.data,
        model: chosenModel,
      },
      200,
      cors,
    );
  },
};
