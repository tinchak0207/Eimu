# PRD：3D 導演工作站（Astra 前置建設）

> 2026-09-06 裁定。暴君定位：**Astra = 專屬 3D 導演 subagent**——主腦遞委託單（想要的效果），Astra 自主用 Blender 設計骨架動畫，隔離上下文，只回傳結果。
> 本 PRD 範圍：**後台 + 前台建設（P0+P1），模型渠道接入殿後**。測試期用現有模型頂位，渠道經不起大量使用 → 全程帶成本護欄。

---

## 0. 架構總圖

```
用戶（劇本/參考圖/一句話）
   │
主腦（現有 agent，上下文不膨脹）
   │  委託單（效果描述+參考+約束，≤2k token）
   ▼
┌─────────────────────────────────────┐
│ 3D 導演 subagent（persona 綁模型位）      │
│  測試期：現有便宜模型頂位                │
│  生產期：gpt-6-astra（渠道限流護欄）      │
│                                       │
│  L2 CG 執行：Blender headless 橋（唯一主力）│
│   bpy 腳本 → .blend/glTF/幀/mp4       │
│   blocking/骨架動畫/材質/燈光/渲染全在此  │
└─────────────────────────────────────┘
   │  回傳（資產引用+摘要，不回傳過程）
   ▼
畫布「3D 場景卡」+ 資產包持久化 + 計費 ledger
   │
   ▼（既有管線）image/video 生成 → timeline 成片
```

**分工裁定（09-06 二審：Blender 上位）**：**Blender 為唯一主力工作站位**——blocking/骨架動畫與真 CG 全在 Blender 內完成。director-engine **停止新增能力投資**，降級保留兩個剩餘價值：①既有 viewport 展示殼（P1 吃 glTF 做瀏覽器預覽）②機位/運動模板作為 bpy keyframe 的種子數據。不再為白模引擎寫任何新功能。

**委託單契約**（上下文控制的關鍵）：
- 主腦 → 3D 導演：`{效果描述, 參考圖引用, 鏡頭數/時長, 風格約束, 交付物清單}`（結構化，≤2k token）
- 3D 導演 → 主腦：`{資產包引用(.blend/glTF/腳本), turntable mp4, stills[], 場景樹摘要(≤500 token), 渲染耗時/成本}`——**過程不出 subagent 隔離層**。

---

## 1. 輪子錨定總表（PRD 鐵律：每 spec 必釘輪子源）

| 輪子釘（源檔） | 複製到 | 白名單欄位（數據源/文案/接入點） | 判定 |
|---|---|---|---|
| [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp)（27k★，執行協議/場景狀態讀回/錯誤形狀） | `bridge/blender-bridge/` 執行器 | 協議訊息形狀、場景 tree dump 格式；交互邏輯按 headless CLI 改寫 | diff 除 headless 適配外逐行等價 |
| [arjun988/blender-skills](https://github.com/arjun988/blender-skills)（94 專業 skill：blockout→lookdev→render 管線配方） | 3D 導演 SKILL 的腳本配方庫（移植 previz 子集 10–15 個） | 腳本模板全文、參數、階段門禁文案 | cp 原文改白名單 |
| `src/lib/director-engine/`（L1 引擎） | **不動**；P1 僅新增 glTF 載入入口 | engine.ts/types.ts 既有介面 | 禁改既有行為 |
| `src/lib/harness-tool-registry.ts` 註冊模式 | `blender_*` 工具族註冊 | 既有 registry 欄位形狀 | 同構複製 |
| generation worker 併發池模式 | 渲染佇列（P1） | 併發數 env 化、lease 語義 | 同構複製 |
| tool-progress SSE 機制 | 逐階段渲染進度（P1） | 事件形狀 | 同構複製 |
| asset-packs persistence | .blend/glTF/腳本入包（P1） | 資產類型欄位 | 同構複製 |
| control-plane billing paradigm | GPU 分鐘計費（P1） | reserve/commit/refund 語義 | 同構複製 |
| new-supplier-integration skill「new-api 渠道 5 分鐘配方」 | Astra 渠道接入（P1 殿後） | 配方全文 | 照抄 |
| [squall01337/mixamo-llm-mocap](https://github.com/squall01337/mixamo-llm-mocap)（視頻→Mixamo→Blender） | P2 埋樁不施工 | — | — |

---

## 2. P0：本機全閉環（後台骨架，零 VPS 改動，零渠道呼叫）

**預期 2–4 天工。驗收門見各項；全綠標準 = smoke 成片 + 斷點 0。**

### P0-1 Blender runtime（≤30 分鐘）
- 安裝 Blender 5.2：flatpak（`flatpak install flathub org.blender.Blender`，免 sudo，agent 可自裝）或暴君一行 `sudo pacman -S blender`。
- 驗證 headless GPU：`blender --background --factory-startup --python-expr` 出一幀 Eevee（EGL 驗 RTX 5070 可用）；Cycles CPU 後備。
- 產物：版本釘死 + 一頁啟動配方（進 runbook，不入 AGENTS.md）。

### P0-2 blender-bridge 執行器（核心後台件）
- 新建 `bridge/blender-bridge/`：本地服務，收 `{bpy 腳本, 資產引用, 渲染參數}` → 起 Blender 進程執行 → 回 `{產物清單, 場景樹摘要, stdout 尾段, 耗時}`。
- 輪子：blender-mcp 的指令/回執形狀 + blender-skills 的管線腳本模板。
- **沙箱紅線**：`--factory-startup`、無網（進程級）、timeout（預設 300s）、磁碟配額、產物白名單路徑。腳本只准寫 workspace 目錄。
- 驗收門：惡意腳本（`import urllib`/死循環/越路徑寫）三連測試全被攔；正常腳本出幀。

### P0-3 3D 導演 SKILL（頂位模型能寫對 bpy）
- 新建 skill：管線五階段（blockout → 相機 → 燈光 → 骨架動畫 → 渲染），每階段帶 blender-skills 移植的腳本配方；Eevee previz 預設 / Cycles lookdev 預設； director-engine L1 數據（機位/運動曲線）可轉 bpy keyframe 的對照表。
- 頂位 = 現有便宜模型（deepseek-v4-flash-vision-exp 級）；Astra 只是日後 persona 換綁，**SKILL/工具/委託單契約全部模型無關**。
- 驗收門：頂位模型按 SKILL 生成 bpy，≤3 次迭代內 bridge 執行通過並出幀。

### P0-4 工具族註冊（本地形態）
- `harness-tool-registry.ts` 註冊 `blender_exec`（建場景/改場景）、`blender_render`（出幀/mp4）、`blender_export_gltf`（P1 前台用，P0 先交付檔案）。
- 工具文案**一律簡體**（gateway 文案鐵律）。
- 驗收門：本地 agent 會話中呼叫我三件套全通；deny 表新增 Blender 沙箱例外條目。

### P0-5 smoke（終驗）
- 輸入：一段劇本（例：雨夜屋頂追逐，2 鏡）。輸出：.blend + glTF + turntable mp4 + 3 stills，全部落盤並列清單。
- 門：單鏡渲染 ≤5 分鐘（Eevee/RTX）；斷點 0；**渲染幀過視覺審核閉環（毒舌審核 PASS）才算交付**——防假成功鐵律。

**P0 明確不做**：VPS 部署、前台 UI、計費、Astra 渠道、資產包入庫。

---

## 3. P1：生產化（VPS + 前台 + 資產 + 計費，渠道殿後）

**預期 1–2 週工，分片派工。**

### P1-1 渲染節點 + 佇列
- 本機 GPU 節點先行（bridge 容器化， podman）；上量後按分鐘租 GPU（RunPod 級）——**渲染節點選型是暴君拍板點①**。
- 佇列：複製 generation worker 併發池（env 可調併發、lease、失敗自愈）。

### P1-2 VPS gateway 工具族
- blender_* 四件套上 VPS gateway（bridge 走內網/隧道）；patch 配方照 opencode gateway 手術配方（backup→tee→python 補丁→bun build→重啟）。
- 進度：tool-progress SSE 逐階段回傳（blockout/相機/燈光/渲染百分比）。

### P1-3 前台「3D 場景卡」
- 畫布新卡型：turntable 視頻 + stills 網格 + 場景樹 + 資產下載；交互範圍 P1 只讀+播放（可拖拽相機沿用 L1 director-engine viewport，不重造）。
- **鐵律**：新 metadata 欄位族必同步兩處白名單（`toNodeMetadata` + `compactMetadataForAgent`），配往復合同測試（snapshot compressor 事故教訓）。
- director-engine 新增 glTF 載入：白模 viewport 升級為真資產預覽。

### P1-4 委託單 UI（subagent 接入面）
- subagent 選單加「3D 導演」項（複製既有 subagent menu 輪子）；委託單表單 = 契約 schema 的 UI 化；回傳渲染為 3D 場景卡。

### P1-5 資產包入庫
- .blend/glTF/腳本/貼圖按資產包 schema 持久化（複製 asset-packs persistence）；**腳本帶指紋索引**——相似委託先命中腳本模板，零 token 復用（成本護欄核心）。

### P1-6 計費
- 渲染 GPU 分鐘 + 儲存進 ledger（reserve/commit/refund 同構）；**价目表先加價再上線**（价目表是唯一價格權威，禁猜價）。

### P1-7 模型渠道接入（殿後，暴君點頭才開工）
- new-api 渠道 5 分鐘配方接 `gpt-6-astra`（$10/$50 每百萬 token）；persona 換綁即完成。
- **成本口徑（2026-09-06 暴君裁定，替代原「月預算帽」設計）**：
  - 單請求成本：≤100k 上下文＋80% 緩存命中 → **0.04–0.05 RMB/請求**；**0.12 RMB/請求為「太貴」紅線**（觀測指標，超線場景走 P2 機制）
  - subagent 隔離設計天然守住成本：委託單 ≤2k token＋SKILL＋場景摘要，不吃滿上下文——**隔離即省錢**
  - 產品計費：**單請求 2 幣靜態收費**（成本讓不出去的特例；落實歸 P2）
- **渠道護欄（保留項）**：佇列限流（併發帽＋排隊）；腳本模板庫命中優先（P1-5，同類場景零渠道呼叫）；Astra 只做首次設計、迭代走便宜模型。原「逐 session token 帽超額降級」設計**作廢**。

### P1 終驗門
eimu.dev 端到端：委託單 → 3D 導演出片 → 場景卡 → 資產包 → 計費對帳零漏 → 視覺審核 PASS；Vercel READY + production alias（暴君接管視覺驗收時到此為止）。

---

## 4. 成本結構（對帳底稿）

| 項目 | 測試期（P0） | 生產期（P1 後） |
|---|---|---|
| 骨架動畫 | L1 director-engine，0 成本 | 同左 |
| bpy 腳本生成 | 頂位模型（現有渠道） | Astra 首次 $0.3–2/場景；迭代走便宜模型 |
| 渲染 | 本機 RTX，電費級 | GPU 分鐘計費（租用約 $0.3/hr 級） |
| 資產復用 | — | 腳本/場景命中模板 = 0 邊際成本（復利層） |

## 5. P2 埋樁（不施工）
- **Astra 上下文壓縮與續命（2026-09-06 暴君裁定歸 P2）**：單請求成本超 0.12 RMB 紅線時，便宜模型壓縮上下文後**隱形給 Astra 開新對話**繼續工作（「沒什麼用還可能出 bug，其他東西都做完才做」）。
- **2 幣靜態計費落實**：3D 導演單請求 2 幣（產品特例，成本讓不出去），與 GPU 分鐘計費一起接進 ledger。
- mixamo-llm-mocap：視頻→角色動畫（真角色骨架，非 mannequin）。
- UE5 L3：walkable 實時漫遊（Astra 官方 demo 已驗證 Blender→UE5 通道）。
- 多鏡 previz → image/video 生成 → timeline 成片**全管線**（3D 資產餵現有生成渠道控品質——終極護城河閉環）。

## 6. 待暴君拍板
1. **渲染節點**：暴君裁定方向＝搜 free tier 高、不占本機的方案（研究片 U/V 掃描中）；本機 RTX 5070 為對照基線（一幀 Eevee ~4s）。
2. ~~Astra 月預算帽~~ **作廢（2026-09-06）**：改為單請求成本觀測口徑（0.04-0.05 RMB 正常／0.12 紅線）＋2 幣靜態收費，均歸 P2 落實。
