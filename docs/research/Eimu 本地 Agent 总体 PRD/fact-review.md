# 独立事实复核

日期：2026-11-25。复核者：codex_prd_research；复核 Claude 研究作者的两项关键归因，并抽查 Codex 源码链接。只读官方文档与源码，未实测产品、未改产品代码。单轮复核。

## 已确认

1. **Remote Control 连接期间有云端 transcript。** 官方 Connection and security 段明确：连接时，会话 transcript（用户消息、Claude 回复、工具活动）储存在 Anthropic 服务器，用于跨设备同步和网络断开后的重连；执行和文件访问仍在本机。保留按 Data usage 政策。不能把远程控制写成“仅转发、不存储”。[官方 Remote Control，Connection and security](https://code.claude.com/docs/en/remote-control#connection-and-security)

2. **不是任意账号/API key 都能使用 Remote Control。** 当前 Requirements 要求符合资格的 Pro、Max、Ultra、Team 或 Enterprise 订阅和 claude.ai 登录；Team/Enterprise 还需组织开启，相应自定义角色需获授权。文档排除 API key、Bedrock/其他云平台、改成其他 API host 的代理和企业 apps gateway；关闭某些功能标记评估也会使功能不可用。ZDR 或 HIPAA 配置组织不可开启。[官方 Remote Control，Requirements](https://code.claude.com/docs/en/remote-control#requirements)、[Connection and security](https://code.claude.com/docs/en/remote-control#connection-and-security)

3. **本机必须在线运行。** Web/移动端是本地会话的窗口；计算机需开机，claude 进程继续运行。休眠/断网恢复有重连能力，但受页面 Limitations 约束。不能承诺关机后仍执行本地任务。[官方 Remote Control](https://code.claude.com/docs/en/remote-control)

4. **权限与 OS sandbox 不是同一覆盖面。** 权限层适用于 Bash、文件、WebFetch、MCP 等工具，但 Bash sandbox 只限制 shell/Monitor 命令及其子进程。Read/Edit/Write、WebFetch/WebSearch、hooks、本地 MCP、LSP/helper 等不自动进入该沙箱。sandbox 的 denyRead 不阻止 Read 工具，allowedDomains 不限制 WebFetch；要共同约束整个进程须另用容器/VM/外层 sandbox。claude.md 的这一表述准确。[官方 Sandbox，What runs outside the sandbox](https://code.claude.com/docs/en/sandboxing#what-runs-outside-the-sandbox)、[Permissions，How permissions interact with sandboxing](https://code.claude.com/docs/en/permissions#how-permissions-interact-with-sandboxing)

5. **Codex restore 链接可访问且归因正确。** 固定 SHA `3f65e9f13165d85d1b1fbe20ce06c55758f927b9` 的 `message_processor.rs:839` 位于恢复快照接口，844 开始 restore，854-856 调用 thread_resume/DaemonRecovery，867 对失败记警告。只能证明相应源码路径，不能证明恢复任意外部生成副作用。[源码](https://github.com/openai/codex/blob/3f65e9f13165d85d1b1fbe20ce06c55758f927b9/codex-rs/app-server/src/message_processor.rs#L839)

6. **Codex interrupt 链接可访问且归因正确。** 同 SHA `tasks/mod.rs:661-677` 取得 active turn 并调用 abort_taken_tasks；710 后说明先让任务观察取消，再清待定输入/审批，符合“执行层取消，不止前端停流”。不能由此推出每个供应商请求都可撤单或退款。[源码](https://github.com/openai/codex/blob/3f65e9f13165d85d1b1fbe20ce06c55758f927b9/codex-rs/core/src/tasks/mod.rs#L661)

## 应修正或收紧

- claude.md 说“默认云存 transcript”方向正确，但精确引用宜用“Remote Control 连接期间 transcript 会云存，按数据使用政策保留”；不要把它扩成所有本地会话默认云存，也不要声称仅连接时新增的消息会上传。
- “工具统一执行裁定层”可作为 Eimu 拟议规范，不能描述成 Claude 所有代码/插件程序都天然受同一权限系统与 OS 沙箱。自执行模块、hooks、MCP 实现有自己的能力边界。
- PRD 无需继承 Claude 的订阅限制；把它记录为竞品能力的可用条件，Eimu 自己设计账号、设备、短票据、撤销及中继保留政策。

## 无法确认

- 此页未明确说明远控启用前已有完整历史是否全部补传、断开后逐项删除时间、逐类工具结果是否含原始文件全文；不得补推“完整工程不上传”或“只存元数据”。
- 未实测任何订阅/设备的 Remote Control、sandbox 或 Codex restore/interrupt 运行行为。官方描述和源码检查不能替代 Eimu 的真实恢复、取消与账号隔离验收；原笔记的未实测声明应保留。
