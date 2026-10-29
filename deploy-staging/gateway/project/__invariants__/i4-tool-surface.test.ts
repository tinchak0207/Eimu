// I4（设计文档 §8 第四行）：主席位工具 ≤12 且 creator/orchestrator 集合相同；beast 两取值 agent 相同；
// 200 步里工具表字节恒定；生成类工具在 creator/orchestrator/全部 _p 席位为 0。
//
// 独立期望来源（取并集，不抄 S14 提交的清单）：
//   ① 设计文档 §3.7 第 8 点的十个工具（本档逐字手写）；
//   ② 对 R/tools/*.ts 源码的静态扫描：去注释后匹配生成端点与批量提交/适配器入口；
//   ③ opencode.json / expert/opencode-agents.json 的席位表解析（只取启用集，不取生成清单）。
import "./fixtures/env"
import "./fixtures/fake-platform"
import { INVARIANTS_SANDBOX } from "./fixtures/env"
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RULES_MAP, extractRuleTags } from "../rules-map.ts"

const HERE = import.meta.dir
/** gateway/project/__invariants__ → deploy-staging */
const DEPLOY_STAGING = join(HERE, "..", "..", "..")
const R = join(DEPLOY_STAGING, "opencode-runtime")
const OPENCODE_JSON = join(R, "opencode.json")
const EXPERT_JSON = join(DEPLOY_STAGING, "gateway", "expert", "opencode-agents.json")

const MAIN_TOOLS_MAX = 14 // 设计文档 §3 常量表（2026-10-29：+quote_bundle/skill/subagent_status）
/** 设计文档 §3.7 第 8 点的十个主席位工具（逐字）。 */
const DOC_MAIN_TOOLS = [
  "project_get", "project_patch", "project_run", "subagent_dispatch", "subagent_stop",
  "question", "read_image", "search_web", "asset_search", "read",
  // 2026-10-29 补回：报价合并、技能库（提示词功底）、子代理进度——迁移时静默丢掉的三项。
  "quote_bundle", "skill", "subagent_status",
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

// ── 运行时席位选择（S2）────────────────────────────────────────────
// 生成工具清单来源：deploy-staging/opencode-runtime/tools/*.ts 去注释后的静态扫描
// （GENERATION_CALL_PATTERNS：生图/生视频端点、upscale、/agent/v1/tts、runGenBatch、
// musicGen/wrapMusic、blender 包装、music_gen/blender_render/blender_exec 字面量）
// 与设计文档超集 DOC_DIRECT_GENERATION_TOOLS 取并集。
// 2026-10-28 扫描命中（文件名＝工具名）：audio_first_timeline、blender_exec、
// blender_export_gltf、blender_render、canonical_key_art_lock、cast_asset_lock、
// character_dna_turnaround、emotion_board_matrix、hand_contact_repair、image_edit、
// image_generate、image_upscale、keyframe_render、last_frame_video_chain、
// moodboard_diverge_converge、music_gen、product_conditioned_generation、product_lock、
// scene_pack_batch、story_sequence_consistency、style_aligned_batch、tts_speak、
// upscale_audit、virtual_tryon。
// video_fetch / video_result_fetch / video_analyze / video_transcribe / video_measure /
// video_evidence / video_quote 是取回或感知，不在这份生成清单里。bash/write/edit 不是生成工具。
// 工程会话可达席位（creator、orchestrator、researcher、全部 *_p）不得启用上述并集。
const RESEARCHER_TOOLS = ["grep", "project_get", "read", "read_image", "search_web"].sort()
const CREATOR_PROMPT = [
  "工程图是唯一工作面。读工程用 project_get，改工程用 project_patch，跑工程用 project_run。[R-01]",
  "本席位不直接调用生成工具。要产出画面、影片或声音，改节点后 project_run。[R-02]",
  "专家任务派 subagent_dispatch。子代理只能写自己 lane 里的节点，越界写入会被拒绝。[R-12]",
  "问用户用 question。报价达到确认阈值且没有持续授权时，停下来等确认；持续授权只认网关核实的 auto/full。[R-07][R-08]",
  "交付只认 export 产物，口头说完成不算交付。[R-03]",
  "先铺满整条产线再细化；专家的活派给专家，互不依赖的同一轮并行派；每出一个产物、每派出或收回一个子代理，就用一两句话告诉用户进展和下一步。[R-17][R-18][R-19]",
].join("\n")
const ORCHESTRATOR_PROMPT = [
  "工程图是唯一工作面。你负责读工程、改工程、派子代理、问用户、交付。",
  "读工程用 project_get，改工程用 project_patch，跑工程用 project_run。[R-01]",
  "本席位不直接调用生成工具。[R-02]",
  "专家任务派 subagent_dispatch。子代理只能写自己 lane 里的节点。[R-12]",
  "问用户用 question。收费确认按网关核实的授权与阈值执行。[R-07][R-08]",
  "交付只认 export 产物。[R-03]",
  "先铺满整条产线再细化；专家的活派给专家，互不依赖的同一轮并行派；每出一个产物、每派出或收回一个子代理，就用一两句话告诉用户进展和下一步。[R-17][R-18][R-19]",
].join("\n")
const CREATOR_LEGACY_PROMPT = "用户直接跟你说话，你要么当场把东西做出来，要么派给专家做。手上开放的工具就用来做图、做片、做音乐。开工前按任务读 .opencode/skills/_prompt-routing/creator-guide.md 里对应的那节和本域配方，不相关的域不要加载。不是一句话能办完的事先研究，做完要有人独立看过。多步骤的活派 subagent_dispatch。只写歌词派 lyricist；整首歌要原创歌词的，先 lyricist 后 music；用户给了完整原词就直接照原样谱曲；纯器乐不派歌词。其余规则见 workspace/AGENTS.md。"
const ORCHESTRATOR_LEGACY_PROMPT = "用户在等你把东西做出来。你要做的：看懂他要什么，写成别人能直接执行的任务书，派合适的专家去做，把结果验过再交回去。出图、出片、写代码这些活由专家做，你手上没有这些工具，也不用为此向用户解释。报价和账本你来核（quote_bundle），画布你来控（canvas_get_state / workflow_write，收盘要真写穿）。读资料、看注册表是为了判断该派谁，不要把生产配方加载进来。对用户只说结果和进度，不说你是什么角色、有什么工具、系统怎么分的工。扣费与协作授权按网关这一轮核实的来。其余规则见 workspace/AGENTS.md 和派遣手册。"

function assertPromptAgent(body: { agent?: unknown }, allowed: readonly string[]): void {
  expect(typeof body.agent).toBe("string")
  const agent = String(body.agent)
  expect(agent.length).toBeGreaterThan(0)
  expect(allowed).toContain(agent)
}

function wakeState(over: Record<string, unknown> = {}): any {
  return {
    sessionId: `gw-i4-${crypto.randomUUID()}`,
    apiKey: `sk-i4-${crypto.randomUUID()}`,
    opencodeSessionId: `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    clients: new Set(),
    replayBuffer: [],
    eventCounter: 0,
    messageRole: new Map(),
    suppressedParts: new Set(),
    pendingQuestions: new Map(),
    pendingConfirms: new Map(),
    partStripState: new Map(),
    partTextEmitted: new Map(),
    stepCostLogged: new Set(),
    turnGen: 1,
    turnTextChars: 0,
    turnToolStarted: false,
    turnAborted: false,
    turnRetries: 0,
    lastTurnActiveAt: 0,
    sessionTitle: "i4",
    seat: "creator_legacy",
    projectMode: false,
    beast: false,
    ...over,
  }
}

function installPromptCapture(): { bodies: Array<{ agent?: string }>; restore: () => void } {
  const prev = globalThis.fetch
  const bodies: Array<{ agent?: string }> = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input?.url ?? "")
    if (url.includes("/prompt_async")) {
      bodies.push(JSON.parse(String(init?.body ?? "{}")))
      return new Response("{}", { status: 200 })
    }
    if (url.endsWith("/session") && (init?.method ?? "GET").toUpperCase() === "POST") {
      return new Response(JSON.stringify({ id: "ses_i4child0001" }), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (url.includes("/message")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { bodies, restore: () => { globalThis.fetch = prev } }
}

describe("I4 运行时席位：不带 agent 的 prompt 不得落到 build", () => {
  test("opencode.json default_agent 指向 creator；工程提示词按规则表，legacy 提示词逐字不动", () => {
    const raw = readJson<{ default_agent?: string; agent: Record<string, Seat & { prompt?: string }> }>(OPENCODE_JSON)
    expect(raw.default_agent).toBe("creator")
    const creator = raw.agent.creator.prompt ?? ""
    const orchestrator = raw.agent.orchestrator.prompt ?? ""
    expect(creator).toBe(CREATOR_PROMPT)
    expect(orchestrator).toBe(ORCHESTRATOR_PROMPT)
    expect(creator.split("\n").length).toBeLessThanOrEqual(40)
    expect(orchestrator.split("\n").length).toBeLessThanOrEqual(40)
    for (const prompt of [creator, orchestrator]) {
      expect(prompt.includes("做图")).toBe(false)
      expect(prompt.includes("做片")).toBe(false)
      expect(prompt.includes("做音乐")).toBe(false)
      expect(prompt.includes("workflow_write")).toBe(false)
      expect(prompt.includes("canvas_get_state")).toBe(false)
      for (const tag of extractRuleTags(prompt)) expect(RULES_MAP[tag]?.enforce).toBeTruthy()
    }
    expect(raw.agent.creator_legacy.prompt).toBe(CREATOR_LEGACY_PROMPT)
    expect(raw.agent.orchestrator_legacy.prompt).toBe(ORCHESTRATOR_LEGACY_PROMPT)
    const researcher = enabled(raw.agent.researcher)
    expect(researcher).toEqual(RESEARCHER_TOOLS)
  })

  test("工程会话可达席位的启用集不含工具目录里的直调生成工具", () => {
    const scan = scanGenerationTools()
    const generation = new Set<string>([...DOC_DIRECT_GENERATION_TOOLS, ...scan.keys()])
    const seats = seatsOf(OPENCODE_JSON)
    const reachable = Object.keys(seats).filter((name) => name === "creator" || name === "orchestrator" || name === "researcher" || name.endsWith("_p"))
    expect(reachable).toContain("creator")
    expect(reachable).toContain("researcher")
    expect(reachable.some((name) => name.endsWith("_p"))).toBe(true)
    for (const name of reachable) assertNoGenerationTools(name, enabled(seats[name]), generation)
    expect(enabled(seats.creator)).toEqual(DOC_MAIN_TOOLS)
  })

  test("主会话 prompt 的席位：工程 creator，legacy 非 beast creator_legacy，legacy beast orchestrator_legacy", () => {
    expect(adm.resolvePromptSeat({ projectMode: true, seat: "creator", beast: false })).toBe("creator")
    expect(adm.resolvePromptSeat({ projectMode: true, seat: "creator", beast: true })).toBe("creator")
    expect(adm.resolvePromptSeat({ projectMode: false, seat: "creator_legacy", beast: false })).toBe("creator_legacy")
    expect(adm.resolvePromptSeat({ projectMode: false, seat: "creator_legacy", beast: true })).toBe("orchestrator_legacy")
  })

  test("legacy 非 beast 的 wake/nudge 与工程 wakeup 字段带席位", async () => {
    const lifecycle = await import("../../session-lifecycle.ts")
    assertPromptAgent(lifecycle.beastAgentField(wakeState({ seat: "creator_legacy", projectMode: false })), ["creator_legacy"])
    assertPromptAgent(lifecycle.beastAgentField(wakeState({ seat: "creator", projectMode: true })), ["creator"])
    assertPromptAgent(lifecycle.beastAgentField(wakeState({ projectMode: false })), ["creator_legacy"])
  })

  test("通用子代理与 expert 子代理的 prompt_async body.agent", async () => {
    const { resolveDispatchAgent } = await import("../../subagent-dispatch.ts")
    expect(resolveDispatchAgent({ projectMode: true, named: "", beast: false })).toBe("researcher")
    expect(resolveDispatchAgent({ projectMode: true, named: "editor", beast: false })).toBe("editor_p")
    expect(resolveDispatchAgent({ projectMode: false, named: "", beast: false })).toBe("creator_legacy")
    expect(resolveDispatchAgent({ projectMode: false, named: "", beast: true })).toBe("orchestrator_legacy")
    expect(resolveDispatchAgent({ projectMode: false, named: "editor", beast: false })).toBe("editor")
    const { initSubagent } = await import("../../subagent-runs.ts")
    const { dispatchAttempt } = await import("../../subagent-attempt.ts")
    initSubagent({
      emitToSession: () => {},
      resolveSession: () => undefined,
      findSessionByOpenCodeId: () => undefined,
      openCodeUrl: "http://127.0.0.1:9",
      openCodeHeaders: () => ({ "content-type": "application/json" }),
      describeError: (e: unknown) => String(e),
      subagentModelChain: () => [{ providerID: "p", modelID: "m" }],
      beastMode: () => false,
      wakeParent: () => {},
    } as any)
    const cap = installPromptCapture()
    try {
      const generic = {
        id: `run-${crypto.randomUUID()}`,
        parentGatewaySessionId: "gw-parent",
        parentOpencodeSessionId: "ses_parent0001",
        opencodeSessionId: "",
        label: "研究",
        startedAt: Date.now(),
        status: "running",
        prompt: "把参考图里的构图写下来",
        modelChain: [{ providerID: "p", modelID: "m" }],
        attempt: 1,
        messageRole: new Map(),
        partEmitted: new Map(),
        beastMode: false,
        projectMode: true,
        asyncMode: false,
        partKind: new Map(),
        suppressedParts: new Set(),
        partText: new Map(),
        pendingTools: new Set(),
      } as any
      expect(await dispatchAttempt(generic)).toBeUndefined()
      assertPromptAgent(cap.bodies.at(-1) ?? {}, ["researcher"])
      const expert = { ...generic, id: `run-${crypto.randomUUID()}`, agent: "editor_p", prompt: "剪一条成片" }
      expect(await dispatchAttempt(expert)).toBeUndefined()
      assertPromptAgent(cap.bodies.at(-1) ?? {}, ["editor_p"])
    } finally {
      cap.restore()
    }
  })

  test("workflow 唤醒与 legacy goal nudge 的 prompt_async body.agent", async () => {
    const cap = installPromptCapture()
    const wf = wakeState({ seat: "creator", projectMode: true })
    const nudge = wakeState({ seat: "creator_legacy", projectMode: false })
    try {
      const { dispatchWorkflowWake } = await import("../../workflow-gw-service.ts")
      await dispatchWorkflowWake(wf, "wf-i4", "工程跑完了", "final")
      assertPromptAgent(cap.bodies[0] ?? {}, ["creator"])
      const { deliverGoalNudge } = await import("../../opencode-event-handler-goal.ts")
      await deliverGoalNudge(nudge, "还没有成片")
      assertPromptAgent(cap.bodies[1] ?? {}, ["creator_legacy"])
    } finally {
      cap.restore()
      const { clearWatchdogTimer, clearMidturnStallTimer } = await import("../../timers-gw.ts")
      clearWatchdogTimer(wf)
      clearMidturnStallTimer(wf)
      clearWatchdogTimer(nudge)
      clearMidturnStallTimer(nudge)
    }
  })

  test("failover 零产出重投沿用 lastPromptBody.agent", async () => {
    const cap = installPromptCapture()
    const fail = wakeState({
      seat: "creator",
      projectMode: true,
      turnUpstreamError: "upstream tls reset",
      lastPromptBody: { agent: "creator", parts: [{ type: "text", text: "做一张海报" }] },
    })
    try {
      const { sessions } = await import("../../sessions-core.ts")
      const { handleOpencodeEvent } = await import("../../opencode-event-handler.ts")
      sessions.set(fail.sessionId, fail)
      handleOpencodeEvent({ type: "session.idle", properties: { sessionID: fail.opencodeSessionId } })
      const deadline = Date.now() + 2500
      while (cap.bodies.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      assertPromptAgent(cap.bodies[0] ?? {}, ["creator"])
    } finally {
      cap.restore()
      const { clearWatchdogTimer, clearMidturnStallTimer } = await import("../../timers-gw.ts")
      clearWatchdogTimer(fail)
      clearMidturnStallTimer(fail)
    }
  })

  test("后台命令完成唤醒带会话当前席位，缺席位时不落到 build", async () => {
    process.env.EIMU_WORKSPACE = join(INVARIANTS_SANDBOX, "oc-workspace")
    const { sessionTmpDir } = await import("../../../opencode-runtime/lib/sandbox.ts")
    const { EimuGuard } = await import("../../../opencode-runtime/plugin/eimu-guard.ts")
    const sessionID = "ses_bgwake0001"
    const dir = sessionTmpDir(sessionID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "task1.notify"), `${sessionID}\n0\n\n`)
    const seen: Array<{ agent?: string }> = []
    await EimuGuard({
      client: {
        session: {
          get: async () => ({ data: { agent: "video-director_p" } }),
          promptAsync: async (args: any) => { seen.push(args?.body ?? {}) },
        },
      },
    } as any)
    const until = Date.now() + 4000
    while (seen.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    assertPromptAgent(seen[0] ?? {}, ["video-director_p"])
  })
})
