# S8 标准 OpenAI 同步接口 /openai/v1（最高优先，预期 3 小时，可拆 2 路）

先读 `_common.md`（同目录）与 `docs/specs-0928/S2-compat-report.md`（差异全表，本 spec 的依据）。

## 为什么（第一性）
我们的资产是便宜且独有的供给（gpt-image-2、PixAI 二次元），缺的是分发。分发管道已经存在，而且里面的用户本来就在付费：
- new-api／one-api 中转站：加渠道只需要填 base URL 和 key
- Cherry Studio、SillyTavern（酒馆）、Dify、Coze、n8n、LobeChat
- 直接用 OpenAI SDK 写代码的开发者

这些管道全部只认标准 OpenAI 的**同步**形状。我们的 production 一律回 202 异步任务，所以每一条管道对我们都是关著的；`docs/biz-api.md` 还写著「可直接用官方 SDK」，这句是错的。

## 做什么
**新开一个兼容层 `/openai/v1/*`，现有 `/v1/*` 契约一行不动**（contract-lock 不许改）。现有 biz key 在两边都能用。

1. `POST /openai/v1/images/generations`
   - 内部走现有 durable 管线：提交后在服务端等到任务完成，然后回 **200**，body 为 `{created, data:[{url} | {b64_json}]}`
   - `response_format` 按 OpenAI 语义：预设 `url`；要 `b64_json` 时由服务端取回 artifact 再编码
   - 失败时回 OpenAI 错误信封（`{error:{message,type,code}}`），未出图＝不扣费（沿用退款语义）
   - 等待上限先实测部署平台允许的函数时长，按实际值设定；超时回 504，并在 `error.message` 附上 task id（任务继续在后台跑，可在网页历史里找到）
2. `POST /openai/v1/chat/completions`：生图模型以对话形式调用。
   - 取最后一条 user 讯息作为 prompt，同步等出图，回标准 chat.completion：`content = "![image](<url>)"`
   - 支援 `stream:true`：先送 keep-alive 片段，出图后送一个含图片 markdown 的 delta，最后送 `[DONE]`（酒馆、Cherry Studio 走的是这条）
   - 非生图模型 → 400 `model_not_supported`
3. `GET /openai/v1/models`：标准 `{object:"list", data:[{id, object:"model", owned_by:"eimu"}]}`，只列目前可用的图片模型（沿用熔断闸，不列已熔断或断供的模型）。
4. 文档：`docs/biz-api.md` 开头改为两种接法：
   - 「标准 OpenAI 同步（中转站、客户端、SDK 直接填）：base URL `https://eimu.dev/openai/v1`」
   - 「异步任务（`/v1`，带 callback 或 Idempotency-Key，适合批量）」
   - 附 new-api 加渠道的填法（类型选 OpenAI，base URL 填上，模型列表填上）

## 验收
- 用官方 `openai` npm SDK 写的测试（mock 上游）：`client.images.generate(...)` 拿到 `data[0].url`；`client.chat.completions.create(...)` 拿到 markdown 图片；stream 模式能正常收完
- `/v1/*` 的 contract-lock 测试不改、全绿
- **真单验证只准 1 次**：gpt-image-2、1024x1024、n=1，由 orchestrator 报备暴君同意后执行，不在本 spec 内执行
