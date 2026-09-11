---
name: music-director
description: 音樂 Expert 配方庫。觸發時機：配樂／主題曲／MV 主題歌／插入曲生成任務（歌曲、器樂 BGM、歌詞、音樂 prompt 工程）。音樂生成類請求必載本庫，禁止憑記憶寫音樂 prompt。
---

# Music Director — SunoForge v3.0 配方庫

本目錄是音樂域 Expert 的 must-load 配方庫，主體為 SunoForge v3.0（MIT）12 檔 verbatim 入庫（`files/`，不翻譯不修改）。目標生成平台為 Google Lyria 3.5（暴君裁定路線），配方同時覆蓋 Suno／Flow Music／ElevenMusic／Stable Audio 等。

## 12 檔結構（5 CORE 規則層 + 7 DATA 事實層）

**CORE 層（prompting 規則，不隨平台版本腐爛）：**

| 檔 | 內容 |
|---|---|
| `CORE_00_ENTRY.md` | 入口／preloader／路由／輸出協議／信心標記 |
| `CORE_01_STYLE.md` | 六層 style 公式、時間與場景、人設（persona=傳記非標籤）、跨流派橋接 |
| `CORE_02_LYRICS.md` | 歌詞括號規則、段落標籤、演唱記號、adlibs、和絃、結構模板 |
| `CORE_03_DIAGNOSE.md` | 壞 prompt 診斷 12 查、修復引擎、失敗模式、幻覺構造清理 |
| `CORE_04_WHY.md` | 每條規則的 rationale（教學層） |

**DATA 層（平台事實快照，會過期，更新只換這些檔）：**

| 檔 | 內容 |
|---|---|
| `DATA_GOOGLE_2026-07.md` | Lyria 3.5／Flow Music：時間戳 prompting、多模態、人聲控制 |
| `DATA_SUNO_2026-07.md` | Suno 版本／欄位／slider／聲音／stems |
| `DATA_OTHER_2026-07.md` | ElevenMusic／Stable Audio／MiniMax／聚合器比較 |
| `DATA_LEGAL_2026-07.md` | 商用權／版權歸屬／聲音同意／訴訟與平台政策（最快腐爛，使用前必驗） |
| `DATA_RECIPES.md` | 45+ 流派／混合／對唱預設（含 BPM/key/slider） |
| `DATA_POSTPROD.md` | 母帶鏈／stems／DAW 交接／響度目標 |
| `DATA_VOCAB.md` | 音色／動態／律動／空間／樂器描述詞彙表＋樂理→prompt 翻譯 |

## CORE/DATA 分離哲學

平台事實（模型版本、欄位、政策）半年度全爛光，prompting 規則零爛——所以規則沉澱在 CORE、時效事實隔離在 DATA。**更新本庫時只換 DATA 檔（檔名帶日期後綴，換血即重命名），CORE 檔一字不動。** 每個 DATA 檔 frontmatter 帶 `valid_as_of` 與過期警示，使用前先核對。

## 通路判定先於配方（2026-09-11 實測校正）

**先確認這條 prompt 走哪條通路，再決定讀哪個 DATA 檔**——`music_gen` 回執的 `channel` 欄就是答案：

| 通路 | 觸發條件 | 權威檔 | `[0:00 - 0:10]` 時間戳 |
|---|---|---|---|
| FlowMusic2API | env `FLOWMUSIC2API_URL` 已配置（**現行生產主通路**） | `DATA_FLOWMUSIC_2026-09.md` | **無效**：上游把 `:` 換成空格、無任何結構控制、成品長度不受約束 |
| Gemini Lyria 直連 | 未配置時回落 | `DATA_GOOGLE_2026-07.md` | 有效（官方控件） |

FlowMusic2API 通路的硬約束（實測，詳見該 DATA 檔）：**無歌詞標籤時 style prompt 被壓成單行、上限 220 runes**；帶 `[Verse]/[Chorus]` 標籤的歌詞走保版面分支（標籤保留，但上游會自行加寫段落、產出 A/B 兩版，不是你寫什麼就唱什麼）；BPM／調性／`Instrumental only, no vocals.` 實測有效。`duration_hint=clip30` 不是真短檔（上游 `lyria-fast` 與 `lyria` 規格全等，整歌實測 162–182s）。

與 Suno 社群偽標籤（`[BPM:120]`、`[Reverb:30%]` 等所有平台都不解析的神話構造）的區分照舊：**凡該通路 DATA 檔沒實測到的控件一律不寫**。

## 使用規則

1. 音樂生成任務必先載對應 CORE 檔（寫 style 載 01、寫詞載 02、產出可疑載 03）＋對應平台 DATA 檔。
2. 不確定描述詞時查 `DATA_VOCAB.md`，選風格預設時查 `DATA_RECIPES.md`。
3. 生成前跑 `CORE_03_DIAGNOSE.md` 的 audit 檢查清單，禁止直接裸 prompt 出曲。

## 授權

SunoForge v3.0（github.com/sanic732/SunoForge）以 MIT License 發佈，本庫 verbatim 收錄並保留歸屬；每檔頭部 HTML 註釋塊記錄來源與入庫日期。
