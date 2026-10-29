// S14 工程模式席位与工具面验收（设计文档 §3.7 第 8-10 点 / §4.2 S14 行）。
//
// 期望来源（不是从被测实现抄答案）：
//   * 十个主席位工具 = 设计文档 §3.7 第 8 点逐字清单；
//   * DIRECT_GENERATION_TOOLS = 契约 project/constants.ts；扫描补全清单来自对
//     R/tools/*.ts 的独立扫描（runGenBatch / POST /upscale / POST /agent/v1/tts）；
//   * 旧席位逐字不变 = git HEAD（S14 改前）各席位对象的 sha256，硬编码在本档；
//   * plan 拒绝的三个工具 = 设计文档 §3.7 第 9 点。
//
// 跑法：bun test deploy-staging/gateway/messages-gw-admission-project.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { DIRECT_GENERATION_TOOLS, LIMITS } from "./project/constants.ts"
import expertIds from "./expert/expert-ids.json"

const GATEWAY_DIR = import.meta.dir
const OC_PATH = join(GATEWAY_DIR, "..", "opencode-runtime", "opencode.json")
const EX_PATH = join(GATEWAY_DIR, "expert", "opencode-agents.json")

// 独立临时运行面：计划状态走真 persistence（bun:sqlite），不碰生产库/工作区。
// 注意：persistence-schema.ts 的 DB 路径是**模组级常量**，由本进程最先加载 persistence
// 的测试档决定。本档若先加载（单跑）就用这里给的临时库；若被别的档先加载（全量共跑），
// beforeAll 的 initPersistence() 会沿用那个档的固定路径——因此那个档也必须给可写临时库
// （见 environment-facts.test.ts 的 dynamic import 说明）。
const SANDBOX = mkdtempSync(join(tmpdir(), "s14-project-"))
const PREV_ENV = {
  SESSIONS_DB_PATH: process.env.SESSIONS_DB_PATH,
  HARNESS_WORKSPACE: process.env.HARNESS_WORKSPACE,
  HARNESS_STATE: process.env.HARNESS_STATE,
}
process.env.SESSIONS_DB_PATH = join(SANDBOX, "sessions.db")
process.env.HARNESS_WORKSPACE = join(SANDBOX, "workspace")
process.env.HARNESS_STATE = join(SANDBOX, "state")
mkdirSync(process.env.HARNESS_WORKSPACE, { recursive: true })
mkdirSync(process.env.HARNESS_STATE, { recursive: true })

type Seat = { mode?: string; description?: string; prompt?: string; tools: Record<string, boolean> }
type SeatFile = Record<string, Seat>

const oc = () => (JSON.parse(readFileSync(OC_PATH, "utf8")) as { agent: SeatFile }).agent
const ex = () => JSON.parse(readFileSync(EX_PATH, "utf8")) as SeatFile

const MAIN_TOOLS = [
  "project_get",
  "project_patch",
  "project_run",
  "subagent_dispatch",
  "subagent_stop",
  "question",
  "read_image",
  "asset_search",
  "read",
  // 2026-10-29 补回：报价合并、技能库（提示词功底）、子代理进度。
  "quote_bundle",
  "skill",
  "subagent_status",
].sort()

// R/tools/*.ts 扫描补全：这些工具源码里真的提交生成（不是描述里提到）：
//   lib/img-orchestrate.runGenBatch → canonical_key_art_lock / cast_asset_lock /
//   story_sequence_consistency / product_lock；platformFetch POST /upscale → upscale_audit；
//   POST /agent/v1/tts → audio_first_timeline。
const SCAN_EXTRA_GENERATION_TOOLS = [
  "canonical_key_art_lock",
  "cast_asset_lock",
  "story_sequence_consistency",
  "product_lock",
  "upscale_audit",
  "audio_first_timeline",
]
const GENERATION = [...DIRECT_GENERATION_TOOLS, ...SCAN_EXTRA_GENERATION_TOOLS].map((t) => t.toLowerCase())
const PROJECT_TOOLS = ["project_get", "project_patch", "project_run"]

// 权威专家席位清单：expert/expert-ids.json（S16 的 project/lanes.ts 也用它，不另抄第二份）。
const EXPERTS: string[] = Array.isArray(expertIds.experts) ? expertIds.experts : []
const CORE_SEATS = new Set(["researcher", "build", "plan", "compaction", "creator", "creator_legacy", "orchestrator", "orchestrator_legacy"])

// S14 改前（git HEAD）各席位对象的 sha256：JSON.parse 保序 + 紧凑序列化 ⇒ 逐字指纹。
const HEAD_OPENCODE_SEATS: Record<string, string> = {
  build: "3076d6d5f738c456be014310cf7c943d34c4a7011c328963c94f9924d33e6f23",
  plan: "e0bd84a13e229ccd9d764c3adee1004e7cac25ec90d1a4cef2976a70e23692f8",
  compaction: "62db79150a353598c8c3da5607275c64a39337233dd8ec58730075ae924a3b54",
  creator: "5f420fb146f4d49090d79dc7a4ca90b943d255302014b5bffc6fe86bfca42c38",
  orchestrator: "301be3b97cd9e556d262aedd2abc818ef410409ffc12f778dffdc06a90c9d2a1",
  director3d: "0d05f80c577882d32ec2cc034f3773778896743d77604593379fa29a96e9f391",
  music: "13786867016a4c4e847b1dfb358ac289c752bb7e576bae934ec3ed505a26aecc",
  "video-director": "fef42a308c662fd3b8ac17a925ecaa98b4eeaa67662150c0a91ffc35dcc35ad3",
  editor: "344d906e2aca1de242702f394dd2c3baf58be6b80a5546040f5121198e095c0b",
  screenwriter: "bc0d92aa4defc06fd63ee2ebb12018b77bd90f74e8ae688023a9109a3a70eeda",
  "motion-director": "0c1b4ab967034ea2e53c14c71fbf9862c8e8c853fe5081747f28f4b67920957a",
  "web3d-director": "5c45ba7b625759049cda93a8f70e7f406f381dc688e9983473d94500f59b02c6",
  critic: "8fffdfbd4b7ed670ed90ed7aa6878b5d6071107219649a4fc86495e3f541cf60",
  lyricist: "6e56076c39b71b4f70a30760db8c2acc89062bb119ea4bb49d20d4fa7a29b867",
}
const HEAD_EXPERT_SEATS: Record<string, string> = {
  creator: "649830b920d31db61e53a77a9995264f1980432f1a2313cbb294824a82a4079e",
  orchestrator: "097f5a7b0c9e8286a5d3fb567a99b69170f4697ed816261c723fa81a04ebfdb4",
  director3d: "d01106bab162ff94ded4e7d0e0e58cde59e094360880c237e2db1c79ec3400e9",
  music: "af38673d0998ae0b5be4b63e749884c780cdb3ed5d3343831afe23e4a7027bcb",
  "video-director": "6776ae3887845d6ba71e7a50b28a2a44ee9046cabdd46fcd213526b4a295ee8c",
  editor: "b4c9b78404cb24b5cbf07196881ee54c67acb8fe3e6d4570ff9eaedd50ac7789",
  screenwriter: "ecec586f21f72eaac009dbd2aa5b71166ef4d060ed0d7ca69fe1310dc8b9f9df",
  "motion-director": "809a21103c1aff0d7b883023c250f5070da3a108f5c92f074ba85640a2b775e2",
  "web3d-director": "eb16869e0ac363cdb3bcaa517acd3429554bb74e44912bc2bb5600eaaa8b9c86",
  critic: "ea3e886b674eb6147c20a5524ee6748e7414310579c935dcd6d470579db743f5",
  lyricist: "45d984c11c0be7a455aa48ecfc1a5593de558910411515f1ee33e38f1b1976a1",
}

const fingerprint = (seat: Seat) =>
  createHash("sha256").update(JSON.stringify(seat)).digest("hex")
const enabled = (seat: Seat) =>
  Object.entries(seat.tools)
    .filter(([, on]) => on === true)
    .map(([name]) => name)
    .sort()

let admission: typeof import("./messages-gw-admission.ts")
let routerInternal: typeof import("./router-internal.ts")
let planMode: typeof import("./plan-mode.ts")
let types: typeof import("./messages-gw-types.ts")

beforeAll(async () => {
  // 计划状态走真 persistence：显式确认安全库可用（不依赖别的测试档的 DB 状态）。
  const schema = await import("./persistence-schema.ts")
  if (schema.db === null) {
    // 共跑时 DB 路径可能被先跑的档固定成它已删除的临时目录——重建父目录后再开库，
    // 让本档不依赖别的测试档的清理时序（路径常量本身无法改指）。
    try {
      mkdirSync(dirname(schema.currentDbPath()), { recursive: true })
    } catch {}
    schema.initPersistence()
  }
  expect({ dbReady: schema.db !== null, dbPath: schema.currentDbPath() }).toMatchObject({ dbReady: true })
  admission = await import("./messages-gw-admission.ts")
  routerInternal = await import("./router-internal.ts")
  planMode = await import("./plan-mode.ts")
  types = await import("./messages-gw-types.ts")
})

afterAll(() => {
  // 还原本档改过的 env（DB 模组常量无法回退，临时库留在 tmpdir，由 OS 清理）。
  for (const [key, value] of Object.entries(PREV_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("① 主席位工具面：creator / orchestrator 集合相同、≤12、十个工具齐全", () => {
  test("creator 启用集逐项等于设计文档 §3.7 第 8 点的十个工具", () => {
    expect(enabled(oc().creator)).toEqual(MAIN_TOOLS)
  })

  test("orchestrator 与 creator 集合相同（仅防残留引用），两者均 ≤ MAIN_TOOLS_MAX", () => {
    const c = enabled(oc().creator)
    const o = enabled(oc().orchestrator)
    expect(o).toEqual(c)
    expect(c.length).toBeLessThanOrEqual(LIMITS.MAIN_TOOLS_MAX)
    expect(o.length).toBeLessThanOrEqual(LIMITS.MAIN_TOOLS_MAX)
    expect(oc().creator.tools["project_run"]).toBe(true)
    expect(oc().orchestrator.tools["project_run"]).toBe(true)
  })

  test("两份席位表的 creator/orchestrator 启用集一致（预检读第二份）", () => {
    const table = ex()
    expect(enabled(table.creator)).toEqual(MAIN_TOOLS)
    expect(enabled(table.orchestrator)).toEqual(MAIN_TOOLS)
  })
})

describe("② 直接生成工具清零（含 R/tools 扫描补全）", () => {
  const seats = () => oc()
  const projectSeatNames = () => ["creator", "orchestrator", ...EXPERTS.map((e) => `${e}_p`)]

  test("creator/orchestrator/全部 _p：opencode.json 启用集与生成工具交集为 0", () => {
    const agents = seats()
    for (const name of projectSeatNames()) {
      const on = new Set(enabled(agents[name]))
      const leaked = GENERATION.filter((tool) => on.has(tool))
      expect({ seat: name, leaked }).toEqual({ seat: name, leaked: [] })
    }
  })

  test("creator/orchestrator/全部 _p：gateway 席位表对每个生成工具都显式 false", () => {
    const table = ex()
    for (const name of projectSeatNames()) {
      const missing = GENERATION.filter((tool) => table[name].tools[tool] !== false)
      expect({ seat: name, missing }).toEqual({ seat: name, missing: [] })
    }
  })
})

describe("③ 子代理 _p 席位：存在、去掉生成工具、加入 project_get/project_patch，旧席位逐字不变", () => {
  test("每个专家席位都有同名 _p（两份表）；席位清单与 expert-ids.json 无静默遗漏", () => {
    const agents = oc()
    const table = ex()
    // 反向：opencode.json 里除核心席位与 *_p/*_legacy 外的每个席位都必须在专家清单里，
    // 否则「逐一补 _p」会静默漏掉新专家。
    const derivedExperts = Object.keys(agents).filter(
      (name) => !CORE_SEATS.has(name) && !name.endsWith("_p"),
    )
    expect(derivedExperts.sort()).toEqual([...EXPERTS].sort())
    for (const expert of EXPERTS) {
      expect(agents[`${expert}_p`]).toBeDefined()
      expect(table[`${expert}_p`]).toBeDefined()
    }
  })

  test("_p = 原席位逐项拷贝，只动生成工具与三个 project 工具（opencode.json）", () => {
    const agents = oc()
    for (const expert of EXPERTS) {
      const original = agents[expert]
      const derived = agents[`${expert}_p`]
      const touched = new Set([...GENERATION, ...PROJECT_TOOLS])
      for (const [tool, on] of Object.entries(original.tools)) {
        if (touched.has(tool)) continue
        expect({ expert, tool, value: derived.tools[tool] }).toEqual({ expert, tool, value: on })
      }
      expect(derived.tools["project_get"]).toBe(true)
      expect(derived.tools["project_patch"]).toBe(true)
      // 设计 §3.7 第 10 点：_p 席位要在自己 lane 里 add_node 后 project_run（直调生成仍为 0）。
      expect(derived.tools["project_run"]).toBe(true)
      // prompt/mode 逐字拷贝（不做提示词打磨）。
      expect(derived.prompt).toBe(original.prompt)
      expect(derived.mode).toBe(original.mode)
    }
  })

  test("_p 同样逐项拷贝 gateway 席位表（只动生成工具与 project 工具）", () => {
    const table = ex()
    for (const expert of EXPERTS) {
      const original = table[expert]
      const derived = table[`${expert}_p`]
      const touched = new Set([...GENERATION, ...PROJECT_TOOLS])
      for (const [tool, on] of Object.entries(original.tools)) {
        if (touched.has(tool)) continue
        expect({ expert, tool, value: derived.tools[tool] }).toEqual({ expert, tool, value: on })
      }
      expect(derived.tools["project_get"]).toBe(true)
      expect(derived.tools["project_patch"]).toBe(true)
      expect(derived.tools["project_run"]).toBe(true)
    }
  })

  test("opencode.json：旧席位（含 plan/build/compaction）逐字等于 S14 改前指纹", () => {
    const agents = oc()
    for (const [name, hash] of Object.entries(HEAD_OPENCODE_SEATS)) {
      // creator/orchestrator 是本片重定义的新席位；旧内容以 *_legacy 逐字保留，下方单独断言。
      if (name === "creator" || name === "orchestrator") continue
      expect({ seat: name, fingerprint: fingerprint(agents[name]) }).toEqual({ seat: name, fingerprint: hash })
    }
    expect(enabled(agents.plan).length).toBe(5)
  })

  test("gateway 席位表：旧席位逐字等于 S14 改前指纹", () => {
    const table = ex()
    for (const [name, hash] of Object.entries(HEAD_EXPERT_SEATS)) {
      if (name === "creator" || name === "orchestrator") continue
      expect({ seat: name, fingerprint: fingerprint(table[name]) }).toEqual({ seat: name, fingerprint: hash })
    }
  })

  test("creator_legacy / orchestrator_legacy = 改前 creator/orchestrator 逐字拷贝", () => {
    const agents = oc()
    expect(fingerprint(agents.creator_legacy)).toBe(HEAD_OPENCODE_SEATS.creator)
    expect(fingerprint(agents.orchestrator_legacy)).toBe(HEAD_OPENCODE_SEATS.orchestrator)
    expect(enabled(agents.creator_legacy).length).toBe(49)
    expect(enabled(agents.orchestrator_legacy).length).toBe(38)

    const table = ex()
    expect(fingerprint(table.creator_legacy)).toBe(HEAD_EXPERT_SEATS.creator)
    expect(fingerprint(table.orchestrator_legacy)).toBe(HEAD_EXPERT_SEATS.orchestrator)
  })
})

describe("④ beast：两种取值下工程会话 promptBody.agent 都是 creator，beast 只锁存", () => {
  test("工程会话：beast=true/false 均解析为 creator", () => {
    const table = ex() // 只为确保两份席位表真的存在 creator
    expect(table.creator).toBeDefined()
    expect(admission.resolvePromptSeat({ projectMode: true, seat: "creator", beast: true })).toBe("creator")
    expect(admission.resolvePromptSeat({ projectMode: true, seat: "creator", beast: false })).toBe("creator")
    // 即使 seat 缺省，projectMode 也足以把席位钉在 creator。
    expect(admission.resolvePromptSeat({ projectMode: true, beast: true })).toBe("creator")
  })

  test("旧会话：仍按 beast 在 *_legacy 之间切换（旧行为冻结）", () => {
    expect(admission.resolvePromptSeat({ projectMode: false, seat: "creator_legacy", beast: true })).toBe(
      "orchestrator_legacy",
    )
    expect(admission.resolvePromptSeat({ projectMode: false, seat: "creator_legacy", beast: false })).toBe(
      "creator_legacy",
    )
    expect(admission.resolvePromptSeat({ beast: true })).toBe("orchestrator_legacy")
    expect(admission.resolvePromptSeat({ beast: false })).toBe("creator_legacy")
    // 两个 legacy 席位都必须真实存在于 opencode.json，否则旧会话会派到不存在的 agent。
    expect(oc().orchestrator_legacy).toBeDefined()
    expect(oc().creator_legacy).toBeDefined()
  })

  test("beast 取值：工程会话用锁存值（不受实时设置翻转），旧会话仍读实时设置", () => {
    expect(admission.resolveBeastMode({ projectMode: true, latched: true }, false)).toBe(true)
    expect(admission.resolveBeastMode({ projectMode: true, latched: false }, true)).toBe(false)
    expect(admission.resolveBeastMode({ projectMode: false, latched: false }, true)).toBe(true)
    expect(admission.resolveBeastMode({ projectMode: false, latched: true }, false)).toBe(false)
  })

  test("席位解析只可能给出 creator / creator_legacy / orchestrator_legacy（没有 plan 换席位）", () => {
    const allowed = new Set(["creator", "creator_legacy", "orchestrator_legacy"])
    for (const projectMode of [true, false, undefined]) {
      for (const seat of ["creator", "creator_legacy", undefined] as const) {
        for (const beast of [true, false, undefined]) {
          expect(allowed.has(admission.resolvePromptSeat({ projectMode, seat, beast }))).toBe(true)
        }
      }
    }
  })
})

describe("⑤ plan 模式：precheck 拒绝三工具且工具表不变", () => {
  const PLAN_DENIED = ["project_patch", "project_run", "subagent_dispatch"]

  async function precheck(sessionId: string, tool: string) {
    const req = new Request("http://127.0.0.1/internal/tool/precheck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, tool, input: {}, cwd: SANDBOX }),
    })
    const res = await routerInternal.handleToolPrecheck(req)
    return (await res.json()) as {
      plan: { status: number; body: Record<string, unknown> } | null
      permission: { status: number; body: Record<string, unknown> } | null
    }
  }

  test("计划模式下三个工具都被拒绝（教学式原因），project_get 不被本闸拦", async () => {
    const sessionId = "ses_s14_plan_fixture"
    await planMode.enterPlanMode(sessionId)

    for (const tool of PLAN_DENIED) {
      const out = await precheck(sessionId, tool)
      expect({ tool, denied: out.plan?.body?.denied_tool }).toEqual({ tool, denied: tool })
      expect(out.plan?.body?.inPlanMode).toBe(true)
      expect(String(out.plan?.body?.denied_reason)).toContain("exit_plan_mode")
      const perm = out.permission?.body as { behavior?: string; reason?: { reason?: string } }
      expect(perm.behavior).toBe("deny")
      expect(String(perm.reason?.reason)).toContain(tool)
    }

    // 非三工具：本闸不添加拒绝标记（其余闸门语义原样）。
    const control = await precheck(sessionId, "project_get")
    expect(control.plan?.body?.denied_tool).toBeUndefined()
  })

  test("非计划会话调用 project_patch 不被本闸拒绝", async () => {
    const out = await precheck("ses_s14_not_plan_fixture", "project_patch")
    expect(out.plan?.body?.denied_tool).toBeUndefined()
    const perm = out.permission?.body as { behavior?: string }
    expect(perm.behavior).not.toBe("deny")
  })

  test("plan 模式不换席位：opencode.json 的 plan 席位原样，creator 仍是十个工具", () => {
    expect(fingerprint(oc().plan)).toBe(HEAD_OPENCODE_SEATS.plan)
    expect(enabled(oc().creator)).toEqual(MAIN_TOOLS)
  })
})

describe("⑥ 工程模式跳过旧模板骨架（首条消息意图判定只跑一次）", () => {
  test("projectMode=true 时，无论有没有用户模板都不建骨架", () => {
    expect(admission.shouldBuildTemplateSkeleton({ projectMode: true, userTemplateAttached: false })).toBe(false)
    expect(admission.shouldBuildTemplateSkeleton({ projectMode: true, userTemplateAttached: true })).toBe(false)
  })

  test("旧会话保持原行为：无模板建骨架、有模板跳过", () => {
    expect(admission.shouldBuildTemplateSkeleton({ projectMode: false, userTemplateAttached: false })).toBe(true)
    expect(admission.shouldBuildTemplateSkeleton({ projectMode: false, userTemplateAttached: true })).toBe(false)
    expect(admission.shouldBuildTemplateSkeleton({})).toBe(true)
  })
})

describe("⑦ 工程模式停掉全部尾部注入（§3.7 第 7 点，伪用户消息=0）", () => {
  // 与 admission 内 20 处直接注入 + 3 处 hook 注入一一对应（标签逐条，见
  // messages-gw-admission.ts 的 maybeAppend*/maybePushHookInjection 调用点）。
  const TAIL_SITES: { kind: "system" | "data" | "context" | "hook"; label: string }[] = [
    { kind: "system", label: "【附件路径·本轮事实】" },
    { kind: "system", label: "【记忆召回·资料】" },
    { kind: "system", label: "【新创作·本轮要求】" },
    { kind: "system", label: "【账户记忆·本轮资料】" },
    { kind: "system", label: "【首次引导·本轮事实】" },
    { kind: "data", label: "【模板偏好·用户资料】" },
    { kind: "system", label: "【本轮设置·真实状态】" },
    { kind: "system", label: "【本轮角色与阶段】" },
    { kind: "context", label: "【派遣配方·版本契约】" },
    { kind: "context", label: "【专家注册表·版本资料】" },
    { kind: "context", label: "【技能索引·版本资料】" },
    { kind: "system", label: "【当前授权·本轮核实】" },
    { kind: "system", label: "【机器·画布写穿·默认骨架】" },
    { kind: "system", label: "【运行时环境·本轮事实】" },
    { kind: "system", label: "【上一轮中止·本轮事实】" },
    { kind: "system", label: "【上一轮计划·本轮事实】" },
    { kind: "system", label: "【压缩续接·上下文已重建】" },
    { kind: "system", label: "【剩余 token·本轮估算】" },
    { kind: "system", label: "【画布模板·系统事实】" },
    { kind: "system", label: "【本轮图片附件·无法直接查看】" },
    { kind: "hook", label: "【Hook·会话启动·非用户指令】" },
    { kind: "hook", label: "【Hook·用户提交·非用户指令】" },
    { kind: "hook", label: "【Hook·压缩后·非用户指令】" },
  ]

  const stateOf = (projectMode: boolean, tag: string) =>
    ({
      sessionId: `ses_s14_tail_${tag}`,
      opencodeSessionId: `oc_s14_tail_${tag}`,
      apiKey: "sk-s14-tail-fixture-0123456789",
      projectMode,
      // 注入开关看席位：lean creator 席位不注入；新会话（旧席位＋工程引擎）照旧注入
      seat: projectMode ? "creator" : "creator_legacy",
    }) as unknown as import("./types-gateway.ts").SessionState

  const newBody = () => ({ parts: [] as import("./types-gateway.ts").GatewayPromptPart[] })

  function runSite(projectMode: boolean, site: (typeof TAIL_SITES)[number], tag: string) {
    const state = stateOf(projectMode, tag)
    const body = newBody()
    const sections: { render: (ctx: unknown) => string }[] = []
    let injected = false
    if (site.kind === "system") {
      injected = admission.maybeAppendSystemTail(state, body, `payload ${site.label}`, site.label)
    } else if (site.kind === "data") {
      injected = admission.maybeAppendDataTail(state, body, `payload ${site.label}`, site.label)
    } else if (site.kind === "context") {
      injected = admission.maybeAppendContextDelta(state, body, site.label, `delta ${site.label}`)
    } else {
      injected = admission.maybePushHookInjection(state, body, sections as never, `hook ${site.label}`, {
        id: site.label,
        priority: 10,
        label: site.label,
      })
    }
    return { state, body, sections, injected }
  }

  test("工程模式：23 个注入点逐个不执行，promptBody 里一条都没有", () => {
    expect(TAIL_SITES.length).toBe(23)
    for (const site of TAIL_SITES) {
      const out = runSite(true, site, `p_${site.label}`)
      expect({ label: site.label, injected: out.injected }).toEqual({ label: site.label, injected: false })
      expect(out.body.parts).toEqual([])
      expect(out.sections).toEqual([])
      expect(JSON.stringify(out.body.parts).includes(site.label)).toBe(false)
    }
  })

  test("旧席位：同一输入逐个照旧注入（标题逐条出现）", () => {
    for (const site of TAIL_SITES) {
      const out = runSite(false, site, `l_${site.label}`)
      expect({ label: site.label, injected: out.injected }).toEqual({ label: site.label, injected: true })
      const all = out.body.parts.map((p) => ("text" in p ? String(p.text) : "")).join("\n")
      expect(all).toContain(site.label)
      if (site.kind === "hook") expect(out.sections.length).toBe(1)
    }
  })

  test("旧席位路径与改前逐字节相同：同一输入，maybe* 与原始注入函数输出全等", () => {
    for (const site of TAIL_SITES) {
      const viaWrapper = runSite(false, site, `w_${site.label}`)
      const state2 = stateOf(false, `r_${site.label}`)
      const body2 = newBody()
      const sections2: { render: (ctx: unknown) => string }[] = []
      if (site.kind === "system") {
        types.appendSystemPayloadToTurnTail(state2, body2, `payload ${site.label}`, site.label)
      } else if (site.kind === "data") {
        types.appendDataPayloadToTurnTail(body2, `payload ${site.label}`, site.label)
      } else if (site.kind === "context") {
        types.appendContextDelta(state2, body2, site.label, `delta ${site.label}`)
      } else {
        types.pushHookInjection(state2, body2, sections2 as never, `hook ${site.label}`, {
          id: site.label,
          priority: 10,
          label: site.label,
        })
      }
      expect(JSON.stringify(viaWrapper.body.parts)).toBe(JSON.stringify(body2.parts))
      expect(JSON.stringify(viaWrapper.sections.map((s) => s.render({})))).toBe(
        JSON.stringify(sections2.map((s) => s.render({}))),
      )
    }
  })

  test("结构守卫：admission 内不再有绕过开关的原始注入调用", () => {
    // 结构性断言（不是行为 oracle）：原始函数只允许出现在各自 wrapper 体内一次；
    // 20 处直接调用 + 3 处 hook 调用全部走 maybe*。
    const src = readFileSync(join(GATEWAY_DIR, "messages-gw-admission.ts"), "utf8")
    const count = (name: string) => (src.match(new RegExp(`\\b${name}\\(`, "g")) ?? []).length
    expect(count("appendSystemPayloadToTurnTail")).toBe(1)
    expect(count("appendDataPayloadToTurnTail")).toBe(1)
    expect(count("appendContextDelta")).toBe(1)
    expect(count("pushHookInjection")).toBe(1)
    // 1 个定义 + N 个调用点
    expect(count("maybeAppendSystemTail")).toBe(17)
    expect(count("maybeAppendDataTail")).toBe(2)
    expect(count("maybeAppendContextDelta")).toBe(4)
    expect(count("maybePushHookInjection")).toBe(4)
  })
})
