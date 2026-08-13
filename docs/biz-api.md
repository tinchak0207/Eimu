# Image Studio 图像生成 API（B 端接入文档）

OpenAI 兼容的图像生成接口，供 API 聚合平台与企业客户直接调用。

## 接入信息

| 项目 | 值 |
| --- | --- |
| Base URL | `https://image.tinchak0207.xyz/v1` |
| 认证方式 | `Authorization: Bearer sk-biz-…` |
| 请求编码 | `application/json`，UTF-8 |
| 兼容性 | OpenAI Images API 形状，可直接用官方 SDK |

密钥由我方后台签发，形如 `sk-biz-` 加 32 位十六进制。**密钥只在签发时出示一次**，请妥善保存；丢失只能吊销后重新签发。

## 端点

### `GET /v1/models`

返回当前密钥有权调用的模型。聚合平台可用它做模型发现与可用性探测。

```bash
curl https://image.tinchak0207.xyz/v1/models \
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
curl https://image.tinchak0207.xyz/v1/images/generations \
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
| `size` | string | 否 | `1024x1024` | `1024x1024`、`1536x1024`、`1024x1536` |
| `quality` | string | 否 | `standard` | `standard` 或 `hd`（`high` 等同 `hd`） |
| `response_format` | string | 否 | `b64_json` | `b64_json` 或 `url` |

#### 成功响应

```json
{
  "created": 1784912242,
  "data": [{ "b64_json": "iVBORw0KGgo…" }]
}
```

请求 `b64_json` 但上游只返回了 URL 时，该项会退化为 `{ "url": "…" }`。**客户端请同时处理两种字段**，不要假定只有 `b64_json`。

`n > 1` 时若中途失败，已成功的图片仍会返回，`data` 长度可能小于 `n`；未消耗的额度会自动退回。

### 使用 OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-biz-…",
    base_url="https://image.tinchak0207.xyz/v1",
)

result = client.images.generate(
    model="gpt-image-2",
    prompt="一只戴帽子的猫",
    size="1024x1024",
)
print(result.data[0].b64_json[:40])
```

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-biz-…",
  baseURL: "https://image.tinchak0207.xyz/v1",
});

const result = await client.images.generate({
  model: "gpt-image-2",
  prompt: "一只戴帽子的猫",
  size: "1024x1024",
});
```

## 错误

错误体为 OpenAI 形状：

```json
{
  "error": {
    "message": "API 密钥无效。",
    "type": "authentication_error",
    "code": "invalid_api_key",
    "param": null
  }
}
```

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
| 402 | `insufficient_quota` | 账户余额不足，需充值 |
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
- 余额不足返回 402。

## 超时

单次上游尝试上限 100 秒，整个请求的故障转移预算 240 秒，函数硬上限 300 秒。请把客户端超时设为**不低于 300 秒**，否则可能在我方仍在重试其他上游时提前断开。

`n > 1` 为串行出图，请据此放宽超时。对时延敏感的场景建议 `n = 1`，由客户端侧并发。

## 可用性

请求会依次尝试多个上游端点；连续失败的端点会进入 60 秒冷却并被排到队尾，因此单个上游故障通常不会影响可用性。所有端点都失败时返回 502，`message` 里列出每个端点的失败原因，便于双方对账排查。

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
