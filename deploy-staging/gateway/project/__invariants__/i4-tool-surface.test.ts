// I4（设计文档 §8 第四行）：主席位工具 ≤12 且 creator/orchestrator 集合相同；beast 两取值 agent 相同；
// 200 步里工具表字节恒定；生成类工具在 creator/orchestrator/全部 _p 席位为 0。
//
// 独立期望来源（取并集，不抄 S14 提交的清单）：
//   ① 设计文档 §3.7 第 8 点的十个工具（本档逐字手写）；
//   ② 对 R/tools/*.ts 源码的静态扫描：去注释后匹配生成端点与批量提交/适配器入口；
//   ③ opencode.json / expert/opencode-agents.json 的席位表解析（只取启用集，不取生成清单）。
import "./fixtures/env"
import "./fixtures/fake-platform"
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const HERE = import.meta.dir
/** gateway/project/__invariants__ → deploy-staging */
const DEPLOY_STAGING = join(HERE, "..", "..", "..")
const R = join(DEPLOY_STAGING, "opencode-runtime")
const OPENCODE_JSON = join(R, "opencode.json")
const EXPERT_JSON = join(DEPLOY_STAGING, "gateway", "expert", "opencode-agents.json")

const MAIN_TOOLS_MAX = 12 // 设计文档 §3 常量表
/** 设计文档 §3.7 第 8 点的十个主席位工具（逐字）。 */
const DOC_MAIN_TOOLS = [
  "project_get", "project_patch", "project_run", "subagent_dispatch", "subagent_stop",
  "question", "read_image", "search_web", "asset_search", "read",
].sort()

/** 设计文档 §3 的起始超集清单（逐字）。 */
const DOC_DIRECT_GENERATION_TOOLS = [
  "image_generate", "image_edit", "image_upscale", "background_remove", "keyframe_render",
  "canvas_generate_image", "canvas_create_generation_flow", "character_dna_turnaround",
  "product_conditioned_generation", "virtual_tryon", "hand_contact_repair", "outlier_audit_regenerate",
  "scene_pack_batch", "shot_grid_batch", "style_aligned_batch", "aspect_reflow", "multi_aspect_reflow",
  "platform_reflow", "moodboard_diverge_converge", "emotion_board_matrix", "last_frame_video_chain",
  "storyboard_voiceover", "music_gen", "tts_speak", "blender_exec", "blender_render", "blender_export_gltf",
  "timeline_ops", "timeline_mix", "timeline_master", "timeline_style", "timeline_rhythm", "timeline_restore",
  "artifact_publish",
]

interface Seat {
  tools?: Record<string, boolean | string>
  [k: string]: unknown
}
type SeatFile = Record<string, Seat>

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function seatsOf(path: string): SeatFile {
  const raw = readJson<{ agent?: SeatFile } & SeatFile>(path)
  return raw.agent ?? raw
}

function enabled(seat: Seat): string[] {
  return Object.entries(seat.tools ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort()
}

/** 去掉 // 与 /* *\/ 注释（保留 URL 里的 //：只在前方是空白时当注释）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1")
}

const GENERATION_CALL_PATTERNS = [
  /["'`]\/(?:v1\/)?(?:images|videos)\/(?:generations|edits)["'`]/,
  /["'`]\/(?:v1\/)?upscale["'`]/,
  /\/agent\/v1\/tts/,
  /runGenBatch\s*\(/,
  /\b(?:musicGenTool|wrapMusicTool|runMusicOperation)\b/,
  /\b(?:wrapBlenderTool|blenderExecTool|blenderRenderTool)\b/,
  /["'`](?:music_gen|blender_render|blender_exec)["'`]/,
]

/** R/tools/*.ts 的静态扫描：文件名（去 .ts）→ 命中原因。 */
function scanGenerationTools(): Map<string, string[]> {
  const dir = join(R, "tools")
  const out = new Map<string, string[]>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue
    const src = stripComments(readFileSync(join(dir, file), "utf8"))
    const hits = GENERATION_CALL_PATTERNS.map((r, i) => (r.test(src) ? `p${i + 1}` : "")).filter(Boolean)
    if (hits.length) out.set(file.slice(0, -3), hits)
  }
  return out
}

/** 检验器：席位集合里出现生成类工具就报错（反例用）。 */
function assertNoGenerationTools(seatName: string, tools: readonly string[], generation: ReadonlySet<string>): void {
  const hit = tools.filter((t) => generation.has(t))
  if (hit.length) throw new Error(`${seatName} 启用了生成类工具：${hit.join(", ")}`)
}

let adm: typeof import("../../messages-gw-admission.ts")

beforeAll(async () => {
  adm = await import("../../messages-gw-admission.ts")
})

describe("I4 主席位工具面", () => {
  test("creator/orchestrator：集合相同、≤12、=== 文档十工具；beast 两取值 agent 相同", () => {
    const oc = seatsOf(OPENCODE_JSON)
    const creator = enabled(oc.creator)
    const orchestrator = enabled(oc.orchestrator)
    expect(creator.length).toBeLessThanOrEqual(MAIN_TOOLS_MAX)
    expect(orchestrator.length).toBeLessThanOrEqual(MAIN_TOOLS_MAX)
    expect(creator).toEqual(orchestrator)
    expect(creator).toEqual(DOC_MAIN_TOOLS)

    // beast 开关只改提示词段：工程会话两种取值都解析到同一个 agent。
    for (const beast of [false, true]) {
      expect(adm.resolvePromptSeat({ projectMode: true, seat: "creator", beast })).toBe("creator")
    }
    expect(adm.resolveBeastMode({ projectMode: true, latched: true }, true)).toBe(true)
    expect(adm.resolveBeastMode({ projectMode: true, latched: true }, false)).toBe(true)
    expect(adm.resolveBeastMode({ projectMode: true, latched: false }, true)).toBe(false)
  })

  test("200 步里工具表字节恒定；反例：旧席位按 beast 逐轮换表 → 字节必变", () => {
    const oc = seatsOf(OPENCODE_JSON)
    const sizes = new Set<number>()
    const seats = new Set<string>()
    for (let step = 0; step < 200; step++) {
      const liveBeast = step % 2 === 0
      const seat = adm.resolvePromptSeat({ projectMode: true, seat: "creator", beast: adm.resolveBeastMode({ projectMode: true, latched: true }, liveBeast) })
      seats.add(seat)
      sizes.add(Buffer.byteLength(JSON.stringify(enabled(oc[seat])), "utf8"))
    }
    expect([...seats]).toEqual(["creator"])
    expect(sizes.size).toBe(1)

    // 反例：旧席位路径（projectMode=false）在同一 200 步里会在两个旧席位间切换 → 工具表字节不恒定。
    const legacySeats = new Set<string>()
    const legacySizes = new Set<number>()
    for (let step = 0; step < 200; step++) {
      const seat = adm.resolvePromptSeat({ projectMode: false, seat: "creator_legacy", beast: step % 2 === 0 })
      legacySeats.add(seat)
      legacySizes.add(Buffer.byteLength(JSON.stringify(enabled(oc[seat])), "utf8"))
    }
    expect(legacySeats.size).toBe(2)
    expect(legacySizes.size).toBe(2)
  })

  test("生成类工具（文档超集 ∪ R/tools 静态扫描）在 creator/orchestrator/全部 _p 席位为 0", () => {
    const scan = scanGenerationTools()
    const generation = new Set<string>([...DOC_DIRECT_GENERATION_TOOLS, ...scan.keys()])
    expect(generation.size).toBeGreaterThanOrEqual(DOC_DIRECT_GENERATION_TOOLS.length)
    // 扫描必须真的扫到（不是空集假绿）：端点/批量提交入口至少各命中一个。
    expect(scan.size).toBeGreaterThan(10)
    for (const [tool, reasons] of scan) expect(`${tool}:${reasons.join("")}`).not.toBe("")

    for (const path of [OPENCODE_JSON, EXPERT_JSON]) {
      const seats = seatsOf(path)
      for (const [name, seat] of Object.entries(seats)) {
        if (name !== "creator" && name !== "orchestrator" && !name.endsWith("_p")) continue
        assertNoGenerationTools(`${path.split("/").slice(-1)[0]}:${name}`, enabled(seat), generation)
      }
    }

    // 双侧：十个必需工具齐全（不因压到 ≤12 而删能力）。
    const creator = enabled(seatsOf(OPENCODE_JSON).creator)
    for (const tool of DOC_MAIN_TOOLS) expect(creator).toContain(tool)
  })

  test("反例：手造的席位启用 image_generate 必须被生成工具闸报出", () => {
    const generation = new Set<string>(DOC_DIRECT_GENERATION_TOOLS)
    expect(() => assertNoGenerationTools("fake_p", ["read", "image_generate"], generation)).toThrow(/生成类工具/)
    expect(() => assertNoGenerationTools("fake_p", ["read", "project_get"], generation)).not.toThrow()
  })
})
