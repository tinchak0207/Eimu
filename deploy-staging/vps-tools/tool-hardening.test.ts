// D2／D4（2026-10-02）：三個 dispatch/status/workflow 工具的硬化契約測試。
//
// 為什麼需要：病灶是「失敗不帶原因」——實測 579 次派工中 124 次失敗（21.4%），其中空參數
// 呼叫 135 次（`workflow_start {}` 97 次），且 109 筆錯誤訊息是空字串。模型拿到空錯誤只能
// 原樣重試，這正是 3,525 次重複呼叫的養分。硬化契約：
//   1. 缺必填欄位 → 本地就擋，回「缺哪個欄位 + 可照抄的完整參數」，且**不打網路**。
//   2. 網關錯誤 → 原樣透傳 error.code（不再壓成單一 dispatch_failed）。
//   3. subagent_status 支援 `latest` 與多筆候選／過期但產物在盤的取回。
//
// 測試對象是 opencode-runtime 的**唯一真源**（vps-tools 不再放重複實作）。
//
// 跑法：本機沒有 node_modules（bun registry 無 DNS），`@opencode-ai/plugin/tool` 解析不到 →
// 本檔必須在**有依賴的環境**執行，也就是生產機：
//   scp 本檔 + eimu-guard.test.ts 到 VPS → cd /opt/agent-harness/workspace/.opencode → bun test <檔案>
// 這也是唯一能同時驗「部署後的代碼」與「真實依賴解析」的地方。
import { afterAll, beforeEach, describe, expect, test } from "bun:test"

const dispatchTool = (await import("../opencode-runtime/tools/subagent_dispatch")).default
const statusTool = (await import("../opencode-runtime/tools/subagent_status")).default
const workflowStartTool = (await import("../opencode-runtime/tools/workflow_start")).default

type ToolResult = { title: string; output: string }
const parse = (r: unknown): any => JSON.parse((r as ToolResult).output)
const ctx = { sessionID: "ses_tool_hardening" } as any

/** 記錄發出的請求；每個測試前清空。 */
const calls: Array<{ url: string; body: any }> = []
const realFetch = globalThis.fetch
let nextResponse: any = { ok: true, status: 200, json: async () => ({ ok: true }) }

globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
  return nextResponse
}) as unknown as typeof fetch

afterAll(() => {
  globalThis.fetch = realFetch
})

beforeEach(() => {
  calls.length = 0
  nextResponse = { ok: true, status: 200, json: async () => ({ ok: true }) }
})

describe("D2 派工硬化：缺必填欄位本地擋下並給可執行示例", () => {
  test("subagent_dispatch {}：回 missing_required_args、指名兩欄、附範例，且不打網路", async () => {
    const r = parse(await dispatchTool.execute({} as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("missing_required_args")
    expect(r.missing).toEqual(["label", "prompt"])
    expect(r.error.hint).toContain("label")
    expect(r.error.hint).toContain("prompt")
    expect(r.error.hint).toContain("示例")
    expect(r.example.prompt).toBeTruthy()
    expect(calls.length).toBe(0) // 關鍵：不讓空參數走到網路層
  })

  test("只缺 prompt：missing 只列 prompt（不誤報 label）", async () => {
    const r = parse(await dispatchTool.execute({ label: "素材整理" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(["prompt"])
    expect(calls.length).toBe(0)
  })

  test("空白字串 label 視同缺欄", async () => {
    const r = parse(await dispatchTool.execute({ label: "   ", prompt: "做一件事" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(["label"])
  })

  test("欄位齊全：送出 trim 後的值，async 模式回 subagent_id", async () => {
    nextResponse = { ok: true, status: 200, json: async () => ({ ok: true, status: "running", subagent_id: "sub_abc" }) }
    const r = parse(await dispatchTool.execute({ label: " 素材整理 ", prompt: " 任务书 ", async: true } as any, ctx))
    expect(r.ok).toBe(true)
    expect(r.subagent_id).toBe("sub_abc")
    expect(calls.length).toBe(1)
    expect(calls[0].body.label).toBe("素材整理")
    expect(calls[0].body.prompt).toBe("任务书")
    expect(calls[0].body.sessionId).toBe("ses_tool_hardening")
  })

  test("網關錯誤碼原樣透傳（不再壓成 dispatch_failed）", async () => {
    nextResponse = {
      ok: false,
      status: 429,
      json: async () => ({ ok: false, code: "concurrency_limit", error: "已有 3 个子代理在跑" }),
    }
    const r = parse(await dispatchTool.execute({ label: "a", prompt: "b" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("concurrency_limit")
    expect(r.error.hint).toContain("已有 3 个子代理在跑")
    expect(r.http_status).toBe(429)
  })

  test("網關連不上：gateway_unreachable（非空錯誤）", async () => {
    const saved = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    try {
      const r = parse(await dispatchTool.execute({ label: "a", prompt: "b" } as any, ctx))
      expect(r.ok).toBe(false)
      expect(r.error.code).toBe("gateway_unreachable")
      expect(r.error.hint).toContain("ECONNREFUSED")
    } finally {
      globalThis.fetch = saved
    }
  })
})

describe("D4 subagent_status：latest 別名與過期/多筆的可執行回饋", () => {
  test("缺 subagent_id → missing_required_args，提示可傳 latest", async () => {
    const r = parse(await statusTool.execute({} as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("missing_required_args")
    expect(r.error.hint).toContain("latest")
    expect(calls.length).toBe(0)
  })

  test("latest 原樣送給網關（由網關解析最近一筆）", async () => {
    nextResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, done: false, subagent_id: "sub_resolved", label: "素材整理", elapsed_ms: 12000 }),
    }
    const r = parse(await statusTool.execute({ subagent_id: "latest" } as any, ctx))
    expect(calls[0].body.subagent_id).toBe("latest")
    expect(r.ok).toBe(true)
    expect(r.subagent_id).toBe("sub_resolved") // 網關解析出的真 id 要回給模型，才能存起來重用
  })

  test("label 前綴命中多筆 → 回候選清單（不是假 not_found）", async () => {
    nextResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, multiple: true, candidates: [{ id: "sub_1" }, { id: "sub_2" }] }),
    }
    const r = parse(await statusTool.execute({ subagent_id: "素材" } as any, ctx))
    expect(r.ok).toBe(true)
    expect(r.multiple).toBe(true)
    expect(r.candidates.length).toBe(2)
  })

  test("記錄過期但產物在盤 → ok:true 附 artifact_path 供直接驗收（網關契約：done=true）", async () => {
    nextResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        done: true,
        status: "ok",
        label: "素材整理",
        artifact_path: "outputs/sub_9/result.md",
        artifact_bytes: 2048,
      }),
    }
    const r = parse(await statusTool.execute({ subagent_id: "sub_9" } as any, ctx))
    expect(r.ok).toBe(true)
    expect(r.artifact_path).toBe("outputs/sub_9/result.md")
    expect(r.artifact_bytes).toBe(2048)
  })

  test("真找不到 → not_found，且 recent_runs 結構化透傳（不是從句子裡撈）", async () => {
    const recent = [
      { id: "sub_1", status: "ok", label: "素材整理" },
      { id: "sub_2", status: "running", label: "分鏡" },
    ]
    nextResponse = {
      ok: false,
      status: 404,
      json: async () => ({
        ok: false,
        code: "not_found",
        error: "subagent_id 不存在或已过期。本会话最近 3 笔 run：sub_1(ok 素材整理)、sub_2(running 分镜)",
        recent_runs: recent,
      }),
    }
    const r = parse(await statusTool.execute({ subagent_id: "sub_9" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("not_found")
    expect(r.error.hint).toContain("sub_1")
    expect(r.recent_runs).toEqual(recent)
  })
})

describe("D2 workflow_start：空呼叫指名必填 template_id 並列出可用模板", () => {
  test("{} → missing_required_args、附 6 個模板與範例，且不打網路", async () => {
    const r = parse(await workflowStartTool.execute({} as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("missing_required_args")
    expect(r.missing).toEqual(["template_id"])
    expect(r.available_templates.length).toBe(6)
    expect(r.available_templates).toContain("feature_film")
    expect(r.error.hint).toContain("single_image")
    expect(r.example.template_id).toBe("feature_film")
    expect(calls.length).toBe(0)
  })

  test("帶 feature_film + 鏡頭內容 → 回 workflow_id", async () => {
    nextResponse = { ok: true, status: 200, json: async () => ({ ok: true, workflowId: "wf_1" }) }
    const r = parse(
      await workflowStartTool.execute(
        { template_id: "feature_film", content: { script: "s", shot1: "a", shot2: "b" } } as any,
        ctx,
      ),
    )
    expect(r.ok).toBe(true)
    expect(r.workflow_id).toBe("wf_1")
    expect(calls[0].body.template_id).toBe("feature_film")
    expect(calls[0].body.content.shot2).toBe("b")
  })

  test("後端 400 缺 role → 透傳 missing_roles", async () => {
    nextResponse = {
      ok: false,
      status: 400,
      json: async () => ({ ok: false, code: "missing_roles", error: "缺少必要内容", missing_roles: ["shot1"] }),
    }
    const r = parse(await workflowStartTool.execute({ template_id: "feature_film" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("missing_roles")
    expect(r.missing_roles).toEqual(["shot1"])
  })
})
