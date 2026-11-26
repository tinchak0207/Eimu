# Codex 本地 Agent 机制研究

访问日期：2026-11-25。范围为官方产品文档和公开 CLI/app-server 源码；未运行 Codex、未访问生产、未验证桌面闭源部分。源码固定 SHA：`3f65e9f13165d85d1b1fbe20ce06c55758f927b9`。借鉴机制，不建议因此替换 Eimu 现有 OpenCode/harness。

## 本地运行、会话与恢复怎样分工？

### Takeaway
成熟实现把界面连接、持久会话、一次执行回合和实际进程分成不同生命周期。会话能够重开，不能推出付费生成可以安全重试。

### Cited Findings
- **官方产品事实**：app-server 是富客户端接入认证、历史、审批和 Agent 事件的接口；连接使用 initialize/initialized，之后才可开始或恢复会话。支持 stdio 和 Unix socket；WebSocket 仍注明 experimental，非本机监听在当前过渡期可能默认没有鉴权。不是可照抄的公网默认值。[App Server](https://learn.chatgpt.com/docs/app-server)
- **源码事实**：`restore_daemon_threads` 按保存的 loaded thread 和 interrupted snapshot 调用恢复，恢复失败记录警告，而非宣称所有任务成功续跑。文件 `codex-rs/app-server/src/message_processor.rs:839-869`。[固定源码](https://github.com/openai/codex/blob/3f65e9f13165d85d1b1fbe20ce06c55758f927b9/codex-rs/app-server/src/message_processor.rs#L839)
- **源码事实**：会话 rollout 以 JSONL 持久化；writer 对未写入尾部保留 pending，I/O 故障后可重开重试；flush 对相应 realtime seal 执行磁盘同步。不能推论每个任意事件都已 fsync。文件 `codex-rs/rollout/src/recorder.rs:1740-1800`。[固定源码](https://github.com/openai/codex/blob/3f65e9f13165d85d1b1fbe20ce06c55758f927b9/codex-rs/rollout/src/recorder.rs#L1740)
- **源码事实**：恢复上下文选择最新可用 compaction 边界和后续记录；最新压缩记录不完整时，不会随意用旧压缩覆盖新状态。文件 `codex-rs/core/src/session/rollout_reconstruction.rs:64-95`。[固定源码](https://github.com/openai/codex/blob/3f65e9f13165d85d1b1fbe20ce06c55758f927b9/codex-rs/core/src/session/rollout_reconstruction.rs#L64)

### Inferences
- **Eimu 拟议 R1**：沿用现有 runtime，建立本地常驻服务；窗口是其客户端。关闭窗口、退出服务、系统休眠、进程崩溃是四种明确行为，不能混成一个“后台运行”。
- **R2**：本地持久保存 project/session/turn/task/item 身份及递增事件序号；先持久后确认接受。断线先读取快照及缺失事件，再订阅实时进度，避免事件遗漏或重复渲染。
- **R3**：压缩只服务模型上下文，原始历史、资产引用、用户人工改动和工程版本不随摘要删除。摘要带来源范围和版本，缺失时仍能读历史。
- **R4**：生成型 POST 单独使用 operation id 与云端回执；恢复线程先对账已提交任务。重放模型上下文不能自动重放扣费、上传、发布、生成请求。Codex 会话机制不能替代 Eimu 的业务幂等账本。

### Gaps
- 这些源码未证明恢复任意外部工具副作用的 exactly-once 保证；也未证明所有客户端实时事件都有通用断点游标。R2、R4 是 Eimu 必须补齐的规范，不是已验证的 Codex 产品承诺。

## 权限、认证、并行和取消怎样构成执行边界？

### Takeaway
用户是否授权与操作系统能否访问是两道不同边界；停止模型输出也与终止实际执行不同。云模型推理和本地执行本来就能并存。

### Cited Findings
- **官方产品事实**：审批策略决定何时询问，OS sandbox 决定技术上能读写和联网到哪里。当前文档列 macOS Seatbelt、Linux bwrap+seccomp、Windows MXC 等不同实现。[Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)
- **官方产品事实**：本地 Codex 支持 ChatGPT 登录或 API key；凭证可进入 OS credential store，API key 与订阅使用不同权限和费用体系。[Authentication](https://learn.chatgpt.com/docs/auth)
- **源码事实**：Agent control 初始化线程执行限额，单个子线程有明确中断接口；V2 子代理中断检查目标身份，不通过中断操作重新加载已死亡的目标。文件 `codex-rs/core/src/agent/control.rs:131-133` 与 `control/interrupt.rs:1-54`。[限额源码](https://github.com/openai/codex/blob/3f65e9f13165d85d1b1fbe20ce06c55758f927b9/codex-rs/core/src/agent/control.rs#L131)；[中断源码](https://github.com/openai/codex/blob/3f65e9f13165d85d1b1fbe20ce06c55758f927b9/codex-rs/core/src/agent/control/interrupt.rs#L1)
- **源码事实**：回合中断取得实际 active turn，调用任务取消和清理，再处理待定审批/输入；不是只停止前端流。文件 `codex-rs/core/src/tasks/mod.rs:661-715`。[固定源码](https://github.com/openai/codex/blob/3f65e9f13165d85d1b1fbe20ce06c55758f927b9/codex-rs/core/src/tasks/mod.rs#L661)

### Inferences
- **R5**：本地系统权限、项目目录授权、网络目的地、付费预算分别管理；模型文本不得放行。MCP、shell、文件读写和媒体程序必须接同一执行裁定层。
- **R6**：本地只持用户/设备短期凭证，供应商共享密钥不下发。登录撤销后禁止新扣费，但本地已交付项目仍可打开编辑；账号切换隔离历史和迟到回调。
- **R7**：并行研究与独立评审必须保留；设置实际 CPU/RAM/磁盘/推理并发预算，按资源调度。取消落到任务代、子代理、进程和队列；云端已提交生成显示“已停止后续工作，正在核对在途生成”，不冒充已撤单退款。

### Gaps
- 开源控制字段不能证明闭源桌面端每种后台任务均遵循相同取消策略；取消上游生成还依赖供应商契约。

## 后台、远程控制和升级能承诺什么？

### Takeaway
成熟本地 Agent 也有宿主在线条件；远程入口不是自动提供云端算力。客户端与运行服务需要明确兼容协商。

### Cited Findings
- **官方产品事实**：本地项目定时任务要求电脑开机、桌面应用运行，项目路径仍存在；云端网页任务不能直接操作电脑目录。[Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app)
- **官方产品事实**：手机 Remote 控制连接宿主上的工作，可启动、转向、审查和处理权限；博客属产品说明，并未提供全部中继实现源码。[Mastering remote engineering work from your phone](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)
- **官方产品事实**：app-server schema 可从对应二进制生成；实验接口需能力 opt-in。源码公开范围包括 CLI、SDK、app-server，不包括 IDE 扩展和 Codex cloud，不能据此声称桌面全部开源。[App Server](https://learn.chatgpt.com/docs/app-server)；[Open Source](https://learn.chatgpt.com/docs/open-source)

### Inferences
- **R8**：清晰显示在线宿主、执行地点、等待原因；离线显示“等待设备恢复”，不能显示“云端执行中”。手机未来通过认证控制连接宿主，默认无公网本地端口暴露。
- **R9**：安装包携带匹配 runtime/依赖清单与协议版本；启动协商 capabilities。升级前保留数据库可恢复副本，在活动任务安全边界切换，失败回到前版；不兼容时保留只读历史入口，禁止静默改写旧任务语义。
- **R10**：所有迁移阶段保留研究→策划→执行→独立评审→返工→可编辑工程交付。runtime 本地化不等于缩成单轮聊天或人工搬素材。

### Gaps
- 官方公开文档未给出可直接复用的完整桌面签名更新/数据库回滚方案；R9 是拟议交付要求。远程与定时能力可能受产品版本、账号及工作区策略限制，本次未做实际账号可用性验证。
