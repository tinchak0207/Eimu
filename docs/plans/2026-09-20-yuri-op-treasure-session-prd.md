# 百合番 OP 會話寶藏挖掘 PRD（喚醒鏈·能力卡·對位真源）

> version: 1.0（2026-09-20）
> 定性：【能力建設】——保守修復紀律不適用；刀 1/刀 2 動 gateway 生產件，遵守 scp→diff→`deploy.sh` 慣例，**只重啟 gateway 不碰 opencode-server**。
> 證據源：eimu.dev 生產會話 `ses_f47dc630effeDRKL3e9nkcDsMH`（2026-09-19 全程 289 則，opencode DB）＋ VPS `outputs/subagent/` 落盤交付。挖掘定案見 memory `yuri-op-treasure-session-mining-0920.md`。

## 0. 一句話終態（可度量）

從該會話暴露的六個斷層中，把「靠 subagent 現場撞牆才能發現」的資訊（成品在不在、模型能吃多長的 prompt、真源音頻什麼節奏）全部前移為機器層可查、可閘、可預檢的靜態資料，換模/補生/裝配三類高頻操作不再產生「等了一小時才知道產物早就好了」或「提交前才知道 prompt 超限」。

量化指標：

| 指標 | 現狀（該會話實錘） | 終態 |
|---|---|---|
| subagent 產物落盤但喚醒丟失 | 裝配方案 23:19 落盤，用戶等 ~1h 才知道 | not_found 回應必帶落盤路徑探測結果 |
| 模型 prompt 上限/時長檔/計費口徑 | subagent 提交前實測才知 4000 上限/無 30s 檔/28 幣每秒 | 派遣前機器預檢（capability gate），不符即拒派並改派 |
| 音畫對位基準 | 設計 176 BPM vs 實產 169.73 BPM，對位表全作廢 | 卡點對位表生成前必須吃實測 BPM，偏差 >1% 即標記 |
| 換模後任務書記憶 | compaction 後照抄舊 spec 數字（721 幣/30s 檔） | spec 內計費/檔位數字由機器按當前模型注入，不落死字 |

## 1. 實測基線（該會話原始證據，勿重跑）

- `seedance-2.5-720p`：prompt 上限 **4000 字元**（4000→202、4001→400 `prompt_too_long`）；**28 幣/秒**、時長上限 **29s 無 30s 檔**；`last_24h=null` 仍標 available。
- 條1（S01–S04）六槽逐字拼裝 **4861 字元**（風格錨 ~340 字元 ×4 鏡 = 1360 為超限主因，且任務書禁改）；條3a 3703 / 條3b 3559 可過。
- 音頻真源（`media-1789821225748-t6qbpy.m4a`，150.4854s）實測 **≈169.73 BPM**（自相關精修 169.728 / comb-filter 169.900），非規格 176；無可量測サビ能量台階。
- 喚醒鏈：裝配方案落盤 `outputs/subagent/deepseek-v4.1-flash-潮汐繡線OP装配方案.md`（29.6KB/408 行），`subagent_status` 返回 not_found（run 記錄過期）但產物在盤上。
- 已修勿重做：402 歸因謬誤（shuai 欠費人話表，0919 三刀已上線）；B key 綁 117（biz-key-binding-fix-117-0919）。

## 2. 建設能力（三刀）

### 刀 1 subagent 產物探測兜底（gateway，最小刀）

- **痛點**：喚醒通知丟失 + run 記錄過期 → `subagent_status` not_found → orchestrator 判「沒跑完」→ 用戶看到的是死氣一小時。
- **後端建設**：`subagent_status`（gateway `subagent.ts`）在 run 記錄 not_found 分支增加落盤路徑探測——按 run id 前綴掃 `outputs/subagent/<runId前8>*.md`，命中即在回應中帶 `artifact_path`＋mtime＋字節數；orchestrator 端 prompt 修一句：「not_found 且帶 artifact_path 時，產物已交付，直接驗收盤上檔案，勿重派」。
- **評測 ruler**：模擬 run 記錄過期（刪 gateway 記錄不刪落盤檔）→ 問 status → 斷言回應含 artifact_path；agent-evolve 真會話驗收 orchestrator 不重派。
- **全鏈生效定義**：一單落盤但喚醒丟失的 subagent，用戶在下一輪詢問時 30 秒內拿到產物路徑，而非重跑。

### 刀 2 模型能力卡＋派遣預檢閘（gateway＋catalog，主刀）

- **痛點**：prompt 上限/時長檔位/計費口徑/交付證據四項全靠 subagent 用真金白銀試出來；換模後任務書還帶著舊模型數字。
- **後端建設**：
  1. `src/lib/generation-model-catalog/` 每視頻模型補四欄：`prompt_char_limit`、`duration_slots`（[min,max] 離散檔）、`billing_basis`（per_second/per_task＋單價）、`last_24h_delivered`（探針回填）。首批只補 seedance 家族（4000/29s/28 每秒/已有探針數據），其餘模型欄位空＝閘放行（fail-open，同 Jev 刀 2 範式）。
  2. `video_quote`/`subagent_dispatch` 前置預檢：spec 內 prompt 拼裝長度 > `prompt_char_limit` → 拒派並回「條X超限 Y 字元，建議拆條或錨串減次」；目標時長不在 `duration_slots` → 回可用檔位。**只拒派不改寫**——創作表述（逐字複用）的取捨留給人/orchestrator。
  3. spec 計費行改機器注入：`subagent_dispatch` 組任務書時計費/檔位段按 dispatch 時的 catalog 即時值渲染，任務書模板裡刪掉死數字（721 幣/30s 檔這類），compaction 失憶自然失效。
- **評測 ruler**：重放該會話條1 場景（4861 字元 spec）→ 斷言預檢拒派且訊息含「超限 861」；正常 3703 字元 → 放行。
- **全鏈生效定義**：換模重推類任務零「提交前才發現 400」、零「任務書幣價與實付差 2.36×」。

### 刀 3 音畫對位真源前置（expert 培訓面＋工具，輕刀）

- **痛點**：對位表基於設計規格 176 BPM 生成，真源 169.73 BPM，整表作廢重做；且此斷屲在裝配階段（最後一里）才被發現。
- **後端建設**：視頻/剪輯類 spec 模板加硬欄 `tempo_source`（enum: `design_spec` / `measured_audio`＋實測值），`measured_audio` 缺實測值或與設計值偏差 >1% 時 catalog/qc 欄標記 `beatmap_at_risk`；editor Expert 的 qc 欄驗收規則同步（骨架已在 Jev 刀 1 空殼欄位初篩上，加一條判定）。
- **Agent 培訓面**：music/video/editor 三 Expert 任務書模板（`gateway/spec-templates.json`）各加一句：「卡點對位必須以真源音頻實測 BPM 為準，設計規格僅作命名參考」。
- **評測 ruler**：拿該會話 m4a（169.73 BPM）重放對位任務 → 斷言產出表使用實測值並帶 `tempo_source=measured_audio`。

## 3. 排序與依賴

刀 2（能力卡）價值最高——它同時吃掉「4000 上限」「計費口徑漂移」「compaction 失憶」三個斷層；刀 1 最小可先行（單檔改動）；刀 3 依賴 Jev 刀 1 的空殼欄位初篩骨架（已上線）。三刀互不阻塞，可並發。

## 4. 明示不做

- 不做 workflow 模板 vs 直調 API 的路由統一（「沒有用模板」爭議）——首批已扣費的歷史決策不追溯，模板化路由另立 PRD 前先讓暴君定產品口徑。
- 不重做 402 歸因與 B key 綁定（0919 已修）。
- 不改「逐字複用」創作約束本身——預檢只陳述衝突（超限 Y 字元），是否拆條/錨串減次由裁決者決定。
