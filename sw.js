// Service Worker for 表情拉霸機 — static-shell cache + network-first for everything else.
// Bump CACHE_VERSION whenever any cached asset materially changes.

const CACHE_VERSION = "slot-v17";
// 資產以 URL 為鍵回查:ignoreSearch 讓帶 ?utm= 的路由也命中,ignoreVary 避開 Pages 的
// Vary: Accept-Encoding(<video> 送 identity、暖快取存的帶 gzip → 預設比對 miss)。
const RANGE_MATCH = { ignoreSearch: true, ignoreVary: true };
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./assets/fonts/caveat-400.woff2",
  "./assets/fonts/caveat-600.woff2",
  "./assets/fonts/noto-sans-tc-300.woff2",
  "./assets/fonts/noto-sans-tc-400.woff2",
  "./assets/fonts/noto-sans-tc-500.woff2",
  "./assets/fonts/noto-sans-tc-700.woff2",
  "./assets/fonts/zen-kaku-gothic-new-400.woff2",
  "./assets/fonts/zen-kaku-gothic-new-500.woff2",
  "./assets/fonts/zen-kaku-gothic-new-700.woff2",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.png",
  "./apple-touch-icon.png",
  "./favicon.ico",
  "./og.png",
  // 首頁 mode card 會 autoplay 這兩支示範影片 —— 一起 precache,離線也看得到;
  // <video> 的 Range 請求靠下面 rangedResponse 從快取合成 206。排最後、檔案最大。
  "./demo-reel.webm",
  "./demo-classic.webm",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // allSettled:單一檔(如較大的 .webm)抓失敗不整批擋掉安裝更新
      .then((cache) => Promise.allSettled(CORE_ASSETS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            // 只清自己的 slot-*:CacheStorage 是 per-origin,yazelin.github.io 所有專案共用
            // 同一份,無差別刪會把 gewu、neko 等別站的離線包整包清掉,而且毫無徵兆。
            .filter((name) => name.startsWith("slot-") && name !== CACHE_VERSION)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

// 從快取的完整回應合成 206:Chrome 的媒體管線對較大的檔一律用 Range 抓,拿到
// 「200 但沒有 Content-Range」會直接判 Format error —— 斷網時大 .webm 播不出來的真因。
async function rangedResponse(req, res) {
  const range = req.headers.get("range");
  if (!range) return res;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!m) return res;
  const buf = await res.arrayBuffer();
  const len = buf.byteLength;
  let start = m[1] ? Number(m[1]) : null;
  let end = m[2] ? Number(m[2]) : null;
  if (start === null && end !== null) { start = Math.max(0, len - end); end = len - 1; }
  else { start ??= 0; end = end === null ? len - 1 : Math.min(end, len - 1); }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= len) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${len}` } });
  }
  const h = new Headers(res.headers);
  h.set("accept-ranges", "bytes");
  h.set("content-range", `bytes ${start}-${end}/${len}`);
  h.set("content-length", String(end - start + 1));
  return new Response(buf.slice(start, end + 1), { status: 206, headers: h });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache Worker API calls (image generation is always live).
  if (url.hostname.endsWith("workers.dev")) return;

  // Navigation: network-first, fall back to cached shell for offline boot.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html", RANGE_MATCH))
    );
    return;
  }

  // Same-origin static: cache-first(Range 請求合成 206),背景更新。
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req, RANGE_MATCH).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === "basic") {
              const copy = res.clone();
              caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached ? rangedResponse(req, cached) : fetchPromise;
      })
    );
  }
});
