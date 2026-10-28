import "./env"
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { platform } from "./fake-platform"
import { SAMPLE_SCRIPT, makeSample, replay, type SceneScript, type ScriptTurn } from "./arena"

function turns(n: number): ScriptTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "agent",
    text: `第 ${i} 句`,
  }))
}

function faultScript(id: string): SceneScript {
  return {
    id,
    turns: [
      { role: "user", text: "开场，三镜" },
      { role: "agent", text: "出图", tool: "image.generate", args: { kind: "image", node: "shot1" } },
      { role: "user", text: "先别往下" },
      { role: "agent", text: "改口之后的镜头", tool: "image.generate", args: { kind: "image", node: "shot3" } },
      { role: "agent", text: "收束" },
    ],
  }
}

describe("L2 对局台 v0", () => {
  test("样例脚本工具名序列与脚本一致", async () => {
    const out = await replay(SAMPLE_SCRIPT, [])
    expect(out.halted).toBeNull()
    expect(out.state.events.map((event) => event.tool ?? "")).toEqual(SAMPLE_SCRIPT.turns.map((turn) => turn.tool ?? ""))
    expect(out.state.events.map((event) => event.text ?? "")).toEqual(SAMPLE_SCRIPT.turns.map((turn) => turn.text ?? ""))
    expect(SAMPLE_SCRIPT.turns.some((turn) => turn.role === "user" && turn.text?.includes("第 3 镜重拍"))).toBe(true)
  }, 20000)

  test("短于 5 轮拒绝，长于 40 轮拒绝，5 和 40 放行", async () => {
    await expect(replay({ id: "n4", turns: turns(4) }, [])).rejects.toThrow(/5 到 40/)
    await expect(replay({ id: "n41", turns: turns(41) }, [])).rejects.toThrow(/5 到 40/)
    const five = await replay({ id: "n5", turns: turns(5) }, [])
    const forty = await replay({ id: "n40", turns: turns(40) }, [])
    expect(five.state.events).toHaveLength(5)
    expect(forty.state.events).toHaveLength(40)
  })

  test("image 小样 PNG 头是 89 50 4E 47", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "arena-png-")), "one.png")
    const got = await makeSample("image", dest)
    const buf = readFileSync(dest)
    expect(got.bytes).toBe(buf.length)
    expect([buf[0], buf[1], buf[2], buf[3]]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  test("video 小样 ffprobe 退出码 0", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "arena-mp4-")), "red.mp4")
    await makeSample("video", dest)
    const probe = spawnSync("ffprobe", ["-v", "error", dest], { encoding: "utf8", timeout: 20000 })
    if (probe.status !== 0) {
      throw new Error(`ffprobe 退出 ${String(probe.status)}，stderr=${probe.stderr} err=${probe.error?.message ?? ""}。没有 ffmpeg/ffprobe 时这条必须失败，不能 skip`)
    }
  }, 20000)

  test("audio 小样 ffprobe 退出码 0", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "arena-wav-")), "sine.wav")
    await makeSample("audio", dest)
    const probe = spawnSync("ffprobe", ["-v", "error", dest], { encoding: "utf8", timeout: 20000 })
    if (probe.status !== 0) {
      throw new Error(`ffprobe 退出 ${String(probe.status)}，stderr=${probe.stderr} err=${probe.error?.message ?? ""}。没有 ffmpeg/ffprobe 时这条必须失败，不能 skip`)
    }
  }, 20000)

  test("timeout：工具无结果、记失败、不自动再扣一次", async () => {
    const script = faultScript("fault-timeout")
    const posts = platform.posts.length
    const out = await replay(script, [{ name: "timeout", at: 1 }])
    const event = out.state.events[1]
    expect(event.result).toBeNull()
    expect(event.status).toBe("failed")
    expect(event.retries).toBe(0)
    expect(out.state.events.filter((item) => item.index === 1 && item.tool === "image.generate")).toHaveLength(1)
    expect(out.state.charges.filter((item) => item.turn === 1)).toHaveLength(1)
    expect(platform.posts.length).toBe(posts)
  })

  test("bad_file：小样头被换成非法字节，解码检查失败", async () => {
    const out = await replay(faultScript("fault-bad-file"), [{ name: "bad_file", at: 1 }])
    const event = out.state.events[1]
    expect(event.status).toBe("failed")
    expect(event.decodeOk).toBe(false)
    const head = readFileSync(event.result!.path).subarray(0, 4)
    expect([head[0], head[1], head[2], head[3]]).not.toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  test("gateway_restart：游标保留，重启后从同一 turn 继续，已完成的不丢", async () => {
    const script = faultScript("fault-restart")
    const first = await replay(script, [{ name: "gateway_restart", at: 3 }])
    expect(first.halted).toBe("gateway_restart")
    expect(first.state.cursor).toBe(3)
    expect(first.state.events).toHaveLength(3)
    const kept = first.state.events.map((event) => event.text)
    const second = await replay(script, [], { scriptId: script.id, cursor: first.state.cursor })
    expect(second.state.scriptId).toBe(script.id)
    expect(second.state.events.slice(0, 3).map((event) => event.text)).toEqual(kept)
    expect(second.state.events[3].text).toBe(script.turns[3].text)
    expect(second.state.events[3].tool).toBe(script.turns[3].tool)
    expect(second.state.events).toHaveLength(script.turns.length)
    expect(first.state.events.map((event) => event.text)).toEqual(kept)
  })

  test("user_changes_mind：之后的 agent 回合读到纠正原文", async () => {
    const line = "第 3 镜不要玻璃杯，改成陶杯，这句话原文保留"
    const out = await replay(faultScript("fault-mind"), [{ name: "user_changes_mind", at: 3, text: line }])
    const later = out.state.events.filter((event) => event.role === "agent" && event.index >= 3)
    const earlier = out.state.events.filter((event) => event.role === "agent" && event.index < 3)
    expect(later.length).toBeGreaterThan(0)
    for (const event of later) expect(event.readable).toContain(line)
    for (const event of earlier) expect(event.readable).not.toContain(line)
  })

  test("leave_and_return：同一 script id + cursor 恢复，cursor 前的结果还在", async () => {
    const script = faultScript("fault-leave")
    const first = await replay(script, [{ name: "leave_and_return", at: 2 }])
    expect(first.halted).toBe("leave_and_return")
    expect(first.state.cursor).toBe(2)
    await expect(replay(script, [], { scriptId: script.id, cursor: first.state.cursor + 1 })).rejects.toThrow(/cursor 不一致/)
    const back = await replay(script, [], { scriptId: script.id, cursor: first.state.cursor })
    expect(back.state.scriptId).toBe(script.id)
    expect(back.state.events.slice(0, first.state.cursor)).toEqual(first.state.events)
    expect(back.state.events[2].text).toBe(script.turns[2].text)
    expect(back.state.cursor).toBe(script.turns.length)
  })
})
