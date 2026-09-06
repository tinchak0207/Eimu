# NODES-PLAN — bridge 節點以 supplier channel 形態進多節點派發（片Y，2026-09-06）

**性質：staging 稿。本片零 src/ 改動、零 VPS 改動。** 研究片 V 裁定的落地稿：現階段（1-2 節點）不引調度輪子，「佇列」P0 已自給（bridge FIFO＋片K 併發，429 即答/雙層超時/失敗自愈），P1 缺口是「**節點分發＋檔案回收**」——用 gateway 既有 supplier 派發模式（認領/健康軟排除/deadline 對帳）換目標地址。

---

## 1. 考古結論（真源檔案:行號＋字段形狀）

### 1.1 supplier channel registry 真源

`src/lib/supplier-channels.config.ts`（193 行，本地在位，記憶 supplier-channel-registry-oneclick 說的「仍被引用是活的」現場核實成立）：

- L11-15 `RegistryChannelClaim`：`{ modelId, supplierModelId: string|null, kinds: ("image_generate"|"image_edit"|"video_generate")[] }`
- L17-28 `RegistryChannel`：
  ```ts
  label: string;                 // env channel label ＝ DB supplier label
  baseUrlEnv: string;
  apiKeyEnv: string;             // 同時作為 credentialRef
  enabledEnv: string | null;
  tier: "first_party" | "managed_pool" | "relay" | "fallback";
  seedPriority: number;          // seed 進 supplier 表的 priority
  sitePriority: number;          // 站點隊列 ENV_CHANNEL_PRIORITIES 用
  chatImageModels: string[];
  adapterType?: "openai_images" | "metaso" | "openai_video";
  claims: RegistryChannelClaim[];
  ```
- L30-193 `REGISTRY_CHANNELS`，marker 區 `REGISTRY-ENTRIES-START`(L31)/`END`(L192)，現有 6 條（hublinuxdo/metaso/tokenmix/yyds/cangyuansuanli/drama）。

**消費鏈（每個接入點都已核實行號）**：

| 環節 | 真源 | 行為 |
|---|---|---|
| env→descriptor | `src/lib/sub2api.ts` L114 `registryChannelToDescriptor` | id=`env:<label>`；`configured = Boolean(base && apiKey)`；L201 併入 `describeEnvChannels` |
| 站點隊列優先級 | `src/lib/channel-registry.ts` L39-45 | `ENV_CHANNEL_PRIORITIES` 由 `REGISTRY_CHANNELS.map(c => [c.label, c.sitePriority])` 展開 |
| seed 三表 | `tools/seed-generation-suppliers.ts` L314-356 | `INSERT supplier`（id=`env:<label>`、`adapter_type = registry?.adapterType ?? "openai_images"`、`supply_tier = tier(label)` 直取 registry.tier、`priority = seedPriority`、configuration_json 含 chatImageModels）＋ `supplier_account`（configuration_json 帶 `healthPath`）＋ 逐 claim `upsertCapability`（L348 `channelCapabilities`：**claim.modelId 不在 GENERATION_MODEL_CATALOG 會 warn 並跳過，不擋 seed**） |
| 認領派發 | `src/lib/generation-core/scheduler.ts` L68-78 | ORDER BY：`supply_tier` CASE(0/1/2/3) → `priority ASC` → health_status CASE(healthy 0/degraded 1/else 2) → `health_score*quality_score*capability.health_score DESC` → 活躍 lease 負載比 ASC → `latency_ewma_ms ASC` → `unit_cost+capability.cost_units ASC` → `last_selected_at`；`FOR UPDATE SKIP LOCKED` 認領＋supplier_lease |
| 健康軟排除 | 同上 L37-45 | supplier/capability/account 三層 `health_status <> 'disabled'`＋`cooldown_until` 過濾（**冷卻是排除不是降權；endpoint 級熔斷器是入隊尾**，`channel-registry.ts` L134-140 prioritizeHealthyEndpoints） |
| adapter 分派 | `src/lib/generation-core/supplier-adapter.ts` L108-135 `requestSupplier` | `if (supplier.adapterType === "metaso")` / `"openai_video"` / filmera / new-api 分流——新增節點 adapter 即在此加一個分支 |
| 對帳協議 | `src/lib/generation-core/worker-service.ts` L54 `protocolOfAdapter` | adapter_type → ProviderProtocol；未映射的同步 adapter 不進異步對帳 |
| deadline 對帳 | `src/lib/generation-core/provider-reconciliation.ts` L33 | reconcile lease（SKIP LOCKED 認領到期 attempt） |
| 健康探測輪子 | `src/lib/generation-core/adobe-health.ts` L37-45 | `SELECT supplier_account JOIN supplier WHERE adapter_type='adobe2api'` → fetch `account.configuration_json.healthPath` → UPDATE account.health_status——**bridge 節點健康探測按此同構** |

### 1.2 bridge 契約真源

`bridge/blender-bridge/README.md`（80 行）＋`src/lib/blender-tools.ts` L11-19 契約節：

- `GET /v1/health` → `{ok, blender_version, gpu:"egl"|"cpu", workdir, queue_depth, concurrency}`
- `POST /v1/execute {script, timeout_ms}` → `200 {ok, artifacts:[{path,bytes,kind:"blend|png|mp4|glb|other"}], scene_summary, stdout_tail, duration_ms, queued, queue_position}` / `500 {ok:false, error, stdout_tail}` / `429 {ok:false, error:"queue_full"}`
- FIFO 嚴格、timeout SIGKILL 進程組、失敗自愈（片K/片O）；橋位址 = `BLENDER_BRIDGE_URL`（默認 `http://127.0.0.1:8765`）
- **單幀 job 才是安全單位**（片L 實錘：橋內多幀循環 render 必 native 崩）→ 節點認領的 capability P0 只有單幀渲染。

### 1.3 片X（Modal）現狀與片W 通路

- `deploy-staging/blender-modal/` **不存在**（片X 未落盤）→ Modal 節點的 endpoint/health 對齊全部標 **pending**。
- `deploy-staging/blender-bridge-tunnel/TUNNEL-PLAN.md`（片W，已交付）：ssh2 反向隧道 `forwardIn('127.0.0.1', 8765)`，VPS `127.0.0.1:8765` → 本機橋；**鑑權落橋側 Bearer**（§5 patch 稿）。本節點註冊稿與其天然銜接：VPS gateway 側看到的本機節點 endpoint 就是 `http://127.0.0.1:8765`＋Bearer token。

---

## 2. 三節點梯隊定義

supply_tier 是 scheduler 第一排序鍵（記憶 supplier-tier-sorting 實錘：priority 再小也翻不過 tier）。梯隊映射零發明，直接套四檔語義：

| # | 節點 id | 實體 | endpoint（VPS gateway 視角） | tier | seed/site priority | 併發 | 引擎能力 | 狀態 |
|---|---|---|---|---|---|---|---|---|
| 1 | `blender-local` | 本機 RTX 5070 Laptop 8GB＋Blender 5.2.1 EGL | `http://127.0.0.1:8765`（片W 反向隧道進來） | `first_party`（本機最快、零邊際成本） | 10 | 1（橋併發鐵律 `BLENDER_BRIDGE_CONCURRENCY=1`） | eevee＋cycles（gpu:egl） | **可接**（橋已在位，缺 Bearer patch 落位＝片W） |
| 2 | `blender-modal` | Modal L4（片X 交付物） | `https://<modal-app>.modal.run`（URL 待片X token） | `managed_pool`（額度池，按 GPU 分鐘計費） | 20 | 2-4（片X 定，pending） | eevee＋cycles | **pending**（片X 落盤後補 endpoint/health 對齊） |
| 3 | `blender-cnb` | CNB 溢出位 | 未定 | `relay` | 30 | — | — | **埋樁**（未來擴展位，只佔 tier 檔位不註冊） |

tier 語義對照：first_party＝自營最快（本機 5070 電費邊際成本≈0）；managed_pool＝受管額度池（Modal 按 GPU 分鐘付費）；relay＝外部溢出（CNB 按次/按時）。與既有渠道語義逐字同構（adobe2api=first_party、hub/yyds=managed_pool、yyds 曾因誤種 relay 整隊被繞過——本稿直接種對）。

### 每節點註冊字段（RegistryChannel 逐字段同構）

```ts
// blender-local
{
  label: "blender-local",
  baseUrlEnv: "BLENDER_NODE_LOCAL_URL",      // VPS 側值固定 http://127.0.0.1:8765（片W 裁定一字不改）
  apiKeyEnv: "BLENDER_NODE_LOCAL_TOKEN",     // 片W §5 橋側 Bearer patch 落位後的共享 token
  enabledEnv: "BLENDER_NODE_LOCAL_ENABLED",
  tier: "first_party",
  seedPriority: 10, sitePriority: 10,
  chatImageModels: [],                        // 本形態無 chat 生圖概念，恆空
  adapterType: "blender_bridge",              // 新 enum 值（見 §3）
  claims: [ /* §3.2 */ ],
}
```

完整定義稿見同目錄 `blender-node-channel.ts`（registry 同構＋最小 diff 註釋）。本地節點 `configured` 判定（sub2api.ts L118 需要 base＋key 同時在）天然要求：**Bearer patch 落位前本節點 configured=false 靜默出隊**——這是既有機制的誠實行為，不是缺陷（橋現在無鑑權，本來就不該暴露給 gateway）。

---

## 3. 派發語義（單幀 job 按能力標籤路由，零調度輪子改動）

### 3.1 能力標籤的承載面＝modelId 認領

不引調度輪子的關鍵：**「能力標籤」不新造路由欄位，編進 capability 的 model_id**。scheduler 按 job.modelId 查 capability 候選集，認領即路由：

| 平台 modelId（擬新增進 GENERATION_MODEL_CATALOG） | 引擎 | 典型用途 | 認領節點 |
|---|---|---|---|
| `blender-render-eevee` | Eevee（previz 存活配方 samples=1＋RT off，片F/M） | previz 單幀 | local＋modal |
| `blender-render-cycles` | Cycles | lookdev 單幀 | modal＋local |

多幀（turntable/動畫 mp4）P0 **不進 capability**（片L 實錘單幀才安全；分塊合成是工具層片M 的活，不走節點派發）。

**與研究片 V 偏好順序的對齊說明（誠實標註）**：片 V 寫「Eevee previz→本機/Modal L4；Cycles lookdev→Modal/本機 5070」（cycles 想優先 Modal）。supply_tier/priority 都是 supplier 行級欄位，表達不了 per-model 反序——現有欄位裡 capability 級只有 `health_score`（進排序乘積）與 `cost_units`（進 cost 排序，但污染計費對帳語義，否決）。初版裁定：**兩節點統一 local→modal 順序**（local=first_party 必勝），本機讓位的真實槓桿有三，全是既有欄位行為：①lease 佔滿（併發 1 被佔，WHERE 硬排除）②健康輪詢寫 disabled/短冷卻（不可達/佇列飽和）③degraded 只作排序內軟懲罰（壓不過 tier，驗證 case3b 實錘）——1-2 節點下這組行為等效於片 V 的意圖（本機閒就本機跑，本機忙/掛才上額度池）。若實測本機 cycles 成瓶頸（8GB VRAM 大 samples），再動 scheduler 的 routingClass 過濾（L50 `firefly_only` 是既有先例，同構加 `cycles_prefers_remote` 類標籤）——**該擴展標 pending，歸後續執行片拍板**。

### 3.2 claims 形狀（seed 端 channelCapabilities 逐字段消化）

```ts
claims: [
  { modelId: "blender-render-eevee",  supplierModelId: null, kinds: ["image_generate"] },
  { modelId: "blender-render-cycles", supplierModelId: null, kinds: ["image_generate"] },
]
```

kinds 沿用 `"image_generate"`（單幀 PNG 產出，語義同圖像生成；不新增 kind enum → seed/adapter/對帳全鏈零枚舉擴散）。**前置依賴（pending，歸執行片）**：`GENERATION_MODEL_CATALOG` 需新增兩個 modelId 條目（ratios/resolutions 取 square 檔），否則 seed 會 warn＋skip（寧少認領不虛報，channelCapabilities 既有行為）。

### 3.3 健康探測＝adobe-health.ts 同構

新輪 `refreshBlenderNodeHealth`（同構 adobe-health.ts L37-45 形狀：`WHERE supplier.adapter_type='blender_bridge'` → fetch healthPath → UPDATE account.health_status/configuration_json）：

| bridge /v1/health 觀察 | 寫入 account | 寫入 configuration_json |
|---|---|---|
| ok＋gpu:egl＋queue_depth < 飽和 | healthy | `{gpu:"egl", blender_version, queue_depth, concurrency, observedAt}` |
| ok＋gpu:cpu | degraded（**僅排序內軟懲罰**：L71 CASE 第三鍵，壓不過 tier——本機 degraded 仍勝 modal healthy；實跑 case3b 錘） | 同上 |
| ok＋佇列飽和（queue_depth ≥ QUEUE_DEPTH） | 短冷卻 `cooldown_until`（⇒ WHERE 層硬排除，流量落 modal；下輪恢復） | 同上 |
| 不可達／非 200 | disabled＋短冷卻（硬排除 ⇒ modal 接手） | 保留上次快照 |

**跨檔讓位的真實槓桿是佔線/冷卻/disabled，不是 degraded**（scheduler L37-45 WHERE 硬排除 vs L71 排序軟懲罰——驗證腳本 case2/case3/case3b 實錘）。healthPath 落點：supplier_account.configuration_json.healthPath——本機節點 `v1/health`；**Modal 節點用 `/health` 端點，以片X 實際交付對齊（pending）**。seed 腳本 L338 目前對所有渠道寫死 `healthPath: ADOBE2API_HEALTH_PATH ?? "health"`，diff 稿見 blender-node-channel.ts 註釋 §D。

### 3.4 requestSupplier 分支（adapter 層）

`supplier-adapter.ts` L108 起 `requestSupplier` 加一個分支（形狀同 filmera/metaso 分支）：

1. 取 supplier.base_url＋credential（Bearer，既有 `readCredential`）
2. 構造單幀渲染腳本（Eevee 存活配方 samples=1＋RT off 已在 blender-tools.ts 片M 落地，同構搬運）
3. `POST {base_url}/v1/execute {script, timeout_ms}`（Modal pending：片X 若走 /execute 同契約則零分支，若走自訂端點則 per-adapter）
4. 回應分揀復用 `blender-delegate.ts` 既有 collectSceneCardFromArtifacts 的 kind 分揀（png/blend/glb）

### 3.5 檔案回收（blend 上雲＋PNG 回收；本機節點零變化）

| 節點 | blend 輸入 | PNG 回收 |
|---|---|---|
| blender-local | 零變化：腳本 CWD=$BLENDER_WORK，產物落 out/（既有快照 diff 機制，片Q） | 零變化：artifacts 回 path 引用，resolveArtifactUrl 既有通道 |
| blender-modal（pending） | blend 上雲：job 請求體附 blend bytes → Modal 卷/臨時卷展開（片X 決定卷形態） | 函數返回 bytes：execute 回應 artifacts 內嵌 base64（或片X 定 multipart），adapter 統一轉 SupplierGenerationOutput |

**同構閉環的關鍵裁定**：本機節點的「回 path」與 Modal 節點的「回 bytes」在 adapter 層收斂成同一個 SupplierGenerationOutput——上層（分揀/入庫/對帳）不感知節點差異。

### 3.6 deadline 對帳

blender_bridge 屬同步 adapter（請求-回應內完成渲染，無異步 task_id 語義）：`protocolOfAdapter` 不加映射（L53 註釋明說「同步 adapter 無異步任務語義，不在此列」），provider-reconciliation 自然不管它；job 級 deadline 復用 worker 既有雙層超時＋bridge 佇列 timeout 契約（片K），429/connection lost＝瞬態重試（片L 實錘，同類連續 2 次未過停）。

---

## 4. 最小 diff 清單（全部歸後續執行片，本稿只出稿）

| # | 檔案 | 改動 | 大小 |
|---|---|---|---|
| A | `src/lib/supplier-channels.config.ts` | REGISTRY-ENTRIES 區內加 2 條節點 entry（blender-local/blender-modal；cnb 不註冊） | ~50 行 |
| B | `src/lib/generation-core/supplier-adapter.ts` | adapterType enum＋`generateWithBlenderNode` 分支 | ~80 行 |
| C | `src/lib/generation-model-catalog/catalog.ts` | 加 blender-render-eevee/cycles 兩條（claims 前置依賴） | ~20 行 |
| D | `tools/seed-generation-suppliers.ts` | supplier_account.configuration_json.healthPath 按 adapter_type 分派（blender_bridge → `v1/health`／Modal `health`） | ~5 行 |
| E | `src/lib/generation-core/blender-node-health.ts`（新） | refreshBlenderNodeHealth，adobe-health.ts 同構 | ~60 行 |
| F | worker 併發/對帳/scheduler | **零改動**（輪子全復用） | 0 |

env 三件套（記憶 supplier-channel-registry-oneclick 事故教訓）：`BLENDER_NODE_LOCAL_URL/ _TOKEN/ _ENABLED` 需同時進 VPS `.env.control-plane`（worker seed 用）與 Vercel env（站點隊列用）；`.env` 尾換行坑與 `vercel env add` 餵值配方照記憶配方節。

---

## 5. Flamenco 3 埋樁條件（照抄研究片 V 結論）

**觸發條件：節點 ≥3 且異構＋需要場景檔分發時才買。** 現階段（1-2 節點）不引調度輪子——supplier channel 派發模式（§3）已覆蓋認領/健康/溢出；Flamenco 的增量價值在場景檔自動分發與農場級併發調度，1-2 節點下是純複雜度。本節點註冊稿（label/tier/claims/health）與未來 Flamenco 農場節點一一對應，屆時把 blender-cnb 檔位換成 Flamenco worker pool 即可，註冊形狀不變。

---

## 6. 本地可驗部分與驗證

派發判定純函數（tier→priority→health→負載 排序，scheduler ORDER BY 的本地同構投影）抽在 `blender-node-channel.ts`，驗證腳本 `verify-node-dispatch.ts` 本地實跑（證據見回報）。不可本地驗的部分（Modal endpoint/health 對齊、VPS seed、隧道實彈）全部標 pending，歸片X 落位後的執行片。
