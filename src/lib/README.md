# 应用业务模块

先找负责的领域，再找文件。这里不提供一层新的总导出；页面、API和工具直接引用实际模块，文件只有一个真源。

|要改什么|负责目录|具体入口|
|---|---|---|
|登录、已验证账号、管理认证、设备凭证、B端密钥|`accounts/`|`server-user.ts`、`new-api-client.ts`、`new-api-auth-server.ts`、`biz-api-key-repository.ts`、`admin-auth.ts`|
|Agent会话、消息状态、记忆、工具契约、专家委派|`agent/`|`agent-chat-client.ts`与同名目录、`agent-chat-reducer.ts`与同名目录、`agent-chat-persistence.ts`、`agent-memory-store/`、`agent-tool-registry.ts`、各`*-delegate.ts`|
|素材、上传、媒体历史、角色卡、分享、文件存储|`media/`|`asset-pack-store.ts`、`asset-scope/`、`upload-record-store.ts`、`two-phase-upload.ts`、`server-history-store.ts`、`character-card-store.ts`、`share-store.ts`、`blob-backend.ts`|
|充值、支付、币额、订阅、团队席位、定价、返利|`billing/`|`image-billing.ts`、`mapay-orders.ts`、`mapay-redemption.ts`、`quota-constants.ts`、`team-seat-order.ts`、`tier-pricing.ts`、`pricing-runtime.ts`|
|模型供给、渠道、路由、生成执行与上游|`generation-core/`|既有`job-repository/`及`supply-registry.ts`；归入的`generation-gates.ts`、`generation-model-catalog.ts`、`provider-config.ts`、`routing-telemetry.ts`、`music-yue2.ts`|
|画布、布局、工程显示及导出|`canvas/`|保留既有子域；`workstation-commands.ts`、`dag-renderer.ts`、`workflow-png.ts`|
|工作流DSL及工程图契约|`workflow-dsl/`、`creative-project/`|`workflow-dsl/project-ops.ts`、`workflow-dsl/schema.ts`及原有入口|

## 谁改哪一层

- 同领域的独立功能文件可分别改。例如一个人改`agent/agent-chat-persistence.ts`，另一人改`agent/critic-delegate.ts`，不用争用一个聚合文件。
- 跨领域的身份形状由`accounts`负责人协调，账本、报价和扣费返回形状由`billing`负责人协调；素材归属与存储契约由`media`负责人协调，生成任务和供应商契约由`generation-core`负责人协调。调用方先保持这些契约，不能在自己的目录再造一份权限或计费规则。
- 既有`agent-chat-types/`、模板目录的`types.ts`和`index.ts`是共享登记处。改一个模板只改该模板；增加字段或注册项由该目录负责人统一接线。
- Agent协调各领域；媒体模块负责有效产物的归属和保存；生成模块消费供应商与计费契约。现有代码仍有历史耦合，例如`accounts/server-user.ts`复用`billing/image-billing.ts`的上游身份校验。本次只标清职责，没有借搬目录改业务依赖或授权行为。
- `workflow-dsl/project-ops.ts`仍直接引用仓库`services/gateway/project/types.ts`。这是现有跨服务共享契约；修改需同时协调网关与DSL负责人，不能复制一份类型以绕过协调。

## 不要改错副本

- `agent/expert-gateway-assets.json`是`services/expert-gateway/`原文的构建镜像。改专家宪法或派遣手册先改服务真源，再按`agent/expert-gateway-assets.ts`中的已有生成说明更新镜像。
- `generation-core/`中的模型目录、供应商注册表和报价配置各有既有生成入口。修改前先看文件头的真源说明，不把当前生成结果当第二份配置。
- 同名`.test.ts`跟随模块放置，仅作为历史资产保留；它们不是另一个业务实现，也不是本轮整理的完成证明。

## 为什么根目录还留文件

根部保留跨领域原语与站点表达：API错误形状、请求追踪、SSR安全、`utils.ts`，以及站点文案、引导、展示案例和使用场景。`viewer/`、`openui/`、`shortdrama-domain/`、`storyboard-contract/`等已有明确边界继续保留。

这些文件的归属尚不足以仅凭名称裁定；没有塞进`misc`，也没有复制兼容转发壳。后续确有具体业务需求时，再根据实际调用方调整。
