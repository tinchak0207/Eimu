# Image Studio Agent 原生终极落地方案设计书

版本：2026-08-01 / v1.0（决策稿）  
目标区间：M0-M6 为 12 周可交付主线，M7-M9 为 6-12 个月验证，终局观察期为 12-24 个月。  
边界：本文只设计 Image Studio 的 Agent API 轨，不改变仓库上位 Core Goal；不代表本文中的新增能力已经部署或通过生产验收。

## 0. 事实边界与第一性原理结论

### 0.1 可测终态

一个从未见过 Image Studio、但持有合法付款授权的 Agent，仅凭站点公开机器入口，在 30 秒内找到正确接入方式和价格，在 5 分钟内提交并取得一个可校验的真实图片 artifact，收到不可重复扣费的 receipt，并把本次成功参数保存为可版本化复用的 workflow；全程不需要 Image Studio 人员解释、发 key、查单或补账。

### 0.2 系统原语

| 原语 | Image Studio 中的具体对象 | 必须观察到的证据 |
| --- | --- | --- |
| 可复用资产 | 模型池、中文 prompt/LoRA/style/reference 模板、现有生成路由、Blob、Mapay、PostgreSQL control plane | version、owner、license、调用成功率、真实 artifact |
| 硬约束 | 上游成本/配额、内容政策、支付授权、Vercel 时限、租户隔离、不可暴露上游凭证 | 失败分类、账本不变量、审计事件、隔离测试 |
| 状态转换 | discover -> authorize/pay -> quote -> reserve -> generate -> moderate -> deliver -> commit/refund -> save workflow | 每次转换有 durable row 和 correlation id |
| 决策函数 | 能力匹配、报价、预算准入、风控、供应商选择、refund、workflow 排名 | versioned input + explainable decision code |
| 最终证据 | Agent 收到图片、hash、receipt、workflow version，并能再次调用 | 两次真实调用可追溯到同一 tenant/workflow，且各只结算一次 |

### 0.3 当前主链与单一瓶颈

最短主链是：`机器可发现入口 -> 可比较能力/价格 -> 合法主体身份或钱包 -> 独立 API 余额/预算 -> durable generation job -> 多供应商执行 -> artifact 校验/审核 -> 原子结算 -> workflow 固化/复用`。

当前单一瓶颈是 **Agent 经济身份与 durable 账本契约**。生成路由已有可复用代码，llms.txt/MCP 也容易增加；但如果 key 仍需人工签发、API 余额仍借用零售金币、支付仍要求人打开 Mapay 页面、扣款仍依赖无幂等保证的外部 quota mutation，那么“自主接入和付费”并不存在。

### 0.4 重要判断标签

- `FACT`：当前 checkout 已有 `/v1/images/generations`、`/v1/models`、B2B key、PostgreSQL generation jobs、supplier lease、billing operation、callback outbox 等代码；这些改动大量处于未提交状态，且本设计未验证其生产部署。
- `FACT`：当前 B2B key 主存储仍在 Vercel Blob，进程内还有 cache/usage buffer；零售计费经 New API quota，Mapay 成功后生成兑换码。两轨尚未形成独立、统一、可审计的 API ledger。
- `FACT`：MCP 官方 HTTP transport 是 Streamable HTTP；远程授权遵循 OAuth 2.1，并通过 Protected Resource Metadata、Authorization Server Metadata、PKCE/DCR 等机制发现。
- `FACT`：官方 MCP Registry 发布物是 `server.json`；`/.well-known/mcp.json`可作为站点级补充发现入口，但不能代替 Registry metadata 和 OAuth discovery。
- `FACT`：llms.txt 是面向 LLM 的社区提案和内容索引，不是 SEO 排名保证。
- `INFERENCE`：未来 12-24 个月，OpenAI-compatible API、MCP、x402/AP2/ACP 中任何单一协议都可能变化，因此协议只能是 adapter，不能成为核心资产模型。
- `HYPOTHESIS`：经过验证的中文 workflow 资产及其跨模型表现数据，会比同一批上游模型的转售价更能提高留存和毛利。M8 必须用真实复用率验证，不能当成事实。

## 1. 执行摘要

1. **推荐方案 D：Agent Workflow Exchange Runtime。** 保留 OpenAI-compatible API 做最低摩擦入口，以 durable async job/ledger 做可信底座，以 MCP 暴露按意图分组的能力，以版本化 workflow 作为真正产品单位；开放市场只在私有/精选资产被证明有复用后启动。
2. **先修经济闭环，再做协议外观。** API wallet、quote、reserve/commit/refund、tenant/key scope、budget policy 必须独立于零售金币；`llms.txt + MCP + API` 接到旧计费上只会放大盗刷和对账风险。
3. **不把“OpenAI compatible”和“durable async”混成一个响应。** 标准同步模式返回 OpenAI Images response；Agent-native 模式由 `Prefer: respond-async` 或 `/v1/image-jobs` 返回 `202 + task_id`，MCP 只走后者。
4. **护城河不是 prompt 列表，而是可执行、可评价、可迁移的 workflow contract。** 每个 workflow 必须有 input schema、版本、模型能力约束、资产 license、成本、质量指标、lineage 和可复现实例。
5. **推翻本推荐的条件：** 上线 30 个高质量 workflow 后 90 天内复用调用占 API 调用仍低于 15%，或 workflow 用户的 30 日留存不高于裸模型 API 用户 10 个百分点；届时停止市场建设，退回“可靠的多供应商 API 聚合层”。

## 2. Agent 端到端旅程推演与卡点清单

### 2.1 逆向旅程

| 节点 | 首次 Agent 会问什么 | 当前障碍与放弃条件 | 设计后的机器答案 | 可执行证明 |
| --- | --- | --- | --- | --- |
| 1. 第一次接触 | 这是网页、API 还是 tool server？ | `FACT`：能力主要从 React/DOM 暴露；根路径没有权威 machine entry。抓到营销 HTML 后无下一步就放弃。 | 根响应和 `/llms.txt` 指向 OpenAPI、MCP、capabilities、pricing、policy；`/.well-known/mcp.json`和 Registry 可发现。 | 新环境中的 Agent 只给域名，30 秒内说出 3 种接入方式及正确 URL。 |
| 2. 判断可用 | 有哪些模型/操作/尺寸/参考图/LoRA？现在健康吗？ | 静态模型名不能证明当前可生成；不清楚生成、编辑、reference、workflow 的能力差异。 | `/v1/capabilities` 返回 versioned capability、实时 `availability`、价格单位、queue ETA、policy class，不暴露供应商。 | Agent 选择一个当时 `available` 的模型；请求与 capability version 对上。 |
| 3. 比较成本 | 这次任务最多花多少？失败怎么收钱？ | 零售 coin 对机器没有货币语义；未发请求前无法确定 workflow、质量、n 的总价。 | `POST /v1/billing/quotes` 返回 15 分钟签名 quote：货币、max total、price version、royalty、tax、refund rule。 | Agent 在预算上限内选方案；服务端不能结算超过 quote。 |
| 4. 选择接入 | 用 SDK、REST 还是 MCP？ | 文档、schema 与实际 route 可能漂移；MCP 工具若按模型堆砌会让 Agent 选择困难。 | 同一份 schema 生成 OpenAPI、llms-full、MCP tool input；SDK 走 OpenAI common subset，复杂流程走 MCP/native job API。 | contract test 证明三种入口编译到同一 command。 |
| 5. 鉴权 | 如何取得身份和最小权限？ | 当前 key 需要管理员签发并绑定 New API user；无 tenant、scope、rotation、self-service。 | OAuth 2.1 + PKCE/DCR 用于委托 Agent；service account 可自助创建 scoped key；x402 wallet 可映射 ephemeral payer tenant。 | 无 Image Studio 人工操作创建 key，密钥仅显示一次，可撤销/轮换。 |
| 6. 付费/额度 | 如何在授权预算内支付或续费？ | Mapay 是人类跳转流程；retail coin 与 API 成本混在一起会套利；无 auto top-up/budget mandate。 | 国内 API 预付走 Mapay adapter，全球机器微支付走 x402，企业走预付/credit line；全部归一为独立 API ledger。 | 余额不足时 Agent 获取 402/quote，付款后同一 idempotency key 继续，不重复提交上游。 |
| 7. 输入资产 | reference image、LoRA、style 如何传？ | DOM upload 语义不可见；直接 Base64 既昂贵又难做 retention/security。 | `POST /v1/uploads` 返回短时 signed PUT；上传完成后得到 tenant-bound `asset_id`、hash、role、expiry。 | Agent 上传一张 reference，越权 tenant 无法读取，生成记录引用同一 hash。 |
| 8. 调用与等待 | 超时能否安全重试？ | 同步长请求受 Vercel 时限影响；如果 202 task 混入标准 OpenAI response，SDK 行为不确定。 | `Idempotency-Key` + durable job；native async 返回 202，poll/webhook；同步 compatibility 只在明确预算内等待。 | 20 个并发同键请求只有 1 job、1 reserve、1 次每输出 provider submit。 |
| 9. 拿结果 | 结果是否真是图、属于本任务、多久有效？ | HTTP 200/URL 不代表可解码图片；公开 Blob URL 可能泄露。 | artifact 有 MIME、decode、width/height、SHA-256、retention；下载 URL 短时签名，响应带 receipt/trace。 | Agent 下载、解码、核对 hash；坏字节绝不进入 `succeeded`。 |
| 10. 失败/退款 | 哪一步失败？是否扣费？能否恢复？ | 外部 quota mutation 无幂等时，timeout 造成 debit unknown；Agent 不知道是否重试。 | 状态机显式区分 `billing_unknown`、`submit_unknown`、`refunded`；unknown 冻结而不盲重试，结构化 `next_action`。 | 故障注入后无双扣/双提交；Agent 根据错误码自动 poll、retry 或停止。 |
| 11. 复购 | 如何持续运行而不守着余额？ | 无预算策略、余额阈值、usage forecast、机器 receipt。 | `budget_policy` 限额、auto-fund mandate、usage API、webhook、invoice/receipt；价格变更需新 quote。 | 连续 100 次调用不超日预算；低余额由 Agent 或 mandate 自动补充。 |
| 12. 沉淀复用 | 如何把成功做法交给下次/别的 Agent？ | prompt/LoRA/style 只存在 UI state 或历史记录，缺 version/license/input schema。 | 成功 job 可 `save_workflow`，生成 immutable version；workflow 可 private/team/public，支持 fork lineage 和可验证指标。 | 第二个 Agent 只给 workflow ref + inputs，得到符合 acceptance profile 的图。 |

### 2.2 旅程中的真实人工边界

“无需人工介入”不能违反付款授权这一原语：一个没有任何 owner grant、credit line 或 wallet 的 Agent，不能合法地替陌生主体创造支付授权。产品承诺应写成：**无需 Image Studio 人工介入；拥有预授权支付能力的 Agent 可全自动完成。** OAuth 首次 consent、企业授信/KYC、专票资质审批属于 payer/法律主体授权，不伪装成可消除步骤；x402 预授权 wallet 是真正的纯机器首次调用路径。

## 3. 终极方案架构

### 3.1 多方案竞争

| 维度 | A 守成者：协议四件套 | B 平台者：Workflow as API | C 生态者：开放资产市场 |
| --- | --- | --- | --- |
| 终局形态 | llms.txt + OpenAPI + key + MCP 包装现有生成 | prompt/LoRA/style/reference 被编译成可版本化 workflow，模型只是执行器 | Agent 可创作、fork、交易 workflow/LoRA/style，平台抽佣 |
| 商业模型 | 纯 usage margin | usage + workflow premium + team plan | usage + 交易抽佣 + creator payout + enterprise private registry |
| 护城河 | 低接入摩擦、供应商聚合 | 中文场景 workflow、跨模型编译、质量/成本数据 | 双边网络、lineage、声誉与交易流动性 |
| 1 人成本 | 4-6 周可上线 | 10-14 周得到可用 v1 | 至少 6-12 个月，且需要运营/法务/审核 |
| 12 个月后 | 一个更易接入的图片转售 API | Agent 可稳定调用并沉淀团队资产的工作流平台 | 若冷启动成功，形成垂直资产市场；失败则是无人使用的目录 |
| 核心风险 | 上游绕过、价格战、协议同质化 | workflow 不够可复现，退化为 prompt 收藏夹 | 冷启动、侵权、恶意 LoRA、刷榜、payout 合规 |

### 3.2 红队攻击与裁决

| 方案 | 最致命的一击 | 是否可防御 | 裁决 |
| --- | --- | --- | --- |
| A | 上游或大平台提供同样的 OpenAI/MCP 接口并降价 30%，迁移只需换 base URL。 | 基本不可防。可靠性可延缓流失，但没有迁移成本和独有 outcome。 | **砍掉为终局方案**；只保留作 M0 分发入口。 |
| B | 巨头复制热门 prompts，或模型升级让旧 prompt 失效；workflow 资产价值归零。 | 可防一部分。把资产定义为 versioned program + eval profile + compiler + lineage，而不是文本；持续跨模型回归。 | **保留为核心**；必须用复用率和质量增益验证。 |
| C | 开放上传引入侵权/NSFW/盗版 LoRA，creator 供给不足，Agent 又没有购买意愿；合规成本先于网络效应爆发。 | 早期不可完全防。只有在私有/精选 catalog 已有需求和审核运营能力后才可控。 | **不在前 6 个月开放**；先做 private/team/curated，再用闸门决定是否市场化。 |
| 全部方案 | Agent 生态从 MCP 切到新协议，或 OpenAI-compatible 语义改变。 | 可防。所有协议必须编译到同一 command/identity/ledger/workflow core。 | 采用 adapter 架构；不让 MCP/ACP/x402 schema 成为内部表结构。 |

### 3.3 收敛方案 D（9 句话）

1. Image Studio 的核心产品单位从“某模型的一张图”升级为“给定输入 schema、预算和质量约束后可重复执行的 workflow version”。
2. OpenAI-compatible API 负责零学习成本，MCP 负责按意图发现和组合，二者都只调用同一个 command service。
3. 每个 paid command 先经过 tenant identity、signed quote、budget policy 和 ledger reserve，再进入 durable job，避免协议层各自计费。
4. PostgreSQL 记录 job、lease、attempt、artifact、moderation、usage 和 ledger；Vercel 只接收命令与查询状态，worker 独占上游 side effect。
5. Sub2API、Adobe2API 和 relay 是可替换 supplier，不是公开产品身份；capability contract 隔离模型变化。
6. workflow 把中文 prompt、LoRA、style、reference roles、质量 profile 和 fallback policy 编译成供应商可执行参数，并持续保存真实成功率、成本和 latency。
7. 私有和团队 workflow 先创造留存，精选公共 catalog 再创造分发，开放交易必须等复用和合规闸门通过。
8. x402/AP2/ACP/Mapay 都是 payment adapter，内部唯一事实源仍是双重记账式 API ledger 和不可变 usage event。
9. 因此即使上游、MCP 或支付协议变化，迁移只替换边缘 adapter，已沉淀的 workflow、评价数据、tenant 集成和账本关系继续复利。

### 3.4 权威请求路径

| 层 | 唯一责任 | 现有资产 | 推荐新增/修正 |
| --- | --- | --- | --- |
| Discovery | 告诉机器“能做什么、怎么接、多少钱、受什么政策约束” | `docs/biz-api.md`（当前编码质量需修复） | `public/llms.txt`、`public/llms-full.txt`、`public/openapi.json`、`public/.well-known/mcp.json`、`server.json`、`src/app/api/v1/capabilities/route.ts` |
| Contract | 一个 schema owner 生成 REST/MCP/docs | `src/lib/api-types.ts`、`src/lib/generation-model-catalog.ts` | `src/lib/agent-contract/schemas.ts`、`src/lib/agent-contract/openapi.ts`、`tools/build-agent-discovery.ts`；引入 `zod` 与 OpenAPI generator |
| Identity | tenant、principal、OAuth、service key、scope | `src/lib/new-api-auth-server.ts`、`src/lib/biz-api-keys.ts` | `src/lib/agent-auth/*`、`src/app/api/v1/api-keys/*`、`src/app/.well-known/oauth-protected-resource/mcp/route.ts`；使用成熟 Authorization Server，不自研密码/OAuth |
| Commercial | quote、wallet、预算、reserve/commit/refund、receipt | `src/lib/image-billing.ts`、`src/lib/generation-core/billing-ledger.ts`、Mapay routes | `src/lib/agent-billing/*`、`src/app/api/v1/billing/*`、migrations `005_agent_tenancy.sql`、`006_api_ledger.sql`、`007_price_book.sql` |
| Command | REST/MCP/UI 归一为同一业务命令 | `src/lib/generation-core/command-service.ts` | `src/lib/generation-service.ts` 作为公开 facade；禁止 MCP 直接调用 supplier adapter |
| Execution | durable job、lease、failover、callback | `db/migrations/001_generation_control_plane.sql`、`src/lib/generation-core/*`、`worker/generation-worker.ts` | 收口 legacy sync branch；补 source=`mcp/x402`、tenant FK、price/workflow/moderation 字段 |
| Supplier | 私有供应商能力与故障域 | `src/lib/sub2api.ts`、`src/lib/biz-image-pipeline.ts`、`supplier*` tables | 供应商只由 scheduler 选择；删除 API 层 in-process health/rate truth source |
| Artifact | 上传、验证、私有交付、retention | Vercel Blob、`artifact-service.ts` | `src/app/api/v1/uploads/*`、`src/lib/agent-assets/*`；tenant prefix、private access、signed URL、hash |
| Workflow | version、compile、run、lineage、metrics | `src/lib/generation-workflow.ts`、LoRA/model catalog、UI preset | `src/lib/workflows/*`、`src/app/api/v1/workflows/*`、migrations `008_workflow_registry.sql` |
| MCP | 意图工具、resource、OAuth、Streamable HTTP | 无 | `src/app/mcp/route.ts`、`src/lib/mcp/server.ts`；`@modelcontextprotocol/sdk`；11 个稳定工具 |
| Governance | moderation、abuse、audit、SLO、canary | `admin-audit.ts`、`slo-service.ts`、`canary-service.ts` | migrations `009_trust_safety.sql`；policy engine、risk rules、appeal/audit endpoints |

### 3.5 对外端点契约

| 端点 | 用途 | 认证/幂等 | 关键返回字段 |
| --- | --- | --- | --- |
| `GET /llms.txt`、`GET /llms-full.txt` | 机器总入口和完整文档 | public，ETag | canonical links、quickstart、error recovery、policy |
| `GET /openapi.json` | REST 权威 schema | public，versioned | OpenAPI 3.1；每个 mutation 的 errors/examples |
| `GET /.well-known/mcp.json` | 站点级 MCP 提示 | public | remote URL、transport、auth metadata、registry name |
| `GET /.well-known/oauth-protected-resource/mcp` | MCP OAuth discovery | public | resource、authorization_servers、scopes_supported |
| `GET /v1/capabilities` | 可执行能力而非静态 model list | public/basic auth | `capability_version`、operation、sizes、reference/LoRA、availability、queue_eta、price_from |
| `GET /v1/models` | OpenAI model list common subset | Bearer | public model ID；专有能力放 `x_image_studio` namespace |
| `POST /v1/billing/quotes` | 预算确定性 | OAuth/key/wallet challenge；request idempotent | `quote_id`、currency、max_total_minor、breakdown、expires_at、price_version、refund_policy |
| `POST /v1/uploads` | 创建 reference/LoRA 输入上传 | `assets:write`；Idempotency-Key | `asset_id`、signed PUT、headers、max_bytes、expires_at |
| `POST /v1/images/generations` | OpenAI common subset，同步 compatibility | Bearer；Idempotency-Key 建议 | 正常返回 ImagesResponse；`Prefer: respond-async`才返回 task |
| `POST /v1/image-jobs` | Agent-native durable async | `images:write`；Idempotency-Key 必填 | 202、`task_id`、status URL、quote/receipt refs |
| `GET/DELETE /v1/image-jobs/{id}` | poll/cancel | tenant-bound | public state、progress、structured error、`next_action` |
| `GET /v1/image-jobs/{id}/result` | artifact/receipt | tenant-bound | signed URL/base64、SHA-256、dimensions、retention、usage、receipt |
| `GET/POST /v1/workflows` | 搜索/创建 workflow | read/public 或 `workflows:write` | version、input schema、license、price、quality profile |
| `POST /v1/workflows/{id}/runs` | 运行固定 workflow version | `images:write`；Idempotency-Key | durable task；不得静默升级 version |
| `POST /v1/feedback` | 显式质量反馈 | tenant/job-bound；幂等 | accepted metric id；默认不公开 prompt |
| `GET /v1/usage`、`GET /v1/billing/balance` | 自主续费/预算 | `usage:read` | committed/reserved、forecast、budget remaining |
| `POST /mcp` | MCP Streamable HTTP | OAuth Bearer，audience/resource 校验 | JSON-RPC；工具只返回结构化 content 和 resource links |

#### OpenAI compatibility 的明确边界

- `/v1/images/generations` 只承诺官方 Images API 的**公共交集**：`model`、`prompt`、`n`、`size`、`quality`、`output_format`等；Image Studio 专有字段放在 `extra_body.image_studio`，不冒充官方字段。
- 复杂 reference roles、LoRA、workflow、callback 和 budget 使用 native endpoint 或 MCP；不要求每个 OpenAI SDK 都理解扩展。
- 当前 control-plane 分支在同一路径直接返回 `202 task`，这不是严格的同步 SDK response。M2 必须用 opt-in async 或独立 `/v1/image-jobs` 修正，contract tests 同时覆盖两种模式。
- capability 只在真实 canary 通过后标记 `available`；`/v1/models` 可列出但必须区分 `configured`、`degraded`、`available`，不得把 model list 当生成证明。

### 3.6 MCP 工具集：11 个意图工具

| 工具 | 单一意图 | 重要约束 |
| --- | --- | --- |
| `discover_capabilities` | 找到当前可执行模型/工作流/价格入口 | 读缓存，不泄露 supplier |
| `quote_generation` | 在预算内取得签名报价 | 返回 max cost 和 expiry，不执行生成 |
| `create_upload` | 为 reference/LoRA 建 signed upload | 限 MIME/大小/tenant/TTL |
| `generate_image` | 从 prompt + asset refs 建 durable job | 必须带 idempotency key 和 quote/budget |
| `edit_image` | 显式图像编辑 | 与 generate 分开，避免参数歧义 |
| `get_generation` | poll 状态和 next action | unknown 状态禁止 Agent 猜测重试 |
| `cancel_generation` | 取消未提交任务 | provider 已提交时返回不可取消原因 |
| `search_workflows` | 按意图、语言、质量、价格搜索 | 只返回可访问版本 |
| `get_workflow` | 读取固定 workflow version/schema/license | 版本不可变 |
| `run_workflow` | 传入 schema inputs 执行 | 不允许静默改写 model/price/version |
| `get_usage` | 查余额、预算、receipt、forecast | scope=`usage:read` |

`save_workflow` 暂不放进首批 11 个工具；由 `POST /v1/workflows` 和 MCP resource action 在 M4 后加入。理由是首批工具优先覆盖高频消费旅程，避免开放写入先于 license/moderation。

### 3.7 Workflow contract

`workflow_version.definition_json` 至少包含：

```json
{
  "schema_version": 1,
  "workflow_id": "wf_product_hero",
  "version": "1.2.0",
  "input_schema": {
    "type": "object",
    "required": ["product_asset", "selling_point"],
    "properties": {
      "product_asset": { "type": "string", "format": "asset-id" },
      "selling_point": { "type": "string", "maxLength": 120 }
    }
  },
  "compiler": {
    "prompt_template": "...",
    "negative_prompt": "...",
    "reference_roles": { "product_asset": "subject" },
    "style_refs": ["style:clean-commerce@3"],
    "lora_refs": [],
    "capability_requirements": ["image.edit", "reference.subject"],
    "fallback_policy": "same_capability_only"
  },
  "acceptance_profile": {
    "aspect_ratio": "1:1",
    "min_resolution": "1024x1024",
    "moderation_policy": "commercial-default",
    "eval_suite": "eval_product_hero_zh@2"
  },
  "commercial": {
    "license": "commercial-use",
    "royalty_bps": 500
  }
}
```

关键不变量：workflow version immutable；运行必须记录 exact version、compiler version、capability contract version、input asset hash、quote version；fork 必须保留 lineage；LoRA/参考图必须有 owner/license/provenance；任何成功率都按真实 artifact + moderation pass 计算，而非 HTTP status。

### 3.8 PostgreSQL 数据模型

| migration / table | 关键字段与不变量 |
| --- | --- |
| `005_agent_tenancy.sql` / `tenant` | `id, slug, plan_tier, risk_tier, status, home_region`; 所有业务表带 `tenant_id`，开启 RLS |
| `principal` | `tenant_id, issuer, subject, principal_type, roles`; `(issuer, subject)` unique |
| `api_credential` | `prefix, secret_hash, scopes[], allowed_models[], allowed_workflows[], rpm, max_concurrency, daily_spend_limit_minor, expires_at, revoked_at`; secret 只显示一次 |
| `006_api_ledger.sql` / `api_wallet` | `currency, available_minor, reserved_minor, version`; API wallet 与 retail coin 无兑换关系 |
| `api_ledger_entry` | `event_type, amount_minor, job_id, quote_id, idempotency_ref unique, balance_after`; append-only，不能 update/delete 金额 |
| `budget_policy` | `period, hard_limit_minor, max_unit_price_minor, max_concurrency, auto_fund_method_id`; 每次 reserve 原子检查 |
| `usage_event` | `operation, quantity, model_id, workflow_version_id, price_version, artifact_count`; immutable |
| `007_price_book.sql` / `price_book_item` | `currency, billing_unit, tier, unit_price_minor, floor_price_minor, valid_from/to, version`; quote 锁版本 |
| `billing_quote` | `request_hash, breakdown_json, max_total_minor, signature, expires_at, consumed_at`; 只能消费一次 |
| `payment_intent` | `provider(mapay/x402/invoice), external_ref, amount, status, settlement_evidence`; provider callback 幂等 |
| `008_workflow_registry.sql` / `workflow` | `owner_tenant_id, slug, visibility, status, current_version_id, license_policy` |
| `workflow_version` | `semver, definition_json, definition_hash, compiler_version, parent_version_id, moderation_status`; immutable unique |
| `workflow_asset` | `workflow_version_id, asset_id, role, license_id, sha256` |
| `workflow_run` | `workflow_version_id, generation_job_id, input_hash, compiler_output_hash` |
| `workflow_metric` | `window, real_runs, success_rate, p50/p95_latency, avg_cost, quality_score, complaint_rate`; 不存虚假“热度” |
| `009_trust_safety.sql` / `moderation_decision` | `tenant_id, job_id, stage(input/output/asset), policy_version, category, action, evidence_ref` |
| `abuse_signal` | `principal/key/wallet/ip hash, signal_type, score, expires_at`; 不把原始敏感标识扩散到日志 |
| `audit_event` | actor、tenant、action、target、before/after hash、trace_id；append-only |

对现有表的修改：`generation_job` 增加 `quote_id, price_version, workflow_version_id, moderation_status, payer_principal_id`；`source` 增加 `mcp/x402`；`api_key_id` 建真实 FK；artifact 默认 private；`billing_operation` 的 adapter 从 New API quota 切到 `api_wallet` 原子 ledger。零售 web job 继续使用零售 billing adapter，两种 balance 绝不共享。

## 4. 商业化设计

### 4.1 双轨隔离

| 规则 | 零售轨 | Agent API 轨 |
| --- | --- | --- |
| 余额 | 现有 coins/New API quota | `api_wallet` monetary minor units 或 contract credits |
| 购买 | Mapay/现有套餐/兑换码 | Mapay API 预付、x402、企业预付或授信 |
| 定价 | 高毛利套餐，保留有效期和 UI 权益 | versioned usage price + workflow royalty + contract discount |
| 接口 | React/UI + `/api/generate-images` | `/v1/*` + MCP |
| 转移 | 不可转移到 API | 不可兑换为 retail coins、CDK 或现金 |
| 风控 | 用户/设备/订单 | tenant/principal/key/wallet/IP/预算/并发 |

禁止任何 `coins -> API balance` 或共享 redemption code 的转换端点。若同一法人同时使用两轨，只共享 KYC/risk identity，不共享价格、余额和优惠。

### 4.2 定价立场

内部统一使用 `billing_unit`，当前模型映射可从现有 catalog 起步：GPT Image 2 standard/1K = 1 unit；high/2K 与 Nano Banana Pro = 2 units。首发**建议价而非已验证成本事实**：PAYG `¥0.055/unit`，月承诺 100k units `¥0.045/unit`，月承诺 1m units `¥0.040/unit`；USD 按 quote 时汇率锁 15 分钟，不在 job 完成后换汇。

真实报价必须执行：

`unit_price = max(contract_price, (p95_supply_cost + infra + expected_abuse_loss + royalty) / (1 - target_gross_margin))`

首发 target gross margin 为 25%；任何模型连续 7 天毛利低于 15% 就停止新 quote 或升价，不靠暗降分辨率/质量补毛利。workflow royalty 单独展示，精选资产建议 0%-20%；开放市场若启动，creator/platform 对 royalty 净收入建议 70/30，模型 usage 收入不参与 creator 分成。

### 4.3 一次调用的资金状态机

1. `quote` 锁定 max amount、price version、refund rule 和 expiry。
2. `reserve` 在 PostgreSQL 同一事务内检查 tenant/key/budget/wallet，将 available 移到 reserved，并写 unique ledger entry。
3. `commit` 只按通过 artifact gate 的成功输出数量结算；partial success 只收成功部分。
4. input moderation 拒绝、无上游 submit、无有效 artifact 时全部 release；用户主动取消但已 submit 时按公开规则处理。
5. `billing_unknown` 或 `submit_unknown` 冻结对应 reserved amount，自动 reconcile；绝不换 idempotency key 再扣/再提交。
6. x402 的链上 settlement 若先于生成失败，不做高频链上退款；等值金额记回 API wallet，达到阈值或关户时再原路结算。此规则必须在 quote 中明示。

### 4.4 支付与发票路径

- **国内 self-service**：新增 API credit SKU，复用 Mapay signature/notify，但 notify 直接幂等记入 `api_wallet`，不生成 retail redemption code。
- **全球纯机器路径**：x402 adapter 接收 402 challenge、verify/settle evidence，并把 wallet subject 映射到 payer tenant；平台不托管私钥。
- **委托 Agent 路径**：后续 AP2/ACP adapter 只负责验证 mandate/checkout authorization，再创建内部 `payment_intent`；不把协议对象直接当账本。
- **企业路径**：billing profile 包含 `legal_name, tax_id, country, currency, invoice_type, billing_email, po_number`；预付默认自动开电子收据，授信客户经 KYC 后 Net-15/Net-30。
- **对公支付**：首次授信/KYC 可以人工，完成后 Agent 可通过 `GET /v1/billing/invoices`、`POST /v1/billing/payment-intents` 和 webhook 自主运营；未授信 Agent 不允许创建负余额。

## 5. 安全与合规设计

### 5.1 滥用与盗刷防护

| 层 | 控制 | 拒绝/降级动作 |
| --- | --- | --- |
| Credential | key prefix + secret hash、scope、expiry、rotation、optional IP/mTLS、OAuth audience | 401/403；不透露 key 是否存在 |
| Tenant budget | 日/月 hard cap、per-job max、unit-price cap、max concurrent jobs | 402 `budget_exceeded`，返回可机器处理的 next action |
| Distributed limit | PostgreSQL/Redis token bucket、active lease count、wallet/IP/risk group | 429 + Retry-After；禁止进程内 Map 成为权威 |
| Payment risk | provider signature、callback idempotency、wallet reputation、velocity、chargeback linkage | 延迟 settlement、降低额度、要求更强授权 |
| Arbitrage | 两轨余额不可兑换、API SKU 不发 CDK、合同价绑定 tenant、禁止转售 key | 冻结 key/tenant，保留 appeal 和 audit evidence |
| Supplier protection | 不暴露 upstream label/key/admin；输出只带 public capability/trace | 安全日志用 public trace，不回传内部 failure detail |

### 5.2 内容安全 pipeline

1. **Preflight**：prompt、workflow input、文件 MIME/size/hash、明显违法类别和 policy version；失败不 reserve 或立即 release。
2. **Reference/LoRA gate**：malware/file parser 隔离、感知 hash、real-person/brand/IP 声明、license/provenance；未知 LoRA 不进入 public catalog。
3. **Provider policy**：保留上游 safety decision 但不把它当唯一审核。
4. **Output gate**：解码、尺寸/hash 后，在交付前做 CSAM/NCII/暴力/仇恨/欺诈 impersonation 等分类；高风险进入 quarantine，不生成公开 URL。
5. **Provenance**：对公开/商业输出写入生成 provenance（优先 C2PA 或等价 signed metadata），receipt 记录 model class、workflow version、policy version，不泄露供应商凭证。
6. **Appeal/takedown**：`POST /v1/safety/appeals`、copyright/DMCA intake、repeat infringer policy；public workflow 被下架时已有 private license 是否继续可用由 license policy 决定。

禁止类别至少包括 CSAM、NCII、欺诈性身份冒充、违法交易支持、明确侵权资产和绕过安全控制；真实人物、政治/广告、医疗等高风险场景按市场和司法辖区配置更严格 policy。正式 GA 前由法律顾问确认 Terms、Privacy、DPA、跨境数据、税务和内容责任，设计书不替代法律意见。

### 5.3 多租户与数据保护

- PostgreSQL 所有 tenant 数据表带 `tenant_id` 并启用 RLS；repository query 还必须显式传 tenant，形成双重约束。
- Blob object key 使用 `tenant/{tenant_id}/jobs/{job_id}/...`，默认 private；signed URL 10 分钟，reference 默认 24 小时、output 默认 30 天，可按企业 policy 缩短。
- prompt 使用现有 AES-256-GCM 能力并增加 key version；KMS/secret store 托管 master key，支持双 key rotation，不把 token/cookie/完整 prompt 写日志。
- API key 建议 256-bit random secret，数据库存 HMAC-SHA-256/peppered hash 和 prefix；secret 仅签发时显示一次。
- webhook 使用 HMAC key version、timestamp、delivery id，接收方可防 replay；callback 必须做 DNS/IP 解析级 SSRF 防护，而不仅是 hostname regex。
- workflow 作者默认不获得调用者 prompt/reference；聚合指标需最小样本阈值和 opt-in，禁止把私有输入变成 public training data。

### 5.4 可靠性与 SLA

| 指标 | GA SLO | 证据来源 |
| --- | --- | --- |
| Control API availability | 99.9% monthly | synthetic canary + edge/API telemetry |
| Accepted job terminalization | 99.5% 在 10 分钟内进入 succeeded/failed/refunded/unknown | `generation_job` durable states |
| Artifact integrity | 100% succeeded jobs 至少有一个通过 decode/hash/dimension 的 artifact | `artifact` rows + object verification |
| No double charge/submit | 100% | unique idempotency + ledger/attempt reconciliation |
| Callback | 99.9% 在终态后 5 分钟内 delivered 或进入可见 dead letter | `callback_delivery` outbox |
| Contracted queue start | p95 < 5 秒（不超购买并发时） | job timestamps/lease |

只有在连续 30 天生产数据达标后才售卖 SLA；首版合同建议 99.5% monthly availability 和 service credit，而不是承诺单一上游永不降级。故障转移必须跨 failure domain；401/403 禁用 credential，429 遵循 Retry-After，408/5xx 判 overloaded 并 fail over，不能从 408 推断 Adobe scope 错误。

## 6. 里程碑与验收标准

每个里程碑均为 1 人 1-2 周范围；若实际超过，必须再切分，不能以“部分完成”冒充验收。

### M0：机器真相面（1 周）

- **文件/工具**：新增 `src/lib/agent-contract/schemas.ts`、`tools/build-agent-discovery.ts`、`public/openapi.json`、`public/llms.txt`、`public/llms-full.txt`、`public/.well-known/mcp.json`、`server.json`；修复 `docs/biz-api.md` UTF-8；新增 CI contract drift test。
- **端点**：补 `GET /v1/capabilities`，只暴露 canary 已证明状态。
- **依赖**：确认当前 public model ID、价格单位、错误码、policy URL；不需要新支付。
- **真实 Agent 验收**：在全新 Claude Code/Cursor workspace 只给域名和一个预发 sandbox key；Agent 30 秒内找到 base URL、鉴权和模型，5 分钟内生成并解码一张真实图；production first-hop、Blob artifact、hash、计费记录同一 trace 可关联。
- **失败即不通过**：Agent 需要人告诉 endpoint/header；只拿到 HTTP 200 或 model list；文档与 route schema 不一致。

### M1：Tenant、scoped key 与双轨 API wallet（2 周）

- **文件/表**：`005_agent_tenancy.sql`、`006_api_ledger.sql`；`src/lib/agent-auth/*`、`src/lib/agent-billing/ledger.ts`、`src/app/api/v1/api-keys/*`、`src/app/api/v1/billing/balance/route.ts`。
- **改造**：将 `biz-api-key-store.ts` 的 Blob 记录迁到 PostgreSQL；Blob 保留只读迁移 fallback 后下线。API job 不再绑定 retail New API `userId`。
- **依赖**：managed PostgreSQL、KMS/secret env、一次性 migration/rollback 脚本。
- **真实 Agent 验收**：一个 OAuth service principal 自助创建 `images:write` key；另一个 tenant 即使猜到 job/asset id 也得到 404；100 个并发 reserve 不超预算、余额守恒、无负数。

### M2：可靠的双模式 generation contract（2 周）

- **文件/端点**：复用 `generation-core/*`、`worker/generation-worker.ts`、`001/004` migrations；新增 `/v1/image-jobs`，修正 `/v1/images/generations` 同步 compatibility；补 `DELETE job`、structured `next_action`。
- **依赖**：生产 worker、PostgreSQL、至少两个独立 failure domain、private Blob。
- **真实 Agent 验收**：20 个并发相同 Idempotency-Key 只得到一个 task、一个 reserve、每个 output 一次 submit；注入 408 后跨 failure domain 成功并产出真实图；同步 OpenAI SDK 调用返回标准 ImagesResponse，async 调用返回 202 task。
- **回滚**：关闭 Agent async public flag，但保留 jobs/ledger/artifacts 供对账；禁止删除证据。

### M3：安全上传与 Workflow v1（2 周）

- **文件/表**：`008_workflow_registry.sql`、`src/lib/agent-assets/*`、`src/lib/workflows/{schema,compiler,repository,service}.ts`、`src/app/api/v1/uploads/*`、`src/app/api/v1/workflows/*`。
- **复用**：`generation-workflow.ts` 作为 compiler 输入，LoRA/model catalog 作为 capability owner，不新建平行 prompt 拼接器。
- **依赖**：M1 tenant/RLS、M2 durable job、private Blob 或等价 private object adapter；先定义 asset retention 与 workflow license 最小字段。
- **真实 Agent 验收**：Agent 上传 reference，创建 private workflow v1，运行两次；第二次仅提供 workflow ref + inputs；两次记录 exact version/input hash，跨 tenant 读取失败，输出均通过真实 artifact gate。

### M4：Remote MCP + OAuth 2.1（1-2 周）

- **文件/工具**：`src/app/mcp/route.ts`、`src/lib/mcp/server.ts`、PRM route、Auth server config、`@modelcontextprotocol/sdk`；首发 11 tools；Registry `server.json`。
- **依赖**：选择支持 PKCE、DCR/CIMD、audience/resource 校验的成熟 Authorization Server；默认推荐 Auth0，若中国网络可达性或 DCR policy 实测不通过则换 ORY/Keycloak，不自研 OAuth。
- **真实 Agent 验收**：Claude/Cursor 从 remote MCP URL 自动读取 auth metadata，完成授权后无需手贴 key；调用 `discover_capabilities -> quote_generation -> generate_image -> get_generation` 得到真实图片和 receipt。
- **分发验收**：官方 MCP Registry publish/validate 成功；PulseMCP、Smithery、Cursor/Claude 目录按各自审核流程提交，目录“已提交”不等于“已收录”。

### M5：机器支付闭环（2 周）

- **文件/端点**：`007_price_book.sql`、`src/lib/agent-billing/{quote,pricing,payment-adapters}.ts`、`/v1/billing/quotes`、`/v1/billing/payment-intents`、`/v1/billing/receipts`；Mapay API wallet adapter；x402 adapter。
- **依赖**：merchant/tax/legal review、x402 facilitator 选择与 sandbox、FX source；平台不托管 wallet key。
- **真实 Agent 验收**：零余额 test wallet 请求生成收到机器可读 402，签署 payment payload 后用同一 Idempotency-Key 继续；只 settlement 一次，失败生成自动记回 API wallet，Agent 可读取 receipt 和新余额。

### M6：Trust & Safety GA gate（2 周）

- **文件/表**：`009_trust_safety.sql`、`src/lib/safety/{policy,moderation,risk,retention}.ts`、`/v1/safety/appeals`、admin queue；输入/输出/asset 三段审核。
- **依赖**：审核供应商或自建 classifier 的误报基线、policy/Terms/Privacy/DPA、on-call runbook。
- **真实 Agent 验收**：安全 prompt 正常生成；测试 policy corpus 在 submit 前拒绝且不收费；模拟高风险 output 被 quarantine 且不发 signed URL；appeal 和 audit 可追溯到 policy version。
- **GA 条件**：M0-M6 全过、30 天无双扣、严重安全漏放率在批准阈值内、毛利为正；否则只保持 invite-only。

### M7：Enterprise 可运营性与 SLA（1-2 周）

- **文件/端点**：billing profile/invoice migrations、`/v1/billing/invoices`、team roles、SLO dashboard、budget/webhook admin；复用 `slo-service.ts`、`callback-outbox.ts`、`canary-service.ts`。
- **依赖**：M1-M6 已通过 invite-only 生产验收；至少 30 天 job/ledger/callback/SLO 数据；财务确认 credit line、invoice 和 service-credit 规则。
- **真实 Agent 验收**：企业 tenant 的 CI Agent 在 hard budget 和并发合同内运行 1000 个任务；故障后自动 failover、receipt/invoice 对齐、callback 无丢失，SLO 报告可从 durable rows 重算。

### M8：精选 Workflow Catalog（2 周）

- **文件/表**：workflow moderation、license、metric、ranking、featured collection；`search_workflows` 接真实质量/价格数据。
- **依赖**：至少 30 个经过 20+ 真实运行的中文商业场景 workflow，明确 license 和 owner。
- **真实 Agent 验收**：陌生 Agent 给“电商主图”意图和预算，不指定模型；搜索、报价并运行精选 workflow，结果通过 acceptance profile；再次运行 exact version 可复现结构，而非只复用一段 prompt。
- **决策闸门**：90 天 workflow 调用占比 >=15%，30 日留存提升 >=10pp 才进入 M9。

### M9：受控交易网络（2 周 MVP，随后持续）

- **文件/表**：creator profile、license acceptance、payout ledger、fork lineage、fraud score、takedown；public publish 仍需审核。
- **依赖**：M8 闸门通过、payout KYC/tax、侵权处理 SLA、反刷榜基线。
- **真实 Agent 验收**：Creator Agent 发布 workflow v1，Buyer Agent 读取 license/quote 并运行，usage/royalty 各只记一次；workflow 被下架后新购买停止，历史授权按 policy 可审计处理。
- **终止信号**：投诉/侵权率、payout fraud 或审核成本吃掉 workflow contribution margin 时，关闭 public publish，保留 private/team registry。

## 7. 风险登记册与对策

| 风险 | 领先信号 | 对策 | 回退/换道阈值 |
| --- | --- | --- | --- |
| 上游绕过/价格战 | 同模型价格低 20%+；base URL 迁移流失 | workflow outcome、跨上游 SLA、team registry；不卖供应商身份 | 90 天 workflow 复用 <15%：停止市场，转可靠聚合 B2B |
| 毛利倒挂 | p95 成本/失败退款上升，quote 命中 floor | versioned price floor、容量限售、供应商竞价 | 连续 7 天 GM <15%：停售受影响 capability/涨价 |
| 巨头复制 workflow | 热门 workflow 被低价复制 | eval 数据、lineage、license、跨模型 compiler、团队私有资产 | 留存不提升 10pp：减少资产研发，专注控制面 |
| 盗刷/套利 | velocity、shared keys、chargeback、两轨倒卖 | scope/budget/risk graph、两轨不可兑换、延迟提现 | chargeback >1% GMV 或重大盗刷：关闭自助授信/x402 capability |
| 内容合规封杀 | 严重漏放、平台投诉、上游封号 | 三段审核、quarantine、takedown、provider isolation | 严重事件超过批准阈值：invite-only/关闭相关 workflow 类别 |
| LoRA/IP 侵权 | 无 provenance、重复 takedown、creator 申诉 | license required、hash/lineage、repeat infringer policy | 审核成本 > royalty 毛利：关闭开放上传，回精选 catalog |
| MCP/协议切换 | MCP client share 下滑，新协议 adoption 上升 | schema/command core 与 protocol adapter 分离 | 任一新协议占目标 Agent >30%：新增 adapter，不迁内部模型 |
| x402/监管/波动 | settlement failure、税务/制裁要求变化 | 非托管、allowlist facilitator/network、fiat/Mapay fallback | 法务不批准或 failure >0.5%：关闭 x402，仅保留预付/授信 |
| Vercel/Blob 限制 | timeout、公开 URL、区域延迟 | API/worker 解耦、private artifact proxy、可迁对象存储 adapter | p95 受平台上限控制：worker/object store 迁 VPS/managed service |
| 源码与生产漂移 | repo 有 route，生产无真实 artifact/first-hop | capability 由 production canary 驱动；发布带 contract hash | 无 correlated proof 一律标 `configured/degraded`，不发布 available |
| 单人交付过载 | milestone >2 周、并行未完成项增多 | 每阶段只交一个 end-to-end slice，Marketplace 延后 | 连续两个 milestone 超时：砍 M8/M9，不砍 ledger/safety/reliability |

### 应推翻本推荐的情况

除执行摘要中的 90 天复用/留存闸门外，出现以下任一事实应重建方案：

1. 真实客户任务主要是单次裸模型调用，workflow 额外抽象显著降低成功率或增加 latency，且用户不保存/分享资产。
2. 目标 Agent 客户端对 remote MCP 支持率低于 20%，而 OpenAI-compatible API 占调用 90% 以上；此时 MCP 保持 adapter，不再优先投资目录分发。
3. 上游直接提供同等中文 workflow、可验证质量和更低成本，Image Studio 无法通过多供应商可靠性或团队资产隔离留住客户。
4. 合规、payment KYC、creator payout 的固定成本超过可实现 contribution margin；此时保留 private/team workflow，不做开放交易。

## 8. 明确不做的事（Out of Scope）

1. **不训练自有 foundation image model。** 当前瓶颈是经济闭环、可靠执行和 workflow 复用，不是基础模型供给。
2. **不推翻 Next.js/Vercel/Sub2API/Blob/Mapay。** 通过 adapter 和 PostgreSQL control plane 增量改造；只有指标证明平台上限时才迁具体组件。
3. **不在 M0 同时开放 workflow marketplace。** 没有需求、license 和 moderation 证据的双边市场只会放大风险。
4. **不把 llms.txt 当 SEO/AEO 增长承诺。** 它是 machine documentation index；增长需 Registry、SDK 示例、合作目录和真实开发者使用。
5. **不为每个模型/LoRA/style 建一个 MCP tool。** 工具按用户意图稳定分组，具体能力由 catalog/resource 返回。
6. **不自研 OAuth、卡收单或托管 crypto wallet。** 使用成熟 Authorization Server/payment facilitator，Image Studio 只验证授权并记内部账。
7. **不允许 retail coin、CDK、API wallet 互转。** 这是双轨防套利的硬边界。
8. **不暴露 Sub2API admin、供应商账户、token/cookie、内部 endpoint label。** Agent 只看到 public capability、trace 和可处理错误。
9. **不承诺“匿名免费无限试用”。** 可有固定水印/低成本 sandbox，但 public 首次真实商业调用必须有 identity、预算或 wallet。
10. **不把同步 HTTP 连接当可靠任务系统。** 同步只是 compatibility view，durable job 是唯一 side-effect owner。
11. **不在前 6 个月做多区域 active-active。** 先把单区域 durable 状态、备份、恢复和 SLO 做实，再由客户地域/延迟证据决定。
12. **不把 AP2/ACP/x402 任一版本写进核心表结构。** 它们是可替换 payment authorization adapter。

## 9. 最终无人解释自检

目标 Agent 的唯一输入是域名、它自己的合法身份/付款授权和任务意图。设计后的闭环为：根/llms/MCP Registry 自动发现 -> capabilities/policy/price 自动比较 -> OAuth/key/x402 自动选择 -> quote 验证预算 -> signed upload -> idempotent durable job -> poll/webhook -> artifact hash/receipt 验证 -> balance/forecast -> exact workflow version 保存和复用。

仍需人工的只有三类主体授权：首次 OAuth consent、企业 KYC/授信、专票资质；它们不能由 Image Studio 或 Agent 伪造。对已经持有 wallet/mandate/service credential 的 Agent，设计中没有需要人工解释、发 key、查 endpoint、确认价格、补单、退款或告诉它如何重试的步骤。

**当前状态结论**：这份设计通过了逻辑自检，但 Image Studio 尚未因此成为 Agent 原生平台。只有 M0-M6 的真实 Agent 验收均产生 correlated production evidence，才能宣称完成第一阶段；M8 闸门通过后，才能宣称 workflow 护城河得到证据；M9 有真实供需和结算后，才能宣称网络效应存在。

## 10. 核验来源

### 当前仓库证据

- `src/app/api/v1/images/generations/route.ts`：现有 B2B route、Bearer key、同步 legacy 分支、control-plane 202 分支。
- `src/lib/biz-api-key-store.ts`：当前 Blob key index、memory cache、usage buffer 与迁移必要性。
- `db/migrations/001_generation_control_plane.sql`、`004_billing_reconciliation.sql`：job、attempt、supplier lease、artifact、callback、billing operation。
- `src/lib/generation-core/{command-service,billing-ledger,callback-outbox,scheduler,artifact-service}.ts`：可复用 durable control-plane 资产。
- `src/lib/generation-workflow.ts`、`src/app/api/lora-models/route.ts`：现有 workflow metadata/prompt compile 与 LoRA 入口。
- `src/lib/mapay.ts`、`src/lib/mapay-redemption.ts`、`src/lib/plans.ts`：零售 payment/redemption/price 资产和双轨隔离边界。

### 外部一手来源（访问于 2026-08-01）

- MCP transports：<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports>
- MCP OAuth authorization：<https://modelcontextprotocol.io/docs/tutorials/security/authorization>
- MCP Registry metadata/publishing：<https://modelcontextprotocol.io/registry/about>、<https://modelcontextprotocol.io/registry/quickstart>
- llms.txt proposal：<https://llmstxt.org>
- OpenAI Image API guide/reference：<https://developers.openai.com/api/docs/guides/image-generation>、<https://developers.openai.com/api/reference/resources/images/methods/generate>
- AP2 reference project：<https://github.com/google-agentic-commerce/AP2>
- x402 specification/reference implementation：<https://github.com/x402-foundation/x402>
