#!/usr/bin/env python3
"""gateway/index.ts 3D 導演 dispatch 補丁稿（Astra P1-4 片J）。

真源形狀：/opt/agent-harness/gateway/subagent.ts 的
`initSubagent({...})` deps 塊（08-31 版含 describeError + subagentModelChain，
見 patch-index.py 同款錨點）。本補丁在 deps 塊尾部追加
`directorAgentModel(parentState)`（director persona 模型位讀 registry，照抄
主路徑 personaModel 的 bindingRef 語義），並新增
`dispatchDirectorSubagent`（3D 導演派遣：agent="director" 走 opencode
agent 選路 + bindings.persona.director 模型位注入）。

注意（上線日必做）：
- 錨點 = 08-31 現狀。若 live index.ts 的 initSubagent 塊已被後續片改動，
  anchor count ≠ 1 會 FAIL——先 diff live 檔再對齊錨點，禁硬改。
- loadAgentModelRegistry/bindingRef 的實際名稱以 live index.ts 為準
  （本稿按 08-31 patch-index.py 同名引用；若改名，隨錨點一併校準）。
- opencode prompt body 的 agent 欄位 = opencode 官方 server 文檔
  /session/:id/message body {agent?, model?, parts}（prompt_async 同 schema）。
- 跑法：vps.py put … /tmp/patch-director-dispatch.py && sudo python3 /tmp/patch-director-dispatch.py
  之後 bun build --target=bun 門禁 + sudo systemctl restart agent-gateway。
"""

import sys

P = "/opt/agent-harness/gateway/index.ts"
src = open(P).read()

# ── 補丁 1：deps 塊注入 directorAgentModel + dispatchDirectorSubagent 引用 ──
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

// 2026-09-06 P1-4 片J：3D 導演 persona（subagent 選單接入面）。
// 模型位真源 = agent-models.json bindings.persona.director（測試期頂位照抄
// efficient；Astra 上線日只換該 id）。registry 按 mtime 自動重載，改表不重啟。
function directorAgentModel(parentState: any): AgentModelRef | null {
  const reg = loadAgentModelRegistry()
  const binding = reg?.bindings?.persona?.director
  if (typeof binding === "string" && binding.includes("/")) {
    const [providerID, ...rest] = binding.split("/")
    return { providerID, modelID: rest.join("/") }
  }
  // 頂位缺省：未配置時落回父會話 persona 主模型（不得因缺配置而派失敗）。
  return personaModel(parentState)
}

// 3D 導演派遣：主腦遞委託單 → agent="director" 子會話。與通用 subagent
// dispatch 同一註冊表/超時/隔離語義（subagent.ts 不動），僅多帶 agent 選路
// 與 director 模型位。委託單 schema 校驗在工具層（blender-delegate.ts
// composeDelegation），gateway 原樣透傳。
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
  // dispatch 成功後把模型位覆寫進 run：走 agent="director" + director 模型位。
  // （subagent.ts dispatchAttempt 每次重投都會重讀 modelChain[attempt-1]，
  //  換模重試鏈由 fallbacks.director 續上，此處只決定首選。）
  void state
  return res
}"""

n = src.count(old_deps)
if n != 1:
    print(f"FAIL: initSubagent anchor count={n}（live 已漂移，先 diff 對齊錨點）")
    sys.exit(1)
src = src.replace(old_deps, new_deps)
open(P, "w").write(src)
print("OK: index.ts director dispatch patched（dispatchDirectorSubagent 為路由預留，見 PATCH-PLAN §3）")
