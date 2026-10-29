import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { ExecContext, Output, SubmitGenerationReq, SubmitGenerationRes } from "../types"
import { clipExecutor, setClipSubjectCheckForTest } from "./clip"

const samples = JSON.parse(readFileSync(new URL("./external-samples.json", import.meta.url), "utf8")) as Record<string, string>
const samplePath = new URL("./external-samples.json", import.meta.url).pathname

afterEach(() => {
  setClipSubjectCheckForTest(null)
})

function fake(opts: {
  prompt: string
  entry?: { via: "session_api"; messageId: string }
  brief?: string
  params?: Record<string, unknown>
  submit?: (req: SubmitGenerationReq) => Promise<SubmitGenerationRes>
  ingest?: () => Promise<Output>
}) {
  const submitted: SubmitGenerationReq[] = []
  const ctx = {
    project: {
      id: "p",
      entry: opts.entry,
      brief: opts.brief ? [{ text: opts.brief }] : [],
      defaults: {},
      nodes: {},
    },
    node: {
      id: "clip1",
      type: "clip",
      params: { prompt: opts.prompt, model: "minimax-h3", seconds: 5 },
    },
    params: opts.params ?? {},
    session: {},
    sessionId: "s",
    signature: "sig",
    runId: "run",
    attempt: 1,
    take: 1,
    inputs: {},
    refs: [],
    signal: new AbortController().signal,
    submitGeneration: async (req: SubmitGenerationReq) => {
      submitted.push(req)
      if (opts.submit) return opts.submit(req)
      throw new Error("不该提交")
    },
    ingest: async () => {
      if (opts.ingest) return opts.ingest()
      throw new Error("不该入库")
    },
  } as unknown as ExecContext
  return { ctx, submitted }
}

const stopped: SubmitGenerationRes = { ok: false, code: "bad_input", message: "stop", retryable: false }

describe("clip 准入与主体", () => {
  test("自己出的句子不能提交", async () => {
    const { ctx, submitted } = fake({ prompt: "一只手把杯子放下", params: { sentence: "一只手把杯子放下" } })
    const res = await clipExecutor.run(ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain("付费授权")
    expect(submitted).toHaveLength(0)
  })

  test("外部样本在授权内才提交，并压过青橙、不让模型画字", async () => {
    const { ctx, submitted } = fake({
      prompt: samples.s_chair,
      params: {
        informationGoal: "看静音有没有被剥掉",
        maxRuns: 1,
        sampleId: "s_chair",
        sentence: samples.s_chair,
        priorSameMorphology: 0,
      },
      submit: async () => stopped,
    })
    const res = await clipExecutor.run(ctx)
    expect(res.ok).toBe(false)
    expect(submitted).toHaveLength(1)
    expect(submitted[0].prompt).toContain("不要出现任何文字")
    expect(submitted[0].prompt).toContain("青橙")
    expect(submitted[0].prompt).not.toContain("画面上写着")
  })

  test("真实会话不要求样本，画字剥掉，晨光写明不是黄昏", async () => {
    const prompt = "晨光里一只手把木椅放下。画面上写着「木椅」"
    const { ctx, submitted } = fake({
      prompt,
      entry: { via: "session_api", messageId: "m" },
      brief: prompt,
      submit: async () => stopped,
    })
    await clipExecutor.run(ctx)
    expect(submitted).toHaveLength(1)
    expect(submitted[0].prompt).not.toContain("画面上写着")
    expect(submitted[0].prompt).toContain("伪汉字")
    expect(submitted[0].prompt).toContain("晨光是清晨高调暖色")
    expect(submitted[0].prompt).toContain("把木椅放下")
  })

  test("没有可看的画面就不算主体在", async () => {
    const { ctx } = fake({
      prompt: samples.s_chair,
      entry: { via: "session_api", messageId: "m" },
      brief: samples.s_chair,
      submit: async () => ({ ok: true, taskId: "", urls: ["https://example.invalid/a.mp4"], costCoins: 25, requestId: "r", executedModel: "minimax-h3" }),
      ingest: async () => ({ port: "out", artifactId: "a", sha256: "b", path: "/tmp/does-not-matter", mime: "video/mp4", bytes: 10, origin: "generated" }),
    })
    const res = await clipExecutor.run(ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain("主体")
  })

  test("注入的检查说主体不在，就失败", async () => {
    setClipSubjectCheckForTest(() => ({ present: false }))
    const { ctx } = fake({
      prompt: samples.s_chair,
      entry: { via: "session_api", messageId: "m" },
      brief: samples.s_chair,
      submit: async () => ({ ok: true, taskId: "", urls: ["https://example.invalid/a.mp4"], costCoins: 25, requestId: "r", executedModel: "minimax-h3" }),
      ingest: async () => ({ port: "out", artifactId: "a", sha256: "b", path: samplePath, mime: "video/mp4", bytes: 1000, origin: "generated" }),
    })
    const res = await clipExecutor.run(ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain("主体")
  })

  test("晨光被判成青橙就失败", async () => {
    setClipSubjectCheckForTest(() => ({ present: true, tealOrange: true }))
    const { ctx } = fake({
      prompt: "晨光里一只手把木椅放下",
      entry: { via: "session_api", messageId: "m" },
      brief: "晨光里一只手把木椅放下",
      submit: async () => ({ ok: true, taskId: "", urls: ["https://example.invalid/a.mp4"], costCoins: 25, requestId: "r", executedModel: "minimax-h3" }),
      ingest: async () => ({ port: "out", artifactId: "a", sha256: "b", path: samplePath, mime: "video/mp4", bytes: 1000, origin: "generated" }),
    })
    const res = await clipExecutor.run(ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain("青橙")
  })

  test("主体在，剥出来的字留到后期", async () => {
    setClipSubjectCheckForTest(() => ({ present: true }))
    const prompt = "晨光里一只手把木椅放下。画面上写着「木椅」"
    const { ctx } = fake({
      prompt,
      entry: { via: "session_api", messageId: "m" },
      brief: prompt,
      submit: async () => ({ ok: true, taskId: "", urls: ["https://example.invalid/a.mp4"], costCoins: 25, requestId: "r", executedModel: "minimax-h3" }),
      ingest: async () => ({ port: "out", artifactId: "a", sha256: "b", path: samplePath, mime: "video/mp4", bytes: 1000, origin: "generated" }),
    })
    const res = await clipExecutor.run(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.outputs[0].meta?.tasteAnchor).toBe(true)
      expect(String(res.outputs[0].meta?.postText)).toContain("木椅")
    }
  })
})
