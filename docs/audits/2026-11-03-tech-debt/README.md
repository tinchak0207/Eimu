# Eimu 技术债全面审计（2026-11-03）

范围：整个仓库（4593 个跟踪文件，约 48 万行 TS）。六条轴线并行只读扫描，明细见同目录 1–6 号报告。
方法：每条发现都带档案:行号或命令输出；编排者对每份报告的关键结论抽查过原码（见文末「抽查记录」）。
**局限**：git 历史被压成约 20 个提交（2026-10-19 至 10-24），无法用 `git log` 判断文件新旧；鉴权统计是文本匹配加人工抽读；安全项的利用路径均为静态推演，未实测；孤儿代码删除前须再确认动态 import。

## 一句话结论

代码本身（类型层面）并不烂：`tsc` 0 错误、前端 `any` 为 0。**烂在“真源不明”**：同一份代码有 2–4 份副本且无同步机制；有 4 个子树（deploy-staging、src/vendor-bridges、staging、全部测试）从未进入类型检查；生产部署无法从仓库重建；CI 的 test 闸门与项目自己的“不写测试”规则互相打架。

## 数字总览

| 项 | 数 | 来源 |
|---|---|---|
| 跟踪文件 / 非测试 TS 行 | 4593 / 约 48 万（含测试） | 1, 5 |
| 重复 blob 组 / 冗余副本占用 | 672 组 / 14.9MB（6.3%） | 1 |
| `tsc` 错误 / 覆盖文件数 | 0 / 1159（deploy-staging 非测试 112,811 行不在内） | 5 |
| `next lint` | 98 error / 216 warning（80 个在 vendor-bridges） | 5 |
| 测试档 / 代码占比 | 483 / 21.9%；按 CI 排除清单跑 403 档：4377 tests，9 fail，4 cancelled | 5 |
| 从不执行的 src 外测试 | 69 个 | 4, 5 |
| API 路由 | 244 个 route.ts，43 个无已知鉴权 helper（人工判定 22 个合理公开） | 3 |
| API 层 zod | 0（`src/app/api` 下）；整个 `src` 仅 5 个文件提到 zod | 3 |
| `src/lib` 根目录文件 / 循环依赖 | 488 / 28 个环 | 3 |
| 孤儿代码 | 27 个文件 6,245 行 | 3 |
| 运行时 `CREATE TABLE IF NOT EXISTS` | 25 张，其中 12 张在 db/migrations 里没有 | 3 |
| 前端 >600 行文件 | 37 个，最大 998 行；655 个 useState / 331 个 useEffect | 2 |
| 硬编码生产 IP `43.172.85.76` | 18 个文件 / 21 处 | 4 |
| 跟踪媒体 | 297 个 180MB，无 git-lfs；`.git` 187M | 5 |
| `npm audit` | 17 个（1 critical，12 high） | 5 |

## 一、P1 清单（按建议处理顺序）

### 安全（详见 6-security.md、3-backend.md）

1. **S-02 `/api/canvas/generate` 的 SSRF**：`source_image` 直接 `fetch(url, { redirect: "follow" })`，不限协议和内网地址，且错误信息回显状态码和 content-type（`src/app/api/canvas/generate/route.ts:154,235`）。报告称抓取发生在上游鉴权之前，匿名可触发，该点编排者未逐行确认。
2. **S-01 PWA 登录交接 ticket** 既在公开 URL 里又是唯一领取凭证，可钓鱼接管账号。
3. **S-06 `/api/payments/mapay/health` 匿名**：`?orders=` 数量不限，触发支付商查询并回显未履约单号和原始 `error.message`（已抽查：GET 内无任何鉴权）。
4. **S-07 `NEXT_PUBLIC_LOCAL_TEST_MODE=true` 即全站鉴权失效**，无生产闸（`src/lib/local-test-mode.ts:9,12`）。
5. **`/api/auth/wechat/qr`**：匿名每次 GET 都向写死公网 IP 明文 http 新建 bot 实体，无限流（`src/app/api/auth/wechat/qr/route.ts:8`）。
6. **`agent/memory/*` GET 对空 body 验 HMAC、无时间戳**：签名泄漏后可永久重放读取任意 `owner_key` 的私有记忆。
7. 秘密：未发现真实密钥（含 git 全历史），命中的都是测试夹具。

### 真源与部署（详见 1-duplication.md、4-infra.md）

8. **生产不可重建**：仓库里没有 agent-gateway / opencode-server / agent-poller 的 unit 和 `/opt/agent-harness/deploy.sh`；`deploy/vps/gateway-release.sh` 自陈“从未对生产执行”。
9. **poller 靠 base64 经 ssh 覆盖文件**，依赖未入库的 `.dsh-ssh/exec-443.js`；flowmusic2api 在生产机上 clone 上游 HEAD（未固定 commit）后打补丁再 build；asr-service 只有 `engine.py`，相对 import 的 4 个模块缺失。
10. **无 Postgres 与 sessions.db 备份流程**；10+ 服务挤在一台 4GB VPS；new-api / certbot 用 `:latest`。
11. **`src/vendor-bridges` 过期**：与 `deploy-staging/gateway` 相比 13 个文件已漂移，只有 4 个相同；缺 2026-10-02 的 ffmpeg-limiter（OOM 治本修复）。`tsconfig.json:43` 排除它，CI 也不编。
12. **director 引擎 4 份副本、无任何导出脚本**：`src/lib/director-engine` 最新（多 27 个武侠动作和“打斗”模板），其余三处都缺。
13. **5 个 `tools/export-*` 脚本 `--check` 全部失败**：`.gitignore:152` 的 `/staging/` 吞了导出目标（`staging/music-tools/` 有 8 个文件仍被跟踪）；CI 也没调用它们。
14. **skills 部署版比源码版新**：`blender-director/SKILL.md` 部署版有 2 处“能力闸门”，`skills/` 源码版 0 处，而 `src/lib/*persona.ts` 读的是旧的那份。
15. **music 真源方向反了**：`classifyFlowMusicFailure` 等线上补丁只在 staging 和部署 lib，`src/lib` 没有；`open-source/` 还有第四份分叉。
16. **三向副本有行为差异**：`blender-tools-impl.ts` 与 `blender_tools.ts` 桥鉴权头不同；`subtitleExport.ts` 部署版用了 Linux 上不存在的 PingFang SC 字体。

### 工程与 CI（详见 5-build.md、4-infra.md）

17. **CI 只有 typecheck、gateway-typecheck、test 三个 job**，全在自托管 runner；不跑 lint / build；gateway typecheck 忽略 `bun.lock` 且 `strictNullChecks`、`noImplicitAny` 都关；`opencode-runtime`（约 41,342 行）没有 tsconfig；desktop、mcp-server、bridge 不在 CI；Node 版本 24 / 24 / 22 不一致。
18. **`next.config.mjs:11-12`**：`VERCEL=1` 时同时 `ignoreDuringBuilds` 和 `ignoreBuildErrors`。
19. **测试存量与规则冲突**：`ci.yml` 的 test job 把测试当 push 闸门，而 `AGENTS.md` 说“不写测试、既有测试不当闸门”。`npm test` 原样 5 分钟跑不完（卡在 blender-e2e 等 3D bridge）。
20. **账号归属红线（前端）**：`src/hooks/use-auth.tsx:117-122` 挂载时直接拿 localStorage 里的 user/token 当登录身份，之后才异步刷新；agent 设置和思考级别的存储 key 不分账号。
21. **错误边界缺位**：全站只有根级 `error.tsx` / `global-error.tsx`，没有 `loading.tsx`、`not-found.tsx`，25 个 page 无段级 error。

## 二、P2 要点

- **后端结构**：鉴权/密钥方案至少 7 套互不复用；`/api/internal/*` 共用同一把 `GENERATION_BILLING_RELAY_SECRET`；54 个 route 把 `error.message` 回给客户端，响应形状 4 种以上；`.catch(() => null)` 类 204 处，账务模块 `store.mark(...).catch(() => {})` 会吞掉失败标记；“占位→改上游额度→核对前后额度”的账务逻辑在 6 个文件里各写一份（2,382 行）；计费闸 `paid-video-cost-gate` 在一个 8 节点环里。
- **数据库**：40 个迁移、编号无重复，但无任何 down 迁移，036 是 `.pending`；元价用 float（`plans.ts` 的 9.9 / 29.9），mapay 回调容忍溢付至 max(0.5 元, 5%)。
- **配置**：`process.env.X` 唯一变量名 127 个（gateway 另用 153 个，README 只文档化 1 个），无集中校验；生产域名 `tinchak0207` 出现在 26 个非测试文件；`/home/lenovo` 86 处，SSH 端口 22443 共 20 处。
- **前端**：`[#007aff]` 手写 176 次而 `ios-blue` token 已存在；`<img>` 70 处对 next/image 2 处；无 i18n，约 4,213 行中文文案写死在代码里；54 行台湾用语（使用者、载入、点选、滑鼠）；`src/app/openui-demo` 已提交且 middleware 不拦。
- **死代码**：`AgentChatPreviewClient.tsx`（852 行）、`CheckinCalendar.tsx`（251 行）、`src/lib/boards-store.ts` 无人 import；`kunpeng-knowledge.ts` 965 行零生产消费者。
- **依赖**：零引用依赖 5 个（`@atlaskit/pragmatic-drag-and-drop`、`@openuidev/react-headless`、`@radix-ui/react-select`、`ws`、`zustand`〔仅 vendor-bridges 用〕）；未声明却在 src 使用的包：`nanoid`、`sharp`；package-lock 与已过期的 pnpm-lock 并存（pnpm-lock 缺 11/45 个依赖）。
- **桌面端**：`contextIsolation` 开、`nodeIntegration` 关、preload 窄，这部分扎实；但无代码签名，更新只靠同源 `latest.yml` 的 sha512，无 Fuses，页面可指定任意 `gatewayBaseUrl`。
- **可观测性**：gateway 536 次直接 `console.*`，结构化日志只有 metrics 一处，无 Sentry / OTel；Gatus 只有 4 个探针，告警整段被注释。
- **vendored 第三方**：smartsearch 208 个文件 3.8MB，依赖包的 LICENSE 被剥掉；img2threejs（Apache-2.0，139 文件）存两份，且不在 `THIRD-PARTY-NOTICES.md`。
- **仓库卫生**：97 个文件被跟踪却匹配忽略规则；`.gitignore:108` 的 `/*.mjs` 会静默忽略根目录新增的 `.mjs`（如 eslint flat config）；ESLint 9 需要 flat config 而现为 `.eslintrc.json`，`npx eslint src` 直接 exit 2。

## 三、P3 与杂物

- 根目录 `eimu-agent-architecture.*`、`pelican.svg` 零引用；`render.yaml` 是另一站点（market）的配置；`DEPLOYMENT.md:50` 链到作者本机 Windows 绝对路径（共 3 处死链）；`pnpm-workspace.yaml` 是占位垃圾；`package.json` name 仍是 `ai-sdk-image-generator`；`vitest.config.mts` 是死配置（vitest 没装）。
- `docs/` 190 个文件里 133 个（70%）是时点快照，长期文档约 20 个。
- `tools/` 约 18 个一次性脚本，另有 3 个 `.ps1`（与 Arch Linux 声明矛盾）。
- 安全响应头（CSP / HSTS / nosniff / frame-ancestors）全站缺失；`napi_token` 30 天且非 httpOnly；`/api/lora-models` 匿名用服务端 PixAI key 代理。

## 四、AGENTS.md 自身的问题（详见 5-build.md 第 8 节）

159 行 / 29KB，其中 39 行是带日期的事故叙事；报告列出 7 对互相矛盾的规则，例如“禁自我 UI 检查”与“视觉改动部署前必做截图”、“不写测试”与 CI 跑测试、“禁自造辅助脚本”与 `tools/` 下 52 个文件、“不许自己停”与“连续 3 次探测无产出就停下问”、“禁止生产机 build”与“VPS 构建”相关条文。

## 五、建议的处理顺序

1. **本周**：S-02、S-06、wechat/qr 限流或鉴权、给 `LOCAL_TEST_MODE` 加生产闸、`memory/*` 签名加时间戳。这些改动都小。
2. **先定真源**：在 `src/` 与 `deploy-staging/` 之间选一边当唯一真源，另一边变成生成物，并让 `--check` 进 CI。先从 director、music、skills、vendor-bridges 四组开始。
3. **让部署可重建**：unit 文件、`deploy.sh`、备份脚本入库；flowmusic2api 固定 commit。
4. **CI 与规则对齐**：要么按 AGENTS.md 把 test job 降级、冻结必红的测试，要么改规则；`next.config.mjs` 的 ignoreBuildErrors 去掉；eslint 迁到 flat config。
5. **机械清理**：27 个孤儿文件、5 个零引用依赖、pnpm 残留、`openui-demo`、根目录杂物、媒体移出 git 历史或上 LFS。
6. **最后再动大文件拆分**：`ImagePlayground.tsx`、`CanvasEmbed.tsx`、`use-canvas-chat.ts`，以及账务逻辑 6 份合 1。

按 AGENTS.md 的规矩，这些改动落地后需要作者以外的人做 Hack 验收，测试结果不算证据。

## 抽查记录（编排者亲自核对原码）

| 结论 | 结果 |
|---|---|
| `use-auth.tsx:117-122` 用 localStorage 当登录身份 | 属实 |
| `openui-demo/page.tsx` 在、middleware 不拦 | 属实 |
| `AgentChatPreviewClient` 仅自身引用；根级 `error.tsx` 是仅有的 error 边界 | 属实 |
| `wechat/qr/route.ts:8` 默认明文 http 打写死 IP | 属实 |
| `gateway-release.sh` 自陈从未对生产执行 | 属实 |
| ci.yml 仅 3 个 job、全自托管 | 属实 |
| 生产 IP 出现在 18 个文件 | 属实 |
| `tsconfig.json` exclude 含 `src/vendor-bridges`、`deploy-staging`、`staging` | 属实 |
| `.gitignore:152` 是 `/staging/`，而 `staging/music-tools/` 有 8 个文件被跟踪 | 属实 |
| `blender-director/SKILL.md` 部署版 2 处“能力闸门”，源码版 0 处 | 属实 |
| 244 个 route.ts；mapay/health 无鉴权 | 属实 |
| zod 使用数 | 报告写“仅 2 个文件”，实测 5 个文件，本文已改；`src/app/api` 下为 0 的结论不变 |
| `canvas/generate` 的 `source_image` 直接 fetch 且 redirect follow | 属实；“早于鉴权”未逐行确认 |
| `LOCAL_TEST_MODE` 无生产闸 | 属实 |
| `.gitignore:108` 是 `/*.mjs`；`next.config.mjs:11-12` 在 `VERCEL=1` 时关 lint 和类型检查 | 属实 |
