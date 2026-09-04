# AI 自主後期全包 —— 施工拆片方案（Timeline Post-Production）

日期：2026-08-31｜裁定：暴君「能用的輪子全部用上，所有 REQ 盡量達成，語義層妥協項除外，逐片派 subagent 避免上下文污染」
需求源：《Eimu 創作 Agent · 剪輯體驗需求文檔 v1.0》（REQ-EDIT-01..08）
輪子源：`/home/lenovo/Desktop/kunpeng-vendor` @ pin **872a58b**（`src/lib/editor/` 8,795 行 + `src/lib/agent/tools/timelineTools.ts` 69 工具 3,997 行 + `src/stores/editorStore.ts` 1,317 行）

## 0. 現狀基線（實查，非記憶）

- Kunpeng 橋接片 0-6 **全部完成上線**：VPS `/opt/agent-harness/gateway/editor/` 已掛載，`assembleFilmNode`（gateway/index.ts L1463）真跑成片（08-30 夜 E2E：final.mp4 18.58s 含 AAC 音軌）。
- 已入庫輪子（gateway/editor/ 與 image-app src/vendor-bridges/editor/ 同構）：composeEngine.ts、renderGraph.ts、adapter/{editorStore,tauri-adapter,fxRenderStub,artifactsStub}.ts、canvas/videoCompose.ts、aspect.ts、presets/{filterPresets,transitionPresets}.ts、subtitleExport.ts、renderBackends.ts。
- composeEngine 內建：`loudnorm=I=-16:TP=-1.5:LRA=11`、per-clip volume/afade/adelay/amix、xfade 轉場、ASS 字幕。**無 ducking（僅靜態 volume）、無版本持久化、無時間線 HTTP 面**。
- 白名單記賬：`vendor/kunpeng/PATCHES.md`（改輪子必記，供 vendor 升級雙向 diff）。

## 1. 架構決策（定死，subagent 不得改）

1. **時間線真源 = gateway 側 per-session JSON store**：新檔 `/opt/agent-harness/gateway/timeline.ts`，與 composeEngine 同進程（setHarnessState 零跳）。存檔路徑 `$WORKSPACE_DIR/timelines/<session_id>.json`。
2. **Agent 工具面 = VPS `/opt/agent-harness/workspace/.opencode/tools/timeline_*.ts`**：複製現有 `workflow_connect.ts` 輪子模式（站內 HTTP + agentFetch 鑑權頭）；**Bun Request body 只能讀一次 → session_id 走 query**。
3. **端點族 = `/agent/v1/timeline/*`**（gateway 新增路由，鏡像既有 `/agent/v1/tts` 模式）。
4. **輪子紀律**：類型/算法逐行 cp，import 行與注入面白名單改寫，偏差進 PATCHES.md。替身（B 類）同簽名誠實拋錯。
5. **妥協清單（暴君已批准，實作遇之誠實 unsupported，不硬造）**：
   - 情緒曲線硬指標 → 接受 agent 標註的 `emotionTag` 序列作軟輸入，缺失降級時長/密度分析
   - 越軸/動作連續性/光不一致/角色臉一致性語義 lint → unsupported（研究問題）
   - 運動追蹤特效 → 降級為靜態/關鍵幀定位疊層
   - 口型同步 → 不屬剪輯層，不做
   - fxComponents（Chromium 花字農場）→ 不做，風格走 ffmpeg 原生子集
   - 音樂/SFX 素材源 → 接受 URL 輸入，不建音樂庫（PRD 自標非目標）
   - 幀級精度 → 秒級浮點（與輪子 EditorClip 一致）

## 2. 拆片表（串行派發，併發=1；每片檔案所有權零交集）

| 片 | REQ | 內容 | 輪子源（kunpeng-vendor） | 目標檔（所有權） | 時間預算 |
|---|---|---|---|---|---|
| **B1** | 01+05 | 時間線資料對象+ops+版本+決策日誌+HTTP 端點 | `src/stores/editorStore.ts` 型別塊（EditorClip L54/AudioClip/SubtitleCue/OverlayClip 逐行）；`src/lib/editor/editorHistory.ts` 快照模式；`timelineTools.ts` ops 語義對照 | VPS `gateway/timeline.ts`（新）+ `gateway/index.ts`（掛路由小 diff） | 90min |
| **B2** | 04 | opencode 工具族：timeline_ops/query/versions（9 類指令：插入/刪除/移動/拆分/修剪/變速/鎖定/分組/改序 + 查詢 + 回讀 diff + 鎖定攔截） | `timelineTools.ts` 對應工具的參數 schema 與返回形態 | VPS `.opencode/tools/timeline_ops.ts`、`timeline_query.ts`、`timeline_versions.ts`（全新檔） | 60min |
| **B3** | 02 | 節奏計算器：analyze_rhythm → curve+flags+climax（規則版：avg_shot_len/dialog_ratio/density/鼓點） | `src/lib/editor/waveform.ts`（PCM 峰值）+ `beatDetect.ts`（能量包絡踩點）逐行；transcriptOps 密度口徑對照 | VPS `gateway/rhythm.ts`（新）+ `.opencode/tools/timeline_rhythm.ts`（新） | 90min |
| **B4** | 03 | 信號層 linter：黑幀/白閃/爆音/靜音段/音量跳變/音畫時長錯位（ffmpeg blackdetect·freezedetect·astats·silencedetect）；must/should 分級；語義層誠實跳過 | `speechAudit/audio.ts` 停頓檢測降級版（silencedetect 路徑）；其餘 ffmpeg 命令新寫 | VPS `gateway/lint.ts`（新）+ `.opencode/tools/timeline_lint.ts`（新） | 90min |
| **B5** | 06 | 混音增強：三軌（voice/bgm/sfx）+ **ducking（sidechaincompress 後置 pass，不動 composeEngine 主釘）** + 響度報告 | `composeEngine.ts` 音頻圖口徑對照（不 import 改動）；ffmpeg sidechain 命令 | VPS `gateway/mix.ts`（新）+ `.opencode/tools/timeline_mix.ts`（新） | 60min |
| **B7** | 08 | 風格貨架 ffmpeg 子集：apply_style（filterPresets→clip.filter 四滑桿）、轉場（transitionPresets 已在庫）、字卡（subtitleExport/ASS）；fx/追蹤 unsupported | `presets/filterPresets.ts`（已入庫）、`presets/textTemplates.ts` 子集 | VPS `gateway/style.ts`（新）+ `.opencode/tools/timeline_style.ts`（新） | 60min |
| **B6** | 07 | 母帶檢查+導出閘：check(timeline)=時長/解析度/畫幅+聚合 B4 lint+B5 響度；must 未清拒導；預設 豎9:16/橫16:9/影院2.39:1/封面幀；交付物=URL+報告+版本號+小結欄位 | `composeEngine.ts` `probeRenderedVideo`（已在庫）+ `EXPORT_RESOLUTIONS`（已在庫） | VPS `gateway/master.ts`（新）+ `.opencode/tools/timeline_master.ts`（新） | 60min |

依賴：B1 → B2 →（B3→B4→B5→B7 串行）→ B6（聚合 B4/B5 結果，最後上）。

## 3. 驗收總門（全片完成後）

端到端：agent 在真實 session 用語言完成「建時間線→剪→節奏報告→lint→混音→風格→母帶檢查→導出」，產物 ffprobe 實測（時長/解析度/響度），版本 diff/restore 可用，決策日誌含成本。構造樣本（黑幀/爆音片段）must 級檢出 100%。

## 4. 部署配方（每片通用，寫進 spec）

- 傳檔：`scp -S "$SSH_BIN" -i /home/lenovo/.ssh/new.pem -P 22443 <本地> ubuntu@43.172.85.76:<遠端>`（本機 ssh 用 flatpak 路徑 `/var/lib/flatpak/runtime/org.freedesktop.Platform/x86_64/25.08/*/files/bin/ssh|scp`；**scp 必帶 `-S $SSH_BIN`**，否則內部 exec `/usr/bin/ssh` 不存在直接失敗——0831 B1 實測坑）
- **gateway/index.ts 是 root:root 644**（目錄 ubuntu 擁有）：改法＝`cp` 到 /tmp → python 錨點插入 → `mv` 覆蓋回原位（rename 只需目錄寫權）；直接 in-place 寫會 PermissionError（0831 B1 實測坑）
- gateway 改動生效：`sudo systemctl restart agent-gateway`；驗 `systemctl is-active` + `journalctl -u agent-gateway -n 20 --no-pager` 零錯
- opencode 工具新增生效：**必重啟 opencode-server**（既有記憶坑）
- 撿核對：改 gateway/index.ts 前先 `grep -n` 錨點行號，VPS 真源比本地 HEAD 新，單向回灌會沖掉修復
- **`.opencode/tools/` 目錄 root:root**：scp 直上 Permission denied → `scp` 到 /tmp 再 `sudo install -m 644 <tmp> <dst>`（0831 B2 實測坑）
- **session_id 契約（0831 B2 卡點+B1 修復，後續片必知）**：opencode 工具的 `context.sessionID` 是 **opencode id**（`ses_…`），非 gateway UUID。`handleTimelineRoutes` 已改用 `resolveSession(sid)` 三段解析 + `state.apiKey !== key` 校驗 + 收攏 `sid = state.sessionId`（鏡像 `canvasKeyFor` 原則）。**後續 B3-B7 新端點一律掛進 `handleTimelineRoutes` 內部**（繼承鑑權與 id 收攏），別另起爐灶。gateway↔opencode id 映射可查 `sessions.db` 表 `sessions(id, owner_key, opencode_session_id)`
- 工具面 op 形態映射：agent 發 `{op, clip_id, clip_ids, to_index}`，工具內 `normalizeOp` 轉 gateway 原生 `{type, clipId, clipIds, toIndex}`——端點直打冒煙時要發原生形態，勿誤打工具形態（0831 B2 實測坑）

## 5. 派工紀律

- 每片 spec 開頭「預期 N 分鐘」，超 2x orchestrator TaskStop 接管
- 同一錯誤重試 2 次未過 → 停，回報事實
- secret 不落 log/commit；驗收要 ffprobe/curl 實證，HTTP 200 ≠ 可用

## 6. 外部高 star 輪子調研結論（08-31 暴君糾偏後補掃，GitHub API 實查）

| 倉庫 | 星數/授權 | 對照結論 |
|---|---|---|
| OpenCut-app/OpenCut | 88k/MIT 活躍 | UI 輪子（CapCut 替代），P1 明確不做 UI；且會造成第二套時間線真源打架 → **不引入** |
| remotion-dev/remotion | 57.8k/NOASSERTION 活躍 | React 程序化視頻=字卡/花字動畫正解路線（補 fxComponents Chromium 缺口）；授權對商業有約束+VPS 2 核算力 → **增強片 B9 候選（記檔不落地）** |
| WyattBlue/auto-editor | 5.1k/Unlicense 活躍 | 自動剪靜音/dead space 成熟決策器，可 `--export` 時間線 XML 不渲染 → **增強片 B8：dead_air 自動修復**（B4 檢出→auto-editor 出切割點→timeline_ops 落地），主鏈閉環後做 |
| adefossez/demucs | 3.1k/MIT | 音源分離 4 軌/`--two-stems=vocals`——成品素材側鏈分離的殺手鐧；VPS 2 核 4G RAM 推理吃緊 → **增強片 B10 候選** |
| soCzech/TransNetV2 | 1k/MIT 2023 停更 | 鏡頭邊界 AI 檢測；無 GPU 環境 → 記檔不落地 |
| LUT 集合庫 | 搜索無高 star 乾淨庫 | B7 風格庫走 ffmpeg 內建 eq/curves/colorbalance + filterPresets 手調曲線（kunpeng 原路），LUT 文件後續人工收集 |

**紀律**：B1-B5 已閉環上線不重做（接續攻堅）；增強片 B8/B9/B10 排在 B6/B7 之後，暴君點名才派。

## 7. 全役完結（2026-08-31 凌晨）

**B1-B7 七片全部上線閉環，PRD 8 REQ 對賬達成**（語義層五項 lint + fxComponents 花字 + 口型同步 = 誠實 unsupported，見 §4 妥協清單）。

- 工具面 8 個：`timeline_query / ops / lint / rhythm / mix / style / restore / master`
- 端點族：`/agent/v1/timeline/*`（ops/get/versions/restore/lint/rhythm/mix/style/style/subtitles.ass/master check+export）
- 終驗：B5 mix 13/13、B7 style 14/14、B6 master 14/14（含負向閘：聲明>源實測 → av_mismatch must → export 400）+ 三片真 agent E2E 自主調用成功；六檔 md5 本地/VPS 一致
- 派工事故：subagent 三連死 "Model request failed"（配額）→ B5/B6/B7 內聯接管完成
- 關鍵坑沉澱：ffmpeg filtergraph（link label 帶冒號=stream specifier／label 單次消費 asplit／-map 逐輸出）、ebur128 只解析 lastIndexOf("Summary:") 後、duck 基準窗掃無人聲區、視頻鏈禁 apad（→trim=duration）、**opencode 工具新增必 restart opencode-server**（transcript 含工具名 = 假陽性，真判據 = `"tool":"<名>"` 調用 part）
