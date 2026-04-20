// Emoji Slot Machine — split a 3x3 grid image, then render a looping slot video.

// Register service worker (PWA install + offline shell). Silently ignore
// failures so the app still works when served from file:// or HTTP.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("SW registration failed:", err);
    });
  });
}

const $ = (id) => document.getElementById(id);

const API_URL_KEY = "slot-api-url";
const SLOT_CONFIG_KEY = "slot-machine-slots";
const DEFAULT_API_URL = "https://emoji-slot-gemini.yazelinj303.workers.dev";
const ESTIMATED_GEN_SECONDS = 50;

// Chinese short labels parallel to Worker's EXPRESSION_POOL by index (0..44).
// Kept in sync manually with worker/src/index.js.
const EXPRESSION_LABELS_ZH = [
  "放聲大笑", "笑到流淚", "嚎啕大哭", "含淚悲傷", "暴怒", "激動大吼",
  "嘟嘴生氣", "驚嚇震驚", "下巴掉下來", "略感驚訝", "仰慕注目", "噁心厭惡",
  "尷尬退縮", "心虛尷尬", "困惑不解", "嘟嘴懷疑", "壞笑", "神秘微笑",
  "俏皮眨眼", "吐舌扮鬼臉", "傻笑", "飛吻", "愛心眼", "撒嬌斜眼",
  "害羞臉紅", "自豪微笑", "放空發呆", "面無表情", "翻白眼", "睡眠打哈欠",
  "得意", "專心", "堅定", "鼓腮幫子", "緊張吞口水", "無聲尖叫",
  "被電到", "被雷打到", "被強風吹", "淋雨", "在雪中", "冷到發抖",
  "熱到冒汗", "被日光刺眼", "寒顫",
];

// Pool manifest cache (fetched from Worker on first settings open).
const poolCache = { loaded: false, items: [] };

// Per-slot configuration: length-9 array. Each entry is:
//   null          → random (Worker picks)
//   { id: 3 }     → preset pool entry by id
//   { custom: s } → free text
function loadSlotConfig() {
  try {
    const raw = localStorage.getItem(SLOT_CONFIG_KEY);
    if (!raw) return new Array(9).fill(null);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 9) return new Array(9).fill(null);
    return parsed;
  } catch {
    return new Array(9).fill(null);
  }
}

function saveSlotConfig(cfg) {
  const allRandom = cfg.every((s) => s === null);
  if (allRandom) localStorage.removeItem(SLOT_CONFIG_KEY);
  else localStorage.setItem(SLOT_CONFIG_KEY, JSON.stringify(cfg));
}

const state = {
  sourceImage: null,   // HTMLImageElement
  tiles: [],           // HTMLImageElement[] length 9
  videoBlob: null,     // Blob
  selfieFile: null,    // File uploaded by user
};

// ---------- AI: generate 3x3 from selfie ----------

const selfieDrop = $("selfie-drop");
const selfieInput = $("selfie-input");
const selfiePreview = $("selfie-preview");
const selfieImg = $("selfie-img");
const selfieClear = $("selfie-clear");
const aiGenerateBtn = $("ai-generate-btn");
const aiProgress = $("ai-progress");
const aiBarFill = $("ai-bar-fill");
const aiProgressText = $("ai-progress-text");

const settingsDialog = $("settings-dialog");
const slotGrid = $("slot-grid");
const slotsResetBtn = $("slots-reset");
const openSettingsLink = $("open-settings-link");
const slotStatusText = $("slot-status-text");

// NOTE: do NOT call selfieInput.click() here — the <label> wrapper already
// opens the picker natively, so adding an extra .click() shows it twice.
selfieInput.addEventListener("change", (e) => handleSelfie(e.target.files[0]));
["dragenter", "dragover"].forEach((ev) =>
  selfieDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    selfieDrop.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  selfieDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    selfieDrop.classList.remove("dragover");
  })
);
selfieDrop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) handleSelfie(f);
});

selfieClear.addEventListener("click", () => {
  state.selfieFile = null;
  selfieInput.value = "";
  selfiePreview.hidden = true;
  selfieDrop.hidden = false;
  aiGenerateBtn.disabled = true;
});

if (openSettingsLink) openSettingsLink.addEventListener("click", openSettings);
refreshSlotStatus();

async function openSettings() {
  await ensurePoolLoaded();
  renderSlotGrid(loadSlotConfig());
  settingsDialog.showModal();
}

slotsResetBtn.addEventListener("click", () => {
  renderSlotGrid(new Array(9).fill(null));
});

const slotsCopyBtn = $("slots-copy-prompt");
const slotsCopyStatus = $("slots-copy-status");
if (slotsCopyBtn) {
  slotsCopyBtn.addEventListener("click", async () => {
    const cfg = readSlotConfigFromGrid();
    slotsCopyStatus.hidden = false;
    slotsCopyStatus.textContent = "正在組 prompt…";
    try {
      const apiUrl = localStorage.getItem(API_URL_KEY) || DEFAULT_API_URL;
      const resp = await fetch(apiUrl.replace(/\/$/, "") + "/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slots: cfg }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const { prompt } = await resp.json();
      await navigator.clipboard.writeText(prompt);
      slotsCopyStatus.textContent =
        "✓ 已複製完整 prompt！到 Gemini / ChatGPT 貼上 + 附自拍，就能生成你這組自訂的 3×3";
    } catch (err) {
      console.error(err);
      slotsCopyStatus.textContent = `複製失敗：${err.message}`;
    }
    setTimeout(() => { slotsCopyStatus.hidden = true; }, 6000);
  });
}

settingsDialog.addEventListener("close", () => {
  if (settingsDialog.returnValue === "save") {
    saveSlotConfig(readSlotConfigFromGrid());
    refreshSlotStatus();
  }
});

function refreshSlotStatus() {
  if (!slotStatusText) return;
  const cfg = loadSlotConfig();
  let exprCustomised = 0;  // exprId or exprCustom
  let weatherPinned = 0;   // weatherId set
  let weatherOff = 0;      // weatherNone
  for (const slot of cfg) {
    if (!slot) continue;
    if (Number.isInteger(slot.exprId) || typeof slot.exprCustom === "string") {
      exprCustomised += 1;
    }
    if (Number.isInteger(slot.weatherId)) weatherPinned += 1;
    else if (slot.weatherNone) weatherOff += 1;
  }
  if (exprCustomised === 0 && weatherPinned === 0 && weatherOff === 0) {
    slotStatusText.textContent = "🎲 目前：9 格全隨機（表情 + 有時會出現天氣）";
    return;
  }
  const parts = [];
  if (exprCustomised > 0) parts.push(`${exprCustomised} 格指定表情`);
  if (weatherPinned > 0) parts.push(`${weatherPinned} 格指定天氣`);
  if (weatherOff > 0) parts.push(`${weatherOff} 格關天氣`);
  const rest = 9 - Math.max(exprCustomised, weatherPinned, weatherOff);
  slotStatusText.textContent = `🎨 自訂設定：${parts.join("、")}，其他格隨機`;
}

async function ensurePoolLoaded() {
  if (poolCache.loaded) return;
  try {
    const apiUrl = localStorage.getItem(API_URL_KEY) || DEFAULT_API_URL;
    const resp = await fetch(apiUrl.replace(/\/$/, "") + "/pool");
    if (!resp.ok) throw new Error(`pool ${resp.status}`);
    const data = await resp.json();
    poolCache.items = data.pool || [];
    poolCache.loaded = true;
  } catch (err) {
    console.warn("failed to fetch pool, using built-in labels only", err);
    // Fallback: construct from local labels.
    poolCache.items = EXPRESSION_LABELS_ZH.map((_, id) => ({
      id,
      category: id < 36 ? "emotion" : "weather",
      label: `#${id}`,
    }));
    poolCache.loaded = true;
  }
}

function renderSlotGrid(cfg) {
  slotGrid.innerHTML = "";
  for (let i = 0; i < 9; i++) {
    slotGrid.appendChild(buildSlotCell(i, cfg[i]));
  }
}

// Slot data model (persisted per-slot):
//   null          → completely random (expression random, no weather)
//   {} or {exprId|exprCustom|weatherId} → any combination
// Worker will fill the blanks randomly from the right sub-pool.
function buildSlotCell(index, slotValue) {
  const cell = document.createElement("div");
  cell.className = "slot-cell";
  cell.dataset.idx = String(index);

  const head = document.createElement("div");
  head.className = "slot-head";
  head.textContent = `第 ${index + 1} 格`;
  cell.appendChild(head);

  // Expression select
  const exprSelect = document.createElement("select");
  exprSelect.className = "slot-select slot-expr";
  exprSelect.appendChild(new Option("🎲 表情：隨機", "__random__"));
  poolCache.items
    .filter((p) => p.category === "emotion")
    .forEach((p) =>
      exprSelect.appendChild(
        new Option(EXPRESSION_LABELS_ZH[p.id] || p.label, `preset:${p.id}`)
      )
    );
  exprSelect.appendChild(new Option("✏️ 自訂表情…", "__custom__"));
  cell.appendChild(exprSelect);

  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.className = "slot-custom";
  customInput.placeholder = "自己描述，例如：看到帥哥兩眼發亮";
  customInput.hidden = true;
  cell.appendChild(customInput);

  // Weather select
  const weatherSelect = document.createElement("select");
  weatherSelect.className = "slot-select slot-weather";
  weatherSelect.appendChild(new Option("🎲 天氣：隨機", "__random__"));
  weatherSelect.appendChild(new Option("☀ 天氣：無", "__none__"));
  poolCache.items
    .filter((p) => p.category === "weather")
    .forEach((p) =>
      weatherSelect.appendChild(
        new Option(EXPRESSION_LABELS_ZH[p.id] || p.label, `preset:${p.id}`)
      )
    );
  cell.appendChild(weatherSelect);

  // Pre-fill from existing config
  const v = slotValue || {};
  if (typeof v.exprCustom === "string" && v.exprCustom) {
    exprSelect.value = "__custom__";
    customInput.value = v.exprCustom;
    customInput.hidden = false;
  } else if (Number.isInteger(v.exprId)) {
    exprSelect.value = `preset:${v.exprId}`;
  } else {
    exprSelect.value = "__random__";
  }
  if (Number.isInteger(v.weatherId)) {
    weatherSelect.value = `preset:${v.weatherId}`;
  } else if (v.weatherNone) {
    weatherSelect.value = "__none__";
  } else {
    weatherSelect.value = "__random__";
  }

  exprSelect.addEventListener("change", () => {
    customInput.hidden = exprSelect.value !== "__custom__";
    if (!customInput.hidden) customInput.focus();
  });

  return cell;
}

function readSlotConfigFromGrid() {
  const cfg = new Array(9).fill(null);
  slotGrid.querySelectorAll(".slot-cell").forEach((cell) => {
    const idx = parseInt(cell.dataset.idx, 10);
    const exprSel = cell.querySelector(".slot-expr");
    const weatherSel = cell.querySelector(".slot-weather");
    const custom = cell.querySelector(".slot-custom");

    const entry = {};
    if (exprSel.value === "__custom__") {
      const t = custom.value.trim();
      if (t) entry.exprCustom = t;
    } else if (exprSel.value.startsWith("preset:")) {
      entry.exprId = parseInt(exprSel.value.slice(7), 10);
    }
    if (weatherSel.value.startsWith("preset:")) {
      entry.weatherId = parseInt(weatherSel.value.slice(7), 10);
    } else if (weatherSel.value === "__none__") {
      entry.weatherNone = true;
    }
    // __random__ → no field (weather will roll naturally)

    cfg[idx] = Object.keys(entry).length === 0 ? null : entry;
  });
  return cfg;
}

async function handleSelfie(file) {
  if (!file || !file.type.startsWith("image/")) {
    alert("請上傳圖片檔");
    return;
  }
  state.selfieFile = file;
  selfieImg.src = URL.createObjectURL(file);
  selfieDrop.hidden = true;
  selfiePreview.hidden = false;
  aiGenerateBtn.disabled = false;
}

aiGenerateBtn.addEventListener("click", async () => {
  if (!state.selfieFile) return;
  const apiUrl =
    localStorage.getItem(API_URL_KEY) ||
    DEFAULT_API_URL ||
    prompt("請輸入 Worker URL");
  if (!apiUrl) return;

  aiGenerateBtn.disabled = true;
  aiProgress.hidden = false;
  setAiProgress(5, "縮圖中…");

  let tick = null;
  try {
    const { base64, mimeType } = await fileToResizedBase64(
      state.selfieFile,
      1280
    );

    // Pseudo-progress: climb toward 85% over ESTIMATED_GEN_SECONDS.
    const start = Date.now();
    tick = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      const pct = Math.min(85, 15 + (elapsed / ESTIMATED_GEN_SECONDS) * 70);
      const remain = Math.max(0, Math.ceil(ESTIMATED_GEN_SECONDS - elapsed));
      const msg = remain > 0
        ? `Gemini 作畫中… 已 ${Math.ceil(elapsed)}s，預估還有約 ${remain}s`
        : `仍在作畫… 已 ${Math.ceil(elapsed)}s（偶爾會超過預估，再等一下）`;
      setAiProgress(pct, msg);
    }, 500);

    const slotConfig = loadSlotConfig();
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: base64, mimeType, slots: slotConfig }),
    });

    clearInterval(tick);
    tick = null;

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${detail.slice(0, 300)}`);
    }

    setAiProgress(90, "載入結果…");
    const data = await resp.json();
    const gridUrl = `data:${data.mimeType};base64,${data.data}`;
    const img = await loadImage(gridUrl);

    state.sourceImage = img;
    sourceImg.src = gridUrl;
    dropZone.hidden = true;
    sourcePreview.hidden = false;

    await splitIntoTiles(img);
    $("step-tiles").hidden = false;
    $("step-video").hidden = false;

    setAiProgress(100, "生成完成，已拆好 9 張");
    $("step-upload").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    console.error(err);
    setAiProgress(0, `失敗：${err.message}`);
  } finally {
    if (tick) clearInterval(tick);
    aiGenerateBtn.disabled = false;
  }
});

function setAiProgress(pct, text) {
  aiBarFill.style.width = `${pct}%`;
  aiProgressText.textContent = text;
}

async function fileToResizedBase64(file, maxSide) {
  const img = await loadImage(URL.createObjectURL(file));
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  const dataUrl = await new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.onerror = () => rej(reader.error);
    reader.readAsDataURL(blob);
  });
  return { base64: dataUrl.split(",")[1], mimeType: "image/jpeg" };
}

// ---------- Upload ----------

const fileInput = $("file-input");
const dropZone = $("drop-zone");
const sourcePreview = $("source-preview");
const sourceImg = $("source-img");
const clearBtn = $("clear-btn");

// The <label id="drop-zone"> already opens the picker — no extra click handler.
fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));

["dragenter", "dragover"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
  })
);
dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files?.[0];
  if (file) handleFile(file);
});

clearBtn.addEventListener("click", resetAll);

function resetAll() {
  state.sourceImage = null;
  state.tiles = [];
  state.videoBlob = null;
  fileInput.value = "";
  sourcePreview.hidden = true;
  dropZone.hidden = false;
  $("step-tiles").hidden = true;
  $("step-video").hidden = true;
  $("video-output").hidden = true;
  $("progress").hidden = true;
  $("tiles-grid").innerHTML = "";
}

async function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    alert("請上傳圖片檔。");
    return;
  }

  const img = await loadImage(URL.createObjectURL(file));
  state.sourceImage = img;
  sourceImg.src = img.src;
  dropZone.hidden = true;
  sourcePreview.hidden = false;

  await splitIntoTiles(img);
  $("step-tiles").hidden = false;
  $("step-video").hidden = false;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ---------- Split 3x3 ----------

async function splitIntoTiles(img) {
  const grid = $("tiles-grid");
  grid.innerHTML = "";
  state.tiles = [];

  const tileW = Math.floor(img.naturalWidth / 3);
  const tileH = Math.floor(img.naturalHeight / 3);

  const canvas = document.createElement("canvas");
  canvas.width = tileW;
  canvas.height = tileH;
  const ctx = canvas.getContext("2d");

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      ctx.clearRect(0, 0, tileW, tileH);
      ctx.drawImage(
        img,
        c * tileW, r * tileH, tileW, tileH,
        0, 0, tileW, tileH
      );
      const dataUrl = canvas.toDataURL("image/png");
      const tileImg = await loadImage(dataUrl);
      state.tiles.push(tileImg);

      const thumb = document.createElement("img");
      thumb.src = dataUrl;
      thumb.alt = `tile ${r * 3 + c + 1}`;
      grid.appendChild(thumb);
    }
  }
}

// ---------- Slot video ----------

const generateBtn = $("generate-btn");
const progress = $("progress");
const barFill = $("bar-fill");
const progressText = $("progress-text");
const videoOutput = $("video-output");
const previewVideo = $("preview-video");
const downloadBtn = $("download-btn");
const shareBtn = $("share-btn");

generateBtn.addEventListener("click", async () => {
  if (state.tiles.length !== 9) return;
  generateBtn.disabled = true;
  videoOutput.hidden = true;
  progress.hidden = false;
  setProgress(0, "初始化…");

  try {
    const fps = clamp(parseInt($("fps-input").value, 10), 5, 30);
    const repeats = clamp(parseInt($("repeats-input").value, 10), 1, 20);
    const size = parseInt($("size-input").value, 10);

    const blob = await renderSlotVideo({ tiles: state.tiles, fps, repeats, size });
    state.videoBlob = blob;

    const url = URL.createObjectURL(blob);
    previewVideo.src = url;
    downloadBtn.href = url;
    downloadBtn.download = `slot-machine-${Date.now()}.webm`;

    videoOutput.hidden = false;
    setProgress(100, `完成！檔案大小 ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.error(err);
    setProgress(0, `失敗：${err.message}`);
  } finally {
    generateBtn.disabled = false;
  }
});

function clamp(v, lo, hi) {
  if (Number.isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function setProgress(pct, text) {
  barFill.style.width = `${pct}%`;
  progressText.textContent = text;
}

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "";
}

async function renderSlotVideo({ tiles, fps, repeats, size }) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const canRequestFrame = typeof track.requestFrame === "function";

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: 5_000_000,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise((res) => (recorder.onstop = res));
  recorder.start();

  // Build frame order: for each repeat, shuffle tiles so no two adjacent
  // loops end/start with the same image.
  const frames = [];
  let prev = null;
  for (let i = 0; i < repeats; i++) {
    const shuffled = shuffle([...tiles]);
    if (prev !== null && shuffled[0] === prev && shuffled.length > 1) {
      [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
    }
    frames.push(...shuffled);
    prev = shuffled[shuffled.length - 1];
  }

  const frameMs = 1000 / fps;
  const total = frames.length;

  for (let i = 0; i < total; i++) {
    drawTile(ctx, frames[i], size);
    if (canRequestFrame) track.requestFrame();
    setProgress(
      Math.round((i / total) * 95),
      `渲染中 ${i + 1}/${total}`
    );
    await sleep(frameMs);
  }

  // Give recorder a beat to flush the last frame.
  await sleep(frameMs);
  recorder.stop();
  await stopped;

  return new Blob(chunks, { type: mimeType || "video/webm" });
}

function drawTile(ctx, img, size) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Share ----------

// ---------- Copy prompt ----------

const copyPromptBtn = $("copy-prompt-btn");
if (copyPromptBtn) {
  copyPromptBtn.addEventListener("click", async () => {
    const pre = $("copy-prompt-text");
    const label = copyPromptBtn.querySelector(".copy-label");
    const originalLabel = label.textContent;
    try {
      await navigator.clipboard.writeText(pre.textContent.trim());
      label.textContent = "已複製！貼到 Gemini 就好";
      copyPromptBtn.classList.add("copied");
    } catch {
      // Fallback: manual selection
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      label.textContent = "請手動 Ctrl+C 複製";
    }
    setTimeout(() => {
      label.textContent = originalLabel;
      copyPromptBtn.classList.remove("copied");
    }, 2500);
  });
}

shareBtn.addEventListener("click", async () => {
  if (!state.videoBlob) return;
  const file = new File(
    [state.videoBlob],
    downloadBtn.download || "slot-machine.webm",
    { type: state.videoBlob.type }
  );

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "表情拉霸機",
        text: "點一下影片看你今天的心情 😏",
      });
      return;
    } catch (err) {
      if (err.name !== "AbortError") console.error(err);
    }
  }
  alert(
    "你的瀏覽器不支援直接分享檔案。\n請先按「下載影片」，再手動到 Facebook 上傳貼文。"
  );
});
