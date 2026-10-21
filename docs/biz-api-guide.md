# B 端 API 调用指南（`/v1`）

> 本指南讲的是**异步接法**（base URL `https://eimu.dev/v1`）。要接中转站或现成客户端（New API、Cherry Studio、酒馆、Dify、Coze、n8n、LobeChat、OpenAI SDK），走同一轮推出的**标准 OpenAI 同步层**，base URL `https://eimu.dev/openai/v1`，选型与填法见 `docs/biz-api.md` 开头。

## 基本资讯

| 项目 | 值 |
|---|---|
| Base URL | `https://eimu.dev/v1` |
| 认证 | `Authorization: Bearer sk-biz-…` |
| 请求体 | `Content-Type: application/json` |
| 追踪 | 每个回应带 `X-Request-Id`；错误体内同值为 `trace_id` |

只需要 **key + Base URL**，不需要任何自定义请求头。

## 最重要的一点：生图是非同步的

`POST /v1/images/generations` **永远回 `202` + 任务 ID**，不会在同一个回应里给图。
它不是 OpenAI 那种「一次请求直接拿 `data[].b64_json`」的同步形状。

```
POST /v1/images/generations   → 202  { task_id, status:"queued", task_url }
GET  /v1/images/{task_id}     → 轮询至 status = succeeded / failed / refunded
GET  /v1/images/{task_id}/result → 302 跳转到图片 URL（或 ?format=json 拿 JSON）
```

`succeeded` 的轮询回应本身就内嵌 `data[]`，所以拿到 `succeeded` 那一刻即可取图，
`/result` 只是额外的便捷入口。

## 快速开始

```bash
KEY="sk-biz-…"
BASE="https://eimu.dev/v1"

# 1. 列出可用模型
curl -s "$BASE/models" -H "Authorization: Bearer $KEY"

# 2. 提交任务
curl -s -X POST "$BASE/images/generations" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"pixai-haruka-v2","prompt":"1girl, silver hair, cinematic lighting","n":1,"size":"1024x1024"}'
# → {"task_id":"3988af81-…","status":"queued","task_url":"/v1/images/3988af81-…"}

# 3. 轮询（建议 3~5 秒一次；实测 15~20 秒出图）
curl -s "$BASE/images/3988af81-…" -H "Authorization: Bearer $KEY"

# 4. 取图
curl -s "$BASE/images/3988af81-…/result?format=json" -H "Authorization: Bearer $KEY"
```

## 端点契约

### `GET /v1/models`

回 OpenAI `list` 形状，额外带两个私有栏位：

```json
{"object":"list","data":[
  {"id":"pixai-haruka-v2","object":"model","created":1767225600,
   "owned_by":"image-studio",
   "x_display_name":"…","x_coins_per_image":{"standard":0.01,"hd":0.01}}
]}
```

注意：这里列的是**全站**支援的模型，不是你这把 key 被授权的模型。
调用白名单外的模型会回 `403 model_not_permitted`。

### `POST /v1/images/generations`

| 参数 | 类型 | 说明 |
|---|---|---|
| `model` | string | 必填。白名单外回 403，全站不存在回 400 |
| `prompt` | string | 必填，上限 4000 字元 |
| `n` | int | 1–4，预设 1。多张为串行出图，计费按张数乘 |
| `size` | string | `1024x1024`（预设）/ `1536x1024` / `1024x1536`，**只有这三种** |
| `quality` | string | `hd` 或 `high` → 2K；其余（含省略）→ 1K |
| `response_format` | string | `url` 或 `b64_json`。非同步路径实际一律回 URL |
| `callback_url` | string | 选填。任务终态时回调 |

请求头 `Idempotency-Key`（选填）：同 key 同 body 回同一个 task；
同 key 不同 body 回 `409 idempotency_key_reused`。

### `GET /v1/images/{task_id}`

```json
{"object":"image_generation.task","task_id":"…",
 "status":"queued|running|succeeded|failed|cancelled|refunded|unknown",
 "requested_count":1,"completed_count":1,
 "result_url":"/v1/images/…/result",
 "data":[{"id":"…","url":"https://…webp","width":768,"height":768,
          "sha256":"…","mimeType":"image/webp","outputIndex":0,
          "endpointLabel":"pixai"}]}
```

`result_url` 与 `data` 只在 `succeeded` 时出现。未终态时若有可报告原因，
会带 `error: { code, reason?, message }`（此时任务仍在重试，不代表失败）。

### `GET /v1/images/{task_id}/result`

- 预设：`302` 跳转到图片 URL
- `?format=json`：回 `{object:"image_generation.result", task_id, data:[…]}`
- 未完成：`409 result_not_ready`

图片 URL 落在 `https://store.tinchak0207.xyz/image-data/files/…`，
**公开可读、不需认证**，格式 `image/webp`，带一年不变快取头。

## 模型与参数的硬约束（实测）

供应商能力表按 `(模型, 操作, 比例, 解析度)` 四元组匹配，对不上直接
`model_unsupported`，这是**参数错误**而非上游故障。

| 模型 | 解析度 | 可用比例 | `quality` |
|---|---|---|---|
| `pixai-haruka-v2` | 仅 1K | 1:1, 3:2, 2:3, 3:4, 4:3, 9:16, 16:9 | **不可传 hd** |
| `pixai-reference-pro` | 仅 1K | 同上 | 不可传 hd |
| `pixai-tsubaki-11` | 仅 1K | 同上 | 不可传 hd |
| `pixai-tsubaki2` | 仅 1K | 同上 | 不可传 hd |
| `pixai-hoshino-v2` | 仅 1K | 同上 | 不可传 hd |
| `sensenova-u1-fast` | 仅 2K | 1:1, 3:2, 2:3 | **必须 hd** |

实测结果：

- 4 个 PixAI 模型（haruka-v2 / reference-pro / tsubaki-11 / hoshino-v2）
  + tsubaki2 端到端出图成功，`n=2` 也成功（`completed_count=2`）。
- `quality:"hd"` + PixAI = `model_unsupported`（PixAI 没有 2K 能力）。
- `sensenova-u1-fast` 目前**不可用**：它只挂在三个中转渠道下，而
  `env:primary` 已停用、`env:sub2api` 在 cooldown、`env:fallback` 降级。
  用 2K 送过去，上游回「images endpoint requires an image model」，
  任务转 `refunded`（已自动退款）。要开通这个模型得先修中转渠道。

## 计费

`1 币 = 500,000 quota`。扣费落在 key 绑定的 New API 用户（你这把是 **user 87**）。

当前生效的定价覆写（`/api/model-pricing` 公开端点可查）：

```
pixai-haruka-v2 / tsubaki2 / tsubaki-11 / hoshino-v2 : imageCredits 1k = 0.01
pixai-reference-pro                                  : imageCredits 1k = 0.0097
pixai-edit                                           : 0.001 (1k/2k/4k)
pixai-upscale                                        : fixedCoins 0.001
```

实测每张 PixAI 图预留并结算 **500 quota ≈ 0.001 币**（reference-pro 485）。
这与「冲量、几乎无限」的意图一致。

计费是真帐本，不是计数器：`billing_operation` 表对每个任务记 `reserve` /
`commit` / `refund`，实测成功任务 `reserve 500 → commit 500` 都 `applied`，
失败任务 `refund` 也 `applied`。失败自动退款。

## 错误契约

HTTP 错误体是 OpenAI 形状 + `trace_id`，同一个 id 也在 `X-Request-Id` 响应头：

```json
{"error":{"message":"...","type":"invalid_request_error","code":"unsupported_size","param":null,"trace_id":"b807330b-..."}}
```

实测过的 HTTP 错误：

| HTTP | `code` | 触发条件 |
|---|---|---|
| 401 | `missing_api_key` | 没带 Authorization |
| 401 | `invalid_api_key` | key 形状不对或不存在 |
| 403 | `api_key_disabled` | key 被停用 |
| 403 | `model_not_permitted` | 模型不在该 key 白名单 |
| 400 | `missing_prompt` / `missing_model` | 缺必填参数 |
| 400 | `model_not_found` | 站点不支援该模型 |
| 400 | `unsupported_size` | size 不在四个允许值内 |
| 400 | `invalid_n` | n 不是 1..4 |
| 400 | `prompt_too_long` | prompt > 4000 字元 |
| 402 | `insufficient_balance` | 余额／额度不足，本次未扣费（message 内含充值入口） |
| 409 | `idempotency_key_reused` | 同 key 配不同请求体 |
| 429 | `rate_limit_exceeded` | 超过 rpm，附 `Retry-After` |
| 503 | `control_plane_unavailable` | 控制面故障 |
| 405 | `method_not_allowed` | 对 generations 发 GET |

任务层失败放在 task 的 `error` 栏位（HTTP 仍 200）：

| `code` | `reason` | 含义 |
|---|---|---|
| `overloaded` | `suppliers_cooldown` | 供应商全在冷却，讯息含恢复时间 |
| `overloaded` | `capacity_saturated` | 并发打满，等待即可 |
| `model_unsupported` | — | 参数四元组匹配不到能力（你的参数错了） |
| `user_input` | — | 上游拒收请求 |
| `quota_exhausted` | — | 帐户额度用尽 |
| `authentication` | — | 上游凭证失效 |
| `unknown` | — | 结果不确定，需人工对账（不自动重试） |

`overloaded` 的三种 reason 处置完全不同：`suppliers_cooldown` 等恢复、
`capacity_saturated` 降并发、`model_unsupported` 改参数。别统一当「上游挂了」重试。

## 接聚合平台的关键限制

**`/v1` 这个端点不是同步 OpenAI 契约。** `/v1/images/generations` 在控制面开启时
**永远**回 202 + task id，不会直接回 `{"data":[{"b64_json":...}]}`。

实测确认：请求体里的 `async` 栏位会被解析但**未被使用**，没有同步旁路。
`response_format` 同理——结果一律是 URL，不给 b64。

后果：New API / one-api 这类期待同步回应的聚合平台**不能把 `/v1` 直接当
OpenAI 生图上游接**，需要中间层实作「提交 → 轮询 → 取 URL」。

**不用自己写这层了**：同一轮（2026-09-28）推出的标准 OpenAI 同步层
`https://eimu.dev/openai/v1` 就是这个包装路由——`POST /images/generations`
同步回 `200 {created,data:[{url|b64_json}]}`，`POST /chat/completions` 支援
`stream:true`，`GET /models` 回标准 list。New API、Cherry Studio、酒馆、
Dify、Coze、n8n、LobeChat 与 OpenAI SDK 一律改填这个 base URL，
填法与选型见 `docs/biz-api.md` 开头。该层与这份文件同日推出，**尚未部署到生产、目前不可调用**，
判据是 `curl -s https://eimu.dev/openai/v1/models -H "Authorization: Bearer $EMU_API_KEY"`
能否回 list（404/502 ＝ 还没上线，此时只能按本文的非同步流程接 `/v1`）。

## 已知坑

- **旧 task id 会查不到（404）**：任务按 `tenant_id = biz:<key记录id>` 隔离。
  本次修复把认证源从 env 兜底切回权威记录，key 记录 id 由
  `env-04dd42f0adb3` 变成 `4eab19b64956`，所以修复前建的任务用这把 key
  已经查不到（实测 404）。任务本身和帐都还在库里。
- **rpm 是每实例计算**：滑动窗口在进程内，多实例各算一份，实际放行量可能
  高于 600。真正的花费上限靠帐户余额兜底。
- **`image-control-api` 容器重建后必须 reload nginx**：容器 IP 变了但
  nginx 把旧 IP 钉住，`/v1/*` 会全部 502。指令：
  `sudo docker exec imagesite-nginx nginx -s reload`。

