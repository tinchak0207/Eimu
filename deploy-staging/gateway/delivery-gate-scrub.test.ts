// 2026-10-27：运行时/闸门错误句不得进用户可见帧（scrubVisibleProse / scrubVisibleFrame）
import { describe, expect, test } from "bun:test"
import { scrubVisibleProse, scrubVisibleFrame } from "./delivery-gate-scrub.ts"

describe("scrubRuntimeGateErrors via scrubVisibleProse", () => {
  test("计划模式 fail-closed 原文 → 产品句", () => {
    const raw = "计划模式状态查询超时/不可达：已按 fail-closed 拒绝写/执行类工具；只读工具仍可用。"
    const out = scrubVisibleProse(raw)
    expect(out).toBe("这一步暂时没做成，我换条路继续。")
    expect(out).not.toContain("fail-closed")
  })

  test("旧并发闸文案 → 产品句", () => {
    const out = scrubVisibleProse("已有 3 个子代理在跑，等一个完成再派")
    expect(out).toBe("这一步暂时没做成，我换条路继续。")
  })

  test("新并发闸文案 → 产品句", () => {
    const out = scrubVisibleProse("当前在跑的子代理已达上限，等一路完成后再派")
    expect(out).toBe("这一步暂时没做成，我换条路继续。")
  })

  test("subagent_id 不存在 → 产品句", () => {
    const out = scrubVisibleProse("subagent_id 不存在或已过期。本会话最近 3 笔 run：a,b,c")
    expect(out).toBe("这一步暂时没做成，我换条路继续。")
    expect(out).not.toContain("subagent_id")
  })

  test("正常正文不动", () => {
    const raw = "已经把第一镜交上去了，你看一下构图。"
    expect(scrubVisibleProse(raw)).toBe(raw)
  })
})

describe("scrubVisibleFrame session.error / tool.result", () => {
  test("session.error 闸门原文被改写", () => {
    const out = scrubVisibleFrame("session.error", {
      code: "tool_error",
      message: "权限求值失败（HTTP 503），已按 fail-closed 拒绝工具调用。",
      human_message: "权限求值失败（HTTP 503），已按 fail-closed 拒绝工具调用。",
    }) as { message: string; human_message: string }
    expect(out.message).toBe("这一步暂时没做成，我换条路继续。")
    expect(out.human_message).toBe("这一步暂时没做成，我换条路继续。")
  })

  test("tool.result 闸门 human_message 被改写", () => {
    const out = scrubVisibleFrame("tool.result", {
      tool: "bash",
      ok: false,
      error: {
        code: "tool_error",
        message: "计划模式状态不可解析：已按 fail-closed 拒绝写/执行类工具；只读工具仍可用。",
        human_message: "计划模式状态不可解析：已按 fail-closed 拒绝写/执行类工具；只读工具仍可用。",
      },
    }) as { error: { message: string; human_message: string } }
    expect(out.error.human_message).toBe("这一步暂时没做成，我换条路继续。")
    expect(out.error.message).not.toContain("fail-closed")
  })
})
