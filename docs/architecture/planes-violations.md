# 三平面违例清单（2026-09-28 快照）

> 契约见 `planes.md`。每条都附 `路径:行号` 与可重跑的 grep。排序＝**修复成本由低到高**。
> **⚑ 必先修**＝不修就会让「加供给 N=1／加管道 M≤1」失效，或正在让钱与帐本对不上。
> 成本：S＝单档 <30 行｜M＝2–4 档｜L＝要退役整条旁路。

## 修复进度（2026-09-28 本地，未 commit／未部署）

| # | 状态 | 落点 |
|---|---|---|
| V-01 | ✅ 已修 | `generation-core/cancel-service.ts` `cancelGenerationJobWithRefund` |
| V-02 | ✅ 已修（未套用到 DB） | `db/migrations/032_supplier_adapter_type_open.sql` |
| V-03 | ✅ 已修 | 价格进 claim（`unitPriceCny/priceSource`）；闸移到 `worker-service.submitWithSupplyCostGate`；openai_video fail-closed，其他协议只审白名单内模型 |
| V-04 | ✅ 已修（需重新 seed） | `tools/seed-generation-suppliers.ts` `CHANNEL_MODEL_ALIASES` → `configuration.modelAliases` |
| V-05 | ⏸ 未动 | — |
| V-06 | ✅ 已修 | `generation-core/supply-registry.ts`；假协议实测 N=2（adapter 档＋config 条目） |
| V-07 | ✅ 已修 | `generation-core/sync-charge.ts` 帐本门面；`pixai-proxy.ts` 不再碰钱 |
| V-08 | ✅ 已修（需部署生效） | 同上＋`control-plane-proxy-routes.mjs` 把 `/api/pixai/{edit,upscale,template-generations}` 代理到控面 |
| V-09 | ✅ 已修 | canvas 走 durable；LoRA／模型不收参考图／参考图格式或大小超限 三种情境保留 legacy |
| V-10～V-12 | ⏸ 未动 | V-10 外部渠道待改写成 SupplyDeclaration；V-11 待 V-10；V-12 音乐 |

附带修正：Web durable 负面词／参考图角色被静默丢弃（`generation-jobs/route.ts` 以 `web-task-prompt.ts` 组 prompt，历史显示原文）。

## 总览

| # | 违例 | 方向 | 成本 | 必先修 |
|---|---|---|---|---|
| V-01 | 取消路由直接呼叫退款 | 分发 → 帐本 | S | |
| V-02 | DB `adapter_type` CHECK 与程式码列举漂移 | 供给宣告双写 | S | ⚑ |
| V-03 | 成本闸住在供给 adapter，价格按模型名全域一价 | 生产政策落在供给 | S–M | ⚑ |
| V-04 | 共用分派写死单一供给（sub2api）特例 | 供给特化进分派 | S | |
| V-05 | new-api 视频内核在供给层绕过 supplier 表选路 | 路由落在供给 | M | |
| V-06 | 协议分派三处中央 switch | 供给增长点散在生产 | M | ⚑ |
| V-07 | `pixai-proxy` 在供给模组内扣退款，B 端同步三路由不经 job | 分发 → 供给 + 帐户 | M | ⚑ |
| V-08 | `/api/pixai/*` 三路由直接扣退款 + 直通上游 | 分发 → 帐户 + 供给 | M | ⚑ |
| V-09 | Canvas 生成打 legacy 引擎 | 分发 → legacy 旁路 | M | |
| V-10 | `/v1/images/generations` 控面关闭分支：自选队列、自扣费、外部渠道 | 分发 → 供给 + 帐户 | M | |
| V-11 | legacy 引擎 `/api/generate-images`、`/api/generate-videos` | 分发 → 供给 + 帐户 | L | |
| V-12 | 音乐工具直连三个上游、自带回落链、无帐本 | 分发(agent) → 供给 | L | |

---

## V-01 取消路由直接呼叫退款（S）
- `src/app/api/generation-jobs/[id]/route.ts:23` import `refundGenerationBilling`
- `src/app/api/generation-jobs/[id]/route.ts:111` `await refundGenerationBilling({ job: existing, executorId: ... })`
- 违反：分发不得触发帐本动作。修法：把「cancel + 条件退款」收进生产门面 `cancel()`（`job-repository.ts:834 cancelGenerationJob` 旁），路由只收 `{ cancelled, refund }`。
- `grep -n "refundGenerationBilling" "src/app/api/generation-jobs/[id]/route.ts"`

## V-02 ⚑ DB `adapter_type` CHECK 与程式码漂移（S）
- `db/migrations/014_cangyuansuanli_supplier.sql:3` CHECK 列举只到 `'openai_video'`，**没有 `blender_bridge`**
- `src/lib/generation-core/types.ts:167` 与 `src/lib/supplier-channels.config.ts:184` 已宣告 `blender_bridge`
- **[I]** 以 repo 内 migration 从零建库时，seed `blender_bridge` 供给会撞 CHECK；线上库若可用，代表曾有 repo 外手改（未验证）。每新增一种协议都要再写一次 migration——这是 N=8 的其中一档。
- 修法：CHECK 改为 `adapter_type <> ''`（或直接 DROP），合法性由程式码 adapter registry 判定。
- `grep -rn "supplier_adapter_type_check" db/migrations`

## V-03 ⚑ 成本闸住在供给层，价格按模型名全域一价（S–M）
- `src/lib/generation-core/openai-video-upstream.ts:2` import、`:158` 呼叫 `assertPaidVideoSubmissionAllowed`——**只有** `openai_video` 走闸（`paid-video-cost-gate` 唯一 importer）；metaso／filmera／newapi_video／adobe2api 视频不经此闸。
- `src/lib/generation-core/paid-video-cost-gate.ts:101-109` `PAID_VIDEO_UNIT_PRICE_CNY` 以 `supplierModelId` 为键，来源固定 xiaoyxiao（`:111`）。
- `src/lib/supplier-channels.config.ts:83-85` gway 同名模型核价 0.6／0.8／1.5／1.0，闸内记的是 0.7／0.9／1.6／1.1 ⇒ **gway 的提交在闸与回报里用错单价**。
- 为何必先修：战略就是持续加便宜供给；价格不下沉到（供给, 模型），每加一条同名更便宜的供给，闸就多说一次错的价。
- 修法：价格移到 `SupplyClaim.unitPriceCny/priceSource`；闸移到 `worker-service` 取得租约后、`adapter.submit` 前，对所有视频协议生效。
- `grep -rn "paid-video-cost-gate\"" src --include=*.ts | grep -v test`

## V-04 共用分派写死 sub2api 特例（S）
- `src/lib/generation-core/supplier-adapter.ts:96` `SUB2API_MODEL_ALIASES`（`gemini-3-image → gemini-3-pro-image`）
- `src/lib/generation-core/supplier-adapter.ts:113` `supplier.id === "env:sub2api"`
- 违反：共用分派认得某一条供给的身分。修法：别名改成 sub2api 宣告里的 `claim.supplierModelId`。
- `grep -n "env:sub2api\|SUB2API_MODEL_ALIASES" src/lib/generation-core/supplier-adapter.ts`

## V-05 new-api 视频内核在供给层绕过 supplier 表（M）
- `src/lib/generation-core/supplier-adapter.ts:278` `if (input.kind === "video_generate" && isMetasoModel(input.modelId) && isNewApiVideoKernelEnabled()) return generateWithNewApiVideo(input);`
- `:274-276` 注解自承「内核路径不依赖 supplier 表（渠道选择由 new-api Distribute 承担）」。
- 违反：生产已经租到的供给被供给层静默替换；租约、健康分、成本闸看到的是 A，实际打的是 B。修法：把 new-api 视频内核做成一条正常的 `SupplyDeclaration`（adapter `newapi_video`），用 priority／enabledEnv 切换，而不是 env 开关拦截。
- `grep -n "isNewApiVideoKernelEnabled()" src/lib/generation-core/supplier-adapter.ts`

## V-06 ⚑ 协议分派三处中央 switch（M）
- `src/lib/generation-core/supplier-adapter.ts:105-131` `requestSupplier` 依 `adapterType` 分派 submit
- `src/lib/generation-core/worker-service.ts:62-72` `protocolOfAdapter`（`default → "newapi_video"`：未知协议会被当成 new-api 去对帐）
- `src/lib/generation-core/provider-reconciliation.ts:247-262` `pollProviderTask` 依 `ProviderProtocol` 分派 poll
- `src/lib/generation-core/types.ts:167`、`:214` 两个联集型别
- 为何必先修：这 5 个点就是「新协议 N=8」的主体。修法：`SupplyAdapter` 物件自带 `protocol/submit/poll/cancel`，registry 以 `protocol` 查表；三处 switch 改成 `registry.get(adapterType)`。
- `grep -n "case \"metaso\"" src/lib/generation-core/*.ts`

## V-07 ⚑ `pixai-proxy` 在供给模组内扣退款；B 端三条同步路由不经 job（M）
- `src/lib/pixai-proxy.ts:43` 直连 `PIXAI_BASE_URL`；同档 `:152 chargeBizRequest` → `:172` `configuredGenerationBillingAdapter().reserve`、`:195 refundBizRequest` → `:198` `.refund`——**绕过 `billing-ledger`，不留 billing_operation 列**。
- 呼叫者：
  - `src/app/api/v1/images/edits/route.ts:170` charge、`:178` `proxyPixai("images/edits")`、`:195` refund
  - `src/app/api/v1/upscale/route.ts:102` charge、`:110` `proxyPixai("upscale")`、`:137` refund
  - `src/app/api/v1/template-generations/route.ts:69` charge、`:77` `proxyPixai("template-generations")`、`:94`／`:101` refund
- 附带：`src/lib/generation-core/sync-idempotency.ts:1-4` 只为这两条同步路由存在（生产目录里的分发关注点）。
- 为何必先修：这是 B 端（付费客户）的钱；没有帐本列，`reconcileGenerationBilling`／`retryStrandedRefundOperations` 救不回失败的退款。
- 修法：edits 已有 durable 分支（`edits/route.ts:120 durableEditBranch`），把 pixai 路径也改成 `submit()`；pixai 成为一条 `SupplyDeclaration`。
- `grep -rn "chargeBizRequest\|refundBizRequest\|proxyPixai(" src/app/api/v1`

## V-08 ⚑ `/api/pixai/*` 直接扣退款（M）
- `src/app/api/pixai/template-generations/route.ts:57` reserve、`:89`／`:100` refund
- `src/app/api/pixai/edit/route.ts:69` reserve、`:92`／`:103` refund
- `src/app/api/pixai/upscale/route.ts:73` reserve、`:96`／`:107` refund
- 违反：分发直呼 `image-billing.reserveImageQuota/refundImageQuota`，不经帐本；退款用 `void … .catch(() => {})` 静默吞错。修法同 V-07。
- `grep -rn "reserveImageQuota\|refundImageQuota" src/app/api/pixai`

## V-09 Canvas 生成打 legacy 引擎（M）
- `src/app/api/canvas/generate/route.ts:241`、`:247` `fetch(\`${req.nextUrl.origin}/api/generate-images\`)`
- 违反：画布是分发面，但它的生成走的是不经 job／帐本的 legacy 引擎（V-11）。Web 主入口已是 durable-first（`src/hooks/use-image-generation.ts:627` 先打 `/api/generation-jobs`，只在 `control_plane_disabled` 时 `:650` 回落）。
- 修法：画布改提交 `/api/generation-jobs`＋轮询，照 `use-image-generation.ts:627-650` 的 durable 分支。
- `grep -n "/api/generate-images" src/app/api/canvas/generate/route.ts`

## V-10 `/v1/images/generations` 控面关闭分支（M）
- `src/app/api/v1/images/generations/route.ts:11` import `generateBizImage, resolveBizEndpoints`（`src/lib/biz-image-pipeline.ts:59` `buildModelQueue`、`:103` `resolveAdobe2ApiModelId`、`:124` 直连 `fetch`）
- 同档 `:376` `reserveImageQuota`、`:446` `refundImageQuota`、`:408` `generateViaExternalChannel`（`src/lib/external-channel-adapter.ts:94`）
- 触发条件：`!generationControlPlaneEnabled()`（`:263` 起的 `if` 之后）。**[I]** 生产控面常开，此分支实际只在控面故障时执行——正是最需要帐本的时候却没有帐本；外部渠道（`external-channels.ts`）也因此只在这条分支可用。
- 修法：删分支，控面关闭时回 503（`:333` 已有 `control_plane_unavailable` 错误码）；外部渠道改写成 `SupplyDeclaration`（按 key 白名单路由的能力移到 scheduler）。
- `grep -n "reserveImageQuota(\|refundImageQuota(\|generateViaExternalChannel(" src/app/api/v1/images/generations/route.ts`

## V-11 legacy 引擎（L）
- `src/app/api/generate-images/route.ts:16` import `buildModelQueue/recordEndpoint*`（`channel-registry`）、`:41` `resolveAdobe2ApiModelId`、`:296`／`:410` 直连 `fetch(${endpoint.baseURL}…)`、`:603` reserve、`:778` refund
- `src/app/api/generate-videos/route.ts:12` `channel-registry`、`:29`／`:205` `resolveAdobe2ApiVideoModelId`、`:151` 直连 `fetch`、`:242` `buildModelQueue`、`:279` reserve、`:353` refund
- 这是一整套平行的生产平面（队列＋重试＋冷却＋计费）住在分发路由里：1174 行（811＋363）。`next.config.mjs:70` 还把 `/api/generate-images` 代理到控面，让它在控面上与 durable 引擎并跑。
- 依赖它的活呼叫者：V-09（canvas）、`use-image-generation.ts:650`（控面关闭回落）。先修 V-09，再把 `:650` 回落改成回报错误，这两条路由即可退役；`channel-registry` 退为 admin 唯读视图。
- `grep -n "buildModelQueue(\|reserveImageQuota(\|fetch(\`\${endpoint.baseURL}" src/app/api/generate-images/route.ts src/app/api/generate-videos/route.ts`

## V-12 音乐工具直连上游（L）
- `src/lib/music-tools.ts:46-64` import `music-flowmusic`／`music-lyria`／`music-yue2`
- `src/lib/music-tools.ts:577`、`:584`、`:585` 依序 `generateYue2Track`／`generateFlowMusicTrack`／`generateLyriaTrack`（回落链＝生产平面的「换供给」逻辑写在工具里；commit `e75a2e8e`「音乐全链回落 Lyria」）
- 上游 `fetch`：`src/lib/music-lyria.ts:237`、`src/lib/music-yue2.ts:245`／`:376`、`src/lib/music-flowmusic.ts:175`
- 计费：`music-tools.ts` 与三个 `music-*.ts` 内没有 reserve/refund/billing 字样。**[H]** 音乐是否刻意免费、或在 agent 会话层另计，未查证。
- 修法：三路音乐各成一条 `SupplyDeclaration`（`modality: "audio"`），`music_gen` 工具改 `submit()`＋等 job；回落链交给 scheduler 的 priority。依赖 planes.md §2.2 的 [H]（yue2 transcribe 是否另立 kind）。
- `grep -n "await generate\(Yue2\|FlowMusic\|Lyria\)Track" src/lib/music-tools.ts`

---

## 不列违例（已核对）

- `/openai/v1/**` 与 `src/lib/openai-compat/**`：只经 HTTP 打自家 `/api/v1`，不 import 生产或供给（`openai-compat/generation.ts:18-19` 仅 import `blob-backend` 取件与同目录 errors）。`openai-compat/models.ts:17` 读 `model-availability-gate` 属门面 `listCapabilities`，允许。
- `/api/v1/videos/generations`：控面开走 `submitGenerationCommand`（`route.ts:232`），关则转发控面（`:172`），不自扣费。
- `generation-core/*-upstream.ts`：无帐本／job／blob import；`openai-video-upstream.ts:271`、`:375` 提到 `persistOutputArtifact` 仅为注解。
- `src/app/api/admin/**` 使用 `channel-registry`／`sub2api`：运维面，不属分发管道。
- `src/app/api/{token,topup,usage,models,pricing,log/self,user/*,data/self}` 的 `makeProxy`（`src/lib/proxy.ts`）：代理 new-api 帐户 API，是帐户自助面，不是生成供给。

## 修复顺序（必先修的 4 条，按依赖）

1. **V-02**（S）→ 2. **V-06**（M，建 adapter registry）→ 3. **V-03**（S–M，价格进 claim、闸进 worker；依赖 2 的 registry 才能「对所有协议生效」）→ 4. **V-07＋V-08**（M，pixai 变成 SupplyDeclaration 后三条 B 端同步路由改 `submit()`）。
完成 1–3 后「新协议供给」由 N=8 降到 N=2；完成 4 后全系统 `image-billing.reserve/refund` 呼叫点只剩 `billing-relay.ts:92-93` 与 `internal/generation-billing/route.ts:53-54`（V-10、V-11 退役后成立）。
