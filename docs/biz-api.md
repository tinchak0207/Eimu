# Image Studio 图像生成 API（B 端接入文档）

OpenAI 兼容的图像生成接口，供 API 聚合平台与企业客户直接调用。

## 接入信息

| 项目 | 值 |
| --- | --- |
| Base URL | `https://eimu.dev/v1` |
| 认证方式 | `Authorization: Bearer sk-biz-…` |
| 请求编码 | `application/json`，UTF-8 |
| 兼容性 | OpenAI 的请求形状与错误信封；**返回是异步任务**（202 + task_id），取图靠轮询 |

密钥由我方后台签发，形如 `sk-biz-` 加 32 位十六进制。**密钥只在签发时出示一次**，请妥善保存；丢失只能吊销后重新签发。

## 端点

### `GET /v1/models`

返回当前密钥有权调用的模型。聚合平台可用它做模型发现与可用性探测。

```bash
curl https://eimu.dev/v1/models \
  -H "Authorization: Bearer $API_KEY"
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-image-2",
      "object": "model",
      "created": 1767225600,
      "owned_by": "image-studio",
      "x_display_name": "GPT Image 2",
      "x_coins_per_image": { "standard": 1, "hd": 2 }
    }
  ]
}
```

`x_display_name` 与 `x_coins_per_image` 是非标准扩展字段，方便平台侧直接算成本；不认识它们的客户端会自动忽略。

### `POST /v1/images/generations`

```bash
curl https://eimu.dev/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只戴帽子的猫，柔和的象牙色背景",
    "n": 1,
    "size": "1024x1024",
    "quality": "standard",
    "response_format": "b64_json"
  }'
```

#### 请求参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | — | 见 `GET /v1/models` |
| `prompt` | string | 是 | — | 最长 4000 字符 |
| `n` | integer | 否 | `1` | 1–4。串行出图，`n` 越大耗时越长 |
| `size` | string | 否 | `1024x1024` | `1024x1024`、`1536x1024`、`1024x1536`、`2048x2048`（2048 由 seedream 系支持） |
| `quality` | string | 否 | `standard` | `standard` 或 `hd`（`high` 等同 `hd`） |
| `response_format` | string | 否 | `b64_json` | `b64_json` 或 `url`。**只影响 legacy 同步分支**；当前生产返回异步任务，成品一律是图片 URL |
| `callback_url` | string | 否 | — | 任务完成时的 webhook 回调（生产异步链路的可选加速） |

#### 成功响应：202 + 任务（生产一律异步）

```json
{
  "object": "image_generation.task",
  "id": "3988af81-…",
  "task_id": "3988af81-…",
  "status": "queued",
  "created": 1784912242,
  "model": "gpt-image-2",
  "requested_count": 1,
  "completed_count": 0,
  "task_url": "/v1/images/3988af81-…"
}
```

响应头带 `Location: /v1/images/{id}`。取图：

```bash
# 轮询（3~5 秒一次，轮询不消耗限流额度）直到 status 变成 succeeded
curl -s https://eimu.dev/v1/images/3988af81-… \
  -H "Authorization: Bearer $API_KEY"
```

`succeeded` 的响应追加 `result_url` 与 `data[]`（元素为 `{id,url,mimeType,sha256,width,height,outputIndex,endpointLabel}`），直接读 `data[0].url` 即成品；`GET /v1/images/{id}/result` 是同一份 `data[]` 的便捷入口（未完成时 409 `result_not_ready`）。**异步链路不回 `b64_json`**——要字节流请自行下载 `data[].url`。

`n > 1` 时若中途失败，`requested_count` 与 `completed_count` 会拉开差距，已成功的图照样可取；未消耗的额度会自动退回。

### 使用 OpenAI SDK

官方 SDK 可以**提交**请求（请求体与错误信封都是 OpenAI 形状），但它的 `images.generate()` 类型是按「同步返回图片」定义的，**拿不到异步任务里的图**：它会解析到 202 的那个任务对象，`result.data` 为空。

```python
from openai import OpenAI

client = OpenAI(api_key="sk-biz-…", base_url="https://eimu.dev/v1")

# 提交：把原始响应体拿出来读 task_id（typed helper 会丢掉非标准字段）
raw = client.images.with_raw_response.generate(
    model="gpt-image-2",
    prompt="一只戴帽子的猫",
    size="1024x1024",
)
task_id = raw.http_response.json()["task_id"]

# 取图：用普通 HTTP 轮询（SDK 没有任务轮询这一层）
poll = client.get(f"/images/{task_id}")
while poll.status_code == 200 and poll.json()["status"] not in ("succeeded", "failed"):
    time.sleep(3)
    poll = client.get(f"/images/{task_id}")
print(poll.json()["data"][0]["url"])
```

最省事的方式是直接用 HTTP（见上面的 `curl` 三连）：提交 → 轮询任务 → 读 `data[0].url`。异步语义下没有「一次调用直接拿到图片字节」这条路。

## 错误

错误体为 OpenAI 形状：

```json
{
  "error": {
    "message": "API 密钥无效。",
    "type": "authentication_error",
    "code": "invalid_api_key",
    "param": null,
    "trace_id": "…"
  }
}
```

`trace_id` 与响应头 `X-Request-Id` 同值，报障时带上它可直达本次请求的日志。

| HTTP | `code` | 含义与处理 |
| --- | --- | --- |
| 400 | `invalid_json` | 请求体不是合法 JSON |
| 400 | `missing_prompt` / `missing_model` | 缺必填参数 |
| 400 | `prompt_too_long` | prompt 超过 4000 字符 |
| 400 | `model_not_found` | 模型不存在，查 `GET /v1/models` |
| 400 | `unsupported_size` | size 不在支持列表 |
| 400 | `invalid_n` | n 不在 1–4 |
| 401 | `missing_api_key` | 没有 `Authorization` 头 |
| 401 | `invalid_api_key` | 密钥无效或已吊销 |
| 403 | `api_key_disabled` | 密钥被停用，请联系我方 |
| 403 | `model_not_permitted` | 该密钥未开通此模型 |
| 402 | `insufficient_balance` | 余额/额度不足，**本次未扣费**；`message` 内含充值入口（成员额度不足时指向团队主账号） |
| 429 | `rate_limit_exceeded` | 超出每分钟上限，见 `Retry-After` 响应头 |
| 502 | `upstream_failed` | 所有上游端点均失败，`message` 内含各端点失败原因 |

429 响应会带 `Retry-After`（秒）。请按该值退避，不要立即重试。

## 限流

每个密钥有独立的每分钟请求上限（默认 60，可按需调整）。

需要说明的是：限流在应用实例内计数，我方部署在多实例无状态环境上，因此**短时间内的实际放行量可能略高于名义上限**。它的作用是拦住失控的客户端与明显滥用，而不是精确配额——真正的花费上限由账户余额兜底。如果你的业务需要严格的并发保证，请提前告知，我方可另行安排。

## 计费

- 按成功出图张数计费，失败不计费。
- 单价随模型与 `quality` 变化，见 `GET /v1/models` 的 `x_coins_per_image`。
- 额度在请求开始时预留，失败或未出满 `n` 张时自动退回。
- 余额不足返回 402 `insufficient_balance`（本次未扣费，`message` 内含充值入口；成员额度不足时指向团队主账号）。

## 超时

单次上游尝试上限 100 秒，整个请求的故障转移预算 240 秒，函数硬上限 300 秒。请把客户端超时设为**不低于 300 秒**，否则可能在我方仍在重试其他上游时提前断开。

`n > 1` 为串行出图，请据此放宽超时。对时延敏感的场景建议 `n = 1`，由客户端侧并发。

## 可用性

请求会依次尝试多个上游端点；连续失败的端点会进入 60 秒冷却并被排到队尾，因此单个上游故障通常不会影响可用性。所有端点都失败时返回 502，`message` 里列出每个端点的失败原因，便于双方对账排查。


---

## 模板 SKU（营销成片模板，2026-08-21 新增）

SKU 是把营销模板产品化后的「一句话/一张表批量下单」接口：你提供商品信息或痛点描述，平台按固定镜头结构（钩子/卖点/场景/CTA）展开成一组生成任务，逐镜头走与 `/v1/images/generations` 完全相同的提交/计费/调度管线。**它卖的是编排结构（人工节省 + 投放节奏适配），不是模型单价**——镜头计划展开是纯文本模板 + 变量替换，不经过 LLM，同一份输入永远得到同一份镜头计划（可预测、可对账、可重放）。

与 `GET /v1/templates`（PixAI 上游场景预设）是两套东西：SKU 是我方自有产品层。

### `GET /v1/skus`（公开，无需鉴权）

返回 SKU 目录：每个 SKU 的输入 schema（字段名/类型/必填/区间/示例，可直接编程生成下单表单）、镜头结构、输出规格、计价模式与能力边界（`notes` 如实标注——当前输出为**分镜静帧图组**，不是成片；平台未接入 TTS/剪辑/数字人）。

首批三个 SKU：

| id | 结构 | 输入 | 输出 |
| --- | --- | --- | --- |
| `sku-ecommerce-15s` | 开箱钩子 → 卖点特写×N → 场景演示 → CTA | 商品名 + 1-3 条卖点（+可选受众/商品图 URL） | 4-6 张 9:16 分镜图 |
| `sku-pain-point-ad` | 问题钩子 → 放大 → 转折 → 证明 → CTA | 痛点 + 解决方案 + 受众 | 5 张 9:16 分镜图 |
| `sku-multi-angle` | N 条同构变体（角度/光线/场景按 8 档内置池轮换注入） | 主体描述 + 变体条数 1-8（缺省 3，可自带角度池） | N 张 1:1 变体图 |

### `POST /v1/skus/{sku_id}/runs`

```bash
curl https://eimu.dev/v1/skus/sku-multi-angle/runs \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-run-20260821-001" \
  -d '{
    "base_subject": "磨砂黑便携保温杯",
    "variant_count": 3
  }'
```

```json
{
  "object": "sku.run",
  "run_id": "my-run-20260821-001",
  "sku_id": "sku-multi-angle",
  "model": "gpt-image-2",
  "created": 1787308800,
  "idempotent_replay": false,
  "items": [
    { "shot_index": 0, "shot_id": "variant-1", "kind": "image", "task_id": "…", "task_url": "/v1/images/…", "accepted": true, "prompt": "磨砂黑便携保温杯，正面平视构图，…" }
  ],
  "failed_items": [],
  "estimated_coins": 3,
  "run_url": "/v1/skus/runs/my-run-20260821-001"
}
```

- **202** 表示全部镜头已提交为异步任务；单镜头结果用 `items[].task_url`（即 `GET /v1/images/{id}` 与 `/result`）逐个取件，或用 run 聚合端点看整体进度。
- 顶层保留字段：`model`（覆盖 SKU 默认模型，需在密钥模型白名单内）、`callback_url`（透传到每个镜头任务）。其余字段即 SKU 输入。
- **表格批量**：body 传 `{ "inputs": [输入对象, …] }`（或直接顶层数组），每项一轮 run（上限 10 轮），响应为 `{ "object": "sku.run.set", "runs": […], "failed_inputs": […] }`，每轮的 `run_id` 为 `<根>-<序号>`。
- **幂等**：`Idempotency-Key` 头 = run 根。同一键重放会命中既有镜头任务（不重复建任务/扣费，`idempotent_replay: true`）；中途失败的镜头重放时自动补齐。同键但输入/model 变了 → 409 `idempotency_key_reused`。run_id 需为 8-128 位字母数字开头字符串（可含 `-`/`_`）。
- **计费**：v1 按 `per_shot` 逐镜头计费（单价见 `GET /v1/models`），提交时预留、失败自动退回，与单任务端点同一套账本。`estimated_coins` 为预估值。
- 输入验证失败（单轮）→ 400，`error.code` 为 `missing_field`/`invalid_field`/`field_too_long`，`error.param` 指明字段；批量模式下单项验证失败进 `failed_inputs`，不炸整批。

### `GET /v1/skus/runs/{run_id}`

按 run 聚合进度（鉴权同其他端点；轮询不消耗限流额度）：

```json
{
  "object": "sku.run.status",
  "run_id": "my-run-20260821-001",
  "sku_id": "sku-multi-angle",
  "status": "open",
  "counts": { "total": 3, "submitted": 3, "unsubmitted": 0, "pending": 1, "running": 1, "succeeded": 1, "failed": 0, "cancelled": 0, "refunded": 0, "unknown": 0 },
  "billing": { "reserved_total": 1500000, "charged_total": 500000, "refunded_total": 0, "pending_total": 1000000 },
  "all_terminal": false,
  "items": [
    { "shot_index": 0, "shot_id": "variant-1", "task_id": "…", "task_state": "succeeded", "billed": true, "result_url": "/v1/images/…/result", … }
  ]
}
```

`all_terminal: true`（或 `status: "completed"`）表示全部镜头已终结；部分成功语义下 `succeeded` 的镜头随时可经 `result_url` 取件。run 不占新表——`run_id` 即幂等键根，镜头任务的冪等键为 `skurun:<run_id>:<shot_index>`，聚合视图直接从任务事实源构建。

---

## 我方内部：签发密钥

```bash
# 签发（--user-id 是上游 New API 的用户 id，消耗从该账户余额扣除）
npm run bizkey:issue -- --label "某聚合平台" --user-id 12

# 可选参数
npm run bizkey:issue -- --label "客户A" --user-id 12 --rpm 120 --models gpt-image-2,adobe-firefly

# 查看已签发的密钥
npm run bizkey:list
```

也可以在 `/admin` → 「B 端密钥」页可视化签发。两条路径等价，CLI 只需要
`BLOB_READ_WRITE_TOKEN`，不需要管理员密码。

明文密钥只在签发时输出一次，存储里只有 sha256。丢了只能吊销重发。
