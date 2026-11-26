# 仓库目录

根目录按职责组织。产品代码、发布配置、维护工具、文档和本机工作资料分开。

```text
image-app/
├── src/                 网页端页面、组件和业务逻辑
├── public/              网页公开静态资源
├── apps/
│   ├── desktop/         Electron 桌面端
│   └── miniapp/         微信小程序
├── services/
│   ├── gateway/         Agent 网关、会话与调度
│   ├── opencode-runtime/ Agent 工具、插件与运行时技能
│   ├── blender-bridge/  本机 Blender 桥
│   ├── mcp/             独立 MCP 服务包
│   └── …                各服务自己的源码和包配置
├── worker/              生成任务执行入口
├── db/                  数据库结构和迁移
├── deploy/              发布脚本、镜像与基础设施配置
├── tools/
│   ├── generated/       导出工具的中间稿；不是另一份运行时真源
│   ├── promo-video/     宣传片制作源码
│   ├── qa/              本机验收工具
│   ├── plugins/         辅助插件项目
│   └── vendor/          外部工具与补丁说明
├── skills/              仓库技能资产
├── docs/
│   ├── design-system/   品牌与设计规范
│   ├── architecture/    技术结构与边界说明
│   ├── runbooks/        操作与接入
│   ├── proposals/       PRD、方案和决策稿
│   ├── evidence/        绑定基线的样本与回执
│   ├── presentation/    对外叙述和展示素材
│   ├── research/        研究资料
│   └── archive/         冻结历史，不作为当前实现说明
└── .local/              本机缓存、状态、临时工作和产物，不入库
```

`.git`、`.github`、`.agents`、`.claude`、`.codex`、`.vercel` 是工具约定的元数据；`node_modules` 是依赖，不是业务分区。

## 从任务找到唯一入口

领域内的文件与接口从 [src/lib职责入口](../src/lib/README.md)继续定位。

| 维护任务 | 从这里开始 | 分工与不能混淆的边界 |
| --- | --- | --- |
| 页面、交互、站内 API | [src/app/](../src/app/) 定路由，[src/components/](../src/components/) 定组件；[赏阅结构](architecture/viewer.md) | 页面不另建渠道/价格注册表；API实际运行面先查 [next.config.mjs](../next.config.mjs) 和 [src/lib/control-plane-proxy-routes.mjs](../src/lib/control-plane-proxy-routes.mjs) 的控面代理，不能只改站点同名路由 |
| 生成、供给与计费 | [src/lib/generation-core/](../src/lib/generation-core/)管生成与供给，[src/lib/billing/](../src/lib/billing/)管账本；执行入口 [worker/generation-worker.ts](../worker/generation-worker.ts)，模型目录 [src/lib/generation-core/generation-model-catalog/](../src/lib/generation-core/generation-model-catalog/) | 请求入口、异步执行、账本不是同一层。新增供应商顺着现有registry/adapter接线；数据库结构进 `db/migrations/`，不在UI或工具中再记一套账 |
| Agent会话、工具与技能 | [services/gateway/index.ts](../services/gateway/index.ts) 追会话；[services/opencode-runtime/tools/](../services/opencode-runtime/tools/) 追执行；配置 [services/opencode-runtime/opencode.json](../services/opencode-runtime/opencode.json) | 工具源码存在不等于席位能调用。工具执行、注册开放与调用者一起核对；导出器在 [tools/codegen/](../tools/codegen/)，中间稿在 [tools/generated/](../tools/generated/)，不可反过来覆盖运行时 |
| 桌面端、小程序与桥 | [apps/desktop/package.json](../apps/desktop/package.json)、[apps/miniapp/package.json](../apps/miniapp/package.json)、[services/blender-bridge/](../services/blender-bridge/) | 各自包脚本和依赖归各自目录；先区分网页共享业务与宿主专属能力。旧根路径只是本机进程兼容，不是第二套源码 |
| 发布、运维和数据变更 | 下方四条发布入口；日常操作从[工具入口](../tools/README.md)按任务进入 | 服务源码归 [services/](../services/)，发布机制归 `deploy/`，环境状态不入库。必须以完整提交候选发布，不能用工作区零散文件拼release |
| 找有效规范与了解状态 | [文档入口](README.md)，工程规则根 [AGENTS.md](../AGENTS.md)，品牌根 [DESIGN.md](../DESIGN.md) 与 [design-system/MASTER.md](design-system/MASTER.md) | `proposals/`描述意图，`evidence/`记录特定行为，`presentation/`用于讲解。它们都不能因目录名或FINAL标题变成当前实现真源 |

根 `skills/` 与运行时 [services/opencode-runtime/skills/](../services/opencode-runtime/skills/) 各有调用与发布范围，不自动同步。[tools/generated/music-tools/](../tools/generated/music-tools/) 含受保护的历史差异，导出器的preserve/known-drift规则继续有效。现役Expert规范源在 [services/expert-gateway/](../services/expert-gateway/)；生成器输出、构建内置副本和运行时产物不得各自手改。

## 文件放在哪里，谁可以一起改

| 文件职责 | 唯一落点 | 并行改动边界 |
| --- | --- | --- |
| Next页面与路由 | `src/app/<route>/` | 一条路由由一人改；共享布局和代理规则另指定一人统改 |
| 一组界面能力 | `src/components/<feature>/` | 在既有功能目录扩展；共享UI基础组件由单人合并 |
| 业务规则、模型与共享类型 | `src/lib/<domain>/` | 先找既有领域；同一类型/registry不新增第二真源；公共导出文件单人登记 |
| 独立进程及其运行配置 | `services/<service>/` | 服务内实现可分工；跨服务契约、runtime配置与共享registry由一人集中改 |
| 客户端专属实现 | `apps/<client>/` | 宿主能力留客户端；共享来源和派生副本按已有同步机制改，不能两边手补 |
| 数据结构与演进 | `db/`、`db/migrations/` | 原迁移不为新功能回写历史；调用者改动与迁移在同一候选中交接 |
| 生成源码的工具 | `tools/codegen/` | 先改源再生成；明确产物目录和受保护差异 |
| 运维任务、校验和开发工具 | `tools/`中对应职责目录，见其README | 使用已有入口，不把一次性试验加入默认维护命令 |
| 规范、提案与证据 | `docs/`中对应类别，见其README | 当前说明只链接唯一源码；快照记录基线，不覆盖规范 |
| 本机秘密、缓存和产物 | `.local/state`、`.local/cache`、`.local/outputs` | 不入Git、不被发布脚本依赖；必要运行配置由对应进程约定加载 |

跨边界改动的交接必须说清：谁产生事实、谁消费、共享接口在哪、哪些文件是生成物、使用哪个发布入口。两人不能各改一份“相同”配置解决同一事实；先选源，再改消费者。目录归属是职责，不是按文件后缀分类。

## 发布入口

- 站点：`deploy/vps/site-release.sh`
- 控面 API 和 worker：`deploy/vps/control-plane-prebuilt-release.sh`
- 网关：`deploy/vps/gateway-release.sh`
- 工具与运行时技能：`deploy/vps/opencode-release.sh`

源码已经归入 `services/`，线上 `/opt/agent-harness/…` 身份不随仓库目录改名。发布前必须提交完整候选；不要拿工作区碎片发布。旧控面原地构建入口仍保持停用。

## 独立项目与运行数据

- 音频服务和评分实验室：`/home/lenovo/Projects/eimu-audio-lab`，独立 Git、模型源码、依赖锁和协议。
- WorkBuddy 构建项目：`/home/lenovo/Projects/workbuddy-desktop-linux`，保留原 Git 和未提交工作，与 Eimu 源码无关。
- 公共资产：`$XDG_CACHE_HOME/eimu/assets`，默认 `~/.cache/eimu/assets`；可用绝对路径 `EIMU_ASSET_CACHE_DIR` 覆盖。
- Blender 工程：`$XDG_DATA_HOME/eimu/blender`，默认 `~/.local/share/eimu/blender`；既有 `BLENDER_WORK` 覆盖仍有效。

旧 `bridge/blender-bridge`、`deploy-staging/yue2-modal`、`deploy-staging/blender-bridge-tunnel` 和数据链接仅供尚在运行的本机进程兼容。新源码与发布脚本使用新目录；不能再往这些旧入口添加功能。`.pixai-refresh` 是仍在运行的本机刷新与 SSH 隧道入口，保留其稳定路径。

## 搜索与添加文件

先选职责，再搜具体目录：

```bash
rg -n '关键词' src
rg -n '关键词' services/gateway services/opencode-runtime -g '!**/node_modules/**'
git ls-files -- apps services deploy tools docs
```

站点类型入口明确限定 src、维护工具、worker 和根构建配置；文档中的冻结源码、独立客户端、服务与本机资料不参与站点编译。它们被排除，不表示这些包没有自己的构建要求。文档和源码之间的路径以当前目录为准；`docs/archive/` 的原文保留旧路径作为历史证据。

新目录先归入上面的已有职责。临时补丁进 `.local/tmp/patch-staging`，记忆队列进 `.local/state/memory-queue`，截图和生成输出进 `.local/outputs`。根目录不再新增以日期、模型名、`eval-*`、`tmp-*` 命名的并列工作区。

根目录仅保留工具自动发现的构建配置、项目入口说明和 Next.js 自动读取的 `.env.production.local`。旧视频与导出包在 `.local/outputs/`；临时脚本在 `.local/tmp/`；凭证副本在权限受限的 `.local/state/secrets/`，维护工具已改用新路径。
