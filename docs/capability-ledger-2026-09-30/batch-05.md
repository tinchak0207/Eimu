# image-app 第 5 批（47 commit）能力穷举清单

- 来源：`/tmp/cap/batch-5.txt`（47 条）、`/tmp/cap/batch-5.hashes`、repo `/home/lenovo/Desktop/image-app`
- 日期范围：2026-09-25 ～ 2026-09-27
- 能力判定：**使用者可见或可呼叫的行为**，非档名；档名只在必要时作证据补充。
- 已逐条处理 47 个 hash，无跳过；逐条对帐在文末。

---

## 生成核心

- [生成核心] 生成时实体卡就地解析注入 — 生成唯一出口（手动面板／A4 原地／retry／runAgentGeneration）与 drama-recipe 的 LoRA 回圈会用与 entity-tokens 同一把尺解析 prompt 中的 `@[种类:名称]`，在卡库全量找相符卡并与既有锁定集取联集；零 token／全未命中回同一阵列参考（零漂移），不自动锁卡 ｜ 证据: 7f9dbe4e
- [生成核心] 音频实体卡送上游前展开 — TTS（闸道 media-internal-routes handleTts）与 music_gen（VPS）送上游前展开音频卡参考、`reference_images` 一律空；`target=audio` 缺省不变为 image ｜ 证据: 7f9dbe4e

## 模型与供应商

- （本批无新增能力。既有模型目录 57（影像 29）等变动只出现在文档 commit 4b6afad5，属前批，不重复列。）

## 控制平面与计费

- [控制平面与计费] 自订档支付按下单档价（`custom:<coins>`）— 滑杆自订档点「立即支付」不再退回梦芽 ¥9.9 下单；`handlePay` 传 `customPlan.id`，`/api/payments/mapay/return` 同步改用 `resolvePricingPlan`（与 notify 同源），回调才解析得了自订档金额 ｜ 证据: fc85156b
- [控制平面与计费] 新-api 管理面改走 TLS — 站点对 new-api 的兑换码／订阅兑换／认证动作改走 `https://store.tinchak0207.xyz/newapi` 的 TLS vhost（bare-IP 明文 `/api` 已被 default_server 444 关闭）；fallback 常数与测试断言同步，未设 `GATEWAY_BASE_URL` 不会静默回死掉的明文路径 ｜ 证据: 432ae6c8

## B端API

- [B端API] 实体卡解析端点 `/api/biz/character-resolve` — 可选 `target(image|audio)`（缺省 image＝零漂移）；回带 warnings（畸形 token），audio 走 `applyCharacterCards({target:"audio"})` 且 reference_images 空 ｜ 证据: 7f9dbe4e
- [B端API] 技能 API `/api/skills`、`/api/skills/[id]` — 列表／搜寻／facet 与单条查询；公开面永不包含 user 来源 ｜ 证据: 513462a5
- [B端API] 私有自订技能 CRUD `/api/skills/mine`（GET/POST）＋ `/api/skills/mine/[id]`（DELETE）— 身分复用 `resolveAgentCaller`＋`deriveMemoryOwnerKey`；未登入 401、非本人 404 不泄漏存在性 ｜ 证据: 513462a5
- [B端API] Remote MCP server `POST /api/mcp` — JSON-RPC 2.0 / Streamable HTTP，支援 initialize、tools/list、tools/call、ping，notifications/* 回 202，GET 405 + Allow: POST ｜ 证据: 017cbc0b
- [B端API] MCP 10 个工具 — `list_skills`／`get_skill`／`list_models`／`generate_image`／`edit_image`／`generate_video`／`tts`／`upscale`／`get_quota`／`get_result`；鉴权逐字复用 `readBearerToken`＋`authenticateBizApiKey`，Authorization 原样透传既有 `/api/v1/*`，扣费／配额／幂等继承同一帐本（零第二套计费）｜ 证据: 017cbc0b
- [B端API] MCP 发现面 `/.well-known/oauth-protected-resource` — 7 个自写 scope；401 带 RFC 9728 `resource_metadata` 指向站根发现文件 ｜ 证据: 017cbc0b
- [B端API] agent 插件包 `public/plugin/` — Codex 插件形态（marketplace.json、`.codex-plugin/plugin.json`、`.mcp.json` 只含 URL 不含密钥）＋ 3 个随包技能（film-production／character-consistency／camera-motion）＋ `/plugin/` 目录入口 ｜ 证据: b49c7401

## Agent助理

- [Agent助理] 闸道节点生成认得实体 tag — workflow-gw 节点提交处展开最终 prompt 并把卡参考图并进 `reference_images`（去重截 5），既有单张 reference 逐字保留；key 用呼叫端传入的使用者 key，快取键含 apiKey 且守卫在查快取之前（防跨租户共用卡参考图）｜ 证据: 7f9dbe4e
- [Agent助理] 133 条内建 Skill 条目层（10 家族）— 电影美学 40／商业广告 27／短剧 20／特效动画 12／剧本 8／分镜 8／选角 5／UGC 5／MV 4／旅拍 4；公开列举＝builtin+recipe+template＝151，私有列举以 ownerKey 隔离 ｜ 证据: 513462a5
- [Agent助理] 对话框斜线直呼 Skill — 输入框打 `/` 出 SkillSlashMenu（debounce 160ms＋双路 AbortController＋「我的技能」分区），选中写回输入框不自动送出 ｜ 证据: 513462a5
- [Agent助理] 私有技能管理面 — 设置弹层内 MySkillsDialog 管理自订技能（交付形态标签收敛到 `src/lib/agent-skills/output-kinds.ts` 单真源）｜ 证据: 513462a5, 2d5dbeac
- [Agent助理] 思维链结算后收合 — 串流中展开、结算后自动收合成「已思考 · N 秒」一行；使用者手动点过 summary 后自动收合不再介入（reasoningTouched ref）｜ 证据: 92a2a698
- [Agent助理] 顶栏精简为直接入口 — 常态状态文字回空串（第二行消失），资产／历史从 ⋯ 选单提出直接站在标题右侧，⋯ 选单退役换齿轮触发 `openSettings()`；reconnecting／closed／connecting 三个异常态文字保持唯一出口 ｜ 证据: 397571a2
- [Agent助理] 顶栏改纯图示列（零文字）— 拆掉「AI 助理」h2 与星芒图标，五颗入口（资产／历史／新会话／直接生成／设置）图示即 logo；连线异常态文字不再由顶栏承担（下沉对话区）｜ 证据: c5f89542
- [Agent助理] 使用者自己的话进入聊天记录（injection echo）— `agentInjection` 新增 `echo` 栏位（默认 false＝模板注入 silent 行为逐字不变）；`echo:true` 时送出瞬间乐观插入使用者气泡，填掉建号到 TTFT 的空白 ｜ 证据: 10403d5a

## 画布与工作流

- [画布与工作流] 节点版本历史 — 纯函式版本层：逐节点上限 20／专案 400，座标与尺寸刻意不进版本；node.created/updated 依 `isNodeContentChange` 自动落版；GET `/api/canvas/nodes/[id]/history`、POST `/api/canvas/nodes/[id]/revert` ｜ 证据: 64aff900
- [画布与工作流] 节点软删与恢复 — `delete_nodes` 改软删（收进 deletedNodes，呼叫端语义不变）；POST `/api/canvas/nodes/[id]/restore`、POST `/api/canvas/nodes/restore`（批量）｜ 证据: 64aff900
- [画布与工作流] 一稿多版位裁切计划 — `planFormatCrops(sourceW,sourceH,AD_SIZE_OPTIONS)` 逐版位回 `{mode:"crop"|"outpaint"|"rejected", cropRect, outpaintEdges, lossRatio, output 尺寸}`，`MAX_CROP_LOSS=0.25`；版位比例取 id 像素而非 label 近似 ｜ 证据: 13f26615
- [画布与工作流] 一稿多版位真裁执行 — POST `/api/canvas/format-crops`（requireVerifiedUser）只给尺寸＝纯 plan 零 IO；`execute:true` 走 sharp 真裁（`readSourceImageInfo` 含 EXIF 5~8 轴互换）；零 DOM／Image／fetch 可在 node 直测 ｜ 证据: 13f26615
- [画布与工作流] 视频截帧／序列帧节点动作 — POST `/api/canvas/video-frames`（requireVerifiedUser）回抽帧计划 `frames:[{index,timeSec,label}]`＋`execution:"client"`，像素由客户端 `extractFramesAtTimes` 落成画布图；`planFrameExtraction` 纯时间点计算、`MAX_SEQUENCE_FRAMES=24` ｜ 证据: 272fac86
- [画布与工作流] 画布缩略图预设收合与缩放胶囊控制 — `CanvasEmbed minimapOpen` 预设收合，入口收进 `CanvasZoomControls`（minimap/review 切换），`CanvasMiniMap` 加 onClose ｜ 证据: 92a2a698
- [画布与工作流] 节点 metadata 键集合单一真源 — `node-metadata-fields.ts` 集中两个清洗入口（`layout.ts` toNodeMetadata 耐久化端／`canvas-chat-types.ts` compactMetadataForAgent 上行端）的键集合与理由，避免漏键静默消失（emitsEntity 实锤）｜ 证据: e4c16950

## 创作域

- [创作域] 行内 `@[种类:名称]` 实体卡引用 — 五值实体（角色／场景／风格／道具／音频）可在 prompt 行内引用；卡在库即可用，不要求人手动锁定 ｜ 证据: 7f9dbe4e
- [创作域] 模板自动落卡 — 13 条产线模板中 11 条（feature_film／novel_ip／ecom_model／ecom_launch／art_style／art_curation／shortdrama_poster 等，15 处）标记 `emitsEntity`，「交付物就是一个实体」时自动落卡 ｜ 证据: 7f9dbe4e
- [创作域] 音频实体卡可被引用 — 音频卡从型别层变成可引用（TTS／music_gen 展开）｜ 证据: 7f9dbe4e
- [创作域] 未命中实体胶囊红色提示 — 未命中 token 的红色底（`bg-ios-red/[0.12]`）不再被 Tailwind opacity scale 静默编成空规则 ｜ 证据: 6452273a
- [创作域] 实体卡持久化 store — `character-card-store` 每用户 index＋新世代写入＋串行 write queue＋无 Blob 记忆体降级 ｜ 证据: e4c16950
- [创作域] 运镜预设库与 harness 工具绑定 — 23 条互斥运镜预设（唯一 key＋简体短标签＋可执行运镜指令＋建议 harness toolId＋检索 tags），公开只读 API；最终组装一律走既有 `describeCameraTrajectory()`，不自造第二套翻译 ｜ 证据: 017cbc0b

## 帐号与增长

- [帐号与增长] 未登入新访客进站播一次宣传片 — 每浏览器一次（localStorage `eimu-promo-seen-v1`）；判定链抽成纯函式 `promo-gate.ts`（登入态水合中不播、已登入永不播、看过不播、深链交接 `?agent=1&q=`／`?session=` 让路）｜ 证据: 786f366c
- [帐号与增长] 宣传片播放政策 — 本体恒 muted autoplay，声音由右下角按钮由人开启；自动播放整条被挡退成海报＋播放钮；底部是真实播放进度条 ｜ 证据: 786f366c
- [帐号与增长] `?promo=1` 强制预览 — 穿过全部守卫（含登入态）但不写入「已看过」，不消耗首次进站体验 ｜ 证据: aa752efe
- [帐号与增长] 渠道来访不播宣传片 — 自家投放链接渠道参数（utm_source/from/ref 含 bilibili/b23/weixin/wechat）、来源域名（bilibili.com／b23.tv／weixin.qq.com／wechat.com 含子网域）、MicroMessenger UA 任一命中即跳过一次且不写已看过 ｜ 证据: 639bd737
- [帐号与增长] 宣传片收尾＝封面画布＋真可打字输入框 — 输入框座标逐字取自封面渲染源，Enter／圆钮送出即开新对话直送产线（走既有 lazy 建号＋`agentTemplateInjection`）；未登入先存 pending（sessionStorage），登入态翻真自动补送 ｜ 证据: a940cb7a
- [帐号与增长] 宣传片结尾「先登入再开跑」— 未登入送出当场弹登入；`resolvePromoTrialIntent` 分流（登入＝当场开跑／未登入＝留 pending 走登入）；GitHub 同窗口跳 `/api/auth/github/start`、微信走既有 `/wechat-login` 弹窗＋postMessage／token 轮询双完成信号；选「先不登入」并离开＝清 pending ｜ 证据: 510eb1c3
- [帐号与增长] 进站判定只做一次 — `resolvePromoEntry` 水合中不判也不记、定案后沿用首次结果；登出（登入态真翻假）不得再把 `?promo=1` 的强制预览重播或补播 ｜ 证据: d5ba65f8
- [帐号与增长] OAuth 建号改走上游管理员建号 API — GitHub／Google／微信三条 OAuth 建号全部改走 gateway-admin `ensureGatewayUserForOAuth`（先查后建、已存在按复用吸收，管理员 POST `/api/user/`），为上游关闭自助注册（RegisterEnabled）做准备，对外行为不变 ｜ 证据: 1129196a

## 前端与UI

- [前端与UI] /pricing 方案卡 3D 化 — 四档（梦芽／梦影／梦虹／自订）各一 3D 世界，堆高与厚度是额度量级函数；互动四件：拖曳拨动（惯性／摩擦）、hover 拾起、自订档滑杆即时增减（先伸缩、落定才落）、点击回馈，声音随互动而生 ｜ 证据: 853244be
- [前端与UI] 3D 方案卡的渐进增强与降级 — 首屏仍为静态卡面 DOM、idle 后才动态 import 引擎；离屏／分页隐藏停 rAF；`saveData`／`deviceMemory ≤ 2` 不接管；`prefers-reduced-motion` 走静止构图；进 /pricing 零等待无 loading 遮罩 ｜ 证据: 853244be
- [前端与UI] 3D 卡堆主角模式 — 一张卡当主角、其余淡出缩成底部选片条；四个世界硬剪接；卡面只留价格与支付 CTA，额度文字下架 ｜ 证据: 853244be
- [前端与UI] 3D 渲染精度与版面收敛 — pixelRatio 加超取样地板（桌面 1.75／上限 2）、图集每格 512→640（compact 256→320）、anisotropy 解开自阉 8 上限、fps 降级不再把解析度砍回 1；卡堆左移与票面右移不再重叠（min() 夹住不越出视口）；渐变文字降饱和（`--p3d-pink-soft`／`--p3d-blue-soft`）｜ 证据: 35e678c0, fc85156b
- [前端与UI] 站点对外介绍单一真源 `site-copy.ts` — layout metadata（OG／Twitter／JSON-LD）、首页 tab 标题、PWA manifest 全改读它；标题为「一句话到成片的 AI 影像工作台」，模型名降到 keywords 与描述尾段 ｜ 证据: 585f27b7
- [前端与UI] OG 分享预览卡换成真宣传片封面 — `src/app/opengraph-image` 由模板残留的「AI SDK Image Generator」示范资产换成宣传片 A 版封面（1200x630，138KB JPEG）｜ 证据: bc018562
- [前端与UI] AI 检索面全面翻新 — `public/llms.txt` 产品优先改写（H1=Eimu、硬事实节、「不是」节、主要页面清单，B 端 API 段逐字保留）；FAQ 前置四题产品题；sitemap 补 docs 六子页与 /status；robots 明确放行九个 AI 检索／回答引擎爬虫 ｜ 证据: e7917b3b
- [前端与UI] 全站 canonical 各自自指 — canonical 从 root layout 移除，改成 10 个公开页各自自指（/pricing、/status、/docs 与六个 docs 子页不再宣告自己是首页副本）｜ 证据: d58eba66
- [前端与UI] 17 个行业枢纽页 + 301 合并 — 新增 `src/lib/use-case-categories/` 17 档（每档 6 子场景、2–3 条可复制提示词、翻车点、行业 FAQ、checklist，4700–6300 汉字）；旧 102 个 `/use-cases/<行业>-<n>` 门页以 20 条 301 转枢纽页 ｜ 证据: dc16ff3d
- [前端与UI] `/use-cases` 总索引页 — 17 张行业卡＋按 categorySlug 分组的深度指南＋8 张产线卡（修掉线上 404）｜ 证据: dc16ff3d
- [前端与UI] 8 条产线落地页 `/workflows`、`/workflows/[slug]` — 依 agent-templates 卡面与 payload 真源，输出 CollectionPage／HowTo／BreadcrumbList／FAQPage／VideoObject ｜ 证据: dc16ff3d
- [前端与UI] 技术 SEO 收口 — layout title template `%s | Eimu`＋`@graph` JSON-LD（Organization／WebSite／SoftwareApplication）；sitemap 改吃真实资料源（62 条）；robots 封私有路由放行 AI 爬虫；history/settings noindex；IndexNow 金钥档 ｜ 证据: dc16ff3d
- [前端与UI] 技能库公开只读浏览面 — `/skills`（家族筛选纯连结 `?family=`，零 client JS）＋ `/skills/[id]`（generateStaticParams 全量静态，只呈现 spec 真有的栏位，未知 id 走 notFound）｜ 证据: eca25f27
- [前端与UI] `/mcp` 安装页与插件包节 — Codex／Claude Code／Cursor／OpenClaw／通用安装指令（只展示占位 key），插件包文件树＋安装指令 ｜ 证据: 017cbc0b, b49c7401
- [前端与UI] 站内通知铃铛与公告 — Navbar 铃铛＋红点＋下拉＋标记已读（portal 落点照 WalletBadge）；公告对话框；`AnnouncementSurfaces` ｜ 证据: ee89433b
- [前端与UI] 站内通知／公告／横幅 API — GET `/api/notifications`（列表＋未读数）、POST `/notifications/mark-read`、GET `/notifications/announcements/[id]`、GET `/notifications/banners`、GET `/notifications/active-modal`、POST `/notifications/banners/[id]/dismiss`；管理端 POST/GET/PATCH `/api/admin/announcements`（requireAdminSession）｜ 证据: ee89433b
- [前端与UI] navbar 余额「+」浮层 portal 到 body — 不再被 `.lg-bar` 的 overflow-hidden 与 backdrop-filter 裁掉；fixed 自算座标（「+」钮与 .lg-bar 下缘较低者+8px）、层级 z-90、收起层 z-89；点外收起层为完整视口 ｜ 证据: ccf5af5d
- [前端与UI] 宣传片结尾封面入镜与输入框对位 — 结尾输入框四周出血 6px 盖死封面画上去的框（几何逐像素对位）；封面横式 contain 完整入镜（不裁品牌标／成片标签）、直式 250vw 以框为中心 ｜ 证据: 1ad87154, 6844f223
- [前端与UI] 宣传片未登入登入框改锚定小框 — 送出钮先转圈 0.2s，再在钮正上方长出小框（不遮结尾画面）；点封面空白处／Esc／先不登录皆可收；Esc 一层一层退 ｜ 证据: a2b8d79b
- [前端与UI] 封面移除「成片·片名」胶囊 — 重渲染 1920×1080 封面（tag 条带逐像素对帐）＋ og 分享图同修；`cover.html` 源头元素与样式一并删除 ｜ 证据: 16b2751c
- [前端与UI] 滚动条与展开钮收敛 — 滚动条 8px→6px 且悬停才显示；「展开」钮改用 aria-pressed/aria-expanded 态著色不再常驻蓝字；NodeBody／CanvasEmbedOverlays 节点工具列整理 ｜ 证据: 92a2a698

## 运维与观测

- [运维与观测] `/api/version` 生产版本可查证端点 — 回部署 commit、建置时间、后端生效布林；force-dynamic + no-store（禁 CDN 快取假证据）；只输出后端名称与布林，永不输出 secret／凭证／token 值 ｜ 证据: e4c16950
- [运维与观测] GitHub Actions CI — push/PR 触发 `tsc --noEmit` 与单元测试；刻意不部署（Vercel 部署属人工授权）、不本地 build ｜ 证据: e4c16950
- [运维与观测] Blob 后端可切换 VPS — `blob-backend` 依 env 在 VPS image-data-api 与 Vercel Blob 间单点切换；生产须显式设 `BLOB_ALLOW_MEMORY_FALLBACK=true` 才允许记忆体降级 ｜ 证据: e4c16950
- [运维与观测] 生成品质门日志 — 每用户上限 500 条滚动 gate log，走 Blob 世代储存（新路径写入＋修剪旧世代＋per-user 串行＋无 Blob 记忆体降级）｜ 证据: e4c16950
- [运维与观测] 伺服器端历史持久化 store — `server-history-store`（Blob 世代、分页／facet／stats／排序／上限与 schema 版本）｜ 证据: e4c16950
- [运维与观测] 认证与私密内容守门 — `scanSensitiveContent`（sk-*／Bearer／AKIA／私钥／JWT／手机号／`secret=` 赋值）接进 `validateUserSkill`，reason 只回种类代码，原文永不进回应或 log ｜ 证据: 513462a5
- [运维与观测] 通知的跨用户隔离 — A 标记已读后 B 未读数不变、冒领他人 x-user-id 回 401、时间窗外公告不进生效清单、A 关掉的横幅 B 仍生效 ｜ 证据: ee89433b

## 团队与企业

- [团队与企业] 团队资产空间作用域持久化（REQ-B2）— `asset-scope-store` 只存两种连结记录（显式分享授权／项目挂用），不存资产本体；走 OS 既有 Blob 世代模式（每用户 index＋新路径写入＋修剪旧世代＋串行 write queue＋无 Blob 记忆体降级）｜ 证据: e4c16950

---

## 非程式码能力

- VPS／部署：`.vercelignore` 排除 200MB 影片产物（promo-video/out、artifacts 等）与 `promo-video/fonts/`（23MB 本机渲染输入）｜ 证据: 0651e7cd, 36ba61a2, e4c16950
- VPS／部署：`.gitignore` 把 200MB 级影片产物（artifacts／promo-video/out）排除，让工作区回到可辨识状态 ｜ 证据: e4c16950
- VPS／部署：`deploy/vps/gateway-release.sh` 收进版控 ｜ 证据: e4c16950
- 外部服务：new-api 管理面改走 TLS vhost `store.tinchak0207.xyz/newapi` 前缀（bare-IP 明文已 444 关闭）｜ 证据: 432ae6c8
- 外部服务：上游 new-api 自助注册端点 `/api/user/register` 可由 RegisterEnabled 关闭；站点 OAuth 建号改走管理员 API 即为此准备 ｜ 证据: 1129196a
- 运营流程：宣传片渲染链（`promo-video/`：audio.py、render.mjs、index.html、film.js、lib/shaders|ui|util、assets 26 素材）与三版封面（cover.html／cover-b／cover-c）；字型为本机渲染输入不入库 ｜ 证据: 36ba61a2
- 运营流程：站点展示资产进版控 — `public/showcase/cards`（768×1024 展示卡＝3D 卡堆贴图来源）、`cards-thumb`、`mascot` ｜ 证据: e4c16950
- 运营流程：README 首屏宣传片展示（加片→双片并排→换新片只留一条全宽）｜ 证据: 8897511b, 64d404b1, 696cec9a, 6eb5e08d
- 运营流程：宣传片片源换 1080p 分享版（1920x1080／30fps／6.76Mbps／43.2MB，faststart moov 在 mdat 前），海报重抽；代价＝未登入访客多下 33MB ｜ 证据: 47c80991
- 运营流程：投放素材链接带渠道参数（promo-video/out/bilibili.md、wechat.md）｜ 证据: 639bd737
- 运营流程：通知机制**不交付**运营配套（无 seed／cron，不 create 即永远空清单，落地后系统行为与交付前等价）｜ 证据: ee89433b
- 运营流程：SEO 交付面 — 20 条 301、sitemap 62 条真源、IndexNow 金钥档、robots 放行九个 AI 爬虫、llms.txt 页面清单 ｜ 证据: dc16ff3d, e7917b3b, d58eba66
- 运营流程：技能库与 MCP 的页面清单同步进 sitemap 与 llms.txt ｜ 证据: eca25f27, 017cbc0b, b49c7401

## 边界与拒绝

- 闸道实体解析 fail-open 硬契约 — `deploy-staging/gateway/entity-resolve.ts` 薄客户端：零 token 零 HTTP、TTL 30s、timeout 6s，任何失败回原文、永不阻断生成；warn 只印长度与 status ｜ 证据: 7f9dbe4e
- 实体解析不自动锁卡 — `mergeTokenReferencedCards` 不自动锁任何卡，锁定语义不动；`CanvasEmbed` 明确关闭注入的呼叫端（传 `{cards:[]}`）保持关闭不并入 ｜ 证据: 7f9dbe4e
- 畸形 token 只诊断不改写 — `findMalformedEntityTokens` 只回报空名称／缺右括号／未知种类；`ENTITY_TOKEN_PATTERN` 与 `parseEntityTokens` 逐字未动，原文照留 ｜ 证据: 7f9dbe4e
- 模板落卡有明确不标清单 — 分镜／影片／剪辑／门禁／工具卡一律不标 `emitsEntity`（免落重复卡）｜ 证据: 7f9dbe4e
- 音频实体卡端到端未验 — FlowMusic2API 上游实测 502（无可用帐号），只验到「展开真的发生才送上游」｜ 证据: 7f9dbe4e
- 一稿多版位不代呼叫付费生成 — outpaint 回 `skipped/no_outpaint_upstream/suggestedSize:<ratio>`，不代呼叫付费生成；现场事实：`ADOBE_FIREFLY_FILL_MODEL_ID` 全仓仅为定价条目、无 route/adapter 消费，我方真正扩图是提示词路径（nano-outpaint ＋ gemini-3.1-flash-image）不保证像素几何 ｜ 证据: 13f26615
- 视频抽帧边界一律回 `{ok:false, reason}` 而非例外 — interval<=0、count<=0/非整数、超过资源长度、超过 24 帧上限、duration NaN、interval 与 count 同给 ｜ 证据: 272fac86
- MCP 只暴露公开技能族 — 私有 Skill 绝不出现在 MCP ｜ 证据: 017cbc0b
- 技能库明确不做 — 公开发布、市集、审核、曝光统计（暴君 09-27 裁定）｜ 证据: 513462a5
- 插件包技能诚实声明 — 随包 SKILL.md 明确写出我们没有的能力（画布节点操作／连线／成片导出）｜ 证据: b49c7401
- 通知缺 blob 凭证时回 503 — 不静默落进程内记忆体 ｜ 证据: ee89433b
- 宣传片渠道来访只跳过一次不写「已看过」；`?promo=1` 不写入已看过；「先不登入」并离开＝清 pending ｜ 证据: 639bd737, aa752efe, 510eb1c3
- 进站判定不因登出而重判（登出不是重新进站）｜ 证据: d5ba65f8
- 3D 方案卡降级红线 — `saveData`／`deviceMemory ≤ 2` 不接管、`prefers-reduced-motion` 走静止构图、不接受载入变慢 ｜ 证据: 853244be
- `/api/version` 诚实边界 — 只证明这个部署是哪个 commit／建置时间／后端生效，不证明功能可用（HTTP 200 ≠ 可用）｜ 证据: e4c16950
- CI 刻意不做的事 — 不部署（Vercel 部署需 scope/auth，属人工授权）、不跑本地 build（remote build 才是稳路）｜ 证据: e4c16950
- 上游 fallback 不得静默回明文死路径 — 未设 `GATEWAY_BASE_URL` 时断言同步 ｜ 证据: 432ae6c8
- 话语归属 — 模板卡注入（机器配方）维持 `silent:true` 不进 transcript；只有宣传片试玩那句「使用者自己的话」带 `echo:true` 进聊天记录 ｜ 证据: 10403d5a
- Big picture：SEO 页面以「不认领中转站位子」为定位红线 — 标题不再以模型名开场、JSON-LD 删掉「无需注册中转站」条目；但 use-cases/long-tail-faq 那批刻意投的中转站长尾页保留 ｜ 证据: 585f27b7, e7917b3b

## 存疑

- `4b6afad5`（README 对齐 98 commit）：本 commit 不改程式码，其记录的能力（五值实体卡、行内 @ 引用、模板自动落卡、13 条产线模板、分镜 21 栏位契约与 142 条镜头词库、审核官把关、助理记忆库五类、工作流记忆沉淀、工作流历史卡与 DAG 缩图、帐号四轨登入增 Google OAuth、充值回调手续费容差、模型目录 57／影像 29／`/v1` 公开路由 31）属 2026-09-15～09-25 既有功能面，**不在本 commit 程式码内**，故不重复列为本批能力（避免跨批归属错误）。缺什么证据：需要对应功能 commit（在前批）。
- `8897511b`、`64d404b1`、`696cec9a`、`6eb5e08d` 仅 README 影片嵌入（各 +4/-9 行），无法从 diff 判断是否含产品能力；已按「无新能力（文档展示）」计。缺什么证据：README 渲染无程式行为。
- `e4c16950` 为 chore 收拢「前一轮三条未提交线」，新档归属（pricing 3D 舞台／blob 与资产范围／画布节点 metadata）可能由其他并行会话先写；本清单以其入库内容为准，作者归属不追。缺什么证据：无独立 commit 边界。
- `92a2a698` 自述「工作区里另一路（同日 09-27）已落地未入库的改动，本次一并入库并部署」，能力归属可能是另一路；以入库事实计。缺什么证据：无原始 commit。
- 音频实体卡（7f9dbe4e）与通知机制（ee89433b）都自陈「端到端未验／不交付运营配套」；能力存在但未以真单证明，属机制级交付。
- `2d5dbeac` 揭示的工程边界（Next page 档只能导出 Next 认可栏位，额外导出资料常量在 build 期被判死、tsc 抓不到）为建置期契约，非使用者可见能力，未列入主清单。
- `1129196a` 的「对外行为不变」属自述；本次未以真单重验三条 OAuth 建号（本批仅读 commit 与现况程式码）。
- 与记忆冲突：**无**。`13f26615` 关于「ADOBE_FIREFLY_FILL_MODEL_ID 无消费／真正扩图是提示词路径」与记忆 `2026-09-28-symdiff-source-first-and-hypit-video-extraction` 所述一致；`272fac86` 的 `/api/canvas/video-frames` 与该记忆所述「全 repo 零前端呼叫」一致（本批只交付端点，未接前端）。

---

## 逐条对帐

| hash | 该 commit 贡献的能力 |
|---|---|
| 7f9dbe4e | 生成时实体卡就地解析注入；`/api/biz/character-resolve`（target image/audio）；闸道节点生成认 tag 并参考图（使用者 key＋快取键含 apiKey）；模板自动落卡（11/13 模板 15 处）；音频卡可引用；畸形 token 警示；entity-resolve fail-open |
| 4b6afad5 | 文档对齐（记录 09-15～09-25 既有 98 commit 功能面）— 无新程式码能力 |
| 8897511b | 文档（README 首屏加宣传片）— 无新程式码能力 |
| 64d404b1 | 文档（README 首屏双片并排）— 无新程式码能力 |
| 696cec9a | 文档（README 一行修正）— 无新程式码能力 |
| 853244be | /pricing 方案卡 3D 化（四档世界／拖曳与滑杆互动／音效）；渐进增强与降级；卡堆主角模式 |
| e4c16950 | `/api/version` 端点；GitHub Actions CI；blob 后端可切 VPS；生成品质门日志；server-history-store；asset-scope 团队资产空间；character-card-store；canvas node-metadata-fields；站点展示资产与 deploy 脚本入库 |
| 35e678c0 | 3D 渲染超取样与版面收敛（pixelRatio 地板／图集 640／anisotropy 解自阉／fps 降级不砍解析度）；渐变文字降饱和 |
| 0651e7cd | 非程式码：`.vercelignore` 排除 200MB 影片产物 |
| 678892b9 | 纯修复（eslint 就地豁免，让 next build lint 阶段通过）— 无新能力 |
| ccf5af5d | navbar 余额「+」浮层 portal 到 body（z-90、点外收起层为完整视口）— 修复暴露的 UI 边界 |
| 6eb5e08d | 文档（README 宣传片换新片）— 无新程式码能力 |
| fc85156b | 自订档支付按 `custom:<coins>` 下单＋return 同源 resolvePricingPlan（真 bug）；票面粉蓝改柔和粉青 |
| 36ba61a2 | 非程式码：宣传片渲染工具链（三版封面、film.js、lib、26 素材）；字型不入库 |
| 6452273a | 未命中实体胶囊红色提示修复（Tailwind bracket 写法） |
| 786f366c | 未登入访客进站播一次宣传片；`promo-gate.ts` 判定链；muted autoplay＋手动开声＋poster 退路＋真进度条；收尾预填试玩语 |
| aa752efe | `?promo=1` 强制预览（不写已看过） |
| 639bd737 | 渠道来访不播宣传片（渠道参数／来源域名／MicroMessenger UA 三认定，跳过一次不写已看过） |
| 47c80991 | 非程式码：片源换 1080p 分享版＋海报重抽（faststart） |
| 7dd1b6a9 | 纯修复（注释措辞避开 ImageDisplay.test 契约）— 无新能力 |
| 92a2a698 | 思维链结算后收合；画布缩略图预设收合＋缩放胶囊控制；展开钮态著色；滚动条细化悬停显示 |
| 585f27b7 | 站点对外介绍单一真源 `site-copy.ts`（去模型名开场，模型名降 keywords） |
| bc018562 | OG 分享预览卡换成真宣传片封面（138KB JPEG） |
| 397571a2 | 顶栏常态零文字、资产／历史直接入口、⋯ 选单退役换齿轮 |
| e7917b3b | AI 检索面翻新：llms.txt 产品优先、FAQ 前置产品题、sitemap 补 docs/status、robots 放行九个 AI 爬虫 |
| c5f89542 | 顶栏改纯图示列五入口、拆标题与星芒图标、连线异常文字下沉对话区 |
| d58eba66 | 全站 canonical 各自自指（10 个公开页） |
| a940cb7a | 宣传片收尾＝封面画布＋真输入框送出直送产线；未登入 pending（sessionStorage）自动补送 |
| 1ad87154 | 结尾输入框四周出血 6px 精准盖框（几何逐像素对位） |
| 6844f223 | 结尾封面横式 contain 完整入镜、直式 250vw 以框为中心 |
| 510eb1c3 | 宣传片结尾「先登入再开跑」；PromiseLoginDialog 两路登入；pending 补送；「先不登入」清 pending |
| a2b8d79b | 登入改不遮画面的锚定小框（送出钮先转圈 0.2s；Esc 一层一层退） |
| 1129196a | OAuth 建号改走上游管理员建号 API（ensureGatewayUserForOAuth，先查后建复用吸收） |
| 16b2751c | 封面移除「成片·片名」胶囊（封面＋og 分享图同修，逐像素对帐） |
| 432ae6c8 | 新-api 管理面改走 TLS vhost（fallback 常数与断言同步，不静默回明文死路径） |
| 10403d5a | injection echo 栏位：宣传片试玩那句话以使用者自己的话进聊天记录（填 TTFT 空白） |
| dc16ff3d | 102 门页合并为 17 行业枢纽＋20 条 301；`/use-cases` 总索引；8 条产线落地页 `/workflows`；技术 SEO 收口（title template／@graph／sitemap 62 条／robots／noindex／IndexNow） |
| d5ba65f8 | 进站判定只做一次（resolvePromoEntry，登出不得重判／重播 ?promo=1） |
| 513462a5 | 133 条 Skill 条目层（10 家族）＋私有技能；`/api/skills` 与私有 CRUD；斜线直呼 SkillSlashMenu；MySkillsDialog；凭证闸 scanSensitiveContent；明确不做公开发布／市集 |
| 017cbc0b | Remote MCP server（JSON-RPC/Streamable HTTP）＋10 工具（同一帐本计费）；`/.well-known/oauth-protected-resource`；`/mcp` 安装页；运镜预设库 23 条＋公开只读 API |
| 64aff900 | 画布节点版本历史（上限 20/400，座标尺寸不进版本）；节点软删与恢复（单／批量端点） |
| 13f26615 | 一稿多版位裁切计划（13 版位 crop/outpaint/rejected，MAX_CROP_LOSS=0.25）；`/api/canvas/format-crops` 真裁（sharp＋EXIF）；outpaint 不代呼叫付费生成 |
| ee89433b | 站内通知／公告／横幅机制（store＋C 端与管理端 API＋铃铛元件）；跨用户未读隔离；机制交付不含运营配套 |
| 272fac86 | 视频截帧／序列帧节点动作（`/api/canvas/video-frames` 回抽帧计划，client 执行）；边界一律回 `{ok:false,reason}` |
| b49c7401 | agent 插件包 `public/plugin/`（Codex 形态＋3 随包技能＋`/plugin/` 入口）；`/mcp` 页插件包安装节；技能诚实声明缺的能力 |
| eca25f27 | 技能库公开只读浏览面 `/skills` ＋ `/skills/[id]`（全量 SSG、未知 id notFound）；sitemap 补录 |
| 2d5dbeac | 纯修复（交付形态标签收敛到单真源，修生产 build 失败）— 无新能力 |