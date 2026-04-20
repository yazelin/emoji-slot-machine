// Cloudflare Worker: proxy for Vertex AI image generation.
// Frontend calls us with { imageBase64, mimeType, prompt? }.
// We add the API key (stored as a Worker Secret) and forward to Vertex AI,
// then return the generated image as base64.

const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
const MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10 MB decoded image size

// Pool of expression descriptors. We randomly pick 9 per request so every
// call returns a different mix — visibly distinct tiles each time you spin.
// 36 expressions + 9 environmental/weather reactions = 45 entries.
// C(45,9) × 9! ≈ 3.3×10^12 possible ordered tiles.
const EXPRESSION_POOL = [
  "ECSTATIC LAUGHTER — head tilted back slightly, eyes squeezed shut, mouth wide open showing upper teeth, big joyful grin",
  "HYSTERICAL LAUGHTER WITH TEARS — eyes shut with laugh-tears streaming, mouth wide open laughing, cheeks flushed red",
  "BAWLING CRY — eyes tightly shut with visible tears streaming down cheeks, eyebrows slanted up in the middle, mouth open in a wailing square shape",
  "TEARY-EYED SADNESS — eyes glistening with unshed tears, corners of the mouth pulled down, cheeks slightly flushed, quiet grief",
  "FURIOUS ANGER — brows pulled sharply down and together, nostrils flared, teeth gritted and bared, eyes glaring hard",
  "PASSIONATE SHOUT — mouth wide open yelling, eyes flashing with intensity, veins on temple, lost in the moment",
  "POUTING SULK — lower lip pushed out in an exaggerated pout, eyebrows drawn together in mild protest, eyes narrowed",
  "TERRIFIED SHOCK — eyes bulging wide open (whites visible), eyebrows raised high, mouth stretched into a large round \"O\", face tense",
  "COMICAL JAW DROP — jaw literally dropped down low, eyes popping out, cartoonishly shocked",
  "MILD SURPRISE — eyebrows lifted, eyes slightly widened, mouth parted a little in pleasant surprise",
  "STARSTRUCK AWE — eyes wide and sparkling with wonder, mouth open in a soft \"oh!\", cheeks softly flushed",
  "REVOLTED DISGUST — nose heavily scrunched up, upper lip curled, tongue sticking out as if saying \"yuck\", one eye half closed",
  "CRINGING EMBARRASSMENT — teeth showing in an awkward grimace, nose wrinkled, eyes squinting, shoulders slightly raised",
  "GUILTY AWKWARD — tight-lipped grimace, eyes darting sideways, corner of mouth stretched thin in a 'whoops' look",
  "BAFFLED CONFUSION — one eyebrow sharply raised (other lowered), eyes looking up and to the side, lips pursed tight to one side",
  "PURSED-LIP SKEPTICISM — mouth pushed to one side in a doubting pucker, one brow cocked high, clearly unconvinced",
  "DEVIOUS SMIRK — only one corner of mouth pulled up in a sly half-smile, eyes narrowed and looking sideways, one brow cocked, mischievous",
  "MYSTERIOUS SMILE — cryptic closed-lip curve, one eye half-closed, as if hiding a secret",
  "PLAYFUL WINK — one eye winked fully shut, the other open and bright, corner of mouth tugged up into a cheeky grin",
  "RASPBERRY TONGUE — tongue sticking straight out flat, eyes crossed playfully, silly face",
  "GOOFY WIDE GRIN — huge teeth-showing grin stretching ear to ear, squinty happy eyes, cheeks pushed up",
  "BLOWING A KISS — lips puckered forward in a clear kiss shape, eyes soft and half-closed, dreamy romantic vibe",
  "HEART-EYES ADORATION — eyes wide and dreamy staring off, mouth curled in a soft melting smile, cheeks flushed, utterly smitten",
  "COQUETTISH SIDE-EYE — eyes glancing sideways with a knowing look, lips slightly parted, flirty and sly",
  "SHY BLUSH — cheeks deeply flushed pink, eyes glancing down and away, lips pressed together in a small bashful smile",
  "BEAMING PRIDE — broad closed-mouth smile, eyes crinkled happily, content and proud",
  "BLANK ZONE-OUT — completely vacant stare, eyes unfocused looking into the distance, mouth slightly agape, zero emotion",
  "DEADPAN — totally flat face, dead expressionless eyes, mouth in a perfectly straight line, 100% done",
  "ROLLING EYES — eyes rolled dramatically upward, one side of the mouth pulled into an unimpressed line, exasperated",
  "SLEEPY DROWSE — eyelids drooping heavily, mouth open mid-yawn, head tilted slightly, exhausted",
  "TRIUMPHANT SMUG — eyes closed in self-satisfaction, chin lifted, small proud closed-lip smile, exuding \"I knew it\"",
  "FOCUSED CONCENTRATION — brows furrowed in thought, lips pressed together tightly (or biting lower lip), laser-focused eyes",
  "DETERMINED RESOLVE — chin lifted, mouth firm in a resolute line, eyes steady forward, unshakeable",
  "PUFFY CHEEKS — cheeks comically puffed out holding breath, lips pursed tightly, a playful 'hmph' vibe",
  "NERVOUS GULP — wide anxious eyes, mouth in a small tight circle, a single sweat bead, tense",
  "SILENT SCREAM — mouth stretched wide in horror, eyes bulging, but completely mute",
  // --- environmental / weather reactions (hair/skin may temporarily change; identity still preserved) ---
  "ELECTROCUTED — hair comically standing on end from static, pupils tiny with mouth agape in a dazed 'o', soft yellow spark halos around the head",
  "STRUCK BY LIGHTNING — brilliant flash washing half the face, hair crackling upward with small blue electric arcs, eyes wide and dazed, jaw slack",
  "BLASTED BY STRONG WIND — hair streaming hard to one side, eyes squinted against the gust, cheeks rippling with wind pressure, lips pursed tight",
  "DRENCHED IN RAIN — water droplets all over the face, hair soaking wet and plastered to forehead, eyelashes heavy with water, eyes slightly glum",
  "CAUGHT IN SNOWFALL — snowflakes resting on eyelashes and hair, cheeks and nose tipped pink with cold, a soft puff of visible breath, gentle smile",
  "SHIVERING COLD — teeth lightly chattering, lips a touch bluish, a plume of visible breath escaping, eyes watery and scrunched, subtle shiver",
  "SWELTERING HEAT — face glistening with sweat, hair damp at the temples, cheeks flushed red, tongue lolling out panting, heavy lidded exhaustion",
  "SUN-DAZZLED — squinting hard against blinding light, one eye more squeezed shut than the other, tiny sparkles of sun glare on the skin",
  "GOOSEBUMPS GASP — sudden sharp intake of breath, eyes wide and startled, fine goosebumps visible on the neck, hair slightly raised at the roots",
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// IDs 0..35 = emotions, 36..44 = weather/environment.
const EMOTION_COUNT = 36;

function poolManifest() {
  return EXPRESSION_POOL.map((line, id) => ({
    id,
    category: id < EMOTION_COUNT ? "emotion" : "weather",
    label: line.split(" — ")[0],
  }));
}

const RANDOM_WEATHER_CHANCE = 0.5;

function buildPrompt(slots) {
  // slots: length-9 array; each item is null (fully random) or an object:
  //   { exprId?, exprCustom?, weatherId?, weatherNone? }
  // Expression (default random from emotion subpool):
  //   exprCustom > exprId > random emotion
  // Weather (default: RANDOM_WEATHER_CHANCE to roll one in):
  //   weatherId > weatherNone (force none) > random-or-none
  const normalized = Array.isArray(slots) && slots.length === 9
    ? slots
    : new Array(9).fill(null);

  const usedEmotionIds = new Set();
  normalized.forEach((s) => {
    if (s && Number.isInteger(s.exprId) && s.exprId < EMOTION_COUNT) {
      usedEmotionIds.add(s.exprId);
    }
  });

  const randomEmotionQueue = shuffle(
    EXPRESSION_POOL.slice(0, EMOTION_COUNT)
      .map((desc, id) => ({ desc, id }))
      .filter((e) => !usedEmotionIds.has(e.id))
  );

  // Track weather IDs already used (explicitly pinned by the user) so that
  // random weather rolls never pick the same one twice across the grid.
  const usedWeatherIds = new Set();
  normalized.forEach((s) => {
    if (
      s &&
      Number.isInteger(s.weatherId) &&
      s.weatherId >= EMOTION_COUNT &&
      s.weatherId < EXPRESSION_POOL.length
    ) {
      usedWeatherIds.add(s.weatherId);
    }
  });
  const randomWeatherQueue = shuffle(
    EXPRESSION_POOL.slice(EMOTION_COUNT)
      .map((desc, i) => ({ desc, id: EMOTION_COUNT + i }))
      .filter((w) => !usedWeatherIds.has(w.id))
  );

  const lines = normalized.map((slot) => {
    slot = slot || {};
    // Expression
    let expr;
    if (typeof slot.exprCustom === "string" && slot.exprCustom.trim()) {
      expr = `CUSTOM — ${slot.exprCustom.trim()}`;
    } else if (
      Number.isInteger(slot.exprId) &&
      slot.exprId >= 0 &&
      slot.exprId < EMOTION_COUNT
    ) {
      expr = EXPRESSION_POOL[slot.exprId];
    } else {
      expr = (randomEmotionQueue.pop() || { desc: "" }).desc;
    }
    // Weather — explicit pins always win. Random rolls draw from a
    // shuffled queue so weather never duplicates across the grid.
    let weather = "";
    if (
      Number.isInteger(slot.weatherId) &&
      slot.weatherId >= EMOTION_COUNT &&
      slot.weatherId < EXPRESSION_POOL.length
    ) {
      weather = EXPRESSION_POOL[slot.weatherId];
    } else if (!slot.weatherNone && Math.random() < RANDOM_WEATHER_CHANCE) {
      const picked = randomWeatherQueue.pop();
      if (picked) weather = picked.desc;
    }
    return weather ? `${expr} + ${weather}` : expr;
  });

  // Spatially label each bullet so Gemini knows which cell each goes in.
  // Lowercase content avoids getting transcribed as on-image text.
  const POSITIONS = [
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "middle-center",
    "middle-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
  ];
  const bullets = lines
    .map((line, i) => `• ${POSITIONS[i]} tile: ${line.toLowerCase()}`)
    .join("\n");

  return `Create a single 3×3 grid image: 3 rows × 3 columns of 9 equal-size square portraits of the same subject from the reference image. Each tile shows a dramatically different, theatrical, exaggerated facial expression — the nine must be obviously distinct at a glance.

CRITICAL — match the reference's ART STYLE exactly. Whatever the reference is, keep it:
• If reference is a photograph → output photo-realistic portraits.
• If reference is anime / manga → output anime illustrations in the same line-art and shading.
• If reference is a cartoon / chibi → stay cartoon, same linework and palette.
• If reference is 3D-rendered / CGI → stay 3D-rendered.
• If reference is a painting / sketch / watercolor → match that medium.
• If reference is a statue / deity / sculpture → keep sculptural look.
Do NOT "upgrade" the reference into photography. Do NOT turn illustrations into real humans. The 9 tiles must look like they came from the SAME artist / camera / render pipeline as the reference.

Each bullet below describes EXACTLY ONE tile at a specific position. Render that expression in that position — do not re-order, do not merge two bullets into one tile, do not skip any bullet. All nine bullets MUST appear, each in its labelled cell:

${bullets}

A bullet written as "<state> + <weather>" means the tile shows both at once — e.g. "ecstatic laughter + drenched in rain" = the subject laughing while being poured on. Both states are rendered in the reference's own style (cartoon rain for a cartoon, photoreal rain for a photo, etc.).

Identity stays constant across every tile: same face/features, colours, hairstyle, clothing, and background treatment as the reference. Weather bullets (lightning, rain, snow, wind, heat, cold, electrocution, sun-dazzle, goosebumps) MAY temporarily change hair (wet, windblown, standing on end) and skin/surface (wet, flushed, frosted, cracked) — that is expected. The SUBJECT must still be clearly the same character.

OUTPUT RULES — strictly enforced:
- Do NOT render any text, letters, numbers, labels, captions, subtitles, callouts, watermarks, emoji, or arrows anywhere on the image.
- Do NOT write the expression names on the tiles. The bullets above are instructions for you, not text to paint.
- No borders, gutters, or dividers between tiles — it is one seamless 1:1 image.
- Two tiles with the same mouth shape or same eye state are NOT allowed.
- The art style MUST match the reference.`;
}

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
      const url = new URL(request.url);
      if (url.pathname === "/pool") {
        return json({ pool: poolManifest() }, 200, cors);
      }
      return json({ ok: true, service: "emoji-slot-gemini" }, 200, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405, cors);
    }

    // POST /prompt — returns the assembled prompt without calling Gemini.
    // Useful for previewing or copying to other AI tools.
    const reqUrl = new URL(request.url);
    if (reqUrl.pathname === "/prompt") {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      const promptText = buildPrompt(body?.slots);
      return json({ prompt: promptText }, 200, cors);
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

    const { imageBase64, mimeType = "image/jpeg", prompt, model, enabledIds } = body || {};
    if (typeof imageBase64 !== "string" || imageBase64.length < 100) {
      return json({ error: "imageBase64 is required" }, 400, cors);
    }
    if (imageBase64.length * 0.75 > MAX_INPUT_BYTES) {
      return json({ error: "image too large (max ~7.5 MB)" }, 413, cors);
    }

    const chosenModel = (model || env.DEFAULT_MODEL || DEFAULT_MODEL).trim();
    const chosenPrompt = typeof prompt === "string" && prompt.trim()
      ? prompt
      : buildPrompt(enabledIds);

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
