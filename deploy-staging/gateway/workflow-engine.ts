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

/**
 * 展開模板：把模板節點實例化成具體節點。
 * role 出現在 contentOverrides 時，merge 進 metadata（Deepseek 的 prompt/model 等）。
 * multiShot 模板：可由 Deepseek 透過 add_node 追加同 role 的新實例（id 加 -N 後綴）。
 *
 * R8（2026-09-10）：multiShot 模板 + content 含 shotN（N≥2）時自動展開 N 條鏈——
 * 以模板 shot1 鏈（shot1 / shot1_gen / shot1_video）為原型克隆 shotN 鏈：
 *   shotN → shotN_gen → shotN_video → final_cut 全連，
 *   char_view1 / scene_img 參考連接與 shot1_gen 同構。
 * 暴君裁定（2026-09-10）：「垃圾後端沒執行好，後端要改」——推翻 08-31 SKILL 的
 * 「agent 手動 add_node 克隆」舊範式，多鏈展開是後端責任。
 */
export function expandTemplate(
  templateId: string,
  template: {
    id: string
    nodes: { role: string; kind: WorkflowNodeKind; title: string; defaults?: Record<string, unknown> }[]
    connections: { fromRole: string; toRole: string }[]
    multiShot?: boolean
  },
  content: TemplateContent,
): WorkflowGraph {
  const nodes: WorkflowNode[] = template.nodes.map((spec, i) => {
    const filled: Record<string, unknown> = {
      ...(spec.defaults ?? {}),
      ...(content[spec.role] ?? {}),
    }
    return {
      id: `${templateId}-${spec.role}-${i}`,
      role: spec.role,
      kind: spec.kind,
      title: spec.title,
      metadata: filled,
    }
  })

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
          const shotSpecs: { role: string; kind: WorkflowNodeKind; title: string; defaults?: Record<string, unknown> }[] = [
            { ...protoShot, role: shotRole, title: `镜头 ${n} 脚本` },
            { ...protoGen, role: `${shotRole}_gen`, title: `镜头 ${n} 影片配置` },
            { ...protoVideo, role: `${shotRole}_video`, title: `镜头 ${n} 影片` },
          ]
          for (const spec of shotSpecs) {
            const filled: Record<string, unknown> = {
              ...(spec.defaults ?? {}),
              ...(content[spec.role] ?? {}),
            }
            nodes.push({
              id: `${templateId}-${spec.role}-${nodes.length}`,
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
  return { nodes, connections }
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
