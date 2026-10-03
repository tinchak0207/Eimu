# Eimu 插件包

把这个包交给你的 coding agent（Codex、Claude Code、Cursor、OpenClaw 或任何会说 MCP 的客户端），它就能直接用 Eimu 干活：生成图片、按指令改图、生成视频、文字转语音、放大图像，查余额、查任务结果，检索 Eimu 的公开技能库。

- 插件主页（文件位置）：https://eimu.dev/plugin/
- 入口说明（本文件）：https://eimu.dev/plugin/eimu/README.md
- MCP 配置指南：https://eimu.dev/mcp
- MCP 端点：`https://eimu.dev/api/mcp`（JSON-RPC 2.0 / Streamable HTTP）

## 包内文件

```
plugin/
├── marketplace.json                    # 市集索引：只声明 eimu 这一个插件
└── eimu/
    ├── .codex-plugin/plugin.json       # 插件元数据：名称、描述、logo、默认提问
    ├── .mcp.json                       # MCP 端点 + Authorization 头（引用 ${EIMU_BIZ_KEY} 环境变量，不含任何密钥）
    ├── assets/eimu-icon.svg            # 图标
    ├── README.md                       # 本文件
    └── skills/                         # 三个随包技能
        ├── film-production/SKILL.md            # 一句话到成片
        ├── character-consistency/SKILL.md      # 角色一致性
        └── camera-motion/SKILL.md              # 运镜与镜头运动
```

三个技能的正文只引用 Eimu MCP 真实提供的 16 个工具：`list_skills`、`get_skill`、`list_models`、`generate_image`、`edit_image`、`generate_video`、`tts`、`upscale`、`get_quota`、`get_result`、`list_canvas_projects`、`canvas_get_state`、`workflow_read`、`workflow_history`、`workflow_write`、`workflow_rollback`。

## 今天就能用的两种装法

### 装法一：手动配置 MCP（现在就能用，推荐）

打开 https://eimu.dev/mcp ，按你所用客户端复制对应片段。三件不变的事：URL 指向 `https://eimu.dev/api/mcp`、认证走 `Authorization: Bearer`、密钥只放在你本机。

```bash
# 密钥：登录 https://eimu.dev/settings/api-keys 自助签发，只显示一次
export EIMU_BIZ_KEY=sk-biz-你的密钥
```

```toml
# ~/.codex/config.toml
[mcp_servers.eimu]
url = "https://eimu.dev/api/mcp"
bearer_token_env_var = "EIMU_BIZ_KEY"
```

```bash
# Claude Code
claude mcp add --transport http eimu https://eimu.dev/api/mcp \
  --header "Authorization: Bearer $EIMU_BIZ_KEY"
```

装完让 agent 调一次 `tools/list` 确认工具都在。未带密钥会拿到 `401` 与 `WWW-Authenticate: Bearer`。

### 装法二：把插件目录复制到本机

整包已发布在 `https://eimu.dev/plugin/`，可以整目录取回后本地安装：

1. 在你的工作机建一个插件目录，把 `plugin/eimu/` 整个复制进去（Codex 常见的本地插件目录是 `~/.codex/plugins/`，最终以你所用版本的约定为准）。
2. 让你的客户端读取其中的 `.codex-plugin/plugin.json` 与 `.mcp.json`；出包的 `.mcp.json` 已带 `Authorization: Bearer ${EIMU_BIZ_KEY}`，`.mcp.json` 里的 `mcpServers.eimu` 也可以直接合并进你已有的 MCP 配置。
3. 把 `plugin/eimu/skills/` 下的三个目录复制到 agent 的技能目录，让 `film-production` / `character-consistency` / `camera-motion` 出现在 agent 的技能列表里。
4. 授权：签发一把 `sk-biz-…`（https://eimu.dev/settings/api-keys ），放进环境变量 `EIMU_BIZ_KEY`。出包的 `.mcp.json` 已经带 `Authorization: Bearer ${EIMU_BIZ_KEY}`，客户端会读取该环境变量后插值送出，无需再改这个文件。只有客户端不支持 `${VAR}` 插值（那会把字面值原样送出）时，才把密钥直接写进该客户端自己的 headers。
5. 自检：客户端的插件（或技能）列表里能看到 `eimu` 与三个技能名，且 agent 能成功调用一次 `get_quota`。

本地插件目录约定各家不同，本包也尚未通过任何市集的校验流程；如果第 2 步客户端读不到本地插件，直接退回装法一，用同样的 URL 与认证头手工配一遍。

## 市集一键装（待发布，现在跑不通）

Eimu 目前**还没有公开的插件市集仓**，所以下面两条命令现在执行会失败，等仓建立、域名挂上之后再照这样装：

```bash
codex plugin marketplace add <eimu-marketplace-git-url>   # 第 1 步：添加目录（待发布）
codex plugin add eimu@eimu                                # 第 2 步：安装插件
export EIMU_BIZ_KEY=sk-biz-你的密钥                        # 第 3 步：授权
```

不要对用户宣称「一键安装今天可用」——`marketplace.json` 只是把仓的索引形状先定下来，`source` 才会指到本目录。

## 能力与边界

能做的（都走同一本账，与网页端共用配额）：

- 生成图像、按指令编辑图像、放大图像
- 提交视频生成任务（异步，用 `get_result` 轮询）
- 文字转语音
- 列出公开技能条目、列出当前密钥可用的模型与计价、查询余额、查询异步任务结果
- 读取与回滚本账号的画布产线：`list_canvas_projects`（列项目）、`canvas_get_state`（读快照）、`workflow_read` / `workflow_history`（读声明与版本史）、`workflow_write`（声明式写入）、`workflow_rollback`（节点回滚）

**不包含**（Eimu 的 MCP 端点目前没有这些能力，不要在对话里承诺）：

- 成片导出、分镜时间线剪辑、画布节点的逐个手动编排界面（画布产线本身是声明式读写的：`workflow_read` → `workflow_write` → `workflow_rollback`）
- 导演提案与分镜工程文件
- 角色库、素材库的跨工程引用
- 预置运镜库的直接调用（运镜只能写进视频提示词）
