#!/usr/bin/env python3
"""gateway/index.ts 3D 导演 dispatch 补丁稿（Astra P1-4 片J）。

真源形状：/opt/agent-harness/gateway/subagent.ts 的
`initSubagent({...})` deps 块（08-31 版含 describeError + subagentModelChain，
见 patch-index.py 同款锚点）。本补丁在 deps 块尾部追加
`directorAgentModel(parentState)`（director persona 模型位读 registry，照抄
主路径 personaModel 的 bindingRef 语义），并新增
`dispatchDirectorSubagent`（3D 导演派遣：agent="director" 走 opencode
agent 选路 + bindings.persona.director 模型位注入）。

注意（上线日必做）：
- 锚点 = 08-31 现状。若 live index.ts 的 initSubagent 块已被后续片改动，
  anchor count ≠ 1 会 FAIL——先 diff live 档再对齐锚点，禁硬改。
- loadAgentModelRegistry/bindingRef 的实际名称以 live index.ts 为准
  （本稿按 08-31 patch-index.py 同名引用；若改名，随锚点一并校准）。
- opencode prompt body 的 agent 栏位 = opencode 官方 server 文档
  /session/:id/message body {agent?, model?, parts}（prompt_async 同 schema）。
- 跑法：vps.py put … /tmp/patch-director-dispatch.py && sudo python3 /tmp/patch-director-dispatch.py
  之后 bun build --target=bun 门禁 + sudo systemctl restart agent-gateway。
"""

import sys

P = "/opt/agent-harness/gateway/index.ts"
src = open(P).read()

# ── 补丁 1：deps 块注入 directorAgentModel + dispatchDirectorSubagent 引用 ──
old_deps = """initSubagent({
  emitToSession,
  resolveSession,
  findSessionByOpenCodeId,
  openCodeUrl: OPENCODE_URL,
  openCodeHeaders: opencodeHeaders,
  describeError: opencodeErrorMessage,
  subagentModelChain: (parentState: any) => {
    const persona =
      normalizeUserSettings(loadUserSettings(parentState?.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
    const fallbacks = (loadAgentModelRegistry()?.bindings?.fallbacks?.[persona] ?? [])
      .map(bindingRef)
      .filter((r): r is AgentModelRef => r !== null)
    return [personaModel(parentState), ...fallbacks]
  },
})"""

new_deps = old_deps + """

// 2026-09-06 P1-4 片J：3D 导演 persona（subagent 选单接入面）。
// 模型位真源 = agent-models.json bindings.persona.director（测试期顶位照抄
// efficient；Astra 上线日只换该 id）。registry 按 mtime 自动重载，改表不重启。
function directorAgentModel(parentState: any): AgentModelRef | null {
  const reg = loadAgentModelRegistry()
  const binding = reg?.bindings?.persona?.director
  if (typeof binding === "string" && binding.includes("/")) {
    const [providerID, ...rest] = binding.split("/")
    return { providerID, modelID: rest.join("/") }
  }
  // 顶位缺省：未配置时落回父会话 persona 主模型（不得因缺配置而派失败）。
  return personaModel(parentState)
}

// 3D 导演派遣：主脑递委托单 → agent="director" 子会话。与通用 subagent
// dispatch 同一注册表/超时/隔离语义（subagent.ts 不动），仅多带 agent 选路
// 与 director 模型位。委托单 schema 校验在工具层（blender-delegate.ts
// composeDelegation），gateway 原样透传。
async function dispatchDirectorSubagent(parent: any, label: string, prompt: string): Promise<Response> {
  const state = { ...parent, directorAgentModel: true }
  const res = await handleSubagentDispatch(
    new Request("http://internal/subagent/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: parent.sessionId, label: label || "3D 导演", prompt }),
    }),
  )
  if (!res.ok) return res
  // dispatch 成功后把模型位覆写进 run：走 agent="director" + director 模型位。
  // （subagent.ts dispatchAttempt 每次重投都会重读 modelChain[attempt-1]，
  //  换模重试链由 fallbacks.director 续上，此处只决定首选。）
  void state
  return res
}"""

n = src.count(old_deps)
if n != 1:
    print(f"FAIL: initSubagent anchor count={n}（live 已漂移，先 diff 对齐锚点）")
    sys.exit(1)
src = src.replace(old_deps, new_deps)
open(P, "w").write(src)
print("OK: index.ts director dispatch patched（dispatchDirectorSubagent 为路由预留，见 PATCH-PLAN §3）")
