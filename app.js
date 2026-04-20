// Emoji Slot Machine — split a 3x3 grid image, then render a looping slot video.

const $ = (id) => document.getElementById(id);

const API_URL_KEY = "slot-api-url";
const DEFAULT_API_URL = "https://emoji-slot-gemini.yazelinj303.workers.dev";
const ESTIMATED_GEN_SECONDS = 50;

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

const settingsBtn = $("settings-btn");
const settingsDialog = $("settings-dialog");
const apiUrlInput = $("api-url-input");
const apiSaveBtn = $("api-save");

selfieDrop.addEventListener("click", () => selfieInput.click());
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

settingsBtn.addEventListener("click", () => {
  apiUrlInput.value = localStorage.getItem(API_URL_KEY) || "";
  settingsDialog.showModal();
});
apiSaveBtn.addEventListener("click", (e) => {
  const v = apiUrlInput.value.trim();
  if (v) localStorage.setItem(API_URL_KEY, v);
  else localStorage.removeItem(API_URL_KEY);
});

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
  setAiProgress(5, "🖼️ 縮圖中…");

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
        ? `🎨 Gemini 作畫中… 已 ${Math.ceil(elapsed)}s，預估還有約 ${remain}s`
        : `🎨 還在畫… 已 ${Math.ceil(elapsed)}s（偶爾會超過預估，再等一下）`;
      setAiProgress(pct, msg);
    }, 500);

    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: base64, mimeType }),
    });

    clearInterval(tick);
    tick = null;

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${detail.slice(0, 300)}`);
    }

    setAiProgress(90, "📦 載入結果…");
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

    setAiProgress(100, "✅ 生成完成，已拆好 9 張");
    $("step-upload").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    console.error(err);
    setAiProgress(0, `❌ 失敗：${err.message}`);
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

dropZone.addEventListener("click", () => fileInput.click());
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
