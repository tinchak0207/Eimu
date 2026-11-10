# 审计 3：后端 / 业务逻辑技术债

范围：src/lib、src/app/api、worker/、db/migrations、src/data。只读审计，未修改仓库、未提交、未运行任何生产请求。
Oracle：全部数字来自本次在容器内对工作树实际执行的 grep / find / wc / madge 命令。Hacker/验证者：本审计人（只做静态阅读，不构成对漏洞的实际利用验证，下文"利用路径"均为推演，标注【未实测】）。
方法限制：鉴权统计基于"route.ts 内是否出现已知 helper 名"的文本匹配，再人工抽读未命中者；中间件 `src/middleware.ts` 与 `next.config.mjs` 的 rewrite（把 `/v1/*`、`/api/v1/*` 等直接代理到控制面）不在此范围。

---

## 总览结论

后端整体纪律不差：没有 `sql.unsafe` 拼用户输入、内部端点普遍 fail-closed、金额主账为 bigint、不少路由头注释写明了红队修复史。主要技术债集中在 **结构（src/lib 扁平 + 28 个循环依赖 + 6245 行孤儿代码）、运行时 DDL（25 张表无迁移）、鉴权方案碎片化（≥7 套互不复用的共享密钥/HMAC）、零 schema 校验（zod 在 API 层 0 使用）**。未发现可直接利用的 P0。有 2 个 P1（未鉴权的昂贵/敏感端点）。

---

## 1. src/lib 扁平化严重，且有 28 个循环依赖

【严重度 P2】
【证据】
- `find src/lib -maxdepth 1 -type f` = 488 个根目录文件（其中非测试 290，测试 198）；子目录仅 27 个。src/lib 总计 896 个 ts/tsx，非测试代码 135,969 行。
- 命名前缀聚类（根目录文件数）：`agent-*` 62、`generation-*` 19、`music-*` 17、`biz-*` 15、`blender-*` 13、`asset-*` 13、`mapay-*` 11、`history-*` 11、`admin-*` 11、`character-*` 8、`workflow-*`/`team-*`/`reddit-*`/`local-*`/`image-*`/`expert-*` 各 7。其中 agent-* 已部分模块化为 `agent-chat-client/ agent-chat-reducer/ agent-chat-types/ agent-memory-store/ agent-skills/ agent-templates*/` 等 7 个目录，但 62 个散文件仍在根目录；`biz-*`、`mapay-*`、`admin-*`、`music-*`、`blender-*`、`history-*` 完全没有成目录。
- 最大目录 `generation-core` 145 个文件（是唯一一个真正成模块的）。
- `npx madge --circular --extensions ts,tsx --ts-config tsconfig.json src/lib`：Processed 932 files，**28 个循环依赖**（原始输出：scratchpad/madge.txt）。典型：
  - 一条 12 节点环：`character-cards.ts > agent-chat-client.ts > agent-chat-client/auth.ts > agent-chat-client/types.ts > agent-chat-types/types-events.ts > canvas/types.ts > canvas/storyboard-shots.ts > agent-output-cards.ts > storyboard-contract.ts > storyboard-contract/bridge.ts > normalize.ts > types.ts`（类型层与业务层互相引用，`canvas/types.ts` 反向依赖 `storyboard-shots.ts`）。
  - `generation-core/types.ts ↔ failure-record.ts ↔ video-post-production.ts ↔ paid-video-cost-gate.ts ↔ supplier-channels.config.ts ↔ supply-registry.ts ↔ blender-node-upstream.ts ↔ failure-classifier.ts`：**计费闸 `paid-video-cost-gate` 位于一个 8 节点环内**，且 `types.ts` 依赖具体实现文件。
  - `use-cases.ts` 与 5 个 `reddit-use-cases-*.ts` 互相 import；`new-api-auth-server.ts ↔ newapi-session-token.ts`（鉴权链路）；`agent-skills/index.ts ↔ registry.ts`；`expert-contract ↔ screenwriter-delegate`。
  - 注意：madge 对 `import type` 也计边，纯类型环在运行时无害，但 `new-api-auth-server ↔ newapi-session-token`、`use-cases*` 是值环，存在 TDZ/初始化顺序风险。
【影响】新人找不到归属；改 types 引起整环重编译；环内模块无法单测隔离；任何"计费闸"改动牵动 8 个文件。
【建议】先把 `biz-*`(15)、`mapay-*`(11)、`admin-*`(11)、`music-*`(17)、`blender-*`(13) 各收成目录 + index；把 `generation-core/types.ts` 改成只含类型、不 import 实现文件（把 `video-post-production` 的类型下沉到 types）；`canvas/types.ts` 不再 import `storyboard-shots`。CI 加 `madge --circular` 门（允许名单起步）。

---

## 2. API 路由：鉴权方案碎片化，两个 P1 未鉴权端点

### 2.1 鉴权统计

【严重度 P2（碎片化）】
【证据】`find src/app/api -name route.ts` = **244**（另有 43 个 `route.test.ts`）。项目内鉴权 helper：
- 用户身份：`requireVerifiedUser`(server-user.ts:47，调上游 /api/user/self 验证)、`authenticateImageUser`(image-billing)、`resolveAgentCaller`(agent-session-guard.ts:33)、`resolveSkillOwner`(skills/mine/owner.ts)
- 管理员：`requireAdminSession`(admin-session.ts:40)、`getAdminSession`、`gateway-admin`
- B 端 key：`authenticateBizApiKey / guardBizApiKey`(biz-api-key-store / biz-api-keys)
- 透传：`makeProxy`(proxy.ts:40，无 Authorization 头 → 401，真验证在上游 new-api)
- 内部/机机：`verifyBizKeySync` HMAC(biz-key-sync.ts:51)、`verifyBillingRelayRequest`、`CRON_SECRET`、`MEMORY_INGEST_SECRET`(memory-hmac.ts)、`IMAGE_UPSTREAM_PROBE_TOKEN`、`CALLBACK_WORKER_SECRET/INTERNAL_WORKER_SECRET`、workflow-completion key
- 回调验签：`verifyMapaySignature`、`verifyWechat*`、`verifyEmuOauthCode`、`verifyUnsubscribeToken`

各类命中 route.ts 数：用户身份 78、管理员 33（`/api/admin/*` 共 30 个，其中 28 个用 session，2 个用共享 token，见 2.3）、B 端 key 57、makeProxy 14、机机 HMAC/secret 20、回调验签 5。扣除后**43 个 route.ts 没有任何已知 helper**（清单 scratchpad/noauth2.txt）。人工逐个读后分类：
- 合理公开/弃用（22）：adobe/{callback,setup} 返回 410、auth/{login,register} 410、healthz、readyz、version(只回 builtAt)、camera-motion-presets、canvas/prompts(公共读，固定源)、desktop/releases、model-pricing、v1/{openapi.json,skus,templates}、skills、skills/[id]、user/model-eta、user/model-status、auth/{github,google,emu-oauth,wechat}/start、auth/handoff、payments/first-charge/eligibility（cookie 反查）、payments/mapay/test-callback（NODE_ENV=production 即 404 + token）、video-contract/generations（re-export v1 处理器，其内鉴权）。
- 自带非标准鉴权（5）：agent/memory/{export,history,ingest,retract,review} 全部 `verifyMemorySignature`；internal/platform-status 同；workflow-completion 自带 key 验签；checkin 与 token/* 等是把 `Authorization` 透传上游。
- 需要关注（见 2.2、2.3）：`payments/mapay/health`、`auth/wechat/qr`、`agent/optimize-prompt`、`lora-models`。
【影响】≥7 套互不复用的共享密钥/HMAC 方案，各自写 timingSafeEqual、各自处理"密钥未配置"。审计成本高，新增端点极易忘接。`/api/internal/*` 14 个端点共用同一把 `GENERATION_BILLING_RELAY_SECRET`（35 个源文件引用），泄漏一处即全通（计费、首充、欢迎礼、mapay 入账都在其下）。
【建议】抽一个 `withAuth({kind:'user'|'admin'|'biz'|'relay'|'cron', ...})` 路由包装器 + 一个"未包装路由必须在 allowlist"的 CI 检查；internal 各域用独立派生密钥（已有 `signatureDomain` 做了域分隔，但同根密钥）。

### 2.2 P1：`/api/payments/mapay/health` 无鉴权，可触发支付商/DB 查询并回显内部单号与原始错误

【严重度 P1】
【证据】`src/app/api/payments/mapay/health/route.ts:27-83`：无任何鉴权；`?orders=a,b,c` 逗号分隔任意订单号 → `reconcileMapayOrders({}, {orders})`（mapay-order-reconciliation.ts:424）逐笔查询支付商并读控制面 DB；响应体回 `paid_unfulfilled_orders`(未履约订单号列表)、`candidates/found/not_found/query_errors`、`last_fulfilled_at`；catch 分支回 `error: error.message`（:78 附近，原始异常文本）。`normalizeMapayOrderCandidates`(mapay-order-reconciliation.ts:352) 只做去重/格式过滤，未见数量上限（【未确认上限，grep 未命中 slice/MAX】）。
【利用路径（未实测）】匿名 GET `/api/payments/mapay/health?orders=<大量构造单号>` → 每个单号触发一次对支付商 `act=order` 的出站查询（放大攻击，可能触发支付商限流/封 pid，直接影响收款对账）；同时可探测订单号是否存在（not_found vs found）与读到所有"已付未履约"单号；异常时回显内部错误文本（可能含上游 URL、DB 报错）。
【影响】泄漏财务运营状态；对支付商接口的匿名放大；对账探针在被打爆时自身失真（反过来让真实告警失明）。
【建议】加 `requireAdminSession` 或 relay HMAC；`orders` 参数加上限（≤20）；catch 不回 `error.message`。

### 2.3 P1/P2 其它未鉴权或弱鉴权端点

【严重度 P1：auth/wechat/qr；P2：optimize-prompt、lora-models、admin 共享 token】
【证据】
- `src/app/api/auth/wechat/qr/route.ts:19-23`：匿名 GET 每次都 `POST http://43.172.85.76:8780/new-qr`（注释自述"扫码即建立新 bot 实体"），无限流无鉴权。同时目的地是**写死的公网 IP + 明文 http**（:8、`auth/wechat/start/route.ts:9` 同样 `http://43.172.85.76:8781`）。
  - 利用路径（未实测）：匿名循环请求 → 在微信 worker 上不断新建 bot 实体、使合法用户正在扫的 QR 失效（登录 DoS）；明文 http 链路上的中间人可替换返回的 `url`，导致登录二维码被换成攻击者码（钓鱼）。
- `src/app/api/agent/optimize-prompt/route.ts:27,65`：免登录调用 LLM（Agent 层 deepseek），限流是进程内 `Map` + 取 `x-forwarded-for` 第一段（可伪造，部署层若不覆写 XFF 则可无限绕过；多实例各记一份）。成本滥用面。
- `src/app/api/lora-models/route.ts:22-47`：匿名 GET，用服务端 `PIXAI_API_KEY` 代请求 PixAI，`keyword/category` 透传。只读，但是公开的上游额度代理。
- `src/app/api/admin/image-upstream-probe/route.ts:20-26` 与 `admin/sub2api-fix-groups/route.ts:23-31`：共用同一个环境变量 `IMAGE_UPSTREAM_PROBE_TOKEN`；一个能对上游图片接口发真实生成请求（单次 180s、`maxDuration=300`，直接花钱），另一个是自述"one-off remediation"的写操作（PATCH sub2api 账号分组），且错误时回 `raw: listBody`（:56 附近）。一次性脚本遗留在生产路由里。长度不等就提前返回（泄漏 token 长度，P3）。
- `agent/memory/*` 与 `internal/platform-status` 的 GET 请求对"空 body"验 HMAC（memory-hmac.ts 头注释"GET 没有 body → 对空 bytes 验签"），也就是**签名不覆盖 query string 和时间戳**：任何一次被截获/日志泄漏的 `x-memory-signature` 值，可对任意 `scope/owner_key/asOf` 永久重放读取全部私有记忆（`export/route.ts:38` 的 `owner_key` 直接取自 query）。无 timestamp、无 nonce。（对比 biz-key-sync 有 ±5 分钟窗口 `MAX_CLOCK_SKEW_MS`，biz-key-sync.ts:27）
【影响】见各条。
【建议】wechat/qr 加限流 + 把 worker 地址改成 env 必填 + https/内网；optimize-prompt 限流改走共享存储并用可信代理头；lora-models 至少加登录；删除 sub2api-fix-groups；memory-hmac 把 method+path+query+timestamp 纳入签名。

### 2.4 `x-user-id` 未校验头：已有显式警告，仅两处回落

【严重度 P3】
【证据】`server-user.ts:18` 的 `getStoredUserFromHeaders` 注释警告"绝不能拿来授权"，全库仅 agent-session-guard 注释提及，无调用方（grep 无非测试调用）。但 `auth/logout/route.ts:18-20`：当 `lookupUserIdByToken(token)` 查不到时，回落用客户端自带的 `x-user-id` 去 `rotateUpstreamAccessToken(token, userId)`；实际由上游校验 token 与 userId 匹配（newapi-session-token.ts:141-157），不可越权。`canvas/generate/route.ts:169` 与 `pixai/upload/route.ts:25` 读 `x-user-id` 但同文件另有 authenticateImageUser。结论：未见越权，但"读未校验头做业务判断"的模式仍存在。
【建议】logout 回落分支直接去掉。

### 2.5 输入校验：API 层零 zod，手写 parse 风格不一

【严重度 P2】
【证据】`package.json:55` 依赖 `zod ^4.6.7`，但 `grep -rln "from \"zod"` 在 src/ 仅命中 `src/lib/openui/eimu-library.ts`、`eimu-layout.ts` 两个文件（均非 API）；244 个 route.ts 中 **0 个** import zod。读 body 的 route.ts：109 个含 `.json()`；约 92 处 `await req.json()` 同行无 catch（粗略，grep 近似）；46 个 route 有自写的 `safeParse/parse/validateXxx/parseXxx`。`generation-jobs/route.ts` 自己常量 `MAX_PROMPT_LENGTH=8_000`、`optimize-prompt/route.ts` 另写 `MAX_PROMPT_LENGTH=4000`，限值各处自定。
【影响】缺 JSON 时 500 vs 400 不一致；字段类型/上限依赖作者自觉；无统一的 OpenAPI 与运行时校验同源（`v1/openapi.json/spec.ts` 手写）。
【建议】先给 `/api/v1/*`（对外 B 端）引入 zod schema + 共享 `parseBody()`，再推广。

### 2.6 错误处理风格不统一，且 54 个 route 把 error.message 回给客户端

【严重度 P2】
【证据】响应形状并存：`{success:false, message}`(138 个 route 文件含 `success: false`)、`{error:{...}}`(OpenAI 风格 42)、`{error:"..."}`(27)、`{ok:false,...}`。`error instanceof Error ? error.message` 出现 79 处 / 54 个 route 文件。非 admin 的外露点例子：`pixai/edit/route.ts:96-99`、`pixai/upscale/route.ts:34,148-151`、`v1/upscale/route.ts:339-342`（把 `超分任务提交失败：${message}` 回给 B 端用户）、`generate-videos/route.ts:289`、`auth/wechat/callback/route.ts:58`、`probe/stuck/route.ts:26`。fetch 失败的 `error.message` 可能含上游主机名/内网 URL。项目有 `sanitizeUpstreamMessage` 与 middleware 的外泄脱敏（proxy.ts:14-20），但并未在这些路径统一使用。
【影响】内部拓扑信息泄漏面；前端需要为每种形状写适配。
【建议】统一 `apiError(code, publicMsg)`，内部消息只进日志 + trace_id。

---

## 3. 数据库

### 3.1 SQL 注入面：低

【严重度 P3（信息）】
【证据】postgres.js 仅 `src/lib/generation-core/database.ts`、`artifact-service.ts` 直接 import；业务代码走 `getGenerationSql()`(215 处调用) 的 tagged template。`.unsafe(` 全库只有 2 处，均在 `tools/migrate-generation-db.ts:11,33`（迁移执行器，输入为仓库内 .sql 文件，无用户输入）。未发现 `sql(\`...${x}\`)` 式模板外拼接（grep 无命中）。
【结论】未发现可注入点。

### 3.2 迁移：编号连续，无 down，存在大量"运行时迁移"

【严重度 P1/P2】
【证据】
- `ls db/migrations` = 40 个文件，编号 001-040，无重复编号（`uniq -d` 空）。036 是 `036_generation_attempt_source.sql.pending`（被 runner 的 `.endsWith(".sql")` 过滤，永不执行，文件头自述"未套用草稿"），故实际已排序迁移 39 个，编号有洞。
- **没有任何 down / rollback 迁移**（`grep -iE 'down|rollback'` 0 个）。runner（tools/migrate-generation-db.ts）只做 forward + sha256 校验"已套用迁移被改"即抛错，无回滚机制；9 个迁移文件不含 `IF NOT EXISTS`（009、010、011、014、017、018、032 等，多为数据/约束变更，非幂等）。
- **运行时 DDL**：`grep -rniE "CREATE TABLE IF NOT EXISTS|ALTER TABLE" src` 非测试共 **29 处**，涉及 **25 张表**，分布在 18 个文件，各自带一个 `ensureSchema`（13 个 `function ensure*`）。其中 **12 张表在 db/migrations 里完全没有定义**：`agent_lessons, agent_user_keys, agent_user_profiles, emu_oauth_consumed, mapay_redemption_claim, music_charge, newapi_session_revocation, newapi_session_token, sync_idempotency_cache` 以及 `src/vendor-bridges/lib/image-journal.ts` 的 `tool_artifact/tool_project/tool_rate/tool_submission`。其余 13 张在迁移与运行时两处都有定义（如 `welcome-gift.ts:402-415` 还对 `welcome_gift_grant` 做运行时 `ADD COLUMN modal_seen_at`，与 026 迁移重复），存在两处定义漂移风险。
- 涉及金额/权益的运行时建表：`music_charge`(music-charge.ts:248)、`mapay_redemption_claim`(mapay-redemption.ts)、`newapi_session_token`。
【影响】schema 真相分裂；生产库权限需要持有 DDL 权限；首个请求承担建表延迟与并发竞态（多实例同时 `CREATE TABLE IF NOT EXISTS` 在 Postgres 下对同名并发有已知唯一约束竞态）；无法从 db/migrations 重建出完整库；无回滚。
【建议】把 12 张"仅运行时"表补成正式迁移，运行时 `ensureSchema` 退役（保留为只读断言）；约定迁移必须幂等；036 要么应用要么删除；至少给高风险迁移附手写 down 脚本说明。

### 3.3 同一"占位→改上游额度→核对前后额度"账务模式被复制 6 次

【严重度 P2】
【证据】`welcome-gift.ts`(635 行)、`mapay-credit.ts`(341)、`music-charge.ts`(370)、`admin-account-adjustment.ts`(378)、`referral-reward.ts`(342)、`first-charge.ts`(316) 合计 2,382 行；其中 4 个含完全同形的 `readUpstreamQuota` 前后对账 + `store.mark(..., "failed"/"unknown")`（welcome-gift.ts:233-258、mapay-credit.ts:128-142、admin-account-adjustment.ts:223-250、referral-reward.ts:102-114 几乎逐行一致），每个模块各带 `ensureSchema`、各带 `DEFAULT_RELAY_TIMEOUT_MS`（user-attribution 2_500、mapay-intake 8_000、welcome-gift 4_000、first-charge 4_000、mapay-orders 20_000、mapay-credit 8_000，6 处独立常量）。
【影响】改一个对账细节要改 4-6 处；`.catch(() => {})` 吞掉 `store.mark` 失败（welcome-gift.ts:233,245,258；mapay-credit.ts:128,142 等），失败标记写不进去时订单永远停在占位态而无告警。
【建议】抽 `claimThenAdjustUpstreamQuota()` 到 `ledger/` 模块，store 接口统一；`mark` 失败至少 `console.error` 带 order id。

---

## 4. 计费/金额：主账用整数，边缘用 float，签名用 MD5

【严重度 P3】
【证据】
- 额度/金币：`QUOTA_PER_COIN = 500_000`（quota-constants.ts:14）；迁移里 `amount/billing_amount/amount_quota/coins/term_quota/daily_quota` 全为 `bigint`（001:127,200；020:48；022:70；024:17；028:22；030:18；031:18；033；035:18）。cost 观测用 `numeric(18,6)`（001:20,80,170）。主账正确。
- 人民币价格是 JS number：`plans.ts:52,71,91` `price: 9.9 / 29.9 / 69`（元，float）；`mapay.ts:54 formatMapayMoney = value.toFixed(2)`；`mapay.ts:77-78 mapayMoneyMatches = Number(actual).toFixed(2) === ...`；`mapay.ts:82-89 mapayMoneyAcceptable` 用浮点 + eps 0.005，**接受"实付 ≥ 价格 且 ≤ 价格+max(0.5元, 5%)"**，即容忍最多 5% 溢付。非计费路径的 `Math.floor(price/coins*1000)/1000` 展示用（plans.ts:225,247）。
- 对 billing/payment/topup/credit/plan/seat/referral 等 25 个 lib 文件统计：`parseFloat` 0、`toFixed` 5、`Number(` 28、`Math.round` 23。
- 支付签名 `signMapayParams` 是 MD5（mapay.ts:56-64，由支付商协议决定）；`verifyMapaySignature` 用 `toLowerCase() ===` 比较，非 timingSafeEqual（mapay.ts:71-74）；notify 未校验 `pid` 与本站配置一致（notify/route.ts 无 pid 比对，依赖密钥签名）。
【影响】分/元换算在边界（9.9、29.9）下 toFixed 能工作但不可证明；溢付容忍窗口需要产品确认；MD5 签名无法更换。
【建议】对外价格以"分"整数存；`verifyMapaySignature` 改常量时间比较；notify 增加 `pid` 断言。

---

## 5. 配置与环境变量

【严重度 P2】
【证据】
- `process.env.X` 字面访问非测试唯一变量名 **127** 个，另有 **33** 处动态 `process.env[...]`（Next 的 DefinePlugin 内联对动态访问无效，version/route.ts 头注释就记录过踩坑）；197 个源文件直接读 `process.env`。无集中校验：没有 `env.ts`/zod env schema（src/lib 下仅 `provider-config.ts`、`model-routes.config.ts`、`supplier-channels.config.ts` 三个 config 模块，覆盖面远不到 127 个变量）。热点：`BLOB_READ_WRITE_TOKEN` 53 次、`GENERATION_CONTROL_PLANE_PROXY_ORIGIN` 45、`GENERATION_BILLING_RELAY_SECRET` 42、`GENERATION_DATABASE_URL` 40、`BIZ_API_KEY_HASHES` 39。
- `Number(process.env.X ?? default)` 无 NaN 防护 15 处，如 `database.ts:25` 池大小 `Math.max(1, Number(process.env.GENERATION_DATABASE_POOL_SIZE ?? 5))`（设成非数字 → NaN → `Math.max(1, NaN)`=NaN）。
- 环境变量默认值里的硬编码：`process.env.X ?? "https://..."` 模式 15 处。生产域名 `tinchak0207.xyz` 出现在 26 个非测试源文件、19 处非注释行，如 `agent-gateway.ts:22 AGENT_GATEWAY_DEFAULT_ORIGIN = "https://store.tinchak0207.xyz"`、`agent-prompt-optimizer.ts:30`、`subscription-redemption.ts:52`(`production` 下默认 `https://store.tinchak0207.xyz/newapi`)、`vendor-bridges/lib/client.ts:11,216`、`desktop-releases.ts:42,51`（含版本号文件名硬编码）、`lyric-player-url.ts:14`。**公网 IP + 明文 http**：`auth/wechat/qr/route.ts:8`、`auth/wechat/start/route.ts:9` 的 `43.172.85.76:8780/8781`。
- 密钥形态扫描：未发现 `sk-…`/`AKIA…`/私钥/JWT 字面量；`secret defaults ?? "..."` 无命中；命中的 40 位 hex 为 git commit（creator-resource-library.ts）、第三方 Next-Action ID（filmera-upstream.ts:22-28，非密钥）、sha256 校验和（desktop-releases.ts:45）。`.env.example` 仅占位（`git ls-files | grep ^\.env` 仅它）。
【影响】环境缺失在运行时才发现；换域名/换机需要全库改；明文 http 到公网 IP 的链路。
【建议】新建 `src/lib/env.ts`（zod）集中解析，启动期 fail-fast；域名、IP 全部走 env 且无默认或默认走相对路径。

---

## 6. 错误吞没

【严重度 P2】
【证据】（排除测试文件，grep 近似）
- 空 `catch {}`（单行）：src/lib 3、src/app/api 0、全 src 8；多行空 catch（只有注释/空体，perl 统计）：src/lib+src/app/api 57。
- `.catch(() => {})`：src/lib 18、全 src 50。
- `.catch(() => null|undefined|false|[]|{})`：src/lib 81、src/app/api 43、全 src 204。
- src/lib+src/app/api 共 1,259 处 `catch`。
- 热点（空 catch + 静默 catch 合计）：`welcome-gift.ts` 6、`auth/me/route.ts` 6、`newapi-session-token.ts` 5、`mapay-credit.ts` 5、`blender-tools.ts` 5、`admin-account-adjustment.ts` 5、`referral-reward.ts` 4、`music-charge.ts` 4。`adobe-oauth-token.ts:72,98` 有 `} catch {}`（token 刷新失败被吞）。账务类 `store.mark(...).catch(() => {})` 见 3.3。
【影响】账务状态写失败、token 刷新失败无信号；排障靠猜。
【建议】账务/鉴权模块禁止静默 catch（ESLint `no-empty` + 自定义规则 `no-swallow-catch-in-billing`）；`mark` 失败至少 error 日志。

---

## 7. 魔法数字与超时

【严重度 P3】
【证据】`AbortSignal.timeout(` 共 143 处，其中 54 处为字面量，值分布：8000×10、10_000×10、30_000×8、15_000×5、20_000×4、240_000×3、900_000×2 …共 15 种；另有 82 个命名常量 `*_TIMEOUT_MS`（同名 `DEFAULT_RELAY_TIMEOUT_MS` 在 6 个文件各自定义且值不同，见 3.3）。`setTimeout(…, 4+位字面量)` 在 lib/api 5 处。重试：`for (let attempt…)` 字面上限在 `music-lyria.ts:296(≤3)`、`direct-upload-client.ts:287(<2)`、`blender-tools.ts:718(≤2)`、`vendor-bridges/lib/client.ts:612(<2)`；命名重试常量仅 3 处。`maxDuration` 字面量：300 ×18、60 ×9；`preferredRegion = "sfo1"` 在 **240 个** route 里逐个手抄（每个都附同一句注释）。进程内限流/缓存 Map：lib/api 模块级 18 个（含 `image-billing.ts:52-53` 30 秒鉴权缓存，登出后最长 30 秒内同实例仍视为已登录）。
【影响】调优需要全库搜索；240 处重复的 region 声明改区域要改 240 个文件。
【建议】`src/lib/timeouts.ts` 集中 + 分级（relay/probe/upstream-submit/upload）；region 用 `next.config` 的 `regions`/统一导出。

---

## 8. 大文件与职责不清（src/lib 非测试 >700 行：18 个）

【严重度 P2】
【证据】`find src/lib worker -name '*.ts' -o -name '*.tsx' | grep -v .test.` 经 `wc -l` 筛 >700 行共 18 个：director-engine/engine.ts 1204、generation-model-catalog/catalog.ts 966、kunpeng-knowledge.ts 965、generation-core/worker-service.ts 952、music-prompt-director/rules-transform.ts 933、blender-tools.ts 890、character-cards.ts 888、history-types.ts 853、video-frames.ts 851、style-library.ts 786、music-take-entropy.ts 778、canvas/types.ts 766、mcp/tools/tools-definitions.ts 757、agent-skills/user-skill.ts 739、generation-core/mapay-order-reconciliation.ts 722、openui/repair.ts 715、device-bridge-display.ts 714、notification-store.ts 710。route.ts 最大 `generate-images/route.ts` 845 行，其次 `v1/images/generations` 591、`canvas/generate` 497。三个典型：
1. **`src/lib/kunpeng-knowledge.ts`（965 行，约 53KB 文本）是死代码**：文件头自述"当前未接入任何运行时注入链路，零生产消费者"；全库 import 仅 `kunpeng-assets.test.ts`（`agent-prompt-director.ts:30` 只是注释提及）；madge `--orphans` 同样判孤儿。逐字复制第三方 MIT 内容。
2. **`src/lib/director-engine/engine.ts`（1204 行）**：一个 `DirectorEngine` class 承载场景/灯光/网格/元素 diff 同步/raycast/TransformControls/OrbitControls/截图/equirect 背景/双 viewport/后处理（Bloom、OutputPass），头注释自述"逐行移植自 kunpeng-vendor、仅切除 Tauri"。已有 `engine/engine-helpers.ts`、`engine-types.ts` 但主类仍是单体，难以单测（three.js 命令式）。
3. **`src/lib/generation-model-catalog/catalog.ts`（966 行）**：开头一段 `build-cache-bust: 9d2f4a81c3e7 (2026-08-21)` 注释——**用修改源码注释来绕过 Vercel 构建缓存**，说明部署缓存失效机制不可信；文件顶部 import 数十个 `*_MODEL_ID` 常量（模型名、能力、价格同处一个超大目录），与 `pricing.ts`(64)、`pricing-overrides.ts`(165)、`capabilities.ts`、`knowledge.ts` 同目录但 catalog 依然是巨型数据表 + 逻辑混合。
另：`generation-core/worker-service.ts`（952 行）是生成任务队列/重试/计费结算的核心，单文件承担多阶段状态机。
【建议】先删 kunpeng-knowledge.ts（或移出 src）；engine.ts 按 scene/camera/controls/postfx 拆；catalog.ts 的数据表迁到 JSON/ts 数据文件，catalog 只留解析逻辑。

### 8.1 死代码（孤儿模块）

【严重度 P2】
【证据】`npx madge --orphans --extensions ts,tsx --ts-config tsconfig.json --exclude '\.test\.|\.spec\.' src` 在 src/lib 下报 34 个孤儿；再以 `grep -rlE` 跨 src/tools/deploy-staging/mcp-server/worker/desktop/bridge 复核，仍零引用的 27 个，合计 **6,245 行**：kunpeng-knowledge 965、drama-recipe 621、fashion-tryon-tools 483、ecommerce-product-adapter 476、biz-character-cards-route-suite 413、atc-tour-content 332、art-workflows/tool-registry 322、adobe-firefly-client 251、scenario-templates 238、novel-ip-visual-tools 212、canvas/node-metadata-audit 206、local-media-worker 202、agent-prompt-contract-check 195、boards-store 182、showcase-user-cases 162、creator-resource-library 153、openai-compat/upstream-stub 150、logos 112、agent-tool-adapter 93、agent-prompt-director 85、brand-kit 84、workstation-commands 83、director-engine/presetCameras 70、filmera-health 61、public-generation-summary 58、workstation-mobile-stage 21、reference-image-size 15。注意：AGENTS.md "记忆标记作废≠真死" 已提醒砍前须 grep；本清单已做 import grep，但动态 `import()` 字符串拼接、skill/脚本引用未能穷尽，删除前需再确认。
【影响】6,245 行不被任何生产路径引用，却占用扫描、类型检查、认知。
【建议】分批 `git rm`，保留历史。

---

## 9. 模型名 / 价格 / 渠道表散落

【严重度 P2】
【证据】
- 含 `gpt-image-2|seedance|gemini-3|kling|veo` 字面量的非测试文件 45 个（src/lib + src/app/api）。字面量 `"gpt-image-2"` 出现 37 次，分布于 supplier-channels.config.ts、model-routes.config.ts、plans.ts、generation-core/upscale-backend.ts、filmera-upstream.ts、showcase-cases.ts、creator-resource-library.ts、kunpeng-prompt-templates.ts、mock.ts，以及路由 `v1/object_info`、`v1/upscale`、`admin/image-upstream-probe`（`MODELS = ["gpt-image-2", "gemini-3.1-flash-image"]` 路由内硬编码）。`"gemini-3.1-flash-image"` 21 次，seedance/minimax 各变体 30+ 次。
- 价格/渠道表分处：`plans.ts`(329，套餐元价)、`tier-pricing.ts`(189)、`team-seat-pricing.ts`、`music-pricing.ts`(62)、`generation-model-catalog/pricing.ts`(64)、`tts-pricing.ts`、`generation-model-catalog/pricing-overrides.ts`(165，覆写应用) 与 **同名但职责不同的** `lib/pricing-overrides.ts`(162，Blob 持久化)、`pricing-runtime.ts`(15)、`tier-pricing-store.ts`；渠道/路由表：`supplier-channels.config.ts`(365)、`model-routes.config.ts`(105)、`provider-config.ts`、`channel-registry.ts`、`channel-overrides`。另有 `image-model-ids.js`（纯 JS 文件夹在 TS 库里）。含 `¥/元/CNY` 的非测试 lib 文件 18 个。
- 好的一面：存在 `GENERATION_MODEL_CATALOG` 与 `SUPPORTED_GENERATION_MODEL_IDS` 作为主表，并有 `normalizeModelPricingOverrides` 运行时覆写。
【影响】新增一个模型需改 ≥6 处（catalog、routes、channels、pricing、mock、admin 探针）；同名双 `pricing-overrides.ts` 易 import 错；价格漂移无法交叉校验。
【建议】单一 `models.ts` 数据表（id → 能力/价格/渠道），其它位置只引 id 常量；重命名 `lib/pricing-overrides.ts` → `pricing-overrides-store.ts`。

---

## 10. 其它观察

【严重度 P3】
- `worker/` 仅 `generation-worker.ts` 一个 14 行入口；实际 worker 逻辑在 `src/lib/generation-core/worker-service.ts`（952 行）与 `/api/cron/generation-worker`（cron 鉴权为 fail-closed，`CRON_SECRET` 未配置回 503，写得好——route.ts:38-60）。
- 类型逃生口低：`: any|as any|@ts-ignore|@ts-expect-error|@ts-nocheck` 在 lib+api 共 4 处，`@ts-nocheck` 0。`console.log|debug` 34 处，`TODO|FIXME|HACK|XXX` 5 处。
- `src/data/` 仅 `kunpeng-style-library.json`（1626 行），被 `kunpeng-style-assets.ts` 引用，正常。
- `src/vendor-bridges/`（86 个文件）是 lib 之外的第二个"lib"，含自己的 `client.ts` 写死 `API_BASE`（image.tinchak0207.xyz）与自己的运行时建表（image-journal.ts 的 4 张 tool_* 表）。
- 测试：src 下 414 个测试文件，其中 src/lib 根目录 198 个；依 AGENTS.md "测试不是 oracle" 规则，本报告未引用任何测试结果作为证据。

---

## 量化总表

| 指标 | 数值 | 命令 / 位置 |
|---|---|---|
| src/lib 根目录文件（含测试） | 488（非测试 290，测试 198） | `find src/lib -maxdepth 1 -type f` |
| src/lib 子目录数 | 27 | `find -maxdepth 1 -type d` |
| src/lib ts/tsx 总数 / 非测试行数 | 896 / 135,969 | find + wc |
| 最大根前缀簇 | agent-* 62；generation-* 19；music-* 17；biz-* 15 | sed/uniq |
| 循环依赖（madge, src/lib） | 28 | `npx madge --circular` |
| 孤儿模块（零引用） | 27 个 / 6,245 行 | `madge --orphans` + grep 复核 |
| src/lib >700 行非测试文件 | 18（最大 engine.ts 1204） | wc -l |
| route.ts 总数 | 244（+43 route.test.ts） | find |
| 用户身份鉴权 route / 管理员 / B 端 key / makeProxy / 机机密钥 / 回调验签 | 78 / 33 / 57 / 14 / 20 / 5 | grep |
| 无任何已知 helper 的 route | 43（人工判定：22 合理公开，5 自带非标鉴权，其余需关注 → P1×2、P2×3） | scratchpad/noauth2.txt |
| 鉴权/密钥方案种数 | ≥7 套 | 人工 |
| zod 在 API 层使用 | 0 / 244（全 src 仅 2 文件） | grep |
| 回显 error.message 的 route | 54 个文件 / 79 处 | grep |
| `sql.unsafe` | 2（仅迁移执行器） | grep |
| 迁移文件 / 重复编号 / down 迁移 / pending | 40 / 0 / 0 / 1（036） | ls |
| 运行时 DDL（CREATE/ALTER） | 29 处 / 25 张表 / 18 文件；12 张表无任何迁移 | grep |
| 金额 | 额度 bigint；元价 float（plans.ts:52,71,91）；mapay 容忍溢付 ≤max(0.5元,5%) | 读码 |
| `process.env.X` 唯一变量名 / 动态访问 / 读 env 的文件 | 127 / 33 / 197 | grep |
| env 集中校验 | 无 | — |
| 默认值含 https 域名的 env 读取 | 15 处；tinchak0207 域名 26 文件（19 处非注释） | grep |
| 写死公网 IP + http | 2 处（43.172.85.76:8780/8781） | grep |
| 密钥字面量 | 未发现 | grep |
| 空 catch（单行/多行） | 单行 lib 3、全 src 8；多行 lib+api 57 | grep/perl |
| `.catch(() => {})` / `.catch(()=>null…)` | lib 18、全 src 50 / lib 81、api 43、全 src 204 | grep |
| `AbortSignal.timeout` 总数 / 字面量 | 143 / 54 | grep |
| 命名 `*_TIMEOUT_MS` 常量 / 同名重复 | 82 / `DEFAULT_RELAY_TIMEOUT_MS` ×6 | grep |
| `preferredRegion="sfo1"` 手抄 | 240 个 route | grep |
| 含主流模型字面量的非测试文件 | 45；`"gpt-image-2"` 37 次 | grep |
| 同形账务"占位→核对额度"模块 | 6（2,382 行） | wc |

## 优先级排序（建议处理顺序）

1. P1：`/api/payments/mapay/health` 加鉴权 + orders 上限 + 不回 error.message。
2. P1：`/api/auth/wechat/qr` 限流 + worker 地址去硬编码、去明文 http。
3. P2：memory-hmac / platform-status 的 GET 签名纳入 query + timestamp；删除 `admin/sub2api-fix-groups`；`optimize-prompt` 限流改用可信客户端 IP + 共享存储；`lora-models` 加登录。
4. P2：12 张运行时建表补迁移；账务"占位→核对"模式抽公共模块并禁止静默 catch。
5. P2：引入 `withAuth` 包装器与 zod `parseBody`，先覆盖 `/api/v1/*`。
6. P2/P3：28 个循环依赖（先解 generation-core 计费闸那个 8 节点环）；删 6,245 行孤儿代码；env 集中校验；模型/价格单一数据表。
