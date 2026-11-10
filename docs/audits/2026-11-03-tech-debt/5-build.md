# 审计 5：构建 / 依赖 / 仓库卫生 / 工程配置

审计对象：/home/user/Eimu（HEAD = "Update README.md" 2026-10-24，全仓仅 20 个提交，是开源发布的压缩历史）。
方法：只读；`npm ci --ignore-scripts` 已就绪；所有数字来自本次实际命令，原始输出在同目录 `tsc2.out / lint.out / lint-w.out / test.out / test2.out / bin.txt / tests.txt`。
未修改任何已跟踪文件，未提交。（tsc 生成了被 .gitignore 忽略的 `tsconfig.tsbuildinfo`，未纳入 git。）
记忆库不存在，已跳过。

重要前提：git 历史被压缩成 20 个提交，所以 `git log -1 --format=%cs` 对 tools/ 全部返回 2026-10-19 / 10-21 / 10-23，**不能反映真实最后修改时间**。第 7 项只能靠文件名里的日期判断。

---

## 发现 1：测试存量是纯负债——483 个测试档、11 万行，`npm test` 在干净环境无法跑完，CI 把它当闸门，与"不写测试"的仓库规则正面冲突
【严重度 P1】

【证据】
- 测试档 483 个（`git ls-files | grep -E '\.(test|spec)\.'`）：ts 474 / js 7 / mjs 2。目录分布：src/lib 298、src/app 61、src/components 45、deploy-staging/gateway 45、deploy-staging/vps-tools 13、src/hooks 6、desktop/lib 5、src/vendor-bridges 4，其余零散 5 个。
- 测试代码 110,625 行，对比非测试代码 394,426 行（全仓 ts/tsx/js/mjs），即测试占全部代码 **21.9%**（测试/非测试 = 28.0%）；仅 src/ 内：测试 95,583 行对非测试 248,812 行（测试/非测试 = **38.4%**，占 src 总量 27.8%）。最大几个：src/lib/mcp/tools.test.ts 1712 行、agent-chat-ui.test.ts 1619 行、storyboard-contract.test.ts 1444 行。
- 69 个测试档在 `src/` 之外（deploy-staging 60、desktop 7、mcp-server 1、skills 1），`npm test` 的 glob `src/**/*.test.ts` 与 CI 的 test job 都不会跑它们，等于从来没被执行的死测试。
- `npm test`（原样，限时 300s）：**未能在 5 分钟内跑完**。卡在 `src/lib/blender-e2e.test.ts`，它在等 `http://127.0.0.1:8765` 的 3D bridge，日志 `bridge 不可达，已等待 240s（上限 600s）`，被 timeout 杀掉，没有汇总行（test.out 里已出现 40 个 `not ok`）。
- 按 ci.yml 里的 11 档排除清单跑剩余 403 档（`tsx --test`，83 秒）：`tests 4377 / pass 4350 / fail 9 / cancelled 4 / skipped 14`。失败集中在：auth/me ×4（`Promise resolution is still pending` 被取消）、钱包订阅池/永久池 ×6、`MOTION_TEMPLATES 恰 58 条`、`gpt-image-2 系顺序＝yyds > adobe2api > newapi`（价格口径断言，价目一变就红）、`R3-② state 带 capabilities`。而 ci.yml 里作者声称本机基线是 `tests 4377 / pass 4363 / fail 0`：总数一致、通过数不一致（差 13），说明"全绿"依赖作者本机夹具/环境。
- ci.yml 自己承认 11 个测试档在干净 checkout 里必然失败：5 个读被 `.gitignore:150 /deploy-staging/*` 排除的本地夹具；5 个读已删除的 `src/components/pro-workstation/**`；1 个要外部服务。其中 2 个"还有 2 条本地既有红灯：片E/片F 的行号锚点 L152 已不存在"。
- 测试被 tsconfig 排除（`**/*.test.ts`），所以 483 个测试档**从未被 tsc 类型检查**，只由 tsx 运行时执行（tsx 不做类型检查）。
- AGENTS.md:93 规定"不再新增任何测试档……既有测试不扩张、不维护、不修红灯，也不得当成交付闸门"（AGENTS.md:89 起整节）。但 `.github/workflows/ci.yml` 的 `test` job 把这 403 档当作 push 闸门（注释原话："这两个是本 repo 唯一有真实断言……的闸"），还维护着一份 11 档排除清单加"清单腐化守门"——这本身就是在维护测试。
- 旁证：测试里有大量字符串/源码形状断言（AGENTS.md 自己也承认"守门件不是 oracle"）。vitest.config.mts 存在，但 `node_modules/vitest` 不存在、package.json 没有 vitest 依赖，该配置是死文件（见发现 3）。

【影响】
- 存量大、不维护、不修红灯，却仍在 CI 与 README（README.md:273 "单元与契约测试"）里以闸门口吻出现，对外读者会被误导；对内，每次改代码都可能撞上与行为无关的陈旧断言（行号锚点、价格顺序、源码字符串）。
- 69 个测试档与 11 个排除档合计 80 个（占 16.6%）是"死的或必红的"。
- 红灯无人修 ⇒ 任何新增失败被淹没在 9+4 个已知红灯里，测试输出彻底失去信号。

【建议】（处理存量，不补测试）
1. 先做分拣，不做大规模删除（AGENTS.md 要求大规模删需点名）：把 483 档按三类打标——(a) 源被删或夹具缺失、必红的 11 档 + 无法运行的 69 档 → 提请批准整批删除；(b) 绑定易变口径的（价目顺序、行号锚点、源码字符串匹配，例如 `gpt-image-2 系顺序` 与 `MOTION_TEMPLATES 恰 58 条`）→ 删或冻结；(c) 其余 → 整体标"历史资产、仅供变更探针"，移出默认路径。
2. 去掉 `npm test` 的 `npx --yes` 与对 blender-e2e 的隐式依赖：`npm test` 默认就该能在 2 分钟内结束（至少排除外部服务档，或让该档在 bridge 不可达时快速 skip）。
3. CI 的 `test` job 要么降级为 `continue-on-error` 的信息性 job，要么删除；与 AGENTS.md/CONTRIBUTING.md（"不是交付闸门"）对齐，不能同时说不是闸门又在 push 上卡它。README.md:273 的说法同步改。
4. 若决定保留一小撮，限定在无外部夹具、计费/幂等这类真实行为断言（作者 ≠ Hacker 原则外的例外需用户点名）。

---

## 发现 2：包管理三套并存、lockfile 已过期、npm 脚本与实际工具链不一致
【严重度 P2】

【证据】
- 根目录同时有 `package-lock.json`（535 KB，现行，CI `npm ci`、vercel.json `npm install`）、`pnpm-lock.yaml`（190 KB）、`pnpm-workspace.yaml`。
- `pnpm-lock.yaml` 已过期：importers 里只有 34 个依赖，而 package.json 有 45 个；缺 `@openuidev/react-headless / react-lang / react-ui`、`@types/dagre`、`@types/three`、`dagre`、`marked`、`three`、`ws`、`zod`、`zustand` 共 11 个。ci.yml 注释："pnpm-lock.yaml 是 8 月的残留，勿用 pnpm"。docs/SELF-HOSTING.md:12 却写"同时保留 pnpm workspace 配置"。
- `pnpm-workspace.yaml` 内容是三行占位文本，pnpm 会把它当配置读：`esbuild: set this to true or false`（sharp、unrs-resolver 同）。没有任何文件引用它，也没有 workspace packages 字段。
- `package.json` 的 `"name": "ai-sdk-image-generator"`（package-lock.json:1 同名）；仓库实际叫 Eimu，全仓只有 package.json 一处引用该名。
- `scripts.test` = `npx --yes tsx --test "src/**/*.test.ts"`：tsx 已在 dependencies 里，`npx --yes` 无意义且在离线/CI 里可能触发下载；同时仓库有 `vitest.config.mts`，vitest 并未安装（`node_modules/vitest` 不存在，package.json 无该依赖），文件头注释写的是"两种执行器下都能注册测试"，实际只有 tsx 一种能跑。
- `tsx` 在 `dependencies`（package.json）：它被 `generation:*`/`ops:*`/`bizkey:*` 脚本和 worker 用，生产运行时需要，所以放 dependencies 有其道理，但 `render.yaml`/docker 的生产镜像因此带上了 tsx/esbuild。`playwright-core` 在 devDependencies：tools/ 下 3 个脚本和 4 个其他文件使用，放 dev 是对的，没有问题。
- 无 `engines` 字段；`.node-version` = 24.15.0，`@types/node` ^22（实装 22.19.1），本容器 node 是 22.23.4。类型与运行时主版本不同。
- `npm audit --omit=dev`（只读 lock）：**17 个漏洞：critical 1、high 12、low 4**。（未逐条判可达性，仅作量化。）
- `next lint` 在 Next 15.5 已标记 deprecated（输出 "will be removed in Next.js 16"）；`package.json` 的 `lint` 脚本就是 `next lint`。

【影响】新人 `pnpm install` 会得到缺 11 个包、且被占位配置污染的结果；`npm test` 对环境隐含网络依赖；Next 16 升级时 lint 直接断。

【建议】删除 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml`（npm 是唯一契约，SELF-HOSTING.md 同步改）；package.json `name` 改为 `eimu`；`test` 脚本去掉 `npx --yes`；删 `vitest.config.mts`（或装 vitest，二选一，建议删）；加 `engines.node`，`@types/node` 与 `.node-version` 对齐；`npm audit` 的 1 个 critical 单独跟进（属依赖升级，非本轴线深挖）。

---

## 发现 3：依赖与 import 对不上——零引用依赖 + 幽灵（未声明）依赖
【严重度 P2】

【证据】（扫描脚本遍历全部跟踪的 ts/tsx/js/mjs/css，抽取 `from/import()/require/@import/@plugin` 的裸包名，对照 package.json；src、tools+worker、根配置分别统计）

零引用（全仓 0 次 import）：
- `@atlaskit/pragmatic-drag-and-drop`（仅出现在一个被 CI 排除的死测试 src/components/ProfessionalWorkstation.test.ts 的字符串里）
- `@openuidev/react-headless`
- `@radix-ui/react-select`
- `ws`（src、tools、worker、deploy 均无 `from "ws"`/`require("ws")`）
- `zustand`：仅 `src/vendor-bridges/editor/adapter/editorStore.ts` 与 `src/vendor-bridges/opencode-tools/director_get_state.ts`（该目录被 tsconfig 排除，不进 Next 打包），根站点代码不用。

被"误用"的 devDeps/配置型依赖（postcss、tailwindcss、tailwindcss-animate、eslint、eslint-config-next、typescript、@types/*）由配置文件间接引用，属正常。

src/ 内非测试代码 import 了但 package.json 未声明的包（幽灵依赖，靠 hoist 才工作）：
- `nanoid`：src/lib/director-engine/{cameraTemplates,motionTemplates,planning-core}.ts 等 3 个文件（在 tsc 编译范围内）；实际由 node_modules 里 3.3.12 版本（来自 next/postcss 传递依赖）满足，tsc 0 错误正是因为 hoist。
- `sharp`：src/lib/dag-png.ts、src/lib/canvas/format-crops-exec.ts；靠 next 的 optionalDependencies（0.34.5）满足，ci.yml 注释自己写过"本地 build 会因自装 node_modules 缺 sharp 而炸"。
- 仅 vendor-bridges（不在 tsc 内）：`@opencode-ai/plugin`（34 个文件）、`bun:sqlite`；仅测试：`@electric-sql/pglite`。tools/export-web-search-tools-staging.ts 引用 `@opencode-ai/plugin`（package-lock 里也没有）。

【影响】5 个声明了却没用的依赖拖大 `npm ci`；`nanoid`/`sharp` 一旦传递依赖升级或换 pnpm 就在运行时崩（sharp 直接影响生图/画布裁剪路径）。

【建议】从 package.json 移除 `@atlaskit/pragmatic-drag-and-drop`、`@openuidev/react-headless`、`@radix-ui/react-select`、`ws`（zustand 若 vendor-bridges 不属于根包也可移除）；把 `nanoid`、`sharp` 补进 dependencies。

---

## 发现 4：类型检查 0 错误，但覆盖范围只有约四分之一的代码；构建时检查被关闭
【严重度 P1】

【证据】
- `npx tsc --noEmit -p tsconfig.json --incremental false`（34 秒）：**0 个 `error TS`**（`grep -c "error TS"` = 0，输出为空）。按错误数聚类前 15：无（空）。
- tsconfig.json：`"strict": true`；但 `exclude` 含 `deploy-staging`、`staging`、`open-source`、`mcp-server`、`plugins`、`src/vendor-bridges`、`eval-*`、`tmp`、`work`、`**/*.test.ts`、`**/*.test.tsx`。`include` 只有 `**/*.ts, **/*.tsx`，所以 `allowJs: true` 实际无效（desktop/*.js 等不进程序）。
- 进入程序的非 node_modules 文件共 **1159 个**（`tsc --listFilesOnly`）：src 1127、tools 29、worker 1、tailwind.config.ts 1、next-env.d.ts 1。
- 未被主 tsc 覆盖的真代码：deploy-staging 非测试 ts/js 112,811 行（跟踪文件 1681 个，生产网关/opencode-runtime 就是这里；仅 `deploy-staging/gateway` 有 ci.yml 里的第二个 tsc job，`opencode-runtime`（1291 个文件）、poller、vps-tools、laya-server、flowmusic2api 无任何类型检查）；src/vendor-bridges 86 个文件；desktop 30 个 JS；测试 11 万行。
- next.config.mjs：`eslint: { ignoreDuringBuilds: process.env.VERCEL === "1" }` 与 `typescript: { ignoreBuildErrors: process.env.VERCEL === "1" }`。即线上（Vercel）构建**同时跳过 lint 和类型检查**，注释理由是"每次省约 60s"。因为 CI（ci.yml）不跑 build、不跑 lint，类型检查只在 CI 的 `npx tsc --noEmit` 里有；一旦 CI 不可用（ci.yml 注释记载 GitHub-hosted runner 账单被锁，已改自托管 runner `eimu-local`），线上构建没有任何类型闸门。
- 代码里 `@ts-ignore/@ts-expect-error/@ts-nocheck` 共 3 处；非测试 `: any` / `as any` 约 70 处；含 `eslint-disable` 的文件 72 个。

【影响】主站代码类型干净（正面发现）；但"类型 0 错误"只对约 1127 个 src 文件成立，生产控制面、网关、opencode 工具运行时多数不受类型保护；Vercel 构建绕过检查，意味着类型/lint 问题只能靠 CI 发现，而 CI 依赖一台自托管机器。

【建议】CI 加一个在 Vercel 之外跑 `tsc` 的必过 job（已有，保持必过）；给 `deploy-staging/opencode-runtime`、`poller`、`vps-tools` 各补一个 tsconfig 并入 gateway-typecheck 同类 job；`src/vendor-bridges` 若是 VPS 代码的镜像，应移出 `src/`（见发现 8、9）。

---

## 发现 5：Lint 实际不通过（98 error / 216 warning），直接用 eslint 跑不起来，CI 不跑 lint
【严重度 P2】

【证据】
- `.eslintrc.json`：extends `next/core-web-vitals` + `next/typescript`，仅把 `no-unused-vars` 设为 warn。
- `npx eslint src --quiet` → exit 2："ESLint couldn't find an eslint.config.(js|mjs|cjs) file"（devDeps 是 eslint ^9.18，装的是 9.39.1，v9 默认只认 flat config，旧的 `.eslintrc.json` 被忽略）。只有 `next lint`（走兼容层）能跑。
- `npx next lint --quiet`（40 秒）：**98 个 error，exit 1**。按规则：`@typescript-eslint/no-explicit-any` 89、`react-hooks/rules-of-hooks` 4（src/lib/openui/eimu-library.ts:422-435，在名为 `component` 的函数里调用 hook）、`prefer-const` 4、`no-non-null-asserted-optional-chain` 1。按目录：**src/vendor-bridges 80（占 82%）**、src/lib 18。
- 非 quiet：**216 warning**：`no-unused-vars` 125、`react-hooks/exhaustive-deps` 91。warning 最多的文件：CanvasEmbed.tsx 41、hooks/canvas/canvas-chat-ops.ts 33、AgentChatSurface.session-actions.ts 29、use-canvas-chat.ts 26。
- CI（ci.yml）只有 typecheck、gateway-typecheck、test 三个 job，**没有 lint job**；Vercel 构建又 `ignoreDuringBuilds`。因此这 98 个 error 平时没人看见。本地 `next build`（非 VERCEL 环境）按 Next 的语义会因 lint error 失败——未实际执行构建（AGENTS.md 禁止在生产主机构建，且耗时/耗内存）。

【影响】`npm run lint` 是红的；真正有风险的只有 4 个 rules-of-hooks（可能是真 bug）；82% 的 error 来自"镜像代码"目录而不是产品代码。

【建议】把 `src/vendor-bridges` 加入 eslint ignore 或移出 src；评估并修复/豁免 openui 的 4 个 hooks 违规；迁到 flat config（官方 codemod `npx @next/codemod@canary next-lint-to-eslint-cli .`）；决定 lint 是否进 CI（建议最小：`error` 级进 CI，warning 不进）。

---

## 发现 6：仓库体积与二进制——189 MB 提交的媒体文件，无 git-lfs，且大量重复
【严重度 P2】

【证据】
- `du -sh .git` = 187M（`size-pack: 186.08 MiB`，5849 个对象，历史仅 20 个提交）。
- 跟踪的二进制/媒体共 **297 个，180 MB**（`stat` 汇总 188,604,628 字节）：mp4 12 个 113.8 MB、png 72 个 27.2 MB、m4a 12 个 23.7 MB、webp 138 个 5.4 MB、otf 1 个 5.0 MB、jpg 33 个 3.5 MB、pdf 9 个 1.0 MB、glb 16 个 0.1 MB。
- 最大 15 个：public/promo/eimu-promo.mp4 41.2 MB；public/showcase/agent-templates/novel-film-3.mp4 16.0 MB；public/showcase/eimu-milestone-caption.mp4 9.0 MB；docs/preview/15-dam-mech-15s.mp4 8.2 MB；public/showcase/agent-templates/art-curation-3.mp4 8.2 MB；drama-poster-2.mp4 6.8 MB；ecom-model-2.mp4 5.1 MB；public/fonts/NotoSansCJKsc-subset.otf 5.0 MB；ecom-launch-2.mp4 4.8 MB；novel-film-2.mp4 4.2 MB；ip-pack-3.mp4 3.9 MB；art-style-2.mp4 3.2 MB；drama-visual-2.mp4 3.1 MB；open-source/eimu-music-agent/eval/audio/nifengbumie5.m4a 与 nifengbumie6.m4a 各 2.1 MB。
- 无 `.gitattributes`；`git lfs ls-files` 无输出——没用 git-lfs。
- 大文本：skills/blender-agent-os/knowledge/catalog.json 631,758 字节，**在 deploy-staging/opencode-runtime/skills/... 下完全同样再存一份**。
- **整棵目录重复**：`skills/` 与 `deploy-staging/opencode-runtime/skills/` 有 **507 个同路径文件，其中 487 个字节级相同**（比较脚本逐个 `cmp`）。`src/vendor-bridges` 与 `deploy-staging/{gateway,opencode-runtime}` 有 30 个同路径文件。
- `.vercelignore` 306 行、`.zcodeignore` 197 行、`.gitignore` 202 行、`.dockerignore` 17 行——四套 ignore 手工同步。
- docs/ 内还放了 44 个图/视频/html（17.7 MB 图像视频）。

【影响】克隆慢（每个新贡献者拉 187 MB）；`public/` 里 12 个 mp4 会被 Vercel 部署带上；重复的 skills 树改一处漏一处（487 份相同，意味着很快会出现漂移）。

【建议】媒体移到对象存储/Releases，`public/` 只留必要的；若仍想入库，上 git-lfs 并加 `.gitattributes`；`skills/` 与 `opencode-runtime/skills/` 只保留一个真源，另一个由导出脚本生成（tools/export-*-staging.ts 已有同类机制）；不在这次做历史重写。

---

## 发现 7：根目录杂物与"部署在哪"的歧义（render.yaml vs vercel.json）
【严重度 P2】

【证据】
- 根目录的 `eimu-agent-architecture.html`（61.5 KB）与 `eimu-agent-architecture.json`（2 KB）：全仓无任何引用（`git grep -F` 返回空）；`pelican.svg`（3.9 KB）：唯一引用是 `.vercelignore`（把它排除）；`pnpm-workspace.yaml` 无引用；`tsconfig.tsbuildinfo`(512 KB)/`next-env.d.ts` 被 .gitignore 忽略，非问题。
- `render.yaml`（Render 免费版 `image-tinchak0207`，`buildCommand: npm install && npm run build`，`IMAGE_API_BASE_URL=https://share-api.com/v1`，`IMAGE_API_BASE_URL_FALLBACK=https://happycode.vip/v1`）与 `vercel.json`（`framework: nextjs`，sfo1 区）并存。`DEPLOYMENT.md` 写明推荐方案："`eimu.dev` 部署在 **Vercel**；`market.tinchak0207.xyz` 留在 Render"。所以 **render.yaml 描述的是另一个站点的初始配置，不是本应用**；而 `DEPLOYMENT.md:50` 里指向它的链接是 Windows 绝对路径 `C:/Users/user/Documents/New project/image-tinchak0207/render.yaml`（作者本机路径，公开仓里是坏链接）。`vercel.json` 的 `installCommand` 用 `npm install` 而不是 `npm ci`。
- 另有生产控制面部署在自有 VPS（AGENTS.md 多处提到 4GB 主机、docker），仓库内 `deploy/vps/Dockerfile`、`deploy/vps/docker-compose.yml`、`deploy/image-data-api/*` 提供，实际形成"Vercel + VPS + Render（旧）"三处部署描述，README/DEPLOYMENT.md/SELF-HOSTING.md 口径不一。
- `promo-video/` 36 个跟踪文件（2.7 MB）：宣传片渲染工程（film.js、render.mjs、audio.py、3 个 cover html），与产品运行时无关；`.gitignore` 已排除其 `out/`、`fonts/`。`marketing-battle-pack/` 本次克隆里不存在（AGENTS.md 提到，已不在仓库）。
- `desktop/`（42 个文件，Electron 桌面端，自带 package.json 与 package-lock.json）、`mcp-server/`（8 个，自带 package-lock）、`bridge/`（5 个）：三个独立 npm 项目没有 workspace 管理。
- `open-source/eimu-music-agent`（55 个跟踪文件含 12 个 m4a）：`.gitignore` 明确写 `/open-source/` 不入库，但仍有 55 个被跟踪（见发现 9）。

【影响】新读者无法从根目录判断"这个项目怎么部署"；坏路径链接是公开仓的低级噪声；架构图 html 孤立在根目录。

【建议】删根目录两个 eimu-agent-architecture 文件（或移到 docs/arch，该处已有同主题）；删 pelican.svg；`render.yaml` 若 market 站不属本仓则移除；DEPLOYMENT.md 修坏链接并写清"本仓只部署 Vercel + VPS"；promo-video 移到独立仓库或 docs/。

---

## 发现 8：docs/ 190 个文件中绝大多数是一次性快照
【严重度 P3】

【证据】`git ls-files docs | wc -l` = 190（125 md、35 png、9 txt、9 json、3 jpg、3 html、2 webp、1 mp4、1 mts、1 mmd）。
- 一次性/时点快照目录：`evidence/` 33、`arch/` 27（含 9 个 `_sp-audit-samples/*.txt` 系统提示采样）、`plans/` 21、`preview/` 18、`specs-0928/` 15、`capability-ledger-2026-09-30/` 15、`archive/` 4。合计 133 个，占 **70%**。
- 根层 38 个文件，其中 25 个文件名含 prd/audit/report/handoff/draft/plan/survey/swallow/symdiff 等一次性文档（如 `2026-08-25-swallow-decision-list.md`、`aid-half-done-audit-2026-09-16.md`、`beast-army-r4-report.md` … `r8-...`、`grok-sota-pipeline-prompt.md`/`-answer.md`、`CAPABILITIES.draft2.md`）。
- 真正的"长期文档"只有：`runbooks/` 2（infra-debugging、bias-refresh）、`architecture/` 4（dual-truth-boundary 等，AGENTS.md 引用）、`skills/` 8、`ARCHITECTURE.md`、`SELF-HOSTING.md`、`CAPABILITIES.md`、`biz-api*.md`，约 20 个，占 **约 11%**。
- 隐藏的调试截图：`docs/.check.png`、`.check2.png`、`.check3.png`、`.check4.png`。
- docs 里的 mp4/图片 17.7 MB（发现 6 已计入）。
- `docs/specs-0928/planes-wrapup-deepseek.md`：文件名指向已被 AGENTS.md 删除的"DeepSeek 专用限制"。

【影响】docs/ 成了考古层，真文档被淹没；新读者分不清哪些是现行规范。

【建议】只保留 runbooks/architecture/SELF-HOSTING/CAPABILITIES 等 ≈20 个；其余整体移到 `docs/archive/` 或独立的 `eimu-docs-archive` 仓库（不是删除历史）；删 .check*.png。

---

## 发现 9：tools/ 里按日期/事件命名的一次性脚本，与平台声明矛盾的 .ps1
【严重度 P3】

【证据】tools/ 共 52 个文件。`git log -1 --format=%cs` 全部是 2026-10-19 / 10-21 / 10-23（历史被压缩，**不可用作新旧判断**）；以下判断来自文件名/内容：
- 一次性核验脚本（含日期或事件号）：`verify-idfix-0831.mjs`(174 行)、`verify-idfix-t2.mjs`(110)、`verify-compact-gate-0831.mjs`(118)、`verify-tour-cursor.mjs`(150)、`agent-r9-retest.mjs`(87)、`jev-calibrate-knife23.ts`(146)、`jev-calibrate.ts`(111)、`jev-livefire.ts`(39)、`.debug-tour-tmp.mjs`(35，名字自带 tmp 的调试残留)、`extract-tpl.ts`(6 行)、`inspect-gemini-relay.mjs`(53)、`dev-scripts/codex-diag.sh`(7)、`dev-scripts/codex-image-data-smoke.mjs`(44)、`purge-bogus-writeoffs.ts`(80，一次性数据修复)、`backfill-lineage.ts`(168)、`seed-manifests/2026-10-19-local-notes.json`(491 行)+`.report.md`(94)、`ab-memory-experiment.mjs`(1121 行，实验)。
- `.ps1`：`probe-image-upstreams.ps1`、`probe-production-image-upstreams.ps1`、`run-production-image-upstream-probe.ps1` 共 3 个；AGENTS.md:42 明说"bash 语法（Arch Linux；PowerShell/Windows 路径是错的）"。
- 依赖密钥的运维脚本（`issue-biz-key.ts`、`issue-promo-code.ts`、`provision-biz-account.ts`、`add-supplier-channel.ts`、`seed-*.ts`）与 package.json 脚本相连，属活的。
- 另外：`tools/` 在 tsc 程序里有 29 个文件，会因脚本过期而影响主 tsc（目前 0 错误）。
- AGENTS.md:29 规定"禁自造辅助脚本/工具，除非暴君点名"，但 tools/ 有 52 个文件；规则与现实冲突（见发现 10）。

【影响】小：噪声与误导；但 `.ps1` 与"平台是 Arch Linux"的声明直接矛盾，新贡献者无法判断环境基线。

【建议】把上面 18 个一次性脚本和 3 个 .ps1 移到 `tools/archive/` 或删除（需用户点名）；`.debug-tour-tmp.mjs` 直接删。

---

## 发现 10：AGENTS.md 膨胀并自相矛盾
【严重度 P2】

【证据】
- AGENTS.md：159 行、29,037 字节；23 行超过 400 个字符，最长一行 1,491 字符；39 行含 `2026-` 日期（事故/纠正的叙事）。文件顶部写"膨胀铁律：本档只加行为规则；排障笔记进 runbook，历史归 memory"，而实际 39 行是带日期的事故叙事（例："2026-10-03 事故"、"2026-09-27 ¥31.29 事故后立"）。CLAUDE.md 只有一行 `@AGENTS.md`，所以这 29 KB 每次会话都完整载入上下文。
- 引用了仓库外不存在的东西：`~/.claude/memory/`、`mem` CLI、`/opt/agent-harness`、Arch Linux、VPS 控制面、`.env.biz-key`（B 端 API key 的存放位置）。对公开仓库读者无意义，且泄露内部运维形状（4GB 生产主机、VPS 2 核、docker 构建缓存清理步骤）。

矛盾点（引原文）：
1. UI 验证：AGENTS.md:23 "**禁自我 UI 检查**：美学归暴君，dev server/Playwright/截图验外观 = 垃圾时间，改完直接交" vs AGENTS.md:24 "**视觉改动部署前必做本地 E2E 截图自审**……违反＝直接退回"；后者自己补一句"这条不推翻上一条"，但同一动作（起 dev server + Playwright 截图）一个被称"垃圾时间"、另一个被称"必做"。
2. 测试：AGENTS.md:93 "**不写测试。** ……既有测试视为历史资产：不扩张、不维护、不修红灯" vs `.github/workflows/ci.yml` 的 `test` job 把 403 个测试档作为 push 闸门，并维护 11 档排除清单与"清单腐化守门"；README.md:273 仍写"单元与契约测试"。（对应发现 1。）
3. 脚本：AGENTS.md:29 "禁自造辅助脚本/工具，除非暴君点名" vs tools/ 有 52 个文件，且 AGENTS.md 自己的"画布写穿硬闸"节要求发版前跑 `tools/check-media-workflow-write-coverage.py`、`tools/media-session-canvas-stats.py`。
4. 何时停：AGENTS.md:19 "**不许自己停**……**不许**把回合停在『等你发话／你说继续我就开始』" vs AGENTS.md:30 "连续 3 次读取/探测没有产出修改 → **停下问暴君一句话**" vs AGENTS.md:32 "不是产品决策不要问我"。三条在"该不该停下提问"上互相打架。
5. 构建：AGENTS.md:76 "承载在线服务的4GB生产主机**禁止原地执行Next/Docker全量构建**；只接收离机预构建产物" vs AGENTS.md:33 "控面部署前置：先清磁碟再 build（`docker builder prune -af`）……实测清完 96%→73%（释放 13G）后一次过"（即在 VPS 上 build）。同一台机器上先规定怎么安全地 build、后规定不准 build。
6. 平台：AGENTS.md:42 "bash 语法（Arch Linux，2026-08-17 起；PowerShell/Windows 路径是错的）" vs tools/ 3 个 .ps1、DEPLOYMENT.md:50 的 `C:/Users/user/Documents/...` 路径。
7. 子代理：AGENTS.md:58 "任何动手环节一律派发，无『小改可内联』的例外" vs AGENTS.md:21 "黄金时间：定改动 → 改码 → 部署 → 写 memory"（orchestrator 不动手却要排序"改码"），以及"禁旁白"（AGENTS.md:41 区）与会话内必须"回报决策、证据、结果"。

【影响】agent 在这些冲突点上的行为不可预测，只能靠最近一次"暴君纠正"的上下文猜；29 KB 常驻上下文挤占有效工作窗口。

【建议】以"一条规则一个真源"整理：保留 ≤60 行行为规则，事故叙事移到 docs/runbooks；把上面 7 对矛盾各裁定一边（建议：测试→CI 降级；UI 截图→只在 UI 任务中必做；脚本→删除"禁自造"，改为"工具进 tools/ 并命名规范"；停问→合并成一条判据）；仓库外引用（memory、mem、VPS 路径）移到私有的 CLAUDE.local.md。

---

## 发现 11：.gitignore 与实际跟踪不一致——97 个"该忽略却被跟踪"的文件，且有一条规则会误伤关键配置
【严重度 P2】

【证据】
- `git ls-files -ci --exclude-standard` = **97 个文件**既被跟踪又匹配忽略规则：`open-source/eimu-music-agent`（55，.gitignore 写 `/open-source/` 且注释"不入 App repo"）；`staging/music-tools`（8，规则 `/staging/`）；`deploy-staging` 下的 blender-director-persona 7、blender-modal 6、blender-gateway 5、blender-nodes 4、blender-bridge-tunnel 4、patch-gateway.py 1 等 28 个（`/deploy-staging/*` 只放行 gateway/laya-server/vps-tools/opencode-runtime/poller/flowmusic2api）；以及 `.env.example`（被 `.env*` 命中，`.gitignore:79`）、`next.config.mjs` 与 `postcss.config.mjs`（被 `.gitignore:108 /*.mjs` 命中）。
- 其中 **`/*.mjs`（.gitignore:108）会让根目录任何新增的 `.mjs` 配置（例如将来的 `eslint.config.mjs`——发现 5 要求新增它）被静默忽略**，提交时必须 `-f`。
- 反向检查 `git ls-files | grep -E '\.log$|__pycache__|\.DS_Store|(^|/)\.env'`：只命中 `.env.example`，没有 .log、__pycache__、.DS_Store、真实 .env 被跟踪。`.env.biz-key` 被 `.env*` 忽略且不在跟踪列表里（正确）。`git ls-files | grep tsbuildinfo|\.next/|node_modules/` 无命中。
- 正面：`next-env.d.ts`、`*.tsbuildinfo` 均被忽略且未被跟踪。
- 对比 AGENTS.md 提到的 `.gitignore` 里"评测证据大档留本地"一节（.gitignore:144）只有注释没有规则（孤立注释）。

【影响】open-source/ 的 55 个文件与 staging/ 的 8 个违背了 .gitignore 自己声明的意图，也是 23.7 MB m4a 音频的来源；`/*.mjs` 是一个已经存在的陷阱。

【建议】决定 open-source/ 要不要入库：入库就删规则，不入库就 `git rm --cached`；把 `/*.mjs` 改成只忽略具体临时名；`.env.example` 加 `!.env.example` 显式放行（它现在能入库靠的是 force-add）。

---

## 发现 12：`src/vendor-bridges` 与 `deploy-staging` 是"镜像代码混在产品源码里"
【严重度 P3】

【证据】`src/vendor-bridges/` 86 个文件被 tsconfig 排除（tsc 不检查）但留在 `src/`，被 `next lint` 扫到（贡献了 80 个 lint error，占 82%）；import 了 `@opencode-ai/plugin`、`bun:sqlite`（Next 的 Node 构建里不存在）；其中 30 个路径与 `deploy-staging/{gateway,opencode-runtime}` 同路径。`deploy-staging/opencode-runtime` 25 MB / 1291 个文件，包含 847 个 skills、282 个 lib、153 个 tools；`.gitignore:150-166` 对 deploy-staging 的"白名单反向例外"共 6 条。

【影响】产品源码目录、线上运行时镜像、技能资料库三者混放，lint/tsc/测试每个都要特别排除；任何"全仓"工具都会误报。

【建议】把 `src/vendor-bridges` 迁到 `deploy-staging/` 或独立目录；`deploy-staging/opencode-runtime/skills` 与根 `skills/` 合并为一个真源（发现 6）。

---

## 量化总表

| 项 | 数值 | 来源 |
|---|---|---|
| 跟踪文件总数 | 4,593（20 个提交） | `git ls-files \| wc -l` / `git rev-list --count HEAD` |
| `.git` 体积 | 187 MB（pack 186.08 MiB，5849 对象） | `du -sh .git`、`git count-objects -vH` |
| 跟踪二进制/媒体 | 297 个 / 179.9 MB（mp4 12=113.8 MB，m4a 12=23.7 MB，png 72=27.2 MB） | stat 汇总 |
| git-lfs / .gitattributes | 无 / 无 | `git lfs ls-files`、`cat .gitattributes` |
| lockfile 数量（根） | 2（package-lock + pnpm-lock），pnpm-lock 缺 11/45 依赖 | 脚本对比 |
| 零引用依赖 | 5（@atlaskit/pragmatic-drag-and-drop、@openuidev/react-headless、@radix-ui/react-select、ws、zustand〔仅 vendor-bridges〕） | 全仓 import 扫描 |
| 未声明但被 src 使用的包 | 2（nanoid、sharp）+ vendor-bridges 的 @opencode-ai/plugin、bun:sqlite | 同上 |
| `npm audit --omit=dev` | 17（critical 1 / high 12 / low 4） | `npm audit` |
| tsc 错误 | 0（34 秒） | `tsc --noEmit -p tsconfig.json --incremental false` |
| tsc 覆盖文件 | 1,159（src 1,127 + tools 29 + worker 1 + 2） | `tsc --listFilesOnly` |
| 未被 tsc 覆盖的代码 | deploy-staging 112,811 行 + vendor-bridges 86 文件 + 测试 110,625 行 + desktop JS | 统计 |
| `strict` | true | tsconfig.json |
| Vercel 构建跳过 lint/类型检查 | 是（`VERCEL=1`） | next.config.mjs |
| `next lint` | 98 error / 216 warning（80 error 在 vendor-bridges）；40 秒；`npx eslint src` 直接 exit 2 | 实跑 |
| CI 是否跑 lint / build | 否 / 否 | ci.yml |
| 测试档 | 483（ts 474、js 7、mjs 2） | `git ls-files` |
| 测试代码行 / 非测试代码行 | 110,625 / 394,426（全仓 21.9%）；src 内 95,583 / 248,812（38.4%） | `cat \| wc -l` |
| 不被 `npm test`/CI 执行的测试档 | 69（src 外）+ 11（CI 排除）= 80 | 对照 ci.yml |
| `npm test` 原样 | 300 秒超时未完（卡 blender-e2e 等 bridge） | 实跑 |
| 排除 11 档后测试 | 4377 tests / 4350 pass / 9 fail / 4 cancelled / 14 skipped（83 秒） | `tsx --test` |
| docs/ 文件 | 190；一次性快照目录 133（70%）；长期文档约 20（11%） | `git ls-files docs` |
| tools/ 文件 | 52；一次性/事件命名约 18；.ps1 3 | 逐文件 |
| AGENTS.md | 159 行 / 29,037 字节；39 行含日期叙事；23 行超 400 字符；矛盾 7 对 | `wc`、`awk` |
| 被跟踪却被 .gitignore 命中的文件 | 97 | `git ls-files -ci --exclude-standard` |
| 重复树：skills/ vs opencode-runtime/skills | 507 同路径、487 字节相同 | `comm` + `cmp` |
| `git ls-files` 命中 log/pycache/DS_Store/.env | 仅 `.env.example`（预期） | grep |
