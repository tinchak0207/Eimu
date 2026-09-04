# Kunpeng 五項對稱差 · 深度調查存檔（2026-08-27）

> 調查對象：pengfeiqiao/kunpeng v2.9.16（MIT，Tauri+React+three.js 桌面應用）。方法：5 個 subagent 並行深挖源碼 + 實跑測試。本文是 `docs/kunpeng-bridge-prd.md` 的支撐材料。

## 總覽

全部真實系統、非 demo。README 三處注水：風格「245 種」實為 161 條；審片「P0–P8」實為六類口癖；「百萬贊」無證據。開源構建預設排除內容資產（aigc-memory 素材圖），但倉庫內檔案可 clone。

| 項目 | 規模 | 真實度 | 系統本質 |
|---|---|---|---|
| 靜態資產 | index.json 440KB + 改寫器 | 測試 25/25 過 | 結構化風格四件套 + LLM 改寫鏈 |
| ASR/配音 | ~2,800 行 | 無測試、無 stub | M1-M5 五模組系統 |
| 3D 導演台 | ~7,700 行 | 零測試、零 stub | 序列化工程 + 純函數求值器 |
| AI 剪輯 | 12,991 行 | 0 測試、0 stub | FFmpeg 三段式 + 審片證據鏈 |
| Harness | 橋 1,094 + runtime 945 + Rust 1,074 | 22/22 過 | 官方包內嵌 + 雙橋架構 |

## A. 靜態資產

- `aigc-memory/style-library/index.json`：161 條風格，每條 `promptTemplate / visualDNA / cameraLanguage / promptSuffix` 四件套（無負向詞/參數）
- 消費鏈：`StyleLibraryPicker` 選風格 → `styleRewriter.ts`（DNA+鏡頭語言=system prompt，模板=輸出範例，LLM 改寫）→ 注入生圖節點
- 另有 `prompt-templates/`（seedance/kling/gpt-image-2 可執行模板）、`shot-patterns/`、`checklists/pre-generation.md`（17 條門禁）
- 開源版 tauri-build 僅在作者私建時打包 aigc-memory/skills

## B. ASR/配音系統藍圖（模型只佔一角）

```
媒體 → [M1 ffmpeg 管線] → 16kHz mono wav / COS 公網 URL
工坊 → [M4 TTS 編排] → dubbing/落盤 → trim 對齊 → 時間軸
[M2 ASR 狀態機] → Transcript{words 詞級} → [M5 審片證據鏈] → 只標記不自動剪
[M3 計費安全] 貫穿 M2/M4
```

- M1（transcribe.ts）：整軌合成一條 wav 只識別一次（atrim/asetpts/atempo/volume→concat→amix，anullsrc 靜音佔位），時間戳天然是時間軸座標；分塊 24MiB/均分/併發 2
- M2：豆包 AUC 協議（X-Api-Key 頭、X-Api-Status-Code 狀態碼 20000000/1/2、輪詢 60×3s）；結果契約 `utterances[{text, words[{w,startSec,endSec,blankMs?}]}]`
- M4：工坊逐角色 `audioPrompts[{characterId,prompt}]` → 音色 base64 參考 → `dubbing/{鏡號}-{角色}.mp3` → trim 等比例裁切對齊；文字內嵌「參考錄音N」綁 1-10 條參考 URL；輪詢 4s/10min/退避 30s
- M5 證據鏈五證據：raw 重轉寫（併發 3）、pause_pattern（詞級 blankMs，可降級）、energy_xcorr ≥0.62（純本地）、filler 本地正則、LLM 語義（批量 6×2）；詞邊界吸附 + 剪後 ±1.2s 驗證
- M3：PaidSubmissionUnknownError（禁自動重發）vs PaidTaskCreatedError（續查）；429/40001=餘額不足

**groq 移植**：唯一缺口 blank_duration → 詞間隙/silencedetect 補，審片全保。

## C. 3D 導演台

- 純函數求值器 `evaluateDirectorFrame`（playback.ts:179）：無 three 依賴，播放/離線渲染/agent 三端共用
- 白模 ref#1 閉環（finalRender.ts:44）：白模鎖構圖，prompt 明示不保留灰模材質 → gpt-image-2/seedream → seedance 成片
- 幾何健康檢查（playback.ts:230）：越軸/入地/碰撞/動作跳變
- 57 動作（三角函數關節角）+ 27 運鏡模板（球坐標 K 幀）+ 12 姿勢；四層產出：截圖/預演 MP4/分鏡圖/成片
- 15 個 director_* agent 工具（兩階段確認、導出強制手動確認）

## D. 剪輯

- FFmpeg 三段式（Pass1 歸一含曲線變速→Pass2 concat/xfade→Pass3 合成）+ Chromium worker 花字特效（逐幀 PNG→alpha.mov→overlay）；分步落盤 + hash 快取 + 成片 ffprobe 校驗門
- 審片六類：filler/repeat/pause/stutter/rambling/manual；只標記不自動剪 + 剪後邊界驗證
- renderGraph IR + renderBackends 決策器（內建 FFmpeg→native 遷移路徑）

## E. Harness

- 內嵌官方 `@deepseek-ai/dsh@0.1.0-rc.6`（199 包），fork 的 ACP 橋僅 94 行差異（image 塊支援）
- 雙橋：ACP 管會話/流 + MCP 管工具（TCP→Rust→webview ToolRegistry，保留風險確認）；取消=殺子進程
- 只讀 observer 邊車（stderr `__KUNPENG_DSH_EVENT__`）：思考/用量/壓縮事件，零改官方源碼
- visibleOutput 防重放 + MCP 媒體 6MiB 內聯預算
- 限制：官方 rc.6 不支援 session resume
