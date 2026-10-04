---
name: model-status
description: 生成模型可用性探测与近 24h 真实表现。调用 image_generate / image_edit / image_upscale 前确认目标模型可用（工具已内建强制探测，不可用会直接失败）；当需要「选一个可用模型」或「模型失败找替代」时，主动查 /v1/model-status 的 availability + last_24h.success_rate，避免把请求发给不可用或近期高失败的模型。
---

# model-status（生成模型可用性 + 近 24h 表现）

## 守则（强制）

image_generate / image_edit / image_upscale 工具已内建「调用前自动探测」：目标模型不可用会直接失败并提示换模型；近 24h 样本 ≥5 且成功率 <50% 也会直接失败并建议换。**不要重复探测**。

当你需要「选一个可用模型」或「某模型生成失败后找替代」时，主动查可用性：

GET https://image.tinchak0207.xyz/v1/model-status（Authorization: Bearer <sk-biz-* key>，工具链 platformFetch 自动持有）

回传 models[] 每项：
- id / media_type（image|video）/ endpoint（/v1/images/generations 或 /v1/videos/generations）
- functions（generate / edit / upscale）
- availability（available | unavailable | unknown）+ note（unavailable/unknown 的原因）
- last_24h（可选）：最近 24 小时真实生图表现 `{jobs, delivered, failed, success_rate, refunded}`——success_rate 是 0~1 的小数。无此字段 = 近 24h 无样本。

## 选模型规则

- 生图：media_type=image 且 availability=available → POST /v1/images/generations
- 生影片：media_type=video 且 available → POST /v1/videos/generations
- 改图：functions 含 edit → /v1/images/edits
- 放大：functions 含 upscale → /v1/upscale
- unavailable → 换下一个同类型 available 模型；全部不可用 → 告知用户「生成服务暂时不可用」
- unknown（如 sensenova 不支持探测）→ 可尝试，失败即换模型
- **多个模型都 available 时，优先选 last_24h.success_rate 高的**（样本 ≥5 才可信；jobs <5 说明数据不足，不下结论）
- **last_24h 样本 ≥5 且 success_rate <50% 的模型要主动提醒用户**：「这个模型探测可用，但最近 24 小时真实成功率只有 X%，建议换 Y」——可用性探测只证明渠道连通，不证明能稳定出图

## 快取

响应 60 秒内有效（probe.cached）。同一轮工作流复用，不必每次重探。
