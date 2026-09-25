// 畫布工作流引擎核心（Workflow Engine）
//
// 暴君策略 v2：Deepseek 填內容（prompt/model/參數），引擎展開節點流並執行。
// 本檔案 = 純函式核心（展開模板、依賴排序、節點流狀態機），不碰 Bun/gateway，
// 可單測。執行層（呼叫平台 API / emit canvas.* 事件）在 gateway 內對接。
//
// 節點流 = 一組節點 + 連線（與前端 canvas/types 同構，但這裡是引擎執行視角）。

// 2026-08-27 novel_film 8 稏：audio = 配音原語（TTS 上游未接前仍可編排，執行誠實報錯）、
// film = 成片原語（拼接+混音，同上）。前端 canvas/types 已有 Audio 節點型別。
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
  // role → 要 merge 進該節點 metadata 的內容（Deepseek 填的）
  [role: string]: Record<string, unknown>
}

/**
 * R8（2026-09-10 多鏡展開修復）：從 content 抽出 shotN 角色（N≥2）的鏡頭編號清單。
 * 大片模板只定義 shot1 鏈；agent 把 shot1..shot8 全部塞進 content 時，舊版
 * expandTemplate 靜默丟棄 shot2..N → expected_shots=1，agent 被迫手動 add_node
 * 克隆 21 顆節點。這裡把「模板鏈 + content 鏡頭」對齊：content 有 shotN 就展開 N 鏈。
 */
export function detectShotRoles(template: { nodes: { role: string; kind: WorkflowNodeKind }[] }, content: TemplateContent): string[] {
  // 模板中存在的 shot 角色（如 shot1）
  const templateShotRoles = template.nodes.filter((n) => /^shot\d+$/.test(n.role)).map((n) => n.role)
  // content 中出現的 shotN 角色（含模板已定義與 N≥2 新鏡）
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
 * 展開模板：把模板節點實例化成具體節點。
 * role 出現在 contentOverrides 時，merge 進節點 metadata（Deepseek 的 prompt/model 等）。
 * multiShot 模板：可由 Deepseek 透過 add_node 追加同 role 的新實例（id 加 -N 後綴）。
 *
 * R8（2026-09-10）：multiShot 模板 + content 含 shotN（N≥2）時自動展開 N 條鏈——
 * 以模板 shot1 鏈（shot1 / shot1_gen / shot1_video）為原型克隆 shotN 鏈：
 *   shotN → shotN_gen → shotN_video → final_cut 全連，
 *   char_view1 / scene_img 參考連接與 shot1_gen 同構。
 * 暴君裁定（2026-09-10）：「垃圾後端沒執行好，後端要改」——推翻 08-31 SKILL 的
 *   「agent 手動 add_node 克隆」舊範式，多鏈展開是後端責任。
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
): WorkflowGraph {
  // 节点 id → 其模板规格（含 tools/notes/gate 衍生材料；克隆链的规格经 spread 继承原型）
  const specByNodeId = new Map<string, DerivableNodeSpec>()
  // role → 本模板實例生成的節點 id（保序、可多個；主迴圈與克隆迴圈都在生成處順手登記）。
  // 這是參考圖 post-pass 的**唯一**依據：不從「${templateId}-${role}-${index}」反推 role
  //（role 本身可含 `-`，字串反切不可靠）。衍生卡（tool/note/gate）不登記：它們不是模板實例。
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
    // 2026-09-24：emitsEntity 是模板宣告的**結構化物件**（画布侧实体卡自动落卡标记）。
    // filled 走淺 spread → 節點 metadata 與模板模組層的 defaults 同一個物件參考，而
    // workflow-service 有 `n.metadata.x = …` 的原地改寫模式 → 保留鍵有跨會話污染面。
    // 防禦性複製一層（只複製這一鍵、只在它真的是物件時；其他欄位一行不動）。
    if (filled.emitsEntity && typeof filled.emitsEntity === "object" && !Array.isArray(filled.emitsEntity)) {
      filled.emitsEntity = { ...(filled.emitsEntity as Record<string, unknown>) }
    }
    const nodeId = `${templateId}-${spec.role}-${i}`
    registerRoleNode(spec.role, nodeId)
    return {
      id: nodeId,
      role: spec.role,
      kind: spec.kind,
      title: spec.title,
      metadata: filled,
    }
  })
  for (const [i, spec] of template.nodes.entries()) specByNodeId.set(`${templateId}-${spec.role}-${i}`, spec)

  // ── R8 多鏡展開：multiShot 模板 + content 帶 shot2..N → 克隆 shot1 鏈 ──
  // 原型 = 模板已定義的 shot1 三件套（text/config/video）。content 只給 shot1
  // 或沒給多鏡 → 行為與舊版完全一致（零回歸）。
  const extraShots = template.multiShot
    ? detectShotRoles(template, content).filter((r) => {
        const n = parseInt(r.slice(4), 10)
        return n >= 2 && !template.nodes.some((spec) => spec.role === r)
      })
    : []
  if (extraShots.length) {
    // 依連線的 fromRole 字串精確定位原型（shot1→shot1_gen→shot1_video→final_cut），
    // 不假設模板陣列順序。原型缺失（模板沒有 shot1 鏈）→ 靜默跳過擴展，回到舊行為。
    const protoGenFrom = template.connections.find((c) => /^shot1$/.test(c.fromRole) && /^shot1_gen$/.test(c.toRole))
    const protoGenTo = template.connections.find((c) => /^shot1_gen$/.test(c.fromRole) && /^shot1_video$/.test(c.toRole))
    const protoVideoTo = template.connections.find((c) => /^shot1_video$/.test(c.fromRole))
    if (protoGenFrom && protoGenTo && protoVideoTo) {
      const specByText = new Map(template.nodes.map((s) => [s.role, s]))
      const protoShot = specByText.get("shot1")
      const protoGen = specByText.get("shot1_gen")
      const protoVideo = specByText.get("shot1_video")
      if (protoShot && protoGen && protoVideo) {
        // 選定「shot1_gen 的非 shot 來源」＝char_view1 / scene_img 參考原型。
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
            // 同主迴圈：克隆節點也登記 role→nodeId（參考圖 post-pass 會看到同名 role 的多個實例）
            registerRoleNode(spec.role, nodeId)
            // 同主迴圈：克隆节点也登记规格——tools/notes/gate 经 spread 从原型继承，供衍生卡展开。
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
        // 擴展連線（在 byRole 構建後追加——見下方合併邏輯）
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

  // ── 衍生卡展開（2026-09-20 spec A）：tools/notes/gate 自動生成子卡 ──
  // 打字路径骨架原来只有主节点卡（点卡片路径却有 101 张富卡），这里把模板节点
  // 自带的工具链/配方/门禁材料展开成画布子卡，两条铺轨路径的卡片密度对齐。
  // 顺序铁律：必须跑在 R8 克隆之后（克隆节点经 spread 继承原型的 tools/notes/gate，
  // 也要展开）、连线解析之前（衍生连线直接按节点 id 生成，不走 fromRole 解析）。
  // 衍生卡 id 用 nodes.length 递增保唯一（主节点/克隆节点/衍生卡三源不撞）。
  //
  // 09-21 消除穿透連線（暴君「线也很乱」修復）：
  // 每一行按工序從左向右相鄰單向串聯（主節點 → 工具卡1 → 工具卡2 → 配方卡 → 門禁卡），
  // 徹底消除所有卡片背後反覆橫穿、互相重疊的「千層餅穿透線」。
  const derivedConns: WorkflowConnection[] = []
  for (const n of [...nodes]) {
    const spec = specByNodeId.get(n.id)
    if (!spec) continue
    let prevId = n.id
    // 工具卡：主節點/前序卡 → 工具卡（順序流水線，不反折回連）
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
    // 配方筆記卡：緊隨工具卡後順序串聯
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
    // 門禁卡：位於本行流水線末端驗收
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

  // ── 參考圖 post-pass（2026-09-24 四視圖聚合）──
  // 模板作者在 `emitsEntity.referenceRoles` 宣告「哪些 role 的交付物是本實體的參考圖」
  // （如 character_sheet 的 view2/view3/view4）；這裡把它解成**本次展開真正的節點 id**
  // 寫進 `emitsEntity.referenceNodeIds`——畫布側據此把四視角收進同一張實體卡。
  //
  // 判定來源＝展開時登記的 role→nodeId（零猜測）。multiShot 同名 role 有多個實例 → 全部納入
  //（去重、保序）。找不到該 role → **不寫該鍵、不報錯**（作者寫錯 role 不該讓整個模板炸）。
  // 寫入一律進**複製後的新物件**：`emitsEntity` 與模板模組層的 `defaults.emitsEntity`
  // 是不同物件（上面已防禦性淺複製），原地寫 referenceNodeIds 會跨會話串味。
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
    // 一個 role 都沒命中 → 不寫這一鍵（保持模板宣告原樣，不回空陣列假裝解析過）。
    if (!ids.length) continue
    n.metadata.emitsEntity = { ...(declaration as Record<string, unknown>), referenceNodeIds: ids }
  }

  const byRole = new Map(nodes.map((n) => [n.role, n]))
  // R8：多鏈擴展連線與模板連線合併後一次性解析（非模板 role 的 content keys 不解析，
  // 與舊版 from&&to null 過濾行為一致）
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
 * 依賴排序（topological sort）。
 * 回 { order: nodeIds[], cycle?: string[] }。cycle 非空 = 有循環，需回報 Deepseek 修正。
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

/** 依執行序取「已準備好」的 image/video 節點：所有上游都完成。text/config 永遠不入（純資料）。 */
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

/** 節點執行結果：成功（帶 content url/cost）或失敗。 */
export interface WorkflowNodeResult {
  nodeId: string
  ok: boolean
  content?: string
  costCoins?: number
  error?: string
}

/** 節點流狀態：給前端/Deepseek 查詢用的投影。 */
export interface WorkflowRunState {
  workflowId: string
  templateId: string
  nodes: { id: string; role: string; kind: string; title: string; status: string; content?: string; costCoins?: number; error?: string }[]
  connections: WorkflowConnection[]
  status: "queued" | "running" | "success" | "partial" | "failed"
}
