import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, guardFail } from "../lib/director-common"

// 3D 导演台群组管理（R3，2026-09-03，评测 P1-6「群组零写路径」补口）。gateway 契约：
// add=op addGroup {op:"addGroup", name, element_ids:[]} → {ok, group:{id,name,element_ids}, revision}；
// remove=op removeGroup {op:"removeGroup", group_id} → {ok, removed_group_id, revision}。
// 请求封装逐行复用 director_manage_plan.ts 范式（directorFetch op 信封 {ops:[...], reason}）。

export default tool({
  description:
    "管理导演台群组：把多个元素编组一起移动/管理。add 需要 name 与 element_ids（director_get_state 返回的真实对象 ID，至少一个）；remove 需要 group_id。",
  args: {
    operation: tool.schema.enum(["add", "remove"]).describe("群组操作"),
    name: tool.schema.string().optional().describe("add 时的群组名称"),
    element_ids: tool.schema.array(tool.schema.string()).optional().describe("add 时编组的元素 ID 列表"),
    group_id: tool.schema.string().optional().describe("remove 时的群组 ID（director_get_state 的 groups[].id）"),
    reason: tool.schema.string().min(1).describe("一句话说明为什么做这次群组操作（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const operation = String(args.operation ?? "")
      if (operation === "add") {
        const groupName = String(args.name ?? "").trim()
        const elementIds = Array.isArray(args.element_ids) ? args.element_ids.map((item) => String(item)).filter(Boolean) : []
        if (!groupName) return fail("director_invalid_args", "新建群组需要提供 name")
        if (elementIds.length === 0) return fail("director_invalid_args", "新建群组需要提供至少一个 element_ids")
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "addGroup", name: groupName, element_ids: elementIds }], reason: args.reason },
          context.abort,
        )
        const group = data.group as { id?: string; name?: string; element_ids?: string[] } | undefined
        return ok({ operation, group: group ?? null, group_id: group?.id ?? null, revision: data.revision })
      }
      if (operation === "remove") {
        const id = String(args.group_id ?? "")
        if (!id) return fail("director_invalid_args", "删除群组需要提供 group_id")
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "removeGroup", group_id: id }], reason: args.reason },
          context.abort,
        )
        return ok({ operation, removed_group_id: data.removed_group_id ?? id, revision: data.revision })
      }
      return fail("director_invalid_args", `不支持的群组操作 ${operation}`)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})
