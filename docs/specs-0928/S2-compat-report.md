# S2 OpenAI 兼容性核对报告（`/v1/images/generations` vs OpenAI Images API）

只读报告，未改任何代码。每条标注 FACT（本 repo 代码/OpenAPI 可验，附出处）或 INFERENCE（第三方客户端行为，
未在本 repo 验证）。出处皆为 repo 内相对路径。

## 结论（一句）

**不能直接接入**：production 一律回 **202 + task_id 的异步任务**（openapi 明文「production 一律 202」），
而 OpenAI Images API 的客户端都期待**单次 POST 同步回 `data[]`**；SillyTavern 与 Cherry Studio 需加一层
「提交 + 轮询」适配器，NextChat 根本没有生图 API 客户端，不适用。

## 一、逐维度差异（左 = OpenAI Images API，右 = 我方 `/v1/images/generations`）

| 维度 | OpenAI Images API | 我方 `/v1/images/generations` | 出处 |
| --- | --- | --- | --- |
| **同步 / 异步** | POST 同步回 **200**，图片在同一回应里 | production：**202** Accepted + `Location: /v1/images/{id}`；回应体为 `GenerationTask`（`{object:"image_generation.task", id, task_id, status:"queued", created, model, requested_count, completed_count, primary_result_id, result_ids, retry_of_task_id, task_url, request_config}`）。取件＝轮询 `GET /v1/images/{id}` 至 `status:"succeeded"`，或收 `callback_url` webhook。openapi 的 200 分支自标「仅在 durable control plane 未启用的 legacy 分支回；production 一律 202」 | FACT：`src/app/api/v1/openapi.json/route.ts:88-91,102-118`；`src/lib/generation-core/task-response.ts:44-90`；`src/app/api/v1/images/generations/route.ts:263-330`（durable 分支）、`456-466`（legacy 同步分支） |
| **`data[].url` / `b64_json`** | 同一 POST 回应的 `data[]` 为 `{url}` 或 `{b64_json}`（+`revised_prompt`） | 202 回应**不含 `data`**；只在 `succeeded` 后出现，且元素是 **`TaskArtifact`**：`{id,url,mimeType,sha256,width,height,outputIndex,endpointLabel}` —— **没有 `b64_json` 栏位**。因此异步路径下 `b64_json` 不可得，交付一律是 artifact 的 `url`。legacy 同步分支才有 OpenAI 形状 `{created,data:[{url|b64_json}]}` | FACT：`openapi.json/route.ts:935-947`（TaskArtifact 无 b64 栏）、`:958-995`（GenerationTask）、`src/app/api/v1/images/[id]/result/route.ts:40-47`、`generations/route.ts:456-466` |
| **`response_format`** | 预设 `url` | 代码预设 **`b64_json`**（`body.response_format === "url" ? "url" : "b64_json"`，非 `url` 一律当 b64，含未传）。降级：要 b64 而上游只给 URL → 该项退为 `{url}`（legacy 分支语义）。**文档不一致**：openapi schema 写 `default:"url"`，`docs/biz-api.md:70` 写 `b64_json` → 以代码为准 = `b64_json`。异步路径下此栏位只落进 `request_config.response_format`，不改变交付形式 | FACT：`generations/route.ts:208`；`openapi.json/route.ts:1102-1106`；`docs/biz-api.md:70,81` |
| **`n`** | 1–10（DALL·E 2/3 与 gpt-image-1） | **1–4**，超界 400 `invalid_n`；串行出图（`MAX_N=4`）。部分成功语义：`requested_count` vs `completed_count`，未出图张数自动退款 | FACT：`generations/route.ts:60,200-205`；`openapi.json/route.ts:1091`；`docs/biz-api.md:67` |
| **`size`** | DALL·E 3：`1024x1024`/`1792x1024`/`1024x1792`；gpt-image-1：`1024x1024`/`1536x1024`/`1024x1536`/`auto` | 固定 4 值白名单 `1024x1024`/`1536x1024`/`1024x1536`/`2048x2048`，不在集合即 400 `unsupported_size`；**无 `auto`**。文档不一致：openapi 与 `docs/biz-api.md` 只列 3 值（缺 `2048x2048`）→ 以代码为准 = 4 值 | FACT：`generations/route.ts:53,189-198`；`openapi.json/route.ts:1092-1096`；`docs/biz-api.md:68` |

### 其他差异（同样影响直连）

- **错误信封**：`{error:{message,type,code,param:null,trace_id}}` + `X-Request-Id` 头；OpenAI 无 `trace_id`。
  额外稳定码：`model_not_permitted`(403)、`no_endpoints`(502)、`control_plane_unavailable`(503)、`result_not_ready`(409)。
  FACT：`generations/route.ts:76-96`；`openapi.json/route.ts:706-713`。
- **额外能力（OpenAI 没有）**：`callback_url`（webhook）、`Idempotency-Key` 头、`control_nets`、`reference_images`、
  `routing_hint`、`quality: hd|high`。`async` 栏位是 **no-op 向后相容**（openapi 原文：「production 一律非同步 202」）。
  FACT：`generations/route.ts:98-105,206-230,264`；`openapi.json/route.ts:1097-1107`。
- **OpenAI 有、我方静默忽略的栏位**：`style`、`user`、`output_format`、`background`、`moderation`、
  `output_compression`（未在请求体型别中，不报错也不生效）。FACT：`generations/route.ts:98-105` 型别定义。
- **限流**：三个 `x-ratelimit-*` 头，轮询不消耗额度。FACT：`src/lib/biz-rate-limit-response-headers.ts`。
- **`docs/biz-api.md` 已过时**：它写「OpenAI Images API 形状，可直接用官方 SDK」并示范同步
  `data[0].b64_json`（`:12,77,100`），与 production 的 202 异步实际行为冲突；站内 `docs/api` 开发进阶
  （`src/app/docs/api/DevAppendix.tsx:56-70`）才是对的（202 + 轮询）。FACT。

## 二、三家客户端逐条判定

| 客户端 | 能否直接接入 | 阻塞点 | 依据 |
| --- | --- | --- | --- |
| **SillyTavern** | **不能** | 其 OpenAI 生图来源是「一次 POST 取图」模型：读同步回应的 `data[0].b64_json`（或 `url`）。我方 202 回应无 `data`，且 `b64_json` 在异步路径根本不可得 → 直接填 Base URL 会拿不到图 | 我方 202 为 FACT；客户端契约为 INFERENCE |
| **Cherry Studio** | **不能** | 同为同步取图：把 `/images/generations` 当 OpenAI 形状、直接读 `data[].url|b64_json`；且我方预设 `b64_json` 而异步交付只有 URL，双重不符 | 我方契约为 FACT；客户端契约为 INFERENCE |
| **NextChat** | **不适用** | 纯聊天客户端，没有 `/v1/images/generations` 生图客户端；图片只能从 chat 回覆的 markdown/URL 呈现 → 无从接入 | INFERENCE（未在本 repo 验证） |

**要让前两家可用，最短改动**（供裁决，不在本轮范围）：在闸道加一层「同步兼容模式」——
POST 时若 `async !== true` 或客户端标头命中，内部提交任务并在 `maxDuration` 内轮询到 `succeeded`，
再包成 OpenAI 形状 `{created, data:[{url}]}` 回 200（或加一个 `/v1/images/generations/sync` 入口）。
调研层面这是唯一阻塞点；`n`/`size` 差异只是参数收敛，不是阻塞。

## 三、信心与验证方式

- 本报告所有我方契约结论 = **源码 + OpenAPI 交叉核对**（FACT），无付费呼叫（红线：本轮禁止任何生成型上游呼叫）。
- 第三方客户端能否接入 = **INFERENCE**，未实测；若要坐实，最快方式是拿一颗测试 key 在该客户端配一次
  并抓包看它是否只发一次 POST（此动作需暴君授权，因会产生真实计费费用）。
- 免费可复现的自我核对：`curl -s https://eimu.dev/v1/models -H "Authorization: Bearer $KEY"`（唯读），
  确认 model id 与 `x_coins_per_image`。

## 四、402 统一（已落地，暴君 2026-09-28 裁决松绑契约锁）

`/v1/*` 所有余额不足出口统一为：

```json
{"error":{"message":"余额不足，本次未扣费。充值：https://eimu.dev/pricing","type":"insufficient_balance","code":"insufficient_balance"}}
```

单一真源＝`src/lib/generation-core/quota-precheck.ts` 的 `INSUFFICIENT_BALANCE_ERROR`：控制面闸门（拒单）
与 legacy reserve 余额不足分支共用同一份 status/type/code/message，路由原样透传（`errorResponse(gate.*)` 不动）。
`param: null` 与 `trace_id` 为既有 OpenAI 信封栏位（`铁律①` 锁定），统一的是 message/type/code 三栏。

同轮松绑与校正（皆在同一变更内）：

- `src/app/api/v1/contract-lock.test.ts`：402 来源扫描改锁 `insufficient_balance`（type/code 同码、常数单一真源）、
  闸门拒单 type/code 联集、openapi 六枚举与稳定码清单、端点错误码对照表。
- `src/lib/generation-core/quota-precheck.test.ts`：runtime 文案/码断言改为统一契约（文案独立抄写，实现改字即爆红）。
- `src/app/api/v1/{images,videos}/generations/route.ts`、`batches/route.ts`、`skus/[id]/runs/route.ts`：`OpenAIErrorType` 联集同步改名。
- `src/app/api/v1/openapi.json/route.ts`：错误 `type` 枚举与稳定码清单改名；`response_format` 预设校正为 `b64_json`；
  `size` enum 补 `2048x2048`。
- `docs/biz-api.md`：202 异步契约 + 轮询取图取代旧的同步 `data[0].b64_json` 叙述；SDK 段落改为诚实说明
  （官方 SDK 能提交但拿不到异步任务的图）；错误表 402 改码；错误体补 `trace_id`。
- `docs/biz-api-guide.md`：402 码与 size 允许值数量同步（同属 /v1 文档面，一并校正不留半套）。

**刻意保留（非 /v1 契约面，一个都没动）**：成员额度不足／停用的 402 **文案**（`成员额度不足，请联系团队主账号…`）——
码已统一为 `insufficient_balance`，但文案保留成员专属指引（叫成员去充值页是错的指引，REQ-B1 有测试锁「与主帐明确区分」）。
C 端（`/api/generate-images`、`/api/generation-jobs`、`RerunDialog.tsx`）的 `insufficient_quota` 属另一套面向，
规格只要求 /v1，未动；上游词表（`failure-classifier.ts`）与上游代理（`pixai-proxy.ts`）的 `insufficient_quota`
是识别上游文字用的比对词，动了会坏事。
