// Cloudflare Worker: proxy for Vertex AI image generation.
// Frontend calls us with { imageBase64, mimeType, prompt? }.
// We add the API key (stored as a Worker Secret) and forward to Vertex AI,
// then return the generated image as base64.

const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
const MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10 MB decoded image size
const DAILY_LIMIT = 5;                     // free AI generations per IP per UTC day
const INFLIGHT_TTL_SECONDS = 180;          // safety net for the per-IP lock

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

  const weatherPool = EXPRESSION_POOL.slice(EMOTION_COUNT);

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
    // Weather — each slot rolls independently. Duplicates across the
    // grid are allowed because "random" should just be random.
    let weather = "";
    if (
      Number.isInteger(slot.weatherId) &&
      slot.weatherId >= EMOTION_COUNT &&
      slot.weatherId < EXPRESSION_POOL.length
    ) {
      weather = EXPRESSION_POOL[slot.weatherId];
    } else if (!slot.weatherNone && Math.random() < RANDOM_WEATHER_CHANCE) {
      weather = weatherPool[Math.floor(Math.random() * weatherPool.length)];
    }
    return weather ? `${expr} + ${weather}` : expr;
  });

  // Anchor each cell with (1) a letter label (2) a row/column call-out
  // (3) an ASCII diagram so Gemini has a visual map of positions.
  // We kept this in after A/B testing against the "same prompt pasted to
  // gemini.google.com" baseline — dropping the letters tanked pairing
  // fidelity to 1-2/9, keeping them held it at 6-9/9.
  const L = lines.map((l) => l.toLowerCase());
  const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
  const diagram = `\`\`\`
+------+------+------+
|  A   |  B   |  C   |   ← top row
+------+------+------+
|  D   |  E   |  F   |   ← middle row
+------+------+------+
|  G   |  H   |  I   |   ← bottom row
+------+------+------+
   ↑      ↑      ↑
 left  centre right
\`\`\``;
  const NAMES = [
    "top-left",
    "top-centre",
    "top-right",
    "middle-left",
    "middle-centre",
    "middle-right",
    "bottom-left",
    "bottom-centre",
    "bottom-right",
  ];
  const layout = LETTERS.map(
    (letter, i) => `  [${letter}] ${NAMES[i]} cell → ${L[i]}`
  ).join("\n");

  return `Create a single 3×3 grid image: 3 rows × 3 columns of 9 equal-size square portraits of the same subject from the reference image. Each tile shows a dramatically different, theatrical, exaggerated facial expression — the nine must be obviously distinct at a glance.

CRITICAL — match the reference's ART STYLE exactly. Whatever the reference is, keep it:
• If reference is a photograph → output photo-realistic portraits.
• If reference is anime / manga → output anime illustrations in the same line-art and shading.
• If reference is a cartoon / chibi → stay cartoon, same linework and palette.
• If reference is 3D-rendered / CGI → stay 3D-rendered.
• If reference is a painting / sketch / watercolor → match that medium.
• If reference is a statue / deity / sculpture → keep sculptural look.
Do NOT "upgrade" the reference into photography. Do NOT turn illustrations into real humans. The 9 tiles must look like they came from the SAME artist / camera / render pipeline as the reference.

The 3×3 layout uses the following cell labels (A..I). Each cell must show EXACTLY the expression listed for its letter — do not swap cells, do not merge, do not skip any cell:

${diagram}

${layout}

A cell written as "<state> + <weather>" means that tile shows both at once — e.g. "ecstatic laughter + drenched in rain" = the subject laughing while being poured on. Render both layers in the reference's own style (cartoon rain for a cartoon, photoreal rain for a photo, etc.).

Identity stays constant across every cell: same face/features, colours, hairstyle, clothing, and background treatment as the reference. Weather states (lightning, rain, snow, wind, heat, cold, electrocution, sun-dazzle, goosebumps) MAY temporarily change hair (wet, windblown, standing on end) and skin/surface (wet, flushed, frosted, cracked) — that is expected. The SUBJECT must still be clearly the same character.

OUTPUT RULES — strictly enforced:
- Final image is a 3×3 photographic grid only. Do NOT render any text, letters, numbers, labels, captions, subtitles, callouts, watermarks, emoji, arrows, or the letter labels (A..I) anywhere on the image.
- Do NOT write the expression names on the tiles. The layout above is instruction for you, not text to paint.
- No visible borders, gutters, dividers, or ASCII lines between tiles — it is one seamless 1:1 image.
- Each cell must correspond to EXACTLY the state mapped to its letter in the layout above. No swapping, no re-ordering, no skipping.
- Two cells with the same mouth shape or same eye state are NOT allowed.
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

// ---------- Client IP ----------
function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

// ---------- Daily quota via Cloudflare KV ----------
// Keyed `quota:<ip>:<YYYY-MM-DD UTC>`, TTL 36h. If the QUOTA binding is
// missing, quota is reported unlimited so the app still functions.
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}
function quotaKey(ip) {
  return `quota:${ip}:${todayUTC()}`;
}
async function readQuota(env, ip) {
  if (!env || !env.QUOTA) return { used: 0, limit: DAILY_LIMIT, kvAvailable: false };
  const used = parseInt((await env.QUOTA.get(quotaKey(ip))) || "0", 10);
  return { used, limit: DAILY_LIMIT, kvAvailable: true };
}
async function bumpQuota(env, ip) {
  if (!env || !env.QUOTA) return DAILY_LIMIT;
  const k = quotaKey(ip);
  const used = parseInt((await env.QUOTA.get(k)) || "0", 10);
  const next = used + 1;
  await env.QUOTA.put(k, String(next), { expirationTtl: 60 * 60 * 36 });
  return next;
}
// Refund a slot when the upstream call failed after we pre-bumped — only
// successful generations burn the daily allowance.
async function decrementQuota(env, ip) {
  if (!env || !env.QUOTA) return;
  const k = quotaKey(ip);
  const used = parseInt((await env.QUOTA.get(k)) || "0", 10);
  if (used <= 0) return;
  await env.QUOTA.put(k, String(used - 1), { expirationTtl: 60 * 60 * 36 });
}

// ---------- Per-IP in-flight serialization ----------
// The shared gemini-web backend is single-threaded; spam-clicks must not
// queue N concurrent browser jobs. Hold `inflight:<ip>` while a request runs.
function inflightKey(ip) {
  return `inflight:${ip}`;
}
async function acquireInflight(env, ip) {
  if (!env || !env.QUOTA) return true;
  const k = inflightKey(ip);
  if (await env.QUOTA.get(k)) return false;
  await env.QUOTA.put(k, "1", { expirationTtl: INFLIGHT_TTL_SECONDS });
  return true;
}
async function releaseInflight(env, ip) {
  if (!env || !env.QUOTA) return;
  await env.QUOTA.delete(inflightKey(ip));
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
      if (url.pathname === "/quota") {
        return json({ quota: await readQuota(env, getClientIp(request)) }, 200, cors);
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

    // AI image generation temporarily disabled (kill switch) — steer users to
    // BYOG. /prompt above still works so they can copy. Flip AI_DISABLED off in
    // wrangler.toml to re-enable.
    if (env.AI_DISABLED === "1") {
      return json(
        {
          error: "ai disabled",
          hint: "byog",
          message:
            "AI 直接生成暫停服務中（後端維修）。可改走免費 BYOG：複製 prompt，貼到 " +
            "ChatGPT／Gemini 時務必「先附上你的參考圖再貼 prompt」，把產出的 3×3 圖存下來貼回來即可。",
        },
        503,
        cors,
      );
    }

    if (!env.VERTEX_API_KEY && !env.GEMINI_WEB_BASE_URL) {
      return json({ error: "server misconfigured: set VERTEX_API_KEY or GEMINI_WEB_BASE_URL" }, 500, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400, cors);
    }

    const { imageBase64, mimeType = "image/jpeg", prompt, model, slots } = body || {};
    if (typeof imageBase64 !== "string" || imageBase64.length < 100) {
      return json({ error: "imageBase64 is required" }, 400, cors);
    }
    if (imageBase64.length * 0.75 > MAX_INPUT_BYTES) {
      return json({ error: "image too large (max ~7.5 MB)" }, 413, cors);
    }

    const ip = getClientIp(request);

    // Per-IP in-flight lock first — cheapest defense against spam-clicking the
    // single-threaded shared backend.
    const gotLock = await acquireInflight(env, ip);
    if (!gotLock) {
      const quotaNow = await readQuota(env, ip);
      return json(
        {
          error: "in flight",
          quota: quotaNow,
          message: "上一個生成還在跑（最久約 60 秒）。等它完成或失敗再點，狂點不會更快。",
        },
        429,
        cors,
      );
    }

    try {
      // Daily quota gate.
      const quotaBefore = await readQuota(env, ip);
      if (quotaBefore.used >= quotaBefore.limit) {
        return json(
          {
            error: "daily quota exceeded",
            hint: "byog",
            quota: quotaBefore,
            message: `今天的 ${quotaBefore.limit} 次免費生成已用完。可複製 prompt + 附參考圖，自己到 ChatGPT／Gemini 跑（免費、不限次）。明天 UTC 0 點重置。`,
          },
          429,
          cors,
        );
      }
      // Pre-emptive bump (charge before the call) so a flood of simultaneous
      // requests can't each slip through the gate. Refunded on recoverable errors.
      const usedAfter = await bumpQuota(env, ip);

      const chosenModel = (model || env.DEFAULT_MODEL || DEFAULT_MODEL).trim();
      const chosenPrompt = typeof prompt === "string" && prompt.trim()
        ? prompt
        : buildPrompt(slots);

      let outMime, outData;

      if (env.GEMINI_WEB_BASE_URL) {
        // gemini-web is browser-driven Gemini Web. Its :generateContent only
        // does TEXT→image (drops the reference photo), so a reference-conditioned
        // grid must go through /api/edit. Payload {prompt, reference_image,
        // timeout}; response {success, images:["data:...base64"], error}.
        const editUrl = `${env.GEMINI_WEB_BASE_URL.replace(/\/+$/, "")}/api/edit`;
        let upstream;
        try {
          upstream = await fetch(editUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY || "" },
            body: JSON.stringify({ prompt: chosenPrompt, reference_image: imageBase64, timeout: 360 }),
          });
        } catch (err) {
          await decrementQuota(env, ip);
          return json({ error: "upstream fetch failed", detail: String(err) }, 502, cors);
        }
        if (!upstream.ok) {
          const text = await upstream.text();
          await decrementQuota(env, ip);
          return json({ error: "upstream error", status: upstream.status, detail: text.slice(0, 1500) }, 502, cors);
        }
        const result = await upstream.json();
        const imgs = result?.images || [];
        if (!result?.success || imgs.length === 0) {
          // Browser-side failure (content blocked / no image / glitch). Not a
          // billed call — it's our own service — so refund the quota.
          await decrementQuota(env, ip);
          return json(
            {
              error: result?.error || "no image in response",
              detail: String(result?.message || result?.detail || "").slice(0, 500),
              quota: { used: Math.max(0, usedAfter - 1), limit: DAILY_LIMIT },
            },
            502,
            cors,
          );
        }
        const img = imgs[0];
        if (img.includes(",")) {
          const [hdr, b64] = img.split(",", 2);
          outMime = (hdr.match(/data:([^;]+)/) || [])[1] || "image/png";
          outData = b64;
        } else {
          outMime = "image/png";
          outData = img;
        }
      } else {
        // Vertex fallback (legacy; only used when GEMINI_WEB_BASE_URL unset).
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
          await decrementQuota(env, ip);
          return json({ error: "upstream fetch failed", detail: String(err) }, 502, cors);
        }
        if (!upstream.ok) {
          const text = await upstream.text();
          await decrementQuota(env, ip);
          return json({ error: "upstream error", status: upstream.status, detail: text.slice(0, 1500) }, 502, cors);
        }
        const data = await upstream.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find((p) => p.inlineData);
        if (!imagePart) {
          return json(
            { error: "no image in response", raw: JSON.stringify(data).slice(0, 1500), quota: { used: usedAfter, limit: DAILY_LIMIT } },
            502,
            cors,
          );
        }
        outMime = imagePart.inlineData.mimeType || "image/png";
        outData = imagePart.inlineData.data;
      }

      return json(
        {
          mimeType: outMime,
          data: outData,
          model: chosenModel,
          quota: { used: usedAfter, limit: DAILY_LIMIT },
        },
        200,
        cors,
      );
    } finally {
      await releaseInflight(env, ip);
    }
  },
};
