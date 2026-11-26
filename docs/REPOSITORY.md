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
│   ├── reports/         报告
│   ├── research/        研究资料
│   └── archive/         冻结历史，不作为当前实现说明
└── .local/              本机缓存、状态、临时工作和产物，不入库
```

`.git`、`.github`、`.agents`、`.claude`、`.codex`、`.vercel` 是工具约定的元数据；`node_modules` 是依赖，不是业务分区。

## 从任务找到入口

| 任务 | 入口 |
| --- | --- |
| 页面或站内 API | `src/app/` |
| 界面组件 | `src/components/` |
| 站点业务与供应商 | `src/lib/` |
| Agent 会话和调度 | `services/gateway/index.ts` |
| 工具、插件、提示词、运行时技能 | `services/opencode-runtime/` |
| 生成队列 | `worker/generation-worker.ts` |
| 网页开发 | 根目录 `npm run dev` |
| 桌面端、小程序、MCP 包 | 在 `apps/desktop`、`apps/miniapp`、`services/mcp` 使用各自包脚本 |

根 `skills/` 与运行时 `services/opencode-runtime/skills/` 各有调用与发布范围，不自动同步。`tools/generated/music-tools/` 含受保护的历史差异，导出器的 preserve/known-drift 规则继续有效，不能拿中间稿覆盖运行时。

## 发布入口

- 站点：`deploy/vps/site-release.sh`
- 控面 API 和 worker：`deploy/vps/control-plane-prebuilt-release.sh`
- 网关：`deploy/vps/gateway-release.sh`
- 工具与运行时技能：`deploy/vps/opencode-release.sh`

源码已经归入 `services/`，线上 `/opt/agent-harness/…` 身份不随仓库目录改名。本次不部署或重启。发布前必须提交完整候选；不要拿工作区碎片发布。旧控面原地构建入口仍保持停用。

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
