# D3：控面代理清单抽单一真源＋漂移棘轮测试（预期 40 分钟）

工作目录 `/home/lenovo/Desktop/image-app`（Next.js 15，测试跑法 `npx tsx --test <档>`，node:test + node:assert）。

## 必读记忆
- `~/.claude/memory/MEMORY.md`（Tier-0）＋ `~/.claude/memory/packs/infra-deploy.md`
- `~/.claude/memory/notes/2026-09-28-control-plane-mirror-port-gap.md`：beforeFiles 代理清单是逐条列举；站点 route 若碰 GENERATION_DATABASE_URL 却没被代理 → 在 Vercel 跑、没 DB → 500/503
- `~/.claude/memory/notes/2026-09-28-control-plane-mirror-port-and-verify-recipe.md`：同上，含控面座标
- 记忆与现场证据冲突时以现场为准，并在回报中写明冲突。

## 背景
`next.config.mjs` 的 `rewrites().beforeFiles` 手写 10 条代理（`/v1/:path*`、`/api/v1/:path*`、`/api/generate-images`、`/api/generation-jobs`、`/api/generation-jobs/:path*`、`/api/admin/billing-operations/:path*`、`/api/internal/team-membership`、`/api/email/unsubscribe`、`/openai/v1/:path*`），每条都是 `source → ${controlPlaneOrigin}/image-control${source}`。`src/app/api` 下有约 212 支 route.ts，没有任何机制发现「需要控面 DB 却没被代理」的 route。

## 要做的事
1. 新档 `src/lib/control-plane-proxy-routes.mjs`（纯 ESM、无依赖）：
   - `export const CONTROL_PLANE_PROXY_SOURCES = [ ... ]`：上面 10 条 source，**顺序不变**；把 next.config.mjs 里每条 source 上方的说明注解**原文搬过来**放在对应元素上方。
   - `export function controlPlaneRewrites(origin)`：`origin` 为空回 `[]`，否则 `SOURCES.map(s => ({ source: s, destination: \`${origin}/image-control${s}\` }))`。
2. `next.config.mjs`：`controlPlaneRewrites` 阵列改成 `controlPlaneRewrites(controlPlaneOrigin)`（import 上面的档）。档尾那段 `CRITICAL: 控制面代理必须放 beforeFiles` 的长注解与 `beforeFiles`/`afterFiles` 结构**一字不动**。
3. 新档 `src/lib/control-plane-proxy-routes.test.ts`：
   - **行为不变断言**：`controlPlaneRewrites("https://o.example")` 深等于一份**在测试里逐字写死**的 10 条 `{source,destination}`（照改动前的 next.config.mjs 手抄，不许从被测模组推导）；`controlPlaneRewrites("")` 与 `controlPlaneRewrites(undefined)` 回 `[]`。
   - **漂移棘轮**：
     - 扫 `src/app/api/**/route.ts`，档案路径转 URL 路径（去 `src/app` 前缀与 `/route.ts`、去掉 `(group)` 段、`[id]`/`[...x]` 保留为一段字面）。
     - 「DB 绑定模组」＝ `src/` 下非 `.test.ts` 且原文含字串 `GENERATION_DATABASE_URL` 的档（测试执行时 grep 得出，不写死）。
     - 从每支 route.ts 做**递回 import 闭包**（只追 `src/` 内：相对路径与 `@/` → `src/`；解析 `.ts/.tsx/.js/.mjs/index.*`；`import type` 可跳过）。闭包碰到任一 DB 绑定模组 ⇒ 该 route 为「DB 绑定 route」。
     - 比对规则照 Next：精确字串相等；`/x/:path*` 只匹配 `/x/<至少一段>`（**不**匹配裸 `/x`，next.config.mjs 注解有写这个坑）。
     - 测试内一个 `KNOWN_VERCEL_LOCAL: Record<string, string>`（URL 路径 → 理由）作为**基线**。断言：每个 DB 绑定 route 要嘛被某条 source 匹配，要嘛在基线内；**且**基线内每一条目前仍是「DB 绑定且未被代理」（过期条目也要红，逼基线只缩不涨）。失败讯息列出所有违规路径。
   - 基线怎么填：先跑一次拿到全部违规 route，逐支读 route.ts：若它在 Vercel 上显然安全（例如缺 env 时直接回 503、只走 HMAC relay 打控面、只在特定 env 下触库），理由写一句具体原因；看不出来的写 `"baseline 2026-09-28 未分类"`。
4. **禁止**新增或删除任何代理条目（那会改生产路由，而控面副本不一定有该 route）。这一步只把现状锁住并列出清单。

## 验收（全部要贴输出）
- 改前改后各跑一次：`GENERATION_CONTROL_PLANE_PROXY_ORIGIN=https://o.example node -e "import('./next.config.mjs').then(async m=>console.log(JSON.stringify(await m.default.rewrites())))"`，两次输出**逐字相等**（用 diff 证明）。
- `npx tsx --test src/lib/control-plane-proxy-routes.test.ts` 全绿。
- 反证：临时把 `KNOWN_VERCEL_LOCAL` 删掉一条 → 测试红且讯息指出该路径；再还原。
- `npx tsc --noEmit -p .` 对你新增/修改的档没有新错（既有错与你无关就注明）。

## 红线
- working tree 有别人未提交的改动（canvas、video-frames 等）：**只 `git add` 你自己的 3 个档**，禁 `git add -A`／`git commit -a`／stash／checkout／reset。
- 不部署、不碰 VPS、不打任何付费上游。
- 同一错误重试 2 次仍失败 → 停下，回报事实。
- 完成后 `git commit`（讯息中文，`chore(proxy): …`，结尾 `Co-Authored-By: DeepSeek <noreply@deepseek.com>`）。

## 回报格式
commit hash；三个档的 diff 行数；DB 绑定 route 总数、被代理数、基线数；基线清单（路径＋理由）全文；验收命令输出。
