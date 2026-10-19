#!/usr/bin/env bun
// gen-opencode.ts — 从 agent model registry（单一真源）生成 opencode.json 的
// provider/model/small_model 三个键，其余键（permission/instructions 等）原样保留。
// 用法：
//   bun gen-opencode.ts            # 写入（原子：tmp + rename）
//   bun gen-opencode.ts --check    # 只比对不写；有漂移印差异 exit 1，无漂移 "in sync" exit 0
// 2026-09-18：加 fail-closed 闸——binding 的 providerID 必须在 registry.providers
// 内声明，否则拒写（见下方 GUARD 段落）。
import { readFileSync, writeFileSync, renameSync } from "node:fs"

const REGISTRY_PATH = process.env.AGENT_MODEL_REGISTRY || "/opt/eimu-harness/agent-models.json"
const TARGET_PATH = "/opt/eimu-harness/workspace/.opencode/opencode.json"

let registry: {
  providers?: unknown
  bindings?: {
    default?: unknown
    small_model?: unknown
    persona?: Record<string, unknown>
    fallbacks?: Record<string, unknown>
  }
}
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"))
} catch (e) {
  console.error(`[gen-opencode] registry unreadable/invalid at ${REGISTRY_PATH}:`, e instanceof Error ? e.message : e)
  process.exit(1)
}
if (!registry || typeof registry !== "object" || !registry.providers || !registry.bindings) {
  console.error(`[gen-opencode] registry missing providers/bindings at ${REGISTRY_PATH} — not touching target`)
  process.exit(1)
}
const defaultBinding = registry.bindings.default
const smallModelBinding = registry.bindings.small_model
if (typeof defaultBinding !== "string" || typeof smallModelBinding !== "string") {
  console.error(`[gen-opencode] registry bindings.default / bindings.small_model must be strings — not touching target`)
  process.exit(1)
}

// ── GUARD（2026-09-18 事故）：binding 的 providerID 必须在 registry.providers 内声明 ──
// 实锤：09-18 zen 免费层实验把 bindings 写成 `opencode/muse-spark-1.3-contributor-free`
// 与 `opencode/union-alpha`。`opencode` 是 opencode binary **内建**的 zen provider，
// 不在 registry.providers 里也照样解析得到，所以 gen 静默照抄进 opencode.json 的
// model/small_model；gateway 又把 persona binding 当 per-message `model` 下发
// （index.ts personaModel→promptBody.model），opencode native `/summarize` 拿它做
// 压缩 → 撞 zen 免费层门禁 403 FreeTierError（`opencode/union-alpha`）与地区门禁
// `This model is not available in your country`（`muse-spark-1.2-contributor-free`）
// → 整条 compaction 全灭。此闸把「型别合法但渠道不存在」这一类静默灾难挡在生成前。
const declaredProviders = new Set(Object.keys((registry.providers ?? {}) as Record<string, unknown>))

/** 收集所有 binding 字串：default / small_model / persona.* / fallbacks.*[]。 */
function collectBindings(bindings: NonNullable<typeof registry.bindings>): { label: string; ref: string }[] {
  const out: { label: string; ref: string }[] = []
  const push = (label: string, v: unknown) => {
    if (typeof v === "string") out.push({ label, ref: v })
    else out.push({ label, ref: `<<非字串：${JSON.stringify(v)}>>` })
  }
  push("bindings.default", bindings.default)
  push("bindings.small_model", bindings.small_model)
  for (const [k, v] of Object.entries(bindings.persona ?? {})) push(`bindings.persona.${k}`, v)
  for (const [k, v] of Object.entries(bindings.fallbacks ?? {})) {
    if (Array.isArray(v)) v.forEach((item, i) => push(`bindings.fallbacks.${k}[${i}]`, item))
    else push(`bindings.fallbacks.${k}`, v)
  }
  return out
}

const violations: string[] = []
const deadRefs: string[] = []
for (const { label, ref } of collectBindings(registry.bindings)) {
  // 形状规则与 gateway index.ts 的 bindingRef 对齐：单一 "/"，两侧非空。
  const idx = ref.indexOf("/")
  if (idx <= 0 || idx === ref.length - 1 || ref.slice(idx + 1).includes("/")) {
    // 含第二个 "/" 的项 gateway 会静默丢弃（既不生效也不报错）= 死配置。只警告不挡。
    deadRefs.push(`${label} = ${JSON.stringify(ref)}`)
    continue
  }
  const providerID = ref.slice(0, idx)
  if (!declaredProviders.has(providerID)) {
    violations.push(`${label} = ${JSON.stringify(ref)} — provider「${providerID}」不在 registry.providers`)
  }
}
if (deadRefs.length > 0) {
  console.warn(`[gen-opencode] WARN: ${deadRefs.length} binding(s) 形状不合法，gateway bindingRef 会静默丢弃（死配置）：`)
  for (const d of deadRefs) console.warn(`  - ${d}`)
}
if (violations.length > 0) {
  console.error(`[gen-opencode] refusing to write: ${violations.length} binding(s) 指向 registry 未声明的 provider — not touching target`)
  for (const v of violations) console.error(`  - ${v}`)
  console.error(`[gen-opencode] registry.providers = [${[...declaredProviders].join(", ")}]`)
  console.error("[gen-opencode] 提醒：`opencode/*` 是 binary 内建 zen 免费层（非本 registry 渠道），本部署走它必撞 403 FreeTierError／地区门禁，会让 session compaction 全灭。")
  process.exit(1)
}

let target: Record<string, unknown>
try {
  target = JSON.parse(readFileSync(TARGET_PATH, "utf8"))
} catch (e) {
  console.error(`[gen-opencode] target unreadable/invalid at ${TARGET_PATH}:`, e instanceof Error ? e.message : e)
  process.exit(1)
}

// ── registry 的产品真相 → opencode 认得的能力栏位（2026-10-02 实锤）──
// registry 每个 model 可以写 `"vision": true`（产品负责人确认这颗模型看得到图）。
// opencode 本身不认这个键，它认 `attachment` 与 `modalities.input`；图能不能活著送到上游
// 完全由 opencode 这一关决定——模型物件留空 `{}` ＝ opencode 当它是纯文字模型，image part
// 在送上游前被静默丢掉：工具回「原图已附上」、模型却说自己看不到图（生产实锤，逃过所有既有验证，
// 因为 gateway 侧 isVisionModel 读的是 registry 旗标、两边不同步）。
// 故：有 `vision: true` 就补 attachment/modalities，并把 registry 专用的 vision 键剥掉
// （不把自家栏位塞进 opencode 设定）。
const VISION_MODALITIES_INPUT = ["text", "image"]

function withVisionCapabilities(providers: unknown): unknown {
  if (!providers || typeof providers !== "object") return providers
  const out: Record<string, unknown> = {}
  for (const [providerId, providerValue] of Object.entries(providers as Record<string, unknown>)) {
    const provider = providerValue as { models?: Record<string, unknown> } | null
    if (!provider || typeof provider !== "object" || !provider.models || typeof provider.models !== "object") {
      out[providerId] = providerValue
      continue
    }
    const models: Record<string, unknown> = {}
    for (const [modelId, modelValue] of Object.entries(provider.models)) {
      const model = modelValue as Record<string, unknown> | null
      if (!model || typeof model !== "object" || model.vision !== true) {
        models[modelId] = modelValue
        continue
      }
      const { vision: _visionFlag, ...rest } = model
      const modalities = { ...((rest.modalities as Record<string, unknown> | undefined) ?? {}) }
      modalities.input = VISION_MODALITIES_INPUT
      if (!modalities.output) modalities.output = ["text"]
      models[modelId] = { ...rest, attachment: true, modalities }
    }
    out[providerId] = { ...provider, models }
  }
  return out
}

// 只替换三个键，其余原样保留；键顺序跟随原档。
const next: Record<string, unknown> = { ...target }
next.provider = withVisionCapabilities(registry.providers)
next.model = defaultBinding
next.small_model = smallModelBinding

const serialized = JSON.stringify(next, null, 2) + "\n"
const current = readFileSync(TARGET_PATH, "utf8")

// 2026-09-18 卫生修：drift 输出逐行印 opencode.json（provider 段含明文 apiKey），
// 直印等于把 11 把上游 key 灌进 journal／CI log（本次实锤）。只遮输出，不动比对逻辑。
const maskSecrets = (line: string): string => line.replace(/("apiKey"\s*:\s*")[^"]*(")/g, "$1***MASKED***$2")

if (process.argv.includes("--check")) {
  if (serialized === current) {
    console.log("in sync")
    process.exit(0)
  }
  // 有漂移：印出逐行差异（前缀/后缀公共行剥除，中间标 <current> / <generated>）。
  const a = current.split("\n")
  const b = serialized.split("\n")
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let e = 0
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++
  const ctx = 2
  console.error("[gen-opencode] drift detected:")
  for (let i = Math.max(0, s - ctx); i < Math.min(a.length, s + ctx); i++) console.error(`  current   L${i + 1}: ${maskSecrets(a[i])}`)
  console.error("  ...")
  for (let i = s; i < a.length - e; i++) console.error(`  current  -L${i + 1}: ${maskSecrets(a[i])}`)
  for (let i = s; i < b.length - e; i++) console.error(`  expected +L${i + 1}: ${maskSecrets(b[i])}`)
  for (let i = b.length - e; i < Math.min(b.length, b.length - e + ctx); i++) console.error(`  expected  L${i + 1}: ${maskSecrets(b[i])}`)
  process.exit(1)
}

// 原子写回：tmp 档 + rename。
const tmp = TARGET_PATH + ".tmp-gen"
writeFileSync(tmp, serialized)
renameSync(tmp, TARGET_PATH)
console.log(`[gen-opencode] written ${TARGET_PATH} from ${REGISTRY_PATH}`)
