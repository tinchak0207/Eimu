# 仓库导航

先按任务进入下面的目录。目录名含 `staging`、日期很旧，或被站点发布排除，都不等于已经废弃。

| 要改什么 | 从哪里看 |
| --- | --- |
| 页面、接口路由 | `src/app/`，接口在 `src/app/api/` |
| 界面组件 | `src/components/` |
| 站点业务逻辑、供应商与代理 | `src/lib/` |
| Agent 网关、会话与调度 | `deploy-staging/gateway/index.ts` 及同目录模块 |
| Agent 工具、提示词、插件 | `deploy-staging/opencode-runtime/` 的 `tools/`、`lib/`、`skills/`、`plugin/` 与配置 |
| 生成任务后台执行 | `worker/generation-worker.ts`，根 `package.json` 的 `generation:worker` 指向这里 |
| 数据库结构与迁移 | `db/migrations/`；执行入口查根 `package.json` 的 `ops:migrate`、`generation:migrate` |
| 发布与基础设施配置 | `deploy/`，主要发布入口在 `deploy/vps/` |
| 微信小程序 | `miniapp/`，独立 `package.json`，Taro 构建 |
| 桌面端与本机能力 | `desktop/`，独立 `package.json`，Electron 打包 |
| 专项工作流与技能资产 | 根 `skills/`；不要与下面的 Agent 运行时技能混为一份 |
| 历史设计、旧方案 | `docs/archive/`，作为背景材料查阅，不据此认定当前行为 |

`deploy-staging/gateway/` 是网关发布脚本实际打包的源码，不能整目录当临时文件删除。`gateway-release.sh` 直接从提交执行 `git archive` 打包，运行时需要的 `nanoid` 及其命令入口共 **26 个文件**仍保留跟踪。`@types/node`、`bun-types`、`undici-types` 共 **508 个开发类型文件**只退出版本跟踪，本地实体保留；新工作区或 CI 可执行 `npm install --prefix deploy-staging/gateway`，按该目录包清单恢复开发依赖。不要把开发类型与发布运行时依赖一起清空。

Agent 运行时技能在 `deploy-staging/opencode-runtime/skills/`，`opencode-release.sh` 的发布范围明确包含它，并安装到服务端 `.opencode`。根 `skills/` 是另一组仓库资产；控面预构建脚本也包含根 `skills/`。修改某个技能前，先查调用方和对应发布范围，不能认定两处自动同步，也不要假设存在根 `runtime/skills/`。

## 发布入口只在需要发布时查阅

| 发布对象 | 查阅脚本 |
| --- | --- |
| 自托管站点 | `deploy/vps/site-release.sh` |
| 控面 API 与 worker 的离机预构建发布 | `deploy/vps/control-plane-prebuilt-release.sh` |
| Agent 网关 | `deploy/vps/gateway-release.sh` |
| Agent 工具与运行时技能 | `deploy/vps/opencode-release.sh` |

这些是源码入口，不表示已经发布或与线上一致。先读脚本顶部用法与发布约束；导航整理不执行它们。旧 `deploy/vps/deploy-control-plane.sh` 的 `deploy` 分支已硬停用，不能拿它在生产主机原地全量构建。

## 限定范围找代码

根目录同时存在依赖、媒体和历史工作区。不要使用 `rg --hidden --no-ignore .` 扫整棵目录。先列出相关的已跟踪文件，再在明确目录内搜索：

```bash
# 只看产品源码的文件清单
git ls-files -- src/app src/components src/lib worker db

# 按症状查站点
rg -n '关键词' src/app src/components src/lib

# 按症状查网关与 Agent 运行时，排除依赖和服务缓存
rg -n -g '!**/node_modules/**' -g '!**/vendor/**' -g '!**/services/**' \
  '关键词' deploy-staging/gateway deploy-staging/opencode-runtime

# 查发布链对某个目录的引用
rg -n 'opencode-runtime|git archive' deploy/vps
```

根 `package.json` 管站点启动和通用运维入口；小程序、桌面端各有自己的包脚本。根 `tsconfig.json` 排除了 `miniapp/`、`deploy-staging/` 等目录，站点类型检查不覆盖整个仓库。

## 本地杂物与恢复

凭证、缓存、日志和生成产物按现有 `.gitignore` 处理，不放进源码目录。一次性补丁放 `.patch-staging/`，记忆队列放 `.memory-queue/`；两处只用于本地暂存，已明确忽略，不能存放唯一一份功能实现。需要长期维护的代码应放到上表对应入口。

`.gitignore` 管版本跟踪，`.zcodeignore` 管该工具的检索，`.vercelignore` 管站点上传，三者作用不同。被忽略的文件仍可能占磁盘，也可能包含有效数据；不要用 `git clean -fdx` 清理共享工作区。

2026-11-26 本轮移出工作区的历史材料保存在仓库外的 `/home/lenovo/Documents/image-app-retired-20261126/`，恢复时先查该目录清单。旧本地分支的原始 ref、SHA 和恢复命令见其中 `branches.tsv`，提交由 `refs/archive/workspace-cleanup-20261126/` 保留；这次没有删除任何 worktree。其他分支、worktree 或日期旧的目录，未经过引用与数据检查不能视为废弃。
