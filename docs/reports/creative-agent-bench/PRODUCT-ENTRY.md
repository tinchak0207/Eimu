# Eimu 创作 Agent：真实产品接入证据

截至 2026-10-06，本轮只做只读认证、源码和定价核查，未提交模型对话或生成订单；尚不能宣称任何 benchmark 任务完成。

## 已证实的权限与原生入口

本轮使用现有 `.env.biz-key`，经网关公开端点只读请求：`GET /agent/v1/settings` 返回 200，实际设置为 `persona=efficient`、`cost_mode=balanced`、`interaction_mode=preset`、`beast_mode=true`；`GET /agent/v1/sessions` 返回 200，并可列出 63 个会话。这证明现有身份可进入 Agent 会话管理层，不能据此推断特定模型或创作工具已能执行。

原生入口是 `tools/agent-debug.ts`：网关建会话、先接 SSE、发消息、遇问题/确认卡暂停，使用生产 `agentChatReducer` 重建用户所见对话。网关直连省掉站点层画像和 lessons 注入，报告必须注明该差异。请保留会话和完整事件，不能仅凭规划正文或 HTTP 200 判完成。

## 官方环境的最小适配边界

现场源码 `deploy-staging/gateway/session-lifecycle.ts:handleCreateSession` 创建 opencode 会话时固定发送空 body；`constants-gateway.ts` 的工作区固定 `/opt/agent-harness/workspace`。当前公开创建会话接口没有任意任务 directory 入口。Harbor 的任务工作区和生产共享工作区不能视为等价或隔离。

接官方 Harbor 时，适配器只负责把 instruction 与原始输入材料交给完整 Eimu harness，保持 orchestrator、Expert、技能、工具及模型路由；任务作品必须由 Eimu 执行工具产生。可行边界为每任务独立环境，放入同版本完整 harness，并把该环境工作区接为 opencode directory，结束后由 Harbor 原生 verifier 读取实际产物。不得以 Codex、另一个 CLI Agent 或克隆的音乐 runner 代写作品。未接通前不计算官方分数。

## 附件与作品

二进制材料应走产品附件上传链，而非本机文字文件桥：图片/小附件为 multipart `POST /agent/v1/sessions/:id/attachments`，落 `uploads/<sid>/<实际改名后的文件>`；音频/视频大文件复用票据加 `video-upload` 直传，限 100 MB。作品回收必须核真实文件字节、路径或可下载 URL。只记录模型宣称的路径不算交付。官方任务的原始目录结构/文件名不应被通用附件清洗悄悄替换；本地文字桥不能承担二进制搬运。

## 首单报价与未验项

`GET https://image.tinchak0207.xyz/v1/models` 本轮返回 200、26 个模型；图像目录示例 `gpt-image-2` 标准档 1 币/张。该目录没有 Agent 对话 token 单价，不能据此给整个 Agent 任务报价。真实默认模型与对话计价仍在继续核查；当前没有执行付费任务的授权。

SSE 生命周期存在截断疑点：现有工具以 `turn.done` 停机，近期真实记录中该事件后仍有正文和异步工具。需按网关真实完成语义修补后交独立 Hacker，不得用“录到事件”冒充作品验收。
