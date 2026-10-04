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

## 通路判定先於配方（2026-09-11 實測校正；2026-09-19 收錄第三通路 YuE2）

**先確認這條 prompt 走哪條通路，再決定讀哪個 DATA 檔**——`music_gen` 回執的 `channel` 欄就是答案：

| 通路 | 觸發條件 | 權威檔 | `[0:00 - 0:10]` 時間戳 |
|---|---|---|---|
| YuE2（Modal） | env `YUE2_MODAL_ENDPOINT` 已配置即啟用，**最高優先**（優先序 YuE2 > FlowMusic2API > Lyria） | 本節 YuE2 段（凍結契約真源＝`music-yue2.ts`） | **無效**：通路不認數字時間碼（規則層會剝除）；`[Verse]/[Chorus]` 段落標籤**有效**，原樣穿透 |
| FlowMusic2API | env `FLOWMUSIC2API_URL` 已配置（YuE2 未配置時的主通路） | `DATA_FLOWMUSIC_2026-09.md` | **無效**：上游把 `:` 換成空格、無任何結構控制、成品長度不受約束 |
| Gemini Lyria 直連 | 未配置時回落 | `DATA_GOOGLE_2026-07.md` | 有效（官方控件） |

YuE2 通路的硬約束（2026-09-19 收錄）：**白盒 ABC 樂譜**——回執帶 `score_abc` 欄（ABC 記譜法：`K:` 調號、`Q:` 節拍、`V: Vocal` 聲部音符序列），是 Expert 交付契約 `melody_notation` 的**真源**（有它勿自行編造音名序列，直接引用其 Vocal 聲部；`score_abc` 為 null 時才自行標注）。**無 30s 短檔**：`duration_hint=clip30` 會被工具層直接拒（如實報錯，不靜默生成整歌；要短檔走別的通路）。**失敗自動回落 FlowMusic**（工具層行為，回執會標明；Expert 不用手動換通路重試）。**一次一請求**：生成是分鐘級，禁連發多請求；style prompt 上限 **600 runes**（實作 `CHANNEL_LIMITS.yue2Style`；超限依 CORE_01 權重由低到高整層丟棄，回執的 `truncated` 如實回報丟了哪些層）。

FlowMusic2API 通路的硬約束（實測，詳見該 DATA 檔）：**無歌詞標籤時 style prompt 被壓成單行、上限 220 runes**；帶 `[Verse]/[Chorus]` 標籤的歌詞走保版面分支（標籤保留，**2026-10-03 實測為近乎逐字保留、零擴寫**：489→487 字、段落標籤全保留，一次呼叫出 181 秒完整版雙 take——同詞同 style、僅編曲／演唱不同）；BPM／調性／`Instrumental only, no vocals.` 實測有效。`duration_hint=clip30` 不是真短檔（上游 `lyria-fast` 與 `lyria` 規格全等，整歌實測 162–182s）。

與 Suno 社群偽標籤（`[BPM:120]`、`[Reverb:30%]` 等所有平台都不解析的神話構造）的區分照舊：**凡該通路 DATA 檔沒實測到的控件一律不寫**。

## 樂譜編輯與翻唱工作流（2026-09-19 收錄；官方 agentic editing 語義，真源＝YuE2 repo docs/editing.md・docs/covers.md）

以下能力**只在 YuE2 通路成立**（其他通路不認 ABC，勿套用）。編輯樂譜時的合法 ABC 記法真源＝`references/yue2-abc-editing.md`（官方 `skills/yue2-music/references/abc-editing.md` Apache-2.0 verbatim 入庫），改譜前必查。

### 編輯循環（改既有歌曲：換和聲、改段落、二次精修）

1. **生成取譜**：`music_gen` 走 YuE2 通路（cot=full），回執 `score_abc` 即白盒樂譜——音符、和弦、速度、段落順序全部可讀可改。旋律骨幹引用它，勿自行編造。
2. **有界編輯**：改 ABC 前先寫一個短的改動契約：哪些聲部、段落、旋律音高、節奏、歌詞、速度是**固定**的，哪些可以動。編輯必須守住不變量（官方原文，逐字）：**vocal/instrumental 旋律音符、時值、小節線、段落順序、tempo——除非顯式宣告改 tempo**。不許無邊界地「給我改好聽一點」。
3. **重渲染**：改完的 ABC 經 `music_gen` 帶 `abc`＋`cot_mode="full"` 重新渲染成新錄音（同一生成器，樂譜即編輯介面）。
4. **新版本保存對比**：每次編輯產出**新版本**，原版保留（官方：每次編輯存新版本、原版不覆蓋）；回執的 `abc_sha256`（上游 artifacts[] 中 score.abc 的 sha256）可對版本溯源，逐版本記下改了什麼。

### 翻唱循環（cover：同旋律骨架，新風格/新歌詞/新語言）

1. **取旋律骨架**：從 `score_abc` 取旋律（或官方 SheetSage2 扒譜路徑；扒譜錯誤會帶進 cover，用前先審查旋律）。
2. **chord-free ABC**：`cot_mode="melody"` 模式下旋律骨幹來自 abc、伴奏自由適配新風格；**melody 模式不自動剝和弦，要 chord-free abc**——帶引號和弦符號的 abc 須先剝除和弦再送。
3. **重渲染**：`music_gen` 帶 chord-free `abc`＋`cot_mode="melody"`＋新 style＋新歌詞。**歌詞要對齊旋律的音節數與段落**（換語言時按演唱適配改寫，勿逐字直譯）；不保留原歌手音色/波形。

### 誠實條款（官方原文語義，逐條適用）

- **樂譜匹配 ≠ 相同演唱/音色**：改完重渲染，波形會變，同一份樂譜兩次渲染也不是同一錄音；驗收要**聽成品對比**（尤其被改的小節與其銜接），不是只看樂譜匹配。
- **每版本獨立保存**：源 ABC、編輯後 ABC、style、歌詞、音頻逐版本留檔，禁止只留最終版。
- **編輯 brief 有界**：無不變量契約的編輯請求＝不可驗收，先補契約再動刀。

## 多版本偏好闸（2026-10-03 收錄）

**多版本偏好闸**：`music_gen` 回执带 `preference_question` 字段时——`asked: true` 必须立刻用 `question` 工具把它抬给用户，`question`/`header`/`options` **逐字照抄**回执字段，不得改写、不得增删选项（`都不行，重写` 与 `你替我定` 两条退路已在 options 内）；拿到答复后，用回执里的 `optionTakeUrls`（label → url）把选中的 label 翻译成对应的音频 URL 作为定版，并在交付说明里写明「用户选定的版本」。`asked: false` 时**不要**弹卡，直接采用 `suggestedIndex` 指向的那一版（索引对齐 `audios[]`），并在交付说明里用 `entropy.reason` 的一句话解释为什么不问。

- 每个 take 的音频已随 `audios[]` 各自发一张带播放器的音档卡（`audio.done`），问题卡只**指认**版本（选项 label A/B 对应 take），真正的音档对照靠回执里的 `optionTakeUrls`（label → url）；**禁止**试图把音档塞进 `question` 选项（选项只带 `{label, description}` 文字）。
- `preference_question` 只在 `audios.length >= 2` 时在场；单 clip 回执不含此字段，无需处理。

## 使用規則

1. 音樂生成任務必先載對應 CORE 檔（寫 style 載 01、寫詞載 02、產出可疑載 03）＋對應平台 DATA 檔。
2. 不確定描述詞時查 `DATA_VOCAB.md`，選風格預設時查 `DATA_RECIPES.md`。
3. 生成前跑 `CORE_03_DIAGNOSE.md` 的 audit 檢查清單，禁止直接裸 prompt 出曲。

## 授權

SunoForge v3.0（github.com/sanic732/SunoForge）以 MIT License 發佈，本庫 verbatim 收錄並保留歸屬；每檔頭部 HTML 註釋塊記錄來源與入庫日期。
