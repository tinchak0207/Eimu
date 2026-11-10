# 审计 2：前端技术债（只读）

范围：src/app（除 api）、src/components、src/hooks、src/styles、src/types、src/middleware.ts。
口径：275 个 .ts/.tsx 非测试文件，共 71,982 行（范围内另有 61 个 *.test.* 未计入）。所有数字来自实际 grep/wc 命令；`useState` 等按调用次数（`grep -o 'useState[<(]'`）统计，不是行数。
仓库状态：只读，未改任何文件，未提交。

先说一个与任务前提不符的事实：**主前端没有 zustand store**。package.json 声明了 `zustand ^4.5.7`，但 src/ 里唯一引用 zustand 的是 `src/vendor-bridges/editor/adapter/editorStore.ts` 和 `src/vendor-bridges/opencode-tools/director_get_state.ts`。vendor-bridges 在 tsconfig.json:43 被 exclude，不属于 UI 状态管理。

---

## F1 巨型组件/超长函数：单函数 600–900 行，状态和职责高度耦合
【严重度 P1】
【证据】
- >600 行的文件 37 个，>400 行的 60 个，无 >1000 行（最大 998）。
- 最差 5 个，都是单个函数体撑起整个文件（以函数起止行算）：

| 文件 | 总行 | 主函数起止 | useState / useEffect / useRef / useCallback+useMemo |
|---|---|---|---|
| src/components/ImagePlayground.tsx（首页 `/` 的唯一客户端入口） | 978 | `:93` 起约 885 行 | 24 / 13 / 11 / 25 |
| src/components/canvas/CanvasEmbed.tsx | 998 | `:106` 起约 892 行 | 18 / 11 / 9 / 42 |
| src/hooks/use-canvas-chat.ts | 994 | `:110` 起约 884 行 | 20 / 3 / 25 / 18 |
| src/components/agent-chat/AgentComposer.tsx | 865 | `:70`–`:865` 约 795 行 | 8 / 4 / 9 / 13（本身是 memo 包装的单函数） |
| src/components/canvas/CanvasImageEditorDialog.tsx | 938 | `:36` 起约 900 行 | 21 / 5 / 6 / 6 |

- 其他：`CanvasLibraryPanel.tsx`（924 行，`:151` 起约 700 行，21 useState，6 次 fetch，里面还夹着 `upsertCanvasPack`、`useDebouncedValue`）；`AgentTemplateCarousel.tsx`（917 行，`:234` 起约 683 行，33 个 useRef、7 个 addEventListener）；`use-image-generation.ts`（859 行，hook 主体 `:247`–`:830`，583 行）。
- `AgentChatSurface.tsx` 19 个 useState，另有 `AgentChatSurface.session-actions.ts` 14 个 useEffect（全仓最高）。
- 全范围合计：useState 655、useEffect 331、useRef 379、useReducer 仅 2。>=10 个 useState 的文件 17 个；>=8 个 useEffect 的文件 4 个。
- `ImagePlayground.tsx` 同时承担：首页 promo gate（localStorage 读写 16 处）、生成参数、PWA 交接、欢迎礼弹窗、agent 面板和历史。import 区就有 60 行以上（`:1`–`:60`）。
【影响】
- 任何一处状态变化会重渲整个 900 行函数。`useCallback/useMemo` 在 CanvasEmbed 里用了 42 个，说明已经在为这个问题打补丁。
- 无法单独审查或测试某一职责。
- 首页 `/` 的 page.tsx（`src/app/page.tsx:1`–`33`）只是个壳，整个首页逻辑都在客户端 bundle。
【建议】
- 优先拆 ImagePlayground（promo gate、PWA、欢迎礼各自抽成 hook 或子组件）和 CanvasEmbed（已有 `canvas/embed/` 子目录，继续往里抽）。
- 用 useReducer 或外部 store 收敛 20+ 个 useState 的文件。
- 拆分前要有等价性证明（行多重集一致），不要靠测试。

## F2 死代码：整文件无人 import（两个，合计 1,103 行）
【严重度 P2】
【证据】
对 src/components 与 src/hooks 下 ~230 个非测试文件取 basename（`index.*` 取目录名），在所有非测试源码的 import/dynamic import/require 里匹配。只有两个无任何引用：
- `src/components/agent-chat-preview/AgentChatPreviewClient.tsx`：852 行，没有路由也没有 import。其他文件只在注释里提到它的名字（`AgentChatPanel.tsx:412`、`AgentPlanCard.tsx:58` 等，是视觉语汇来源），且该文件里有 6 处 `style={{`、`src="https://picsum.photos/seed/emu1/512/512"`（`:348`）。
- `src/components/CheckinCalendar.tsx`：251 行。仅被两个测试引用：`PricingQuality.test.ts:149` 把它列为文件名，`ui-copy.test.ts:35` 断言导航不再含它。
- 其他部分：`src/lib/boards-store.ts` 是全仓唯一使用 `idb-keyval` 的文件，没有任何非测试 import，只有 `ProfessionalWorkstation.test.ts:415` 读它的源码做断言。这是范围外但相关的证据，即 `idb-keyval` 依赖只服务于死代码。
【影响】
- 约 1.1k 行无人维护的代码。AGENTS.md 要求的"改前先 grep import"在这里是反向用例：它们可以安全清理。
- `AgentChatPreviewClient` 被注释当作"已批准的视觉真源"引用，删除前要先确认设计团队不需要它做参照。
【建议】
删除 `AgentChatPreviewClient.tsx`、`CheckinCalendar.tsx` 和 `boards-store.ts`，同时从 package.json 移除 `idb-keyval`；zustand 同理，除非 vendor-bridges 真被用到。

## F3 暂存/演示路由残留：openui-demo 上了公开路由
【严重度 P2】
【证据】
- `src/app/openui-demo/page.tsx`（146 行，`"use client"`）已提交到 git（`git ls-files` 可见）。
- `src/app/robots.ts:5` 把 `/openui-demo` 放进 NON_CONTENT_PATHS（robots 禁抓），但 `src/middleware.ts` 没有任何针对它的拦截，所以生产上可直接访问。
- 页面里硬编码 `https://store.tinchak0207.xyz/image-data/files/uploads`（`:17`）和 5 个 demo 素材；`DEMO_ITEMS` 用假 taskId（`task_demo_img_1` 等）。
- `src/lib/openui/rich-examples.ts:4` 的注释把它当作引用源。
- zz-tmp-*：`find src -iname '*zz-tmp*'` 和 `git ls-files | grep zz-tmp` 均为 0，AGENTS.md 要求的暂存路由当前已清理干净。
【影响】
演示页面是公开可访问的非产品页面（robots 只是君子协定）。
【建议】
给它加 `notFound()` 生产闸（`process.env.NODE_ENV === "production"` 时），或移到 dev-only 路由。

## F4 浏览器存储散落 52 个文件；账号隔离大体做对，但有三处漏洞
【严重度 P1（#3）/ P2（其余）】
【证据】
- 数量（src 全量，非测试，排除 api）：localStorage 158 行/52 文件，sessionStorage 28 行/10 文件，idb-keyval 1 处（仅 boards-store，死代码）。
- 前端范围内热点文件：ImagePlayground.tsx 16、use-creative-projects.ts 11、PricingSync.tsx 9、use-chat-panel.ts 7、Navbar.tsx 7、app/layout.tsx 5。
- 账号数据归属（对照 AGENTS.md「账号数据归属」）：
  - 做对的：agent 聊天存档 key 带账号（`agent-chat-persistence.ts:229` `agent-chat-session-v1:user:${ownerId}`），读取时必须经 `listAgentSessions()` 服务端核实后才展示（`use-agent-chat.ts:188`–`196`，注释"网络失败不展示未经归属核实的旧客户端缓存"）；生成历史按 `historyByUser[userId]` 分桶（`generation-cache.ts:168`）；`use-creative-projects.ts` 有 owner key。
  - 漏洞 1（P1）：身份源是 localStorage。`use-auth.tsx:117`–`122` 在挂载时直接用 `getStoredUser()`/`getStoredToken()` 同步 `setUser/setToken` 并把 `isLoading` 置 false，之后才异步 `fetchMe`。`use-agent-chat.ts:55` 的 `ownerId = user?.id` 因此来自本地快照，`storedOwner()`（`agent-chat-persistence.ts:225`）同样来自 `getStoredUser()`。AGENTS.md 明确说"不得用浏览器存储、设备 ID 或登录 token 代替账号身份"。`fetchMe` 失败且 transient 时（`use-auth.tsx:134` 附近）保留旧用户，意味着 token 过期/被替换的窗口内 UI 仍以旧账号渲染。`getStoredUser()`/`getStoredToken()` 在 54 处调用，覆盖 18 个文件。
  - 漏洞 2（P2）：`use-agent-chat.ts:188` 的 `loadLegacyPersisted()` 读取无归属的旧缓存 key，仅靠 `sessions.some(...)` 的服务端核对兜底，核对通过后写入当前账号桶（`:193`）。迁移逻辑本身合理，但没有退役时间点，旧 key 永远不会被清。
  - 漏洞 3（P2）：`agent-chat/AgentSettingsPopover`、`settings.ts:32`–`44`（`AGENT_SETTINGS_STORAGE_KEY`）和 `AGENT_THINKING_LEVEL_STORAGE_KEY`（`:108`/`:121`）是全局 key、不分账号；同一浏览器切换账号会继承上一个账号的 agent 设置和思考级别。设置本身不算敏感，但与"切换账号立即隔离旧状态"不符。
- 状态管理形态：无 zustand、无 react-query/SWR。手写 `useSyncExternalStore` 外部 store 8 处（use-history、use-creative-projects、use-pricing-revision、AgentComposer.local-file-mode、pricing-overrides、device-bridge-display、history-client-store、agent-display-preferences），createContext 4 处。客户端 `fetch(` 在 components+hooks 里 107 次/46 文件，没有统一数据层（admin 面板每个自己 fetch，`AdminBizKeys.tsx`、`CanvasLibraryPanel.tsx` 各 6 次）。
【影响】
- 同类职责（"带缓存的服务端资源"）有 8 套自写 store + 107 处裸 fetch，行为（重试、去重、失效、账号切换）各不相同。
- 漏洞 1 是 AGENTS.md 明令的红线，实际风险窗口小但属于架构上违反。
【建议】
- 把 `use-auth` 改为"本地快照仅用于乐观渲染并标记 `unverified`"，涉及账号归属的读写（聊天、资产、历史）等 `fetchMe` 成功后再放行。
- 为设置类 key 加 `:user:${id}` 后缀或登出时清除。
- 统一一个 `createServerBackedStore()` 工厂，收敛 8 个手写 store。

## F5 类型安全：非常干净，唯一债务是 eslint-disable
【严重度 P3】
【证据】
- `: any` / `as any` / `<any>` / `any[]`：0。`@ts-ignore`、`@ts-expect-error`、`@ts-nocheck`：0。`tsconfig.json` `strict: true`。
- `as unknown as`：9 处/9 文件，全部是窄化 window 扩展或泛型 JSON 解析：`AdminHome.tsx:38`、`AdminRoutingPanel.tsx:55`、`AdminStatistics.tsx:77`（同一个 marker 判断函数复制了三份）、`TeamConsoleClient.tsx:146`、`NodeBody.tsx:435`、`sound.ts:74`、`use-image-generation.ts:851`、`use-canvas-chat.ts:601`、`use-auth.tsx:114`。
- `eslint-disable`：94 处。构成：`@next/next/no-img-element` 62、`react-hooks/exhaustive-deps` 21（19 next-line + 2 line，分布在 16 个文件）、`react/no-danger` 8、`jsx-a11y` 3。热点：NodeBody.tsx 5、OpenUIArtifactSlot.tsx 5、use-canvas-chat.ts 4、CanvasNodePromptPanel.tsx 3、LoraLibraryPanel.tsx 3、AgentTemplateCarousel.tsx 3、workflows/page.tsx 3、workflows/[slug]/page.tsx 3。
【影响】
- 21 处 exhaustive-deps 压制是真正的风险点：它们集中在 use-canvas-chat、canvas-project-sync 等大 hook，正是陈旧闭包 bug 的高发区。
- 三份 `marker in candidate ? (candidate as unknown as T) : null` 复制粘贴，是缺一个共享类型守卫。
【建议】
- 逐处复核 21 个 exhaustive-deps 压制，能用 ref 或 useEffectEvent 的改掉。
- 抽出共享的 `asMarked<T>()` 工具。
- 这一项不必优先做，整体类型纪律是亮点。

## F6 硬编码文案：无 i18n 框架，4,213 行 CJK 文案直接写在 JSX/源码里
【严重度 P3（当前只做中文市场，属设计取舍）】
【证据】
- package.json 无 i18n 依赖；`layout.tsx:138` `lang="zh-CN"`。
- 含 CJK 的非测试文件 265/275；非注释的含 CJK 行 4,213。
- 部分集中管理：`src/lib/ui-strings.ts`、`site-copy.ts`、`checkin-copy.ts`，但绝大多数页面（`mcp/page.tsx`、`use-cases/[slug]/page.tsx`、`docs/*`）把长文案内联在组件里。
- 硬编码 URL（范围内、非注释，排除 w3.org）：36 行/22 文件。其中 `https://schema.org` 17（JSON-LD）、`https://eimu.dev` 10（`use-cases/[slug]/page.tsx` 6、`workflows/[slug]/page.tsx` 4）、`https://store.tinchak0207.xyz` 2（`openui-demo/page.tsx:17`、`status/page.tsx:8`）、`qun.qq.com` 1、`picsum.photos` 1（死代码里）。站点域名已有 `getSiteUrl()`，但 `eimu.dev` 仍有 10 处绕过它。
【影响】
- 想做英文版需要全量改造。文案修改要在 265 个文件里 grep。
- 域名硬编码使预发/自托管环境产出错误的 canonical 或结构化数据 URL。
【建议】
- 不建议现在上 i18n 框架（产品只做大陆）。
- 把 `eimu.dev` 的 10 处改成 `getSiteUrl()`；`status/page.tsx:8` 的 gatus 地址改走 env。

## F7 硬编码颜色大量绕过 tailwind token
【严重度 P2】
【证据】
- `tailwind.config.ts` 已定义 `ios.blue = #007AFF` 等整套 iOS 系统色，`ios-blue` 类使用 371 次，说明 token 在用。
- 但同时存在：`[#007aff]` / `[#007AFF]` 任意值 176 次（`use-cases/[slug]/page.tsx` 14、`mcp/page.tsx` 13、`workflows/[slug]/page.tsx` 10、`use-cases/page.tsx` 9、`docs/mcp/page.tsx` 9），即与 `ios-blue` 完全等价的色值被手写。
- 任意值十六进制类 `xxx-[#RRGGBB]` 共 722 次/99 文件。原始 `#RRGGBB` 非注释行 606 行/110 文件，热点：AdminStatistics.tsx 30、AdminRoutingPanel.tsx 23、StatusDashboard.tsx 23、AdminBizKeys.tsx 20、DevAppendix.tsx 18。admin 目录合计 149 行。高频色值：#007aff 181、#2878d0 41、#a82d24 31、#242830 23、#d99024 21、#ff3b30 20（= ios-red）、#248a3d 20。
- 任意值 rgba/hsl 颜色类 952 次；rgba/hsl 字面量 905 处；`style={{` 128 次/49 文件（CanvasImageEditorDialog.tsx 13、CanvasStageOverview.tsx 8、CanvasEngineeringPanel.tsx 8）。
【影响】
- 违背 AGENTS.md "品牌验收遵循 tailwind.config.ts token"。改一次主色要改 176+ 处；暗色/主题切换无法生效；admin 与 status 页面视觉自成体系。
- 注意：本审计未做视觉检查（AGENTS.md 禁自我 UI 检查），仅统计。
【建议】
- 先做机械替换：`[#007aff]`→`ios-blue`、`[#ff3b30]`→`ios-red` 等已有 token。
- `#2878d0/#a82d24/#242830/#d99024/#248a3d` 这些重复出现的非 token 色，要么补进 tailwind 作为语义 token，要么确认是有意的 admin 专用色。
- 加一条 ESLint 规则或 CI 计数门禁，防止继续增加。

## F8 繁体字污染：UI 文案基本干净，污染的是"繁体用语"和极少量注释
【严重度 P3】
【证据】
- 用约 190 个"繁体独有字"（這個為說們會設後檔與務體訊錄選項點開關閉進連線應該裡麼圖頁碼…）做 `grep -P`，必须 `LC_ALL=C.UTF-8`，否则默认 C locale 下 PCRE 按字节匹配会得到 11,563 个全是误报；已排除并验证）。
- 结果：275 个文件里命中 2 行，且均在 JSX 注释内（`CanvasChatWorkstation.tsx:500`「改回傳」，另一处 `PricingClient.tsx:265` 的"惠"是简繁同形的误报）。**UI 字符串里 0 处繁体字**。
- 但存在"简体字+台湾用语"：对 ~35 个台湾词（使用者、滑鼠、萤幕、讯息、载入、点选、帐号、连结、预设、内建、支援、相容、软体、档案、登入、位址、伺服器、汇出…）做非注释行统计，命中 54 行/30 文件。例子：`openui-demo/page.tsx:128` "点选回传"、`docs/api/DevAppendix.tsx:78` "载入失败"、`DevAppendix.tsx:202` "无法载入 OpenAPI spec"、`mcp/page.tsx:348` "重新载入"、`docs/mcp/page.tsx:142` "使用者"、`mcp/page.tsx:476` "使用者／客户端"。出现在注释里的更多（总命中 783 行，非注释 92 行里含"设定""影片"这种大陆也常用的词）。
- 注释里大量使用台湾词汇，例如 `src/app/.well-known/oauth-protected-resource/route.ts:4`–`:36`（登入、位址、伺服器、汇出、档）。
【影响】
- AGENTS.md 要求"只做大陆生意，繁体＝污染"。字形层面合规；词汇层面有约 54 行 UI 可见文案带台湾用语（如"使用者""载入""点选""滑鼠"），大陆用户会感觉别扭，但不是繁体字。
【建议】
- 把"使用者→用户、载入→加载、点选→点击、滑鼠→鼠标、萤幕→屏幕、讯息→消息、帐号→账号"做一次定向替换（仅 UI 字符串，约 54 行）。
- 在 ESLint 或 CI 里加这批词的禁用清单。

## F9 Next.js 用法：'use client' 占比高，错误边界和 loading 几乎缺位
【严重度 P1（错误边界）/ P3（其余）】
【证据】
- `'use client'` 文件 176/275（64%）。components 150/201（75%），hooks 17/28，app 9/42。
- app 层只有 `src/app/error.tsx` 和 `src/app/global-error.tsx`；`error.tsx`/`loading.tsx`/`not-found.tsx` 在任何子路由段（admin、agent、history、pricing、settings、workflows 等 25 个 page.tsx）里都不存在，全站没有 `not-found.tsx` 和 `loading.tsx`。组件级 ErrorBoundary 只有 5 个文件：CanvasErrorBoundary、CanvasEmbed、CanvasEmbedView、AgentOpenUIBlock、AgentMarkdown。
- 首页 `src/app/page.tsx`（33 行）→ `ImagePlayground`（978 行 `"use client"`），所以首页 JS 全量客户端，SSR 只产出壳。
- page.tsx 里的客户端逻辑：`auth/complete/page.tsx`（105 行）、`wechat-login/page.tsx`（54 行）、`openui-demo/page.tsx`（146 行）是 `"use client"` 页面；`status/` 下 `StatusDashboard.tsx` 248 行 + `GenerationJobLookup.tsx` 184 行客户端。其余 page.tsx 是服务端；但 `mcp/page.tsx`（572 行）、`use-cases/[slug]/page.tsx`（637 行）把长篇静态文案和数据内联在 page 文件里。
- 元数据覆盖：25 个 page.tsx 中 22 个有 metadata/generateMetadata。静态生成：`use-cases/[slug]`、`workflows/[slug]`、`skills/[id]` 有 `generateStaticParams`，`dynamicParams=false`。
- `src/middleware.ts`：271 行，matcher 单一全覆盖（`/((?!_next/static|_next/image|favicon.ico).*)`，`:55`），内含 control-plane 代理逻辑（超时、缓冲、`NextResponse.rewrite`、`new RegExp` 判准）。其中约一半是注释（解释 rewrite 绕过的历史事故）。它对所有请求跑一次路径正则，未命中即 `next()`，开销可接受，但把"路由 + 代理 + 脱敏"都放在 middleware 里职责偏重。
【影响】
- 子路由发生渲染错误时全部落到根 `error.tsx`，用户失去页面上下文（例如 admin 面板一个组件抛错整页被替换）。
- 缺少 `loading.tsx` 导致 SSR 页（pricing、history）无流式骨架。
- 64% 客户端文件在这类产品（画布、聊天）里属正常，不是主要问题。
【建议】
- 给 `admin/`、`agent/`、`history/`、`settings/`、`pricing/` 各加一个段级 `error.tsx`，补一个全站 `not-found.tsx`。
- 把 `mcp/page.tsx`、`use-cases/[slug]/page.tsx` 的数据块挪到 `src/lib/`，page 只做组装。
- middleware 里的 control-plane 代理长期可以搬到 route handler，当前不必动。

## F10 性能/可访问性：three.js 处理得当，图片基本不走 next/image
【严重度 P2】
【证据】
- three.js：`engine.ts`、`scenes.ts` 顶层 `import * as THREE from "three"`，但入口 `PricingStage3D.tsx:34`–`36` 用 `import("./engine")` 动态加载；`DirectorMiniViewport.tsx:394`、`Scene3dGltfViewport.tsx:88` 同样动态 import `@/lib/director-engine/engine`。`PricingPlanCarousel.tsx:8` 静态 import 的是 `PricingStage3D`（壳），不是 engine。结论：three 没进主 bundle，做得对。`browser-image-compression` 也是动态 import（`DirectorMiniViewport.tsx:310`）。
- `next/dynamic`：PromptInput、CanvasChatWorkstation、AgentMarkdown 共 3 个文件用；`CanvasEmbed` 以 `ssr:false` 动态加载（`CanvasChatWorkstation.tsx:22`）。
- 图片：`<img` 70 处/42 文件，`next/image` 只在 3 个文件 import、`<Image` 2 处。62 处 `eslint-disable @next/next/no-img-element`。热点：NodeBody.tsx 5、OpenUIArtifactSlot.tsx 5。`loading="lazy"` 仅 22 处。单行 `<img ... >` 没有 alt 的检出为 0（8 个匹配经核对都是注释），多行 `<img` 33 处未逐一核对 alt。
- 可访问性：`aria-label`/`role=` 447 处；`<div|span onClick` 3 处，且都没有 role。`dangerouslySetInnerHTML` 12 处（layout.tsx 3 处是 JSON-LD 和启动脚本，其余未逐一审）。
【影响】
- 生成图片来自外部 blob，next/image 优化未必适用，`<img>` 本身是有意取舍，但 70 处里只有 22 处懒加载，图库、历史页等长列表会一次性拉取全部缩略图。
- 3 个可点击的 div/span 无键盘可达性。
【建议】
- 给 HistoryCard、AgentAttachmentCards 等列表型 `<img>` 统一补 `loading="lazy"` + `decoding="async"` + 显式宽高（避免 CLS）。
- 3 个无 role 的 `onClick` 容器改 `<button>`。

## F11 其他观察
【严重度 P3】
- 测试：范围内仍有 61 个测试文件（源码字符串断言型居多，如 `ui-copy.test.ts:35`、`ProfessionalWorkstation.test.ts:415` 读源码做 regex 断言）。按 AGENTS.md 2026-10-04 规定属历史资产，不扩张、不当证据，此处只记录。
- `components/` 根目录平铺 28 个 .tsx；最大子目录 `canvas/` 18,269 行、`agent-chat/` 13,096 行、`admin/` 4,101 行；hooks 28 个文件共 8,088 行。
- 目录命名不一致：`agent-chat` 与 `agent-chat-preview`、`canvas` 与 `canvas-workstation`、`image-playground` 与 `ImagePlayground.tsx` 并存。

---

## 量化总表

| 指标 | 数值 | 命令口径 |
|---|---|---|
| 范围内非测试 ts/tsx 文件 | 275 | find（排除 src/app/api、*.test.*） |
| 总行数 | 71,982 | wc -l |
| >600 行文件 | 37 | wc -l 过滤 |
| >400 行文件 | 60 | wc -l 过滤 |
| 最大文件 | 998（CanvasEmbed.tsx） | |
| 最长单函数 | 约 900 行（CanvasImageEditorDialog / CanvasEmbed / ImagePlayground） | 函数起行到文件尾 |
| useState / useEffect / useRef 调用 | 655 / 331 / 379 | grep -o |
| useState >=10 的文件 | 17 | |
| zustand store（主前端） | 0（仅 vendor-bridges 2 文件） | |
| 手写 useSyncExternalStore store | 8 | |
| createContext | 4 | |
| 客户端 fetch( 调用 | 107 次/46 文件 | components+hooks |
| localStorage 引用 | 158 行/52 文件 | src 全量非测试非 api |
| sessionStorage 引用 | 28 行/10 文件 | 同上 |
| idb-keyval | 1 处（死代码 boards-store） | |
| getStoredUser/Token 调用 | 54 处/18 文件 | |
| `any`（含 as any / any[]） | 0 | |
| `as unknown as` | 9 | |
| @ts-ignore / expect-error / nocheck | 0 / 0 / 0 | |
| eslint-disable | 94（img 62、exhaustive-deps 21、no-danger 8、jsx-a11y 3） | |
| 无引用的组件文件 | 2（AgentChatPreviewClient 852 行、CheckinCalendar 251 行） | basename import 匹配 |
| 暂存/演示路由 | openui-demo 1 个；zz-tmp-* 0 个 | |
| 非注释 CJK 文案行 | 4,213（265 文件含 CJK） | |
| 硬编码 URL（非注释） | 36 行/22 文件，其中 eimu.dev 10 | |
| `#RRGGBB` 非注释行 | 606 行/110 文件 | |
| 任意值十六进制颜色类 | 722 次/99 文件（其中 [#007aff] 176） | |
| token `ios-blue` 使用 | 371 | |
| 任意值 rgba/hsl 颜色类 | 952 | |
| `style={{` | 128 次/49 文件 | |
| 繁体字（非注释，UI 字符串） | 0 | LC_ALL=C.UTF-8 + grep -P |
| 繁体字（注释） | 1–2 行 | |
| 台湾用语（非注释 UI 行） | 54 行/30 文件 | |
| 'use client' 文件 | 176/275（64%） | |
| error.tsx / global-error.tsx | 2（仅根级） | |
| loading.tsx / not-found.tsx | 0 / 0 | |
| 组件级 ErrorBoundary 文件 | 5 | |
| page.tsx（不含 api） | 25，其中 22 有 metadata | |
| middleware.ts | 271 行，单 matcher | |
| `<img` / next/image `<Image` | 70 处/42 文件 / 2 处 | |
| `loading="lazy"` | 22 | |
| three 动态加载 | 是（engine 经 import() 懒加载） | |
| aria-label / role= | 447 | |
| 无 role 的 div/span onClick | 3 | |
| 测试文件（范围内，仅记录） | 61 | |

## 优先级排序（给主 agent 汇总用）
1. P1 F4 漏洞 1：auth 身份源仍是 localStorage 快照（违反账号数据归属红线）。
2. P1 F9：全站无子路由 error.tsx/loading.tsx/not-found.tsx。
3. P1 F1：ImagePlayground / CanvasEmbed / use-canvas-chat 等 900 行级单函数。
4. P2 F7：176 处 `[#007aff]` 与 722 处任意值十六进制绕过 token。
5. P2 F2/F3：两个无引用文件 1,103 行、openui-demo 公开可访问、`idb-keyval`/`zustand` 依赖基本无用。
6. P2 F10：70 个 `<img>` 仅 22 处懒加载。
7. P3：F5 eslint-disable 压制、F6 硬编码域名、F8 台湾用语。
