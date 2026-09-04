# PRD：AI 助理 × 資產持久化與活化（Asset Packs）

> 定性：能力建設。參考競品 filmera.ai，映射到 Emu 既有棧，不造輪子。
> 狀態：待暴君裁定 → 按本檔 SPEC 表格機械執行。
> 語言：正體中文（與代碼註釋一致）；站點 UI 文案仍走簡體（PRODUCT.md 品牌規則）。

---

## 0. 一句話目標（可測量終態）

用戶在任意過去產物（對話出圖 / 歷史 / 畫布 / 工作流）上**一鍵提取資產** → 落入統一的**帳號級資產包（Asset Pack）** → 新會話或進行中會話中，Agent 能**搜尋並活化**該包（提示詞 / 配方 / LoRA / 參考卡）→ 生成的任務參數與 `job_events.detail` 實際帶上該包引用（可查證），全程**不重複扣費**。

**判定成功（全部為可驗證證據，非 HTTP 200）：**

1. 用戶在歷史/畫布/聊天各有一個「存為資產」入口，保存後可在「我的資產」看到，跨會話、跨重新整理仍在。
2. Agent 對話中說「用我上次那個角色風格」→ 工具 `asset_search` 返回該包 → `asset_activate` 解析出 prompt/LoRA/參考圖 → 生成任務 `job_events.detail` 含 `asset_pack_id`，實彈出圖且參數與資產一致。
3. 活化前後用戶額度餘額除正常生成扣費外**零額外扣除**（計費真源仍是控制面排帳）。
4. 舊「存圖庫」假存檔（prompt 寫死 `AI 助理生成 · 第 N 张`）消失，取而代之的是帶真實語境的資產保存。

---

## 1. 現狀（事實標籤）與主瓶頸

### 現狀盤點（2026-08-30 Explore 全庫盤點）

| 現有孤島 | 位置 | 狀態 |
|---|---|---|
| 畫布素材（text/image） | `src/lib/canvas/asset-store.ts`（Blob `canvas-assets/{userId}/`，500/戶） | ✅ 最接近「資產庫」，upsert-by-id |
| 角色/場景/風格卡 | `src/lib/character-card-store.ts`（Blob，100/戶） | ✅ 已存在，無 prompt |
| 配方模板（六槽） | `src/lib/recipe-template-store.ts`（Blob，50/戶） | ✅ 已存在 |
| LoRA 收藏/最近 | `src/lib/lora-user-state.ts`（Postgres `lora_user_state` / Blob） | ✅ 已存在 |
| 帳戶畫像+教訓 | `src/lib/agent-profile-store.ts`（Postgres `agent_user_profiles`/`agent_lessons`） | ✅ 已存在，**已注入 sessions L0** |
| 帳號級「提示詞庫」 | ❌ 不存在（`/api/canvas/prompts` 是公共遠端，只讀無用戶保存） | ❌ |
| 統一資產包抽象 | ❌ 五個孤島互不相通，無 collections/pack | ❌ |
| 從對話提取資產 | ❌ 唯一機制 `fireAndForgetLessonDigest`（提煉教訓，非資產）；`AgentChatSurface.tsx:298-320` 存圖庫是假存檔 | ❌ |
| Agent 讀取用戶資產 | ❌ 本地工具契約（`agent-tool-contract.ts:122-234`）只有 image_generate/edit/upscale + canvas + lora，**無任何工具讀 canvas-assets / character-cards / recipe-templates** | ❌ |
| 前端拿完整 transcript | ❌ 只有 SSE 回放，無 GET transcript 端點（gateway 側 7 天 DB row） | ⚠️ 阻礙「對話精確提取 prompt」 |
| 歷史→Agent 交接 | `HistoryClient.tsx:195-200` 只傳一句 prompt 文本，丟 model/size/lora/參考圖 | ⚠️ 與資產複用無關 |

### 主瓶頸（FACT）

1. **Agent 活化面是 0 讀**：資產存了，但 agent 工具鏈讀不到、注入面（L0）只帶畫像+教訓，不帶資產 → 「從過去提取資產並複用」的**複用半環完全缺失**。
2. **提取面是假出口**：唯一號稱「存圖庫」的按鈕存的是假歷史條目，不帶對話中的 prompt/LoRA/參數（`agent-chat-persistence.ts:61-79` sanitize 把 prompt 丟掉）。

### 因果鏈（最短主線）

用戶過去生成資產 → 資產散落五孤島可存不可聚 → Agent 生成時讀不到（活化=0）→ 用戶只能手動複製貼上 → 無法「從過去提取→複用」

### 最小干預（每格推一格）

1. 造統一**資產包抽象**（引用層，不搬資料）→ 2. 打通**提取**（歷史/畫布/聊天三個 1 鍵入口）→ 3. 打通**活化**（站內 agent 工具 asset_search/activate + L0 active pack 注入）→ 4. 給**可見面**（我的資產）。

---

## 2. 競品對照：filmera.ai → Emu（2026-08-30 官網抓取）

filmera 的資產複用範式**不是泛泛的「提示詞庫」**，而是：

> **「Characters and sets locked as reference cards — stay locked across every generation.」**
> 角色/場景鎖定為參考卡，跨每次生成保持；take-based 非破壞性（每次生成留底，VFX 施加在已愛上的那一版，不是重擲骰子）；agent 佈線節點並排隊出片；每次生成事前明碼計價。

**映射到 Emu（取可用、改白名單、不整建）：**

| filmera | Emu 對應 | 落地 |
|---|---|---|
| 參考卡跨生成鎖定 | **資產包（Asset Pack）**：參考卡/配方/LoRA 包成為帳號級可激活集合 | 本 PRD 核心 |
| take-based 非破壞 | 歷史重跑/微調變體（已有 `history-rerun.ts`） | 不動，只是資產來源之一 |
| agent 佈線節點 | agent 工具面擴 `asset_search`/`asset_get`/`asset_activate`（站內實現，同 `agent-lora.ts` 模式） | P0 |
| 三房 Canvas/Media/Edit | 畫布 / 歷史 + 我的資產 / 工作站 | 我的資產 = 新入口（P0） |
| 事前明碼計價 | 確認卡先行（已有） | 不動 |

> filmera 是 video-first 單一工作流；Emu 是全能中轉 + 批量場景。**只借「參考卡鎖定 + 可激活集合」這一核心心智，不複製三房佈局。**

---

## 3. 核心設計：資產包 = 參考卡集合

### 原語

- **資產包（AssetPack）**：帳號級集合，含
  - `references[]`：參考卡（角色/場景/風格）→ 引用 `character-cards` 孤島物件 id
  - `prompts[]`：提示詞/六槽配方 → 引用 `recipe-templates` id **或** 自由文本提示詞（自帶）
  - `loraBundle[]`：`{versionId, title, weight}` → 引用 `lora_user_state` 收藏的 versionId
  - `images[]`：素材圖引用 → 引用 `canvas-assets` image 的既有 URL（**不複製位元組**）
  - `digest`：包的語義摘要（≤500 字，模型注入用，agent 用語義搜尋）
- **提取（Extract）**：從歷史/畫布/聊天把「用過的配方」固化成資產條目 → 一鍵入包
- **活化（Activate）**：包被指定為 active / agent 依語義命中 → 解析出 `{prompt, loraModelVersionIds, referenceImageUrls}` → 餵給既有 `image_generate` / `image_edit` 參數面；L0 注入 digest 讓模型「跨生成記住」

### 真源與不重造輪子

- **資料仍留在各自孤島**（extend existing owner：不建第二套 canvas-assets / character-cards / recipe-templates）；**資產包只存引用 + digest + 排序**，是「我的資產」的單一聚合入口。
- **儲存模式逐行複製** `asset-store.ts`（新路徑 + 修剪世代 + 寫入佇列 + cache TTL + normalize 白名單），新命名空間 `asset-packs/{userId}/`。
- **Agent 工具模式逐行複製** `agent-lora.ts`（站內實現、讀站內 API、寬鬆 payload 解析、明確錯誤碼）。
- **注入通道擴展** `agent-profile-store.ts` + `sessions/route.ts` L0（現有 profile+lessons 注入）→ 增加 active pack digest。
- **UI 不造新面板**：擴 `CanvasLibraryPanel` 四 tab、`AgentChatSurface` 工具列、`HistoryCard` 動作列。

### 誠實能力宣告（PRODUCT.md「UI 宣稱必須匹配真實能力」）

- LoRA 包**只**在模型 `capabilities.lora` 為真時激活（沿用 `loraToGenerationParam` 單選鐵律 `slice(0,1)`）。
- 參考卡圖**只**走支援參考圖/edits 的通道（`image_edit`、畫布 reference 節點）；不支援處明確標 `unsupported`。
- LoRA 訓練/自存模型**維持 `unsupported`**，不因本 PRD 假裝存在。

---

## 4. SPEC（輪子釘 | 複製到 | 白名單 | 判定）

> 鐵律：白名單以外的交互邏輯/物理參數/事件監聽/生命週期 hooks 一行不許動（AGENTS.md「禁止造輪子」）。

### P0-A 資產包真源 + API

| 欄 | 內容 |
|---|---|
| 輪子釘 | `src/lib/canvas/asset-store.ts`（整體）；`src/app/api/canvas/assets/route.ts`（API 骨架） |
| 複製到 | `src/lib/asset-pack-store.ts`；`src/app/api/assets/route.ts`（GET/PUT/DELETE，`requireVerifiedUser`） |
| 白名單欄位 | `CanvasAsset.kind` 枚舉改為 `prompt / reference / lora_bundle / recipe / image`；新增 `prompts[]/references[]/loraBundle[]/images[]/digest`；上限 100 包/戶。**其餘（upsert-by-id、寫入佇列、新路徑修剪、cache TTL 3s、normalize 白名單、limit 錯誤類）逐行等價** |
| 判定 | 單元測試：normalize 白名單/上限拒絕；API E2E：PUT→GET→DELETE 跨重新整理仍在（expected-pass） |

### P0-B 提取：三個一鍵入口

| 入口 | 輪子釘 | 複製到/改 | 白名單 | 判定 |
|---|---|---|---|---|
| 歷史→資產 | `src/lib/history-card-anchor.ts:47-67` `cardFromHistoryEntry` | 擴充為「存為資產」：除圖 URL 外帶入 history 條目的 prompt/model/size/lora（這些欄位 history 條目已有），存成 `reference` 或 `recipe` 資產 | 只加欄位映射與保存呼叫；轉換邏輯原樣 | 歷史卡「存為資產」保存後，資產包內 title/prompt 與歷史一致（非 `AI 助理生成 · 第 N 张`） |
| 畫布→資產 | `src/components/canvas/CanvasLibraryPanel.tsx:309-338` 「存入素材」 | 存入目標由 `/api/canvas/assets` 改為 `/api/assets`（打包），帶上節點完整配方（已有 `parseWorkflowRecallConfig` 可用） | 只換 API 路徑與 payload 欄位；面板交互零動 | 畫布節點存為資產後，配方六槽與節點一致 |
| 聊天→資產 | `src/components/agent-chat/AgentChatSurface.tsx:298-320` `onSaveToLibrary`（假存檔） | 改為存 `reference` 資產（圖 URL + 會話 id + 時間 + 語境句）；**不宣稱帶 prompt**（前端無 prompt，見 P1） | 只改 body 與目標 API；disabled 態/冪等 `savedIds` 保持 | 點「存為資產」→ `/api/assets` 出現 reference；原 `/api/history` 假條目不再產生 |

### P0-C Agent 活化（站內工具 + L0 注入）

| 欄 | 內容 |
|---|---|
| 輪子釘 | `src/lib/agent-lora.ts`（工具模式）；`src/app/api/agent/sessions/route.ts` L0（注入通道） |
| 複製到 | `src/lib/agent-assets.ts`（`asset_search`/`asset_get`/`asset_activate`）；sessions route 擴 active pack 注入；`agent-profile-store.ts` 加 `buildAssetPackInjection` |
| 白名單 | 工具命名/錯誤碼沿用 lora 模式；`asset_activate` 輸出契約 `{prompt, loraModelVersionIds, referenceImageUrls}` 可直接進 `image_generate`/`image_edit` 參數；L0 注入 digest ≤500 字、只注入 active pack；**LoRA 單選鐵律 `slice(0,1)` 與 `capabilities.lora` 門不變** |
| 判定 | 契約測試：`asset_search` 搜到用戶包；`asset_activate` 解析出的 lora versionId 進生成參數；E2E：對話「用我上次那個風格」→ 生成任務 `job_events.detail` 含 `asset_pack_id` + 真實 LoRA/prompt，實彈出圖；額度僅扣正常生成費 |

### P0-D UI：我的資產 + 使用入口

| 欄 | 內容 |
|---|---|
| 輪子釘 | `src/components/canvas/CanvasLibraryPanel.tsx`（四 tab 面板）；`AgentChatSurface` 工具列 |
| 複製到 | 畫布資源庫「我的素材」tab 擴為資產包視圖（列表 + 包詳情 + 設為 active）；聊天加「我的資產」入口（沿用 Liquid Glass，禁 emoji 圖示） |
| 白名單 | 只加一個 tab 內容與「設為 active」動作；面板外殼/交互原樣 |
| 判定 | 用戶設 active 包 → 新開會話 L0 帶 digest（服務端可查）；我的資產列表與 `/api/assets` 一致 |

### P1（不阻塞核心閉環）

| 項 | 內容 |
|---|---|
| E1 對話精確提取 | gateway 增 GET transcript 端點（7 天 DB row 已有）→ 前端讀 `generate_image` 工具 args 的 prompt/lora → 聊天「存為資產」帶真 prompt；**gateway 在 VPS /opt/agent-harness，需本地/遠端雙向 diff 後合併（見 AGENTS.md 基底合併規則）** |
| E2 交接帶配方 | `HistoryClient.tsx:195-200` 只傳一句話 → 改帶完整配方（model/size/lora/參考圖 URL）給 agent |
| E3 聚合搜尋 | 全站搜「我的資產」（跨 pack 標題/tags/digest 關鍵字） |
| E4 LoRA 包編輯 | 工作站 `LoraLibraryPanel` 支持把收藏打包成 loraBundle |

---

## 5. 範圍外（Out of Scope）

- LoRA 訓練 / 用戶自訓模型（upstream `unsupported`，不假裝）
- 資產市場 / 跨帳號分享 / 團隊協作
- 把五個孤島資料一次性遷入 pack（pack 只引用；「打包即快照」屬後續）
- filmera 式 take-based 三房佈局（Emu 已有歷史重跑閉環）

## 6. 計費 / 運行時 / 衛生（暴君-9 / -10）

- **活化不重複扣費**：活化是元資料解析 + 注入，不碰額度；生成一次扣費走既有控制面排帳（記憶 `control-plane-billing-paradigm` 唯一真源）。驗收迴歸：活化前後額度只被正常生成扣。
- **資產包不複製位元組**：圖片一律引用既有 URL（history/canvas URL），無儲存放大；Blob 包檔案很小。
- **秘密不入檔**：資產包無任何憑證；`requireVerifiedUser` 全程看守。
- **不宣稱未驗證能力**：reference/LoRA 路由未達能力處標 `unsupported`（例：`generate_images` 不支援參考卡的通道，agent 活化時明示改用 `image_edit`）。

## 7. 驗收總表（上線前 Gate）

| 證據 | 手段 |
|---|---|
| 資產包 CRUD 跨刷新持久 | 契約測試 + E2E API |
| 三個提取入口保存內容真實 | 契約測試（title/prompt 非假文） |
| Agent 活化帶真實參數 | E2E：對話指令 → `job_events.detail` 含 pack id + 實彈出圖 |
| 零重複扣費 | 額度餘額比對（活化前後） |
| 舊假存檔消失 | 前端回歸：無 `AI 助理生成` 假條目 |