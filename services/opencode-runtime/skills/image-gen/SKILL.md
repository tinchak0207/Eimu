---
name: image-gen
description: 生图首选渠道（平台渠道，与 image_generate 同源；agent-pixai 免费池长期不可用，默认不选）。用户要「画一张、生成图片、把这张图改一下、放大图片」时直接用它。走 image.tinchak0207.xyz 平台 API，生图非同步（空闲时几十秒到几分钟，高峰期排队可能更久、逾时自动退款），改图同步 10-30s。
license: internal
metadata:
  audience: coding-agent
---

## 我负责什么
呼叫我们平台的图像 API（OpenAI 相容）。**只负责 API 呼叫与状态判断，不负责构思 prompt 内容**。

## API 总览（Base: https://image.tinchak0207.xyz/v1，认证 Bearer）
| 动作 | 端点 | 同步? | 花费 |
|---|---|---|---|
| 生图 | POST /v1/images/generations | 非同步(202) | 见定价表 |
| 查状态 | GET /v1/images/{id} | 同步 | 0 |
| 改图 | POST /v1/images/edits | 同步 10-30s | 用 image_quote 查 |
| 放大 | POST /v1/upscale | 同步 ~20s | 用 image_quote 查 |
| 上传 | POST /v1/uploads | 同步 | 0 |

**影片已可用**：POST /v1/videos/generations（非同步 202，建影片任务；model/prompt/n/size/duration_seconds/generate_audio）。支持哪些影片模型以 `video_quote` 回执为准（不要凭记忆报模型名）。**查影片模型与按秒报价用 `video_quote` 工具**（免费）：它列出全部影片模型与 x_coins_per_second 每秒单价（依解析度分档），总价 = 每秒单价 × 时长。`image_quote` 只列图片模型，查影片不要用它。**大片/多镜头请用 workflow_* 工具建工作流**（workflow-director skill），不要手动逐支提交。

## 模型与定价（只认工具回执）

图片模型清单、默认模型、每张单价、可用性，一律以 `image_quote` 回执为准（`available_models`／`proven_models`；已按近 24h 真实交付排序），本档不再维护模型名表和价格快照——配置一更新，回执就跟着变，写在这里的名字只会过期。
- 模型 id 必须逐字照抄回执里的 `id`，不凭记忆拼写。
- 部分模型 hd 比 standard 贵，以回执的分档价为准；总价用 `quote_bundle`。
- 更高单价的模型只在用户点名，或成品精修且用户接受价格时用。

## 步骤化工作流：生图
1. 未指定模型 → 先 `image_quote`，从回执 `available_models` 里按「近 24h 真实交付靠前、单价合理」选一个，不在回复里复述记忆中的模型名；用户点名其他模型时才换。告知用户用了哪个与价钱。
2. 先报价（用 image_quote 查即时单价），确认后才发请求。
3. POST /v1/images/generations（response_format: "url"）。
4. 收到 202 → 记 task_id，**不要开始轮询**。回报「已提交」并结束本回合；耗时一律说「通常几十秒到几分钟，高峰期可能排队更久，逾时自动退款」，不报精确秒数。回报给用户的 task_id 必须原样照抄完整 UUID（36 字元含连字号），严禁截断成前 8 位——短 id 在平台查不到任务。
5. 图完成后 harness 会把结果续接回来 → 直接给最终图片 URL。

## 状态机
| status | 动作 |
|---|---|
| queued / running | 等待，不重试 |
| succeeded | 回应已内嵌 result_url，直接取图 |
| failed | 读 error，依陷阱表修复后重发 |

## 陷阱表
| 症状 | 原因 | 下一步 |
|---|---|---|
| 错误含 model 字样 | 模型名错 | 换表内模型名重试 |
| HTTP 413 | 上传 >20MB | 压缩重传 |
| 429 | 超过 60rpm | 等 Retry-After 再重试 |
| 402 insufficient_quota | 余额不足 | 告知用户充值，不重试 |

## 省钱纪律
- 默认模型取 `image_quote` 回执（已排好序、已剔除不可用）；用户明确要求省钱/草稿且未点名模型时，取回执里最低价的可用档；更高单价只在用户指名或成品精修时用。
- n 预设 1；>0.1 币的动作扣费前必先报价并等确认（≤0.1 币免确认，方便自由探索）。
- 完全相同的 (model, prompt, size, n) 会命中快取，0 币直接回旧图——不必重发。
