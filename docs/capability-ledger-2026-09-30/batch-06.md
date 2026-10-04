# image-app 第 6 批（47 commits，2026-09-27 ~ 2026-09-28）我方能力穷举清单

口径：能力＝**使用者可见或可呼叫的行为**（端点／UI 动作／帐务语义／闸门判准），不是档案存在。
证据来源：`/tmp/cap/batch-6.txt`（唯一真源）＋ `git show`／`git show --stat` 补证；档名只作落地位置注记。
领域标签限用 11 个：生成核心 / 模型与供应商 / 控制平面与计费 / B端API / Agent助理 / 画布与工作流 / 创作域 / 帐号与增长 / 前端与UI / 运维与观测 / 团队与企业。

---

## 生成核心

- [生成核心] 真实结果驱动的模型可用性断路器（circuit breaker） — 72h 内最近 20 个计入终态样本（排除 user_input/cancelled），≥5 且 0 成功、或 ≥10 且成功率 <20% 即 open；每 30 分钟放行 1 单试探，最近计入终态成功即恢复；60s 快取 ｜ 证据: f009cf09
- [生成核心] 断路器的提交前 fail-fast 与替代模型建议 — 在 submitGenerationCommand 建单／预扣费之前 fail-fast（幂等重放例外），各提交路由映射 503 + 既有稳定码 no_endpoints（web 为 model_unavailable），讯息含同介质成功率最高的替代模型 ｜ 证据: f009cf09
- [生成核心] 不可用模型的三处一致下架 — /v1/model-status、/api/internal/model-status（自 VPS 收编入 repo）同判 unavailable，/v1/models（agent / MCP list_models）排除之 ｜ 证据: f009cf09
- [生成核心] 供给面断供判定 — 有 capability 合约但无任何可用「供应商＋合约＋帐号」组合的模型直接判不可用：列表下架、提交前拒单不扣费、不放必败试探，替代不推断供模型 ｜ 证据: 43be7f6e
- [生成核心] 影片轮询窗口可调 — openai-video 上游轮询窗口 540s → 1200s，支援 OPENAI_VIDEO_MAX_WAIT_MS 覆写（下限 60s），超时文案同源读取 ｜ 证据: 782d3214
- [生成核心] 生成预算按 job kind 分级 — 开工后生成预算 video_generate/avatar/lipsync 25 分钟、其余维持 15 分钟（新增纯函数 generationBudgetMs） ｜ 证据: 782d3214
- [生成核心] 欠费错误分类优先于鉴权分类 — failure-classifier 把欠费判定移到 401/403 鉴权判定之前（xiaoyxiao 欠费回 401 insufficient_user_quota 不再进鉴权桶 → 不再 quarantine → 不再帐号 disabled 空转到 deadline） ｜ 证据: 43be7f6e

## 模型与供应商

- [模型与供应商] xiaoyxiao 为视频唯一权威渠道 — registry 只留 xiaoyxiao（openai_video 既有轮子、tier managed_pool、priority 1），移除 metaso/tokenmix/cangyuansuanli/napi/drama/adobe2api-plus 六条视频条目 ｜ 证据: 8d640263
- [模型与供应商] 上游视频模型名重映射 — seedance 族由已下架的 sd4-* 改映射到 /v1/models 实查存在的 sd12-seedance-2.0／sd12-seedance-2.0-fast／sd13-seedance-2.0-mini／sd8-seedance-2.5／sd7-seedance-2.0-1080p（每族取最低价；旧名被上游以 "not a public model name" 直接拒收） ｜ 证据: 5da7919e
- [模型与供应商] 欠费文案与错误码词表补全 — 补齐中英词与错误码 insufficient_user_quota（原文「预扣费额度失败, 用户剩余额度: ¥1.44…」），欠费不再落 overloaded（retryable）而在退避循环空转到 deadline ｜ 证据: 5da7919e
- [模型与供应商] 欠费改 30 分钟冷却 — 欠费从「永久 disabled」改为「30 分钟冷却」，recoverExpiredCooldowns 可自动恢复（fail-fast retryable=false 不变） ｜ 证据: 5da7919e
- [模型与供应商] 成品 URL 多形状解析 — extractOutputUrl 补顶层 url 分支，支援 xiaoyxiao completed 只回 {"status":"completed","progress":100,"url":"…mp4"} 的形状，不再把已生成好的成品误判 upstream_protocol 丢掉 ｜ 证据: 43decfd6
- [模型与供应商] minimax-h3 时长表补齐 — DURATION_RANGES 补 minimax-h3 4–15s，与 catalog durations 对齐（原缺漏使 B 端真单在呼叫上游前被 400 挡下，零上游成本） ｜ 证据: 28aaed8d
- [模型与供应商] 零供货视频模型公开下架 — 公开目录下架 17 条零供货视频 model（14 条暴君裁定 + seedance-2.0-fast/-mini/seedance-2.5-30s 无白名单档位可承接） ｜ 证据: 8d640263
- [模型与供应商] adobe2api 只停 video 认领 — ADOBE2API_MODEL_IDS 只留图像，16+16 条图片 capability 不动，video 认领停止 ｜ 证据: 8d640263
- [模型与供应商] 退役供应商标签防复活 — 新增 RETIRED_SUPPLIER_LABELS（7 条），seed 跳过不碰，修复「worker 重启即把 DB 停用态冲回」的复活地雷 ｜ 证据: 8d640263

## 控制平面与计费

- [控制平面与计费] 兑换码上游分页全扫 — listGatewayRedemptions 改 p 从 1 起算、按上游 total 翻到尽、按 id 去重（原本 p=0 与 p=1 同页、只翻 1 页 ⇒ 415 张码只看得到最新 100 张且同页被数两次） ｜ 证据: bed6f558
- [控制平面与计费] 基线前兑换不再被静默丢弃 — redeemed_time < 开户基线的码改记两条腿（同一事务）：recharge +Q 让「钱从哪来」可见 ＋ adjustment −Q 冲销（净额 0 不双算）；先读两把幂等键、只补缺的那条，避免单腿漂移 ｜ 证据: bed6f558
- [控制平面与计费] 人工码不记现金 — 新增 isCashBackedRedemptionName（mPay 单命名 = `MP` + out_trade_no 后 18 码）；现金单维持 source=redemption-sync，人工发码/赠送码改记 source=gift-manual-code（命中既有 NON_CASH_RECHARGE_SOURCE） ｜ 证据: bed6f558
- [控制平面与计费] 上游调额不幂等的占位幂等 — welcome_gift_grant 占位（ON CONFLICT … WHERE status='failed'）＋ idempotency_ref=adjustment:welcome:<uid>:v1，并发/重放只加一次；上游抛错时复读 quota 区分 failed（可重试）与 unknown（不再自动动上游） ｜ 证据: 629b4ae5
- [控制平面与计费] 支付回跳自动兑换 — PricingClient 侦测 ?cdk= 回跳且已登录即自动兑换一次，成功后移除 URL 中的 cdk（刷新不重兑），失败保留预填不弹错 ｜ 证据: be716f12
- [控制平面与计费] 余额不足就地充值 — 余额不足 toast 显示本次所需币数并带「去充值」动作 ｜ 证据: be716f12
- [控制平面与计费] 订单参数自签三段值 — 订单参数自签 `planId.userId.hmac8`（HMAC-SHA256，域 "mapay-order"，timingSafeEqual 验签，旧格式／篡改一律回 null）；checkout 已登录（napi_token cookie → 控面稳定令牌表反查 userId，2.5s 预算）时写三段值，未登录／查不到／超时沿用旧格式 plan.id ｜ 证据: e27e3697
- [控制平面与计费] notify 直接入帐（不再依赖用户回跳兑换码） — param 验签通过 → 控面直达入帐、成功不生成兑换码；上游明确没动或通道不可用 → 退回旧发码流程（保证钱一定落地）；占位结果未定 → 不开第二条通道并留 warn 交核对 ｜ 证据: e27e3697
- [控制平面与计费] mapay_credit 占位幂等与状态机 — 占位表 mapay_credit(out_trade_no PK) 只插不覆盖（上游调额不幂等，重放永不双发）→ adjustGatewayUserQuotaExact → 帐本 recordRecharge（幂等键 redemption:<out_trade_no>）；状态机 pending/applied/failed/unknown；结果词表 credited/already_credited/failed/in_flight/none/unavailable ｜ 证据: e27e3697
- [控制平面与计费] 控面乐观重算金额 — /api/internal/mapay-credit 的额度一律控面自己由 planId 重算，不接受呼叫方传金额（op=credit 入帐、op=status 只读，biz-key-sync HMAC 通道，域 "mapay-credit"） ｜ 证据: e27e3697
- [控制平面与计费] legacy reserve 失败不谎报余额不足 — 非余额失败（网关不可达／回滚不确定）不再谎报成余额不足，改走既有 503 control_plane_unavailable 契约，真因写服务端日志 ｜ 证据: a9ceb2f0
- [控制平面与计费] 首充专享・限一次 — FIRST_CHARGE_PLAN（id `first-charge`，¥7 → 300 币）**故意不进 PLANS 阵列**（不出现在正价梯与价目列头）；/api/payments/first-charge/eligibility 探资格，有资格才渲染卡，未登录只显示文案、点击先登录 ｜ 证据: 1b592d5d
- [控制平面与计费] 首充资格帐本口径 — 资格＝该帐号在 account_ledger 从无 recharge 行 ∧ 名额表未被占；判准唯一真源在控面 /api/internal/first-charge（签名域 first-charge），金额权威仍是 account_ledger ｜ 证据: 1b592d5d
- [控制平面与计费] 首充并发执法 — 名额表 user_id 主键 INSERT … ON CONFLICT DO NOTHING RETURNING：两单并发只有一单保留 300 币，输家按 ¥7 对应正价币数（70 币）入帐并记 detail；真正执法在 checkout 403 与入帐时按正价折算 ｜ 证据: 1b592d5d
- [控制平面与计费] 团队席位价格唯一真源 — team-seat-pricing 为席位价格单一真源（改价只改本档），现值全为 null＝未配置，未配置一律回 price_not_configured ｜ 证据: c9696948
- [控制平面与计费] 席位下单未接线接缝 — POST /api/v1/team/seats/order 未接线回 501 seat_order_fulfillment_unwired，翻线前一律拒单；刻意不呼叫 mapay 收款面（既有 notify 端 resolvePricingPlan 必然 null ⇒ 会「收钱不履约」） ｜ 证据: c9696948
- [控制平面与计费] 席位 → 成员额度分配 — POST /api/v1/team/seats/allocate 全部委派既有 allocateMemberQuota，不另开第二条分配路径、不改其不变量语义 ｜ 证据: c9696948
- [控制平面与计费] 团队用量查询 — GET /api/v1/team/usage，明细走 account_ledger 逐笔、总额走 new-api ｜ 证据: 2447c874
- [控制平面与计费] 团队席位上限闸 — GET/POST /api/v1/team/seats：上限不得低于现有成员数、不得超硬上限；席位闸与调整幂等 ｜ 证据: 2447c874

## B端API

- [B端API] /openai/v1/images/generations 同步形状 — 提交后服务端轮询到终态，同步回 200 {created, data:[{url}|{b64_json}]}；response_format 预设 url（OpenAI 语义），b64 由服务端复用既有取件后端取回再编码；等待上限 240s（maxDuration 300 减 60s 结算余裕，OPENAI_COMPAT_MAX_WAIT_MS 可调） ｜ 证据: 8cb16aea
- [B端API] /openai/v1/chat/completions（含 stream） — 取最后一条 user 讯息当 prompt；stream:true 先送 role delta，出图前每 10s 送 SSE keep-alive，出图后送 markdown 图片 delta，末行 [DONE]（stream_options.include_usage 时补 usage chunk） ｜ 证据: 8cb16aea
- [B端API] /openai/v1/models 只列可出图模型 — {object:"list", data:[{id, object:"model", owned_by:"eimu"}]}，共用金钥白名单＋目录 kind=image＋既有熔断/断供闸 ｜ 证据: 8cb16aea
- [B端API] 同步层错误信封与未出图不扣费 — 失败/超时回 OpenAI 错误信封，未出图不扣费（沿用 durable 退款语义），504 的 message 带 task id；insufficient_balance 补进 type 值域以便 402 原样透传 ｜ 证据: 8cb16aea
- [B端API] 同步层共用层禁直连 DB — openai-compat 共用层的提交/轮询走被 beforeFiles 代理的 HTTP 入口 /api/v1/images/generations 与 /api/v1/images/{id}；鉴权复用 authenticateBizApiKey（biz key 两边通用） ｜ 证据: 8cb16aea
- [B端API] 同步层改在控面执行 — /openai/v1/* 加 beforeFiles 代理改在控面跑（Vercel Hobby 函数硬上限 60s 会硬杀等待中的函数、连 504 都送不出去；models 的熔断/断供闸需要 GENERATION_DATABASE_URL，Vercel 不持有该变数只会 fail-open） ｜ 证据: 1b49771a
- [B端API] B 端 /v1 拒绝遥测 — 新表 api_rejection ＋ withApiRejectionTelemetry 出口拦截只记 status>=300（reason 取自回应体的稳定 code，非 JSON 退回 http_<status>），只记 key 前 8 位、不记 prompt/完整 key，写入 fire-and-forget 储存层错误静默吞掉 ｜ 证据: af6c6a49
- [B端API] 拒绝遥测覆盖四个 /v1 出口 — 接线 /v1/images/generations、/v1/images/edits、/v1/images/[id]、/v1/models，写成边界包装使新增出口自动覆盖（漏记出口没有任何测试能事后发现） ｜ 证据: af6c6a49
- [B端API] 建 key 成功即给可复制 curl — ApiKeysClient 签发成功弹窗新增两段一键复制 curl 区块（通用 gpt-image-2 / PixAI 二次元），model 与 size 一律由 generation-model-catalog 推导 ｜ 证据: 0cbd7c0c
- [B端API] 建 key 弹窗余额说明 — 「新人礼额度可直接调用；余额用完返回 402，附充值连结。」＋充值连结 ｜ 证据: 0cbd7c0c
- [B端API] /v1 余额不足统一 402 insufficient_balance — 所有 /v1 余额／额度不足出口一律回 {"error":{"message":"余额不足，本次未扣费。充值：https://eimu.dev/pricing","type":"insufficient_balance","code":"insufficient_balance"}}，单一真源＝quota-precheck.ts 的 INSUFFICIENT_BALANCE_ERROR（闸门拒单与 legacy reserve 余额不足分支共用） ｜ 证据: a9ceb2f0

## Agent助理

- [Agent助理] 剪辑域 Agent 配方库落库 — skills/editor/** 新增 7 份 SKILL.md（域根路由表＋lint 闸门铁律＋四条标准链路＋六个子配方 assembly / audio-first / rhythm / look / mix / qc-master），一配方一目录一 SKILL.md ｜ 证据: 2890c923
- [Agent助理] editor persona 默认注入 7 条 skill 路径 — EDITOR_PERSONA_SKILL_PATHS 由 [] 填成 7 条真实路径（原本自陈「skills/ 无剪辑域配方库 → skill 待补」）；EDITOR_PERSONA_TOOL_IDS 现场已是 10/10 完整未动 ｜ 证据: 2890c923
- [Agent助理] 委派 prompt 质检闸硬规则 — editor-delegate.ts 委派 prompt 只增一段质检闸硬规则（纪律层），既有回执契约与 collect 语义零改 ｜ 证据: 2890c923
- [Agent助理] skill 索引可解析性修复 — opencode 只解析 YAML frontmatter 在 byte 0 的 SKILL.md（首为 HTML 注解者静默不进索引）；115 档纯位移＋1 档补 frontmatter，skills/ 可解析 8/124 → 124/124 ｜ 证据: 19f7f257
- [Agent助理] skill frontmatter 索引守门测试 — src/lib/skill-frontmatter-indexability.test.ts（repo 级）：①扫描集合 ≥100 ②每份 SKILL.md byte 0 必须 `---` ③frontmatter 含非空 name/description；突变对照可变红并指名档路径 ｜ 证据: 19f7f257
- [Agent助理] timeline 族工具的 subagent 身份 fallback — timeline_* 工具在子代理（editor 跑独立 opencode 子会话）下 fallback 到 subagentParentState，整族端点不再一律 404 timeline_session_not_found ｜ 证据: 6d395e84
- [Agent助理] timeline 身份闸未放松（边界语义） — `if (!tlState || tlState.apiKey !== key) return 404` 一字未改；subagentParentState 只在可信 internal dispatch 写入的 byChildOc 命中时回值，父会话非本 key 一律 404，跨租户隔离不变、零新增模型可控身份输入面 ｜ 证据: 6d395e84

## 画布与工作流

- [画布与工作流] 本机 3D 模型导入通道 — CanvasNodeCreateMenu 增「导入 3D 模型…」，经 POST /api/canvas/scene-3d（requireVerifiedUser + blob-backend.put）把桌面 GLB 带进画布成 scene_3d 场景卡 ｜ 证据: 32d9bf2c
- [画布与工作流] Scene3dCardMetadata 契约放宽 — 底线＝glb_path + scene_summary 非空，turntable_url / stills_urls / blend_path / duration_ms 放宽为可选；新增可选 source: "director" | "import"；落地清洗缺底线整包丢、可选栏型别不符只省略该栏；双白名单两端同步 ｜ 证据: 32d9bf2c
- [画布与工作流] 导入卡卡面减法 — 导入卡只出 GLB 视口 + 下载 + 真实来源摘要，不渲染空播放器、空静帧网格、死切换钮、缺席的 .blend 连结 ｜ 证据: 32d9bf2c
- [画布与工作流] 桌面 Blender 一键导出到画布 — Blender addon 面板新增「Eimu 导出」区（服务器地址／连接码／导出按钮），operator blendermcp.export_to_eimu：导出 GLB → stdlib urllib multipart POST → 报结果 ｜ 证据: 13983ce7
- [画布与工作流] 一次性连接码铸发 — POST /api/canvas/scene-3d/link 需登录铸码，code = base64url("scene-3d-link.{userId}.{到期毫秒}") + "." + hmacHex（HMAC-SHA256 无状态，不新增存储）；缺 env 时诚实 503，不降级 ｜ 证据: 13983ce7
- [画布与工作流] 3D 上传路由多身份来源 — POST /api/canvas/scene-3d 多认一种身份，三条优先序＝Bearer 连接码 → cookie（requireVerifiedUser，顺序与语义逐字不变）→ 表单 code；落地物件键仍用验出来的 userId，与 cookie 路径同一套 ｜ 证据: 13983ce7
- [画布与工作流] 画布 UI 连接 Blender — CanvasNodeCreateMenu 增「连接 Blender」→ 铸码 → 显示可复制连接码与到期时间 ｜ 证据: 13983ce7
- [画布与工作流] 团队命名空间画布 — project.scope === "team" 且已验成员身份 → 落 canvas/team/<teamId>，teamId 以 relay 回传的权威值盖章（客户端送来的不采信）；团队画布单写（后写覆盖），刻意不做锁／CRDT／冲突解决 ｜ 证据: c9696948
- [画布与工作流] 建画布闸（真资料源走 HMAC relay） — team-canvas-gate 真源改走 /api/internal/team-membership relay（逐行照抄 newapi-session-token 的 ViaRelay 模式，换路径与 signatureDomain 防跨端点重放）；判定与 team-governance.canCreateSharedCanvas 逐字对齐；relay 回 null → 放行（fail-open 兜底）；先判后存，拒时不呼叫任何 save*、不产生半成品专案，既有专案更新不受事后关闸影响 ｜ 证据: c9696948
- [画布与工作流] 建画布闸接入全仓唯一落盘路径 — PUT /api/canvas/projects（upsert by id，全仓唯一建/落盘路径）接线；上游三个真实前端建立来源（工具箱新建画布 / agent 下发 canvas_apply_ops 的 debounce 存档 / 模板铺画布）全收敛到它 ｜ 证据: c4c895d3

## 创作域

- [创作域] 剪辑质检闸（交付／导出门槛） — timeline_lint 在域根与 qc-master 皆写成「must 级未清不得交付／不得导出」的闸门 ｜ 证据: 2890c923

## 帐号与增长

- [帐号与增长] 新人礼（首次登录送约 5 张标准图额度） — 首次登录即送 5 币（= 5 × 预设模型标准图真实定价，2,500,000 quota，WELCOME_GIFT_* 具名常量）；资格＝generation_job 无 succeeded；/api/auth/me 验证通过后挂发放（每实例每用户只问一次控面，3s 超时，失败不挡登录） ｜ 证据: 629b4ae5
- [帐号与增长] 新人礼回溯补发 — /api/internal/welcome-gift 控制面 HMAC 端点 op=grant / op=backfill[dryRun]，追溯未出过图的既有用户 ｜ 证据: 629b4ae5
- [帐号与增长] 新人礼站内通知每用户只一次 — 站内通知改由 Vercel 登录路径写入（welcome-gift-login.ts），控制面回 noticePending、Vercel 写后经 op=noticed 回执；登录发放与运维回溯发放都只收一次「新人礼：已送你 5 币，够生成约 5 张图」 ｜ 证据: fc2c8053
- [帐号与增长] 新人礼首登弹窗 — 已发放未展示才弹一次，闸门权威在服务端 welcome_gift_grant.modal_seen_at ＋ internal op=modal_seen（不复用 noticed_at，否则弹窗永远不出现）；localStorage 只挡同设备重复弹 ｜ 证据: 586d83bd
- [帐号与增长] 弹窗主按钮只预填不发送 — 「马上生成第一张」走 AgentChatSurface 既有 prefillRequest 通路（输入框有字、光标在末尾、聚焦在框上，人再按送出）；示例句与聊天面板空态 chips 共引用 lib/agent-example-prompts 单一真源 ｜ 证据: 586d83bd
- [帐号与增长] 主输入区被登入挡下的一句话不再消失 — 未登录在主输入区送出被 auth 挡下时那句话写进 PROMO_PENDING_KEY（与宣传片同一格）并读回验证（空句不覆盖已存），登入态翻真后既有的补送 effect 原样接手 ｜ 证据: a8362440
- [帐号与增长] 只对 auth 挡下才补送 — onSendBlockedByAuth 只在 closedReason==='auth' 这一种上抛（网路抖动／上游故障不留），notice 文案同时说得出路 ｜ 证据: a8362440
- [帐号与增长] 作品公开分享页 — /p/<shareId>，shareId 128-bit 随机（base64url 22 字）不可由 artifact/entry id 推得、不可枚举；默认不公开（没点过分享就没记录）、可撤销且撤销＝删记录（同一链接当场 404） ｜ 证据: d4b2a8b8
- [帐号与增长] 「做同款」增长回路 — 分享页「做同款」复用图库卡既有交接通道（?agent=1&q=）＋ commit a8362440 的「未登录不丢话」，未登录者只差一次登录 ｜ 证据: d4b2a8b8
- [帐号与增长] 分享链路 UTM — 分享链接带 utm_source=share&utm_medium=p&ref=<shareId>，canonical 路径不带参数 ｜ 证据: d4b2a8b8
- [帐号与增长] 已验证真实 email 触达 — GitHub /user/emails 取 verified（优先 primary）、Google userinfo 取 email_verified===true 的真实 email 落 user_attribution.email；只在已验证时带值、未验证一律 null；每次登录幂等 upsert（email 最新已验证值胜出） ｜ 证据: 86fb664b
- [帐号与增长] 注册来源首触归因 — root layout 挂 AttributionCapture，首次进站把 utm_source/medium/campaign、referrer host、落地路径写进 eimu_first_touch cookie（90 天，首触不覆盖）；注册/首次登录经 HMAC 签名通道落 user_attribution（signup_source = utm_source → referrer host → 'direct'，小写分组键），/api/auth/me 兜底覆盖微信等无 callback 路径 ｜ 证据: 86fb664b
- [帐号与增长] 生命周期邮件：新人礼欢迎信 — worker 帐本维护循环（10 分钟）挂点；email 取自 user_attribution，新人礼 applied 才发 welcome ｜ 证据: 9f883c61
- [帐号与增长] 生命周期邮件：48h 未出图激活提醒 — nudge 邮件带 List-Unsubscribe 一键退订（HMAC，域分隔复用 GENERATION_BILLING_RELAY_SECRET），/api/email/unsubscribe 代理至控制面写 email_preference ｜ 证据: 9f883c61
- [帐号与增长] 邮件发送幂等与错误分级 — email_send_log 占位幂等＋Resend Idempotency-Key；单收件人错误记 failed 不重试，系统性错误（401/403/429/5xx/网路）释放占位并中止本轮、下轮重试；未配置 RESEND_API_KEY 整体 no-op ｜ 证据: 9f883c61
- [帐号与增长] 生命周期邮件三个产品时刻重做 — 首图 / 未出图提醒 / 额度用完（新增 depleted：出过图、余额不足一张标准图、从未充值、最后出图已过 1h → 一次）；正文给出已做张数与最低一档价格/可做张数，CTA 去充值 ｜ 证据: 350ef376
- [帐号与增长] 邮件品牌版式与真实示例一点即填 — 表格布局＋preheader＋品牌色（DESIGN.md：#2d3142 CTA、金币色）＋logo；示例＝同一句 prompt 以 gpt-image-2 真实生成的图，点击走 /?agent=1&q= 交接通道（提示词填进助理输入框） ｜ 证据: 350ef376
- [帐号与增长] key_idle 召回信 — 建第一把 biz key 满 24h、却没有任何 source=biz 的 job、未退订、有已验证 email → 发一次；curl 直接复用 dev-quickstart 的 gpt-image-2 范例，CTA 指向实际存在的 /settings/api-keys 路由 ｜ 证据: a4be1a00
- [帐号与增长] 自签邀请码 — src/lib/referral-code.ts 形状 `<id 36进位>-<hmac8>`／`<userId>-<8hex>`；解码零查表、签名防伪（乱填 id 只会被拒），密钥复用 GENERATION_BILLING_RELAY_SECRET 以域前缀分隔；前端 looksLikeInviteCode 只挡畸形，验签一律在服务端 ｜ 证据: e33571e9
- [帐号与增长] 分享即邀请 — share-remix.ts 分享连结首位带作者邀请码，看图的人注册并出首图＝作者邀请成功 ｜ 证据: e33571e9
- [帐号与增长] 邀请绑定时机 — 只在被邀请人尚未出图时绑，首个邀请胜出；码不合法／自邀／已出图都回 ok（免得每次登录重送）；Vercel 侧 auth/me 并入 applyInviteBinding（带记忆避免重试风暴，永不挡登录） ｜ 证据: e33571e9
- [帐号与增长] 邀请奖励挂「出第一张图」 — 被邀请人首图成功后双方各发一次；金额口径＝plans.ts 的 INVITER/INVITEE_REWARD_IMAGES × STANDARD_IMAGE_COINS（与新人礼同一把尺）；每人上限 MAX_REWARDED_INVITES 防小号农场；帐本幂等键按角色分开、沿用五态状态机；上游调额失败＝整轮停且 quota 未动记 failed 可重试；worker 维护轮接上 ｜ 证据: e33571e9
- [帐号与增长] 邀请定价页文案与自签连结 — 文案改「好友出第一张图你得 N 金币」，邀请连结改走 /api/user/invite 自签连结（取代 fetchAffCode），FAQ 补「分享作品连结同样算邀请」与上限说明 ｜ 证据: e33571e9
- [帐号与增长] 开发者新人礼自动补发 — runWelcomeGiftDevCatchUp()：外部用户（持有 biz key ∧ 未领过新人礼 ∧ 没有成功出图）自动补发，直接复用 grantWelcomeGift，每轮上限 20 人；接入 runAccountMaintenanceOnce，失败不中断维护轮 ｜ 证据: 78a019a3
- [帐号与增长] 新人礼排除口径唯一权威 — welcomeGiftExcludedUserIds() 排除名单唯一权威＝env INTERNAL_USER_IDS（与统计剔除同源），不再按「持有 biz key」排除 ｜ 证据: 78a019a3

## 前端与UI

- [前端与UI] 通知入口搬进「API 密钥」下拉 — NotificationBell 增 variant?: "icon" | "menuItem"；menuItem 渲染成 DropdownMenuItem 一行（Bell 图标 + 「站内通知」+ 未读徽章，>0 才渲染、>9 显示 9+），Navbar 在密钥下拉末尾加一行（零 header 宽度成本） ｜ 证据: a6cc34f0
- [前端与UI] 通知面板挂 body 避免退场卸载 — Radix 2.1.24 退场动画会卸载整棵 content 子树 ⇒ 面板改由 mountNotificationPanel() 用 createRoot 挂到 body（模组级单例，先卸旧再挂新），面板容器显式 pointerEvents:auto（菜单退场 200ms Radix 会把 body 设成 pointer-events:none） ｜ 证据: a6cc34f0
- [前端与UI] 通知面板锚点纯函式 — computePanelAnchor({rect,barBottom,innerWidth})、nextPanelAnchor(previous, el, innerWidth)（el 为 null 时原样回 previous，绝不清成 null）；坐标在点击当下量成数字存起 ｜ 证据: a6cc34f0
- [前端与UI] Navbar 项数回退 — 移除 <NotificationBell /> 与其 import，余额/历史/文档/密钥/用户/退出回到通知刀之前的项数并再少一项 ｜ 证据: 2d601be7

## 运维与观测

- [运维与观测] 激活漏斗卡 — 窗口（7/30 天）注册 → 发起生成 → ≥1 成功 → 首次生成后 7 日内回访 → 现金充值，每步为上一步子集；D1 回访、未回访即付费、非现金入帐单列 ｜ 证据: 9218cabf
- [运维与观测] 内部流量剔除 — INTERNAL_USER_IDS env（预设 117,82），消耗／剩余额度／漏斗统一按任务拥有者（web:<uid> 或 biz_api_key.user_id）剔除，预设不含、可切换 ｜ 证据: 9218cabf
- [运维与观测] 新用户首图耗时指标 — 注册 → 首个 succeeded finished_at、首单 created → finished 的 p50/p90（最近秩）；注册走 new-api 管理 API listGatewayUsersRegisteredSince（不直连 sqlite） ｜ 证据: 9218cabf
- [运维与观测] 漏斗按来源拆分 — statistics-projection 新增 sources（每来源 注册/发起/成功/付费），各来源每格加总恒等于总漏斗对应步骤（具名测试钉住）；无归因事实归 UNATTRIBUTED 桶（不猜成 direct）；归因读取失败回 sourceBreakdownUnavailable 由 /admin 明示 ｜ 证据: 86fb664b
- [运维与观测] Next.js maxDuration 段配置须字面量 — maxDuration 只能写字面量 300，写常量会炸整包 build（tsc 与单测都抓不到） ｜ 证据: 29e6ca91

## 团队与企业

- [团队与企业] 团队成员角色管理 — GET/POST /api/v1/team/members（action: set_role | remove） ｜ 证据: 2447c874
- [团队与企业] 建画布权限开关 — GET/POST /api/v1/team/settings（member_create_canvas） ｜ 证据: 2447c874
- [团队与企业] 加入审批四态 — GET/POST /api/v1/team/join-requests（apply | decide，四态） ｜ 证据: 2447c874
- [团队与企业] 团队生命周期与 48h 冷静期 — GET/POST /api/v1/team/lifecycle（dissolve | withdraw | leave）；解散 48h 冷静期内可撤回、过期不可撤回、执行幂等 ｜ 证据: 2447c874
- [团队与企业] 治理控制台 UI — src/app/settings/team 页 + TeamConsoleClient 六面（成员角色／建画布开关／加入审批／席位／解散+冷静期撤回／用量含守恒检验），入口在 Navbar 密钥小菜单与 ApiKeysClient 页尾 ｜ 证据: c4c895d3
- [团队与企业] 治理控制台认证 — 认证走团队主帐 B 端密钥（只存 sessionStorage，不落盘不记 log） ｜ 证据: c4c895d3
- [团队与企业] 席位未接计费的诚实标注 — GET /api/v1/team/seats 加 billing_connected:false ＋ billing_note（addition-only） ｜ 证据: c4c895d3

---

## 非程式码能力（VPS／部署／DB 迁移／外部服务／运营流程）

- 外部 biz key 首调审计报告（唯读） — VPS 唯读查 Postgres + new-api sqlite：23 把外部 key 里 14 人从未发起任何生成（12/14 与最后登入同一分钟内）；9 人有发起者首单成功 5 人、首单退款／拒单 4 人（deadline_exceeded×2、model_unsupported×1、billing zombie×1）；23 人 new-api 消费记录（type=2）为 0 行、top_ups 空表 ｜ 证据: 0f9e2962
- 审计口径重算为 21 位外部持有者 — 87/90 判为内部帐号（admin 供给型巨额额度、零登入零签到、建号即签 key 即出图）自 23 位扣除；job 级按 failure_class 精确扣除 426 → 401（succeeded 227→215、deadline_exceeded 178→170、model_unsupported 6→2） ｜ 证据: f5018d30
- VPS skill 索引落位 — VPS 侧索引 50 → 167（13 份死亡修复 + 104 份本地独有落位，精准吻合 50+13+104）；VPS 独有 42 份中 41 份逐位元未动 ｜ 证据: 19f7f257
- timeline 链上生产 — timeline_lint 调用 0 → 2 且皆 {"ok":true}、timeline_query 0 → 5 成功；真产物 timelines/25ef4fc6-…/{current.json,versions/1.json,versions/2.json,log.jsonl}（3 clips／1 audio／1 subtitle／9:16），lint 结论被真实消费 ｜ 证据: 6d395e84
- AGENTS.md 付费上游呼叫硬闸规则 — 规则落进工作规则档（model 白名单为唯一真源、resolution ≤720p、seconds ≤5、提交前先核价、一次授权一次呼叫、花暴君的钱先问） ｜ 证据: e33571e9
- biz-api 「两种接法」文档 — 开篇并列 A 标准 OpenAI 同步 base https://eimu.dev/openai/v1（images/generations、chat/completions 含 stream:true、models）与 B 异步 base https://eimu.dev/v1（202+task_id 轮询／callback／Idempotency-Key），并给 new-api/one-api 加渠道 9 步填法 ｜ 证据: dffaef5b
- openapi／biz-api 契约文档校正 — response_format 预设改 b64_json、size enum 补 2048x2048、data[0].b64_json 叙述改为 202 异步 + 轮询取图、错误表改码、SDK 段落诚实说明 ｜ 证据: a9ceb2f0
- S2 OpenAI 兼容核对报告 — docs/specs-0928/S2-compat-report.md 逐维度差异（异步 202 vs 同步 200、data[] 为 TaskArtifact 无 b64_json、response_format 预设 b64_json、n 1-4、size 固定 4 值）＋三家客户端接入判定 ｜ 证据: 0cbd7c0c
- /openai/v1 控面部署依赖 runbook — 部署配置必须加 OPENAI_COMPAT_GENERATION_ORIGIN: http://127.0.0.1:3000（兼容层预设打 origin + /api/v1/*，但控面 app 路径在 /image-control/api/v1/* 底下会落不到 route，真单撞 503 control_plane_unreachable） ｜ 证据: ea31d305
- 决策分界工作规则 — ops／口径问题自行拍板并在回报写判准，只有不可逆且偏好因人而异的产品／审美题才回报待裁 ｜ 证据: 8f2eaac2
- DB 迁移 023–031 — 023_team_governance／024_welcome_gift_grant／025_user_attribution／026_welcome_gift_modal_seen／027_lifecycle_email／028_referral／029_api_rejection／030_mapay_credit／031_first_charge_claim（现 repo db/migrations/ 已存在至 033） ｜ 证据: 2447c874 / 629b4ae5 / 86fb664b / 586d83bd / 9f883c61 / e33571e9 / af6c6a49 / e27e3697 / 1b592d5d

## 边界与拒绝（明确不做／fail-closed／白名单外拒收／诚实降级）

- [边界语义] 付费上游视频成本硬闸 fail-closed — model 白名单 7 条外一律拒收；resolution 缺省／空字串拒收；4k/2k/1080p 无条件拒收（上限 ≤720p）；seconds 超上限拒收；三元组 (model,resolution,seconds) 无核价记录即拒收；拒收写结构化稽核日志并抛 400，不重放、不重复烧钱 ｜ 证据: 8d640263
- [边界语义] 视频秒数上限先设 10 且三元组显式枚举 — PAID_VIDEO_MAX_SECONDS = 10（＝catalog 最短时长），未登录即 triple_not_priced（非「≤10 全放行」） ｜ 证据: a27b6476
- [边界语义] 视频秒数上限放宽至 30 且三元组由 catalog 生成（禁手抄） — PAID_VIDEO_MAX_SECONDS = 30；buildPricedVideoTriples() 由 registry xiaoyxiao claims × GENERATION_MODEL_CATALOG（durations × resolutions）× PAID_VIDEO_ALLOWED_RESOLUTIONS 生成，catalog 改时长/档位闸门自动跟上；未映射／未核价＝零三元组＝拒收；白名单内但无 claim 维持 fail-closed（grok-video-1.5 依暴君裁定搁置） ｜ 证据: ed732c8e
- [边界语义] 成本闸作用域收敛 — 三个已退役渠道（cangyuansuanli/napi/drama，仅作协议夹具）豁免；在线渠道与未标明 supplierId 的新渠道一律 fail-closed 拒收，豁免不泄漏 ｜ 证据: 28aaed8d
- [边界语义] 本机 3D 导入上限由 100MB 收窄为 4MB — 本路由走表单代理，请求体先过平台硬顶（Vercel 4.5MB），100MB 只会让 4.5–100MB 的档前端验证通过却被平台 413；LibTV 级 100MB 需浏览器直传物件存储通道，生产 blob 后端是 VPS image-data-api，站内现无该通道 ｜ 证据: 32d9bf2c
- [边界语义] 连接码与 OAuth 码域隔离 — 域前缀与独立 env SCENE_3D_LINK_SECRET；与 emu-oauth 同密钥同格式会让画布上给用户复制的连码变成一把「可铸 key」的凭证；无状态的代价（TTL 内无法单独吊销，只能等过期或轮换密钥）写在档头 ｜ 证据: 13983ce7
- [边界语义] 连接码验签先于域与时效 — 按最后一个 "." 切分 + timingSafeEqual，先验签再看域与时效（签章不过不回报「已过期」，不给「格式对了只是旧了」的假信号） ｜ 证据: 13983ce7
- [边界语义] 剪辑不做人工多轨时间线 UI — 暴君裁定剪辑由 Agent 做，不做人的多轨时间线 UI，本片只交付站点侧契约与配方层 ｜ 证据: 2890c923
- [边界语义] 审查页整页撤除 — 删 src/app/review/page.tsx 与唯一使用者 src/lib/review-assembler.ts 及其测试；Navbar「审查页」入口与 robots 的 /review 条目一并拔掉，生产 /review 404（暴君：从没用过） ｜ 证据: 2d601be7
- [边界语义] 团队治理写入禁影子帐本 — 治理写入路径不呼叫任何上游额度调整、不写任何点数帐本（测试钉死）；配额唯一通路仍是 member-quota.ts（点数权威在 new-api users.quota，分配＝转移且写绝对值天然幂等） ｜ 证据: 2447c874
- [边界语义] 最后一个 owner 不可移除／不可退出 — 409 last_owner ｜ 证据: 2447c874
- [边界语义] 满员时加入申请不得通过；member 且开关关闭时建画布被拒 ｜ 证据: 2447c874
- [边界语义] 一个 user 同时只属一个团队（现场推翻竞品假设） — 019 的 member_user_id UNIQUE 使竞品「每人可加入 5 团队」结构上不可达，实际紧约束是配额桶模型，已在 migration 与模组注释标明 ｜ 证据: 2447c874
- [边界语义] 治理层未配置／查不到成员身份 fail-open — relay 回 null（未配置／逾时／查不到／载荷不合法）→ 放行；查不到成员身份 → 降级个人命名空间（不拒、也不写进别人的团队） ｜ 证据: c9696948
- [边界语义] 席位未配置绝不当 0 元 — 未配置一律回 price_not_configured（0 元成立订单＝诚实性事故） ｜ 证据: c9696948
- [边界语义] 席位下单翻线前一律拒单 — 501 seat_order_fulfillment_unwired；刻意不呼叫 mapay 收款面（既有 notify 端 resolvePricingPlan 必然 null ⇒ 会「收钱不履约」） ｜ 证据: c9696948
- [边界语义] 成员额度不足／停用 fail-closed — 成员额度读不到／unlimited 的 503 control_plane_unavailable 行为一字不动 ｜ 证据: a9ceb2f0
- [边界语义] 402 语义保留 — 预留先于生成不变；非 402 的其他错误码一个没动 ｜ 证据: a9ceb2f0
- [边界语义] 首充通道不可用 fail-closed 不给折扣 — 通道不可用时 fail-closed；前端只做显示闸门，真正执法在 checkout 403 与入帐时按正价折算 ｜ 证据: 1b592d5d
- [边界语义] 开发范例不编造 model id — PixAI id 走偏好序 + catalog 与可见白名单双重存在性检查，查无即不显示 ｜ 证据: 0cbd7c0c
- [边界语义] 个资不出边界 — email 属个资：永不进日志、永不进返回值，所有日志只印 user_id 与布尔状态 ｜ 证据: 86fb664b
- [边界语义] 邮件永不嵌入真实 key — curl 范例 key 位置只放 $EMU_API_KEY 占位符 ｜ 证据: a4be1a00
- [边界语义] 拒绝遥测不记敏感内容且绝不影响客户请求 — 只记 key 前 8 位、不记 prompt/完整 key；储存层错误静默吞掉；成功与 202 不记 ｜ 证据: af6c6a49
- [边界语义] 断路器 fail-open 与可回滚 — DB 失败 fail-open；GENERATION_MODEL_BREAKER_DISABLED=1 回滚；幂等重放例外 ｜ 证据: f009cf09
- [边界语义] 明确未做（诚实标注） — 团队支付下单（席位计价／续费／扣款）、任何团队前端 UI（片F 未做部分）、canvas 侧建画布接线（仅交付 canMemberCreateSharedCanvas）、解散执行接排程器（executeTeamDissolution 已幂等实作，需外部触发）、团队建立入口、席位 SKU、控制面副本同步、「团队共享画布」存储层 scope 维度（CanvasProject 目前 per-user，无 team/scope 栏） ｜ 证据: 2447c874 / c4c895d3
- [边界语义] 建画布闸在 Vercel 侧当时不生效 — /api/canvas/projects 不在 next.config.mjs 的 beforeFiles 代理清单内、由 Vercel 服务，而 Vercel 按设计不持有 GENERATION_DATABASE_URL / GENERATION_CONTROL_PLANE_ENABLED ⇒ governanceStoreEnabled()=false ⇒ 闸走「未配置→放行」；要真生效需三选一（皆超本片权限） ｜ 证据: c4c895d3
- [边界语义] 被拒时前端 403 降级 — client.ts 把 403 一律降级成 not_authenticated（既有静默降级设计，未改） ｜ 证据: c4c895d3
- [边界语义] timeline 孤儿子会话仍维持 404 — 父会话先被删／收尾时子成孤儿 → parentFallback=no → 维持 404（无主可归属）；byChildOc 是 in-memory，gateway 中途重启会回溯 miss ｜ 证据: 6d395e84
- [边界语义] 团队画布不做锁／CRDT／冲突解决 — 团队画布单写（后写覆盖）为刻意设计 ｜ 证据: c9696948
- [边界语义] 人工码禁止计入付费漏斗 — 人工码是行销／赔付，不是现金流入 ｜ 证据: bed6f558
- [边界语义] skill 索引唯一判死条件＝byte 0 不是 `---` — 同时推翻两个错误前提：name ≠ 目录名不是死因、frontmatter YAML 不合法不是死因（VPS 探针：name-mismatch 与 bad-yaml 都被收录） ｜ 证据: 19f7f257
- [边界语义] 未出图不扣费（B 端同步层） — 失败／超时回 OpenAI 错误信封，沿用 durable 退款语义 ｜ 证据: 8cb16aea
- [边界语义] /openai/v1 只列可出图模型 — 金钥白名单 + 目录 kind=image + 既有熔断／断供闸三闸共用 ｜ 证据: 8cb16aea

## 存疑（讯息不足以判断者，写明缺什么证据）

- 5da7919e 的 sd10 族形状假设（同 sd4 协议）自陈待有余额后实弹覆核；且同日 8d640263 把 cangyuansuanli 整条移除 ⇒ 该重映射的生产有效性无法从本批（含讯息与 diff）确认。缺：上游实弹提交证据。
- e27e3697 自陈未落地：控面端点需另行部署到 VPS（本次不部署）；pending/unknown 属人工核对路径。缺：部署与真单入帐证据。
- 8cb16aea 当时未部署（本批无生产验收），1b49771a 与 ea31d305 只是补上代理与部署依赖。缺：本批内的生产验收。
- c4c895d3 自陈「本片不宣称生产已生效」（见上 fail-open）；真生效需三选一，超本片权限、已回报待裁。
- 0cbd7c0c 自陈未落地：402 统一为 insufficient_balance 与 contract-lock.test.ts 的 insufficient_quota 契约锁互斥，依 spec 停下回报；次一 commit a9ceb2f0 以暴君裁定解锁。
- a8362440 真人浏览器端到端（打字→被挡→GitHub 回来→自动送出）未验（本环境无浏览器，认证红线禁 headless OAuth）。
- e33571e9 自陈未验：真生产发码与真实邀请链路端到端。
- 2d601be7 只拔 header 入口：通知组件本体（src/components/notifications/*）与通知／公告 API 未动，是否连机制一起撤等暴君一句话。
- 2890c923 的 orchestrator-beast-frame 两条既有 L152 红灯逐字未动、仍红（未掩盖），非本批新增能力；另 19f7f257 自陈全量测试 fail 恒为既有 2 条。
- 记忆冲突：`2026-09-27-team-seat-pricing-order-allocation.md` 写「本片未 commit（暴君指定）」，但 c9696948 确实提交了该三刀（档案与端点现场仍在）。以现场为准；差异仅在「是否 commit」的叙述，能力面无冲突。

---

## 逐条对帐（47/47，一个都没跳过）

2890c923 — 剪辑域 Agent 配方库＋persona 默认注入＋交付质检闸（Agent助理／创作域）
2447c874 — 团队治理六面 API（团队与企业）
32d9bf2c — 本机 GLB 导入 3D 场景卡（画布与工作流）
f009cf09 — 模型可用性断路器＋提交前 fail-fast＋替代模型建议（生成核心）
629b4ae5 — 新人礼首次登录发放＋回溯补发＋占位幂等（帐号与增长／控制平面与计费）
9218cabf — 激活漏斗卡＋内部流量剔除＋新用户首图耗时（运维与观测）
fc2c8053 — 新人礼站内通知每用户只一次（帐号与增长）
13983ce7 — Blender 一键导出＋一次性连接码＋上传多身份（画布与工作流）
bed6f558 — 兑换码分页全扫＋基线前两条腿＋人工码不记现金（控制平面与计费）
2d601be7 — 撤审查页＋拔 header 铃铛（边界与拒绝／前端与UI）
6d395e84 — timeline 族子代理身份 fallback（Agent助理）
19f7f257 — skill 索引 byte-0 修复＋索引守门测试（Agent助理）
c4c895d3 — 建画布闸接入落盘路径＋治理控制台 UI（团队与企业）
5da7919e — 上游模型名重映射＋欠费词表＋欠费 30 分钟冷却（模型与供应商）
782d3214 — 影片轮询窗口 1200s＋生成预算按 kind 分级（生成核心）
43decfd6 — 成品顶层 url 解析（模型与供应商）
a6cc34f0 — 通知入口搬进 API 密钥下拉＋面板挂 body（前端与UI）
a8362440 — 被登入挡下的话登入后自动补送（帐号与增长）
8d640263 — xiaoyxiao 唯一权威渠道＋付费上游成本硬闸（模型与供应商／边界与拒绝）
a27b6476 — 视频秒数上限 10＋三元组显式枚举（边界与拒绝）
c9696948 — 建画布闸真源 relay＋团队命名空间＋席位计价/下单接缝/分配（团队与企业／画布与工作流／控制平面与计费）
ed732c8e — 视频秒数上限 30＋三元组由 catalog 生成（边界与拒绝）
86fb664b — 已验证真实 email＋首触归因＋漏斗按来源拆分（帐号与增长／运维与观测）
d4b2a8b8 — 作品公开分享页＋做同款（帐号与增长）
586d83bd — 新人礼首登弹窗＋主按钮只预填（帐号与增长）
28aaed8d — minimax-h3 时长表补齐＋成本闸作用域收敛（模型与供应商／边界与拒绝）
9f883c61 — 生命周期邮件 welcome/nudge＋一键退订（帐号与增长）
be716f12 — 支付回跳自动兑换＋余额不足就地去充值（控制平面与计费）
2e44d778 — 纯修复（canvas-meta 测试型别，修控面 next build lint）→ 无新能力
350ef376 — 生命周期邮件三时刻重做＋品牌版式＋真实示例一点即填（帐号与增长）
43be7f6e — 欠费分类前置＋供给面断供判定（生成核心）
e33571e9 — 自签邀请码＋分享即邀请＋首图后自动发币（帐号与增长）
af6c6a49 — /v1 拒绝遥测 api_rejection＋出口拦截（B端API／运维与观测）
0cbd7c0c — 建 key 给可复制 curl＋OpenAI 兼容核对报告（B端API／非程式码）
e27e3697 — notify 直接入帐＋自签订单参数＋mapay_credit 占位幂等（控制平面与计费）
0f9e2962 — 纯文档（23 把外部 biz key 首调审计报告）→ 非程式码能力
a9ceb2f0 — /v1 余额不足统一 402 insufficient_balance＋契约锁同步（B端API／边界与拒绝）
1b592d5d — 首充专享限一次＋名额并发执法（控制平面与计费）
f5018d30 — 纯文档（审计口径重算 21 位外部持有者）→ 非程式码能力
8f2eaac2 — 纯规则（决策分界）→ 非程式码能力
a4be1a00 — key_idle 召回信（帐号与增长）
78a019a3 — 开发者新人礼自动补发＋排除口径改 INTERNAL_USER_IDS（帐号与增长）
dffaef5b — 纯文档（biz-api 两种接法＋new-api 加渠道填法）→ 非程式码能力
8cb16aea — /openai/v1 同步兼容层三路由（B端API）
1b49771a — 同步层加 beforeFiles 代理改控面执行（B端API／运维与观测）
29e6ca91 — 纯修复（maxDuration 段配置改字面量 300）→ 无新能力，暴露建置边界语义
ea31d305 — 纯文档（runbook：OPENAI_COMPAT_GENERATION_ORIGIN 部署依赖）→ 非程式码能力