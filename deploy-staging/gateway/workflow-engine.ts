// 画布工作流引擎核心（Workflow Engine）
//
// 暴君策略 v2：Deepseek 填内容（prompt/model/参数），引擎展开节点流并执行。
// 本档案 = 纯函式核心（展开模板、依赖排序、节点流状态机），不碰 Bun/gateway，
// 可单测。执行层（呼叫平台 API / emit canvas.* 事件）在 gateway 内对接。
//
// 节点流 = 一组节点 + 连线（与前端 canvas/types 同构，但这里是引擎执行视角）。

// 2026-08-27 novel_film 8 䅉：audio = 配音原语（TTS 上游未接前仍可编排，执行诚实报错）、
// film = 成片原语（拼接+混音，同上）。前端 canvas/types 已有 Audio 节点型别。
//
// 2026-10-08 DSL 读面接通：expandTemplate 的主卡（模板/克隆实例）带 workflow_ns/stepId/
// stepIndex 三键，供前端 DSL 反推器（src/lib/workflow-dsl/decompile.ts）读到模板产线——
// 衍生卡（tool/note/gate）不带（辅助卡不进 DSL）。
export type WorkflowNodeKind = "text" | "config" | "image" | "video" | "audio" | "film"

export interface WorkflowNode {
  id: string
  role: string
  kind: WorkflowNodeKind
  title: string
  metadata: Record<string, unknown> // prompt/model/size/kind/count/duration_seconds...
}

export interface WorkflowConnection {
  from: string // node id
  to: string
}

export interface WorkflowGraph {
  nodes: WorkflowNode[]
  connections: WorkflowConnection[]
}

export interface TemplateContent {
  // role → 要 merge 进该节点 metadata 的内容（Deepseek 填的）
  [role: string]: Record<string, unknown>
}

/**
 * R8（2026-09-10 多镜展开修复）：从 content 抽出 shotN 角色（N≥2）的镜头编号清单。
 * 大片模板只定义 shot1 链；agent 把 shot1..shot8 全部塞进 content 时，旧版
 * expandTemplate 静默丢弃 shot2..N → expected_shots=1，agent 被迫手动 add_node
 * 克隆 21 颗节点。这里把「模板链 + content 镜头」对齐：content 有 shotN 就展开 N 链。
 */
export function detectShotRoles(template: { nodes: { role: string; kind: WorkflowNodeKind }[] }, content: TemplateContent): string[] {
  // 模板中存在的 shot 角色（如 shot1）
  const templateShotRoles = template.nodes.filter((n) => /^shot\d+$/.test(n.role)).map((n) => n.role)
  // content 中出现的 shotN 角色（含模板已定义与 N≥2 新镜）
  const contentShotRoles = Object.keys(content).filter((k) => /^shot\d+$/.test(k) && content[k] && typeof content[k] === "object")
  const all = new Set([...templateShotRoles, ...contentShotRoles])
  return [...all].sort((a, b) => (parseInt(a.slice(4), 10) || 0) - (parseInt(b.slice(4), 10) || 0))
}

/** 衍生工具卡的材料（与 workflow-templates/types.ts 的 WorkflowNodeSpec.tools 同构，引擎侧解耦用）。 */
type DerivableToolSpec = { id: string; input?: string; output?: string; unsupported?: boolean; requiredCapability?: string }

/** expandTemplate 接受的节点规格（模板 WorkflowNodeSpec 的结构子集 + 衍生卡材料）。 */
type DerivableNodeSpec = {
  role: string
  kind: WorkflowNodeKind
  title: string
  defaults?: Record<string, unknown>
  deliverable?: string
  gate?: string
  tools?: DerivableToolSpec[]
  notes?: string[]
}

/**
 * stepId 卫生化（对齐 src/lib/workflow-dsl/schema.ts STEP_ID_PATTERN ^[a-z][a-z0-9_]{0,47}$）：
 * 非 [a-z0-9_] 字元（含 role 里的 `-`）换 `_`、转小写、截 48；首字符非小写字母补 `s_`。
 * 与 decompile.ts 的 sanitizeWorkflowNs 同哲学，本档内自持（引擎档不 import 前端 lib）。
 */
function sanitizeStepId(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 48)
  return /^[a-z]/.test(cleaned) ? cleaned : `s_${cleaned}`.slice(0, 48)
}

/**
 * 展开模板：把模板节点实例化成具体节点。
 * role 出现在 contentOverrides 时，merge 进节点 metadata（Deepseek 的 prompt/model 等）。
 * multiShot 模板：可由 Deepseek 透过 add_node 追加同 role 的新实例（id 加 -N 后缀）。
 *
 * R8（2026-09-10）：multiShot 模板 + content 含 shotN（N≥2）时自动展开 N 条链——
 * 以模板 shot1 链（shot1 / shot1_gen / shot1_video）为原型克隆 shotN 链：
 *   shotN → shotN_gen → shotN_video → final_cut 全连，
 *   char_view1 / scene_img 参考连接与 shot1_gen 同构。
 * 暴君裁定（2026-09-10）：「垃圾后端没执行好，后端要改」——推翻 08-31 SKILL 的
 *   「agent 手动 add_node 克隆」旧范式，多链展开是后端责任。
 *
 * workflowId（2026-10-08 DSL 读面接通，可选）：传入时主卡（模板实例 + R8 克隆实例）metadata
 * 额外带 workflow_ns/stepId/stepIndex 三键——前端 DSL 反推器只认这三键的节点，模板产线
 * 不带则 dsl 永远空、读面死锁。键写在 content merge 之后（引擎管辖的身分键，不被
 * Deepseek content 覆盖）。衍生卡（tool/note/gate）是辅助卡，一律不带。未传则零行为差异。
 */
export function expandTemplate(
  templateId: string,
  template: {
    id: string
    nodes: DerivableNodeSpec[]
    connections: { fromRole: string; toRole: string }[]
    multiShot?: boolean
  },
  content: TemplateContent,
  workflowId?: string,
): WorkflowGraph {
  // 节点 id → 其模板规格（含 tools/notes/gate 衍生材料；克隆链的规格经 spread 继承原型）
  const specByNodeId = new Map<string, DerivableNodeSpec>()
  // role → 本模板实例生成的节点 id（保序、可多个；主回圈与克隆回圈都在生成处顺手登记）。
  // 这是参考图 post-pass 的**唯一**依据：不从「${templateId}-${role}-${index}」反推 role
  //（role 本身可含 `-`，字串反切不可靠）。衍生卡（tool/note/gate）不登记：它们不是模板实例。
  const nodeIdsByRole = new Map<string, string[]>()
  const registerRoleNode = (role: string, nodeId: string) => {
    const bucket = nodeIdsByRole.get(role)
    if (bucket) bucket.push(nodeId)
    else nodeIdsByRole.set(role, [nodeId])
  }
  const nodes: WorkflowNode[] = template.nodes.map((spec, i) => {
    const filled: Record<string, unknown> = {
      ...(spec.defaults ?? {}),
      ...(content[spec.role] ?? {}),
    }
    // 骨架自述（2026-09-20）：deliverable/gate 是节点自带的产出合同与验收门禁，
    // 与 defaults 同源铺进 metadata——打字路径建骨架时卡片不再只有「(待填:…)」占位。
    // 放在 content 之后：Deepseek 显式改写可覆盖模板预设。
    if (spec.deliverable !== undefined && filled.deliverable === undefined) filled.deliverable = spec.deliverable
    if (spec.gate !== undefined && filled.gate === undefined) filled.gate = spec.gate
    // 2026-09-24：emitsEntity 是模板宣告的**结构化物件**（画布侧实体卡自动落卡标记）。
    // filled 走浅 spread → 节点 metadata 与模板模组层的 defaults 同一个物件参考，而
    // workflow-service 有 `n.metadata.x = …` 的原地改写模式 → 保留键有跨会话污染面。
    // 防御性复制一层（只复制这一键、只在它真的是物件时；其他栏位一行不动）。
    if (filled.emitsEntity && typeof filled.emitsEntity === "object" && !Array.isArray(filled.emitsEntity)) {
      filled.emitsEntity = { ...(filled.emitsEntity as Record<string, unknown>) }
    }
    const nodeId = `${templateId}-${spec.role}-${i}`
    registerRoleNode(spec.role, nodeId)
    // DSL 读面键（2026-10-08）：主卡带 workflow_ns/stepId/stepIndex 供前端反推 dsl。
    // 最后写：身分键由引擎管辖，不让 content 覆盖。workflowId 缺席（旧调用点）→ 不写，零回归。
    if (workflowId) {
      filled.workflow_ns = workflowId
      filled.stepId = sanitizeStepId(`${spec.role}_${i}`)
      filled.stepIndex = i
    }
    return {
      id: nodeId,
      role: spec.role,
      kind: spec.kind,
      title: spec.title,
      metadata: filled,
    }
  })
  for (const [i, spec] of template.nodes.entries()) specByNodeId.set(`${templateId}-${spec.role}-${i}`, spec)

  // ── R8 多镜展开：multiShot 模板 + content 带 shot2..N → 克隆 shot1 链 ──
  // 原型 = 模板已定义的 shot1 三件套（text/config/video）。content 只给 shot1
  // 或没给多镜 → 行为与旧版完全一致（零回归）。
  const extraShots = template.multiShot
    ? detectShotRoles(template, content).filter((r) => {
        const n = parseInt(r.slice(4), 10)
        return n >= 2 && !template.nodes.some((spec) => spec.role === r)
      })
    : []
  if (extraShots.length) {
    // 依连线的 fromRole 字串精确定位原型（shot1→shot1_gen→shot1_video→final_cut），
    // 不假设模板阵列顺序。原型缺失（模板没有 shot1 链）→ 静默跳过扩展，回到旧行为。
    const protoGenFrom = template.connections.find((c) => /^shot1$/.test(c.fromRole) && /^shot1_gen$/.test(c.toRole))
    const protoGenTo = template.connections.find((c) => /^shot1_gen$/.test(c.fromRole) && /^shot1_video$/.test(c.toRole))
    const protoVideoTo = template.connections.find((c) => /^shot1_video$/.test(c.fromRole))
    if (protoGenFrom && protoGenTo && protoVideoTo) {
      const specByText = new Map(template.nodes.map((s) => [s.role, s]))
      const protoShot = specByText.get("shot1")
      const protoGen = specByText.get("shot1_gen")
      const protoVideo = specByText.get("shot1_video")
      if (protoShot && protoGen && protoVideo) {
        // 选定「shot1_gen 的非 shot 来源」＝char_view1 / scene_img 参考原型。
        const refFromRoles = template.connections
          .filter((c) => c.toRole === "shot1_gen" && !/^shot1(_gen)?$/.test(c.fromRole))
          .map((c) => c.fromRole)
        for (const shotRole of extraShots) {
          const n = parseInt(shotRole.slice(4), 10)
          const shotSpecs: DerivableNodeSpec[] = [
            { ...protoShot, role: shotRole, title: `镜头 ${n} 脚本` },
            { ...protoGen, role: `${shotRole}_gen`, title: `镜头 ${n} 影片配置` },
            { ...protoVideo, role: `${shotRole}_video`, title: `镜头 ${n} 影片` },
          ]
          for (const spec of shotSpecs) {
            const filled: Record<string, unknown> = {
              ...(spec.defaults ?? {}),
              ...(content[spec.role] ?? {}),
            }
            // 同主循环：克隆链继承原型的 deliverable/gate（spread 已带，content 未覆盖时保底）。
            if (spec.deliverable !== undefined && filled.deliverable === undefined) filled.deliverable = spec.deliverable
            if (spec.gate !== undefined && filled.gate === undefined) filled.gate = spec.gate
            // 同主循环：克隆链的 emitsEntity 也不得与模板模块层共用同一物件参考。
            if (filled.emitsEntity && typeof filled.emitsEntity === "object" && !Array.isArray(filled.emitsEntity)) {
              filled.emitsEntity = { ...(filled.emitsEntity as Record<string, unknown>) }
            }
            const nodeId = `${templateId}-${spec.role}-${nodes.length}`
            // 同主回圈：克隆节点也登记 role→nodeId（参考图 post-pass 会看到同名 role 的多个实例）
            registerRoleNode(spec.role, nodeId)
            // 同主回圈：DSL 读面键——克隆 spec 不在 template.nodes 里没有模板下标，
            // 序号取节点产出序（= nodeId 后缀），保「stepId 后缀与节点 id 后缀一致」。
            if (workflowId) {
              const nodeSeq = nodes.length
              filled.workflow_ns = workflowId
              filled.stepId = sanitizeStepId(`${spec.role}_${nodeSeq}`)
              filled.stepIndex = nodeSeq
            }
            // 同主回圈：克隆节点也登记规格——tools/notes/gate 经 spread 从原型继承，供衍生卡展开。
            specByNodeId.set(nodeId, spec)
            nodes.push({
              id: nodeId,
              role: spec.role,
              kind: spec.kind,
              title: spec.title,
              metadata: filled,
            })
          }
        }
        // 扩展连线（在 byRole 构建后追加——见下方合并逻辑）
        ;(template as { __r8ExtraConnections?: { fromRole: string; toRole: string }[] }).__r8ExtraConnections =
          extraShots.flatMap((shotRole) => [
            { fromRole: shotRole, toRole: `${shotRole}_gen` },
            ...refFromRoles.map((r) => ({ fromRole: r, toRole: `${shotRole}_gen` })),
            { fromRole: `${shotRole}_gen`, toRole: `${shotRole}_video` },
            { fromRole: `${shotRole}_video`, toRole: protoVideoTo.toRole },
          ])
      }
    }
  }

  // ── 衍生卡展开（2026-09-20 spec A）：tools/notes/gate 自动生成子卡 ──
  // 打字路径骨架原来只有主节点卡（点卡片路径却有 101 张富卡），这里把模板节点
  // 自带的工具链/配方/门禁材料展开成画布子卡，两条铺轨路径的卡片密度对齐。
  // 顺序铁律：必须跑在 R8 克隆之后（克隆节点经 spread 继承原型的 tools/notes/gate，
  // 也要展开）、连线解析之前（衍生连线直接按节点 id 生成，不走 fromRole 解析）。
  // 衍生卡 id 用 nodes.length 递增保唯一（主节点/克隆节点/衍生卡三源不撞）。
  //
  // 09-21 消除穿透连线（暴君「线也很乱」修复）：
  // 每一行按工序从左向右相邻单向串联（主节点 → 工具卡1 → 工具卡2 → 配方卡 → 门禁卡），
  // 彻底消除所有卡片背后反覆横穿、互相重叠的「千层饼穿透线」。
  const derivedConns: WorkflowConnection[] = []
  for (const n of [...nodes]) {
    const spec = specByNodeId.get(n.id)
    if (!spec) continue
    let prevId = n.id
    // 工具卡：主节点/前序卡 → 工具卡（顺序流水线，不反折回连）
    if (spec.tools) {
      spec.tools.forEach((tool, ti) => {
        const id = `${templateId}-${n.role}__tool_${ti}-${nodes.length}`
        nodes.push({
          id,
          role: `${n.role}__tool_${ti}`,
          kind: "text",
          title: tool.id,
          metadata: {
            pipelineCard: "tool",
            toolId: tool.id,
            toolInput: tool.input,
            toolOutput: tool.output,
            unsupported: tool.unsupported,
            requiredCapability: tool.requiredCapability,
          },
        })
        derivedConns.push({ from: prevId, to: id })
        prevId = id
      })
    }
    // 配方笔记卡：紧随工具卡后顺序串联
    if (spec.notes) {
      spec.notes.forEach((note, ni) => {
        const id = `${templateId}-${n.role}__note_${ni}-${nodes.length}`
        nodes.push({
          id,
          role: `${n.role}__note_${ni}`,
          kind: "text",
          title: "配方",
          metadata: { pipelineCard: "note", content: note },
        })
        derivedConns.push({ from: prevId, to: id })
        prevId = id
      })
    }
    // 门禁卡：位于本行流水线末端验收
    const gateText = typeof n.metadata.gate === "string" ? n.metadata.gate : spec.gate
    if (gateText !== undefined) {
      const id = `${templateId}-${n.role}__gate-${nodes.length}`
      nodes.push({
        id,
        role: `${n.role}__gate`,
        kind: "text",
        title: "门禁",
        metadata: { pipelineCard: "gate", content: gateText },
      })
      derivedConns.push({ from: prevId, to: id })
      prevId = id
    }
  }

  // ── 参考图 post-pass（2026-09-24 四视图聚合）──
  // 模板作者在 `emitsEntity.referenceRoles` 宣告「哪些 role 的交付物是本实体的参考图」
  // （如 character_sheet 的 view2/view3/view4）；这里把它解成**本次展开真正的节点 id**
  // 写进 `emitsEntity.referenceNodeIds`——画布侧据此把四视角收进同一张实体卡。
  //
  // 判定来源＝展开时登记的 role→nodeId（零猜测）。multiShot 同名 role 有多个实例 → 全部纳入
  //（去重、保序）。找不到该 role → **不写该键、不报错**（作者写错 role 不该让整个模板炸）。
  // 写入一律进**复制后的新物件**：`emitsEntity` 与模板模组层的 `defaults.emitsEntity`
  // 是不同物件（上面已防御性浅复制），原地写 referenceNodeIds 会跨会话串味。
  for (const n of nodes) {
    const declaration = n.metadata.emitsEntity
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) continue
    const roles = (declaration as Record<string, unknown>).referenceRoles
    if (!Array.isArray(roles) || roles.length === 0) continue
    const ids: string[] = []
    for (const role of roles) {
      if (typeof role !== "string" || !role) continue
      for (const id of nodeIdsByRole.get(role) ?? []) {
        if (!ids.includes(id)) ids.push(id)
      }
    }
    // 一个 role 都没命中 → 不写这一键（保持模板宣告原样，不回空阵列假装解析过）。
    if (!ids.length) continue
    n.metadata.emitsEntity = { ...(declaration as Record<string, unknown>), referenceNodeIds: ids }
  }

  const byRole = new Map(nodes.map((n) => [n.role, n]))
  // R8：多链扩展连线与模板连线合并后一次性解析（非模板 role 的 content keys 不解析，
  // 与旧版 from&&to null 过滤行为一致）
  const extraConns = ((template as { __r8ExtraConnections?: { fromRole: string; toRole: string }[] }).__r8ExtraConnections ?? []) as {
    fromRole: string
    toRole: string
  }[]
  const connections: WorkflowConnection[] = [...template.connections, ...extraConns]
    .map((c) => {
      const from = byRole.get(c.fromRole)
      const to = byRole.get(c.toRole)
      return from && to ? { from: from.id, to: to.id } : null
    })
    .filter((c): c is WorkflowConnection => c !== null)
  // 衍生卡连线按节点 id 直连（不走 fromRole 解析），与模板/R8 连线合并返回。
  return { nodes, connections: [...connections, ...derivedConns] }
}

/**
 * 依赖排序（topological sort）。
 * 回 { order: nodeIds[], cycle?: string[] }。cycle 非空 = 有循环，需回报 Deepseek 修正。
 */
export function topologicalSort(graph: WorkflowGraph): { order: string[]; cycle: string[] } {
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of graph.nodes) {
    inDegree.set(n.id, 0)
    adj.set(n.id, [])
  }
  for (const c of graph.connections) {
    adj.get(c.from)?.push(c.to)
    inDegree.set(c.to, (inDegree.get(c.to) ?? 0) + 1)
  }
  const queue: string[] = []
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  const visited = new Set(order)
  const cycle = graph.nodes.filter((n) => !visited.has(n.id)).map((n) => n.id)
  return { order, cycle }
}

/** 依执行序取「已准备好」的 image/video 节点：所有上游都完成。text/config 永远不入（纯资料）。 */
export function readyNodes(graph: WorkflowGraph, done: Set<string>): WorkflowNode[] {
  const upstreamCount = new Map<string, number>()
  const upstreamDone = new Map<string, number>()
  for (const n of graph.nodes) {
    upstreamCount.set(n.id, 0)
    upstreamDone.set(n.id, 0)
  }
  for (const c of graph.connections) {
    upstreamCount.set(c.to, (upstreamCount.get(c.to) ?? 0) + 1)
  }
  for (const c of graph.connections) {
    if (done.has(c.from)) upstreamDone.set(c.to, (upstreamDone.get(c.to) ?? 0) + 1)
  }
  return graph.nodes.filter((n) => {
    if (n.kind !== "image" && n.kind !== "video" && n.kind !== "audio" && n.kind !== "film") return false
    if (done.has(n.id)) return false
    const total = upstreamCount.get(n.id) ?? 0
    return (upstreamDone.get(n.id) ?? 0) >= total
  })
}

/** 节点执行结果：成功（带 content url/cost）或失败。 */
export interface WorkflowNodeResult {
  nodeId: string
  ok: boolean
  content?: string
  costCoins?: number
  error?: string
}

/** 节点流状态：给前端/Deepseek 查询用的投影。 */
export interface WorkflowRunState {
  workflowId: string
  templateId: string
  nodes: { id: string; role: string; kind: string; title: string; status: string; content?: string; costCoins?: number; error?: string }[]
  connections: WorkflowConnection[]
  status: "queued" | "running" | "success" | "partial" | "failed"
}
