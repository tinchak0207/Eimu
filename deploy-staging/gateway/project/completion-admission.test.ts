import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  admitPipelineSmoke,
  admitSmoke,
  countsTowardCompletion,
  morphologyOf,
  parsePaidAuth,
} from "./completion-admission"

const registry = JSON.parse(readFileSync(new URL("./executors/external-samples.json", import.meta.url), "utf8")) as Record<string, string>

describe("成片率入口", () => {
  test("只有会话首句进成片率", () => {
    expect(countsTowardCompletion({ entry: { via: "session_api" }, brief: [{ text: "一只手把木椅放下" }] })).toBe(true)
    expect(countsTowardCompletion({ brief: [{ text: "一只手把木椅放下" }] })).toBe(false)
    expect(countsTowardCompletion({ entry: { via: "script" }, brief: [{ text: "一只手把木椅放下" }] })).toBe(false)
    expect(countsTowardCompletion({ entry: { via: "session_api" }, brief: [{ text: "   " }] })).toBe(false)
  })

  test("形态只看节点类型和参数键", () => {
    expect(morphologyOf({
      b: { type: "export", params: { preset: "landscape", burn: true } },
      a: { type: "clip", params: { seconds: 5, prompt: "x" } },
    })).toBe("clip|prompt,seconds;export|burn,preset")
  })

  test("同一形态第三次没有新失败就停", () => {
    expect(admitSmoke(3, "").allow).toBe(false)
    expect(admitSmoke(3, "").reason).toContain("3")
    expect(admitSmoke(3, "qc_failed").allow).toBe(true)
    expect(admitSmoke(2, "").allow).toBe(true)
  })

  test("付费授权要写信息，计数器不算目标", () => {
    expect(parsePaidAuth({ informationGoal: "  ", maxRuns: 1 }).ok).toBe(false)
    for (const goal of ["导出 99 条", "export 10", "线上首句导出 20"]) {
      const parsed = parsePaidAuth({ informationGoal: goal, maxRuns: 1 })
      expect(parsed.ok, goal).toBe(false)
      if (!parsed.ok) expect(parsed.reason).toContain("计数器")
    }
    expect(parsePaidAuth({ informationGoal: "看静音有没有被剥掉", maxRuns: 0 }).ok).toBe(false)
    expect(parsePaidAuth({ informationGoal: "看静音有没有被剥掉", maxRuns: 4 }).ok).toBe(false)
    expect(parsePaidAuth({ informationGoal: "看静音有没有被剥掉", maxRuns: 1.5 }).ok).toBe(false)
    expect(parsePaidAuth({ informationGoal: "看静音有没有被剥掉", maxRuns: 1 }).ok).toBe(true)
  })

  test("脚本冒烟必须用外部样本，真实会话不要求样本", () => {
    expect(admitPipelineSmoke({ sessionEntry: true, sentence: "随便", registry }).allow).toBe(true)
    const base = {
      sessionEntry: false,
      informationGoal: "看静音有没有被剥掉",
      maxRuns: 1,
      sampleId: "s_chair",
      sentence: registry.s_chair,
      registry,
      priorSameMorphology: 0,
    }
    expect(admitPipelineSmoke({ ...base, sampleId: "s_missing" }).allow).toBe(false)
    expect(admitPipelineSmoke({ ...base, sentence: `${registry.s_chair}。` }).allow).toBe(false)
    expect(admitPipelineSmoke(base).allow).toBe(true)
    expect(admitPipelineSmoke({ ...base, priorSameMorphology: 1 }).allow).toBe(false)
  })
})
