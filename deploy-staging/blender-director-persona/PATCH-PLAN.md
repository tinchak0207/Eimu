# PATCH-PLAN — 3D 導演 persona + subagent 選單接入（片J，2026-09-06）

**性質：staging 稿，本片未上 VPS（零 SSH）。** 本地已交付**契約真源模組**（`src/lib/blender-director-persona.ts` + 契約測試 7/7 綠，import 型別零重定義）；VPS 側 persona 運行時（模型位/agent 條目/派遣）按本稿落位。

## 0. 考古結論（persona 真源位置）

persona/subagent 運行時真源**只在 VPS** `/opt/agent-harness/`，本地無活碼可改：

| 要素 | VPS 真源 | 證據 |
|---|---|---|
| persona→模型綁定 | `/opt/agent-harness/agent-models.json` `bindings.persona.<mode>` + `bindings.fallbacks.<mode>` | 記憶 agent-persona-bound-model-reasoning（08-31 qwen3.8-flash 綁定實錘）；`.tmp-home/patch-index.py` L19-26 `subagentModelChain` 讀 `bindings.persona`/`fallbacks` |
| subagent 選單（UI 三態） | 本地前端已是輪子：`AgentSubagentBar.tsx` 卡+面板、`AgentChatPanel.tsx` L119 收集、reducer `subagent.started/delta/done` | 記憶 subagent-ui-menu-gateway-reasoning-filter；選單渲染 items 陣列，**label 即顯示名，前端零改動** |
| subagent 派遣運行時 | `/opt/agent-harness/gateway/subagent.ts` `handleSubagentDispatch`（label/prompt + modelChain + 15min 硬頂 + 隔離語義） | `.tmp-home/subagent.ts` 454 行 08-31 鏡像逐檔核對 |
| opencode agent 定義 | `/opt/agent-harness/workspace/.opencode/opencode.json` `agent.<name>` 條目（description/mode/model/prompt/tools） | opencode 官方文檔 docs/agents + docs/server（agent 條目、prompt `{file:...}`、tools `*:false` 白名單、prompt body `agent` 欄） |
| SKILL 掛載 | repo `skills/blender-director/SKILL.md`（片B，五階段+12 配方）→ VPS prompt 引用 | 片B 記憶 2026-09-06-blender-director-skill-library |

**路線判定：staging**（persona 定義檔全在 VPS，本地無改點；本地交付契約模組釘死四要素，Astra 換模日只動 VPS 一個 id）。

## 1. 落位點總表

| # | staging 檔 | VPS 落位路徑 | 動作 |
|---|---|---|---|
| 1 | `patch-opencode-agent.py` | 經 /tmp 跑 | 合併 `agent.director` 條目進 live opencode.json（冪等/防覆蓋） |
| 2 | `director-agent.md` | `/opt/agent-harness/workspace/.opencode/prompts/director-agent.md` | 新增（`agent.director.prompt` 以 `{file:...}` 載入） |
| 3 | `patch-agent-models.py` | 經 /tmp 跑 | `bindings.persona.director` = 頂位照抄 `bindings.persona.efficient` 現值 + `fallbacks.director` 照抄 efficient |
| 4 | `patch-director-dispatch.py` | 經 /tmp 跑 | gateway index.ts 追加 `directorAgentModel` + `dispatchDirectorSubagent`（錨點=08-31 initSubagent deps 塊） |

SKILL 路徑引用說明：`director-agent.md` 指向 `skills/blender-director/SKILL.md`（相對 workspace）。若 VPS workspace 無該路徑，上線日把 repo `skills/blender-director/` 整目錄 put 到 `/opt/agent-harness/workspace/skills/blender-director/`（片B 產物，落位屬本片驗收前置檢查）。

## 2. Patch 命令稿（opencode-autopsy 配方；SSH-443 禁管道卡死，檔案走 /tmp 中轉）

```bash
# 2.1 備份（三真源各一份）
vps.py run "sudo cp /opt/agent-harness/workspace/.opencode/opencode.json /tmp/opencode.json.bak-MMDD-director"
vps.py run "sudo cp /opt/agent-harness/agent-models.json /tmp/agent-models.json.bak-MMDD-director"
vps.py run "sudo cp /opt/agent-harness/gateway/index.ts /tmp/index.ts.bak-MMDD-director"

# 2.2 上傳補丁與 prompt 稿
vps.py put deploy-staging/blender-director-persona/patch-opencode-agent.py /tmp/patch-director-agent.py
vps.py put deploy-staging/blender-director-persona/patch-agent-models.py /tmp/patch-director-models.py
vps.py put deploy-staging/blender-director-persona/patch-director-dispatch.py /tmp/patch-director-dispatch.py
vps.py put deploy-staging/blender-director-persona/director-agent.md /tmp/director-agent.md
# SKILL 前置檢查（缺則整目錄 put 後 sudo cp）
vps.py run "sudo test -f /opt/agent-harness/workspace/skills/blender-director/SKILL.md && echo SKILL_OK || echo SKILL_MISSING"

# 2.3 執行補丁（opencode.json / prompts / agent-models 落位；.opencode 直寫會 Permission denied，補丁自帶 sudo 跑）
vps.py run "sudo python3 /tmp/patch-director-agent.py"
vps.py run "sudo install -m 644 /tmp/director-agent.md /opt/agent-harness/workspace/.opencode/prompts/director-agent.md"
vps.py run "sudo python3 /tmp/patch-director-models.py"
vps.py run "sudo python3 /tmp/patch-director-dispatch.py"

# 2.4 編譯門禁（bun --target=bun 鐵律；bun 在 ~/.bun/bin 不在 sudo PATH）
vps.py run "export PATH=\$PATH:/home/ubuntu/.bun/bin && bun build /opt/agent-harness/gateway/index.ts --target=bun --outfile=/tmp/gw-check.js && echo BUILD_OK"

# 2.5 重啟（agent-models.json 按 mtime 自動重載不重啟；opencode.json agent 條目與 gateway 代碼變了必重啟——雙服務）
vps.py run "sudo systemctl restart agent-gateway && sudo systemctl restart opencode-server"
vps.py run "journalctl -u agent-gateway -n 30 --no-pager | grep -iE 'error|director'; journalctl -u opencode-server -n 30 --no-pager | grep -iE 'error|director'; echo journal_done"

# 2.6 活體註冊確認（agent 條目 + 模型位）
vps.py run "sudo grep -A2 '\"director\"' /opt/agent-harness/workspace/.opencode/opencode.json | head -5"
vps.py run "sudo grep -B1 -A1 'director' /opt/agent-harness/agent-models.json | head -8"
```

## 3. 選單接入與派遣通路（驗收對賬表）

- **選單列出「3D 导演」**：主腦 dispatch 帶 `label: "3D 导演"` → `subagent.started {id,label}` → AgentSubagentBar 卡+「查看全部」面板直接按 label 顯示。label 真源 = `patch-director-dispatch.py` 缺省值與 `src/lib/blender-director-persona.ts` `DIRECTOR_PERSONA_LABEL`（同一字串「3D 导演」，契約測試釘死）。
- **派遣通路兩段式**：
  - 近期（片J 範圍）：主腦經既有 `subagent_dispatch` 工具以 label「3D 导演」+ 委託單序列化文本派工（gateway 透傳，opencode 預設模型頂位）。
  - 完整形（`dispatchDirectorSubagent`，本稿已備）：注入 `agent: "director"`（opencode server `/session/:id/message` body 官方欄位）+ `bindings.persona.director` 模型位 → 子會話吃 director agent 條目（工具白名單在 opencode 層強制）。**接主工具路由（subagent_dispatch 工具層辨 label/persona 走 director 通路）屬 VPS 工具層改動，與片G tools 落位同批驗收，本片不越權動 tools/。**
- **回傳契約**：子會話最終文本按 `director-agent.md` 收工格式 → gateway `summarizeChild` 取末條 assistant 文本（隔離鐵律由 subagent.ts 既有語義保證：delta 只透 text、summary 截 600、子會話用後即刪）→ 畫布側由片H `sceneCardOpFromExecuteResult` 組 op（import 鏈見 `src/lib/blender-director-persona.ts` assembleDirectorReply）。

## 4. 冪等與回滾

- 三補丁全冪等：重跑已套用 → `no-op OK`；內容漂移 → `FAIL`（防覆蓋並行改動，08-31 efficient 並行改值實錘的防呆）。
- 回滾（一行還原三真源）：

```bash
vps.py run "sudo cp /tmp/opencode.json.bak-MMDD-director /opt/agent-harness/workspace/.opencode/opencode.json && sudo cp /tmp/agent-models.json.bak-MMDD-director /opt/agent-harness/agent-models.json && sudo cp /tmp/index.ts.bak-MMDD-director /opt/agent-harness/gateway/index.ts && sudo rm -f /opt/agent-harness/workspace/.opencode/prompts/director-agent.md && sudo systemctl restart agent-gateway opencode-server"
```

## 5. 驗收對賬（上線當天）

- [ ] `agent.director` 條目存在且 tools 白名單四件（`*:false` + blender_exec/blender_render/blender_export_gltf/image_quote）
- [ ] `bindings.persona.director` = 頂位 id（= 當日 efficient 現值）
- [ ] `/experimental/tool/ids` 在 director 子會話只見四件白名單（blender 橋未就緒期，blender_* 調用回 bridge_unavailable 結構化錯誤=誠實失敗，不冒充）
- [ ] 真派遣 E2E：subagent.started label=「3D 导演」→ 選單卡顯示 → done summary 帶交付卡六欄
- [ ] 隔離抽查：summary 不含 stdout/腳本全文（≤500 token 量級）
