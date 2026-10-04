# MCode（MiniMax Code）取代 opencode-server 迁移评估

日期：2026-09-19　结论：**现在搬不了，冻结等待；重试条件明确（见末节）**

## 一句话结论

我们的 agent-gateway 深度绑死 opencode 的 HTTP/SSE server API（约 63 个 fetch 呼叫点），而 MCode **公开版本根本没有 server API**——唯一官方预告的 `mcode app-server` 仍在内部测试、未随任何版本发布（官方维护者在 issue #139 亲口确认）。在此现状下迁移＝丢掉 gateway 的串流、question、abort、subagent 全部控制面，或在无官方背书的 ACP 表面上自造桥接层，成本以周计且踩在不稳定地基上。

## 证据链

### 1. MCode 无公开 server API（致命断点）

- `docs/architecture.md`（源码仓内）：`local-runtime-v2` 的 application 层「does not instantiate … an HTTP front door, or cloud handoff services」；全 repo grep `createServer`/`Hono` 仅命中 miniapp 开发脚手架与 OAuth lease 本地 socket，零对外 HTTP 服务。
- **Issue #139（open）**：官方文档页 `agent.minimax.io/docs/cli/integrations` 曾记载 `mcode app-server`（`--stdio` JSON-RPC / `--listen unix://` / `proxy` / `daemon`），但 0.2.0–0.3.4 全部已发布版本 grep 零命中。官方回覆原文：**"The app-server feature is still in internal testing and is not available in the current public release. We have corrected the documentation to remove the premature references. We will notify you when a future release makes this feature publicly available."**——即：路存在、无时间表、文档已撤回。
- **Issue #176（open，零回覆）**：第三方桌面客户端（Monocode Linux 维护者）问「ACP 是不是嵌入 mcode 的正确表面」，官方未答。ACP 嵌入路径无官方背书、无生态先例。

### 2. 我方依赖面 vs MCode 可用表面

gateway 对 opencode 的依赖（另一探查报告实锤）：

| 依赖 | opencode 现状 | MCode 对应物 |
|---|---|---|
| `POST /session/:id/prompt_async` ＋ `GET /event` SSE | 异步发送＋事件流是全架构前提 | 无。只剩 `mcode exec` 每轮起子进程（丢串流粒度）或 `mcode acp`（stdio JSON-RPC，事件语义全重映射，无背书） |
| `session.idle` SSE 事件 | 承载收盘、看门狗、抖动重试、question 冻结 | 无同构事件；`session.idle` 仅在 `packages/local-runtime/src/cron/api.ts` 出现，语义不同 |
| question 双路径 6 组端点（/question、/reply、/reject） | 中途人机交互 | ACP 有 approval 概念但语义不同，需全部重写 |
| `POST /session` 带 `agent` 栏挂 8 Expert subagent | subagent 派遣 | MCode 自有 mavis 子代理体系（`subagent-roles.ts`），概念不同构 |
| `@opencode-ai/plugin` 工具生态（25 档 vendor-bridges＋`.opencode/tools/` 落位＋registry） | 工具真源 | MCode 走 MCP＋自家 plugin system，25 档全重写 |
| `agent-models.json` → `gen-opencode.ts` → `opencode.json` provider 配置链 | provider 层 | `mcode provider add` BYOK 可行，但配置链要重做 |

### 3. 迁移成本量级（若现在硬搬）

- 最低路径（ACP 桥接）：新造 ACP→前端帧翻译 daemon＋63 呼叫点适配＋question/abort/subagent 重写＋25 工具档重写，粗估 2–4 周聚焦开发才到主链路可用，且地基（ACP 表面）官方未承诺稳定。
- `mcode exec` 每轮子进程路径更便宜但功能残缺，不符产品要求。

### 4. 「性能更好」的前提本身有疑

截图（FrontierHarness Eval，30 任务全量通过率）显示 MCode 76.7%/4m33s、Codex 66.7%、Claude Code 63.3%、OpenCode 50%。但：

- 外部搜寻（GitHub/Reddit/DDG）对「FrontierHarness」零独立命中；源码仓（21 commits、docs/）无该评测数据。**来源＝MiniMax 自家发布、无独立复现、无公开 harness 代码。**
- n=30 的小样本上 76.7% vs 50% 的差距，叠加厂商自测，按本仓「不宣称未验证的成功」标准只能记为「厂商宣称」，不能记为事实。
- 图中「MiniMax Code: Kimi China API」注记＝它跑的是 Kimi 模型，非 MiniMax 自家模型；即它的优势主张是 harness 本身，这正是我们想买的东西，但唯一验证渠道就是这份自测报告。

### 5. 附带红旗（生态成熟度）

- Issue #102（open）：「No Linux support is simply unreasonable」——Linux 支援状态有公开 bug 报告；我们的 harness 跑在 Linux VPS 上。
- Issue #87（open）：MCode 使用 opencode 的资料库路径造成冲突——与 opencode 有部分共源痕迹，但共生态位会互踩。
- Issue #103：首次调用 SyntaxError；#76：MCP stdio cwd 落 homedir 丢 workspace 上下文。
- 模型侧：订阅制模型绑 `mcode login` 浏览器登入（我们已知会损失全部 opencode zen 模型，此为第二笔损失）。

## 定案

1. **迁移冻结。** 现状搬＝在无官方背书的表面上自造关键基础设施，且性能优势仅有厂商自测背书。
2. **等待条件（重试触发器）**：MCode 任何一版发布实装 `app-server` 子命令（`--stdio` JSON-RPC 即可，Unix socket 更好）——这正是 Codex 的 `codex-rs/app-server` 同构物（Codex 的 app-server 有 thread/turn/approval 完整面，已被其 IDE/桌面整合大规模使用，证明这种架构能承接我们这种 gateway）。届时迁移成本从「重写」降为「写一个 app-server 桥接层」，约 1–2 周量级。
3. **监测方式**：watch issue #139（官方承诺会通知）＋ npm registry `@minimax-ai/code` 新版本 tarball 内 grep `app-server`。
4. 我方现有痛点（opencode harness 性能垫底）属实且已在评测图中第三方印证，但不构成现在搬 MCode 的充分条件；Codex（66.7%、app-server 已公开、Apache-2.0、`model_providers` 支援 `base_url`+`env_key` 自订 provider，但 `wire_api` 已收敛到仅 Responses API——我们的 chat-completions 渠道需确认能走 responses 形状）是唯一「性能好且有公开 server API」的替代候选，如暴君日后要求性能搬家，那是首选，不在本报告 scope 内展开。
