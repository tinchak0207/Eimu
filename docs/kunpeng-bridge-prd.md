# Kunpeng 資產包橋接 PRD（輪子釘版）

> 狀態：草案 · 2026-08-27
> **讀取規則（寫死）**：每個 spec 的第一欄是「輪子釘」= 能力的源代碼在 kunpeng 倉庫的**確切檔案路徑**。實現 = 複製該檔全文到目標路徑，只改白名單欄位。**任何 spec 找不到輪子釘 = 不許開工，先回查**。禁止從零實現任何輪子釘指向的能力。

## 0. 暴君主線（目標，一句話/包）

一條 30 秒口播短劇：現在暴君要過 7 站（拆劇本半天、風格試錯 7 輪、配音排期 2 小時、剪輯 4 小時）；接入後 = 一句話 → 工坊自動拆 → 風格一鍵 → 自動配音對齊 → 審片標記 → 暴君只在「確認」與「審美」下車。技術細節見附錄，**spec 表是唯一施工依據**。

---

## 1. 包 A：風格資產（P0）

| Spec | 輪子釘（kunpeng 源檔） | 複製到（我們） | 白名單（只准改這些） | 判定 |
|---|---|---|---|---|
| A1 風格資產載入 | `aigc-memory/style-library/index.json`（440KB，161 條四件套：promptTemplate/visualDNA/cameraLanguage/promptSuffix）+ `src/lib/styleLibrary.ts`（TS 型別與載入） | `vendor/kunpeng/style-library/` 原樣 + 我們 loader | 無（資料契約一行不動） | diff 等價；161 條全量載入 |
| A2 風格→提示詞改寫 | `src/lib/styleRewriter.ts`（DNA+鏡頭語言=system prompt，模板=輸出範例，走 LLM 改寫） | `src/vendor-bridges/style/` 原樣 | LLM 呼叫端點/金鑰注入點 | diff 除白名單逐行等價；試錯輪數 ≤1 |
| A3 風格卡 UI | `StyleLibraryPicker.tsx`（分類頁籤+搜尋+onApply 交互） | 掛載到工作台 | 事件匯流排名稱、import 路徑 | 交互邏輯 diff 等價 |
| A4 提交前門禁 | `aigc-memory/checklists/pre-generation.md`（17 條規則） | 內容原樣複製；轉 agent 門禁規則 = 橋層改編 | 只准轉格式，不准改規則語義 | 17 條逐一對應 |

**禁造**：風格四件套結構、改寫 prompt 結構（三段式）、UI 交互邏輯。

## 2. 包 B：ASR/配音（P0，渠道 = groq）

| Spec | 輪子釘（kunpeng 源檔） | 複製到（我們） | 白名單（只准改這些） | 判定 |
|---|---|---|---|---|
| B1 音訊管線 M1 | `src/lib/editor/transcribe.ts`（460 行：整軌 filter_complex 合成、`anullsrc` 靜音佔位、16kHz mono、分塊 24MiB/均分/併發 2、`-ss` 快速 seek） | 後端 worker `src/vendor-bridges/audio/` | ffmpeg 路徑注入、COS 端點 | diff 等價；時間戳 = 時間軸座標 |
| B2 ASR 結果契約 | `src/lib/doubaoAsr/client.ts` 的結果形狀 `utterances[{text,words[{w,startSec,endSec,blankMs?}]}]`（型別照搬；提交協議換 groq 同步化） | 同上 | 端點/認證頭；**結果契約形狀禁改** | groq 返回映射後契約逐欄等價 |
| B3 TTS 編排 M4 | `src/lib/kuaizi/seedAudio.ts`（克隆標記「參考錄音N」、輪詢 4s/10min/退避 30s、429/40001 餘額映射）+ 工坊 `generate.ts` 的逐角色落盤（`dubbing/{鏡號}-{角色}.mp3`）+ `trim.ts`（等比例裁切 min 0.1s） | 後端 worker | 供應商端點/金鑰（渠道註冊進 supplier registry） | diff 等價；落盤結構與對齊行為一致 |
| B4 審片證據鏈 M5 | `src/lib/editor/speechAudit/`（1,005 行：engine/audio/verify/prompt/types——五證據、詞邊界吸附、剪後 ±1.2s 驗證、只標記） | 後端 worker | LLM 判定走我們網關（注入點） | diff 等價；證據鏈五種全保 |
| B5 波形/節拍 | `src/lib/editor/waveform.ts`（50 桶/秒+快取）+ `beatDetect.ts`（能量閾值） | 同上 | 無 | diff 等價 |
| B6 計費安全 | **不搬代碼**：kunpeng 的 M3（PaidSubmissionUnknown/PaidTaskCreated）語義由我們三階段計費覆蓋 | — | — | 無重複扣費（現有測試） |

**禁造**：filter_complex 合成鏈、分塊算法、輪詢/退避/併發數值（2/3/6×2/4s/10min/30s）、證據鏈判定邏輯、結果契約。

## 3. 包 C：3D 導演台（P1，白模→分鏡先行）

| Spec | 輪子釘（kunpeng 源檔） | 複製到（我們） | 白名單（只准改這些） | 判定 |
|---|---|---|---|---|
| C1 導演工程契約 | `src/lib/director/types.ts`（v2 序列化 schema） | `src/vendor-bridges/director/` | 無 | diff 等價 |
| C2 純函數求值器 | `src/lib/director/playback.ts` 的 `evaluateDirectorFrame`（:179-221，無 three 依賴）+ `inspectDirectorPlan`（:230-302 幾何健康檢查） | 同上 | 無 | diff 等價；播放/離線/agent 三端共用 |
| C3 素模/姿勢/鏡頭/動作 | `mannequin.ts`（11 關節）+ `poses.ts`（12 姿勢）+ `presetCameras.ts` + `cameraTemplates.ts`（27 運鏡）+ `motionTemplates.ts`（57 動作）+ `pathCurve.ts` | 同上 | 無 | diff 等價 |
| C4 生成閉環 | `src/lib/director/finalRender.ts`（白模 ref#1、prompt「不保留灰模材質」結構）+ `export.ts` | 同上 | 生圖/影片渠道注入（我們供應商） | 閉環行為一致 |
| C5 agent 工具 | `src/lib/agent/tools/directorTools.ts`（15 個 director_* 工具：id/入參/出參/兩階段確認/導出強制手動確認） | 註冊進我們 AgentToolRegistry | 事件名/artifact 映射 | 工具 id 與契約照搬 |
| C6 UI | `DirectorStage.tsx`（2,625 行） | 掛載工作台（three.js 瀏覽器原生） | 存儲適配（工程 JSON 落我們存儲） | 交互邏輯 diff 等價 |

**禁造**：素模骨骼/姿勢/運動生成、球坐標鏡頭、求值器、健康檢查規則、工具契約。

## 4. 包 D：剪輯審片（P1 審片 / P2 渲染）

| Spec | 輪子釘（kunpeng 源檔） | 複製到（我們） | 白名單（只准改這些） | 判定 |
|---|---|---|---|---|
| D1 審片 | **與 B4 同一個輪子**（speechAudit/）——不寫第二份 | 見 B4 | 見 B4 | 見 B4 |
| D2 渲染引擎 | `src/lib/editor/composeEngine.ts`（1,173 行 FFmpeg 三段式+快取+ffprobe 校驗門）+ `fxRender.ts`（1,199 行 Chromium worker 特效）+ `renderGraph.ts`（IR+後端決策器） | P2 立項，worker 農場 | 渲染後端選擇（native/FFmpeg） | 成片強制 probe 校驗 |

**禁造**：Pass1/2/3 渲染鏈、花字逐幀管線、校驗門。

## 5. 包 E：Harness（觀望）

不排期。可偷設計點（雙橋/邊車/visibleOutput 防重放）已記入網關 backlog，spec 待官方 dsh 穩定後補釘（輪子 = `src/lib/agent/dsh/` + `dsh-runtime/`）。

---

## 附錄 A：Vendor 規則（執行時強制）

- 源：pengfeiqiao/kunpeng，pin commit `872a58b`（2026-08-27）；調查存檔 `docs/2026-08-27-kunpeng-symmetry-survey.md`
- 複製 = 整檔複製，白名單之外一行不許改；每筆白名單改動記 `vendor/kunpeng/PATCHES.md`（檔:行 → 改前/改後 → 理由）
- 驗收門：`git diff` 對照源倉庫，過濾白名單後逐行等價；不等價 = 沒做完，不許交貨
- 掛載點：`AgentToolRegistry.register()`（擴展點已有測試）；產出走 `canvas.ops`；計費走三階段；B 端 `/v1/audio/transcriptions`（verbose_json 帶詞級）+ `/v1/audio/speech`
- 風險：MIT 合規（THIRD-PARTY-NOTICES 追加）；素材圖商用前確認授權（index.json 文字無礙）；groq 缺 blank_duration → 詞間隙/silencedetect 降級（kunpeng 現成 fallback，不新發明）
