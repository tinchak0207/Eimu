# image-app 第 2 批（47 commits）能力穷举清单

- 来源：/tmp/cap/batch-2.txt、/tmp/cap/batch-2.hashes（唯一真源）
- 口径：能力 = 使用者可见或可呼叫的行为，不是档案存在。修复类若暴露新边界语义亦收录。
- 领域标签：生成核心 / 模型与供应商 / 控制平面与计费 / B端API / Agent助理 / 画布与工作流 / 创作域 / 帐号与增长 / 前端与UI / 运维与观测 / 团队与企业
- 本批 commit 数：47；能力条数：96；存疑条数：9；本批无「团队与企业」领域命中。
- 分领域计数：生成核心 9／模型与供应商 6／控制平面与计费 2／B端API 3／Agent助理 16／画布与工作流 5／创作域 23／帐号与增长 5／前端与UI 16／运维与观测 11／团队与企业 0。

## 生成核心

- [生成核心] 内容审核类失败归为不可重试 — HTTP 451 或命中 legal_error／content_rejected／compliance filter 时 failureClass=content_rejected、retryable=false、不切换供应商、不隔离、无冷却；其余失败分类路径不变 ｜ 证据: efe3d029
- [生成核心] 生成品质门 v1（前置确定性检查） — 空提示词／超长（>6000）／非法宽高比／负面词反噬所选风格等「可判定」项阻断提交，不可判定项 status=skip 仅记录；零外部依赖 ｜ 证据: 4557829f
- [生成核心] newapi／openai 视频上游 adapter — 新增 newapi-video-upstream 与 openai-video-upstream 两条上游提交通道（取代单一 adobe2api 视频路径） ｜ 证据: ffc6e9af
- [生成核心] 提交前配额预检（quota-precheck） — 任务进入通道前先做上游配额检查，避免先受理后才发现上游不可用 ｜ 证据: ffc6e9af
- [生成核心] Blender 节点接入生成管线 — blender-node-upstream 把 blender 渲染节点当一等生成上游，可经既有任务通道派发 ｜ 证据: c005c4bf
- [生成核心] 3D 场景卡嵌合视频生成 — /api/generate-videos 接受 scene_card／camera_trajectory 两栏，经 fuseSceneVideo 并入视频 prompt；缺栏时零行为变化 ｜ 证据: 5f8170c8
- [生成核心] Modal 云端 Blender 渲染暖复用与场景快取 — 以 sha256 为键命中场景快取即跳过 open_mainfile 与重编译；blend 单帧暖 0.4–1.8s vs 冷 20.8–22.7s（$0.036/10 帧链） ｜ 证据: 4b5b464b
- [生成核心] C 端生成完成后的写盘挪出关键路径 — localStorage 生成快取改在 requestIdleCallback 执行并节流 ≥500ms（Safari 降级 setTimeout），避免生成结束瞬间抢主线程 ｜ 证据: 36ce9469
- [生成核心] hub 渠道固定路由（routing_class=hub_only） — DB 约束扩充第三种 routing_class，让 routing_hint=hub 的 Gatus uptime 探针固定走 hub 渠道，不被 supply_tier 排序到 adobe2api ｜ 证据: 0455beb0

## 模型与供应商

- [模型与供应商] filmera 渠道 24/7 自愈 — token 自动轮换并持久化回 env 文件（worker 重启不退回旧 token）、project/node 自愈、纯插值去水印；冻结成 protocol=filmera 的渠道 ｜ 证据: 06c6fdda
- [模型与供应商] 帐号池守护（402 自动切号） — 帐号常驻注册保活，遇 402 额度不足自动切换下一帐号，并挂载 worker env ｜ 证据: 06c6fdda
- [模型与供应商] 渠道 registry 化与一键注册 — 渠道条目集中登记于 supplier-channels.config，tools/add-supplier-channel 提供注册入口；registry 条目映射为 env 渠道描述子 ｜ 证据: 06c6fdda
- [模型与供应商] Blender 节点以 supplier channel 形态接入 — supplier-channels 新增 adapterType=blender_bridge、blender-local／blender-modal 渠道条目，catalog 挂 blender-render-eevee／cycles 能力标签，director-engine assetLoader 接线 ｜ 证据: 5f8170c8
- [模型与供应商] 模型知识面三字段 — generation-model-catalog/knowledge 为模型卡补上知识面栏位，供模型卡呈现 ｜ 证据: 4557829f
- [模型与供应商] 模型档位解析器（resolution.ts） — 依模型实际支持的 aspectRatios／resolutions／durations 解析请求值，不支持则回退模型预设（aspectRatioFromImageSize 由像素反推比例） ｜ 证据: 0455beb0

## 控制平面与计费

- [控制平面与计费] INC-0831 供应商对帐（provider-reconciliation） — 新增上游对帐模组，含 metaso／newapi／filmera 三条 poll 分支，把「上游其实成功」与「我方记失败」对齐 ｜ 证据: ffc6e9af
- [控制平面与计费] 自订档位计价（plans.ts） — 0.045 币/金币单点权威、custom:<coins> 服务端计价，含 clampCustomPlanCoins／snapCustomCoins／customPlanFor 及 9 档位；方案折扣与 GPT Image 2 等价张数换算 ｜ 证据: 0455beb0

## B端API

- [B端API] B 端 key 代理路由（/api/agent/biz/[...path]） — 把插件（emu_wish 等）带 B 端 key 的 agent 网关请求换发为使用者派生 key 后转发，零网关改动；GET events 以 SSE 流式透传 ｜ 证据: 87167706
- [B端API] B 端代理路径正规化 — 消除重复的 agent/v1 前缀段，两种 baseUrl 形态皆可正确转发 ｜ 证据: 0f28e05f
- [B端API] 用户自助管理 B 端 API key — 设定页可自助建立／列出／撤销绑定 userId 的 biz key（/api/user/biz-keys 与 /[id]） ｜ 证据: b097b4b3

## Agent助理

- [Agent助理] 免登入提示词优化端点（免费层钩子） — POST /api/agent/optimize-prompt：Agent 层优先、失败回落规则层、皆无效回 502；每 IP 10 分钟 20 次限流；不读任何授权头 ｜ 证据: b097b4b3
- [Agent助理] 免费优化端点回传六槽结构化 JSON — extractSixSlots(prompt, mediaType) 输出六槽 JSON，并以 media_type 区分 image／video 两种分流 ｜ 证据: cbf81b62
- [Agent助理] SOTA agent 工作流模板工业化 — 8 模板加 pipeline 与 requiredTools／tool-contract／domain 注册表（agent-tool-contract／agent-tool-registry／agent-tool-adapter） ｜ 证据: 06c6fdda
- [Agent助理] 助理模板库（四领域 SOTA 模板） — AgentTemplateGallery 左对话右模板库，小说／电商／短剧／艺术各 3 张，资料层 lib/agent-templates ｜ 证据: ef0bbc6b
- [Agent助理] 模板流水线蓝图字段 — AgentTemplate 新增 pipeline 字段（步骤含 deliverable／inputFrom／promptNotes／gate），8 张流水线蓝图（每领域 2 张），骨架为文本结构化→资产先行→门禁审核→组装产出 ｜ 证据: 6bf50774
- [Agent助理] MOE 专家军团（7 Expert） — 7 个 Expert persona／delegate／契约框架（blender-director／music／video／editor／screenwriter／motion／web3d）＋ expert-registry／expert-contract 注册表 ｜ 证据: c2b79797
- [Agent助理] orchestrator 野兽帧 — orchestrator-beast-frame 提供野兽模式的编排回覆框架（OFF 时回覆键逐栏位同现状） ｜ 证据: c2b79797
- [Agent助理] vision／web_search 工具注册 — harness-tool-registry 补上视觉与网路检索工具 id ｜ 证据: c2b79797
- [Agent助理] 输入笔记与画布图的宣告式 DSL — workflow-dsl 提供 compile／decompile／schema，AI 笔产出 DSL 可编译成画布图、画布图可反编译 ｜ 证据: ffc6e9af
- [Agent助理] harness 工具注册表 — harness-tool-registry 纳入可用工具清单 ｜ 证据: ffc6e9af
- [Agent助理] persona 放行资产检索工具 — 3D 导演 persona 契约放行 asset_search／asset_get ｜ 证据: 86b2584b
- [Agent助理] wish 会话并入用户助理空间 — 经 B 端 key 代理路由把 wish（插件）会话与用户网页助理合并为同一隔离空间，并提供 session 深链 ｜ 证据: 87167706
- [Agent助理] 音频成品卡 — AgentAudioCard 呈现 TTS／音乐类成品 ｜ 证据: d6e1ceb2
- [Agent助理] 子代理跑马灯与报告卡 — AgentSubagentBar 尾随跑马灯＋AgentSubagentReportCard 提交报告卡 ｜ 证据: d6e1ceb2
- [Agent助理] 会话身份与标题正典化 — 会话标题双轨（网关摘要优先）、switchSession 解锁、历史 normalizer、resolve-owner 身份正典化、beast-mode 设定端点 ｜ 证据: d6e1ceb2
- [Agent助理] 附件上传与发送同源 lazy 建号 — ensureSession 走 start() 串行化管线，修复空态附件钮恒 disabled 的回归，附件可先于发送建立会话 ｜ 证据: d6e1ceb2

## 画布与工作流

- [画布与工作流] agent 模式画布常驻 — 右面板常驻 canvas，resultMode 纯派生，删除中间态切换 ｜ 证据: ef0bbc6b
- [画布与工作流] 模板 pipeline 铺多步骤 canvas 工作流 — 每个 pipeline 步骤铺一泳道（步骤节点带产出／要点／门禁＋生成节点），步内 step→gen、步间 gen→next-step 链式连线；无 pipeline 走旧两层兜底 ｜ 证据: f653b458
- [画布与工作流] 场景 3D 卡接画布节点 — Scene3dCardBody／Scene3dGltfViewport 让 3D 场景以节点卡形态存在并可预览 GLTF ｜ 证据: c005c4bf
- [画布与工作流] 短剧生产域工具状态机 — shortdrama-domain 8 支工具（script_scene_parse／storyboard_qc_17 等）＋统一回执契约（status/gates/canvas metadata/unsupportedCode）与 17 道门禁 ｜ 证据: 06c6fdda
- [画布与工作流] 导演台 R1–R3 与 proposals 持久化 — seed 门禁泛化、capabilities、shot_count、addGroup 重叠守卫；proposals 磁盘持久化；前端 AgentDirectorCard／DirectorMiniViewport three.js 视口 ｜ 证据: ffc6e9af

## 创作域

- [创作域] 配方模板六槽具名 profile — 具名的六槽参数快照可摊进工作台表单修改，套用走 parseWorkflowRecallConfig 同一验证路径；含配方模板捕获器与 Blob 世代储存 ｜ 证据: 4557829f
- [创作域] showcase 案例双向化（用户投稿） — 历史配方可一键发布为社区案例，与官方案例合并在首页环展示（现仅发布者浏览器可见，读／写两函数预留服务端审核替换点） ｜ 证据: 4557829f
- [创作域] 短剧配方五段管线 — outline／cast／art／script／storyboard 五段 JSON 接力收敛为一条配方，能算的不让模型猜（分镜秒数按语速折算、批次切分、资产清单），资产引用复用 character-cards 卡体系 ｜ 证据: 4557829f
- [创作域] 审查页单页组装器 — 由 boards-store 的 SavedShotMeta 生成可渲染 pane 模型（每镜一 pane、分组与 hash 锚点），供 /review 单页合成模式 ｜ 证据: 4557829f
- [创作域] 历史一键存为角色卡 — 历史记录的图可锚定成 character-card（HistoryEntry→卡 payload），走 normalizeCharacterCard 唯一清洗 ｜ 证据: 4557829f
- [创作域] 电商新品上架 domain adapter — 8 支工具（product_lock／background_remove／product_conditioned_generation 等）契约与映射，只做 planning/translation 不拥有 queue／billing／history／artifact ｜ 证据: 06c6fdda
- [创作域] 时装 flat-lay→模特 domain 工具 — 8 支工具契约（garment_extract／virtual_tryon／hand_contact_repair 等），仅 shot_grid_batch 对映到本仓已具能力、其余诚实标 unsupported ｜ 证据: 06c6fdda
- [创作域] 小说／IP 视觉包 domain 契约 — 7 支工具（world_bible_extract／emotion_board_matrix／style_anchor_sref 等）的宣告式投影与 canvas metadata 契约 ｜ 证据: 06c6fdda
- [创作域] 3D 导演工作站工具族 — blender_exec／blender_export_gltf／blender_render 三支工具（Blender 5.2 兼容、分块 10 帧 turntable 存活配方）＋ headless 执行桥 ｜ 证据: c005c4bf
- [创作域] 3D 导演 persona 交付契约与嵌合三件套 — blender-director-persona 交付契约＋ camera-trajectory-to-prompt／scene3d-video-fusion／blender-to-video-bridge 把镜头轨迹与 3D 场景嵌进生成 ｜ 证据: c005c4bf
- [创作域] 3D 资产指纹零 token 复用 — blender-asset-store 以 FNV-1a 指纹双通道复用既有资产，命中不走模型 ｜ 证据: c005c4bf
- [创作域] blender-director SKILL 配方库（五阶段＋12 份） — 五阶段 SKILL 手册与 12 份上游配方＋seed-mapping 入库 ｜ 证据: c005c4bf
- [创作域] blender-director 配方库对称差扩容 12→105 — 逐目录 verbatim 吃进工艺资产／风格 mood／特效／产品运镜／图转 3D 等配方，附来源/license/雷区白名单注释块 ｜ 证据: 07038697
- [创作域] 五个新顶级 skill 域 — make-blender-education-video／motion-design／astra-ad-studio／web-3d-awwwards／blender-agent-os 五域入库 ｜ 证据: 07038697
- [创作域] 12 资产库入库 — seed-asset-packs／seed-openasset-packs 幂等 upsert，落地 91 包／2935 条×2 户并以五库搜索验证 ｜ 证据: 86b2584b
- [创作域] blender 执行成功自动入库与指纹命中 — blender_exec 成功自动 saveSceneAssets 入库、执行前指纹命中回报 template_hit、result 带 artifact_base_url 供产物取回 ｜ 证据: 86b2584b
- [创作域] 3D 路由硬规则（禁二维顶替） — SKILL 明订 3D 需求必须走 3D 工具链，禁止用二维生成顶替 ｜ 证据: 86b2584b
- [创作域] kunpeng 知识与提示词模板资产 — kunpeng-knowledge／kunpeng-prompt-templates／kunpeng-style-assets 三份知识资产入库并附红线测试（禁 ffmpeg／Kimi 等字串） ｜ 证据: ffc6e9af
- [创作域] 音乐 Expert 配方库（SunoForge v3.0 六层公式） — 六层 style 公式 GENRE→MOOD→INSTRUMENTATION→VOCAL→STRUCTURE→PRODUCTION，含诊断 12 查／词汇表／45+ 风格预设，14 档入版控 ｜ 证据: 3b29f169
- [创作域] 音乐通路判定先于配方 — 首页改为通路判定对照表，DATA_FLOWMUSIC 实测入库：时间戳在 FlowMusic2API 无效、无歌词标签时 style prompt 压单行上限 220 runes、带 [Verse]/[Chorus] 走保版面分支（上游自行加写段落并产 A/B 两版）、BPM／调性／instrumental 有效 ｜ 证据: a54ea6d0
- [创作域] 音乐工具家族 — music_gen／music_lyria／music_flowmusic 三支工具＋adapter＋staging 导出器入库（音乐生成可被 harness 调用） ｜ 证据: 9a6ee963
- [创作域] 音乐 prompt 确定性规则层 — 六层侦测＋缺层补齐、伪标签剥除、anti-slop、mood ≤2，外加通路感知（flowmusic 剥无效时间戳、无歌词标签压单行并按层权重守 220 runes，超限整层丢弃记 truncated；lyria 保留时间戳）；零 import 纯函数决定性 ｜ 证据: 86eb165f
- [创作域] 音乐 prompt 硬截用满预算 — 首 cap runes 内存在 ≥60% cap 的子句边界才退让，否则退最后空白（避免切断拉丁单词），CJK 直接在 cap 切；同一输入由 15 runes 提升到 217 runes 且保住 mood／genre／instrumentation ｜ 证据: bdb8b81a

## 帐号与增长

- [帐号与增长] GitHub 一键授权 DSH 插件并自动签发 biz key — emu-oauth 产 60s 签名码（HMAC，timingSafeEqual 验证），callback 带 loopback cookie 时 302 回 DSH loopback（保留站点 session），exchange 验码后签发绑 userId 的 sk-biz- key ｜ 证据: b097b4b3
- [帐号与增长] PWA 跨浏览器登入 handoff — 常用浏览器完成 GitHub 授权后以一次性 ticket 交回 PWA（create→callback 带 state→poll→一次性 claim 种 napi_token），解决 standalone storage 隔离；TTL 10 分钟 ｜ 证据: 5f8170c8
- [帐号与增长] auth 韧性链 — auth/me 遇坏残留凭证反查重试（newapi-session-token），fetchMe transient 错误不抹凭证，github-login 补齐 ｜ 证据: 5f8170c8
- [帐号与增长] newapi 会话 token 反查 — api/internal/newapi-session-token 由凭证反查 userId／会话 ｜ 证据: 5f8170c8
- [帐号与增长] auth/me 硬超时与微快取 — 对控面 GET /api/user/self 加 2.5s 硬超时（超时回 503 走 transient），成功结果 30s TTL／上限 500 条微快取，key 为凭证 SHA-256 杂凑 ｜ 证据: c2b79797

## 前端与UI

- [前端与UI] 失败提示依错误码分类显示 — 依 errorCode／errorMessage 正则给出人类可读提示，新增「当前帐号无影片生成权益」与「内容审核未通过」两类 ｜ 证据: efe3d029
- [前端与UI] 点模板卡注入提示与铺画布 — 点卡即注入 initialPrompt（复用 useAgentChat().send）并用 slots 铺 canvas workflow，可 undo ｜ 证据: ef0bbc6b
- [前端与UI] ModelPicker flyout 固定宽 — 展开能力卡时固定 lg:w-[24rem]，不再抖动 ｜ 证据: ef0bbc6b
- [前端与UI] 模板入口旋转木马 — AgentTemplateCarousel 继承 case-showcase 全套物理（拖拽／惯性／弹簧／键盘／磁力落格），300px 卡宽，仅正面卡触发 onUseTemplate ｜ 证据: f653b458
- [前端与UI] 模板卡材质层栈修复 — 补 edge／surface（sheen／rim）光照四件套、GL 缺席冷光 inset、grid 置中、pointer-events 由 slab 承接；测试锁死五层 JSX 防再砍层 ｜ 证据: 476244e0
- [前端与UI] 模板卡海报区重造 — 卡面 55% 领域海报区（领域大字水印＋pipeline 步骤链），8 张按领域 accent 配色，卡宽 320→420 竖版，文字区垂直置中 ｜ 证据: 7b8f5992
- [前端与UI] 历史「再来 N 组／微调变体」重跑 — 把历史记录完整配方 payload（六槽＋模型＋尺寸）批量提交到 /api/generation-jobs，支援只改 prompt／换模型／换尺寸；带 retryOfTaskId 父链与参考图继承；组数档位 1/2/3/5/8 ｜ 证据: 4557829f
- [前端与UI] 定价弹窗重构 — PricingClient 重构并导入 PricingQuality 品质测试 ｜ 证据: 4557829f
- [前端与UI] 生成中粒子海弹等候视觉 — ParticleSeaWaiting（蓝粉灰 1:1 卡内铺满）接 ImageDisplay isRendering 分支，后续重做为生成中海底视觉 ｜ 证据: 5f8170c8
- [前端与UI] 定价方案轮播卡 — PricingPlanCarousel 轮子＝AgentTemplateCarousel 逐行复制，含自订档 Log Scale 滑杆 ｜ 证据: 0455beb0
- [前端与UI] 灯箱与编辑面板／参考图 — 灯箱复用（ImageLightbox），PromptInput 编辑面板与参考图上传（ReferenceImageUpload）重做 ｜ 证据: 0455beb0
- [前端与UI] 工具显示名映射 — 113 键工具 id→显示名映射，agent 工具卡不再显示裸 id ｜ 证据: d6e1ceb2
- [前端与UI] Service Worker v2 与下载穿透 — 拆除 navigate 拦截（登入 redirect 不再被写入快取毒药面），CORS 图下载以 ?dl=1 穿透（imageHelpers 与 nginx default.conf 同步） ｜ 证据: 5f8170c8
- [前端与UI] 手机端批次修复 — Seedance 时长 10s 地板、手机全萤幕助理、弹窗置中 ｜ 证据: 5f8170c8
- [前端与UI] 工作台 boards 库导入参考图 — 从资料夹导入 shot 为参考图时量测自然尺寸（measureNaturalSize）并带入，避免比例失真 ｜ 证据: 00af5fb9
- [前端与UI] 工作台引导行动端适配 — tour 文案更新＋移动端三件（可见锚点解析、容器 .pro-studio-body 滚动同步、移动端安全弹层方位），修 driver.js 在 <1024px 的错位 ｜ 证据: 00af5fb9

## 运维与观测

- [运维与观测] /v1/model-status 追加 24 小时表现统计 — 每模型追加 jobs／delivered／failed／success_rate／refunded 的 last_24h 真实数据，与 /admin 模型分布同源 ｜ 证据: 62610cfe
- [运维与观测] 生成品质门日志 — generation-gate-log 以 Blob 世代储存每用户门禁检查纪录（上限 500 条）并统计各门触发率（fail/(pass+fail)） ｜ 证据: 4557829f
- [运维与观测] 余额信号与供应商健康同源裁决 — model-status R7-E 余额信号＋supplier-health-signal 让执行侧与观测侧对供应商可用性做同源裁决 ｜ 证据: ffc6e9af
- [运维与观测] admin 路由调度面板显示产出图 — AdminRoutingPanel 展开路由调度时显示对应产出图 ｜ 证据: 06c6fdda
- [运维与观测] 桥上产物取回端点（GET /v1/artifact） — blender bridge 提供产物下载，含 traversal 双防护与副档名白名单 ｜ 证据: 86b2584b
- [运维与观测] staging 工具稿 byte 等价导出器 — export-blender-tools-staging --check 验证 staging 稿与真源机械导出 byte 等价（根治 461→832 行漂移） ｜ 证据: 86b2584b
- [运维与观测] blob 读写统一 10s 硬超时 — blob 的 list／put 统一 10s 硬超时与呼叫方 abortSignal 合并；put 属写入且幂等性未知故超时不重试 ｜ 证据: 36ce9469
- [运维与观测] 音乐工具回执新增 prompt_director 栏 — music_gen 回执如实回报 applied／warnings／truncated／layers，让规则层介入可被观测 ｜ 证据: 86eb165f
- [运维与观测] VPS 同步 export 工具 — 提供把本地真源同步／导出到 VPS harness 的工具 ｜ 证据: c2b79797
- [运维与观测] headless 执行桥 — server.py／blender_addon.py／launcher.py 提供 job FIFO 伫列、双层超时、stdout 分道轮转（codeout 与 blender.log 不互相截断）、scan_artifacts 快照 diff 判定产物 ｜ 证据: c005c4bf
- [运维与观测] 僵尸会话根治链 — agent 会话生命周期清理，避免僵尸会话残留 ｜ 证据: d6e1ceb2

## 非程式码能力

- DB 迁移：010_filmera_supplier（filmera 渠道）、011_metaso_supplier、012_biz_key_newapi_token、013_job_events、014_cangyuansuanli_supplier、015_billing_writeoff、016_provider_reconciliation ｜ 证据: 06c6fdda, ffc6e9af
- VPS／部署稿：deploy-staging 五目录（SSH 反向隧道服务＋bridge-reverse-tunnel.js、Modal 云端渲染 POC 四档、blender-nodes 渠道稿、blender-gateway 工具真源、blender-director-persona 幂等补丁） ｜ 证据: 04ebc177
- 仓库追踪清理：-2318 档、追踪体积 230MB→15MB；pixai-pool 帐号数据（638 帐号明文）／redteam 脚本／log 全家退追踪，AGENTS.md 加 repo 扫描地图 ｜ 证据: ea41f112, 951451ab
- 凭证隔离：.flowmusic-creds／staging／deploy-staging／*.bak-* 进 .gitignore，tsconfig 排除 staging ｜ 证据: a51702bd
- 文档站改版：/docs/report 挂 13M 比赛报告 PDF 并设快头 Cache-Control，docs/*.md 战役记录入库 ｜ 证据: 5ea2d5cb
- README 产品说明书化：中性章节名、第三人称、表格承载信息，改简体中文，模型目录 54→56、API base 改 eimu.dev/v1、Blender 5.2.1，附 13 张产品预览图 ｜ 证据: 539c9c92
- PRD 入档：prd-agent-global-memory（私有／共享双层记忆库契约）＋symdiff-aid-swallow-prd（吞 AID 产品层刀位裁定），THIRD-PARTY-NOTICES 追加 AID（MIT） ｜ 证据: f7e9032f
- filter-repo 事故恢复：从 ZCode 会话库重放 138 档未提交改动＋bundle 组装 agent-templates（tsc 0 错、1411/1411 测试绿） ｜ 证据: ffc6e9af
- 部署忽略与探针：.vercelignore 补漏排除评测产物／一次性残片 patterns，gatus 探针配置调整 ｜ 证据: 1f9e9f2b, 057243be, 1fae23c0

## 边界与拒绝

- 451／legal_error／content_rejected／compliance filter 一律 fail-closed：不可重试、不切换供应商、不隔离、无冷却 ｜ 证据: efe3d029
- 帐号无影片生成权益时显示专属提示，不误报成「审核未通过／额度不足」 ｜ 证据: efe3d029
- 生成品质门：不可判定项一律 skip，仅 fail 才阻断；明订「误拦的门比没有门更糟」 ｜ 证据: 4557829f
- 免费优化端点不读授权头，AGENT_OPTIMIZE_KEY 只在内部使用、永不进响应；限流为尽力而为而非精确配额 ｜ 证据: b097b4b3
- B 端代理：B 端密钥与派生 key 只出现在发往网关的 Authorization 头，任何 log／错误响应不夹带（固定文案）；网关 404（session not found 防枚举）原样透传不改写 ｜ 证据: 87167706
- 时装 flat-lay domain 8 工具中仅 shot_grid_batch 有真能力，其余标 unsupported（不宣称分割／身份／试穿／修手／排版模型存在） ｜ 证据: 06c6fdda
- 电商 domain adapter 明确不拥有 queue／billing／history／artifact storage／canvas persistence，只做规划与翻译 ｜ 证据: 06c6fdda
- 短剧域统一回执：status 有 succeeded／blocked／unsupported／failed 四态，unsupported 需带 code／message／requiredCapability 诚实回报 ｜ 证据: 06c6fdda
- 3D 路由硬规则：3D 需求禁止用二维生成顶替 ｜ 证据: 86b2584b
- 音乐规则层「库内无依据的同义词表诚实留空」；决定性纯函数，规则逐条引用配方库行号 ｜ 证据: 86eb165f
- 音乐通路边界：FlowMusic2API 时间戳无效需剥除、无歌词标签时 style prompt 压单行守 220 runes、带 [Verse]/[Chorus] 走保版面分支；BPM／调性／instrumental 有效 ｜ 证据: a54ea6d0
- 音乐硬截边界：仅当 ≥60% cap 处存在子句边界才退让，否则退最后空白（避免切断拉丁单词），CJK 直接在 cap 切 ｜ 证据: bdb8b81a
- blob put 属写入且幂等性未知 → 超时不重试，AbortError 依现行错误路径照抛 ｜ 证据: 36ce9469
- 3D 场景卡嵌合为可选：scene_card／camera_trajectory 缺栏时零行为变化 ｜ 证据: 5f8170c8
- auth/me 明文 token 永不进快取、永不进日志（快取 key 为 SHA-256 杂凑，日志只印前 8 码）；只快取成功结果 ｜ 证据: c2b79797
- 资产库扩充的 SKILL 铁律与 3D 路由白名单；kunpeng 知识正文禁出现 ffmpeg／Kimi／vision_video_analysis 等工具名字串（红线测试） ｜ 证据: 86b2584b, ffc6e9af

## 存疑

- 4557829f「R 键配方回填」：diff 只见资料层 workstation-recall.ts，未见 R 键 keydown 绑定或 UI 触发点，缺「按 R 即回填」行为的直接证据（缺：UI 绑定档与行号）。
- 06c6fdda「每个模型追加…」「agent chat silent 注入」与「admin 路由调度展开显示产出图」：仅有 commit 讯息与档名（AdminRoutingPanel.tsx、messages route），未逐行读 diff，具体可验证行为待补（缺：AdminRoutingPanel 与 messages route 的 diff）。
- 04ebc177：deploy-staging 五目录自陈为「稿」，是否已部署成活体未知（缺：VPS 现场档案与服务状态）。
- 07038697：五个新顶级 skill 域与 105 份配方是否已部署到 VPS harness 并被 Expert must-load 未证（commit 只说入库）。
- 3b29f169：commit 自陈「部署与 Expert 接线由后续片处理」，本 commit 本身未接线（缺：后续片是否已闭环的证据）。
- ffc6e9af：138 档重放入库，无法从 commit 区分「新能力」与「事故前既有能力复原」，本清单只取其中明确的新模组（provider-reconciliation／quota-precheck／workflow-dsl 等）。
- 1fae23c0：blender-bridge server.py +81 行修订内容未细读，是否含新能力存疑（缺：server.py diff）。
- 62610cfe：/v1/model-status 的 last_24h 与 /admin 模型分布「同源」为 commit 自陈，未跑 SQL 实际核对。
- 476244e0／7b8f5992／9fd19be9／3fea5783：属纯外观或逐行复制类；本清单按「使用者可见行为（外观）」收录，若采「仅可呼叫行为」口径则这几条可剔。

## 逐条对帐

| hash | 该 commit 贡献的能力（或纯修复／纯重构／无新能力） |
|---|---|
| 9c32e211 | 纯重构（LeftPromptTab 从工作站抽离，task 8 panel 5/5） |
| efe3d029 | 边界语义：content_rejected（451/legal_error）不可重试；影片权益提示（生成核心＋前端与UI 各 1 条） |
| b097b4b3 | GitHub 一键授权 DSH 自动签发 biz key；用户自助 biz key 管理；免登入提示词优化端点（3 条） |
| cbf81b62 | 免费优化端点六槽 JSON 与 image/video 分流（1 条） |
| 87167706 | B 端 key 代理路由；wish 会话并入用户助理空间＋session 深链（2 条） |
| 0f28e05f | 纯修复（B 端代理重复 agent/v1 前缀正规化，列为 B端API 边界语义 1 条） |
| 4557829f | 配方总线第一波：配方模板六槽 profile／showcase 用户投稿／短剧配方／审查页组装器／历史存角色卡／历史再来 N 组／定价弹窗重构／模型卡三字段／生成品质门＋日志（9 条） |
| 057243be | 无新能力（移除超大 dmg、gitignore workbuddy） |
| ef0bbc6b | 助理模板库；画布常驻；点卡注入＋铺画布；ModelPicker 固定宽（4 条） |
| 6bf50774 | 模板流水线蓝图字段（pipeline/deliverable/gate）（1 条） |
| f653b458 | 模板 pipeline 铺多步骤 canvas；模板入口旋转木马（2 条） |
| 476244e0 | 前端与UI：模板卡材质层栈修复（1 条，外观） |
| 7b8f5992 | 前端与UI：模板卡海报区与领域配色重造（1 条，外观） |
| 3fea5783 | 纯重构（旋转木马改为 CaseShowcase 逐行复制／轮子纪律） |
| 9fd19be9 | 纯修复（CSS import 相对路径，build 修复） |
| 06c6fdda | filmera 渠道自愈；帐号池 402 切号；渠道 registry＋一键注册；agent 工作流 8 模板工业化；电商／时装／IP domain 契约；短剧域状态机；admin 调度面板（8 条） |
| 62610cfe | /v1/model-status last_24h 真实表现统计（1 条） |
| 59221be9 | 纯修复／观测微调（last_24h 统计失败时记错误日志，无新能力） |
| ea41f112 | 非程式码（仓库追踪清理，-2318 档／230MB→15MB） |
| ffc6e9af | 全量入库：provider-reconciliation／quota-precheck／newapi+openai video upstream／workflow-dsl／harness-tool-registry／导演台 R1-R3＋proposals／余额与健康同源裁决／kunpeng 三资产／6 个 DB 迁移（含非程式码项） |
| 951451ab | 非程式码（根目录暴露面清理，帐号池数据退追踪） |
| c005c4bf | blender 3D 导演全链：工具族／persona＋嵌合三件套／资产指纹复用／SKILL 五阶段＋12 配方／headless 桥／场景 3D 卡／节点接入（7 条） |
| 04ebc177 | 非程式码（deploy-staging 五目录部署稿） |
| 5f8170c8 | PWA 跨浏览器 handoff；auth 韧性链；newapi 会话 token；粒子海；blender 节点渠道；3D 场景卡嵌合；SW v2；手机端批次（8 条） |
| 1f9e9f2b | 非程式码（.gitignore 补漏一次性残片 patterns） |
| 4b5b464b | Modal 云端渲染暖复用与场景快取（1 条） |
| 07038697 | blender-director 配方库 12→105；五个新顶级 skill 域（2 条） |
| 86b2584b | 12 资产库入库；blender 自动入库＋指纹命中＋artifact 取回；/v1/artifact 端点；3D 路由硬规则；persona 放行资产工具；byte 等价导出器（6 条） |
| f67dc3d0 | 无新能力（临时 secret 指纹诊断路由，验完即删） |
| 90ad3615 | 无新能力（移除上条临时路由） |
| 3b29f169 | 音乐 Expert 配方库（SunoForge 六层公式）（1 条） |
| a54ea6d0 | 音乐通路判定先于配方＋FlowMusic 实测边界（1 条） |
| 9a6ee963 | 音乐工具家族（music_gen/lyria/flowmusic）（1 条） |
| 86eb165f | 音乐 prompt 确定性规则层；工具回执 prompt_director 栏（2 条） |
| bdb8b81a | 音乐硬截用满预算（15→217 runes，边界语义）（1 条） |
| a51702bd | 非程式码（凭证与 VPS 同步工作目录隔离） |
| d6e1ceb2 | 音频成品卡；子代理跑马灯＋报告卡；会话标题与身份正典化＋beast-mode；附件 lazy 建号；工具显示名 113 键；僵尸会话根治（6 条） |
| c2b79797 | MOE 7 Expert＋registry/contract；orchestrator 野兽帧；vision/web_search 工具；auth/me 硬超时＋微快取；VPS 同步 export 工具（5 条） |
| 0455beb0 | hub_only 017 迁移；模型档位解析器；自订档计价；定价轮播卡；灯箱＋编辑面板／参考图；粒子海重做（6 条） |
| a8c1d059 | 纯修复（GitHub 回调／me、mapay 下单回调三件套、adobe 回调、new-api 鉴权端修订） |
| 5ea2d5cb | 非程式码（文档站改版＋/docs/report 挂 PDF） |
| 77cf70a3 | 纯重构（移除首页 CaseShowcase，改由模板廊承载） |
| 00af5fb9 | 工作台 boards 库导入参考图（自然尺寸）；工作台引导行动端适配（2 条） |
| 36ce9469 | 生成快取写盘挪出关键路径；blob 读写 10s 硬超时（2 条） |
| 1fae23c0 | 非程式码／运维（vercelignore／gatus 探针／blender-bridge 与 skill 配方微调，无明确新能力） |
| 539c9c92 | 非程式码（README 产品说明书化＋13 张预览图） |
| f7e9032f | 非程式码（两份 PRD 入档＋THIRD-PARTY-NOTICES 追加 AID） |