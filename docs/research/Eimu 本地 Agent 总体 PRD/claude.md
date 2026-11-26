# Claude Code：本地执行与云服务的成熟边界

访问日期：2026-11-25。下列链接均实读官方原文。Claude Code 运行时闭源；没有采用泄漏源码，也不把 SDK 文档当作内部源码证明。结论中“事实”来自官方描述，“Eimu 要求”是本次产品推导。

## 一、成熟之处究竟是什么

### Takeaway
Claude Code 的可借鉴点是完整的本地运行生命周期：本地执行、连续保存会话、恢复和分支、分层授权、操作系统隔离及远程控制。它并不要求模型本地运行，也没有证明本地执行的数据从不经过云端。

### Cited Findings
- 执行位置有三种：Local 在用户机器，Cloud 在云端环境，Remote Control 在用户机器执行但由浏览器控制；收集上下文、行动、验证组成循环。[架构](https://code.claude.com/docs/en/how-claude-code-works)
- 会话绑定项目目录，持续保存本地 transcript；支持 continue、按 ID/name/path resume 和 branch。默认 JSONL 在 `~/.claude/projects/<project>/<session-id>.jsonl`。不同产品表面各有自己的会话列表，不应把它说成全端天然统一历史。[会话](https://code.claude.com/docs/en/sessions)
- 权限规则和模式决定工具调用能否获准；符号链接同时检查所请求路径和真实目标，allow 两边都须匹配，deny 任一匹配即拒绝。[权限](https://code.claude.com/docs/en/permissions)
- Bash 沙箱限制文件和网络，并覆盖其子进程；文件工具、hooks、MCP 等并不自动都在同一 OS 沙箱内。可配置沙箱不可用时拒绝启动及禁止无沙箱重试。[沙箱](https://code.claude.com/docs/en/sandboxing)
- checkpoint 支持代码、对话分别恢复，随会话保存；仅覆盖跟踪到的文件，部分 shell/子代理/并发和外部修改存在遗漏，不能替代版本管理。[恢复点](https://code.claude.com/docs/en/checkpointing)
- subagent 有独立上下文、系统提示、工具与权限，返回研究摘要以减轻主上下文；请求仍计入相同用量限制。[子代理](https://code.claude.com/docs/en/sub-agents)
- Skills 是含 frontmatter 的 `SKILL.md` 和按需读取的支持文件；MCP 的 stdio 服务是本地进程，HTTP 服务是远端接入。[Skills](https://code.claude.com/docs/en/skills)、[MCP](https://code.claude.com/docs/en/mcp)
- hooks 在执行前能拒绝/改参/请求确认，执行后能处理结果，但 PostToolUse 时外部作用已经发生。当前文档允许 PreToolUse 返回 allow/deny/ask/defer，不能沿用旧记忆“hook 永不能放行”的说法。[Hooks](https://code.claude.com/docs/en/hooks)

### Inferences
这些能力应成为 Eimu 本地运行服务的产品合同，而非另开一个 CLI 给用户。研究→策划→执行→独立评审→返工→可编辑交付必须保留，界面仍以自然语言目标和作品为中心。

### Gaps
未取得公开的完整运行时源码，不能据文档证明其具体内部线程、锁、崩溃一致性或安全实现，也不能承诺完全复刻其行为。

## 二、远控、隐私和托管的限制

### Takeaway
“执行本地”和“历史只留本地”是两份合同。Claude Remote Control 可作为出站连接与账号设备授权参考，但它默认云存 transcript，不能原样满足用户的目标。

### Cited Findings
- Remote Control 本机仅发起出站 HTTPS，不开放入站端口；服务路由远端消息，使用用途分离、独立到期的短期凭据。**连接期间消息、响应和工具活动的 transcript 存在 Anthropic 服务端。**本地进程停止则远控离线，机器醒来联网后可以重连。[Remote Control](https://code.claude.com/docs/en/remote-control)
- 同一页面说明，可选 Trusted Devices 将远控绑定到已登记设备及近期认证，设备能撤销；它与仅登录账号是不同校验。[Remote Control](https://code.claude.com/docs/en/remote-control)
- 本地 Claude Code 为调用 LLM 仍发送提示和模型输出。商业条款下默认不用于训练，与是否保留、是否发送是不同问题。[数据使用](https://code.claude.com/docs/en/data-usage)
- Agent SDK 提供 Claude Code 的循环和工具，但 `query()` 会启动 CLI 子进程；N 并发会话为 N 子进程和进程树，非 N 台服务器。默认 transcript、memory、作品是本地磁盘状态，临时容器重启或换节点不会自动保留，需自己的持久化策略。[SDK](https://code.claude.com/docs/en/agent-sdk/overview)、[Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)
- 云会话是独立执行环境，可离开页面继续工作；受保护凭据可保留在环境外，由代理附加至请求，区别于向 Agent 分发上游密钥。[云会话](https://code.claude.com/docs/en/claude-code-on-the-web)

### Inferences
Eimu 应默认本地权威历史、作品和任务日志；云端只保留授权账本、必要生成回执与明示的涉密能力。远控采用瞬时中继或明确保留期，不能偷偷照搬云历史。经 Eimu 代理调用推理时，代理仍可接触上下文，TLS 不代表端到端保密。机器关机/休眠不执行本地任务；已经交给供应商的任务可以继续，恢复后按原 ID 查询。

### Gaps
Claude 目录级本地 transcript 不能作为 Eimu 同一操作系统下多账号隔离的证明。SDK 商业集成的认证、分发许可和供应商绑定须在选型时另核，不能凭有 SDK 就决定替换现有 OpenCode/harness。未找到 Claude 对图片视频长任务提供业务级幂等、扣费与退款的公开保证。

## 三、可直接进入 Eimu PRD 的要求

### Takeaway
先定义状态和责任，再复用运行机制。优先做本地连续创作与恢复，跨端只是遥控入口；默认云同步历史不属于本次范围。

### Cited Findings
以下为产品要求，分别以上述官方机制为依据，不宣称竞品已实现 Eimu 的媒体业务：

| 要求 | Eimu 应落地的合同 | 参考 |
|---|---|---|
| 本地执行权 | 安装包提供界面与运行服务，项目不依赖远程网页才能打开；工具处理本机素材 | [架构](https://code.claude.com/docs/en/how-claude-code-works) |
| 状态连续保存 | 项目/会话/任务具有稳定 ID；消息、研究、计划、工具回执先保存再展示；恢复原项目不重起任务 | [会话](https://code.claude.com/docs/en/sessions) |
| 三种寿命分开 | 窗口、运行服务、外部生成任务独立；退出/休眠显示真实影响，重启先对账 | [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)、[远控](https://code.claude.com/docs/en/remote-control) |
| 授权不是沙箱 | 保留真实 full/auto 设置与授权根；单独实施文件/网络隔离，依赖缺失不能伪装已隔离；自动失败提供人工恢复入口 | [权限](https://code.claude.com/docs/en/permissions)、[沙箱](https://code.claude.com/docs/en/sandboxing) |
| 可撤销且不重复扣费 | 会话回退、工程版本、外部副作用分别记；回退不撤销上游订单、不退款、不删除已交付素材 | [恢复点](https://code.claude.com/docs/en/checkpointing) |
| 分工完整 | 研究/制作/独立评审具独立上下文与权限；共享项目资产但保护人工修改；按设备资源限制并发 | [子代理](https://code.claude.com/docs/en/sub-agents) |
| 扩展可信 | 本地工具走明确适配器/MCP；技能版本固定可回滚；项目带来的 hook/MCP 在信任后启用，不能覆盖账号与付费裁定 | [MCP](https://code.claude.com/docs/en/mcp)、[Hooks](https://code.claude.com/docs/en/hooks) |
| 手机遥控 | 账号+设备绑定、短期票据、撤销、出站中继；电脑离线显示等待设备，不称云端接管 | [远控](https://code.claude.com/docs/en/remote-control) |
| 保密与数据说明 | 共享密钥和专有能力在云端执行；本地对话可能经过推理代理，默认不上传完整历史；涉密 prompt 下发到本地后无法可靠保密 | [数据使用](https://code.claude.com/docs/en/data-usage)、[云会话](https://code.claude.com/docs/en/claude-code-on-the-web) |
| 真交付 | 成片和可编辑工程写入本地、校验后确认；短期中转允许，永久云作品仓不作为必需路径 | [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting) |

### Inferences
首个验收场景：真实素材发起完整创作；生成提交后退出；重启恢复同一个任务，不重复付费；完成评审返工；拿到本地可编辑工程和成品。另用第二账号证明旧项目/缓存/在途响应不串号。若只能打开本地文件而 Agent 仍跑在 VPS，本次迁移尚未完成。

### Gaps
本研究不证明 Eimu 已满足任一要求，也未实测竞品运行时。未改产品代码、未访问生产、未付费、未登录。旧记忆只用于定位问题；最终竞品事实以本次实读官方文档为准。
