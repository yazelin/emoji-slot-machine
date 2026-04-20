# 🎰 Emoji Slot Machine｜表情拉霸機

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-%E2%98%95-ffdd00?style=for-the-badge)](https://buymeacoffee.com/yazelin)
[![PWA](https://img.shields.io/badge/PWA-installable-5a5ad6?style=for-the-badge)](https://yazelin.github.io/emoji-slot-machine/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](#license)

把一張自拍 → 9 種誇張表情 → 一支 Facebook 可自動播放 / 點擊即停的**拉霸影片**。
貼到 FB 動態牆後會自動 loop，觀眾手指一碰就會停在隨機一格表情，像一張活的心情占卜。

**Live demo：** <https://yazelin.github.io/emoji-slot-machine/>

![OG preview](og.png)

---

## 目錄

- [它在做什麼](#它在做什麼)
- [為什麼在 Facebook 上行得通](#為什麼在-facebook-上行得通)
- [功能](#功能)
- [架構](#架構)
- [如何使用（使用者流程）](#如何使用使用者流程)
- [Prompt 工程筆記](#prompt-工程筆記)
- [本機開發](#本機開發)
- [自行部署 Cloudflare Worker](#自行部署-cloudflare-worker)
- [省錢小撇步](#省錢小撇步)
- [Roadmap](#roadmap)
- [支持](#支持)
- [License](#license)

---

## 它在做什麼

一個純前端（static）網頁，核心兩件事：

1. **上傳 1 張自拍** → 呼叫 Cloudflare Worker → Worker 帶 API Key 去打 Google
   Vertex AI（`gemini-3.1-flash-image-preview`）→ 拿回一張 **3×3 九宮格圖**，
   9 格是同一個人、9 種誇張到不行的表情。
2. **拆成 9 張圖 → 用 `<canvas>` + `MediaRecorder` 在瀏覽器裡輪播錄成一支
   WebM 拉霸影片**，可直接下載 / `navigator.share()` 到 FB。

也可以跳過 AI，直接上傳你手邊任何一張 3×3 圖（例：用 Gemini / ChatGPT 自己
生的），拉霸影片在你瀏覽器裡產出，不會經過任何後端。

## 為什麼在 Facebook 上行得通

Facebook 在 feed 上會對短影片自動播放，**使用者點一下就會暫停在當下這一影格**。
這個 app 產出的影片是：

```
[洗牌過的 9 格] × [N 次循環]  fps=10
```

也就是每一圈 9 格的順序都不一樣。FB 播到哪、觀眾點到哪 → 停在哪。
結果就是一支 **零 JS、FB 原生** 的「看你今天心情」拉霸梗圖。

> 這個 trick 不是只能拿來做表情包：9 張塔羅牌、9 張星座運勢、9 句幸運話都行。

## 功能

- 🤖 **自拍 → AI 自動生 3×3 表情圖**（45 種表情 / 天氣組合池，每次抽 9）
- 🧩 **自訂 9 格**：每一格可獨立選「表情」× 「天氣/環境反應」，或自己打描述
- 📋 **複製完整 prompt**：不想排隊等 Worker？一鍵複製 prompt 貼到
  `gemini.google.com` 自己跑
- ✂️ **自動拆格**：任何 3×3 圖上傳後自動切成 9 張，前端完成不傳後端
- 🎬 **WebM 拉霸影片**：自訂 FPS（5–30）、循環數（1–20）、尺寸（720² / 1080²）
- 📲 **PWA**：可安裝到手機主畫面，離線也能開（AI 功能需連線）
- 🔗 **Web Share API**：支援就直接分享到 FB / IG / Line，不支援則落回下載
- 🖼️ **Open Graph + Twitter Card**：貼到 FB / X 有自己的預覽圖
- 🎨 **風格保留**：照片 in → 照片 out，卡通 in → 卡通 out，不會被 AI
  「升級」成真人照

## 架構

```
┌───────────────────────────┐        ┌───────────────────────────┐
│  Static frontend (Pages)  │  POST  │   Cloudflare Worker       │
│  index.html / app.js      │───────▶│   worker/src/index.js     │
│                           │  JSON  │   (holds VERTEX_API_KEY)  │
│  - 拆 3×3 圖 (canvas)     │◀───────│                           │
│  - 合成拉霸影片           │        │   fetch → Vertex AI       │
│  (MediaRecorder → WebM)   │        │   gemini-3.1-flash-image  │
└───────────────────────────┘        └───────────────────────────┘
         ▲                                     ▲
         │ PWA install / offline               │ API key never touches client
         │ Web Share API                       │ CORS + rate-limit guard
```

- **前端**：靜態檔，放 GitHub Pages。沒有 build step。
- **Worker**：Cloudflare Worker 當代理層，**唯一**原因是要藏 Vertex AI 的
  API Key。同時也處理 CORS、限制輸入大小 (10 MB) 與組 prompt。
- **兩個端點**：
  - `POST /`：生成 3×3（帶圖 + slot 設定）
  - `POST /prompt`：只回傳組好的 prompt 文字（供「複製到 Gemini」使用）
  - `GET /pool`：回傳表情池 manifest，供前端畫自訂 UI

## 如何使用（使用者流程）

```
  ⓪ 上傳 1 張自拍（可選）                 或   ① 直接上傳現成 3×3 圖
           │                                          │
           ▼                                          │
   (Worker + Gemini 約 50 秒)                         │
           │                                          │
           └──────────────► ② 前端自動拆出 9 格 ◄────┘
                                  │
                                  ▼
                     ③ 設 FPS / 循環數 / 尺寸
                                  │
                                  ▼
                    下載 WebM / Share → FB 貼文
```

點進網站後每一步會自己亮出來，沒什麼要學。

## Prompt 工程筆記

這個專案折騰最久的不是前端，是 **怎麼讓 Gemini 乖乖畫 9 格對得上**。
踩過的雷、留下的 trick 都記在 `worker/src/index.js` 的 `buildPrompt()`：

- **大池 + 每次抽 9**：45 條表情池（36 表情 + 9 天氣），每次請求洗牌抽 9，
  讓每次「拉一次」的結果都新鮮。
- **ASCII 3×3 diagram 作為錨點**：一開始只列九條敘述，Gemini 會亂對位；
  補一張 ASCII `+---+---+---+` 的九宮格 + 每格註明 `top-left / middle-centre / …`
  後，配對正確率從 1-2/9 → 6-9/9。
- **字母標籤只寫在 prompt 不畫在圖上**：有標 `[A] top-left …` Gemini 會把
  字母烤進圖裡；去掉 → 又退化；最後保留字母標但在 OUTPUT RULES 明寫
  「不要畫任何文字 / 字母 / 數字」。
- **風格鎖定**：強制要求輸出與參考圖**同風格**（照片 → 照片、動漫 → 動漫、
  雕像 → 雕像）。不加這段，卡通自拍常被「升級」成真人照。
- **天氣是覆蓋層**：`"ecstatic laughter + drenched in rain"` 這種組合被解讀
  成「表情 + 天氣」同時發生，不是二擇一。
- **身份一致性條款**：五官 / 髮型 / 衣著 / 背景要一樣，但天氣那格的頭髮可以
  變濕、變結冰 — 這條不寫的話天氣那格會變成另一個人。

詳細條文請直接看 [`worker/src/index.js`](worker/src/index.js)。

## 本機開發

沒有 build step、沒有 npm deps（前端部分），開 `index.html` 就能跑：

```bash
python3 -m http.server 8000
# 然後瀏覽 http://localhost:8000
```

要在本機測 AI 功能（⓪），把前端指到本機 Worker：

```bash
cd worker
npm install
npx wrangler dev          # 啟動 http://127.0.0.1:8787
```

然後在瀏覽器 DevTools console：

```js
localStorage.setItem("slot-api-url", "http://127.0.0.1:8787");
```

## 自行部署 Cloudflare Worker

想自己付 API 帳單 / 避開作者的 rate limit：

```bash
cd worker
npx wrangler login                        # 第一次會開瀏覽器
npx wrangler secret put VERTEX_API_KEY    # 貼上 Vertex AI Express Mode key
npx wrangler deploy                       # 會印出 https://xxx.workers.dev
```

部署完把 URL 寫進前端：

```js
localStorage.setItem("slot-api-url", "https://YOUR-WORKER.workers.dev");
```

| Env key | 型別 | 用途 |
|---|---|---|
| `VERTEX_API_KEY` | **Secret** | Vertex AI Express Mode API Key |
| `DEFAULT_MODEL` | var (optional) | 預設 `gemini-3.1-flash-image-preview` |

## 省錢小撇步

AI 功能（⓪）是作者付錢呼叫 Gemini — rate limit 撞到時會掛。三個解法：

1. **按「自訂 9 格」→「複製到 Gemini」** → 貼到 <https://gemini.google.com>
   自己跑，免費、免排隊。產好的 3×3 圖回來丟進①就好。
2. 自己 deploy 一份 Worker（上面那節）。
3. 直接用其他 AI 工具（ChatGPT / Flow / Midjourney…）產 3×3 圖，①直接上傳。

## Roadmap

- [ ] 更多輸出比例（豎版 9:16 for Reels / Shorts）
- [ ] 更多影格策略（加速、減速、急停）
- [ ] 把 Worker 的 pool 拆成多主題（動物、食物、職場心情…）
- [ ] 瀏覽器端直接呼叫 Vertex（user-supplied key）→ 完全移除後端依賴

## 支持

覺得好玩請：

- ☕ [Buy me a coffee](https://buymeacoffee.com/yazelin)
- ❤️ 按 repo 右上角的 **Sponsor** 按鈕
- ⭐ Star 這個 repo

錢錢直接換算成 Gemini API quota，讓這支 demo 繼續活著 🙏

## License

[MIT](LICENSE) © yazelin
