# 三平面边界：供给／生产／分发（2026-09-28 冻结）

> 状态：**契约冻结，未接线**。本档只定边界与型别；今天的违例与修复顺序见 `planes-violations.md`。
> 标注：**[F]** FACT（附 `路径:行号`，可 grep）｜**[I]** INFERENCE（由 FACT 推出，未实测）｜**[H]** HYPOTHESIS（待验）。

## 0. 一句话

供给与管道都会越来越多，所以要让「加一条供给」只动供给平面、「加一条管道」只动分发平面；reserve／commit／refund 全系统只在生产平面出现一次。

---

## 1. 决策一：三平面职责与单向依赖

### 1.1 平面划分（按目录落地）

| 平面 | 职责 | 今天的程式码真源 | 不准知道什么 |
|---|---|---|---|
| **分发**（Distribution） | 形态转换（OpenAI 同步／B 端 202 异步／MCP／Web UI）、鉴权、配额与限流、把 job 状态投影成管道形状 | `src/app/api/v1/**`、`src/app/openai/v1/**` + `src/lib/openai-compat/**`、`src/app/api/generation-jobs/**`、`src/lib/mcp/**`、`src/lib/biz-api-keys.ts`、`src/lib/biz-openai-error.ts` | 任何供给名、上游模型名、上游 base URL、adapterType；帐本表；重试与换供给的策略 |
| **生产**（Production） | job 生命周期（`pending_billing → queued → leased → submitting → running → succeeded/failed/cancelled/refunded`）、供给选择与租约、重试／补偿／deadline、失败分类、产物落地、**计费 reserve/commit/refund**、成本闸、对帐 | `src/lib/generation-core/{command-service,job-repository,scheduler,worker-service,billing-ledger,billing-relay,failure-classifier,artifact-service,provider-reconciliation,model-availability-gate,paid-video-cost-gate}.ts` | 管道形状（OpenAI JSON、Next `NextResponse`、同步等待）；任何上游的 HTTP 细节（路径、payload、轮询格式） |
| **供给**（Supply） | 把一条「已选定供给 + 已归一请求」变成上游呼叫：提交、轮询、取消、把上游回应还原成产物位址 | `src/lib/generation-core/*-upstream.ts`、`newapi-adapter.ts`、`supplier-adapter.ts`（分派）、`src/lib/supplier-channels.config.ts`（宣告） | 用户、租户、金额、帐本、job 状态机、其他供给的存在、管道形状 |

**[F]** 生产核心内部已经是干净的单向依赖：`generation-core/{command-service,worker-service,scheduler,job-repository,billing-ledger}.ts` 没有 import 任何 `biz-api-*`／`openai-compat`／`pixai-proxy`／`next/server`；`*-upstream.ts` 与 `newapi-adapter.ts` 没有 import `billing-*`／`job-repository`／`database`／`image-billing`（2026-09-28 grep，零命中）。
**[F]** 违例全部集中在「绕过生产核心」的旁路上（legacy 同步引擎、pixai 同步代理、音乐工具）。见 violations。

### 1.2 资料流图

```
                        ┌──────────────────────── 分发平面 ─────────────────────────┐
  Web UI / Canvas ──►   │ /api/generation-jobs   /api/v1/*(202)   /openai/v1/*(同步) │   ◄── new-api 中转站 / Cherry / Dify / SDK
  Agent harness  ──►   │   鉴权 · 配额 · 限流 · 形态转换 · 状态投影                 │
                        └───────────────┬──────────────────────────────▲─────────────┘
                                        │ submit(command, idemKey)     │ getJob / cancel
                                        ▼  （唯一入口：生产门面）         │ （唯一出口：job 投影）
                        ┌──────────────────────── 生产平面 ─────────────────────────┐
                        │ command-service ─► billing-ledger.reserve ─► job(queued)  │
                        │ scheduler.acquireSupplierLease（依 supplier_capability）   │
                        │ worker-service ─► paid cost gate ─► supply.submit          │
                        │ failure-classifier · retry/换供给 · deadline               │
                        │ artifact-service.persistOutputArtifact                     │
                        │ billing-ledger.commit / refund  ─► billing-relay ─► 帐户    │
                        │ provider-reconciliation ─► supply.poll                     │
                        └───────────────┬──────────────────────────────▲─────────────┘
                                        │ SupplyRequest + SupplyContext │ SupplyResult / SupplierRequestError（只报事实）
                                        ▼                               │
                        ┌──────────────────────── 供给平面 ─────────────────────────┐
                        │ adapter registry：adobe2api · openai_images · openai_video │
                        │ metaso · filmera · blender_bridge · newapi · (music*)      │
                        │ 宣告：supplier-channels.config（claims + 核价）            │
                        └────────────────────────────────────────────────────────────┘
                                        │
                                        ▼  上游（Adobe2API / PixAI bridge / sub2api / gway / xiaoyxiao / Lyria / YuE2 …）
```

### 1.3 依赖规则（可机械检查）

1. `src/app/**` 与分发 lib **只准** import 生产门面（见 §3.2）与 `biz-api-*`／`request-trace`／`generation-model-catalog`（纯目录资料）。禁 import：`channel-registry`、`sub2api`、`admin-pools`、`pixai-proxy`、`external-channel-adapter`、`image-billing`、`generation-core/*-upstream`、`generation-core/billing-ledger`、`music-{lyria,yue2,flowmusic}`。`/admin/**` 路由不受此规则约束（它是运维面，不是分发管道）。
2. 生产平面不准 import `src/app/**`、`next/server`、`openai-compat/**`、`biz-openai-error`。
3. 供给平面不准 import `billing-*`、`image-billing`、`job-repository`、`database`、`job-events`、`blob-backend`、`artifact-service`，也不准互相 import（`newapi-adapter.ts:2` 从 `supplier-adapter` 借 `chatImageOutput` 属于同平面内的工具共用，搬进 `supply/shared.ts` 即可）。

**[I]** 规则 1–3 用一条 `eslint no-restricted-imports`（按 glob 分组）就能守住；本轮不接线。

---

## 2. 决策二：供给契约（最小栏位集）

### 2.1 反推依据（三类现存供给的交集）

| 栏位 | 图片（openai_images / adobe2api / newapi） | 视频（openai_video / metaso / filmera / newapi_video） | 音乐（lyria / yue2 / flowmusic） | 结论 |
|---|---|---|---|---|
| 能力宣告 | `RegistryChannelClaim{modelId,supplierModelId,kinds}` **[F]** `supplier-channels.config.ts:11-15` | 同左 + 核价只在注解 **[F]** `supplier-channels.config.ts:83-85` | 无宣告，写死在工具里 **[F]** `music-tools.ts:577-585` | 宣告必须结构化，含核价 |
| 提交 | 同步 200 带 `data[0].url/b64_json` **[F]** `supplier-adapter.ts:256-267` | 异步：拿 task id，`onProviderTaskSubmitted` 落库 **[F]** `types.ts:228-234` | 同步回音讯 | 提交结果二选一：`done` 或 `accepted(taskId)` |
| 轮询 | 无 | `pollXxxTask` 四份，分派写死 **[F]** `provider-reconciliation.ts:247-262` | 无 | `poll` 为可选方法，**由 adapter 自带**，不再中央 switch |
| 取消 | 无 | 无（只把上游 `cancelled` 当失败读回）**[F]** `metaso-upstream.ts:123`、`openai-video-upstream.ts:301` | 无 | `cancel` 为可选方法；缺席＝「不可取消」，生产平面按此决定是否等对帐 |
| 失败分类 | 丢 `SupplierRequestError(status, retryAfter, raw)` **[F]** `supplier-adapter.ts:219-231` | 同左 | 自有错误型别 `Yue2TranscribeError` | 供给**只报事实**（HTTP 状态、retry-after、原文），分类归生产 `failure-classifier.ts:127` |
| 产物落地 | 回 url/base64，由 worker 落地 **[F]** `worker-service.ts:339` | 同左（需鉴权的下载在 adapter 内转 base64）**[F]** `openai-video-upstream.ts:271` | 自行处理 | 供给**不写 blob**，只回 `url | base64 + mime` |
| 幂等键 | `attemptId`（每次尝试唯一）已传入 **[F]** `types.ts:217-218` | 同左 | 无 | 幂等键＝`attemptId`，adapter 若上游支援就透传 |

**[F]** 今天已有 4 套供给语汇并存：`SupplierRecord.adapterType`（`types.ts:167`）、`RegistryChannel.adapterType`（`supplier-channels.config.ts:28`）、`GatewayEndpoint.protocol`（`channel-registry.ts` / `sub2api.ts`，legacy 引擎）、`ExternalChannel`（`external-channels.ts:14`）。冻结后只留一套：`SupplyDeclaration` + `SupplyAdapter`。

### 2.2 契约型别草稿（冻结）

```ts
// src/lib/supply/contract.ts（草稿；本轮不建档）
import type { GenerationKind, ProviderTaskPollResult } from "@/lib/generation-core/types";

export type Modality = "image" | "video" | "audio";

/** 一条可被路由的能力：平台模型 × 上游模型 × 核价。价格按（供给, 上游模型）定，不按模型名全域定。 */
export interface SupplyClaim {
  modelId: string;                 // 平台 catalog id
  supplierModelId: string;         // 上游模型名（同名也要写，不再有隐式别名表）
  kinds: GenerationKind[];
  modality: Modality;
  resolutions?: string[];          // 宣告可接受档位；是否放行由生产成本闸决定
  durationsSec?: number[];
  unitPriceCny: number;            // 已核价；无价＝不得进生产路由
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
  adapter: SupplyAdapter;          // 直接引用 adapter 物件：宣告即注册，无中央 switch
  adapterConfig?: Record<string, unknown>;  // chatImageModels / omitQualityBody 等协议旗标
  claims: SupplyClaim[];
}

/** 生产平面交给供给的东西：已归一、已选定、已过成本闸。 */
export interface SupplyRequest {
  claim: SupplyClaim;
  kind: GenerationKind;
  prompt: string;
  size: string | null; ratio: string | null; resolution: string | null;
  quality: string | null; durationSec: number | null;
  references: Array<{ url: string; mimeType?: string; role?: string }>;
  extras: Record<string, unknown>; // controlNets / generateAudio 等；adapter 不认就忽略
}

export interface SupplyContext {
  idempotencyKey: string;          // = attemptId
  credential: string;              // 生产平面从 env 读出后注入；adapter 不碰 process.env
  baseUrl: string;
  config: Record<string, unknown>;
  signal: AbortSignal;             // deadline 由生产平面给
}

export type SupplyOutput = {
  media: { url: string } | { base64: string };
  mimeType?: string;
  providerRequestId?: string;
  evidence?: Record<string, unknown>;
};

export type SupplySubmitResult =
  | { state: "done"; output: SupplyOutput }
  | { state: "accepted"; providerTaskId: string };   // 生产平面立刻落库 + 排对帐

export interface SupplyAdapter {
  protocol: string;                // 全域唯一；DB adapter_type 存它（不再是 CHECK 列举）
  submit(req: SupplyRequest, ctx: SupplyContext): Promise<SupplySubmitResult>;
  poll?(providerTaskId: string, ctx: SupplyContext): Promise<ProviderTaskPollResult>;
  cancel?(providerTaskId: string, ctx: SupplyContext): Promise<"cancelled" | "too_late">;
  // 失败：一律 throw SupplierRequestError(status, retryAfter, raw)。分类不在这里。
}
```

**决策依据**
- **[F]** 失败分类已在生产：`failure-classifier.ts:127 classifySupplierFailure`；供给只需丢 `SupplierRequestError`（`supplier-adapter.ts:8`）。维持。
- **[F]** 产物落地已在生产：`artifact-service.ts:365 persistOutputArtifact`，由 `worker-service.ts:339` 呼叫；没有任何 `*-upstream.ts` import blob 模组。维持。
- **[F]** 单价目前住在生产的成本闸且**按模型名全域一价**：`paid-video-cost-gate.ts:101-109`（来源 xiaoyxiao，`:111`）；而 gway 同名模型实际核价不同（`supplier-channels.config.ts:83-85`：0.6／0.8／1.5／1.0 vs 闸内 0.7／0.9／1.6／1.1）。⇒ 单价必须下沉到 `SupplyClaim`，按（供给, 上游模型）存。
- **[I]** `credential` 由生产注入而非 adapter 自读 env（今天 `supplier-adapter.ts:24-28` 自读）：这让 adapter 可在无 env 的测试下跑，也让「上游 key 不下发」的红线有单一收口点。
- **[H]** 音乐三路（lyria／yue2／flowmusic）能无损套进 `submit → done`：yue2 的 transcribe（`music-yue2.ts:376`）是第二个动作，可能需要做成独立 kind（`audio_transcribe`），待接线时验证。

### 2.3 gway 走契约（验收 1-a）

gway 是同协议（`openai_video`）的新供给。
- **今天** **[F]**：commit `ed47cb58` 只改 `src/lib/supplier-channels.config.ts`（+25 行）；另有 repo 外的控面 DB seed + `GWAY_*` env。成本闸「零改动」是因为上游模型名与 xiaoyxiao 同名（`supplier-channels.config.ts:72`）——**代价是 gway 的真实单价没进闸**（上条 FACT）。
- **冻结后**：只写一个 `SupplyDeclaration`（在 `supplier-channels.config.ts`），`adapter: openaiVideoAdapter`，四条 claim 各带 `unitPriceCny/priceSource`。成本闸读 claim 的价；worker 经 `declaration.adapter.submit/poll` 呼叫；对帐经 `adapter.poll`。
- **碰到的档**：`supplier-channels.config.ts`（1 档）。第二个档只在协议是新的时才出现：`src/lib/supply/adapters/<protocol>.ts`。**不存在第三个档**：分派（`supplier-adapter.ts`）、协议映射（`worker-service.ts:62`）、轮询分派（`provider-reconciliation.ts:247`）、型别联集（`types.ts:167,214`）、DB CHECK（`db/migrations/014_*.sql:3`）、价目表（`paid-video-cost-gate.ts:101`）在冻结后都改为**读 registry**，不再随供给增长。

---

## 3. 决策三：分发契约

### 3.1 管道只做两件事

1. **形态转换**：管道形状 ⇄ `GenerationCommand` / job 投影。
2. **鉴权与配额**：key → tenant、模型白名单、限流、余额预检（`quota-precheck.enforceQuotaGate` 是唯读预检，允许）。

管道**不得**：选供给、知道上游模型名、扣费或退费、做重试或换供给、直接 `fetch` 任何上游。

### 3.2 生产门面（管道唯一可呼叫的东西）

```ts
// 生产平面对外只暴露这 4 个动作（今天已存在，只是没被收成门面）
submit(command: GenerationCommand, opts: { idempotencyKey: string }): Promise<{ jobId: string }>
//   ↳ command-service.ts:52 submitGenerationCommand（内含 billing-ledger.reserve）
getJob(jobId: string, tenantId: string): Promise<JobProjection>
//   ↳ job-repository.ts:194 getGenerationJobForTenant + task-response.ts 的 taskStatus 投影
cancel(jobId: string, tenantId: string, existing: GenerationJob): Promise<{ cancelled: boolean; previousStatus; refund: { amount: number; full: boolean } | null; refundState: BillingRefundResult | null }>
//   ↳ cancel-service.ts cancelGenerationJobWithRefund（V-01 已落地 2026-09-28；existing＝取消前快照，保留原退款读取时点语义）
listCapabilities(tenant): Promise<Array<{ modelId; kinds; available }>>
//   ↳ model-availability-gate.ts + generation-model-catalog
```

### 3.3 同步／异步在分发平面收敛

- **生产只认一种形状：异步 job。** **[F]** `submitGenerationCommand` 只回 job；`/api/v1/*` 回 202。
- **同步＝管道在自己那层等 job。** **[F]** `/openai/v1` 就是这样做的：`openai-compat/generation.ts:1-26` 提交到 `/api/v1/images/generations`、轮询 `/api/v1/images/{id}`、超时回 504 且不取消任务；它**没有 import 任何 generation-core 或供给模组**（`8cb16aea` 的 14 档全在 `src/app/openai/**`、`src/lib/openai-compat/**`、`src/lib/biz-openai-error.ts`）。这是冻结后的**范本管道**。
- **[F]** 反例：`/v1/images/edits`、`/v1/upscale`、`/v1/template-generations` 是「同步直通上游」，不经 job（`pixai-proxy.ts:33-43`），也因此需要一份生产目录里的同步幂等快取 `generation-core/sync-idempotency.ts:1-4`。冻结后这三条也走 job，`sync-idempotency.ts` 随之退役。
- **[F]** 传输：`/openai/v1` 走 HTTP 回自己的 `/api/v1` 而不是 in-process 呼叫，原因是 Vercel 不持有 `GENERATION_DATABASE_URL`（`openai-compat/generation.ts:3-8`）。现在它已被代理到控面执行（`next.config.mjs:93`，commit `1b49771a`）。**[I]** HTTP 回环在控面上已非必要，但它守住了「管道只碰门面」，不列违例。

### 3.4 new-api 中转站走契约（验收 1-b）

new-api 站长新增一个 OpenAI 类型渠道：`base_url = https://image.tinchak0207.xyz/openai`、key = 他在我方签的 `sk-biz-…`。
- 请求路径：new-api → `/openai/v1/images/generations`（`next.config.mjs:93` 代理到控面）→ `openai-compat/generation.ts` → `POST /api/v1/images/generations` → `submitGenerationCommand` → worker → 供给。
- 回程：`GET /api/v1/images/{id}` 轮询 → 取件 → OpenAI 形状。
- **我方每多一个中转站 = 改 0 档**（它只是既有管道的新租户，差异全在 biz key 与白名单）。**[F]** 这条管道本身的 14 个档案没有一档落在 `generation-core/**` 或供给模组。
- 不碰的第三个档：计费（reserve 在 `command-service.ts:132/157` 内发生）、供给选择（`scheduler.ts:9`）、上游模型名（`supplier-channels.config.ts`）——管道全程不知道。

---

## 4. 决策四：计费归属

- **唯一实作**：`generation-core/billing-ledger.ts`——`reserveGenerationBilling:250`、`commitGenerationBilling:355`、`refundGenerationBilling:426`、对帐 `reconcileGenerationBilling:606`、滞留退款重试 `retryStrandedRefundOperations:838`。**[F]**
- **帐户转接层（不是第二套计费）**：`billing-relay.ts:96 configuredGenerationBillingAdapter` → `image-billing.ts:227 reserveImageQuota` / `:265 refundImageQuota`（写 new-api 用户 quota）；远端接收端 `src/app/api/internal/generation-billing/route.ts:53-54`。冻结后 `image-billing.reserve/refund` **只准**被 `billing-relay.ts` 与该 internal route 呼叫。**[F]** 今天另有 7 个呼叫点直接扣退款、不留帐本列（V-07～V-11）。
- 分发平面：不扣费、不退费。取消后的退款由门面 `cancel()` 内部触发。**[F]** 今天 `generation-jobs/[id]/route.ts:111` 在路由里直接呼叫 `refundGenerationBilling`（V-01）。
- 供给平面：不写帐本、不知道金额。**[F]** 今天 `*-upstream.ts` 已符合（grep 零命中）。
- 成本闸（花的是**我们付给上游**的钱）属生产：在 `worker-service` 选定供给后、`adapter.submit` 前执行，读 `SupplyClaim.unitPriceCny`。**[F]** 今天它住在供给 adapter 内 `openai-video-upstream.ts:158`，只挡 `openai_video` 一种协议（`paid-video-cost-gate` 唯一 importer）（V-03）。

---

## 5. 可证伪数字

| 情境 | 今天 N／M（档名） | 冻结后 |
|---|---|---|
| 新增一条**同协议**供给（例 gway） | **N=1**：`src/lib/supplier-channels.config.ts` **[F]** `ed47cb58`；若上游模型名是新的，另加 `src/lib/generation-core/paid-video-cost-gate.ts`（白名单 `:74` + 价目 `:101`）→ **N=2** | **N=1**：`supplier-channels.config.ts` |
| 新增一条**新协议**异步供给 | **N=8**：`src/lib/generation-core/<x>-upstream.ts`（新）、`supplier-adapter.ts`（分派 `:105-131`）、`types.ts`（`:167` adapterType、`:214` ProviderProtocol）、`worker-service.ts`（`:62` protocolOfAdapter）、`provider-reconciliation.ts`（`:247` pollProviderTask）、`src/lib/supplier-channels.config.ts`（`:28` 型别联集 + 条目）、`db/migrations/0xx_*.sql`（`supplier_adapter_type_check`，最新定义在 `014_cangyuansuanli_supplier.sql:3`）、`paid-video-cost-gate.ts`（视频时）**[I]**（逐一由分派点 grep 推出，未以一次真实新增验证） | **N=2**：`src/lib/supply/adapters/<x>.ts`（新）+ `supplier-channels.config.ts` |
| 新增一条**管道**（例 `/openai/v1`） | **M=9**（非测试）：`src/app/openai/v1/{images/generations,chat/completions,models}/route.ts`、`src/lib/openai-compat/{generation,models,errors,chat-messages}.ts`、`src/lib/biz-openai-error.ts`、`next.config.mjs`（`:93`）**[F]** `8cb16aea` + `1b49771a`；其中 **管道目录外 2 档**（`biz-openai-error.ts`、`next.config.mjs`），**生产／供给平面 0 档** | 管道自有目录 + **管道目录外 ≤1 档**（`next.config.mjs` 代理行；部署拓扑所迫）；生产／供给 0 档 |
| 同一管道再接一个中转站租户（new-api 站） | **M=0** **[I]**（只需签 biz key） | M=0 |

---

## 6. 被否方案

| # | 方案 | 否决理由 |
|---|---|---|
| R1 | **new-api 当唯一供给平面**（所有供给先接进 new-api，Emu 只接 new-api 一个 adapter） | **[F]** new-api 任务内核只覆盖 metaso 系视频，其他视频供给「在 new-api 无对应视频渠道，误灌会全量失败」（`supplier-adapter.ts:274-276` 注解）；adobe2api／blender_bridge／音乐都不是 OpenAI 形状。**[I]** 成本闸与核价真源会跑到 repo 外，违反「付费上游呼叫硬闸」要求的可审计。保留为**一个** adapter（`newapi`），不当平面。 |
| R2 | 每条管道自带 reserve/refund（今天 legacy 与 pixai 路由的做法） | **[F]** 已有 7 处直接扣退款、不经帐本（violations V-07～V-11）；没有 billing_operation 列就无法对帐、无法 `retryStrandedRefundOperations`。每加一条管道就多一处钱的漏洞。 |
| R3 | 生产平面同时提供同步与异步两种 API | 两套生命周期＝两套补偿语义。**[F]** 同步在 Vercel Hobby 60s 硬上限下会被杀（`next.config.mjs:87-92` 注解）；`/openai/v1` 已证明同步可以纯在分发层以「等 job」实现。 |
| R4 | 供给契约按模态拆三个介面（ImageSupply/VideoSupply/MusicSupply） | 违反「禁止为单一供给特化」；三类的差异只在「同步／异步」与「产物 mime」，`SupplySubmitResult` 二选一 + `modality` 栏位已覆盖。 |
| R5 | 以 HTTP 当平面边界（三平面拆三个服务） | **[F]** 生产与供给同在控面一个 Next standalone 进程（`next.config.mjs:6` `output: "standalone"`、`:60-61` 注解）；拆服务只增加一跳与部署面，边界靠 import 规则即可守住（§1.3）。HTTP 只在部署拓扑逼迫时使用（Vercel ↔ 控面）。 |
| R6 | 保留 `channel-registry` 作为生产的路由真源、`supplier` 表作为 worker 真源（双真源并存） | **[F]** 两者今天各自决定队列：legacy 引擎用 `buildModelQueue`（`generate-images/route.ts:556`），durable 引擎用 `supplier_capability`（`job-repository.ts:279`）。`channel-registry.ts:1-15` 自己就写明它要消灭「各说各话」——冻结后只留 durable 一套，`channel-registry` 退为 admin 唯读视图的资料源。 |
