# 三平面違例清單（2026-09-28 快照）

> 契約見 `planes.md`。每條都附 `路徑:行號` 與可重跑的 grep。排序＝**修復成本由低到高**。
> **⚑ 必先修**＝不修就會讓「加供給 N=1／加管道 M≤1」失效，或正在讓錢與帳本對不上。
> 成本：S＝單檔 <30 行｜M＝2–4 檔｜L＝要退役整條旁路。

## 修復進度（2026-09-28 本地，未 commit／未部署）

| # | 狀態 | 落點 |
|---|---|---|
| V-01 | ✅ 已修 | `generation-core/cancel-service.ts` `cancelGenerationJobWithRefund` |
| V-02 | ✅ 已修（未套用到 DB） | `db/migrations/032_supplier_adapter_type_open.sql` |
| V-03 | ✅ 已修 | 價格進 claim（`unitPriceCny/priceSource`）；閘移到 `worker-service.submitWithSupplyCostGate`；openai_video fail-closed，其他協議只審白名單內模型 |
| V-04 | ✅ 已修（需重新 seed） | `tools/seed-generation-suppliers.ts` `CHANNEL_MODEL_ALIASES` → `configuration.modelAliases` |
| V-05 | ⏸ 未動 | — |
| V-06 | ✅ 已修 | `generation-core/supply-registry.ts`；假協議實測 N=2（adapter 檔＋config 條目） |
| V-07 | ✅ 已修 | `generation-core/sync-charge.ts` 帳本門面；`pixai-proxy.ts` 不再碰錢 |
| V-08 | ✅ 已修（需部署生效） | 同上＋`control-plane-proxy-routes.mjs` 把 `/api/pixai/{edit,upscale,template-generations}` 代理到控面 |
| V-09 | ✅ 已修 | canvas 走 durable；LoRA／模型不收參考圖／參考圖格式或大小超限 三種情境保留 legacy |
| V-10～V-12 | ⏸ 未動 | V-10 外部渠道待改寫成 SupplyDeclaration；V-11 待 V-10；V-12 音樂 |

附帶修正：Web durable 負面詞／參考圖角色被靜默丟棄（`generation-jobs/route.ts` 以 `web-task-prompt.ts` 組 prompt，歷史顯示原文）。

## 總覽

| # | 違例 | 方向 | 成本 | 必先修 |
|---|---|---|---|---|
| V-01 | 取消路由直接呼叫退款 | 分發 → 帳本 | S | |
| V-02 | DB `adapter_type` CHECK 與程式碼列舉漂移 | 供給宣告雙寫 | S | ⚑ |
| V-03 | 成本閘住在供給 adapter，價格按模型名全域一價 | 生產政策落在供給 | S–M | ⚑ |
| V-04 | 共用分派寫死單一供給（sub2api）特例 | 供給特化進分派 | S | |
| V-05 | new-api 視頻內核在供給層繞過 supplier 表選路 | 路由落在供給 | M | |
| V-06 | 協議分派三處中央 switch | 供給增長點散在生產 | M | ⚑ |
| V-07 | `pixai-proxy` 在供給模組內扣退款，B 端同步三路由不經 job | 分發 → 供給 + 帳戶 | M | ⚑ |
| V-08 | `/api/pixai/*` 三路由直接扣退款 + 直通上游 | 分發 → 帳戶 + 供給 | M | ⚑ |
| V-09 | Canvas 生成打 legacy 引擎 | 分發 → legacy 旁路 | M | |
| V-10 | `/v1/images/generations` 控面關閉分支：自選隊列、自扣費、外部渠道 | 分發 → 供給 + 帳戶 | M | |
| V-11 | legacy 引擎 `/api/generate-images`、`/api/generate-videos` | 分發 → 供給 + 帳戶 | L | |
| V-12 | 音樂工具直連三個上游、自帶回落鏈、無帳本 | 分發(agent) → 供給 | L | |

---

## V-01 取消路由直接呼叫退款（S）
- `src/app/api/generation-jobs/[id]/route.ts:23` import `refundGenerationBilling`
- `src/app/api/generation-jobs/[id]/route.ts:111` `await refundGenerationBilling({ job: existing, executorId: ... })`
- 違反：分發不得觸發帳本動作。修法：把「cancel + 條件退款」收進生產門面 `cancel()`（`job-repository.ts:834 cancelGenerationJob` 旁），路由只收 `{ cancelled, refund }`。
- `grep -n "refundGenerationBilling" "src/app/api/generation-jobs/[id]/route.ts"`

## V-02 ⚑ DB `adapter_type` CHECK 與程式碼漂移（S）
- `db/migrations/014_cangyuansuanli_supplier.sql:3` CHECK 列舉只到 `'openai_video'`，**沒有 `blender_bridge`**
- `src/lib/generation-core/types.ts:167` 與 `src/lib/supplier-channels.config.ts:184` 已宣告 `blender_bridge`
- **[I]** 以 repo 內 migration 從零建庫時，seed `blender_bridge` 供給會撞 CHECK；線上庫若可用，代表曾有 repo 外手改（未驗證）。每新增一種協議都要再寫一次 migration——這是 N=8 的其中一檔。
- 修法：CHECK 改為 `adapter_type <> ''`（或直接 DROP），合法性由程式碼 adapter registry 判定。
- `grep -rn "supplier_adapter_type_check" db/migrations`

## V-03 ⚑ 成本閘住在供給層，價格按模型名全域一價（S–M）
- `src/lib/generation-core/openai-video-upstream.ts:2` import、`:158` 呼叫 `assertPaidVideoSubmissionAllowed`——**只有** `openai_video` 走閘（`paid-video-cost-gate` 唯一 importer）；metaso／filmera／newapi_video／adobe2api 視頻不經此閘。
- `src/lib/generation-core/paid-video-cost-gate.ts:101-109` `PAID_VIDEO_UNIT_PRICE_CNY` 以 `supplierModelId` 為鍵，來源固定 xiaoyxiao（`:111`）。
- `src/lib/supplier-channels.config.ts:83-85` gway 同名模型核價 0.6／0.8／1.5／1.0，閘內記的是 0.7／0.9／1.6／1.1 ⇒ **gway 的提交在閘與回報裡用錯單價**。
- 為何必先修：戰略就是持續加便宜供給；價格不下沉到（供給, 模型），每加一條同名更便宜的供給，閘就多說一次錯的價。
- 修法：價格移到 `SupplyClaim.unitPriceCny/priceSource`；閘移到 `worker-service` 取得租約後、`adapter.submit` 前，對所有視頻協議生效。
- `grep -rn "paid-video-cost-gate\"" src --include=*.ts | grep -v test`

## V-04 共用分派寫死 sub2api 特例（S）
- `src/lib/generation-core/supplier-adapter.ts:96` `SUB2API_MODEL_ALIASES`（`gemini-3-image → gemini-3-pro-image`）
- `src/lib/generation-core/supplier-adapter.ts:113` `supplier.id === "env:sub2api"`
- 違反：共用分派認得某一條供給的身分。修法：別名改成 sub2api 宣告裡的 `claim.supplierModelId`。
- `grep -n "env:sub2api\|SUB2API_MODEL_ALIASES" src/lib/generation-core/supplier-adapter.ts`

## V-05 new-api 視頻內核在供給層繞過 supplier 表（M）
- `src/lib/generation-core/supplier-adapter.ts:278` `if (input.kind === "video_generate" && isMetasoModel(input.modelId) && isNewApiVideoKernelEnabled()) return generateWithNewApiVideo(input);`
- `:274-276` 註解自承「內核路徑不依賴 supplier 表（渠道選擇由 new-api Distribute 承擔）」。
- 違反：生產已經租到的供給被供給層靜默替換；租約、健康分、成本閘看到的是 A，實際打的是 B。修法：把 new-api 視頻內核做成一條正常的 `SupplyDeclaration`（adapter `newapi_video`），用 priority／enabledEnv 切換，而不是 env 開關攔截。
- `grep -n "isNewApiVideoKernelEnabled()" src/lib/generation-core/supplier-adapter.ts`

## V-06 ⚑ 協議分派三處中央 switch（M）
- `src/lib/generation-core/supplier-adapter.ts:105-131` `requestSupplier` 依 `adapterType` 分派 submit
- `src/lib/generation-core/worker-service.ts:62-72` `protocolOfAdapter`（`default → "newapi_video"`：未知協議會被當成 new-api 去對帳）
- `src/lib/generation-core/provider-reconciliation.ts:247-262` `pollProviderTask` 依 `ProviderProtocol` 分派 poll
- `src/lib/generation-core/types.ts:167`、`:214` 兩個聯集型別
- 為何必先修：這 5 個點就是「新協議 N=8」的主體。修法：`SupplyAdapter` 物件自帶 `protocol/submit/poll/cancel`，registry 以 `protocol` 查表；三處 switch 改成 `registry.get(adapterType)`。
- `grep -n "case \"metaso\"" src/lib/generation-core/*.ts`

## V-07 ⚑ `pixai-proxy` 在供給模組內扣退款；B 端三條同步路由不經 job（M）
- `src/lib/pixai-proxy.ts:43` 直連 `PIXAI_BASE_URL`；同檔 `:152 chargeBizRequest` → `:172` `configuredGenerationBillingAdapter().reserve`、`:195 refundBizRequest` → `:198` `.refund`——**繞過 `billing-ledger`，不留 billing_operation 列**。
- 呼叫者：
  - `src/app/api/v1/images/edits/route.ts:170` charge、`:178` `proxyPixai("images/edits")`、`:195` refund
  - `src/app/api/v1/upscale/route.ts:102` charge、`:110` `proxyPixai("upscale")`、`:137` refund
  - `src/app/api/v1/template-generations/route.ts:69` charge、`:77` `proxyPixai("template-generations")`、`:94`／`:101` refund
- 附帶：`src/lib/generation-core/sync-idempotency.ts:1-4` 只為這兩條同步路由存在（生產目錄裡的分發關注點）。
- 為何必先修：這是 B 端（付費客戶）的錢；沒有帳本列，`reconcileGenerationBilling`／`retryStrandedRefundOperations` 救不回失敗的退款。
- 修法：edits 已有 durable 分支（`edits/route.ts:120 durableEditBranch`），把 pixai 路徑也改成 `submit()`；pixai 成為一條 `SupplyDeclaration`。
- `grep -rn "chargeBizRequest\|refundBizRequest\|proxyPixai(" src/app/api/v1`

## V-08 ⚑ `/api/pixai/*` 直接扣退款（M）
- `src/app/api/pixai/template-generations/route.ts:57` reserve、`:89`／`:100` refund
- `src/app/api/pixai/edit/route.ts:69` reserve、`:92`／`:103` refund
- `src/app/api/pixai/upscale/route.ts:73` reserve、`:96`／`:107` refund
- 違反：分發直呼 `image-billing.reserveImageQuota/refundImageQuota`，不經帳本；退款用 `void … .catch(() => {})` 靜默吞錯。修法同 V-07。
- `grep -rn "reserveImageQuota\|refundImageQuota" src/app/api/pixai`

## V-09 Canvas 生成打 legacy 引擎（M）
- `src/app/api/canvas/generate/route.ts:241`、`:247` `fetch(\`${req.nextUrl.origin}/api/generate-images\`)`
- 違反：畫布是分發面，但它的生成走的是不經 job／帳本的 legacy 引擎（V-11）。Web 主入口已是 durable-first（`src/hooks/use-image-generation.ts:627` 先打 `/api/generation-jobs`，只在 `control_plane_disabled` 時 `:650` 回落）。
- 修法：畫布改提交 `/api/generation-jobs`＋輪詢，照 `use-image-generation.ts:627-650` 的 durable 分支。
- `grep -n "/api/generate-images" src/app/api/canvas/generate/route.ts`

## V-10 `/v1/images/generations` 控面關閉分支（M）
- `src/app/api/v1/images/generations/route.ts:11` import `generateBizImage, resolveBizEndpoints`（`src/lib/biz-image-pipeline.ts:59` `buildModelQueue`、`:103` `resolveAdobe2ApiModelId`、`:124` 直連 `fetch`）
- 同檔 `:376` `reserveImageQuota`、`:446` `refundImageQuota`、`:408` `generateViaExternalChannel`（`src/lib/external-channel-adapter.ts:94`）
- 觸發條件：`!generationControlPlaneEnabled()`（`:263` 起的 `if` 之後）。**[I]** 生產控面常開，此分支實際只在控面故障時執行——正是最需要帳本的時候卻沒有帳本；外部渠道（`external-channels.ts`）也因此只在這條分支可用。
- 修法：刪分支，控面關閉時回 503（`:333` 已有 `control_plane_unavailable` 錯誤碼）；外部渠道改寫成 `SupplyDeclaration`（按 key 白名單路由的能力移到 scheduler）。
- `grep -n "reserveImageQuota(\|refundImageQuota(\|generateViaExternalChannel(" src/app/api/v1/images/generations/route.ts`

## V-11 legacy 引擎（L）
- `src/app/api/generate-images/route.ts:16` import `buildModelQueue/recordEndpoint*`（`channel-registry`）、`:41` `resolveAdobe2ApiModelId`、`:296`／`:410` 直連 `fetch(${endpoint.baseURL}…)`、`:603` reserve、`:778` refund
- `src/app/api/generate-videos/route.ts:12` `channel-registry`、`:29`／`:205` `resolveAdobe2ApiVideoModelId`、`:151` 直連 `fetch`、`:242` `buildModelQueue`、`:279` reserve、`:353` refund
- 這是一整套平行的生產平面（隊列＋重試＋冷卻＋計費）住在分發路由裡：1174 行（811＋363）。`next.config.mjs:70` 還把 `/api/generate-images` 代理到控面，讓它在控面上與 durable 引擎並跑。
- 依賴它的活呼叫者：V-09（canvas）、`use-image-generation.ts:650`（控面關閉回落）。先修 V-09，再把 `:650` 回落改成回報錯誤，這兩條路由即可退役；`channel-registry` 退為 admin 唯讀視圖。
- `grep -n "buildModelQueue(\|reserveImageQuota(\|fetch(\`\${endpoint.baseURL}" src/app/api/generate-images/route.ts src/app/api/generate-videos/route.ts`

## V-12 音樂工具直連上游（L）
- `src/lib/music-tools.ts:46-64` import `music-flowmusic`／`music-lyria`／`music-yue2`
- `src/lib/music-tools.ts:577`、`:584`、`:585` 依序 `generateYue2Track`／`generateFlowMusicTrack`／`generateLyriaTrack`（回落鏈＝生產平面的「換供給」邏輯寫在工具裡；commit `e75a2e8e`「音樂全鏈回落 Lyria」）
- 上游 `fetch`：`src/lib/music-lyria.ts:237`、`src/lib/music-yue2.ts:245`／`:376`、`src/lib/music-flowmusic.ts:175`
- 計費：`music-tools.ts` 與三個 `music-*.ts` 內沒有 reserve/refund/billing 字樣。**[H]** 音樂是否刻意免費、或在 agent 會話層另計，未查證。
- 修法：三路音樂各成一條 `SupplyDeclaration`（`modality: "audio"`），`music_gen` 工具改 `submit()`＋等 job；回落鏈交給 scheduler 的 priority。依賴 planes.md §2.2 的 [H]（yue2 transcribe 是否另立 kind）。
- `grep -n "await generate\(Yue2\|FlowMusic\|Lyria\)Track" src/lib/music-tools.ts`

---

## 不列違例（已核對）

- `/openai/v1/**` 與 `src/lib/openai-compat/**`：只經 HTTP 打自家 `/api/v1`，不 import 生產或供給（`openai-compat/generation.ts:18-19` 僅 import `blob-backend` 取件與同目錄 errors）。`openai-compat/models.ts:17` 讀 `model-availability-gate` 屬門面 `listCapabilities`，允許。
- `/api/v1/videos/generations`：控面開走 `submitGenerationCommand`（`route.ts:232`），關則轉發控面（`:172`），不自扣費。
- `generation-core/*-upstream.ts`：無帳本／job／blob import；`openai-video-upstream.ts:271`、`:375` 提到 `persistOutputArtifact` 僅為註解。
- `src/app/api/admin/**` 使用 `channel-registry`／`sub2api`：運維面，不屬分發管道。
- `src/app/api/{token,topup,usage,models,pricing,log/self,user/*,data/self}` 的 `makeProxy`（`src/lib/proxy.ts`）：代理 new-api 帳戶 API，是帳戶自助面，不是生成供給。

## 修復順序（必先修的 4 條，按依賴）

1. **V-02**（S）→ 2. **V-06**（M，建 adapter registry）→ 3. **V-03**（S–M，價格進 claim、閘進 worker；依賴 2 的 registry 才能「對所有協議生效」）→ 4. **V-07＋V-08**（M，pixai 變成 SupplyDeclaration 後三條 B 端同步路由改 `submit()`）。
完成 1–3 後「新協議供給」由 N=8 降到 N=2；完成 4 後全系統 `image-billing.reserve/refund` 呼叫點只剩 `billing-relay.ts:92-93` 與 `internal/generation-billing/route.ts:53-54`（V-10、V-11 退役後成立）。
