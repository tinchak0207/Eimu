# 三平面邊界：供給／生產／分發（2026-09-28 凍結）

> 狀態：**契約凍結，未接線**。本檔只定邊界與型別；今天的違例與修復順序見 `planes-violations.md`。
> 標註：**[F]** FACT（附 `路徑:行號`，可 grep）｜**[I]** INFERENCE（由 FACT 推出，未實測）｜**[H]** HYPOTHESIS（待驗）。

## 0. 一句話

供給與管道都會越來越多，所以要讓「加一條供給」只動供給平面、「加一條管道」只動分發平面；reserve／commit／refund 全系統只在生產平面出現一次。

---

## 1. 決策一：三平面職責與單向依賴

### 1.1 平面劃分（按目錄落地）

| 平面 | 職責 | 今天的程式碼真源 | 不准知道什麼 |
|---|---|---|---|
| **分發**（Distribution） | 形態轉換（OpenAI 同步／B 端 202 異步／MCP／Web UI）、鑑權、配額與限流、把 job 狀態投影成管道形狀 | `src/app/api/v1/**`、`src/app/openai/v1/**` + `src/lib/openai-compat/**`、`src/app/api/generation-jobs/**`、`src/lib/mcp/**`、`src/lib/biz-api-keys.ts`、`src/lib/biz-openai-error.ts` | 任何供給名、上游模型名、上游 base URL、adapterType；帳本表；重試與換供給的策略 |
| **生產**（Production） | job 生命週期（`pending_billing → queued → leased → submitting → running → succeeded/failed/cancelled/refunded`）、供給選擇與租約、重試／補償／deadline、失敗分類、產物落地、**計費 reserve/commit/refund**、成本閘、對帳 | `src/lib/generation-core/{command-service,job-repository,scheduler,worker-service,billing-ledger,billing-relay,failure-classifier,artifact-service,provider-reconciliation,model-availability-gate,paid-video-cost-gate}.ts` | 管道形狀（OpenAI JSON、Next `NextResponse`、同步等待）；任何上游的 HTTP 細節（路徑、payload、輪詢格式） |
| **供給**（Supply） | 把一條「已選定供給 + 已歸一請求」變成上游呼叫：提交、輪詢、取消、把上游回應還原成產物位址 | `src/lib/generation-core/*-upstream.ts`、`newapi-adapter.ts`、`supplier-adapter.ts`（分派）、`src/lib/supplier-channels.config.ts`（宣告） | 用戶、租戶、金額、帳本、job 狀態機、其他供給的存在、管道形狀 |

**[F]** 生產核心內部已經是乾淨的單向依賴：`generation-core/{command-service,worker-service,scheduler,job-repository,billing-ledger}.ts` 沒有 import 任何 `biz-api-*`／`openai-compat`／`pixai-proxy`／`next/server`；`*-upstream.ts` 與 `newapi-adapter.ts` 沒有 import `billing-*`／`job-repository`／`database`／`image-billing`（2026-09-28 grep，零命中）。
**[F]** 違例全部集中在「繞過生產核心」的旁路上（legacy 同步引擎、pixai 同步代理、音樂工具）。見 violations。

### 1.2 資料流圖

```
                        ┌──────────────────────── 分發平面 ─────────────────────────┐
  Web UI / Canvas ──►   │ /api/generation-jobs   /api/v1/*(202)   /openai/v1/*(同步) │   ◄── new-api 中轉站 / Cherry / Dify / SDK
  Agent harness  ──►   │   鑑權 · 配額 · 限流 · 形態轉換 · 狀態投影                 │
                        └───────────────┬──────────────────────────────▲─────────────┘
                                        │ submit(command, idemKey)     │ getJob / cancel
                                        ▼  （唯一入口：生產門面）         │ （唯一出口：job 投影）
                        ┌──────────────────────── 生產平面 ─────────────────────────┐
                        │ command-service ─► billing-ledger.reserve ─► job(queued)  │
                        │ scheduler.acquireSupplierLease（依 supplier_capability）   │
                        │ worker-service ─► paid cost gate ─► supply.submit          │
                        │ failure-classifier · retry/換供給 · deadline               │
                        │ artifact-service.persistOutputArtifact                     │
                        │ billing-ledger.commit / refund  ─► billing-relay ─► 帳戶    │
                        │ provider-reconciliation ─► supply.poll                     │
                        └───────────────┬──────────────────────────────▲─────────────┘
                                        │ SupplyRequest + SupplyContext │ SupplyResult / SupplierRequestError（只報事實）
                                        ▼                               │
                        ┌──────────────────────── 供給平面 ─────────────────────────┐
                        │ adapter registry：adobe2api · openai_images · openai_video │
                        │ metaso · filmera · blender_bridge · newapi · (music*)      │
                        │ 宣告：supplier-channels.config（claims + 核價）            │
                        └────────────────────────────────────────────────────────────┘
                                        │
                                        ▼  上游（Adobe2API / PixAI bridge / sub2api / gway / xiaoyxiao / Lyria / YuE2 …）
```

### 1.3 依賴規則（可機械檢查）

1. `src/app/**` 與分發 lib **只准** import 生產門面（見 §3.2）與 `biz-api-*`／`request-trace`／`generation-model-catalog`（純目錄資料）。禁 import：`channel-registry`、`sub2api`、`admin-pools`、`pixai-proxy`、`external-channel-adapter`、`image-billing`、`generation-core/*-upstream`、`generation-core/billing-ledger`、`music-{lyria,yue2,flowmusic}`。`/admin/**` 路由不受此規則約束（它是運維面，不是分發管道）。
2. 生產平面不准 import `src/app/**`、`next/server`、`openai-compat/**`、`biz-openai-error`。
3. 供給平面不准 import `billing-*`、`image-billing`、`job-repository`、`database`、`job-events`、`blob-backend`、`artifact-service`，也不准互相 import（`newapi-adapter.ts:2` 從 `supplier-adapter` 借 `chatImageOutput` 屬於同平面內的工具共用，搬進 `supply/shared.ts` 即可）。

**[I]** 規則 1–3 用一條 `eslint no-restricted-imports`（按 glob 分組）就能守住；本輪不接線。

---

## 2. 決策二：供給契約（最小欄位集）

### 2.1 反推依據（三類現存供給的交集）

| 欄位 | 圖片（openai_images / adobe2api / newapi） | 視頻（openai_video / metaso / filmera / newapi_video） | 音樂（lyria / yue2 / flowmusic） | 結論 |
|---|---|---|---|---|
| 能力宣告 | `RegistryChannelClaim{modelId,supplierModelId,kinds}` **[F]** `supplier-channels.config.ts:11-15` | 同左 + 核價只在註解 **[F]** `supplier-channels.config.ts:83-85` | 無宣告，寫死在工具裡 **[F]** `music-tools.ts:577-585` | 宣告必須結構化，含核價 |
| 提交 | 同步 200 帶 `data[0].url/b64_json` **[F]** `supplier-adapter.ts:256-267` | 異步：拿 task id，`onProviderTaskSubmitted` 落庫 **[F]** `types.ts:228-234` | 同步回音訊 | 提交結果二選一：`done` 或 `accepted(taskId)` |
| 輪詢 | 無 | `pollXxxTask` 四份，分派寫死 **[F]** `provider-reconciliation.ts:247-262` | 無 | `poll` 為可選方法，**由 adapter 自帶**，不再中央 switch |
| 取消 | 無 | 無（只把上游 `cancelled` 當失敗讀回）**[F]** `metaso-upstream.ts:123`、`openai-video-upstream.ts:301` | 無 | `cancel` 為可選方法；缺席＝「不可取消」，生產平面按此決定是否等對帳 |
| 失敗分類 | 丟 `SupplierRequestError(status, retryAfter, raw)` **[F]** `supplier-adapter.ts:219-231` | 同左 | 自有錯誤型別 `Yue2TranscribeError` | 供給**只報事實**（HTTP 狀態、retry-after、原文），分類歸生產 `failure-classifier.ts:127` |
| 產物落地 | 回 url/base64，由 worker 落地 **[F]** `worker-service.ts:339` | 同左（需鑑權的下載在 adapter 內轉 base64）**[F]** `openai-video-upstream.ts:271` | 自行處理 | 供給**不寫 blob**，只回 `url | base64 + mime` |
| 冪等鍵 | `attemptId`（每次嘗試唯一）已傳入 **[F]** `types.ts:217-218` | 同左 | 無 | 冪等鍵＝`attemptId`，adapter 若上游支援就透傳 |

**[F]** 今天已有 4 套供給語彙並存：`SupplierRecord.adapterType`（`types.ts:167`）、`RegistryChannel.adapterType`（`supplier-channels.config.ts:28`）、`GatewayEndpoint.protocol`（`channel-registry.ts` / `sub2api.ts`，legacy 引擎）、`ExternalChannel`（`external-channels.ts:14`）。凍結後只留一套：`SupplyDeclaration` + `SupplyAdapter`。

### 2.2 契約型別草稿（凍結）

```ts
// src/lib/supply/contract.ts（草稿；本輪不建檔）
import type { GenerationKind, ProviderTaskPollResult } from "@/lib/generation-core/types";

export type Modality = "image" | "video" | "audio";

/** 一條可被路由的能力：平台模型 × 上游模型 × 核價。價格按（供給, 上游模型）定，不按模型名全域定。 */
export interface SupplyClaim {
  modelId: string;                 // 平台 catalog id
  supplierModelId: string;         // 上游模型名（同名也要寫，不再有隱式別名表）
  kinds: GenerationKind[];
  modality: Modality;
  resolutions?: string[];          // 宣告可接受檔位；是否放行由生產成本閘決定
  durationsSec?: number[];
  unitPriceCny: number;            // 已核價；無價＝不得進生產路由
  priceBasis: "per_call" | "per_second";
  priceSource: string;             // 原文 + 日期，例："GET https://www.gway.dev/api/pricing 2026-09-28 vip"
  realPerson: boolean;             // 是否支援真人
}

export interface SupplyDeclaration {
  id: string;                      // = DB supplier.id，= label
  tier: "first_party" | "managed_pool" | "relay" | "fallback";
  failureDomain: string;
  baseUrlEnv: string;
  credentialEnv: string;
  enabledEnv: string | null;
  priority: number;
  concurrency: number;
  adapter: SupplyAdapter;          // 直接引用 adapter 物件：宣告即註冊，無中央 switch
  adapterConfig?: Record<string, unknown>;  // chatImageModels / omitQualityBody 等協議旗標
  claims: SupplyClaim[];
}

/** 生產平面交給供給的東西：已歸一、已選定、已過成本閘。 */
export interface SupplyRequest {
  claim: SupplyClaim;
  kind: GenerationKind;
  prompt: string;
  size: string | null; ratio: string | null; resolution: string | null;
  quality: string | null; durationSec: number | null;
  references: Array<{ url: string; mimeType?: string; role?: string }>;
  extras: Record<string, unknown>; // controlNets / generateAudio 等；adapter 不認就忽略
}

export interface SupplyContext {
  idempotencyKey: string;          // = attemptId
  credential: string;              // 生產平面從 env 讀出後注入；adapter 不碰 process.env
  baseUrl: string;
  config: Record<string, unknown>;
  signal: AbortSignal;             // deadline 由生產平面給
}

export type SupplyOutput = {
  media: { url: string } | { base64: string };
  mimeType?: string;
  providerRequestId?: string;
  evidence?: Record<string, unknown>;
};

export type SupplySubmitResult =
  | { state: "done"; output: SupplyOutput }
  | { state: "accepted"; providerTaskId: string };   // 生產平面立刻落庫 + 排對帳

export interface SupplyAdapter {
  protocol: string;                // 全域唯一；DB adapter_type 存它（不再是 CHECK 列舉）
  submit(req: SupplyRequest, ctx: SupplyContext): Promise<SupplySubmitResult>;
  poll?(providerTaskId: string, ctx: SupplyContext): Promise<ProviderTaskPollResult>;
  cancel?(providerTaskId: string, ctx: SupplyContext): Promise<"cancelled" | "too_late">;
  // 失敗：一律 throw SupplierRequestError(status, retryAfter, raw)。分類不在這裡。
}
```

**決策依據**
- **[F]** 失敗分類已在生產：`failure-classifier.ts:127 classifySupplierFailure`；供給只需丟 `SupplierRequestError`（`supplier-adapter.ts:8`）。維持。
- **[F]** 產物落地已在生產：`artifact-service.ts:365 persistOutputArtifact`，由 `worker-service.ts:339` 呼叫；沒有任何 `*-upstream.ts` import blob 模組。維持。
- **[F]** 單價目前住在生產的成本閘且**按模型名全域一價**：`paid-video-cost-gate.ts:101-109`（來源 xiaoyxiao，`:111`）；而 gway 同名模型實際核價不同（`supplier-channels.config.ts:83-85`：0.6／0.8／1.5／1.0 vs 閘內 0.7／0.9／1.6／1.1）。⇒ 單價必須下沉到 `SupplyClaim`，按（供給, 上游模型）存。
- **[I]** `credential` 由生產注入而非 adapter 自讀 env（今天 `supplier-adapter.ts:24-28` 自讀）：這讓 adapter 可在無 env 的測試下跑，也讓「上游 key 不下發」的紅線有單一收口點。
- **[H]** 音樂三路（lyria／yue2／flowmusic）能無損套進 `submit → done`：yue2 的 transcribe（`music-yue2.ts:376`）是第二個動作，可能需要做成獨立 kind（`audio_transcribe`），待接線時驗證。

### 2.3 gway 走契約（驗收 1-a）

gway 是同協議（`openai_video`）的新供給。
- **今天** **[F]**：commit `ed47cb58` 只改 `src/lib/supplier-channels.config.ts`（+25 行）；另有 repo 外的控面 DB seed + `GWAY_*` env。成本閘「零改動」是因為上游模型名與 xiaoyxiao 同名（`supplier-channels.config.ts:72`）——**代價是 gway 的真實單價沒進閘**（上條 FACT）。
- **凍結後**：只寫一個 `SupplyDeclaration`（在 `supplier-channels.config.ts`），`adapter: openaiVideoAdapter`，四條 claim 各帶 `unitPriceCny/priceSource`。成本閘讀 claim 的價；worker 經 `declaration.adapter.submit/poll` 呼叫；對帳經 `adapter.poll`。
- **碰到的檔**：`supplier-channels.config.ts`（1 檔）。第二個檔只在協議是新的時才出現：`src/lib/supply/adapters/<protocol>.ts`。**不存在第三個檔**：分派（`supplier-adapter.ts`）、協議映射（`worker-service.ts:62`）、輪詢分派（`provider-reconciliation.ts:247`）、型別聯集（`types.ts:167,214`）、DB CHECK（`db/migrations/014_*.sql:3`）、價目表（`paid-video-cost-gate.ts:101`）在凍結後都改為**讀 registry**，不再隨供給增長。

---

## 3. 決策三：分發契約

### 3.1 管道只做兩件事

1. **形態轉換**：管道形狀 ⇄ `GenerationCommand` / job 投影。
2. **鑑權與配額**：key → tenant、模型白名單、限流、餘額預檢（`quota-precheck.enforceQuotaGate` 是唯讀預檢，允許）。

管道**不得**：選供給、知道上游模型名、扣費或退費、做重試或換供給、直接 `fetch` 任何上游。

### 3.2 生產門面（管道唯一可呼叫的東西）

```ts
// 生產平面對外只暴露這 4 個動作（今天已存在，只是沒被收成門面）
submit(command: GenerationCommand, opts: { idempotencyKey: string }): Promise<{ jobId: string }>
//   ↳ command-service.ts:52 submitGenerationCommand（內含 billing-ledger.reserve）
getJob(jobId: string, tenantId: string): Promise<JobProjection>
//   ↳ job-repository.ts:194 getGenerationJobForTenant + task-response.ts 的 taskStatus 投影
cancel(jobId: string, tenantId: string, existing: GenerationJob): Promise<{ cancelled: boolean; previousStatus; refund: { amount: number; full: boolean } | null; refundState: BillingRefundResult | null }>
//   ↳ cancel-service.ts cancelGenerationJobWithRefund（V-01 已落地 2026-09-28；existing＝取消前快照，保留原退款讀取時點語義）
listCapabilities(tenant): Promise<Array<{ modelId; kinds; available }>>
//   ↳ model-availability-gate.ts + generation-model-catalog
```

### 3.3 同步／異步在分發平面收斂

- **生產只認一種形狀：異步 job。** **[F]** `submitGenerationCommand` 只回 job；`/api/v1/*` 回 202。
- **同步＝管道在自己那層等 job。** **[F]** `/openai/v1` 就是這樣做的：`openai-compat/generation.ts:1-26` 提交到 `/api/v1/images/generations`、輪詢 `/api/v1/images/{id}`、超時回 504 且不取消任務；它**沒有 import 任何 generation-core 或供給模組**（`8cb16aea` 的 14 檔全在 `src/app/openai/**`、`src/lib/openai-compat/**`、`src/lib/biz-openai-error.ts`）。這是凍結後的**範本管道**。
- **[F]** 反例：`/v1/images/edits`、`/v1/upscale`、`/v1/template-generations` 是「同步直通上游」，不經 job（`pixai-proxy.ts:33-43`），也因此需要一份生產目錄裡的同步冪等快取 `generation-core/sync-idempotency.ts:1-4`。凍結後這三條也走 job，`sync-idempotency.ts` 隨之退役。
- **[F]** 傳輸：`/openai/v1` 走 HTTP 回自己的 `/api/v1` 而不是 in-process 呼叫，原因是 Vercel 不持有 `GENERATION_DATABASE_URL`（`openai-compat/generation.ts:3-8`）。現在它已被代理到控面執行（`next.config.mjs:93`，commit `1b49771a`）。**[I]** HTTP 回環在控面上已非必要，但它守住了「管道只碰門面」，不列違例。

### 3.4 new-api 中轉站走契約（驗收 1-b）

new-api 站長新增一個 OpenAI 類型渠道：`base_url = https://image.tinchak0207.xyz/openai`、key = 他在我方簽的 `sk-biz-…`。
- 請求路徑：new-api → `/openai/v1/images/generations`（`next.config.mjs:93` 代理到控面）→ `openai-compat/generation.ts` → `POST /api/v1/images/generations` → `submitGenerationCommand` → worker → 供給。
- 回程：`GET /api/v1/images/{id}` 輪詢 → 取件 → OpenAI 形狀。
- **我方每多一個中轉站 = 改 0 檔**（它只是既有管道的新租戶，差異全在 biz key 與白名單）。**[F]** 這條管道本身的 14 個檔案沒有一檔落在 `generation-core/**` 或供給模組。
- 不碰的第三個檔：計費（reserve 在 `command-service.ts:132/157` 內發生）、供給選擇（`scheduler.ts:9`）、上游模型名（`supplier-channels.config.ts`）——管道全程不知道。

---

## 4. 決策四：計費歸屬

- **唯一實作**：`generation-core/billing-ledger.ts`——`reserveGenerationBilling:250`、`commitGenerationBilling:355`、`refundGenerationBilling:426`、對帳 `reconcileGenerationBilling:606`、滯留退款重試 `retryStrandedRefundOperations:838`。**[F]**
- **帳戶轉接層（不是第二套計費）**：`billing-relay.ts:96 configuredGenerationBillingAdapter` → `image-billing.ts:227 reserveImageQuota` / `:265 refundImageQuota`（寫 new-api 用戶 quota）；遠端接收端 `src/app/api/internal/generation-billing/route.ts:53-54`。凍結後 `image-billing.reserve/refund` **只准**被 `billing-relay.ts` 與該 internal route 呼叫。**[F]** 今天另有 7 個呼叫點直接扣退款、不留帳本列（V-07～V-11）。
- 分發平面：不扣費、不退費。取消後的退款由門面 `cancel()` 內部觸發。**[F]** 今天 `generation-jobs/[id]/route.ts:111` 在路由裡直接呼叫 `refundGenerationBilling`（V-01）。
- 供給平面：不寫帳本、不知道金額。**[F]** 今天 `*-upstream.ts` 已符合（grep 零命中）。
- 成本閘（花的是**我們付給上游**的錢）屬生產：在 `worker-service` 選定供給後、`adapter.submit` 前執行，讀 `SupplyClaim.unitPriceCny`。**[F]** 今天它住在供給 adapter 內 `openai-video-upstream.ts:158`，只擋 `openai_video` 一種協議（`paid-video-cost-gate` 唯一 importer）（V-03）。

---

## 5. 可證偽數字

| 情境 | 今天 N／M（檔名） | 凍結後 |
|---|---|---|
| 新增一條**同協議**供給（例 gway） | **N=1**：`src/lib/supplier-channels.config.ts` **[F]** `ed47cb58`；若上游模型名是新的，另加 `src/lib/generation-core/paid-video-cost-gate.ts`（白名單 `:74` + 價目 `:101`）→ **N=2** | **N=1**：`supplier-channels.config.ts` |
| 新增一條**新協議**異步供給 | **N=8**：`src/lib/generation-core/<x>-upstream.ts`（新）、`supplier-adapter.ts`（分派 `:105-131`）、`types.ts`（`:167` adapterType、`:214` ProviderProtocol）、`worker-service.ts`（`:62` protocolOfAdapter）、`provider-reconciliation.ts`（`:247` pollProviderTask）、`src/lib/supplier-channels.config.ts`（`:28` 型別聯集 + 條目）、`db/migrations/0xx_*.sql`（`supplier_adapter_type_check`，最新定義在 `014_cangyuansuanli_supplier.sql:3`）、`paid-video-cost-gate.ts`（視頻時）**[I]**（逐一由分派點 grep 推出，未以一次真實新增驗證） | **N=2**：`src/lib/supply/adapters/<x>.ts`（新）+ `supplier-channels.config.ts` |
| 新增一條**管道**（例 `/openai/v1`） | **M=9**（非測試）：`src/app/openai/v1/{images/generations,chat/completions,models}/route.ts`、`src/lib/openai-compat/{generation,models,errors,chat-messages}.ts`、`src/lib/biz-openai-error.ts`、`next.config.mjs`（`:93`）**[F]** `8cb16aea` + `1b49771a`；其中 **管道目錄外 2 檔**（`biz-openai-error.ts`、`next.config.mjs`），**生產／供給平面 0 檔** | 管道自有目錄 + **管道目錄外 ≤1 檔**（`next.config.mjs` 代理行；部署拓撲所迫）；生產／供給 0 檔 |
| 同一管道再接一個中轉站租戶（new-api 站） | **M=0** **[I]**（只需簽 biz key） | M=0 |

---

## 6. 被否方案

| # | 方案 | 否決理由 |
|---|---|---|
| R1 | **new-api 當唯一供給平面**（所有供給先接進 new-api，Emu 只接 new-api 一個 adapter） | **[F]** new-api 任務內核只覆蓋 metaso 系視頻，其他視頻供給「在 new-api 無對應視頻渠道，誤灌會全量失敗」（`supplier-adapter.ts:274-276` 註解）；adobe2api／blender_bridge／音樂都不是 OpenAI 形狀。**[I]** 成本閘與核價真源會跑到 repo 外，違反「付費上游呼叫硬閘」要求的可審計。保留為**一個** adapter（`newapi`），不當平面。 |
| R2 | 每條管道自帶 reserve/refund（今天 legacy 與 pixai 路由的做法） | **[F]** 已有 7 處直接扣退款、不經帳本（violations V-07～V-11）；沒有 billing_operation 列就無法對帳、無法 `retryStrandedRefundOperations`。每加一條管道就多一處錢的漏洞。 |
| R3 | 生產平面同時提供同步與異步兩種 API | 兩套生命週期＝兩套補償語義。**[F]** 同步在 Vercel Hobby 60s 硬上限下會被殺（`next.config.mjs:87-92` 註解）；`/openai/v1` 已證明同步可以純在分發層以「等 job」實現。 |
| R4 | 供給契約按模態拆三個介面（ImageSupply/VideoSupply/MusicSupply） | 違反「禁止為單一供給特化」；三類的差異只在「同步／異步」與「產物 mime」，`SupplySubmitResult` 二選一 + `modality` 欄位已覆蓋。 |
| R5 | 以 HTTP 當平面邊界（三平面拆三個服務） | **[F]** 生產與供給同在控面一個 Next standalone 進程（`next.config.mjs:6` `output: "standalone"`、`:60-61` 註解）；拆服務只增加一跳與部署面，邊界靠 import 規則即可守住（§1.3）。HTTP 只在部署拓撲逼迫時使用（Vercel ↔ 控面）。 |
| R6 | 保留 `channel-registry` 作為生產的路由真源、`supplier` 表作為 worker 真源（雙真源並存） | **[F]** 兩者今天各自決定隊列：legacy 引擎用 `buildModelQueue`（`generate-images/route.ts:556`），durable 引擎用 `supplier_capability`（`job-repository.ts:279`）。`channel-registry.ts:1-15` 自己就寫明它要消滅「各說各話」——凍結後只留 durable 一套，`channel-registry` 退為 admin 唯讀視圖的資料源。 |
