# Eimu 本地 Agent 总体 PRD：当前基底与迁移边界

## 当前有什么，什么仍依赖云端

### Takeaway
本地能力已有入口，但仍是“云端 Agent 借用本地文件和计算”的架构。真正的迁移对象是完整运行闭环、任务状态和项目权威，不能将本地转码、下载或 Electron 薄壳当成本地 Agent 已完成。本次只读当前工作树和指定记忆，未运行安装包、未访问生产，因此以下是源码事实与历史证据，均不冒充今日线上可用性。

### Cited Findings
- 桌面入口仍加载远端站点；关闭全部窗口会退出应用，尚无这里可证明的独立常驻 Agent 服务。**已接线，完整运行待实测**：[desktop/main.js:62](/home/lenovo/Desktop/image-app/desktop/main.js:62)、[desktop/main.js:425](/home/lenovo/Desktop/image-app/desktop/main.js:425)、[desktop/main.js:608](/home/lenovo/Desktop/image-app/desktop/main.js:608)。
- 聊天明确采用“localStorage 按账号缓存、服务端全量历史真源”，本地缓存有截断限制。**已接线，需迁移权威**：[agent-chat-persistence.ts:1](/home/lenovo/Desktop/image-app/src/lib/agent-chat-persistence.ts:1)、[agent-chat-persistence.ts:228](/home/lenovo/Desktop/image-app/src/lib/agent-chat-persistence.ts:228)。
- 本地媒体适配器存在，但非注释引用搜索没有发现生产调用；本机 worker 有 ffmpeg 探测、抽帧和转码。**worker 有实现，W4 adapter 零生产消费者，不能混为一谈**：[local-media-worker.ts:1](/home/lenovo/Desktop/image-app/src/lib/local-media-worker.ts:1)、[local-worker.js:271](/home/lenovo/Desktop/image-app/desktop/local-worker.js:271)、[local-worker.js:480](/home/lenovo/Desktop/image-app/desktop/local-worker.js:480)。
- 运行包依赖 OpenCode plugin/sdk 1.18.14，但这不证明桌面安装包包含同版引擎。发布脚本按 Git SHA 同步 tools/lib/skills/plugin/config，再派生配置并重启 systemd 服务；目前不是可搬到桌面的发行链。**现成运行内容可保留，安装生命周期需改造**：[package.json:4](/home/lenovo/Desktop/image-app/deploy-staging/opencode-runtime/package.json:4)、[opencode-release.sh:54](/home/lenovo/Desktop/image-app/deploy/vps/opencode-release.sh:54)、[opencode-release.sh:170](/home/lenovo/Desktop/image-app/deploy/vps/opencode-release.sh:170)。
- 本地端口不等于运行可移植：网关默认访问 4096，工作目录硬编码 `/opt/agent-harness/workspace`；工具访问 8081；沙箱硬编码 `/usr/bin/bwrap`、Linux 挂载和 PATH。**已接云端运行链，跨 OS 待适配**：[constants-gateway.ts:132](/home/lenovo/Desktop/image-app/deploy-staging/gateway/constants-gateway.ts:132)、[constants-gateway.ts:261](/home/lenovo/Desktop/image-app/deploy-staging/gateway/constants-gateway.ts:261)、[sandbox.ts:30](/home/lenovo/Desktop/image-app/deploy-staging/opencode-runtime/lib/sandbox.ts:30)、[timeline_master.ts:8](/home/lenovo/Desktop/image-app/deploy-staging/opencode-runtime/tools/timeline_master.ts:8)。
- 云端生成已有 tenant+idempotency 去重、reserve 账务、submit_unknown 对账以及取消后保留已提交任务的语义。**应保留的协议，源码存在；本轮未实测**：[write.ts:32](/home/lenovo/Desktop/image-app/src/lib/generation-core/job-repository/write.ts:32)、[write.ts:53](/home/lenovo/Desktop/image-app/src/lib/generation-core/job-repository/write.ts:53)、[write.ts:367](/home/lenovo/Desktop/image-app/src/lib/generation-core/job-repository/write.ts:367)、[write.ts:576](/home/lenovo/Desktop/image-app/src/lib/generation-core/job-repository/write.ts:576)。
- 账号身份入口取得已验证 user.id；账户画像/教训和可用资产在创建会话时由站点注入。**已接线，迁移不能漏掉这些隐形输入**：[agent-session-guard.ts:85](/home/lenovo/Desktop/image-app/src/lib/agent-session-guard.ts:85)、[sessions/route.ts:47](/home/lenovo/Desktop/image-app/src/app/api/agent/sessions/route.ts:47)、[sessions/route.ts:60](/home/lenovo/Desktop/image-app/src/app/api/agent/sessions/route.ts:60)。
- 产物服务已有 owner 校验、sha256 与字节数快照校验。**复用数据契约，改交付落点**：[artifact-delivery.ts:11](/home/lenovo/Desktop/image-app/deploy-staging/gateway/artifact-delivery.ts:11)、[artifact-delivery.ts:72](/home/lenovo/Desktop/image-app/deploy-staging/gateway/artifact-delivery.ts:72)。
- 当前 `gateway/project/` 只有 types/constants/fixtures，没有完整 ProjectGraph 引擎；11-04回滚记忆与现场吻合。**类型遗留，不能当现成项目引擎**：[types.ts](/home/lenovo/Desktop/image-app/deploy-staging/gateway/project/types.ts)、[回滚说明](/home/lenovo/.claude/memory/notes/2026-11-04-projectgraph-engine-rolled-back-head-status-h09.md)。
- Shotcut 11-24记忆记载另一分支/线上接入与真会话，但当前树没有 `tools/shotcut_cli.ts`，editor SKILL 也无引用。**历史已上线证据，当前树未合入，不重新发明或忽略**：[Shotcut接入记忆](/home/lenovo/.claude/memory/notes/2026-11-24-cli-anything-shotcut-integration.md)。
- 发行源存在冲突：package 0.3.5 的 Linux target 是 tar.gz，发布清单指向 AppImage，而 updater 注释明确 tar.gz 不能自更新；Windows 清单仍0.3.3，Mac没有桌面下载。**更新模块已接线，当前可重现发行待证**：[package.json:47](/home/lenovo/Desktop/image-app/desktop/package.json:47)、[desktop-releases.ts:43](/home/lenovo/Desktop/image-app/src/lib/desktop-releases.ts:43)、[updater.js:14](/home/lenovo/Desktop/image-app/desktop/updater.js:14)、[desktop-releases.ts:111](/home/lenovo/Desktop/image-app/src/lib/desktop-releases.ts:111)。

### Inferences
先合成“所有发布面的能力并集”，再迁移。当前主树不是线上完整快照，历史笔记也不是当前树的能力清单。建议 candidate manifest 绑定 UI/runtime/OpenCode/tools/skills/contracts/schema 的版本、哈希、平台依赖与迁移兼容区间；先锁住候选再验收，防止把已上线后期链漏掉。

建议实施排序：**身份/路径/契约 → 本地 runtime → 持久恢复 → 媒体 → 逐项切流**。先解决同一任务和文件在两端如何指代，再搬循环，避免媒体已搬走、任务仍指向 VPS 的半迁移。

### Gaps
本轮没有证据证明 Windows/macOS 完整工具链、安装包签名与实际更新防降级、休眠后恢复、手机远控本地运行、加密跨设备同步。均应列 PRD 要求，不能写成已有能力。OpenCode 二进制实际版本也不能仅由 plugin 版本推定。

## 十二项迁移矩阵

| 领域 | 处理 | 具体触点 | 实施依赖/当前边界 |
|---|---|---|---|
|完整自主创作链|保留|runtime skills/plugin、子代理与timeline工具|不改成填表/复制prompt；先盘点跨分支与线上并集|
|桌面界面|迁移|main.js远端loadURL|随包本地可打开；云断线不影响已存项目浏览导出|
|Agent引擎与任务执行|迁移|OpenCode 4096、gateway工具8081|本地服务生命周期、认证IPC、崩溃恢复、资源调度|
|任务与对话状态|迁移|sessions.db、chat persistence|账号分区、全量本地日志、续跑身份、兼容导入|
|项目与素材文件|迁移|workspace、artifact store|本地目录真源、相对引用、hash、版本和人工修改保护|
|原生媒体工具|改造|ffmpeg/bwrap/Python/MLT/Blender|逐OS随包依赖与沙箱适配；Shotcut先合入真实版本|
|账号与订阅|云端留守|resolveAgentCaller、账号key|设备独立可撤销短期凭证；本地文件不随登出被删除|
|模型/供应商路由|云端留守|模型registry、受保护能力接口|密钥不下发；公私技能划界；按请求鉴权而非信任本地|
|账本与生成回执|云端留守|generation_job/billing_operation|幂等、unknown对账、退款权威；本地持有job引用|
|结果交付|改造|artifact_delivery、生成结果URL|优先本地下载；需鉴权或链接过期时短期中转；校验后确认消费|
|同账号跨设备/手机|改造|历史全量、账号epoch、device bridge|同步/远控明确区分；单任务执行租约；关机真实显示离线|
|发行与恢复|改造|electron-updater、release manifest|统一候选清单、兼容迁移、可回退；实际安装包首次验收|

## PRD不可牺牲项与真实交付反例

### Takeaway
首个可接受里程碑应是“用户实际安装包完成一条自主研究→策划→工具执行→独立评审→返工→可编辑工程与成片交付，并经退出/恢复仍能继续”；从这个端到端项目扩展覆盖。只搬 API 或渲染器不能成为里程碑。

### Cited Findings
三条旧能力不得牺牲：①保留完整自主链和已有后期能力，不能因为迁移删除评审/返工；②保留账号归属、同账号跨端历史/资产与换号隔离，改变存储权威不改变所有权；③保留幂等扣费、unknown对账、真实可下载与可编辑交付。[原项目规则](/home/lenovo/Desktop/image-app/AGENTS.md)、[账号历史资产要求](/home/lenovo/.Codex/memory/2026-10-18-account-history-assets-sync.md)、[生成状态协议](/home/lenovo/Desktop/image-app/src/lib/generation-core/job-repository/write.ts:367)、[产物交付协议](/home/lenovo/Desktop/image-app/deploy-staging/gateway/artifact-delivery.ts:72)。

### Inferences
验收由非作者用真实安装包和真实用户路径执行，记录候选 manifest、任务身份、输入输出与故障现场；不能用测试绿灯替代以下行为：

1. 上游已接受生成，本地断网/退出：恢复只查询原 job，结果最终下载一次，账本只扣一次；找不到不能盲重投。
2. Shotcut 本地渲染中关闭窗口/设备休眠：状态说明正在暂停还是可继续；恢复有可用工程，不假报完成，也不覆盖用户手改片段。
3. 账号 A 在途请求期间切到 B：A 的晚到文本、素材和任务不得进入 B；A 在本地的文件保留但不暴露给 B 的自动上下文。
4. 生成成功但下载中断/链接过期/磁盘满：生成状态与落地状态分离，能够重取或明确待处理；不能显示已交付、不能再次生成收费。
5. 云端不可达或更新失败：现有工程/历史可打开并导出，缺网能力据实暂停；升级后 schema 不能回退覆盖新数据。手机发出的同一操作也不能和桌面双执行。

### Gaps
成本目标尚缺每成功项目的现有 CPU/内存/媒体字节/出网/推理/生成成本基线，因此不能声称本地化能降低某个百分比。PRD应分开记录云端基础设施成本、供应商费用和用户设备负担，再按同等作品链比较。
