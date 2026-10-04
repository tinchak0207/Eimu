# PATCH-PLAN — 3D 导演 persona + subagent 选单接入（片J，2026-09-06）

**性质：staging 稿，本片未上 VPS（零 SSH）。** 本地已交付**契约真源模组**（`src/lib/blender-director-persona.ts` + 契约测试 7/7 绿，import 型别零重定义）；VPS 侧 persona 运行时（模型位/agent 条目/派遣）按本稿落位。

## 0. 考古结论（persona 真源位置）

persona/subagent 运行时真源**只在 VPS** `/opt/agent-harness/`，本地无活码可改：

| 要素 | VPS 真源 | 证据 |
|---|---|---|
| persona→模型绑定 | `/opt/agent-harness/agent-models.json` `bindings.persona.<mode>` + `bindings.fallbacks.<mode>` | 记忆 agent-persona-bound-model-reasoning（08-31 qwen3.8-flash 绑定实锤）；`.tmp-home/patch-index.py` L19-26 `subagentModelChain` 读 `bindings.persona`/`fallbacks` |
| subagent 选单（UI 三态） | 本地前端已是轮子：`AgentSubagentBar.tsx` 卡+面板、`AgentChatPanel.tsx` L119 收集、reducer `subagent.started/delta/done` | 记忆 subagent-ui-menu-gateway-reasoning-filter；选单渲染 items 阵列，**label 即显示名，前端零改动** |
| subagent 派遣运行时 | `/opt/agent-harness/gateway/subagent.ts` `handleSubagentDispatch`（label/prompt + modelChain + 15min 硬顶 + 隔离语义） | `.tmp-home/subagent.ts` 454 行 08-31 镜像逐档核对 |
| opencode agent 定义 | `/opt/agent-harness/workspace/.opencode/opencode.json` `agent.<name>` 条目（description/mode/model/prompt/tools） | opencode 官方文档 docs/agents + docs/server（agent 条目、prompt `{file:...}`、tools `*:false` 白名单、prompt body `agent` 栏） |
| SKILL 挂载 | repo `skills/blender-director/SKILL.md`（片B，五阶段+12 配方）→ VPS prompt 引用 | 片B 记忆 2026-09-06-blender-director-skill-library |

**路线判定：staging**（persona 定义档全在 VPS，本地无改点；本地交付契约模组钉死四要素，Astra 换模日只动 VPS 一个 id）。

## 1. 落位点总表

| # | staging 档 | VPS 落位路径 | 动作 |
|---|---|---|---|
| 1 | `patch-opencode-agent.py` | 经 /tmp 跑 | 合并 `agent.director` 条目进 live opencode.json（幂等/防覆盖） |
| 2 | `director-agent.md` | `/opt/agent-harness/workspace/.opencode/prompts/director-agent.md` | 新增（`agent.director.prompt` 以 `{file:...}` 载入） |
| 3 | `patch-agent-models.py` | 经 /tmp 跑 | `bindings.persona.director` = 顶位照抄 `bindings.persona.efficient` 现值 + `fallbacks.director` 照抄 efficient |
| 4 | `patch-director-dispatch.py` | 经 /tmp 跑 | gateway index.ts 追加 `directorAgentModel` + `dispatchDirectorSubagent`（锚点=08-31 initSubagent deps 块） |

SKILL 路径引用说明：`director-agent.md` 指向 `skills/blender-director/SKILL.md`（相对 workspace）。若 VPS workspace 无该路径，上线日把 repo `skills/blender-director/` 整目录 put 到 `/opt/agent-harness/workspace/skills/blender-director/`（片B 产物，落位属本片验收前置检查）。

## 2. Patch 命令稿（opencode-autopsy 配方；SSH-443 禁管道卡死，档案走 /tmp 中转）

```bash
# 2.1 备份（三真源各一份）
vps.py run "sudo cp /opt/agent-harness/workspace/.opencode/opencode.json /tmp/opencode.json.bak-MMDD-director"
vps.py run "sudo cp /opt/agent-harness/agent-models.json /tmp/agent-models.json.bak-MMDD-director"
vps.py run "sudo cp /opt/agent-harness/gateway/index.ts /tmp/index.ts.bak-MMDD-director"

# 2.2 上传补丁与 prompt 稿
vps.py put deploy-staging/blender-director-persona/patch-opencode-agent.py /tmp/patch-director-agent.py
vps.py put deploy-staging/blender-director-persona/patch-agent-models.py /tmp/patch-director-models.py
vps.py put deploy-staging/blender-director-persona/patch-director-dispatch.py /tmp/patch-director-dispatch.py
vps.py put deploy-staging/blender-director-persona/director-agent.md /tmp/director-agent.md
# SKILL 前置检查（缺则整目录 put 后 sudo cp）
vps.py run "sudo test -f /opt/agent-harness/workspace/skills/blender-director/SKILL.md && echo SKILL_OK || echo SKILL_MISSING"

# 2.3 执行补丁（opencode.json / prompts / agent-models 落位；.opencode 直写会 Permission denied，补丁自带 sudo 跑）
vps.py run "sudo python3 /tmp/patch-director-agent.py"
vps.py run "sudo install -m 644 /tmp/director-agent.md /opt/agent-harness/workspace/.opencode/prompts/director-agent.md"
vps.py run "sudo python3 /tmp/patch-director-models.py"
vps.py run "sudo python3 /tmp/patch-director-dispatch.py"

# 2.4 编译门禁（bun --target=bun 铁律；bun 在 ~/.bun/bin 不在 sudo PATH）
vps.py run "export PATH=\$PATH:/home/ubuntu/.bun/bin && bun build /opt/agent-harness/gateway/index.ts --target=bun --outfile=/tmp/gw-check.js && echo BUILD_OK"

# 2.5 重启（agent-models.json 按 mtime 自动重载不重启；opencode.json agent 条目与 gateway 代码变了必重启——双服务）
vps.py run "sudo systemctl restart agent-gateway && sudo systemctl restart opencode-server"
vps.py run "journalctl -u agent-gateway -n 30 --no-pager | grep -iE 'error|director'; journalctl -u opencode-server -n 30 --no-pager | grep -iE 'error|director'; echo journal_done"

# 2.6 活体注册确认（agent 条目 + 模型位）
vps.py run "sudo grep -A2 '\"director\"' /opt/agent-harness/workspace/.opencode/opencode.json | head -5"
vps.py run "sudo grep -B1 -A1 'director' /opt/agent-harness/agent-models.json | head -8"
```

## 3. 选单接入与派遣通路（验收对账表）

- **选单列出「3D 导演」**：主脑 dispatch 带 `label: "3D 导演"` → `subagent.started {id,label}` → AgentSubagentBar 卡+「查看全部」面板直接按 label 显示。label 真源 = `patch-director-dispatch.py` 缺省值与 `src/lib/blender-director-persona.ts` `DIRECTOR_PERSONA_LABEL`（同一字串「3D 导演」，契约测试钉死）。
- **派遣通路两段式**：
  - 近期（片J 范围）：主脑经既有 `subagent_dispatch` 工具以 label「3D 导演」+ 委托单序列化文本派工（gateway 透传，opencode 预设模型顶位）。
  - 完整形（`dispatchDirectorSubagent`，本稿已备）：注入 `agent: "director"`（opencode server `/session/:id/message` body 官方栏位）+ `bindings.persona.director` 模型位 → 子会话吃 director agent 条目（工具白名单在 opencode 层强制）。**接主工具路由（subagent_dispatch 工具层辨 label/persona 走 director 通路）属 VPS 工具层改动，与片G tools 落位同批验收，本片不越权动 tools/。**
- **回传契约**：子会话最终文本按 `director-agent.md` 收工格式 → gateway `summarizeChild` 取末条 assistant 文本（隔离铁律由 subagent.ts 既有语义保证：delta 只透 text、summary 截 600、子会话用后即删）→ 画布侧由片H `sceneCardOpFromExecuteResult` 组 op（import 链见 `src/lib/blender-director-persona.ts` assembleDirectorReply）。

## 4. 幂等与回滚

- 三补丁全幂等：重跑已套用 → `no-op OK`；内容漂移 → `FAIL`（防覆盖并行改动，08-31 efficient 并行改值实锤的防呆）。
- 回滚（一行还原三真源）：

```bash
vps.py run "sudo cp /tmp/opencode.json.bak-MMDD-director /opt/agent-harness/workspace/.opencode/opencode.json && sudo cp /tmp/agent-models.json.bak-MMDD-director /opt/agent-harness/agent-models.json && sudo cp /tmp/index.ts.bak-MMDD-director /opt/agent-harness/gateway/index.ts && sudo rm -f /opt/agent-harness/workspace/.opencode/prompts/director-agent.md && sudo systemctl restart agent-gateway opencode-server"
```

## 5. 验收对账（上线当天）

- [ ] `agent.director` 条目存在且 tools 白名单四件（`*:false` + blender_exec/blender_render/blender_export_gltf/image_quote）
- [ ] `bindings.persona.director` = 顶位 id（= 当日 efficient 现值）
- [ ] `/experimental/tool/ids` 在 director 子会话只见四件白名单（blender 桥未就绪期，blender_* 调用回 bridge_unavailable 结构化错误=诚实失败，不冒充）
- [ ] 真派遣 E2E：subagent.started label=「3D 导演」→ 选单卡显示 → done summary 带交付卡六栏
- [ ] 隔离抽查：summary 不含 stdout/脚本全文（≤500 token 量级）
