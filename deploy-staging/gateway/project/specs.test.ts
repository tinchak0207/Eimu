// S3 specs.ts 行为测试。期望值全部来自独立来源：设计文档 §3.5 表（手抄）、image_generate.ts 源码的 args 键、
// FNV-1a 公开测试向量、editor/aspect.ts 与 master.ts 的源码文本、handleTts 的 2000 字上限、OpenAI speech speed 0.25..4。
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { NodeType, ProjectNode } from "./types"
import {
  NODE_SPECS, NODE_SPECS_LITE, NODE_TYPES, PIN_RULES, UNPINNABLE_TYPES, checkMusicRights, checkParam, checkParams, checkPinnable,
  defaultSeed, materializeDefaults, missingRequired, pinInvariantViolations, portKindCompatible, portKindOf, resolvePort,
} from "./specs"

const here = import.meta.dir
const read = (rel: string) => readFileSync(join(here, rel), "utf8")

// §3.5 表手抄：signedParams 与 可 pin
const TABLE: Record<NodeType, { signed: string[]; pinnable: boolean }> = {
  reference: { signed: ["source", "artifactId"], pinnable: true },
  script: { signed: ["text"], pinnable: true },
  shotlist: { signed: ["kind", "rows"], pinnable: true },
  keyframe: { signed: ["prompt", "model", "size", "seed", "role", "n", "styleLock"], pinnable: true },
  clip: { signed: ["prompt", "model", "seconds", "resolution", "seed", "generateAudio"], pinnable: true },
  voice: { signed: ["text", "voice", "speed"], pinnable: true },
  music: { signed: ["prompt", "lyrics", "sourceAudioSha"], pinnable: true },
  timeline: { signed: ["order", "transitions", "aspect", "fps", "styleId"], pinnable: true },
  subtitle: { signed: ["style", "burnIn", "lang"], pinnable: true },
  mix: { signed: ["levels", "ducking", "targetLufs"], pinnable: true },
  export: { signed: ["preset"], pinnable: false },
  qc: { signed: ["mode", "rubric", "thresholds"], pinnable: false },
  render3d: { signed: ["script", "engine", "params"], pinnable: true },
}
// 表之外、为“不比 image_generate 少”而追加的签名参数（偏离已在回报中声明）：
const ADDED: Partial<Record<NodeType, string[]>> = {
  keyframe: ["quality", "toolSubmission"], // 原工具完整载荷与操作身份参与签名
  clip: ["size", "styleLock", "n", "toolSubmission"], // 视频batch及原工具完整载荷
  music: ["durationHint"],             // music_gen 实际接受的是 duration_hint=full|clip30
  export: ["stage", "goalRevision"], // 合成候选与发布不同职责；生效制作要求变化使候选失效。
  qc: ["briefLedgerRevision"],       // 新原话只触发评审核对，不能使未变媒体重渲。
}

describe("NODE_SPECS 与 §3.5 表", () => {
  test("13 个 NodeType 全有 spec，且 type 字段自洽", () => {
    expect(NODE_TYPES.slice().sort()).toEqual(Object.keys(TABLE).sort())
    for (const t of NODE_TYPES) expect(NODE_SPECS[t].type).toBe(t)
  })
  test("signedParams = 表 ∪ 声明的追加项（精确相等，防静默漂移）", () => {
    for (const t of NODE_TYPES) {
      const want = [...TABLE[t].signed, ...(ADDED[t] ?? [])].sort()
      expect([...NODE_SPECS[t].signedParams].sort()).toEqual(want)
    }
  })
  test("pinnable 与表一致；不可 pin 的恰是 export 和 qc", () => {
    for (const t of NODE_TYPES) expect(NODE_SPECS[t].pinnable).toBe(TABLE[t].pinnable)
    expect([...UNPINNABLE_TYPES].sort()).toEqual(["export", "qc"])
    expect(NODE_SPECS_LITE.export.pinnable).toBe(false)
    expect(NODE_SPECS_LITE.keyframe.signedParams).toContain("seed")
  })
  test("每个 signedParam 都有类型规则；title 不进签名", () => {
    for (const t of NODE_TYPES) {
      for (const k of NODE_SPECS[t].signedParams) expect(NODE_SPECS[t].params[k]?.kind).toBeDefined()
      expect(NODE_SPECS[t].signedParams).not.toContain("title")
    }
  })
  test("主输出口与表一致：subtitle 是 srt/ass，其余 out；export 主口随 preset", () => {
    for (const t of NODE_TYPES) if (t !== "subtitle") expect(NODE_SPECS[t].primaryPort).toBe("out")
    expect(NODE_SPECS.subtitle.outputs.map((o) => o.name)).toEqual(["srt", "ass"])
    expect(resolvePort(NODE_SPECS.subtitle, undefined)).toBe("srt")
    expect(resolvePort(NODE_SPECS.subtitle, "out")).toBe("srt")
    expect(resolvePort(NODE_SPECS.subtitle, "mp3")).toBeNull()
    expect(portKindOf({ type: "export", params: { preset: "image_pack" } })).toBe("package")
    expect(portKindOf({ type: "export", params: { preset: "landscape_169" } })).toBe("video")
  })
  test("枚举与上游源码对表：EDITOR_ASPECTS、MASTER_PRESETS", () => {
    const aspects = [...read("../editor/aspect.ts").match(/EDITOR_ASPECTS = \[([^\]]+)\]/)![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect((NODE_SPECS.timeline.params.aspect as { values: string[] }).values).toEqual(aspects)
    const presetsSrc = read("../master.ts").match(/MASTER_PRESETS = \{([\s\S]*?)\n\} as const/)![1]
    const presets = [...presetsSrc.matchAll(/^\s{2}(\w+): \{/gm)].map((m) => m[1])
    expect((NODE_SPECS.export.params.preset as { values: string[] }).values).toEqual([...presets, "image_pack"])
  })
})

describe("keyframe/clip 不比 image_generate 少", () => {
  // 把 image_generate.ts 的 args 键逐个映射：要么是执行管线字段（图节点之外由引擎/账本提供），要么落到某个节点参数/refs。
  const src = read("../../opencode-runtime/tools/image_generate.ts")
  const argsBlock = src.slice(src.indexOf("  args: {"), src.indexOf("async execute(args, context)"))
  const argKeys = [...argsBlock.matchAll(/^ {4}(\w+): tool\.schema/gm)].map((m) => m[1])
  const PLUMBING = new Set(["node_id", "project", "frame", "request_id", "retry_task_id", "cap_coins", "project_budget_coins", "reference_version", "style_version", "kind"])
  const MAP: Record<string, { type: NodeType; param?: string; refs?: true }[]> = {
    prompt: [{ type: "keyframe", param: "prompt" }, { type: "clip", param: "prompt" }],
    style_lock: [{ type: "keyframe", param: "styleLock" }, { type: "clip", param: "styleLock" }],
    model: [{ type: "keyframe", param: "model" }, { type: "clip", param: "model" }],
    size: [{ type: "keyframe", param: "size" }, { type: "clip", param: "size" }],
    n: [{ type: "keyframe", param: "n" }, { type: "clip", param: "n" }],
    quality: [{ type: "keyframe", param: "quality" }],
    duration_seconds: [{ type: "clip", param: "seconds" }],
    resolution: [{ type: "clip", param: "resolution" }],
    generate_audio: [{ type: "clip", param: "generateAudio" }],
    reference_images: [{ type: "keyframe", refs: true }, { type: "clip", refs: true }],
  }
  test("源码里解析出的参数键非空（解析本身没坏）", () => {
    expect(argKeys.length).toBeGreaterThanOrEqual(15)
    expect(argKeys).toContain("reference_images")
  })
  test("image_generate 的每个参数都有去处；新增参数会让本测试失败从而逼人表态", () => {
    for (const k of argKeys) {
      if (PLUMBING.has(k)) continue
      const to = MAP[k]
      expect(to, `image_generate 参数 ${k} 没有映射`).toBeDefined()
      for (const m of to) {
        if (m.param) {
          expect(NODE_SPECS[m.type].signedParams, `${m.type}.${m.param} 应进签名`).toContain(m.param)
        } else {
          expect(typeof NODE_SPECS[m.type].maxReferences).toBe("function")
        }
      }
    }
  })
  test("参考图上限对齐 image_generate：图 5；视频 5，minimax-h3 为 9", () => {
    expect(src).toMatch(/const MAX_REFERENCE_IMAGES = 5/)
    expect(src).toMatch(/model === "minimax-h3" \? 9/)
    expect(NODE_SPECS.keyframe.maxReferences!({ params: {} })).toBe(5)
    expect(NODE_SPECS.clip.maxReferences!({ params: {} })).toBe(5)
    expect(NODE_SPECS.clip.maxReferences!({ params: { model: "minimax-h3" } })).toBe(9)
  })
  test("分辨率档位、quality、n 范围与 image_generate 的 zod 一致", () => {
    expect((NODE_SPECS.clip.params.resolution as { values: string[] }).values).toEqual(["480p", "540p", "720p", "1080p", "2k", "4k"])
    expect((NODE_SPECS.keyframe.params.quality as { values: string[] }).values).toEqual(["standard", "hd"])
    expect(checkParam("keyframe", "n", 4)).toBeNull()
    expect(checkParam("keyframe", "n", 5)).not.toBeNull()
    expect(checkParam("keyframe", "n", 0)).not.toBeNull()
    expect(checkParam("clip", "seconds", 4)).not.toBeNull()   // image_generate: duration_seconds min 5
    expect(checkParam("clip", "seconds", 5)).toBeNull()
  })
})

describe("参数校验与教学式错误", () => {
  test("keyframe.size 要像素，16:9 被拒并给出可抄的修正；clip.size 比例/像素都行", () => {
    const i = checkParam("keyframe", "size", "16:9", "kf1")!
    expect(i.message).toContain("像素")
    const fix = JSON.parse(i.fix)
    expect(fix).toMatchObject({ op: "set", node: "kf1", path: "params.size" })
    expect(checkParam("keyframe", "size", fix.value)).toBeNull()
    expect(checkParam("keyframe", "size", "1536x1024")).toBeNull()
    expect(checkParam("clip", "size", "16:9")).toBeNull()
    expect(checkParam("clip", "size", "1920x1080")).toBeNull()
    expect(checkParam("clip", "size", "wide")).not.toBeNull()
  })
  test("类型错误：数字给字符串、枚举外取值、布尔给数字", () => {
    expect(checkParam("clip", "seconds", "10")).not.toBeNull()
    expect(checkParam("clip", "resolution", "8k")!.message).toContain("480p")
    expect(checkParam("clip", "generateAudio", 1 as never)).not.toBeNull()
    expect(checkParam("keyframe", "seed", 1.5)).not.toBeNull()
    expect(checkParam("keyframe", "seed", -1)).not.toBeNull()
  })
  test("整串 ${...} 引用放行 number/enum/boolean（扇出模板），夹在句子里的 number 不放行", () => {
    expect(checkParam("clip", "seconds", "${row.seconds}")).toBeNull()
    expect(checkParam("clip", "resolution", "${row.res}")).toBeNull()
    expect(checkParam("clip", "seconds", "about ${row.seconds}")).not.toBeNull()
    expect(checkParam("keyframe", "prompt", "镜头：${row.action}")).toBeNull()
  })
  test("未知参数被拒（防止改了不进签名）并列出可用参数", () => {
    const i = checkParam("keyframe", "seconds", 5)!
    expect(i.message).toContain("prompt")
    expect(checkParams("export", { preset: "landscape_169", bogus: 1 }).length).toBe(1)
  })
  test("字数上限：配音 2000 字（handleTts）、intent 以外的字符串按字符不按字节", () => {
    expect(checkParam("voice", "text", "字".repeat(2000))).toBeNull()
    expect(checkParam("voice", "text", "字".repeat(2001))).not.toBeNull()
    expect(checkParam("voice", "speed", 0.25)).toBeNull()
    expect(checkParam("voice", "speed", 4.5)).not.toBeNull()
    expect(checkParam("keyframe", "prompt", "")).not.toBeNull()
  })
  test("shotlist.rows：行 id 必须合法且唯一（实例 id 由它生成）", () => {
    expect(checkParam("shotlist", "rows", [{ id: "s1" }, { id: "s2" }])).toBeNull()
    expect(checkParam("shotlist", "rows", [{ id: "s1" }, { id: "s1" }])!.message).toContain("重复")
    expect(checkParam("shotlist", "rows", [{ id: "Shot 1" }])).not.toBeNull()
    expect(checkParam("shotlist", "rows", [{ action: "x" }])).not.toBeNull()
    expect(checkParam("shotlist", "rows", ["s1"] as never)).not.toBeNull()
  })
  test("reference.artifactId 必须是 art_+16hex；model 不含空白", () => {
    expect(checkParam("reference", "artifactId", "art_0123456789abcdef")).toBeNull()
    expect(checkParam("reference", "artifactId", "art_XYZ")).not.toBeNull()
    expect(checkParam("clip", "model", "seedance-2.0-900-特惠")).toBeNull()
    expect(checkParam("clip", "model", "my model")).not.toBeNull()
  })
})

describe("J5 music 参数闸", () => {
  test("带参考音频必须声明 rights；声明后放行", () => {
    const sha = "a".repeat(64)
    expect(checkMusicRights({ prompt: "ambient", sourceAudioSha: sha })!.key).toBe("rights")
    expect(checkMusicRights({ prompt: "ambient", sourceAudioSha: sha, rights: "licensed" })).toBeNull()
    expect(checkParam("music", "rights", "stolen")).not.toBeNull()
  })
  test("复刻/翻唱既有歌曲旋律的措辞被拒；正常风格描述放行", () => {
    expect(checkMusicRights({ prompt: "翻唱周杰伦的晴天" })).not.toBeNull()
    expect(checkMusicRights({ prompt: "a cover of Yesterday by The Beatles" })).not.toBeNull()
    expect(checkMusicRights({ prompt: "cinematic orchestral, 90 BPM, key of D minor, heroic" })).toBeNull()
    expect(checkParams("music", { prompt: "same melody as the original", rights: "own" }).length).toBe(1)
  })
})

describe("默认值与 seed", () => {
  test("defaultSeed = FNV-1a32 & 0x7fffffff（公开测试向量）", () => {
    expect(defaultSeed("")).toBe(0x811c9dc5 & 0x7fffffff)
    expect(defaultSeed("a")).toBe(0xe40c292c & 0x7fffffff)
    expect(defaultSeed("foobar")).toBe(0xbf9cf968 & 0x7fffffff)
  })
  test("确定性且按 nodeId 区分；在 seed 范围内", () => {
    expect(defaultSeed("shot_1")).toBe(defaultSeed("shot_1"))
    expect(defaultSeed("shot_1")).not.toBe(defaultSeed("shot_2"))
    expect(defaultSeed("kf#s1")).not.toBe(defaultSeed("kf#s2"))
    expect(checkParam("keyframe", "seed", defaultSeed("x"))).toBeNull()
  })
  test("materializeDefaults：显式 > 工程 defaults > 硬默认；seeded 类型补 seed，非 seeded 不补", () => {
    const p = materializeDefaults("keyframe", "kf1", { prompt: "p", size: "512x512" }, { imageModel: "m-img", imageSize: "2048x2048", style: "S" })
    expect(p).toMatchObject({ prompt: "p", size: "512x512", model: "m-img", n: 1, quality: "standard", styleLock: "S", seed: defaultSeed("kf1") })
    const q = materializeDefaults("keyframe", "kf1", { prompt: "p", seed: 7 })
    expect(q).toMatchObject({ seed: 7, model: "gpt-image-2.5-flare", size: "1024x1024" })
    const c = materializeDefaults("clip", "c1", { prompt: "p" }, { videoModel: "minimax-h3" })
    expect(c).toMatchObject({ model: "minimax-h3", size: "16:9", seconds: 15, seed: defaultSeed("c1") })
    expect(c.generateAudio).toBeUndefined()
    expect(materializeDefaults("voice", "v1", { text: "t" }, { voice: "vv" })).toEqual({ text: "t", voice: "vv", speed: 1 })
    expect(materializeDefaults("export", "e1", { preset: "landscape_169" })).toEqual({ preset: "landscape_169" })
    const orig = { prompt: "p" }
    materializeDefaults("keyframe", "kf1", orig)
    expect(orig).toEqual({ prompt: "p" })   // 不改入参
  })
  test("missingRequired：clip 没有 videoModel 就缺 model；有 defaults 则不缺", () => {
    expect(missingRequired({ id: "c", type: "clip", params: { prompt: "p" } }, {})).toEqual(["model"])
    expect(missingRequired({ id: "c", type: "clip", params: { prompt: "p" } }, { videoModel: "m" })).toEqual([])
    expect(missingRequired({ id: "k", type: "keyframe", params: {} }, {})).toEqual(["prompt"])
    expect(missingRequired({ id: "e", type: "export", params: {} }, {})).toEqual(["preset"])
  })
})

describe("端口类型兼容", () => {
  test("file 是未定媒体类型的二进制：进图/视频/音频口都行；文本口不收；接受 file 的口不等于接受一切二进制", () => {
    expect(portKindCompatible("file", ["image", "text"])).toBe(true)
    expect(portKindCompatible("file", ["text", "json"])).toBe(false)
    expect(portKindCompatible("image", ["file"])).toBe(false)   // 接受 file 的口只收 file，不是任意二进制
    expect(portKindCompatible("audio", ["image", "file", "text", "json"])).toBe(false)
    expect(portKindCompatible("text", ["file"])).toBe(false)
    expect(portKindCompatible("audio", ["image", "video"])).toBe(false)
    expect(portKindCompatible("image", [])).toBe(false)
  })
})

describe("pin 边界（schema 显式规则）", () => {
  const base = (o: Partial<ProjectNode> = {}) => ({
    id: "kf1", type: "keyframe" as NodeType, status: "done" as const, forEach: undefined, takes: undefined, scratch: undefined,
    outputs: [{ port: "out", artifactId: "art_0123456789abcdef", sha256: "a".repeat(64), path: "/x", mime: "image/png", bytes: 1, origin: "generated" as const }],
    ...o,
  })
  test("规则清单恰为 7 条，id 唯一", () => {
    expect(PIN_RULES.length).toBe(7)
    expect(new Set(PIN_RULES.map((r) => r.id)).size).toBe(7)
  })
  test("正常节点可 pin，返回全部输出口指纹", () => {
    const r = checkPinnable(base())
    expect(r).toEqual({ ok: true, outputsSha: ["a".repeat(64)] })
  })
  test("type_not_pinnable：export/qc", () => {
    for (const t of ["export", "qc"] as NodeType[]) {
      const r = checkPinnable(base({ type: t }))
      expect(r).toMatchObject({ ok: false, code: "NOT_PINNABLE", rule: "type_not_pinnable" })
    }
  })
  test("template_node / scratch / bad_status / no_outputs", () => {
    expect(checkPinnable(base({ forEach: { over: "shots", as: "shot" } }))).toMatchObject({ ok: false, rule: "template_node" })
    expect(checkPinnable(base({ scratch: { expiresAt: "2026-01-01T00:00:00Z" } }))).toMatchObject({ ok: false, rule: "scratch" })
    expect(checkPinnable(base({ status: "failed" }))).toMatchObject({ ok: false, rule: "bad_status" })
    expect(checkPinnable(base({ status: "blocked" }))).toMatchObject({ ok: false, rule: "bad_status" })
    expect(checkPinnable(base({ status: "stale" }))).toMatchObject({ ok: true })
    expect(checkPinnable(base({ outputs: [] }))).toMatchObject({ ok: false, rule: "no_outputs" })
  })
  test("takes_needs_take：takes 节点必须指定且是被选中的；非 takes 节点不接受 take", () => {
    const o = (take: number) => ({ ...base().outputs[0], take })
    const t = base({ takes: { n: 2, select: "user" }, outputs: [o(2)] })
    expect(checkPinnable(t)).toMatchObject({ ok: false, rule: "takes_needs_take" })
    expect(checkPinnable(t, { take: 1 })).toMatchObject({ ok: false, rule: "takes_needs_take" })
    expect(checkPinnable(t, { take: 2 })).toMatchObject({ ok: true, take: 2 })
    expect(checkPinnable(base(), { take: 1 })).toMatchObject({ ok: false, rule: "takes_needs_take" })
  })
  test("freeze_all_ports：多输出口全部冻结；缺 sha 拒绝；已 pin 节点的指纹必须恰好覆盖全部口", () => {
    const o2 = { ...base().outputs[0], port: "ass", sha256: "b".repeat(64) }
    const sub = base({ type: "subtitle", outputs: [{ ...base().outputs[0], port: "srt" }, o2] })
    expect(checkPinnable(sub)).toEqual({ ok: true, outputsSha: ["a".repeat(64), "b".repeat(64)] })
    expect(checkPinnable(base({ outputs: [{ ...base().outputs[0], sha256: "zz" }] }))).toMatchObject({ ok: false, rule: "freeze_all_ports" })
    const pinned = (shas: string[]) => ({ ...sub, pinned: { by: "user" as const, at: "t", outputsSha: shas, signatureAtPin: "s" } })
    expect(pinInvariantViolations(pinned(["a".repeat(64), "b".repeat(64)]))).toEqual([])
    expect(pinInvariantViolations(pinned(["a".repeat(64)])).map((v) => v.rule)).toEqual(["freeze_all_ports"])
  })
  test("教学式错误带可抄示例", () => {
    const r = checkPinnable(base({ takes: { n: 2, select: "user" } })) as { message: string }
    expect(r.message).toContain('"op":"pin"')
  })
})
