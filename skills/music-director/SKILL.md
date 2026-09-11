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

## Lyria 3.5 優先原則

Eimu 音樂主線走 Lyria 路線。寫 Lyria prompt 時以 `DATA_GOOGLE_2026-07.md` 為權威：**時間戳結構 `[0:00-0:10]` 與 `[Verse]` 等段落標籤是 Lyria 官方真實控件**（有廠商文檔背書），與 Suno 社群偽標籤（`[BPM:120]`、`[Reverb:30%]` 等所有平台都不解析的神話構造）嚴格區分。Lyria 3.5 另支援 image-to-music（≤10 圖）與 BPM/調性自然語言控制；30s 片段走 `lyria-3-clip-preview`。平台行為以該 DATA 檔快照為準，衝突時以官方文檔實測為準。

## 使用規則

1. 音樂生成任務必先載對應 CORE 檔（寫 style 載 01、寫詞載 02、產出可疑載 03）＋對應平台 DATA 檔。
2. 不確定描述詞時查 `DATA_VOCAB.md`，選風格預設時查 `DATA_RECIPES.md`。
3. 生成前跑 `CORE_03_DIAGNOSE.md` 的 audit 檢查清單，禁止直接裸 prompt 出曲。

## 授權

SunoForge v3.0（github.com/sanic732/SunoForge）以 MIT License 發佈，本庫 verbatim 收錄並保留歸屬；每檔頭部 HTML 註釋塊記錄來源與入庫日期。
