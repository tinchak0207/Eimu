---
name: editor
description: 剪輯域 Expert 配方庫總入口。觸發時機：時間線編排／剪切／轉場／節奏卡點／混音 ducking／調色／母帶質檢導出／時間線回退（taskTypes editing / timeline / cut / film_assembly）。剪輯任務必載本庫，禁止憑記憶手搓 ffmpeg 或臆測時間線狀態。
---
<!--
來源（輪子）: 自有配方（非第三方輪子）。內容依據我方後期製建設既有盤面，非憑空編寫：
              docs/timeline-post-production-plan.md §2 拆片表（B1-B7）與 §7 全役完結；
              記憶 2026-08-31-b1-timeline-lifecycle-layer、timeline-post-production-buildout-0831、
              timeline-b1-b3-harness-training-e2e。
工具真源: VPS /opt/agent-harness/workspace/.opencode/tools/timeline_*.ts（本地
           src/lib/harness-tool-registry.ts 只登記 id，handler 不在本 repo）。
入庫批次: 2026-09-27 剪輯域 Agent 能力面活化（補 editor-persona skillPaths 待補項）。
-->

# Editor — 剪輯師配方庫（時間線後期全鏈）

本目錄是剪輯域 Expert 的 must-load 配方庫。目標：把「素材進來到成片交出」整條鏈**全部經 timeline 工具**完成，禁止用 `run_py` + ffmpeg 手搓繞過封裝工具（繞道會丟版本／決策日誌／計費對帳，且 lint 閘門失效）。

## 硬規則（先於一切）

1. **狀態唯一真源 = 時間線 JSON（per-session）**。任何變更前先 `timeline_query(what=state)` 摸底，變更後回讀 diff；**禁止憑記憶猜剪輯點或剩餘時長**。
2. **多步變更同批原子**：`timeline_ops` 一次帶整批指令，整批先驗證後套用；分批亂發會造成中間態與版本錯亂。
3. **`timeline_lint` 是閘門不是可選項**：must 級未清**不得交付、不得導出**。`timeline_master` 的 export 會被 must 級 block 直接 400 拒，這是機器層硬閘（VPS `gateway/master.ts`）——先過 lint 再談交付。
4. **語義層誠實 unsupported**：越軸／動作連續性／光不一致／角色臉一致性／口型同步／運動追蹤特效／fxComponents 花字農場 = 本鏈不支援，遇之如實標註，禁硬造結果。
5. **一次一變更意圖**：工具是分鐘級上游（TTS／導出）時禁連發；單次 `timeline_ops` 內聚合，不開並發。

## 十件套路由表（什麼場景 → 調哪支 → 輸入什麼 → 交付什麼）

| 場景 | 工具 | 輸入 | 交付 |
|---|---|---|---|
| 素材進入剪輯（視頻／音頻上傳進 gateway 會話） | `video_upload` | 本地檔或 URL + session | 素材可在後續 ops 中引用的引用 |
| 生成剪輯清單（EDL／manifest，語義層交底） | `editing_manifest` | 素材引用清單 + 剪輯意圖 | manifest（素材→鏡頭→順序的顯式清單） |
| 摸底時間線狀態 | `timeline_query` | `what=state` | clips／時長／版本號／決策日誌 |
| 落軌與批量編排 | `timeline_ops` | 整批 op（add/remove/reorder/trim/split/speed/lock/unlock/group/ungroup/set_transition/set_meta/add_audio/add_subtitle/set_aspect） | 新版本 + diff |
| 旁白／解說先行（先定音軌，再對齊畫面） | `audio_first_timeline` | 逐行文稿或音頻 | 真 TTS + ffprobe 實測時長 + 累計 offset_ms 錨點時間線 |
| 節奏體檢與卡點 | `timeline_rhythm` | 時間線（可帶情緒曲線軟輸入） | curve + flags（must/should）+ climax |
| 信號層質檢（黑幀／白閃／爆音／靜音段／音量跳變／音畫時長錯位） | `timeline_lint` | 時間線 | must/should 分級報告（**閘門**：must 未清不得交付） |
| 混音層（voice/bgm/sfx 三軌 + ducking + 響度報告） | `timeline_mix` | 時間線 + 分軌筆記 | 混音後時間線 + 響度報告 |
| 風格層（濾鏡四滑桿／轉場／字卡 ASS） | `timeline_style` | 時間線 + 風格檔 | 套用風格後時間線 |
| 母帶質檢與成片導出 | `timeline_master` | 時間線 + 預設（9:16／16:9／2.39:1／封面幀） | check 報告；must 未清 export 拒；過閘後成片 URL + 版本號 + 小結 |
| 時間線回退 | `timeline_restore` | 目標版本號 | 內容回退該版本（版本號單調遞增，歷史不刪） |

## 四條標準鏈路（照走，勿自拼）

1. **素材平剪成片**：`video_upload` →（`editing_manifest`）→ `timeline_query` 摸底 → `timeline_ops` 落軌與剪切 → `timeline_lint` 過閘 → `timeline_rhythm` 節奏修正 → `timeline_mix` → `timeline_style` → `timeline_master` check → export。
2. **旁白先行**：`audio_first_timeline` 定音軌與 offset 錨點 → `timeline_ops` 依錨點對齊畫面 → `timeline_lint` → `timeline_master`。
3. **節奏卡點**：`timeline_query` → `timeline_rhythm` 取 flags/climax → `timeline_ops` 依 flags 修（只修 clip_id 明確的 must/should）→ `timeline_rhythm` 複驗。
4. **返工回退**：`timeline_restore` 回目標版本 → `timeline_query` 確認 → 重編。

## 隔離條款（回傳契約）

只回**交付物契約**三欄（`timeline_ops` / `duration_sec` / `qc`）＋ `edit_summary`（≤500 token）。試剪中間態、逐次 lint 報告、多輪痕跡**不出子代理**。`qc` 必須是 `timeline_lint`／`timeline_master` 的真實質檢結論，缺 qc 的回執＝未交付（站點側 `editor-delegate.ts` collect 閘門直接判 `missing_deliverables`）。

## 子配方索引

| 子目錄 | 主題 | 對應工具鏈 |
|---|---|---|
| `assembly/SKILL.md` | 素材入軌與時間線編排 | `video_upload` → `editing_manifest` → `timeline_query` → `timeline_ops` → `timeline_restore` |
| `audio-first/SKILL.md` | 旁白先行時間線 | `audio_first_timeline` → `timeline_ops` → `timeline_lint` |
| `rhythm/SKILL.md` | 節奏卡點與體檢 | `timeline_query` → `timeline_rhythm` → `timeline_ops` → `timeline_rhythm` |
| `look/SKILL.md` | 風格與調色 | `timeline_style` → `timeline_lint` |
| `mix/SKILL.md` | 混音與 ducking | `timeline_mix` → `timeline_lint` |
| `qc-master/SKILL.md` | 質檢閘與母帶導出 | `timeline_lint` → `timeline_master` |

## 授權

自有配方，無第三方授權義務。工具鏈執行碼真源在 VPS `/opt/agent-harness`（`gateway/timeline.ts` + `gateway/lint.ts` + `gateway/mix.ts` + `gateway/style.ts` + `gateway/master.ts` + `.opencode/tools/timeline_*.ts`）。
