// project_patch — 改工程图的唯一写入口（S9）。强类型 PatchOp 与 {op:"dsl"} 两种写法。
// {op:"dsl"} 在工具端经站点编译（target:"project"）展开成 PatchOp[] 再送网关；网关不收 dsl。
// Actor 由网关按 sessionID 解析（主席位=agent／子代理席位=subagent+lane），工具不得自带 actor。
import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { expandProjectDsl, projectPatch } from "../lib/project-client"

const z = tool.schema

const nodeId = z.string().describe("节点 id（^[a-z][a-z0-9_]{0,47}，forEach 实例带 #rowId）")
const artifactId = z.string().describe("产物 id（art_ + 16 位 hex）")

const newNode = z.object({
  id: z.string().describe("新节点 id"),
  type: z.string().describe("reference|script|shotlist|keyframe|clip|voice|music|timeline|subtitle|mix|export|qc|render3d"),
  intent: z.string().optional().describe("人话说明（≤200 字，不进签名）"),
  params: z.record(z.string(), z.any()).optional().describe("类型相关参数；字符串可含 ${node.port} 引用"),
  inputs: z.record(z.string(), z.object({ from: z.string(), port: z.string().optional() })).optional().describe("显式输入边"),
  refs: z.array(z.object({ artifactId: z.string(), role: z.string() })).optional().describe("外部常量素材"),
  forEach: z.object({ over: z.string(), as: z.string() }).optional().describe("扇出模板"),
  takes: z.object({ n: z.number().int(), select: z.enum(["qc", "first", "user"]), rubric: z.string().optional() }).optional(),
  onFail: z.any().optional().describe("失败策略（regenerate/fail/skip/ask_user）"),
})

const patchOp = z.union([
  z.object({ op: z.literal("add_node"), node: newNode }),
  z.object({ op: z.literal("set"), node: nodeId, path: z.string(), value: z.any(), ifRev: z.number().int().optional() }),
  z.object({ op: z.literal("remove_node"), node: nodeId }),
  z.object({ op: z.literal("connect"), to: nodeId, input: z.string(), from: nodeId, port: z.string().optional() }),
  z.object({ op: z.literal("disconnect"), to: nodeId, input: z.string() }),
  z.object({ op: z.literal("lock"), node: nodeId, fields: z.union([z.array(z.string()), z.literal("*")]) }),
  z.object({ op: z.literal("unlock"), node: nodeId }),
  z.object({ op: z.literal("pin"), node: nodeId, take: z.number().int().optional(), reason: z.string().optional() }),
  z.object({ op: z.literal("unpin"), node: nodeId }),
  z.object({ op: z.literal("replace_output"), node: nodeId, artifactId }),
  z.object({ op: z.literal("select_take"), node: nodeId, take: z.number().int() }),
  z.object({ op: z.literal("reroll"), node: nodeId }),
  z.object({ op: z.literal("write_result"), node: nodeId, value: z.any() }),
  z.object({
    op: z.literal("set_targets"),
    targets: z.object({
      durationSec: z.number().optional(), aspect: z.string().optional(), shots: z.number().int().optional(),
      subtitles: z.boolean().optional(), audio: z.enum(["voice", "music", "both", "none"]).optional(),
    }),
  }),
  z.object({
    op: z.literal("set_defaults"),
    defaults: z.object({
      videoModel: z.string().optional(), imageModel: z.string().optional(), imageSize: z.string().optional(),
      voice: z.string().optional(), style: z.string().optional(),
    }),
  }),
  z.object({ op: z.literal("apply_recipe"), recipe: z.string(), params: z.record(z.string(), z.any()) }),
  z.object({ op: z.literal("dsl"), source: z.any().describe("整份 DSL：工具端先交站点 compile(target:\"project\") 展开成 PatchOp") }),
])

/** 与契约 ProjectPatchArgs 双向对齐的 zod 形状（测试用同一实例做 fixtures 往返）。 */
export const projectPatchArgsSchema = z.object({
  ops: z.array(patchOp).min(1).max(1000),
  baseVersion: z.number().int().optional(),
  atomic: z.boolean().optional(),
})

export default tool({
  description:
    "改工程图（唯一写路径）。ops 是 PatchOp 数组，或 {op:\"dsl\", source}（整份 DSL 由站点编译器展开；适合一次铺/改多个节点）。\n" +
    "常用：add_node（建节点）、set（改 params.<k>/intent/takes/onFail/refs，可带 ifRev）、connect/disconnect（连线）、" +
    "pin/unpin（钉住产物）、lock/unlock（作者锁）、reroll（换 seed）、write_result（script/shotlist/qc 写内容）、" +
    "select_take、replace_output（仅用户）、set_targets、set_defaults、apply_recipe、remove_node。\n" +
    "规则：pinned/locked 的内容不要覆盖；子代理只能写自己 lane 内的节点；报错回执里 rejected[].code 是权威（LOCKED/LANE_VIOLATION/…）。" +
    "改完要产出就调 project_run；补丁本身不执行。",
  args: projectPatchArgsSchema.shape,
  async execute(args, context) {
    const ops: unknown[] = []
    for (const op of args.ops as Array<Record<string, unknown>>) {
      if (op && op.op === "dsl") {
        const expanded = await expandProjectDsl(op.source, context.sessionID)
        if (!expanded.ok) {
          return fail("workflow_dsl_invalid", (expanded.errors ?? ["DSL 编译失败"]).join("；").slice(0, 600))
        }
        for (const item of expanded.ops ?? []) ops.push(item)
        continue
      }
      ops.push(op)
    }
    if (!ops.length) return fail("empty_patch", "没有可应用的 op（DSL 编译结果为空）。")
    const r = await projectPatch(context.sessionID, {
      ops,
      ...(typeof args.baseVersion === "number" ? { baseVersion: args.baseVersion } : {}),
      ...(typeof args.atomic === "boolean" ? { atomic: args.atomic } : {}),
    })
    if (!r.ok) {
      return fail(r.error?.code ?? "project_patch_failed", r.error?.message ?? "补丁失败", { status: r.status })
    }
    return ok(r.data ?? {})
  },
})
