---
name: image-gen
description: 生图备援渠道（付费，仅当 agent-pixai 免费池不可用时使用）。用户要「生成图片、把这张图改一下、放大图片」时，若 agent-pixai 已失败或用户明确要求平台付费渠道，用它。走 image.tinchak0207.xyz 平台 API，生图非同步（空闲时几十秒到几分钟，高峰期排队可能更久、逾时自动退款），改图同步 10-30s。
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

**影片已可用**：POST /v1/videos/generations（非同步 202，建影片任务；model/prompt/n/size/duration_seconds/generate_audio）。支持模型：seedance-2.0、kling 2.5/3.0、veo 3.1、runway-gen-4、luma-ray、minimax-h3 等（以 GET /v1/models 为准）。**查影片模型与按秒报价用 `video_quote` 工具**（免费）：它列出全部影片模型与 x_coins_per_second 每秒单价（依解析度分档），总价 = 每秒单价 × 时长。`image_quote` 只列图片模型，查影片不要用它。**大片/多镜头请用 workflow_* 工具建工作流**（workflow-director skill），不要手动逐支提交。

## 模型与定价（快照，以 GET /v1/models 的 x_coins_per_image 为准）
| 模型 | 单价（标准） | 定位 |
|---|---|---|
| pixai-reference-pro | 0.00097 币 | 最便宜 |
| pixai-tsubaki2 / pixai-haruka-v2 / pixai-tsubaki-11 / pixai-hoshino-v2 | 0.001 币 | 二次元/插画，极便宜 |
| sensenova-u1-fast | 0.1 币 | 通用草稿 |
| gpt-image-2.5-flare | 用 image_quote 查（站点 1k/2k/4k 分档） | **默认生图模型**：批量/迭代首选，延迟约 GPT Image 2 一半 |
| gpt-image-2 / adobe-firefly / gemini-2.5-flash-image / flux-kontext-max / flux-kontext-pro / flux-1.1-pro | 1 币 | 成品 |
| gpt-image-2.5-sunburst | 用 image_quote 查 | 旗舰精修；非默认 |
| gemini-3.1-flash-image / gpt-image-1.5 / flux-2-pro / flux-2 / flux-1.1-ultra / runway-gen-4-image | 2 币 | 高阶成品 |
| gemini-3-image | 4 币 | 高阶 |
| gpt-image | 6 币 | 最贵，只在用户明确要求时用 |

**模型名必须完全照抄上表**（pixai 系列一定带 `pixai-` 前缀，写错会回 model 错误）。
部分模型 hd 比 standard 贵（如 runway-gen-4-image：标准 2 / hd 4），用 image_quote 查准价。

## 步骤化工作流：生图
1. 未指定模型 → **一律用默认生图模型 `gpt-image-2.5-flare`**（批量/迭代首选；尺寸按站点 1k/2k/4k + 比例白名单，用 image_quote 查准价）；用户点名其他模型时才换。告知用户用了哪个与价钱。
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
- 默认用 `gpt-image-2.5-flare`；用户明确要求省钱/草稿且未点名模型时，可改用 0.001-0.1 币层（pixai / sensenova）；更高单价只在用户指名或成品精修（如 sunburst）时用。
- n 预设 1；>0.1 币的动作扣费前必先报价并等确认（≤0.1 币免确认，方便自由探索）。
- 完全相同的 (model, prompt, size, n) 会命中快取，0 币直接回旧图——不必重发。
