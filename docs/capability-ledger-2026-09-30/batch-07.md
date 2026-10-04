# 第 7 批（47 commit）我方能力清单

- 范围：/tmp/cap/batch-7.hashes 全 47 条（2026-09-28 ～ 2026-09-30）
- 口径：能力＝使用者可见或可呼叫的行为；档名/模组名不算能力。修复类若暴露边界语义另列。
- 领域标签限用 11 个。同一能力只列一次。

## 生成核心

- [生成核心] 音乐三路全链回落（YuE2→FlowMusic→Gemini Lyria） — 只在「已选通路抛错」时回落；Lyria 仅在 GEMINI_API_KEY 已配置或有前路时入链；换通路必须用该通路重新过 director；全链失败回退带每一路原因码 music_all_channels_failed ｜ 证据: e75a2e8e
- [生成核心] 欠费无替补即时失败＋退款 — 上次失败判定 quota_exhausted 且诊断显示无可用替代供应商（全被排除／冷却／不健康）即当下失败并退款，不再空转到 25 分钟 deadline（实弹 2.4 秒）；capacity_saturated 不算（仍有健康供应商在忙）｜ 证据: e75a2e8e
- [生成核心] 影片生成式后期（续片 extend_video／局部改片 edit_video） — 仅 catalog 宣告 videoGenerationTypes 含该型别者可提交（今日＝Seedance-2.5 族）；型别契约＋能力闸门＋具名错误码；两条 route（api/generation-jobs、api/v1/videos/generations）皆接 ｜ 证据: 51ca0474
- [生成核心] 生成式后期来源影片解析 — 收 source_video.url 或 source_video.object_key（objectKey→url resolver），非 http(s) 一律 video_source_video_not_url 拒、缺来源 video_source_video_missing 拒（fail-closed，不猜）｜ 证据: 51ca0474
- [生成核心] 一键超分档位契约 — 档位是 (size, factor) 参数对而非枚举字串：1k→(1k,×2)、2k→(2k,×2)、4k→(2k,×4)，长边保底 4608px；一键预设＝最高可提交档位 ｜ 证据: 329c4221
- [生成核心] 超分提交路由统一走档位解析 — C 端 /api/pixai/upscale 与 B 端 /v1/upscale 都走 resolveUpscaleSubmission，factor 由呼叫端任意值改为契约值（计费口径未动）｜ 证据: 329c4221
- [生成核心] 4K 提交端打开＋严格解析度解析 — 显式 resolution／size:"4k"／size:"4096x4096" 皆可到 4k；未由模型宣告即具名拒 resolution_not_declared_by_model，禁静默降级 ｜ 证据: 0289ade9
- [生成核心] durable 图片尺寸白名单单一真源 — 已知可交上游尺寸（1024x1024／1536x1024／1024x1536／2048x2048／4096x4096）＋档位倍率折算（1k×1／2k×2／4k×4）＋旧 "1k"/"2k" 别名；generations 的 SUPPORTED_SIZES 与 edits 的 DURABLE_EDIT_SIZES 收拢一处 ｜ 证据: 82ee2b9a
- [生成核心] 数量上限单一真源（批次数／参考上限） — request-limits 零 import 叶模组为唯一真源（MAX_REQUEST_BATCH_COUNT=4、MAX_REQUEST_REFERENCE_IMAGES=5），images/videos generations、biz-image-references、batch-service 全改引用点 ｜ 证据: a9b33109
- [生成核心] Web durable 任务负面词与参考图角色不再丢失 — 分发层用与 legacy /api/generate-images 同一函式（buildWorkflowPrompt）组进单一 prompt，位元组一致；用户原文记 workflow.originalPrompt，显示/重跑读 displayGenerationPrompt 还原 ｜ 证据: 64b2bf91

## 模型与供应商

- [模型与供应商] 极途 Gway 备用视频渠道（priority 2） — xiaoyxiao 直接上游，同名模型同协议；控面 DB＋env 已上线，seed 不会把它当未知渠道 ｜ 证据: ed47cb58
- [模型与供应商] 供给 adapter registry（协议注册表） — 新增一条新协议供给＝2 档（adapter 档＋channels.config 条目），载入时自动注册；分派／对帐／对帐协议映射三处中央 switch 皆查此表；未注册协议明确失败（不再 default 成 newapi_video）｜ 证据: 64b2bf91
- [模型与供应商] 上游模型别名改读资料 configuration.modelAliases — 不再认 supplier 身分特例（废除 supplier.id === "env:sub2api" 硬编）｜ 证据: 64b2bf91
- [模型与供应商] catalog 只外露可服务的超分档位 — 宣告 upscaleTiers:[1k,2k,4k] 但 generationCapabilities 只给 servableUpscaleTiers（校准前不含 4K），不宣告提交时必被拒收的档位 ｜ 证据: 329c4221
- [模型与供应商] YuE2 模型输入预算（8GB 卡） — style 上限 3000→600 runes、ABC ≤500 token，截断标记泛化为 truncate-${limit}-hard；同单 52.4s 成片、峰值 7.10GiB ｜ 证据: b68c0fdd

## 控制平面与计费

- [控制平面与计费] 成本闸按（供给 label, 上游 model）核价 — 读 claim 的 unitPriceCny/priceSource（含来源原文与日期），缺价才回退兜底表；两者皆无＝未核价不许提交；openai_video 协议 fail-closed，其他协议只在上游 model 落白名单时套价检 ｜ 证据: 64b2bf91
- [控制平面与计费] 同步直通路由的钱进帐本 — /v1/images/edits（pixai 分支）、/v1/upscale、/v1/template-generations、/api/pixai/* 经 sync-charge 门面留 billing_operation 列，可被 reconcileGenerationBilling／retryStrandedRefundOperations 捞回（原本退款失败只剩一行日志）｜ 证据: 64b2bf91
- [控制平面与计费] 同步 job 状态机（绝不进 queued） — reserve 成功后 job 保持 running；确定未扣 → op failed＋job failed（客户当下拿 402，不在背后偷偷扣）；不明 → op unknown＋job billing_unknown 交 6h 僵尸回收全额退款 ｜ 证据: 64b2bf91
- [控制平面与计费] 取消任务＋条件退款门面 — 分发路由只收 { cancelled, previousStatus, refund }；queued/leased 全额退款、pending_billing 未扣不退、submitting/running 由 worker 丢弃并交 reconcile 兜底；退款未 applied 不向客户端谎报已完成 ｜ 证据: 64b2bf91
- [控制平面与计费] 4K 超分计费改吃档位 — imageGenerationCoins 第三参数带档位，4K 不再按 1k/2k 价卖；既有输入（1024x1024／2048x2048 ＋ fast/hd）解析度与价格逐位元不变 ｜ 证据: 0289ade9
- [控制平面与计费] GET /api/admin/statistics?format=csv 统计/用量导出 — 同一份投影的 CSV（单表＋section 栏供 Excel 筛选/pivot），meta 段带窗口与口径；只认 json／csv，其余具名 400；导出与 JSON 同一道 admin 门 ｜ 证据: c6ca3857
- [控制平面与计费] 用量按生成物类别切分 — byAssetKind 切面（shot_video／still_image／unclassified 三桶），锚点与日／模型同一个 job ⇒ 三切面可逐桶对帐；CSV 增 asset_kind section ｜ 证据: 8d9e067f
- [控制平面与计费] 后台统计看板取真数字 — /api/admin/statistics 加进 CONTROL_PLANE_PROXY_SOURCES（控面容器同时有 route 与库），不再由 Vercel 本地副本回「统计不可用」降级投影 ｜ 证据: 6221c69d

## B端API

- [B端API] /v1/models 升级成能力契约 — 逐模型揭露 maxBatchCount（全给）＋maxReferenceImages（仅 referenceImages===true 时给）；openapi ModelCapabilities schema 补 5 栏（新 2 栏＋videoGenerationTypes／promptCharLimit／upscaleTiers）｜ 证据: a9b33109
- [B端API] GET /v1/tts/voices 结构化语音库 — 照对手 ListVoices 无参数全量回，每条附 route（实际走哪条上游）与 source（属性实查来源），另回 default_voice 与 Age 缺席说明 ｜ 证据: 215d2f07
- [B端API] POST /v1/tts/generations 音色值域把关 — voice 走 normalizeVoiceId，未知 → 400 voice_unknown（讯息指向语音清单）；未带 voice ⇒ 既有 "default" 行为逐位不变 ｜ 证据: 215d2f07
- [B端API] /v1/upscale 对外文件揭露档位契约 — 三档位上游配对、一键预设语义、三个具名拒收码写进摘要；schema 补 upscale_tier（enum＝执行端 UPSCALE_TIERS）、factor 改写成档位倍率语义、size 去掉假的 default ｜ 证据: de4f5df9
- [B端API] generations 的 size 列举从执行端常数派生 — enum: [...DURABLE_IMAGE_SIZES] 补 4096x4096，并揭露 resolution／output_resolution 档位键 ｜ 证据: b32c4818
- [B端API] 建 key 面板与 /docs/api 曝光 OpenAI 兼容 base — 显示 https://eimu.dev/openai/v1（此前只写在 repo docs，开发者不可见）｜ 证据: 3a483ee6
- [B端API] /v1/upscale 新后端口径与自证栏位 — 文件写明「是重新绘制、不是保真像素放大」、后端与具名码；ImageObject 补 width/height（回应带实测尺寸供自证）｜ 证据: 0289ade9
- [B端API] /v1/upscale 揭露「档位以 size 表达」口径与新码 upscale_backend_size_unavailable ｜ 证据: 82ee2b9a

## Agent助理

- [Agent助理] 「已思考 N 秒」当下结算 — 思考后直接调工具（中间无正文）时在 tool.invoke 即结算 reasoningMs，不再等整轮 settleItems 造成每段思考都显示成到整轮结束 ｜ 证据: bd5405f5
- [Agent助理] 「已用 N 币」只算真花费 — 报价估价与失败工具不计入；网关侧报价类工具 tool.result 不再挂 cost_coins（双端同修）｜ 证据: 5d4e202b, e5d954a7
- [Agent助理] 自动制画布只给出图工具 — image_quote／get_result／upload 不再铺永远待处理的空节点 ｜ 证据: c5115e19
- [Agent助理] 站内可达 Remote MCP 安装页 /mcp — 助理带走页补连结（此前站内零连结、文档只教克隆自建）｜ 证据: 74fb5728
- [Agent助理] 斜线技能选单底部「浏览全部技能」→ /skills ｜ 证据: 905bcccf
- [Agent助理] 助理可用影片取证工具登记＋知识正文还工具 — video_evidence／video_fetch／video_measure／video_transcribe 进 harness-tool-registry；kunpeng-knowledge 把「怎么看参考片」从纯文字指导接回这四支（含环境未 prepare 时回 video_fetch_unavailable 的诚实边界）｜ 证据: 1fdcafc0

## 画布与工作流

- [画布与工作流] 画布生成预设走 durable job — 每张 POST /api/generation-jobs（带 Idempotency-Key）→ 伺服器端轮询取件，回应形状与旧版一字不变；等待上限＝maxDuration−20s，超时回 504 generation_timeout 且不取消任务 ｜ 证据: 64b2bf91
- [画布与工作流] Blender 插件下载入口 — 画布「连接 Blender」补 public/downloads/eimu-blender-addon.py（测试锁与 bridge 真源逐字一致）｜ 证据: 3a483ee6
- [画布与工作流] 节点右键「恢复上一版」 — 接既有 revert_node reducer（进撤销栈，无更早版本时灰掉）｜ 证据: 3a483ee6
- [画布与工作流] 图片右键「一稿多版位」 — 经 /api/canvas/format-crops 按常用尺寸裁出版位，落成源图右侧子节点＋连线（扩图版位无上游照实略过）｜ 证据: 3a483ee6
- [画布与工作流] 3D 白模当生成参考 — scene_3d 节点的 stills 经既有 blender-to-video-bridge 参考卡接成生成节点的一等参考（影片/模型档由该轮子剔除、首张带 nodeId 作去重载体）｜ 证据: aa81b4b0
- [画布与工作流] 回分镜溯源两键 — directorStageId／shotId 进 metadata 双白名单；shotId 优先舞台自身 storyboardShot.shotNumber，其次生成节点自身 ｜ 证据: aa81b4b0
- [画布与工作流] 分镜级候选集与星标选定 — 一分镜 ≤4 条（第 5 条明确拒绝）、首条自动选定、不自动抢稿、星标者被删除才回退首条 ｜ 证据: aa81b4b0
- [画布与工作流] 候选 prompt 回溯 — 候选可读回产生它的 prompt 供重跑；缺 prompt 整条丢弃，不编造 ｜ 证据: aa81b4b0
- [画布与工作流] 分镜增删复制重排 — 复制品剥掉来源的产物／裁决／溯源指针 ｜ 证据: aa81b4b0
- [画布与工作流] 按集批次换模型／批次重跑 — metadata.episodeId＝CanvasEpisode.id（现场原无「分镜→集」的边）；缺 prompt 的格列 missingPromptShotNumbers 并排除，不用假 prompt 花钱 ｜ 证据: aa81b4b0
- [画布与工作流] 任务版本／Tags／选中标记 — per-任务版本（重跑产生新版本且旧版本存活）、Tags 语义与分组、选中照既有 batchPrimaryImageId／reducer 星标回退语义（不自创第三套）｜ 证据: 51ca0474
- [画布与工作流] 专案级风格绑定（风格一等 id） — styleId id 进全文出：request > project 优先序、查不到回 null（不猜近似 id、不回退第一个风格）；未知 id 在 /api/canvas/generate 于任何下游请求之前 400 style_id_unknown 挡下；无风格时 prompt／负面词逐位不变 ｜ 证据: 8dcdcd57
- [画布与工作流] 专案级剧本型别与旁白音色 — scriptType 接既有 AID enum（plot／monologue，desc 逐字取自 AID 未改写）、narrationVoice 直接复用 normalizeVoiceId（与 /v1/tts/generations 同一把尺）｜ 证据: f2668377
- [画布与工作流] 专案级栏位汇出／汇入带得走 — styleId、scriptType、narrationVoice 走完整七处接线（types／normalizeProject 逐栏白名单／canvasProjectMeta／normalizeProjectMetaPatch／专案 PUT／hook state 与三处还原点／setProjectMeta），汇出整包带走、汇入经 canvasProjectMeta ｜ 证据: 8dcdcd57, f2668377
- [画布与工作流] 影片截帧容量放开与 at 模式 — /api/canvas/video-frames 时长上限 60→600s、序列帧 24→600、新增 mode:"at"＋atSec 时间点清单（严格递增、全部 < 片长），加 intervalSamples／tileSampleTimes／frameFileName（照 hypit 语义移植）｜ 证据: 1fdcafc0
- [画布与工作流] 模板卡片旋转木马重构 — 沿用 CaseShowcase 交互机件（wheel {passive:false}／SPRING_TRACK／drive() 全保留），提交键跑选定步骤、海报浮水印卡片、挑著跑时主按钮带 k/N 与「恢复全部」、零选时禁用 ｜ 证据: c859432b

## 创作域

- [创作域] 变装子资产 — 既有 variantOf 之上长出：角色挂多个具名变装（各自参考图）、可新增变装、设定阶段缺件明确具名回报（不得静默用主造型顶替）；drama-recipe 套用路径真的取到变装参考 ｜ 证据: 51ca0474
- [创作域] 变装缺件 fail-closed 落到资料面 — disguises 为空时 prompt 一律清空（needsAsset/missingDisguiseNames 只是回报栏位，挡不住消费端）；命中变装但变装自己没写 prompt 才沿用卡本体片段；清洗去重键与 addCharacterDisguise 对齐（id 或 name，留最后一张）｜ 证据: 3d46f837
- [创作域] 两段式上传（直传凭证 → objectKey 入库） — VPS 走 image-data-api 短效 HMAC 签名（母钥只留伺服器端）、Vercel 走 handleUpload client token；第二段亲自取回位元组算 sha256 才入库；上限 512MB、内容型别白名单；端点 /api/uploads{,/sign,/commit} ｜ 证据: 1fdcafc0
- [创作域] 视频运镜预设 23 条 — 视频生成面板「运镜」行接 camera-motion-presets，后缀替换语义同风格 chip（可选「不指定」）｜ 证据: 3a483ee6
- [创作域] 剧本入口曝光（novel_film） — 正面卡补一行入口提示；示范 chip 第三条换成长文本改编口径（原「大电影」命中泛用 feature_film，等于把人往通用产线引）；纯 UI/文案、零判定逻辑改动 ｜ 证据: 1fdcafc0

## 帐号与增长

- [帐号与增长] 助理出的图可以分享（分享即邀请回路） — 图卡「分享」先以 agent-<taskId> 经既有 POST /api/history 幂等补写历史（顺带让助理作品出现在历史页）再开既有分享框；/api/share 未命中时等历史索引快取（3s）过期重读一次，免跨实例刚写入即 404 ｜ 证据: d9169959
- [帐号与增长] 公告横幅／弹窗两个投放面渲染 — AnnouncementSurfaces 由 Navbar 单例挂载，关闭即 dismiss/mark-read ｜ 证据: 3a483ee6

## 前端与UI

- [前端与UI] 工作站跨萤幕等比 — 以 1274×664 为设计基准按 min(宽比,高比) 放大根字级；面板／间隙／圆角／FAB／卡内字级改 rem，3D 透视跟卡宽等比 ｜ 证据: ee89d6c3
- [前端与UI] body 与助理面板 px→rem 等比缩放 — 字级／图标／输入框跟工作站根字级缩放（基准机零变化）｜ 证据: 620b6267
- [前端与UI] 工作站态解除导览列页壳 1440 上限 — >1440 视口面板／画布不再被夹成置中窄壳 ｜ 证据: fc314d43
- [前端与UI] 首页不再每次 hydration 失败重建 — 内联 <style> 注解不再含字面 <style>（SSR 转义不符）｜ 证据: ef4e8b19
- [前端与UI] 文档中心「找现成做法」三入口 — 场景指南／创作产线／技能目录三个此前对用户零可见入口（此前 /use-cases、/workflows 只在 hidden SEO 区块）｜ 证据: 14a99737

## 运维与观测

- [运维与观测] 网关 opencode SSE 30s 看门狗 — /event 30s 无位元组即 abort 重连（opencode 每 ~10s heartbeat），消除重启 opencode-server 后最长 5 分钟的 SSE 盲窗（VPS 实测重连 35s）｜ 证据: c7788ee8
- [运维与观测] npm healthz/smoke:image 改 curl（Arch Linux）｜ 证据: c7788ee8
- [运维与观测] 控面建置 context 白名单＋next build 快取挂载 — .dockerignore 改 allowlist（VPS context 383M→只剩建置所需）；builder 层 RUN --mount=type=cache 挂 .next/cache，改一行不再全量编译 ｜ 证据: c7788ee8
- [运维与观测] 控面代理清单单一真源＋DB 绑定 route 漂移棘轮 — CONTROL_PLANE_PROXY_SOURCES／controlPlaneRewrites(origin) 为唯一真源（rewrites() 输出逐字相等）；测试扫 src/app/api route.ts 递回 import 闭包，触及含 GENERATION_DATABASE_URL 的模组且未被代理者必须列 KNOWN_VERCEL_LOCAL 基线，过期条目亦红 ｜ 证据: 203a86ae
- [运维与观测] 补四条漏网代理 DB route — billing-operations 裸路径、biz-keys/provision、probe/stuck、probe/jobs/*（原本 Vercel 无库、登入后必 500）｜ 证据: 1c6e0e20
- [运维与观测] nginx 改 nginx -t＋reload（禁 restart）＋postcheck 加经 nginx 的对外 healthz — 事故：restart 遇上游容器已被移除 → [emerg] host not found → 全站入口重启回圈；容器内 healthz 当时仍 200，故补对外探测 ｜ 证据: a823d5f1
- [运维与观测] 控面部署脚本修正 — 本机无 hostname 改 uname -n；build 快取清理改 --keep-storage 2gb（until=72h 放过新快取，部署后磁碟触 98%）｜ 证据: 73f37beb

## 团队与企业

- [团队与企业] 资产团队维度 — asset-scope 加 owner:"team"＋teamId；鬼状态 fail-closed（不降格 personal）｜ 证据: 1fdcafc0
- [团队与企业] 团队／成员配额判定与存取 — fixed/daily 模式、UTC+8 日界（epoch offset 480 分）、回收上限、超卖保护；配额只写意图（team_settings／team_member_quota）不写五态帐本、不预扣 ｜ 证据: 1fdcafc0
- [团队与企业] 三级权限矩阵（主帐／管理员／成员） ｜ 证据: 1fdcafc0
- [团队与企业] GET/POST /v1/team/quota/limits 配额读写面 — GET 团队模式＋各成员模式与当日用量；POST scope=team/member 设配额；鉴权照同群组既有 /v1/team/quota，团队主帐＝呼叫方密钥的 user_id，成员密钥改配额 403 ｜ 证据: 1fdcafc0
- [团队与企业] /v1/team/members 回团队与成员配额区块 — 读不到映射层就省略该栏（不冒充）｜ 证据: 1fdcafc0

## 非程式码能力

- 控面一键部署脚本 deploy/vps/deploy-control-plane.sh — plan 唯读双向 diff 闸（VPS 将覆写档的 md5 不在 repo 该路径历史任一版 ⇒ BLOCKED）／deploy 版本化镜像＋postcheck 自动回滚／rollback；来源＝git HEAD（git archive 白名单，不部署 working tree）；本机无 rsync 时退 md5 清单比对＋tar（判准等价）｜ 9e5664be
- DB 迁移 032_supplier_adapter_type_open.sql — 供给 adapter_type 开放为任意协议字串（由 registry 执行期判定合法值）｜ 64b2bf91
- DB 迁移 033_team_quota_limits.sql — 团队／成员配额意图栏位 ｜ 1fdcafc0
- VPS 侧 image-data-api 新增 POST /api/blob/presign（短效 HMAC 签名直传）＋ nginx 上限，已完成端到端验证（签名直传→读回 sha256 相符）｜ 1fdcafc0
- VPS /opt/agent-harness/gateway/events-translate.ts 同步（报价不挂 cost_coins、自动制画布只给出图工具），各自留 .bak 备份 ｜ e5d954a7, c5115e19
- 控面 env 同步 ADMIN_SESSION_SECRET／ADMIN_USERNAME 进 .env.control-plane（统计代理的前置条件）｜ 6221c69d
- 控面 DB＋env 上线 gway 渠道（seed 不当未知渠道）；V-03 起在 channels.config 带入已核单价与来源日期 ｜ ed47cb58, 64b2bf91
- 控面 compose 模板同步 control-plane-compose.yml（补齐与 VPS 现役档的非 secret 差异并标明为模板）｜ c7788ee8
- Runbook 更新 docs/runbooks/infra-debugging.md — 网关 session 已 SQLite 持久化；opencode SSE 悬挂根因与 30s 看门狗（VPS 实测重连 35s，原 5 分钟）｜ a7d81d8d
- 双真相边界文件 docs/architecture/dual-truth-boundary.md（W5，纯文件） — world1（画布多步生产链）↔ world2（模板＋素材注入＋成片）；新事实：world2 自己有两份（VPS 活本 /opt/agent-harness/gateway/ 与 repo 镜像 deploy-staging/gateway/，2026-09-29 逐档 md5 全等但「一致」是当下状态不是契约）｜ 79e1f5a3
- AGENTS.md 规则：禁内联——任何动手环节一律派 subagent ｜ 1fdcafc0
- staging 镜像同步 staging/music-tools/{music_tools,music_prompt_director}.ts（e75a2e8e／b68c0fdd 的 staging 侧）｜ aa729665

## 边界与拒绝

- YuE2 输入硬截断：style 600 runes、ABC 500 token，截断标记 truncate-${limit}-hard（8GB 卡 NAR prefill 显存预算）｜ b68c0fdd
- 生成式后期闸门压在成本闸之后、任何 fetch 之前（fail-closed）；不支援的模型即拒，不静默降级成 generate ｜ 51ca0474
- 分镜候选第 5 条明确拒绝；缺 prompt 的候选/格列整条丢弃（不用假 prompt 花钱）｜ aa81b4b0
- 4K 超分 fail-closed：upscale_4k_upstream_unverified（上游 factor 语义未经真单校准），env UPSCALE_4K_UPSTREAM=1 于校准后开启；切 gpt-image-2 新后端亦同闸（直到真单量到长边 ≥3840px）｜ 329c4221, 0289ade9
- 不制造假档位：对手列 720P/1080P/2K/4K，上游 RATIO_SIZES 只有 1k／2k 两个键，720P 键不存在 ⇒ 只列 1K/2K/4K，不加静默回退成 1K 的假标签 ｜ 329c4221
- 超分具名拒收码：upscale_bridge_size_unsupported／upscale_tier_unsupported／upscale_factor_conflict／upscale_input_too_large／resolution_not_declared_by_model／upscale_backend_size_unavailable（不支援一律具名拒、不静默降级）｜ 329c4221, 0289ade9, 82ee2b9a
- 视频超分上游无通道 ⇒ 带 video 具名拒 upscale_video_upstream_unsupported ｜ 329c4221
- 超分后端切换（legacy PixAI bridge ↔ gpt-image-2 重绘）＝定价决策（0.001 币一口价 → 档位价），未经裁定不擅自切；默认 legacy ｜ 0289ade9
- 档位折算出的像素 size 落不进白名单即具名拒，不静默降级成较低档位（如 3:2 的 2k⇒3072x2048、16:9 的 1k⇒1792x1024）｜ 82ee2b9a
- 资产团队维度鬼状态 fail-closed（不降格 personal）｜ 1fdcafc0
- 配额只写意图上限与速率计数，不写本地余额、不呼叫上游额度调整、不预扣；「改回不限 ⇒ 剩余全数回收」只回报应回收额度（reclaim），实际点数移动须另走既有转移通路 ｜ 1fdcafc0
- 统计 CSV 缺值留空不填 0（「没有这个数字」≠「这笔量是 0」）；control-plane DB 未配置时照抄投影的 configured:false，不吐一排 0 ｜ c6ca3857
- 统计 CSV 组织维度（总／团队／子帐号／专案）缺席 ⇒ 一列都不伪造；byScope 留为延伸点 ｜ c6ca3857
- 用量类别：角色／场景／道具保留在值域但不指派（提交端完全没有落盘事实，节点类型与 episodeId 都不进请求）；未知／缺席 kind 一律 unclassified 不猜 ｜ 8d9e067f
- 语音库 Age 一律缺席（上游清单没有 Age 栏位 ⇒ 不编造）；接受集≠描述集，刻意不收 foo:bar 这种上游会拒→降级→静默变预设的形式 ｜ 215d2f07
- 上游缺陷钉成事实（未修，proxy 在 VPS）：shimmer → zh-CN-XiaoyouNeural 而 Microsoft 现行清单已无该音色 ⇒ 降级路径对 shimmer 会失败 ｜ 215d2f07
- 非解说剧却绑旁白音色 ⇒ narrationVoiceConflicts 具名回报该设定不生效（不静默忽略、也不代用户清掉）；effectiveNarrationVoice 未绑＝null（不假装绑了）｜ f2668377
- 非法值逐一栏位独立省略（同既有 meta 范式，不整包作废）；专案栏位型别宽 string 因载荷不可信 ｜ f2668377, 8dcdcd57
- 生成路由刻意不读专案：按未验证的 x-user-id 读他人专案＝跨租户读取，故以「专案持久化绑定＋呼叫端带 id」表达 ｜ 8dcdcd57
- 没套风格时 /api/canvas/generate 回应形状与旧版逐位一致（style_id／style_source 只在真套了才吐）｜ 8dcdcd57
- pixai-upscale 不进 /v1/models：image-model-ids 明文规定服务类定价条目不入 SUPPORTED_*，硬塞会制造空能力宣称并坏 openapi x_endpoint 枚举；由测试钉成事实（哪天进清单该测试会红）｜ a9b33109, 329c4221
- maxReferenceImages 只在 referenceImages === true 时给（否则就是空能力宣称）｜ a9b33109
- 报价类工具 tool.result 不再挂 cost_coins（报价 ≠ 已用/消耗）；失败工具与估价不计入「已用 N 币」｜ e5d954a7, 5d4e202b
- 自动制画布只给出图工具（image_quote／get_result／upload 不铺永远待处理的空节点）｜ c5115e19
- 无 GENERATION_DATABASE_URL 的实例（Vercel 站点副本的 /api/pixai/*）没有帐本可写 ⇒ 门面退回直接经 billing adapter 扣退款并如实标 ledger=false（既有行为保留，不是帐本化）｜ 64b2bf91
- 供给 registry 载入期验证：protocol 不得为空且全域唯一、channel.adapterType 须等于 adapter.protocol、reconcileVia 必须是「可轮询」的已注册协议，违反即载入抛错 ｜ 64b2bf91
- Next route 模组只准汇出 handler（__setAssetsTeamGateDepsForTests 这类测试 setter 必须移出 route 档，否则生产 build 失败）；route 档内不得让 useVpsBlobBackend 被 rules-of-hooks 误判 ｜ 0e7b3745, 159259a7
- 尺寸别名改走 hasOwnProperty 查表（原型键不会再被当别名读出函式）｜ 36fcbab5
- Vercel 生产 env 无 GENERATION_DATABASE_URL（7 个键）⇒ 触及该库的 route 没被代理就是登入后必 500，棘轮会逼删过期基线条目 ｜ 1c6e0e20, 203a86ae
- 文件与执行端漂移锁：/v1/upscale 档位列举＝执行端档位全集、size 列举＝bridge 比例表实际有的键、size.default 不得假；generations size 枚举从执行端常数派生（改歪就红）｜ de4f5df9, b32c4818
- 控面无 ADMIN_SESSION_SECRET／ADMIN_USERNAME 时，统计代理过去也只是 401（前置条件写进注解）｜ 6221c69d
- 影片抽帧到顶明确拒绝、不静默截断（600 帧／600 秒；讯息给提高 step 或改伺服器端抽帧的出路）；mode:"at" 清单须严格递增且全 < 片长；序列帧数须 ≥2（单帧用 mode:"current"）｜ 1fdcafc0
- 非绑定式变装缺件无法归属到哪张卡，但作者宣告了变装就不该有人以主造型出图 ⇒ 本镜所有角色卡一起去造型；场景／道具卡不受影响 ｜ 3d46f837
- 模板旋转木马必须保留原交互机件（wheel {passive:false}／SPRING_TRACK／drive()）——禁精简复制（2026-08-25 三轮返工教训）｜ c859432b

## 存疑

- aa729665：staging 侧镜像同步（staging/music-tools/music_tools.ts）——讯息仅称「e75a2e8e 的 staging 侧」，无新能力；是否有 staging 独有差异需逐行 diff staging 与 src 才能断定 ｜ 缺：staging 执行环境与 diff 证据
- 1fdcafc0：「站内 /api/uploads 尚未部署」为 commit 自陈；两段式上传目前只在 VPS 侧（presign 端点）端到端验证 ｜ 缺：站内部署与站内端到端证据
- 1fdcafc0：P1-1（白模当生成参考）与其 11 条测试因与在飞的 canvas/types.ts 同档而暂不提交；下一颗 aa81b4b0 是否即为其落地需比对（两颗都写 P1-1，内容一致）｜ 缺：commit 父链外的在飞档状态
- aa81b4b0：抽卡面板／集侧栏／批次按钮等 React 接线未做；episodeId 的写入端（谁在分镜产生时盖集指针）未做（commit 自陈）⇒ 「按集换模型」目前缺前端入口 ｜ 缺：前端接线证据
- 51ca0474：三条已知未收口（①字串式宣告缺件时任务 referenceImages 仍含主造型参考、闸只在 needsAsset；②绑定式缺件时 prompt 仍沿用卡本体片段；③清单清洗只按 id 去重、新增路径才按名字覆盖 ⇒ 解析取决于清单序），测试以「现况记录」钉住待裁决 ｜ 缺：裁定与收紧后测试
- 51ca0474：生成式后期的真单未验（上游生成请求需暴君逐次报备，本轮零付费呼叫）⇒ 「Seedance-2.5 族可续片/改片」仅契约与行为测试层已证 ｜ 缺：付费真单证据
- 329c4221 / 0289ade9：PixAI 是否接受 upscale=4、输出是否等于「基底 × factor」未经真单校准；gpt-image-2 的 4K 输出色校准亦未完成（控面唯读取证只到能力闸 present）｜ 缺：真单色校准证据
- ed47cb58：gway「控面 DB＋env 已上线」无法从 repo 验证（本 repo 只有 config 与 seed）｜ 缺：控面 supplier 表证据
- 64b2bf91：三平面违规项（V-01～V-09）进度表在 docs/architecture/planes-violations.md，未逐条核是否全清（V-05 渠道选择由 new-api Distribute 承担，本档自陈「另案」）｜ 缺：违规表逐条核对
- c859432b：讯息未说明「海报浮水印卡片」的水印是否可关／是否影响产线；未查到相关测试语义 ｜ 缺：水印行为的验收口径
## 逐条对帐

| hash | 该 commit 贡献的能力（或「纯修复／纯重构／无新能力」） |
|---|---|
| e75a2e8e | 音乐三路全链回落（YuE2→FlowMusic→Lyria）＋欠费无替补即时失败并退款 |
| b68c0fdd | 边界语义：YuE2 style 上限 600 runes／ABC 500 token，截断标记 truncate-${limit}-hard |
| aa729665 | 无新能力（staging 镜像同步 e75a2e8e 的 music_tools） |
| ed47cb58 | 极途 Gway 备用视频渠道（priority 2），控面 DB＋env 上线、seed 不当未知渠道 |
| c7788ee8 | 网关 opencode SSE 30s 看门狗；npm healthz/smoke 改 curl；控面建置 context 白名单＋build 快取；compose 模板同步 |
| a7d81d8d | 无新能力（runbook 文档：session SQLite 持久化、SSE 悬挂根因与看门狗） |
| 203a86ae | 控面代理清单单一真源＋DB 绑定 route 漂移棘轮（KNOWN_VERCEL_LOCAL 基线） |
| 9e5664be | 非程式码：控面一键部署脚本（plan 双向 diff 闸／deploy 版本化＋postcheck 回滚／rollback） |
| 73f37beb | 纯修复：部署脚本 uname -n、build 快取 --keep-storage 2gb（防磁碟 98%） |
| 1c6e0e20 | 补四条漏网代理 DB route（billing-operations 裸路径、biz-keys/provision、probe/stuck、probe/jobs/*）；边界：未代理＝登入后必 500 |
| a823d5f1 | nginx -t＋reload 禁 restart＋postcheck 对外 healthz；边界：容器内 healthz 200 ≠ 对外可用 |
| 64b2bf91 | 供给 adapter registry；成本闸按供给核价；同步直通路由计费入帐本（sync-charge）；同步 job 状态机；取消＋条件退款门面；canvas 生成走 durable；Web 负面词/参考图角色不再丢失；模型别名读资料；migration 032 |
| 3a483ee6 | 六个用户面入口：OpenAI 兼容 base 曝光、Blender 插件下载、公告横幅/弹窗、节点恢复上一版、一稿多版位、视频运镜预设 23 条 |
| 74fb5728 | 站内可达 Remote MCP 安装页 /mcp（此前零连结） |
| 905bcccf | 斜线技能选单底部「浏览全部技能」→ /skills |
| 1fdcafc0 | 资产团队维度＋三级 RBAC＋团队/成员配额＋/v1/team/quota/limits＋migration 033；剧本入口曝光（novel_film）；两段式上传（/api/uploads{,/sign,/commit}，VPS presign）；影片截帧容量放开＋at 模式；W7 影片取证工具登记＋知识还工具；AGENTS.md 禁内联 |
| aa81b4b0 | 3D 白模当生成参考＋回分镜溯源两键；分镜候选集/星标/prompt 回溯/增删复制重排；按集批次换模型与批次重跑（episodeId） |
| d9169959 | 助理出的图可分享（agent-<taskId> 幂等补写历史再开分享框；/api/share 快取过期重读） |
| 159259a7 | 纯修复：two-phase-upload 的 useVpsBlobBackend 补 rules-of-hooks 豁免（1fdcafc0 起 build 失败） |
| 0e7b3745 | 纯重构／修复：/api/assets 团队闸移出 route 模组（Next 不准 route 汇出测试 setter） |
| ef4e8b19 | 纯修复：内联 style 注解含字面 <style> 致首页每次 hydration 失败重建 |
| 14a99737 | 文档中心「找现成做法」三入口（场景指南／创作产线／技能目录） |
| 51ca0474 | 生成式后期（续片 extend_video／改片 edit_video，仅 Seedance-2.5 族）；任务版本／Tags／选中；变装子资产＋缺件具名回报 |
| fc314d43 | 工作站态解除导览列 1440 上限（>1440 不再夹成窄壳） |
| bd5405f5 | 「已思考 N 秒」在 tool.invoke 当下结算（不再等整轮 settleItems） |
| 5d4e202b | 「已用 N 币」不再把报价估价与失败工具算成花费（前端侧） |
| e5d954a7 | 报价类工具 tool.result 不挂 cost_coins（网关侧，已同步 VPS） |
| c5115e19 | 自动制画布只给出图工具，image_quote/get_result/upload 不铺空节点（已同步 VPS） |
| ee89d6c3 | 工作站跨萤幕等比（1274×664 基准、min(宽比,高比) 放大根字级、多项改 rem、3D 透视等比） |
| 620b6267 | body 与助理面板字级／图标／输入框 px→rem 跟根字级缩放（基准机零变化） |
| 3d46f837 | 变装缺件 fail-closed 落到资料面（参考图与 prompt 双清、drama-recipe 全角色卡去造型、去重键与 add 对齐） |
| 329c4221 | 一键超分档位契约＋4K 档位（(size,factor) 对）；具名拒收码；servableUpscaleTiers 只外露可服务档位；C/B 端路由统一；4K fail-closed；视频超分具名拒 |
| 79e1f5a3 | 无新能力（W5 纯文件：双真相边界；新事实＝world2 有 VPS 活本与 repo 镜像两份） |
| 8dcdcd57 | 专案级风格一等 id（id 进全文出、未知 400 style_id_unknown、不读专案避免跨租户读取、汇出汇入带走） |
| a9b33109 | /v1/models 升级成能力契约（maxBatchCount／maxReferenceImages＋openapi 补 5 栏）；request-limits 数量上限单一真源；边界：pixai-upscale 不进清单 |
| c6ca3857 | GET /api/admin/statistics?format=csv 统计/用量 CSV 导出（BOM＋CRLF＋RFC4180、缺值留空、不伪造组织维度） |
| c859432b | 模板卡片旋转木马重构（沿用 wheel/spring/drive，提交键跑选定步骤、海报浮水印卡片） |
| 215d2f07 | GET /v1/tts/voices 结构化语音库＋POST /v1/tts/generations 未知音色 400 voice_unknown；Age 诚实缺席；接受集≠描述集 |
| 8d9e067f | 用量按生成物类别切分（shot_video／still_image／unclassified）＋CSV asset_kind section；角色/场景/道具保留不指派 |
| f2668377 | 专案级剧本型别（接 AID enum）＋旁白音色（走语音库同一把尺）；非解说剧绑音色具名回报 |
| de4f5df9 | /v1/upscale 对外文件对齐档位契约（upscale_tier enum、factor 语义、size 去假 default、三闸码）＋漂移锁测试 |
| 6221c69d | 后台统计 /api/admin/statistics 代理到控面（生产看板取真数字）；前置条件 ADMIN_SESSION_SECRET/USERNAME |
| 0289ade9 | 4K 提交端打开＋严格解析（resolution_not_declared_by_model）；计费改吃档位；/v1/upscale 后端二 gpt-image-2 生成式重绘；默认仍 legacy（定价决策不擅自切） |
| 94c48e3e | 纯重构：超分后端规划搬到 lib（route 档只准汇出 handler）；边界：next build 型别闸 |
| 82ee2b9a | 档位靠像素 size 承载（推翻 resolution 假设）；durable-image-sizes 尺寸白名单单一真源；折算落不进白名单具名拒 upscale_backend_size_unavailable |
| b32c4818 | generations size 枚举从执行端常数派生并补 4096x4096、揭露 resolution 档位键；漂移锁扩到生成端 schema |
| 36fcbab5 | 纯修复：尺寸别名改走 hasOwnProperty 查表（原型键不再被当别名读出函式） |
