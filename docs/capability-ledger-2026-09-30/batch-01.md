# image-app 能力清单（第 1 批，47 个 commit）

- 批次范围：`/tmp/cap/batch-1.hashes`（47 条），线性史 2026-08-14 → 2026-08-22（`4860f1ed` 为无父的初始基线 commit，其后逐条线性）。
- 口径：能力＝**使用者可见或可呼叫的行为**（端点、工具、UI 行为、计费/退款决策、拒绝/降级语义），不是「存在某档」。
- 标签：生成核心／模型与供应商／控制平面与计费／B端API／Agent助理／画布与工作流／创作域／帐号与增长／前端与UI／运维与观测（本批「团队与企业」零命中）。
- 来源冲突：记忆 `2026-09-28-symdiff-source-first-and-hypit-video-extraction.md` 说我方「影片提取」只有浏览器端均匀抽 4 张（`video-frames.ts`）＋100MB 直传；本批（08 月早期）现场**零命中任何影片提取/转写/场景切点能力**，与记忆一致，无冲突。记忆 `aid-server-symdiff-prd-0915.md` 提到的 AID 对称差交付物（`lens-language-library.ts` 等）是本批之后（09-15）的工作，本批零命中，属时间差而非冲突。

## 生成核心

- [生成核心] 生图任务提交与查询 — 同步提交 `/api/generate-images` 建立生成任务，`/api/generation-jobs`、`/api/generation-jobs/[id]` 查任务状态与结果 ｜ 证据: 4860f1ed
- [生成核心] 生视频提交 — `/api/generate-videos` 接受视频模型参数（时长/解析度/音频）提交生成 ｜ 证据: 4860f1ed
- [生成核心] 画布节点专用生图薄壳 — `/api/canvas/generate` 把画布栏位（prompt/model/size/quality/count/source_image/reference_image_urls）翻成 generate-images 请求，并把单张回应聚合成画布 reducer 可直接吃的阵列 ｜ 证据: ec748a51
- [生成核心] 画布语义参考图与负面词 — `/api/canvas/generate` 接受带角色（ReferenceImageRole）的 `reference_images` 与 `negative_prompt`；同 URL 去重后上限 5 张，只收 https/data:image，角色走 generate-images 的 workflow 链路 ｜ 证据: e19103a3
- [生成核心] 上游图片 URL 转存本站 Blob — 上游回传短时签名 URL 时，回应前把位元组转存本站 Blob 回持久 URL，避免 Canvas/历史因签名过期破图（失败保留原 URL 由调用方兜底） ｜ 证据: 425ac035
- [生成核心] 生成 worker 心跳与迭代容错 — 心跳写入失败（暂时性 DB 错误）只记录不杀进程；主回圈每轮 try/catch，迭代失败继续轮询；`unhandledRejection` 记录不退出（避免在飞任务全部停摆被判定 dead 而批量退款） ｜ 证据: 286c47e5
- [生成核心] 生成 worker cron 端点 — `/api/cron/generation-worker` 每分钟 claim 待处理与过期任务、执行生成、处理失败退款；仅允许 Vercel Cron header 或本地 localhost ｜ 证据: ec748a51
- [生成核心] 模型能力查询在定价覆写载入后仍稳定 — `generationModel`/`generationCapabilities` 在 effectiveCatalog 查不到时回退静态 `GENERATION_MODEL_CATALOG`，pricing override 载入不再把模型能力抹成 null ｜ 证据: 6ebb22ef, 271c66b6
- [生成核心] 容忍式 model-id 解析 — 显示名风格分隔符（`seedance 2.0`、`seedream 2.0`、`image 5 pro`）正规化成连字号 id，同一模型不因写法被拒；作用于生视频、生图、`/v1/images/generations`、`generation-jobs` ｜ 证据: 984b9878
- [生成核心] 无目录能力也能提交的 Dreamina 图片模型 — `generation-jobs` 对 `image-5-pro`/`image-5-lite`/`seedream-2.0` 三个模型即使 catalog 查不到 capabilities 也接受提交（补预设配置而非 400 model_not_found） ｜ 证据: 984b9878
- [生成核心] PixAI 池帐号档安全写入 — 池帐号 JSON 改原子写（mkstemp→write→fsync→os.replace）＋跨进程 flock／msvcrt 锁＋同进程线程锁，避免并发写坏池档 ｜ 证据: 984b9878

## 模型与供应商

- [模型与供应商] 模型目录与用户可见模型清单 — `/api/models`（含端点与价格资讯）与 `/api/user/models` 对外列生成模型 ｜ 证据: 4860f1ed
- [模型与供应商] PixAI 上游工具面 — `/api/pixai/edit`、`/api/pixai/upload`、`/api/pixai/upscale`、`/api/pixai/template-generations` 提供编辑/上传/超分/模板生图 ｜ 证据: 4860f1ed
- [模型与供应商] LoRA 目录与用户偏好 — `/api/lora-models`（PixAI bridge 代理）与 `/api/lora-preferences`（收藏/最近） ｜ 证据: 4860f1ed
- [模型与供应商] Adobe2API 帐号生命周期 — `/api/adobe/oauth`、`/api/adobe/callback`、`/api/adobe/setup`、`/api/adobe-token` 完成 Adobe 帐号授权与 token 取用 ｜ 证据: 4860f1ed
- [模型与供应商] 渠道队列单一事实来源 — `channel-registry.buildModelQueue` 为 user 管线/biz 管线/admin 预览/探测唯一队列来源；admin overrides 可启停/调序 env 渠道与池而不需改 env 重部署；未配置渠道显示为未配置而非隐形 ｜ 证据: 4860f1ed, 425ac035
- [模型与供应商] admin 渠道与供应池治理 — `/api/admin/channels(+probe/audit/rollback)`、`/api/admin/pools(/[id],/[id]/test)`、`/api/admin/account-pools(+import)`、`/api/admin/external-channels`、`/api/admin/image-upstream-probe`、`/api/admin/adobe2api/import`、`/api/admin/sub2api-fix-groups` 管理上游供给 ｜ 证据: 4860f1ed
- [模型与供应商] Dreamina Image 5 Pro / Lite / Seedream 2.0 进模型目录 — 三者加入 `SUPPORTED_IMAGE_MODEL_IDS` 与公开菜单前排（popularity 98/97/96），各支援 1k/2k/4k、1:1 等常用比例与参考图，币价 10/20/40、5/10/20、5/10/20 ｜ 证据: 8ec2239b
- [模型与供应商] Image 5 Pro 路由 Dreamina 生产池 — 对 `image-5-pro` 硬接一个 priority 1 的 `dreamina-image5-pro` relay 端点，其他模型该池零端点 ｜ 证据: 6711d495
- [模型与供应商] Dreamina relay 限制于已验证上游模型 — 池的 `supportedModels` 仅 `image-5-pro`；`gpt-image-2`、`gemini-3.1-flash-image`、`image-5-lite`、`seedream-2.0`、`flux-2` 在该池下建不出端点（白名单拒收） ｜ 证据: 8ec2239b
- [模型与供应商] 对外模型可用性探测 — `GET /v1/model-status` 回所有 image+video 模型的可用性＋能力＋功能标注；只发 `GET {baseURL}/models` 不触发生成不扣费；结果模组级快取 60 秒 ｜ 证据: ec748a51
- [模型与供应商] 对外通道标签不透露供应链 — 回应中的 endpointLabel 把内部 label（adobe2api/sub2api/池名等）归一成 primary/fallback，客户端拼不出上游供应链 ｜ 证据: 425ac035
- [模型与供应商] sensenova-u1-fast 从供给面移除 — 生产版本同步时该模型自 `SUPPORTED_IMAGE_MODEL_IDS` 与模型目录删除，channel-registry 不再有 `sensenova` channel kind 与专用 baseURL ｜ 证据: 425ac035
- [模型与供应商] PixAI pool bridge（上游池服务） — `pixai-pool/bridge`（app.py/server.py/pool_store.py）作为 PixAI 帐号池的本地服务面 ｜ 证据: 4860f1ed

## 控制平面与计费

- [控制平面与计费] 生成控制平面 DB schema — `db/migrations` 001-007：generation control plane（任务/租约）、admin 配置审计、canary run、billing reconciliation、professional workflow lineage、LoRA user state、biz api key ｜ 证据: 4860f1ed
- [控制平面与计费] 计费/额度/支付 API — `/api/token(/[id])`、`/api/topup`、`/api/usage`、`/api/pricing`、`/api/model-pricing`、`/api/payments/mapay/checkout|notify|return|test-callback`、`/api/user/topup/info`、`/api/user/topup/self` 构成扣费、额度、下单、回调链路 ｜ 证据: 4860f1ed
- [控制平面与计费] admin 定价改写即时生效面 — `/api/admin/model-pricing`、`/api/admin/tier-pricing` 改价，算价前同步进目录（核心层吞错，失败不挡生成） ｜ 证据: 4860f1ed, 984b9878
- [控制平面与计费] B端 biz key 与内部签名通道 — `/api/admin/biz-keys(+provision,/[id])`、`/api/internal/biz-keys`、`/api/internal/callback-worker`、`/api/internal/generation-billing` 提供 biz key 签发与控制面内部写入/回调 ｜ 证据: 4860f1ed
- [控制平面与计费] B端批次生成编排 — `POST /v1/batches` 逐项（image/video）走同一条 `submitGenerationCommand`（不自建第二套提交/计费/调度），`GET /v1/batches/:id` 聚合状态，`GET /v1/batches/:id/reconciliation` 对帐汇出 ｜ 证据: e19103a3
- [控制平面与计费] 生成任务租约回收与对帐 — `recoverExpiredGenerationLeases`（leased 回 queued、submitting/running 转 submit_unknown 并补上游对帐）、`reconcileGenerationBilling`、`refreshAdobeSupplierHealth` 由 worker 每 30 秒执行 ｜ 证据: 4860f1ed, 286c47e5
- [控制平面与计费] admin 帐务与 SLO 观测面 — `/api/admin/billing-operations`、`/api/admin/slo`、`/api/admin/routing-events`、`/api/admin/control-plane-diagnostics` 提供帐务操作、SLO、路由事件与控制平面诊断 ｜ 证据: 4860f1ed

## B端API

- [B端API] 原有 /v1 对外契约 — `/v1/images/generations`、`/v1/images/edits`、`/v1/images/[id](/result)`、`/v1/videos/generations`、`/v1/videos/[id](/result)`、`/v1/uploads`、`/v1/history` 提供生图/编辑/生视频/上传/历史 ｜ 证据: 4860f1ed
- [B端API] /v1 元数据与相容面 — `/v1/models`、`/v1/queue`、`/v1/system_stats`、`/v1/object_info`、`/v1/openapi.json`、`/v1/templates`、`/v1/template-generations`、`/v1/upscale` ｜ 证据: 4860f1ed
- [B端API] SKU 目录（公开只读） — `GET /v1/skus` 列自有营销 SKU（电商带货 15s、痛点广告、多角度变体），含输入 schema/镜头结构/输出规格/计价模式，可程式化生成下单表单；不需鉴权 ｜ 证据: e19103a3
- [B端API] SKU 下单 — `POST /v1/skus/:id/runs` 输入→镜头计划展开→逐镜头提交；支援单轮与 `{inputs:[...]}` 表格批量；biz key 鉴权、限流头、trace_id、OpenAI 风格错误体、Idempotency-Key 幂等（逐镜头确定性幂等键） ｜ 证据: e19103a3
- [B端API] SKU 订单查询 — `GET /v1/skus/runs/:id` 查 SKU run 状态 ｜ 证据: e19103a3
- [B端API] TTS 提交与查询 — `POST /v1/tts/generations`、`GET /v1/tts/:id` 走 generation-core（kind 接通、MediaKind audio 传播到 9 处下游型别） ｜ 证据: e19103a3
- [B端API] /v1/images/generations 容忍 model 写法 — 显示名风格 model 字串正规化后才做支援性检查 ｜ 证据: 984b9878
- [B端API] OpenAPI 契约随端点扩充 — `/v1/openapi.json` 随 batches/skus/tts 等新端点同步（本次 +336 行） ｜ 证据: e19103a3

## Agent助理

- [Agent助理] 站点↔agent 闸道纯代理 — `/api/agent/sessions`、`/[id]`、`/[id]/messages`、`/[id]/confirm`、`/[id]/question`、`/[id]/attachments`、`/[id]/sse-ticket`、`/api/agent/quota`；身份统一由 `resolveAgentCaller` 解决，闸道为权威 ｜ 证据: 4860f1ed
- [Agent助理] 对话历史 dropdown — `GET /api/agent/sessions` 代理闸道 list sessions（按 key 隔离），前端 hook `switchSession` 切换历史会话并有目录 UI ｜ 证据: 186b1770
- [Agent助理] 刷新自动续上上次会话 — 网关已持久化会话后，刷新/重开改为静默 resume（transcript 含 workflow/canvas 事件流原样回来），会话真被回收时 resume 自己清档开新并提示 ｜ 证据: daa226cd
- [Agent助理] 会话记忆补注 — resume/switch 到老会话时 `POST /api/agent/sessions/[id]/memory` 读本站权威 profile+lessons 并推给 gateway `memory-patch`（前端 fire-and-forget）；无画像回 `{patched:false,has_profile:false}` ｜ 证据: 3275bef9
- [Agent助理] 建新会话注入帐户画像与教训 — 建立会话时带 `user_profile` 与 `lessons`；空画像时带 `memory_empty:true` 让 gateway 首条讯息用 question 工具做选择题 onboarding（用户点选零打字） ｜ 证据: 984b9878, e9e1b178
- [Agent助理] 帐户画像 API — `GET/PUT /api/agent/profile` 读写「用户确认过」的画像（只在此或 onboarding 表单写入，模型提炼走 lessons）；单栏 500 字、清单 12 项上限 ｜ 证据: e19103a3
- [Agent助理] 静默教训提炼 — `POST /api/agent/profile/lessons` 收 transcript 语料（≤64KB）→ 闸道 LLM 提炼 ≤6 条教训入 `agent_lessons`；需 ≥2 轮往来；失败静默不报错；教训只在用户确认后才进注入集合 ｜ 证据: e19103a3
- [Agent助理] AI 助理 LoRA 搜索引擎 — `agent-lora` 搜索站内 `/api/lora-models` 后按 versionId 过滤，复用 `/api/lora-preferences`，单选铁律（装配参数只留 1 个），模型无 LoRA 能力时明确报错 ｜ 证据: e19103a3
- [Agent助理] 输入框粘贴与拖拽附件 — AgentComposer 支援 Ctrl+V 贴档与拖入，与附件按钮共用 `enqueueFiles` 管道；拖拽悬停高亮，纯文本粘贴放行 ｜ 证据: e62cf333
- [Agent助理] 参考图上传按模型能力门控 — PromptInput 容器级拖拽＋Ctrl+V 经 `ReferenceImageUpload.acceptFiles` 同一管道；模型不支持参考图时隐藏上传入口，杜绝「上传后立马消失」 ｜ 证据: e62cf333
- [Agent助理] 画布状态上行（agent 的眼睛） — `POST /api/agent/sessions/[id]/canvas-state` 前端画布变更 300ms 防抖把压缩快照推给 gateway 暂存，agent `canvas_get_state` 零往返读取；快照尽力而为失败不重试，512KB 上限 ｜ 证据: ec748a51
- [Agent助理] 画布批量操作结果回报 — `POST /api/agent/sessions/[id]/canvas-ops-result` 前端执行（或用户拒绝）agent 下发的批量画布操作后回报，resolve gateway 端 `canvas_apply_ops` 工具调用（否则 30s 超时） ｜ 证据: ec748a51
- [Agent助理] 强制中止当前生成轮 — `POST /api/agent/sessions/[id]/abort` 透传到 opencode `/session/:id/abort`（系统层取消，非发 prompt 软停） ｜ 证据: ec748a51
- [Agent助理] 闸道技术名词中文化 — question/confirm expired 等闸道错误/状态文字映射为中文再呈现 ｜ 证据: 1b31ad23

## 画布与工作流

- [画布与工作流] 画布专案持久化 — `/api/canvas/projects` 储存/读取画布专案 ｜ 证据: 4860f1ed
- [画布与工作流] 首次 workflow_start 即切画布模式 — agent 第一次调 `workflow_start` 时不等 canvas.plan/节点事件落地，右侧面板立即进 canvas 模式（黏性旗标，画布清空不被踢回图片模式）；`tool.invoke` 不入画布 reducer ｜ 证据: 420bdbd9
- [画布与工作流] 画布图片三级载入链路 — 直链失败切同源代理 `/api/canvas/image-proxy`，代理也失败才落破图占位；破图占位不伪装生成失败，提供「重新载入」 ｜ 证据: af3a9c4e
- [画布与工作流] 已完成节点不再卡失败态 — node content 更新时自动重置图片错误状态（清 useProxy/imgError）重新走载入链路 ｜ 证据: af3a9c4e
- [画布与工作流] AI 助理面板 dock 布局 — 面板 dock 时画布收缩让位，不遮盖左侧节点 ｜ 证据: dd83c049
- [画布与工作流] 画布导航与快捷键辅助 — CanvasMiniMap、CanvasZoomControls、CanvasShortcutsHelp、CanvasContextMenu 提供缩放/小地图/快捷键说明/右键选单 ｜ 证据: ec748a51
- [画布与工作流] 节点内嵌生成面板 — CanvasNodePromptPanel 就地编辑 prompt/模型/比例/数量，生成结果作相连子节点插回；模型清单取自真实供给（不摆站上不路由的假选项），生成钮旁标「约 N 币」与扣费同源估价 ｜ 证据: ec748a51
- [画布与工作流] 云端素材库与提示词库面板 — CanvasLibraryPanel 两 tab：提示词库（公共，一次拉全量、客户端 debounce 过滤、可插入画布/填节点/存素材库）与我的素材（登入用户云端素材） ｜ 证据: ec748a51
- [画布与工作流] 云端素材库 API — `/api/canvas/assets` list/upsert/delete，requireVerifiedUser 验证（不信任 x-user-id）；Blob 世代持久化，与画布专案分命名空间，有大小/数量上限 ｜ 证据: ec748a51
- [画布与工作流] 角色/场景卡锁定注入 — `/api/character-cards` CRUD（GET/POST/PATCH/DELETE，requireVerifiedUser）；卡锁定后该画布所有生成（手动面板、agent run_generation、编辑器派生）自动以卡 id 序注入 locked prompt 前缀、参考图（卡优先）与负面词 ｜ 证据: e19103a3
- [画布与工作流] 画布语义节点 — prompt 节点文本与 reference 节点图片沿入边收集供生成；`resolveGenerationInputs`/`composeGenerationPrompt`/`mergeGenerationReferences` 保证手动 UI 与 agent run_generation 接线语义完全一致，参考图按 nodeId 去重合并 ｜ 证据: e19103a3

## 创作域

- [创作域] 用例库（提示词/场景库） — `use-cases` 提供多领域用例与对应提示词（含 386KB 生产版内容恢复），供站点用例页与 sitemap 消费 ｜ 证据: 4860f1ed, 425ac035
- [创作域] 画布图片编辑全家桶 — CanvasImageEditorDialog 提供裁剪/切图/抠除/旋转/角度；像素类操作输出新 PNG dataURL 作新子节点（原节点不动，非破坏性）；生成类（角度重绘、抠除 AI 重绘）走回调交生成链路并明标 AI 重绘 ｜ 证据: ec748a51
- [创作域] 提示词库服务端聚合 — `GET /api/canvas/prompts` 并行抓多个远程提示词源（每源 8s timeout、失败跳过不挡整体、解析不了跳过），模组级 1h 记忆体快取＋stale-while-revalidate ｜ 证据: ec748a51
- [创作域] 历史与统计 — `/api/history`、`/api/history/[id]`、`/api/history/stats` 查生成历史与统计 ｜ 证据: 4860f1ed
- [创作域] 图片编辑像素核心可测 — `canvas/image-edit` 纯数学层（computeSplitRects/findLineSpot/clampCropRect/buildAnglePrompt）可被 node:test 直测，浏览器段只在 client 呼叫 ｜ 证据: ec748a51

## 帐号与增长

- [帐号与增长] 注册/登入/身份 — `/api/auth/register`、`/api/auth/login`、`/api/auth/me`、`/api/user/self`、`/api/data/self`、`/api/log/self(+search/stat)` ｜ 证据: 4860f1ed
- [帐号与增长] GitHub OAuth 登入 — `/api/auth/github/start`、`/api/auth/github/callback` ｜ 证据: 4860f1ed
- [帐号与增长] 微信扫码登入（轮询式） — `/api/auth/wechat/qr`、`/poll`、`/start`、`/callback` ｜ 证据: 4860f1ed
- [帐号与增长] 微信公众号被动回覆登入通道 — `/api/auth/wechat/msg` 验证签名（sha1 字典序 token/timestamp/nonce），用户在公众号对话发验证码，FromUserName(openid) 作帐号身份，匹配登入码完成登入 ｜ 证据: ec748a51
- [帐号与增长] 邀请返利 — `/api/user/aff` 提供邀请返利资讯 ｜ 证据: 4860f1ed
- [帐号与增长] 每日签到 — `/api/checkin` ｜ 证据: 4860f1ed
- [帐号与增长] 动态站点 URL — `getSiteUrl()` 作为 robots/sitemap/manifest/OG 的站点前缀来源，sitemap lastmod 固定为内容更新日（不用 new Date 烧爬虫预算） ｜ 证据: 425ac035

## 前端与UI

- [前端与UI] liquid glass 设计系统迁移 — agent-chat/canvas/pro-workstation 全面迁移，新增 DESIGN.md 与 PRODUCT.md 设计/产品文件 ｜ 证据: e7407935
- [前端与UI] Tailwind 死 opacity modifier 修复 — `/94`、`/92`、`/88`、`/12` 等非 5 阶值改写成 bracket alpha（`bg-primary/[0.94]`），Button hover 与 DropdownMenu/Select 文字不再静默编译成无效；并扩充守门测试扫描 theme color 名前缀 ｜ 证据: 5913f5a7, 8049becd
- [前端与UI] 历史 dropdown 视觉修复 — 缩窄贴齐触发钮、减影、行高修正（文字不再叠印）、点击外部关闭、z-30→z-50、纯白不透明底、surface 溢出裁切（输入框/卡片边框不被盖） ｜ 证据: 1b31ad23, cb119753, 4b034edf
- [前端与UI] question 卡不挤压输入框 — 卡区允许收缩并设高度上限（60dvh→40dvh→45dvh 定版），面板加 overflow-hidden 防内容撑破 ｜ 证据: 5758ed5d, 5114bfcf
- [前端与UI] agent 面底部按钮列左对齐紧凑 — 回滚 justify-between 撑开布局，恢复左对齐排列；transcript 底部间距调整 ｜ 证据: 051606bb, 9e3d91da
- [前端与UI] CanvasEmbed 展开状态受控 — 补上 expanded/onToggleExpand props 修 build 型别错误 ｜ 证据: 8ab4331f
- [前端与UI] 品牌名统一 Eimu — layout 品牌名由 Emu 恢复/统一为 Eimu ｜ 证据: 6ec4f018, 425ac035
- [前端与UI] 缩图放行 Vercel Blob 域 — next.config 放行 Vercel Blob 域供 `/_next/image` 缩图 ｜ 证据: af3a9c4e
- [前端与UI] 辅助文字对比度提亮 — 思考过程标题/内容与节点辅助文字由 0.35/0.4/0.45 提至 0.55/0.6/0.62；转录区底部 padding 加大避免思考过程被裁 ｜ 证据: af3a9c4e

## 运维与观测

- [运维与观测] gatus 生产探测验证 202 任务 — `/v1/images/generations` 探测条件为 `[STATUS]==202` 且 `[BODY].id != ""`，不再宽松 2xx（避免卡 202 也算成功） ｜ 证据: 4860f1ed
- [运维与观测] 健康检查端点 — `/api/healthz` ｜ 证据: 4860f1ed
- [运维与观测] admin 出口代理池观测面板 — `/api/admin/proxy-pool` 取 adobe2api 出口代理池数据；控制面实例直连 adobe2api:6001，Vercel 侧走 HMAC 签名中继（域 `proxy-pool`，与 biz key 写入通道共用密钥但签名不通用）；未配置中继或上游异常回 `available:false` 让 UI 优雅降级 ｜ 证据: e7407935
- [运维与观测] 内部 HMAC 中继端点 — `/api/internal/proxy-pool` 供 edge 实例签名中继到控制面 ｜ 证据: e7407935
- [运维与观测] admin 控制台与代理池管理 UI — `AdminProxyPool.tsx`、`AdminRoutingPanel`、`AdminPoolManager`、`AdminBizKeys`、`AdminLogin` 等后台面板 ｜ 证据: e7407935, 4860f1ed
- [运维与观测] MCP server（image-studio） — `mcp-server` 以 biz key 接站点 API，暴露 `list_models`、`generate_image`（非同步等待成品 URL）等工具给 MCP 客户端 ｜ 证据: 4860f1ed
- [运维与观测] 运维脚本工具组 — `tools/` 的 control-plane-bootstrap、migrate-generation-db、seed-generation-suppliers、run-canary、issue-biz-key、provision-biz-account、inspect-gemini-relay 与上游探测脚本 ｜ 证据: 4860f1ed
- [运维与观测] 生成 worker 进程入口 — `worker/generation-worker.ts` 跑 generation worker，含 fatal 捕获与 unhandledRejection 记录不退出 ｜ 证据: 4860f1ed, 286c47e5

## 非程式码能力

- VPS／部署：`deploy/gatus`（config.yaml + docker-compose）自架状态页与 2h 间隔生产探测；`vercel.json` 配置 Vercel Cron 每分钟打 `/api/cron/generation-worker` ｜ 证据: 4860f1ed, ec748a51
- DB 迁移：`db/migrations/001`~`007` 七支 schema 上线（生成控制平面、admin 配置审计、canary、帐务对帐、workflow lineage、LoRA 用户态、biz key）＋ `tools/migrate-generation-db.ts` ｜ 证据: 4860f1ed
- DB 迁移：`tools/control-plane-bootstrap.ts` 与 `tools/seed-generation-suppliers.ts` 初始化控制平面与供应商 seed ｜ 证据: 4860f1ed
- DB 迁移：`tools/run-canary.ts` 跑 canary run（对应 migrations/003） ｜ 证据: 4860f1ed
- 外部服务：Adobe IMS OAuth 回调/设定链路（`/api/adobe/*`）与 Adobe2API 帐号导入（`/api/admin/adobe2api/import`） ｜ 证据: 4860f1ed
- 外部服务：微信公众平台测试号被动回覆接口 URL 配置（需微信端配置 token 与 URL 指向 `/api/auth/wechat/msg`） ｜ 证据: ec748a51
- 运营流程：从 Vercel「6h 前生产部署」全量恢复源码／品牌名／差异档（三笔 restore commit），属事故恢复运营动作而非开发 ｜ 证据: ec748a51, 6ec4f018, 425ac035
- 运营流程：上游帐号池导入与 biz 帐号开通（`/api/admin/account-pools/import`、`tools/provision-biz-account.ts`、`tools/issue-biz-key.ts`、`tools/verify-production-image-password.ps1`） ｜ 证据: 4860f1ed
- 文档：`docs/biz-api.md`／`docs/biz-api-guide.md` 随 B 端能力更新；`/v1/openapi.json` 契约同步；`public/llms.txt` 供 agent 消费 ｜ 证据: e19103a3, 984b9878
- 文档／计画：`docs/plans/2026-08-22-large-file-refactor.md` 大型档案重构计画与 4 份 domain 分析（canvas/core/input/workstation） ｜ 证据: e7407935
- 文档：`DESIGN.md`、`PRODUCT.md` 作为 UI/产品决策权威来源 ｜ 证据: e7407935
- 契约测试守门：`agent-chat-ui.test.ts`、`character-cards.test.ts`、`canvas-reducer-adapter.test.ts`、`sku-engine.test.ts`、`batch-service.test.ts`、`agent-profile-store.test.ts`、`tailwind-opacity-modifier.test.ts` 等以「读旧档＋新档拼接」方式锁定语义不放宽 ｜ 证据: e62cf333, a7837658, e19103a3, 5913f5a7
- 运营验证产物：`.codex-image-data-smoke.mjs`、`tools/run-production-image-upstream-probe.ps1` 等冒烟/探测脚本 ｜ 证据: 4860f1ed

## 边界与拒绝

- gatus 探测 fail 判准：只认 202 + task id 存在，拒绝「任何 2xx 即成功」 ｜ 证据: 4860f1ed
- 模型不支持参考图时隐藏上传入口（不让用户上传后被丢弃） ｜ 证据: e62cf333
- 画布破图不伪装生成失败：直链→同源代理→破图占位三级，占位只说「图片载入失败」并给重新载入 ｜ 证据: af3a9c4e
- worker 暂时性 DB 错误 fail-open 于进程：心跳/迭代失败只记录，租约到期自然回收，不触发批量退款；`unhandledRejection` 不退出 ｜ 证据: 286c47e5
- 容忍式 model-id 只正规化分隔符，不支援的模型仍 400（不变成任意别名通过） ｜ 证据: 984b9878
- Agent session DELETE 幂等：仅吞闸道 404 且 `code=="not_found"`（回 200 `already_gone`），其他 4xx/5xx 原样透传 ｜ 证据: 984b9878
- 无帐户画像时不硬塞空上下文：改带 `memory_empty` 让 gateway 以 question 选择题引导采集 ｜ 证据: e9e1b178
- 记忆补注查不到画像即回 `patched:false`，不虚报已注入 ｜ 证据: 3275bef9
- 教训提炼只「提议」不确认：lessons 须用户明确确认才进注入集合；提炼失败静默不报错 ｜ 证据: e19103a3
- agent LoRA 单选铁律：装配参数 `loraModelVersionIds` 只保留 1 个（服务端 slice(0,1) 兜底）；模型无 LoRA 能力明确报错不静默忽略 ｜ 证据: e19103a3
- 画布语义参考图收口：只收 https/data:image，同 URL 去重后上限 5 张；取不回直接报错不静默丢弃；`cost_coins` 算不出回 null 不填 0；count 部分成功只回部分结果 ｜ 证据: e19103a3, ec748a51
- 画布 image-proxy SSRF 立场：只服务登入用户、只认 https 公网主机、拒 IP 字面量与 localhost/*.local/*.internal、只回 image/*、上限 25MB ｜ 证据: ec748a51
- canvas-state 快照尽力而为：失败不重试；压缩后超 512KB 视为异常 ｜ 证据: ec748a51
- 模型可用性探测唯读：只发 `GET /models` 不触发生成不扣费；无 `/models` 能力的渠道诚实回 `unknown` + note 而非假装探测失败 ｜ 证据: ec748a51
- SKU 目录只读：非 GET 明确 405；`pricing` 栏位如实标 per_shot（逐镜头按模型价走既有 billing-ledger），per_sku 一口价不提前虚标 ｜ 证据: e19103a3
- 上游图转存拒收：非 `image/*` content-type、空位元组或超 `HISTORY_MAX_IMAGE_BYTES` 即拒绝转存（保留原 URL 由调用方兜底） ｜ 证据: 425ac035
- 供给面收口：`sensenova-u1-fast` 自目录与渠道队列移除；channel kind 不再有 sensenova 分支 ｜ 证据: 425ac035
- Dreamina relay 白名单拒收：非 `image-5-pro` 的模型在该池建不出端点 ｜ 证据: 8ec2239b
- proxy-pool 面板不假装有数据：中继未配置/上游异常一律 200 + `available:false` + reason ｜ 证据: e7407935
- 对外不透露供应链：endpointLabel 只回 primary/fallback ｜ 证据: 425ac035
- 渠道队列诚实列举：`describeChannels` 枚举含未配置与被停用渠道并标明数值来源，未配置显示为未配置而非隐形 ｜ 证据: 4860f1ed
- 图片编辑非破坏性：原节点永不改动，结果作新子节点；UI 诚实标注生成类是 AI 重绘不假装本地变换 ｜ 证据: ec748a51
- 素材库未登入诚实显示登入提示，不假装可用 ｜ 证据: ec748a51

## 存疑

- `4860f1ed` 是**无父 commit 的全仓初始基线**（591 档/95591 行，含 102 支 API route），其能力无法逐条归属于「本 commit 新增」。上方标 4860f1ed 者为 **baseline route-group 粒度**，未逐 route 拆条。缺证据：该 commit 之前是否存在更早历史（`git rev-list --parents` 显示无父；`git rev-list --count --all` = 450，本批只是主线最早 47 条）。
- `984b9878` 于 `src/app/api/agent/sessions/route.ts` 引入 `@/lib/agent-profile-store` 的 import，但 `git log --diff-filter=A` 显示该档直到 `e19103a3` 才被加入 ⇒ 该中间 commit 的可建置性存疑（可能为历史重建/压缩产物）。缺证据：该 commit 当时的 tsc/CI 是否通过。
- `e19103a3` 的 commit body 内含字面 `\n\n`（讯息被转义），且 `canvas/generate/route.ts` 新增注解写「2026-08-22」而 commit 日期为 08-21。实际新增档案以 `--stat`（77 档）为准；注解日期与 commit 日期不一致的成因不明。
- `425ac035`／`ec748a51`／`6ec4f018` 是「从 Vercel 6h 前生产部署恢复」的提交：能力是「回到生产版本」而非新开发。**无法从 commit 讯息判定恢复前后哪些差异是刻意的产品变更**（例：`sensenova-u1-fast` 移除、SenseNova channel 分支删除是刻意下架还是恢复副作用）。缺证据：当时 Vercel 部署清单与产品意图纪录。
- `6711d495` 把 `image-5-pro` 硬接 `https://collector-mandatory-moderator-guitar.trycloudflare.com`（临时隧道 URL，apiKey 明文 `dreamina-free-local`）。无法从 repo 证明该上游现在是否仍有效、是否为生产正式池。缺证据：生产环境变数/控制面池配置。
- 「团队与企业」领域本批零命中。可能原因：本批（08 月早期）team/RBAC 尚未实作（记忆 `2026-09-30-decision-table-coverage-audit.md` 说 team 维度＋三级 RBAC 是 P0-2、`1fdcafc0`，远晚于本批）。缺证据：未逐档扫 baseline 是否有隐含多租户/团队栏位。
- `4860f1ed` 的 baseline 是否包含「影片提取/转写」能力：本批 grep 未见相关 route 或 lib；与记忆一致（我方该格薄弱且 08-31 才降级为备援）。标为零命中而非存疑，但未逐档通读 591 档验证。

## 逐条对帐

1. `4860f1ed` — 初始基线：591 档全仓导入（102 支 API route、7 支 DB 迁移、pixai-pool bridge、mcp-server、tools、worker、deploy/gatus）；该 commit 意图面＝gatus 探测改验证 202+id（运维 fail 判准）。
2. `8ab4331f` — 纯修复（CanvasEmbed 补 expanded/onToggleExpand props 修 build 型别错误）。
3. `ec748a51` — 能力导入（生产源码恢复）：画布专用生图薄壳与 image-proxy、画布图片编辑全家桶、云端素材库 API/面板、提示词库聚合、节点内嵌生成面板、缩放/小地图/快捷键、canvas-state 上行、canvas-ops-result 回报、生成轮 abort、v1/model-status、wechat 公众号被动回覆登入、cron generation-worker、harness 文档页。
4. `6ec4f018` — 纯修复／品牌（品牌名 Emu→Eimu）。
5. `425ac035` — 能力导入／供给面收口（生产版本恢复）：上游图片转存本站 Blob、动态站点 URL、用例库 386KB 内容恢复、微信登入页恢复；同时移除 sensenova-u1-fast（目录＋渠道队列）。
6. `e62cf333` — 新能力：输入框粘贴/拖拽附件；参考图上传按模型能力门控。
7. `af3a9c4e` — 纯修复＋边界语义：画布图片直链→同源代理→破图链路、破图重试钮、content 更新重置失败态；`/_next/image` 放行 Blob 域；对比度提亮。
8. `8ec2239b` — 新能力：Dreamina Image 5 Pro/Lite/Seedream 2.0 进模型目录（比例/解析度/币价/参考图）；Dreamina relay 白名单边界。
9. `6711d495` — 新能力：Image 5 Pro 路由 Dreamina 生产池（priority 1 硬接端点）。
10. `6ebb22ef` — 纯修复（pricing override 载入后保留模型能力，fallback 静态 catalog）。
11. `271c66b6` — 纯修复（runtime 模型能力查询稳定，capabilities 直接查 effectiveCatalog ∪ 静态 catalog）。
12. `984b9878` — 新能力＋边界：容忍式 model-id 解析、Dreamina 模型无目录能力可提交、session DELETE 幂等、建新会话注入帐户画像、PixAI 池帐号档安全写入（原子写＋锁）。
13. `420bdbd9` — 新能力：首次 workflow_start 即切画布模式。
14. `286c47e5` — 纯修复＋边界语义：worker 心跳/迭代容错，暂时性 DB 错误不杀进程、不触发批量退款；unhandledRejection 只记录。
15. `dd83c049` — 纯修复（AI 助理面板 dock 布局，画布收缩让位）。
16. `e19103a3` — 新能力（大）：/v1/batches 提交+聚合+对帐汇出、/v1/skus 目录与下单与订单查询、/v1/tts 提交查询、/api/character-cards CRUD、帐户画像与静默教训提炼、agent LoRA 搜索引擎、画布语义节点、画布语义参考图与负面词、OpenAPI 扩充。
17. `5758ed5d` — 纯修复（question 卡区高度上限 40dvh，不挤压输入框）。
18. `051606bb` — 纯修复（底部 pills 铺满整排、transcript 间距）。
19. `9e3d91da` — 纯回滚（回滚 pills 撑开布局）。
20. `5114bfcf` — 纯修复（面板 overflow-hidden、卡区 45dvh 定版，回滚前两轮错误 shrink/pb）。
21. `daa226cd` — 新能力：刷新自动续上上次会话（resume 取代 D-17 discardAndStartNew），提示改「已接续」。
22. `186b1770` — 新能力：对话历史 dropdown（GET /api/agent/sessions 目录端点＋hook switchSession＋UI）。
23. `1b31ad23` — 纯修复＋诚实语义：dropdown 轻量化；闸道技术名词（question/confirm expired）中文化。
24. `cb119753` — 纯修复（dropdown 行高/点击外部关闭/surface 溢出裁切）。
25. `4b034edf` — 纯修复（dropdown z-50 与纯白不透明底）。
26. `3275bef9` — 新能力：会话记忆补注链（resume/switch 老会话补帐户画像，gateway memory-patch）。
27. `e9e1b178` — 新能力：画像 onboarding（无画像建会话带 memory_empty，gateway 首条讯息用 question 选择题采集）。
28. `e7407935` — 重构＋新能力：liquid glass 设计系统迁移与 DESIGN.md/PRODUCT.md、大型档案重构计画；**新增 admin 出口代理池观测面板与 HMAC 内部中继端点**（AdminProxyPool）。
29. `5913f5a7` — 纯修复（Tailwind 死 opacity modifier 改 bracket alpha＋扩充守门测试）。
30. `89294ebb` — 纯重构（use-cases.ts 5396→83 行拆成 17 个领域 shard，内容不变）。
31. `8049becd` — 纯修复（API docs method badge 死 opacity modifier）。
32. `3e7e4000` — 纯重构（generation-model-catalog 拆 6 模组＋barrel，54 个 importer 不动）。
33. `1d7c9925` — 纯重构（workstation 抽出 use-panel-resize）。
34. `a639f88d` — 纯重构（PromptInput 抽出 3 hooks：use-agent-hint/use-height-lock/use-pixai-tools-panel）。
35. `69af3442` — 纯重构（workstation 抽出 use-canvas-annotation）。
36. `a7837658` — 纯重构＋测试（use-canvas-chat 抽 types/reducer-adapter/sync/cards/settler，新增 29 条 reducer adapter 测试）。
37. `8c7adcb5` — 纯重构（workstation 抽出 use-boards-library）。
38. `04a7b366` — 纯重构（workstation 抽出 workstation-recall）。
39. `22246bc0` — 纯重构（CanvasNodeView 拆 node-view/：constants/use-node-gestures/NodeBody）。
40. `ca51b1ba` — 纯重构（workstation 抽出 WorkstationTopbar 面板）。
41. `3442c999` — 纯重构（CanvasEmbed 拆 embed/ 域：helpers/interaction/generation/shortcuts/overlays/context-menu-items）。
42. `e7e5148a` — 纯重构（ImagePlayground 测试读取路径同步，主体抽取随 a2cf10b 落库）。
43. `9dff8689` — 纯重构（PromptInput 抽出 4 个 JSX 面板＋rail-classes）。
44. `fcc52160` — 纯重构（CanvasChatWorkstation 抽出＋use-chat-panel＋use-agent-param-reflect，D-12 三态复原行为原文搬迁）。
45. `52372765` — 纯重构（workstation 抽出 InspectorPanel：queue/gallery/history）。
46. `b6e404bc` — 纯重构（workstation 抽出 CanvasStage 面板）。
47. `e06544eb` — 纯重构（workstation 抽出 LeftSettingsTab + WorkstationRunBar）。