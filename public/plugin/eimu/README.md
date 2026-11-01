# Eimu 插件包

**不用学提示词设计和分镜，现在你也是导演。**

Eimu 是 **Vibe Directing / Cursor of video**：把模糊需求交给导演工具，拿回**成片**与中间产物（分镜、brief、首尾帧、配音等）。把这个包交给你的 coding agent（Claude Code、Codex、Cursor、OpenClaw 或任何会说 MCP 的客户端），默认只会看到导演工具面。

- 插件文件清单：https://eimu.dev/plugin/
- 本说明：https://eimu.dev/plugin/eimu/README.md
- 接入页（含喂到嘴边的安装 prompt）：https://eimu.dev/mcp
- **主路径端点（远端 HTTP MCP）**：`https://eimu.dev/api/mcp`（JSON-RPC 2.0 / Streamable HTTP）
- 仓库内 `mcp-server/` 是本机 stdio 进阶形态，**不是**对外主路径

## 默认工具面（导演）

`tools/list` 默认只返回约 5 个工具：

| 工具 | 作用 |
|---|---|
| `eimu_direct` | 一句话派工给导演，返回 `job_id`（可 `mode=quote\|plan\|full`，`full` 建议带 `budget_cap`） |
| `eimu_job` | 对 job 做 get／wait／reply／approve／revise／cancel；终态含成片与中间产物 |
| `list_agent_sessions` | 列本账号 agent／导演会话 |
| `get_agent_session` | 读会话对话与产物 |
| `abort_agent_session` | 中止正在跑的会话 |

主技能 `film-production` 的路径就是：**eimu_direct → 轮询 eimu_job → 交成片**。

### 展开原子工具（专家面）

需要自己拼镜头、查模型、读写画布时：

- URL：`https://eimu.dev/api/mcp?toolset=expert`
- 或请求头：`X-Eimu-Toolset: expert`
- 或 `initialize`／`tools/list` 的 `params.toolset = "expert"`

专家面含生图／改图／生视频／TTS／画布产线／harness 闸门等原子工具；**成片主路径仍应走导演工具**，不要把逐镜手拼写成默认教法。

## 包内文件

```
plugin/eimu/
├── .codex-plugin/plugin.json       # 插件元数据
├── .mcp.json                       # 远端 HTTP MCP + Authorization: Bearer ${EIMU_BIZ_KEY}
├── assets/eimu-icon.svg
├── README.md                       # 本文件
└── skills/
    ├── film-production/SKILL.md            # 一句话到成片（导演主路径）
    ├── character-consistency/SKILL.md      # 角色一致性
    └── camera-motion/SKILL.md              # 运镜与镜头运动
```

目前**没有** zip／tar.gz 整包；请按 https://eimu.dev/plugin/ 逐档取回。本说明**不**推销市集一键装。

## 今天就能用的装法

### 装法一：手动配置远端 MCP（推荐）

打开 https://eimu.dev/mcp ，按客户端复制片段。三件不变：URL 指向 `https://eimu.dev/api/mcp`、认证走 `Authorization: Bearer`、密钥只放本机。

```bash
# 密钥：登录 https://eimu.dev/settings/api-keys 自助签发，只显示一次
export EIMU_BIZ_KEY=sk-biz-你的密钥
```

上面这行只对**当前终端**生效。要持久，写入 shell 启动文件（bash `~/.bashrc`，zsh `~/.zshrc`）。完整写入与自查见 https://eimu.dev/mcp 的「一键：把这段发给你的 agent」。

```bash
# Claude Code（--header 必须单引号，写出字面 ${EIMU_BIZ_KEY}）
claude mcp add --transport http --scope user eimu https://eimu.dev/api/mcp \
  --header 'Authorization: Bearer ${EIMU_BIZ_KEY}'
```

```toml
# ~/.codex/config.toml
[mcp_servers.eimu]
url = "https://eimu.dev/api/mcp"
bearer_token_env_var = "EIMU_BIZ_KEY"
```

装完让 agent 调 `tools/list`：默认应看到导演工具（约 5 个），而不是整包原子工具。真 oracle＝`tools/call get_quota`（需 `toolset=expert`）或导演派工回执；`✔ Connected` 只证明握手。

### 装法二：复制插件目录到本机

1. 建本地插件目录，放入本包文件（Codex 常见 `~/.codex/plugins/`，以你客户端约定为准）。
2. 让客户端读取 `.codex-plugin/plugin.json` 与 `.mcp.json`（已含 `Authorization: Bearer ${EIMU_BIZ_KEY}`）。
3. 把 `skills/` 三个目录拷进 agent 技能目录。
4. 持久化 `EIMU_BIZ_KEY`（见上）。客户端不支持 `${VAR}` 时，再把密钥写进该客户端自己的 headers。
5. 自检：技能列表能看到 `film-production`，且 `tools/list` 默认是导演面。

## 能力口径（对外怎么说）

**能做／要承诺的：**

- 把一句话／一段剧本交给导演，拿回**成片**与中间产物
- 同一 job 上改片、批准预算、中止
- 回读历史会话与产物链接
- （专家面）原子生成、画布声明式读写、交付契约／媒体硬检

**口径：**

- 对外只讲「导演拿走需求 → 交回成片与中间产物」；禁止把 Eimu 说成只交素材、要用户自己拼片的裸生成机

**诚实边界（仍成立）：**

- 默认面不展开全部原子工具（要显式 `toolset=expert`）
- 不提供「预置运镜库 API」或跨工程角色库的独立产品面；运镜与角色一致性走导演链路与对应 skill
- `eimu_direct`／`eimu_job` 若回 `not_ready`，按回执用 `toolset=expert` + `run_agent`／`get_agent_session` 过渡，叙事仍是「交出去拿成片」

## 本机 stdio（非主路径）

仓库 `mcp-server/` 提供本机 stdio 形态（工具集与环境变量 `IMAGE_STUDIO_*` 与远端不同）。需要仓库权限才能构建。对外安装与文档以**远端 HTTP MCP**为准。
