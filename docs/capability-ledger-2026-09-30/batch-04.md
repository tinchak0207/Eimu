# Image Studio（Emu）第 4 批 commit 能力穷举

- 批次：47 个 commit，日期 2026-09-20 ～ 2026-09-25（`/tmp/cap/batch-4.hashes`）
- 真源：`/tmp/cap/batch-4.txt` ＋ `git show <hash>`（讯息不足者一律看 diff）；现场验证以 `grep -rn` 于 `/home/lenovo/Desktop/image-app` HEAD
- 口径：能力＝**使用者可见或可呼叫的行为**；档名单独出现不算能力。修复／重构若暴露新能力或其边界语义，另列于「边界与拒绝」。

## 生成核心

- [生成核心] harness `image_generate` 影片时长下限硬规则 — `kind=video` 的 `duration_seconds` schema 为 `min(10)`，小于 10 秒直接拒绝（上游按条计费、10 秒以下亏本；seedance-2.0 适用 10–15s、seedance-2.5 适用 10–30s），并要求回传完整 36 字元 UUID task_id、禁止截断 ｜ 证据: a0cf8147
- [生成核心] harness `image_generate` 模型可用性强制探测与扣费确认分流 — 提交前先探测模型可用性（不可用不得提交）；预估 ≤0.1 币的低成本草稿直接执行免确认，其余先跳扣费确认；工具自我声明「非同步、提交后立即交还控制权、逾时自动退款」，且要求影片/大片需求改用 workflow_* 工具而非单张生图 ｜ 证据: a0cf8147
- [生成核心] B 端生图参考图解析轮子 `lib/biz-image-references.ts` — 由 `images/edits` 私有 helper 整段抽出为共用模组，`/v1/images/generations` 与 edits 两条 route 共用同一份实现（禁造第二套） ｜ 证据: 2bd7217c

## 模型与供应商

- [模型与供应商] 打字路径工作流模板的领域判准（6→13 模板） — `jev-gate` TEMPLATE_CRITERIA 新增 7 个领域重模板：`shortdrama_visual`／`novel_ip`／`ecom_launch`／`ecom_model`／`shortdrama_poster`／`art_curation`／`art_style`；判准为「领域关键词＋交付物形态」，领域模板与泛用骨架（single/feature/novel）互斥，无领域词的多镜头影片由 `feature_film` 兜底；`ecom_launch` 收紧为「明确要上市物料」；真实 Jev API 实测 7/7 全对 ｜ 证据: c7d0fad1

## 控制平面与计费

- [控制平面与计费] mPay 回调金额手续费容忍 — 实收必须 ≥ 应收（少付一律拒），超出部分 ≤ `max(0.5 元, 5%)` 才接受；签名失败／非成功状态／方案或金额不符三个拒绝分支全补 warn/info 日志（含 out_trade_no、money、param 供排障） ｜ 证据: ac8fa0c0
- [控制平面与计费] 客户可见余额权威归我方帐本（/v1/quota） — `GET /v1/quota` Bearer B 端/agent key → biz_api_key.userId → `account_ledger` → `{ balance_coins }`；new-api `users.quota` 降格为「上游供货水位」；口径由「帐面净额 Σ amount」改为「可用余额」（永久池＋未过期订阅池，过期为读取当场 lazy 判定，不依赖定时任务）；余额可为负且不夹到 0；回应形状 success/balance_coins/currency 与 503 quota_unavailable 契约不破 ｜ 证据: a16d5690
- [控制平面与计费] 帐本开户基线与调整双写 — `ensureAccountOpening` 以 new-api 当时余额幂等种入上线基线；管理端 provision 改上游 `users.quota` 后同步在我方帐本记一笔 adjustment，delta 由「呼叫前后权威读数相减」得出（不是重算目标值），幂等键 `provision:<username>:<目标额度>`；记帐失败不挡路，差额由对帐报告指出 ｜ 证据: a16d5690
- [控制平面与计费] 订阅 SKU 与兑换码履行 — `subscription-sku` 定义订阅 SKU 与履行通道（预设走兑换码）；`subscription-redemption` 是唯一发码端，码的 `name` 承载 `SUB-<sku>@<ref>` 供入帐端辨识；订阅池 `pools`（永久池＋订阅池）供余额口径读取 ｜ 证据: a16d5690
- [控制平面与计费] 任务失败记录与对帐模组 — `failure-record`（落 `failure_record` 表）＋ `account-reconciliation`（帐本对帐）＋ `operation-registry`（操作注册）＋ `callback-outbox` 回调外送箱，构成失败态与对帐的持久层 ｜ 证据: a16d5690
- [控制平面与计费] Vercel 侧历史经控制面代理归并任务记录 — `GET /api/history` 在本地控制面未启用时，经 `GENERATION_CONTROL_PLANE_PROXY_ORIGIN` 打 `/image-control/api/history`（pageSize 100、15s timeout、转发呼叫者 Bearer/x-user-id），与本地记录合并后再本地分页；修「任务跑在 VPS、历史读在 Vercel，两边不相见→再来 N 组/微调变体卡片永不进历史」 ｜ 证据: 8ece45dc
- [运维与观测] 管理侧统计只读端点与 CSV — `GET /api/admin/statistics` 验管理员 session、验窗口 `days`（1..MAX_WINDOW_DAYS，越界 400），回 `statistics-projection` 投影与 CSV 汇出；本路由零 SQL 写入、不碰计费扣额重试；模型三态不在此重算，消费既有 `/api/user/model-status`（与 `/v1/model-status` 同一份判活） ｜ 证据: a16d5690
- [控制平面与计费] 拔除 biz-key-token-mapping 影子映射（G1） — 删除 `src/lib/generation-core/biz-key-token-mapping.ts`，并以测试断言该档不存在；B 端 key 的身分映射权威归帐本路径，不得另立第二套 token→user 映射 ｜ 证据: a16d5690

## B端API

- [B端API] `/v1/images/generations` 新增 `reference_images` 输入 — 接受 `string` 或 `{url, role, name}`；上限 5 张、保序、非法形状回 400 不静默截；role 收敛到 `GenerationReference` 值域（未知→general）；转成 `workflow.references`；零参考图时不加 `workflow` 键（逐位元零回归）；计费/kind/模型白名单/size/n/quality/control_nets 校验一行未动；生成本身仍走控制面（billing/queue/worker 不变） ｜ 证据: 2bd7217c
- [B端API] prompt 行内实体 tag 解析（`@[种类:名称]`）— 对呼叫金钥 owner 的卡库解析，命中者就地展开成该卡 prompt 片段、其参考图并入 references（卡的图在前、显式在后、按 url 去重、上限 5 截尾并回 warning）；未命中原样保留（fail-open）；卡库抖动降级成 warning 不让生成失败；plans 端不重写 regex，直接复用 `entity-tokens` 的 `expandEntityTokens` ｜ 证据: 2bd7217c
- [B端API] B 端角色卡 API `/api/biz/character-cards` — GET/POST，B 端金钥认证，与站内 `/api/character-cards` 共用同一卡库与同一清洗收口；决定性 id `biz-<sha256(userId|kind|name)[:16]>` 做 upsert（同键幂等）；`/v1/character-cards` 为开发/测试挂载点（生产 `/v1/*` 被 next.config beforeFiles 代理到控制面，故生产真正服务 agent 的是 `/api/biz/character-cards`），两挂载点共用同一实现与同一断言套件 ｜ 证据: 2bd7217c
- [B端API] B 端实体解析端点 `POST /api/biz/character-resolve` — 是参考图输入与行内 tag 两者的解析前端，供 agent 工具层在生图前呼叫 ｜ 证据: 2bd7217c
- [B端API] `/v1/team/quota` 团队成员点数配额（GET/POST） — GET 回主帐总额／已分配／各成员额度与消耗（全部当场读 new-api 权威源）；POST 由团队主帐对成员划额度，`target_coins`/`target_quota` 为**绝对目标值**（大于现值＝划额度、小于现值＝回收、等于现值＝幂等 no-op 不写上游）；分配＝主帐扣、成员加，两条腿不成功即回滚；所有金额对外以币为准（1 币 = QUOTA_PER_COIN quota）；禁影子帐本，额度真源只有 new-api ｜ 证据: a16d5690
- [B端API] 团队资产空间 `/api/project-assets`（挂用／解除） — GET 列表（包 + 卡，带挂用标记）＋ sharesIn；POST 挂用采 copy-on-use：建本地副本并回 `localCopyId`，同键幂等；DELETE 解除挂用回该记录的 `localCopyId`（前端据它解锁）；认证 `requireVerifiedUser`（不信任 x-user-id） ｜ 证据: a16d5690
- [B端API] 资产显式分享授权 `/api/project-assets/shares` — POST 授权（同键重放回 `created:false`，幂等）／DELETE 撤销（支援 id 或四元组）；跨项目复用只能靠这个显式动作；拒收码 `cross_user`／`not_a_project_asset`／`project_mismatch`／`same_project` 各有中文讯息 ｜ 证据: a16d5690

## Agent助理

- [Agent助理] 回合中追加指引（steer） — `POST /api/agent/sessions/[id]/steer` 透传网关 `/agent/v1/sessions/:id/steer`；语义与 /messages 不同：不终止当前回合、不另起用户消息；网关回 `status=injected`（已注入当前回合）或 `status=queued`（已排队，本回合结束后生效），结果原样透传；D2b 修复 body 必须转发（含 `steer_id`，否则命令身份层失去防重放意义）；长度上限权威在网关 `STEER_MAX_CHARS`，不在站内复制第二份常数 ｜ 证据: a16d5690
- [Agent助理] steer 引导链闸道侧与前端整合 — 新增 `steer-core`／`steer-identity`／`steer-ledger-gw`／`steer-gw`（VPS 网关侧）＋ composer `steerActive`＋ `agent-chat-reducer` 的 steer 处理与 `agent-steer-ui` 测试 ｜ 证据: a16d5690
- [Agent助理] 子代理在跑不再消失 — running 卡跨回合原样保留，终态裁决权交给 `subagent.done`（async 子代理生命周期长于派出回合），根治「不显示子代理」 ｜ 证据: d70732dd
- [Agent助理] 回合重试体验与黏性渠道 — 重试时显示「重试中 (x/10)」取代丑错误帧；重试预算 4→10；重试成功且有真实正文者把该模型钉为 session 黏性渠道（`personaModel` 快路，记 `stickyModel`），该渠道再跑挂即自动解钉交回常规链轮转；重试用满后依分类回「上游欠费／缺少该模型／持续报错」三种讯息 ｜ 证据: 0b3dee7f
- [Agent助理] 移除中段静默心跳「处理中（已 Ns）」 — 六档机械拆除 `arm/clearQuietNoticeTimer`、`QUIET_NOTICE_MS`、`quietNoticeTimer` 栏位（哨兵体系 7→6）；活动可见性改由计画卡即时上屏＋思维链承担；一次性 `turn.status` 通知（已收到／误判恢复／略去英文思考）全部保留，前端零改动 ｜ 证据: 461d775a
- [Agent助理] 思维链真秒数 — `reasoningMs`/`reasoningStartedAt` 入型别并在 reducer 两个时机结算（首正文 delta／settleItems）；收合行显示「已思考 · N 秒」，串流中显示「正在思考…」；caret 加 trim 条件（首 delta 为 `\n` 时不再悬空闪烁） ｜ 证据: 6119e159

## 画布与工作流

- [画布与工作流] 打字路径骨架富化：引擎衍生工具卡／配方卡／门禁卡 — `WorkflowNodeSpec` 加 `tools[]`／`notes[]`，`expandTemplate` 在 R8 克隆后、连线解析前衍生三类卡（pipelineCard tool/gate ＋ 配方 content 卡），id 递增不撞、R8 克隆继承；节点数 shortdrama_visual 14→81、novel_film 90、feature_film 51 ｜ 证据: 135528dd
- [画布与工作流] 13 模板回填 tools/notes — 8 个 payload 模板逐字搬 `requiredTools`/`promptNotes`；`novel_film` 补 previs 白模预演步（8→9 环对齐 payload）；`feature_film` 照 novel_film 密度自写配方级；4 个简单模板轻量 ｜ 证据: 135528dd
- [画布与工作流] 前端双白名单放行衍生卡栏位 — `layout.ts toNodeMetadata` 与 `canvas-chat-types.ts compactMetadataForAgent` 放行 `pipelineCard` tool|gate|director＋五工具栏；NodeBody 零改动（分支已存在） ｜ 证据: 135528dd
- [画布与工作流] gateway 下发画布节点权威座标 — `emitNodeDelta` 不再发 `{0,0}`，改由 `computeSwimlanePositions` 照前端 `pipelineToCanvasLayout` 同款配方（lane/主节点、col/衍生卡、CARD_W 300／GAP_X 60／LANE_GAP_Y 330）计算，并盖 `moved:true` 让 `layoutGraph` 不重排；衍生卡 300x150 ｜ 证据: 275d387d
- [画布与工作流] 配方卡新增 `note` 卡型 — 配方卡 metadata 补 `pipelineCard:note`（此前无标记落入纯文字分支）；双白名单＋联合型＋NodeBody＋typeBadge 加 note（Lightbulb/配方/amber） ｜ 证据: 275d387d
- [画布与工作流] 画布 DAG 分层布局 — 主链按依赖深度分栏＋barycenter 压交叉＋衍生卡垂直脊柱；行内单向串联（星状穿透归零）；`bezierPath` 改垂直底出顶入／长距离拱桥路由 ｜ 证据: a0cf8147
- [画布与工作流] 角色/道具/场景/风格/音频五值实体 kind — `CharacterCardKind` 3→5 值（character/scene/style/prop/audio）；变体不新增 kind，改用 `variantOf` 指母卡；存卡入口（右键选单、历史对话框）五值化，并新增「存为角色变体卡→选母卡」 ｜ 证据: a7e169f3
- [画布与工作流] 行内实体引用 `@[种类:名称]` — `entity-tokens.ts` 就地展开 token，`applyCharacterCards` 展开时被引用的卡不再重复塞前缀；新增 `target`／`referenceScope` 两个可选参数（缺省＝既有行为逐位元不变）；提示词面板既有 @-mention chip 系统扩成两组（图片／素材卡）并序列化成 token ｜ 证据: a7e169f3
- [画布与工作流] 分镜参考素材解析可见（ShotReferencePanel） — 摊开「本镜参考素材 N」，三段来源 token > shot > locked；未匹配 token 红字警示；零空壳不渲染 ｜ 证据: a7e169f3
- [画布与工作流] 模板自动落卡（emitsEntity） — gateway 模板节点 `defaults.emitsEntity` 送进 metadata（闸道侧零引擎改动）；四个模板标记（character_sheet view1／scene_setup result／shortdrama_visual cast_card／novel_film char_card+art_card）；引擎解析 role→nodeId 支援四视图聚合（referenceRoles → referenceNodeIds）；站点渐进聚合（updatedCards 就地更新既有卡）＋卡名第二来源（上游文本节点首行）＋退回标题时可见化 ｜ 证据: a7e169f3
- [画布与工作流] 分镜契约 propCardIds 全链路与门禁第⑤条 — `propCardIds` 贯穿 StoryboardQcShot／resolveReferenceAssetsToCardIds／productionFieldsFromContext 第④条；门禁第⑤条以节点 metadata 卡 id 为输入，优先序 production > referenceAssets > nodeMetadata；真门禁 A/B：节点宣告卡 id → 17/17 ready=true，不宣告 → 15/17 blocked（characters_bound／scenes_bound）；`QC_REQUIRED_FIELDS` 刻意不含 propCardIds ｜ 证据: a7e169f3
- [画布与工作流] 节点 metadata 耐久性放行 — 双白名单（`layout.toNodeMetadata` ＋ `canvas-chat-types.compactMetadataForAgent`）放行 `emitsEntity`／卡名三键／四个卡 id 栏／`fontSize`（10..28，修「改字号重载即失」既有 bug）；漏放行 `emitsEntity` 时该能力「当下就被剥」而非重载才坏 ｜ 证据: a7e169f3
- [画布与工作流] 分镜批准与门禁裁决状态持久化 — `metadata.approval`（分镜批准）与 `metadata.gateConfirm`（门禁裁决）进 `types.ts`（宣告）、`layout.ts toNodeMetadata`（读取端）、`canvas-chat-types compactMetadataForAgent`（上行端）三处；`toGateConfirm` 导出化供上行端共用同一份清洗；残形／缺栏整包丢弃、不制造半形状态（缺 `request_id` 的门禁卡按不下批准） ｜ 证据: f382569a
- [画布与工作流] 资产／分镜审查面板入口 chip — 「审查 · 待确认 N」chip 与面板 props（overlays／CanvasEmbed 两面板挂载、五个 handler、档位回读、`patchShotApproval`） ｜ 证据: f382569a／891d0a6c
- [画布与工作流] 画布 cardIds 作用域闸 — `POST /api/canvas/projects` 的 `cardIds` 逐个过 `filterCardIdsForProject`（生成时卡注入读的就是这份 cardIds）；跨项目、未显式分享的卡不得锁进本项目；个人卡逐位不变，查不到的 id 不猜（原样保留） ｜ 证据: a16d5690

## 创作域

- [创作域] 生成中任务卡进历史 — 历史列表新增生成中卡片：粒子海动画、无操作条、5s 轮询（`HistoryClient` `setInterval(..., 5000)`） ｜ 证据: 7ee680cd
- [创作域] 历史光箱拔除「发布为案例／存为角色卡」两钮 — 移除 `onSaveCard`／`onPublishCase` 两颗工具列按钮与其 props 挂载；mask 改纯渐变 ｜ 证据: 7ee680cd
- [创作域] 生成血统（lineage）登记与视图 — `generate-images` 完成落历史时登记 `parents`：本次请求的参考图若出自另一条生成任务（`sourceGenerationId`）记 derivation、直接引用产物（`sourceResultId`）记 reference；裸上传无持久身份不登记；「再来 N 组」以 `retry_of_job_id` 落库、源无 taskId 时用历史把手 `history-<id>` 组 rerun；job 面为读时投影组装（存量任务同路径自动可溯）；`LineageDrawer` 血统抽屉＋ `tools/backfill-lineage.ts` 回填工具；血统只落历史本体，agent/canvas 两面零触碰 ｜ 证据: a16d5690
- [创作域] 资产作用域与血统清洗收口 — `asset-pack-store` 与 `character-cards` 共用 `asset-scope`／`lineage` 清洗：非法条目丢、上限截尾并显式标记 `parents` 曾超限；非 project 一律收敛成 personal 并省略栏位（不写 `scope:{owner:"personal"}` 冒充已设定） ｜ 证据: a16d5690
- [创作域] 修 `isUsableCardImageUrl` 误判 `data:audio/` 为非法 — 修复内嵌参考音频被静默丢弃的缺陷 ｜ 证据: a7e169f3

## 帐号与增长

- [帐号与增长] QQ 交流群入口 — 手机端直跳加群分享页；桌面端在导览列提供与金币胶囊同构的「售后/交流群组」钮，点开二维码弹窗，群号 980122175 一键复制 ｜ 证据: 0ef8381c

## 前端与UI

- [前端与UI] AI 助理聊天全量重设计（Grok 骨架＋Liquid Glass 皮） — 用户 `lg-float` 玻璃气泡、助手正文直铺、思维链预设收合「已思考」；ToolCard/SubagentBar/BatchProgress 卡降级成无底色细行、状态词去胶囊（ios-blue 运行／ios-green 完成／ios-red 失败）、整行触发展开；composer `lg-float`＋specular 亮线＋品牌色送出钮；决策卡不再锁输入框（2px 蓝提示条＋新 placeholder）；空态输入框 30vh 居中主角「想做点什么？」＋幽灵文字链示例；顶栏三幽灵钮＋⋯收纳历史／资产／设置；拆 CanvasChatWorkstation 白底 `!important` 覆盖层 ｜ 证据: 5e8196a1
- [前端与UI] 聊天滚动门槛单一真源 — `scroll-threshold.ts` 的 `NEAR_BOTTOM_PX=96` 统一全站聊天滚动判定 ｜ 证据: 5e8196a1
- [前端与UI] 批准用静态预览页 `/agent-chat-preview` — 提供不依赖真实会话的聊天 UI 静态预览页 ｜ 证据: 5e8196a1
- [前端与UI] 结果卡与决策卡语汇对齐 — F 路（图/视频/音频/锚点/报告卡）figure 去灰底、幽灵动作条、币数灰字、`lg-sheet` 补 specular 亮线；G 路（确认/问题/计画/通知/导演卡）主 CTA `#2d3142`＋signature 阴影、金胶囊改币金文字、计画卡改工具行式折叠、胶囊全面灰阶化；`lightbox` 500 行资产零改动 ｜ 证据: 9a777861
- [前端与UI] 工具行对版（类型图标＋参数摘要＋币数） — `toolRowIcon` 类型图标映射（exact+rules 两层）；参数摘要与币数收进展开面板（key:value 行＋「消耗：N 币」）；状态词「运行中…／完成／失败」 ｜ 证据: 6119e159
- [前端与UI] composer 逐项对版预览设计 — 外壳 `gap-1 p-1.5`、textarea `rows=1`／`min-h-52`／`max-h-140`／`py-[15px]`／`leading-[22px]` 单形态；预设 placeholder「描述你想做的…」；送出钮与 attach icon 同步 18px（Send→ArrowUp） ｜ 证据: 4917fd27
- [前端与UI] composer 长文本重排 — 按钮下移一行（附件左、送出/停止右）、文字区全幅；三颗钮 44→36px；附件钮主色实底→浅灰幽灵（主色只留送出钮）；textarea `max-h` 124→240px（约 10 行才滚）；后经 9609fc97 回滚 flex-col 但保留轻量化（恢复横排 items-end） ｜ 证据: a17e1fb0／9609fc97
- [前端与UI] 计画卡排版 — 悬挂缩排（标签 absolute、正文 `pl-[38px]`）让换行与首行左对齐、专家晶片自成排；后改 grid 两列（auto+1fr、items-baseline）标签与正文首行共基线、收合预览与展开正文同字级行高（ios-subhead/1.55）零字体跳变 ｜ 证据: 9609fc97／c7f0ce68
- [前端与UI] 计画卡细节 — 去掉 provisional「临时」标记（数据层保留）；展开正文与「计画」标签同行、从紧邻右边开始折行；标签字号对齐子代理卡（ios-footnote/medium/foreground-80）；计画头与思维链头左缘对齐（`px-3`→`-mx-1 px-1`）＋header 顶距减 33%（`py-2.5`→`py-[7px]`） ｜ 证据: 13dd0b1b／16458779
- [前端与UI] 建号／忙碌态零位移 — 删「正在建立会话…」行（在途回馈交给送出钮转圈）；拆掉 `sessionStarting || turnActive` 忙碌分流，欢迎态一套 DOM 从始至终；忙碌时推荐语仍渲染但强制 disabled；输入框与欢迎态逐字同构 ｜ 证据: b403ac57／c7f0ce68
- [前端与UI] 问答卡截断与横向溢出根治 — `agent-transcript` 补 `overflow-x:hidden`；markdown `p` 补 `break-words`；卡片区限高 45dvh→62dvh（四选项卡不再被切）；question/label/description 全补 `break-words`＋`overflow-wrap:anywhere`（选项文字是答案、不能用 truncate 藏）；计画卡折叠预览 `shrink-0 truncate`→`max-w-[45%]+min-w-0`；面板容器 `min-w-0`＋`overflow-x-hidden` 防护层 ｜ 证据: e18b1b05／6119e159
- [前端与UI] 空态禁止滚动 — 30vh padding 改真 `justify-center` 置中，矮视口不再溢出 ｜ 证据: 3a493b30
- [前端与UI] 空态 Liquid Glass 氛围层与后续收敛 — 蓝/粉/紫光斑烘进径向渐变、光斑提浓推向卡片带、环境光直铺卡本身（`:has` 空态标记）、composer `lg-float` 玻璃上折玻璃；最终（0b12f851）撤回空态玻璃装饰，卡片恢复 `lg-card` 真玻璃（0.72 白底 + blur，不过透），backdrop 回到与首页 `body::after` 逐字同配方 ｜ 证据: e60820e6／fe3ed2fb／38fbddb4／0b12f851
- [前端与UI] 工作站 backdrop 换铺首页同款环境光渐层 — 进 AI 助理底色不再被抹平；后续对比度刀提浓光斑、压深底色 ｜ 证据: afadaee7／fe3ed2fb
- [前端与UI] QQ 入口排版与弹窗三轮根治 — 挪到左侧贴 Logo、图标换官方 Simple Icons 企鹅、二维码裁正方形＋加宽 420px；Logo+QQ 包同一左组容器（`justify-between` 三子元素才会顶到中间）；弹窗彻底去重（拔标题行＋白色内嵌卡、二维码直铺 460px、关闭钮浮右上、仅剩一行群号＋复制）；高度溢出修：面板 `max-h 100dvh-2rem`、二维码封顶 60dvh（`object-contain` 保正方形） ｜ 证据: 5c427d55／91d802f4／711d8c65
- [前端与UI] 登出钮不再被顶出胶囊 — 中段图示收 36px、群组与帐号名让位；640–1024px 收图示与间距、宽萤幕再放回文字 ｜ 证据: 3ad48bd5
- [前端与UI] AI 助理面板吃满天花板 — 面板顶至 0.75rem；navbar 经 `--ws-navbar-inset` 右退跟随面板拖宽；聊天态与空态一律吃满面板全高（`:has` 分流经 0924 终裁作废） ｜ 证据: 9f0b1695／0cae069c
- [前端与UI] 首秒零回缩与宽度回填不跳变 — `--ws-panel-w` 单一真源首帧即终态＋`settled` 闸关水合动画；存值升代 v2 赦免旧垃圾＋`beforeInteractive` 首帧前套用；修「载入后宽度回填跳变／秒缩回」 ｜ 证据: 1efcd34a／e09a9ffe
- [前端与UI] header-offset 站点框架 — Navbar sticky ＋ `--site-header-offset` 变数，供面板／dock 扣除头部高度 ｜ 证据: a16d5690
- [前端与UI] ui-strings 单源字串表 — 新增 `src/lib/ui-strings.ts`（177 行）＋测试，集中站点文案（含简体契约，如计画卡「计划」） ｜ 证据: a16d5690／e18b1b05
- [前端与UI] 首页版面三刀 — 左卡 `fit-content` 垂直置中＋40/60 默认宽＋减法阴影；轮播分页收进卡内反色＋Dock 净空；示例改横向玻璃 chips ｜ 证据: a16d5690
- [前端与UI] 实体引用就地渲染成带微缩图的胶囊 — `entity-chip.tsx` 为唯一渲染真源：`EntityChip` 为 `lg-float` 圆角胶囊＋最左 16px 微缩图格（有卡有图放图、否则种类图示占位，宽度恒定 ⇒ 卡库载入前后零位移）；`EntityText` 把字串 token 就地换成胶囊；`EntityThumbStack` 卡面左缘最多 3 格 18px 微缩图＋N 收尾；接线三处（AgentMarkdown InlineSpan、NodeBody 六处只读正文、CanvasNodeView header） ｜ 证据: 50f7e436
- [前端与UI] 文档中心收敛与教程 — `/docs/api` 重写为教学向五章（对话/流程/设定五行含野兽模式/计费/带走）＋开发进阶附录保留 spec 动态目录；快速上手扩容三章（工作流：模板转盘 8 条产线＋画布节点操作＋续写＋配方模板；历史素材复用：筛选/悬浮动作/再来 N 组 vs 微调变体＋余额兜底；充值：顶栏入口/四档方案/支付到账兑换码）；文档中心收敛为单一文档 `/docs`（删 api|mcp|harness|report 子页） ｜ 证据: 9304b9e6／83e09bea／47b670ca

## 团队与企业

- [团队与企业] 团队成员额度持久层与模型 — `db/migrations/019_team_member_quota.sql` ＋ `member-quota.ts`（成员＝new-api 另一 user 子帐号；查成员名册、读团队配额视图、`toCoins` 换算） ｜ 证据: a16d5690

## 非程式码能力

- DB 迁移 019–022 — `019_team_member_quota.sql`、`020_account_ledger.sql`、`021_failure_record.sql`、`022_subscription_pools.sql`（团队成员配额／帐本／失败记录／订阅池四张表的 schema 落地） ｜ 证据: a16d5690
- VPS 网关部署产物 — steer 引导链闸道侧档案（`deploy-staging/gateway/steer-core.ts`／`steer-identity.ts`／`steer-gw.ts`／`steer-ledger-gw.ts` 与对应测试）、`outbound-emit.ts` 自 `outbound-sanitize.ts` 拆分；0b3dee7f 自陈「VPS 已同步跑同一码，md5 逐档等价」 ｜ 证据: a16d5690／0b3dee7f
- VPS harness 工具落档 — `deploy-staging/vps-tools/image_generate.ts`（169 行）入库，含影片时长硬规则与模型探测 ｜ 证据: a0cf8147
- 血统回填运维工具 — `tools/backfill-lineage.ts`（168 行），供存量历史回填生成血统 ｜ 证据: a16d5690
- 外部服务整合 — mPay 支付回调（notify/return）容忍规则与拒绝日志（手续费容忍上限 `max(0.5 元, 5%)`） ｜ 证据: ac8fa0c0
- 运营内容资产 — QQ 交流群二维码图档（`public/qq-group-qrcode.jpg`，群号 980122175）与站点教程文档（`/docs` 五章＋快速上手三章） ｜ 证据: 0ef8381c／83e09bea
- 发布物 — `public/docs/eimu-competition-report.pdf` 随 a16d5690 入库 ｜ 证据: a16d5690

## 边界与拒绝

- [边界语义] mPay 支付金额 fail-closed — 实收 < 应收一律拒绝；超出容忍上限（`max(0.5 元, 5%)`）亦拒绝；签名失败时栏位不可信只回原值供排障 ｜ 证据: ac8fa0c0
- [边界语义] B 端参考图非法形状不静默截 — `/v1/images/generations` 的 `reference_images` 形状非法回 400；上限 5 超出以截尾＋warning 回报；role 未知收敛成 general 而非拒收 ｜ 证据: 2bd7217c
- [边界语义] 控制面未启用＋带参考图 → 501 fail-closed — 站点侧只做栏位与解析，生成本身仍走控制面；控制面不可用时带参考图的请求明确 501，不降级成无参考图生成 ｜ 证据: 2bd7217c
- [边界语义] 行内实体 tag fail-open 与诚实降级 — `@[种类:名称]` 未命中原样保留；卡库抖动降级成 warning 不让生成失败；前端未命中卡走虚线红框且原文照留；零 token 输出逐位元等于原文、不多包 span ｜ 证据: 2bd7217c／50f7e436
- [边界语义] 资产「不可见即不可用」 — `/api/project-assets` 挂用前必过 `resolveMountable`，不可见一律 403 不得静默成功；agent 注入项目包前过 `isAssetUsable`，无项目上下文＝不注入；个人口包逐位不变 ｜ 证据: a16d5690
- [边界语义] 跨项目复用只认显式分享 — `shares` 路由拒收 `cross_user`／`not_a_project_asset`（个人资产本身跨项目可用、无需分享）／`project_mismatch`／`same_project`；没有隐含可见、没有「同帐号自动放行」 ｜ 证据: a16d5690
- [边界语义] 鬼状态不降格 — 资产 scope 为 project 但无 projectId 时写回 `GHOST_ASSET_SCOPE`（该卡在任何上下文都不可见/不可用），不降格成 personal；理由：降格＝把归属不明的项目资产变成人人可用的个人资产 ｜ 证据: a16d5690
- [边界语义] 团队成员金钥不得自行分配额度 — 成员金钥的 user 若已在成员名册里，呼叫 `/v1/team/quota` 分配回 403；分配只认团队主帐（出资方） ｜ 证据: a16d5690
- [边界语义] 门禁卡半形状态拒收 — 缺 `request_id` 的门禁卡按不下批准；残形／缺栏整包丢弃，不制造半形状态 ｜ 证据: f382569a
- [边界语义] 余额负值与降级 — 客户可见余额可为负（真实状态，不夹到 0）；帐本储存层不可用时 `/v1/quota` 退回读 `users.quota`（C 端显示不因权威搬迁而断） ｜ 证据: a16d5690
- [边界语义] 记帐失败不挡路 — admin provision 的帐本双写失败不阻止上游额度调整，差额交由对帐报告指出 ｜ 证据: a16d5690
- [边界语义] 历史代理 fail-soft — 控制面不可达或非 2xx 时 `/api/history` 只记日志回本地那部分记录，不让历史页整体失败 ｜ 证据: 8ece45dc
- [边界语义] 影片时长 <10 秒直接拒绝 — harness `image_generate` `duration_seconds` 最小 10，schema 层挡下；task_id 必须完整 36 字元 UUID 禁止缩写 ｜ 证据: a0cf8147
- [边界语义] 忙碌／建号态防二次计费 — 忙碌时推荐语 disabled、拒绝重复送出（避免同一次生成被提交两次计费） ｜ 证据: b403ac57／c7f0ce68
- [边界语义] 音频实体 target 刻意无生产呼叫端 — 查证站上无「拿得到锁定卡」的音频生成入口（v1/tts 是 B 端、input 语义为朗读文本；画布无 audio 生成分支），故 `target:"audio"` 无生产呼叫端，四个模板 voiceover 刻意不标 ｜ 证据: a7e169f3
- [边界语义] 资产确认闸生产惰性 — AssetReviewPanel/ShotReviewPanel/gateConfirm 的闸道侧本次不部署，确认闸在生产需闸道端 `markGateNodeState` 写入才生效 ｜ 证据: a7e169f3
- [边界语义] 选项文字不得用 truncate 藏 — 问答卡 question/label/description 是答案，一律 `break-words`＋`overflow-wrap:anywhere`，不以截断藏答案 ｜ 证据: e18b1b05
- [边界语义] 白模预演补步与模板互斥 — 领域模板与泛用骨架互斥；`ecom_launch` 收紧为「明确要上市物料」，不带领域词的普通多镜头影片兜底 `feature_film`，单图/none 对照组不变 ｜ 证据: c7d0fad1
- [边界语义] copy-on-use 挂用的崩溃／辨伪边界 — 9 条对抗断言：删到一半崩溃重试收敛且 `deletedCards` 诚实不回虚报；记录混入别 project 真副本或 derivation 指向别来源者拒删；另一用户同 id 卡库只动本人 store；二次解除为 no-op；建副本一半崩溃孤儿由重挂收编再解除全清 ｜ 证据: e53324cf
- [撤回／移除] 撤回创作流程步骤条呈现 — 暴君裁定「为什么创作流程要这样静态显示？先撤回」，删 `wizard-steps` 及其 UI 挂载；双白名单收键（approval/gateConfirm）与审查面板入口保留（见画布与工作流节） ｜ 证据: 891d0a6c
- [撤回／移除] 撤回空态玻璃装饰 — 卡片恢复 `lg-card` 真玻璃、backdrop 回与首页逐字同配方（不同步即劣化） ｜ 证据: 0b12f851
- [撤回／移除] 移除中段静默心跳通知 — 「处理中（已 Ns）」不再发送；一次性 `turn.status` 通知保留 ｜ 证据: 461d775a
- [撤回／移除] 历史光箱移除「发布为案例／存为角色卡」钮 ｜ 证据: 7ee680cd
- [撤回／移除] 拔除 biz-key-token-mapping 影子映射（G1）＋测试断言该档不存在 ｜ 证据: a16d5690

## 存疑

- [存疑] `deploy-staging/vps-tools/image_generate.ts` 与 VPS 活体工具是否同一份 — commit 为新档入库，但未附 harness `image_generate` 的 md5/版本对帐；本 repo 是否为 VPS 活体镜像、该硬规则是否已在生产生效，缺证据 ｜ 证据: a0cf8147
- [存疑] `deploy-staging/gateway/*` 是否已上生产 — 本批多个 gateway 改动（jev 模板 c7d0fad1／骨架衍生 135528dd／泳道座标 275d387d／心跳移除 461d775a）落在 `deploy-staging/gateway/`，除 0b3dee7f 自陈「VPS 已同步 md5 逐档等价」外，其余未附部署对帐；讯息不足以判定生产是否已跑新码 ｜ 证据: c7d0fad1／135528dd／275d387d／461d775a
- [存疑] 指标投影是否落地 — `statistics-projection` 于 a16d5690 入库（62KB），但当时是否已接上生产 DB 与管理页触达未在讯息中说明；记忆 2026-09-30-decision-table-coverage-audit 另载「P2-1/P2-2 交付但生产不可见，2026-09-30 才修（共享 admin session 秘密＋把 /api/admin/statistics 加进控面代理清单）」 ｜ 证据: a16d5690
- [存疑] 9304b9e6 的 `/docs/api` 五章在 47b670ca 后是否仍存在 — 47b670ca 删除了 `src/app/docs/api/page.tsx` 并收敛为单一 `/docs`；两者是否为同一内容的搬迁（能力保留）或功能缩减，讯息未逐字对应 ｜ 证据: 9304b9e6／47b670ca
- [存疑] 真上游是否吃下参考图与 agent 真回合 — 2bd7217c 自陈「真上游是否吃下参考图与 agent 真回合未验，属诚实边界」；本批未附生产端到端证据 ｜ 证据: 2bd7217c
- [存疑] 生成中卡片进历史需依赖 VPS 任务投影 — 7ee680cd 的行为在本地控制面未启用时是否可见未验（与 8ece45dc 代理修复互为条件） ｜ 证据: 7ee680cd／8ece45dc
- [存疑] test-only commit 的能力归属 — `de568aba`（仅测试字串对齐，无产品行为）与 `e53324cf`（仅测试入库，被测能力由 a16d5690 交付）都不含新生成能力；列表中不计为能力条目，仅 e53324cf 抽出边界语义 ｜ 证据: de568aba／e53324cf

## 逐条对帐

- `5e8196a1` — 聊天全量重设计（玻璃气泡/工具行降级/composer/空态/顶栏收纳）＋滚动门槛单源＋批准用预览页（前端与UI 3 条）
- `3a493b30` — 空态禁止滚动、真置中（前端与UI）
- `c7d0fad1` — 打字路径自动选模板（13 模板判准）＋ 7 领域重模板入池（模型与供应商／画布与工作流边界）
- `4917fd27` — composer 逐项对版预览（前端与UI）
- `9a777861` — 结果卡/决策卡语汇对齐＋光标乱闪修复（前端与UI）
- `135528dd` — 骨架富化：衍生工具卡/配方卡/门禁卡＋13 模板回填＋双白名单放行（画布与工作流 3 条）
- `e18b1b05` — 问答卡截断/横向溢出根治（前端与UI＋边界：选项不得 truncate）
- `6119e159` — 思维链真秒数＋工具行对版＋溢出根因清剿＋卡片对版（Agent助理／前端与UI）
- `275d387d` — gateway 下发权威座标＋moved 章＋配方卡 note 卡型（画布与工作流 2 条）
- `13dd0b1b` — 计画卡/输入区细化（前端与UI）
- `ac8fa0c0` — mPay 回调手续费容忍＋拒绝分支全补日志（控制平面与计费＋边界）
- `a17e1fb0` — composer 长文本重排（前端与UI）
- `9609fc97` — composer 横排轻量化回滚＋计画卡悬挂缩排（前端与UI）
- `b403ac57` — 建号忙碌态劣化拔除、输入框与欢迎态同构（前端与UI＋边界防二次计费）
- `c7f0ce68` — 忙碌态单一 DOM 零位移＋计画卡 grid 基线（前端与UI）
- `16458779` — 计画头与思维链头左缘对齐＋顶距减 33%（前端与UI）
- `461d775a` — 移除中段静默心跳通知（Agent助理／撤回移除）
- `afadaee7` — 工作站 backdrop 换首页同款环境光（前端与UI）
- `e60820e6` — 空态 Liquid Glass 氛围层（前端与UI）
- `9304b9e6` — `/docs/api` 重写为教学五章（前端与UI）
- `fe3ed2fb` — 玻璃感对比度刀（前端与UI）
- `38fbddb4` — 空态玻璃三刀（前端与UI）
- `7ee680cd` — 生成中卡进历史（粒子海＋5s 轮询）＋移除发布案例/存角色卡两钮（创作域 2 条）
- `0b12f851` — 撤回空态玻璃装饰、卡复真玻璃（撤回移除）
- `47b670ca` — 文档中心收敛单一文档＋删四子页（前端与UI）
- `8ece45dc` — Vercel 历史经控制面代理归并任务记录（控制平面与计费＋边界 fail-soft）
- `0ef8381c` — QQ 群入口（帐号与增长）
- `5c427d55` — QQ 入口三刀排版（前端与UI）
- `91d802f4` — QQ 钮置中根治＋弹窗去重（前端与UI）
- `711d8c65` — QQ 弹窗高度溢出修（前端与UI）
- `a0cf8147` — 画布 DAG 分层布局＋harness image_generate 时长硬规则（画布与工作流／生成核心 3 条）
- `d70732dd` — 子代理在跑不再消失（Agent助理）
- `0b3dee7f` — 重试体验三刀＋黏性渠道（Agent助理／运维部署产物）
- `83e09bea` — 快速上手扩容三章（前端与UI）
- `a16d5690` — 全量收尸：steer 引导链／余额权威帐本／团队配额／资产空间与显式分享／血统／统计／迁移 019-022／ui-strings／header-offset／首页版面／拔 biz-key-token-mapping（多领域，见上）
- `de568aba` — 纯测试（ImagePlayground 字串探针对齐）；无新能力
- `e53324cf` — 纯测试入库（copy-on-use 对抗 9 断言）；被测能力由 a16d5690 交付，本条仅贡献边界语义
- `9f0b1695` — AI 助理面板吃满天花板（前端与UI）
- `0cae069c` — 空态不再缩卡、一律吃满全高（前端与UI）
- `1efcd34a` — 首秒零回缩（前端与UI）
- `e09a9ffe` — 消灭宽度回填跳变（前端与UI）
- `3ad48bd5` — 登出钮不再被顶出胶囊（前端与UI）
- `a7e169f3` — 五值实体化＋行内 @token＋模板自动落卡＋四视图聚合＋门禁闭环＋metadata 耐久性（创作域／画布与工作流共 7 条）
- `f382569a` — 步骤条接对话区＋批准/门禁双白名单收口（画布与工作流 3 条）
- `891d0a6c` — 撤回步骤条切片、保留双白名单与审查面板（撤回移除）
- `2bd7217c` — B 端参考图＋行内 tag 角色卡＋B 端卡 API＋resolve 前端（B端API／生成核心共 6 条）
- `50f7e436` — 实体引用就地渲染成带微缩图胶囊（前端与UI）