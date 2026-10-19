// workflow-dsl/decompile.ts — 画布真相 → DSL 源码的反向读取器（compileWorkflow 的逆操作）。
//
// 角色（项目负责人裁定 2026-09-02）：画布图为唯一运行时真相；本档按节点 metadata 的
// workflow 运行期键（compile.ts 铺的 workflow_ns/stepId/stepIndex）把画布分组反推回
// WorkflowDslSource，供 agent「看图改源码」或 round-trip 校验。
//
// 反推规则：
//   1. 分组键 = metadata.workflow_ns；缺 workflow_ns 但有 workflow_id → 卫生化后采用；
//      两者皆无 → 跳过该节点。缺 metadata.stepId 的节点跳过。
//   2. steps 按 metadata.stepIndex 排序（缺省沉底，按 stepId 定序保证确定性）。
//   3. needs 从组内节点间连线反推（fromNodeId 节点的 stepId 为依赖）。
//   4. model/size/count/prompt/gate/toolId/kind 反向读出；meta 透传 = metadata 减去
//      白名单栏位后的剩余（浅拷贝）。
//   5. 目标：对 DSL 编译产物 decompile 后再 compile → 全部 update_node、零新增连线
//      （round-trip 幂等，workflow-dsl.test.ts 案⑤把关）。
//   6. 输出前合法性保证（2026-10-09）：反推器吐出的 dsl 必须能过 compile 的 schema——
//      即「读到的 dsl 原样交回必须成功」。step 级违规值降级（能无损透传就挪进 meta、其次
//      截断、最后丢该步）；source 级超 steps 上限则**整份不输出**（读面不得说谎），
//      见 enforceCompileValidity；只对违规值动手，合法值逐字节不变。
//
// 四族收纳规则（2026-10-08 读面解锁，记忆 dsl-adoption-zero-audit：读面死锁根因；
// 2026-10-09 补族4 扩面——项目负责人裁定「收编从靠模型自觉 → 系统默认给骨架」）：
//   画布上真实存在四族产线节点，仅族3 带 workflow_ns+stepId 真键——本档按族收纳：
//   - 族3（编译器产物，id wf-<16hex>）：workflow_ns+stepId 真键，走上述既有规则。
//   - 族1（gateway 骨架，id 如 single_image-prompt-0）：metadata 无任何身份键，
//     但连线 id 为 wf-<workflowId>-<fromNodeId>-<toNodeId>（workflowId 无连字符）——
//     按「出现在 wf- 前缀连线两端」归属：ns 从连线 id 提取，stepId = node.id 卫生化。
//   - 族2（前端模板卡，id 如 tpl-<ts36>-s<i>-<key>）：带 workflow_id=template.id，
//     生成卡另有 stepIndex——按 workflow_id+stepIndex 收纳（stepId=step_<i>），
//     辅助卡（head/tool/gate 带 pipelineCard 键）刻意排除。
//   - 族4（存量画布「生成单元」，2026-10-09）：id 形如 cu_<12hex>-text|-config，
//     metadata **无任何产线身份键**（硬条件，与族1/2/3 互斥）——本族收两类节点：
//       ① 生成配置节点：type=config 且 metadata.model 非空，**且完全没有任何身份键**
//          （stepId / workflow_ns / workflow_id+stepIndex / pipelineCard / 出现在 wf-
//          连线两端，任一命中即排除）；
//       ② 提示词节点：type=text|prompt、metadata.content 非空，且**存在一条连线指向
//          族4 生成配置节点**（即它的下游生成器本身没有产线身份键）。
//     「提示词节点下游必须也是族4 配置节点」是刻意收窄：避免把模板画布上连到模板卡的
//     备忘文字算成步骤，也避免把一个生成单元劈到两个 workflow。
//     ns = 画布级 namespace（context.namespace，缺省倒退「全画布节点 id 升序第一者」并
//     卫生化；卫生化失败 ⇒ 整族跳过）；stepId = node.id 卫生化。族4 步骤另按节点 position
//     定序（见下方 _stepIndex），让 DSL 步骤顺序＝画布视觉顺序。
//   每个收纳 step 的 meta 塞运输键 _origin_node_id = node.id，供 compile.ts 收编
//   第三路把 DSL 回写原节点（键回填 workflow_ns/stepId 后存量节点从此族3化）。

import { CanvasNodeType, type CanvasConnection, type CanvasNode } from "../canvas/types";
import {
  META_MAX_BYTES,
  SIZE_PATTERN,
  STEP_ID_PATTERN,
  WORKFLOW_NS_PATTERN,
  WORKFLOW_STEPS_MAX,
  WORKFLOW_STEPS_MIN,
  type WorkflowDslSource,
  type WorkflowDslStep,
} from "./schema";
import { HARNESS_TOOL_IDS } from "../harness-tool-ids";
import { workflowNodeId, type WorkflowNodeMetadata } from "./compile";

/** schema 接受的 kind 值域（schema.ts 的 STEP_KINDS 未导出，此处按契约镜像）。 */
const STEP_KINDS = new Set(["image", "text", "video", "audio", "director"]);

/** compile 铺进 metadata 的白名单栏位（decompile 读取后从 meta 透传中扣除）。 */
const METADATA_WHITELIST_KEYS = new Set([
  "prompt",
  "content",
  "kind",
  "model",
  "size",
  "count",
  "gate",
  "toolId",
  "workflow_id",
  "workflow_ns",
  "stepId",
  "stepIndex",
  "status",
]);

/** 卫生化命名空间：小写、非法字符换 _、首字符非 [a-z] 补 wf_ 前缀、截 48；清完为空回 null（丢弃）。 */
function sanitizeWorkflowNs(raw: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 48);
  if (cleaned.length === 0) return null;
  if (WORKFLOW_NS_PATTERN.test(cleaned)) return cleaned;
  // 首字符非 [a-z]：补 wf_ 前缀（前缀后仍须 ≤48，故原串截 45）。
  return `wf_${cleaned.slice(0, 45)}`;
}

/**
 * 卫生化 stepId（族1 用：node.id 直接当步骤符号名）：非法字符换 _、首字符非 [a-z]
 * 补 s_ 前缀、截 48，保证过 STEP_ID_PATTERN（^[a-z][a-z0-9_]{0,47}$）；清完为空回 null。
 */
function sanitizeStepId(raw: string): string | null {
  const cleaned = raw.replace(/[^a-z0-9_]+/g, "_").slice(0, 48);
  if (cleaned.length === 0) return null;
  if (STEP_ID_PATTERN.test(cleaned)) return cleaned;
  // 首字符非 [a-z]（数字/_ 开头）：补 s_ 前缀（前缀后仍须 ≤48，故原串截 46）。
  return `s_${cleaned.slice(0, 46)}`;
}

/**
 * 族1 归属索引：node id → 从 wf- 前缀连线 id 提取的 workflowId（连线 id 格式
 * wf-<workflowId>-<fromNodeId>-<toNodeId>，workflowId 无连字符）。同一节点的多条
 * wf- 连线不一致时取数组序第一条；同一条 wf- 连线两端节点取同一 ns。
 */
function buildWfNsByNodeId(connections: CanvasConnection[]): Map<string, string> {
  const wfNsByNodeId = new Map<string, string>();
  for (const conn of connections) {
    if (!conn.id.startsWith("wf-")) continue;
    const rest = conn.id.slice("wf-".length);
    const dash = rest.indexOf("-");
    const rawNs = dash === -1 ? rest : rest.slice(0, dash);
    const ns = sanitizeWorkflowNs(rawNs);
    if (ns === null) continue;
    if (!wfNsByNodeId.has(conn.fromNodeId)) wfNsByNodeId.set(conn.fromNodeId, ns);
    if (!wfNsByNodeId.has(conn.toNodeId)) wfNsByNodeId.set(conn.toNodeId, ns);
  }
  return wfNsByNodeId;
}

/** 读节点 metadata 为宽松键值（CanvasNodeMetadata 无索引签名，借 WorkflowNodeMetadata 桥接）。 */
function asLooseMetadata(md: CanvasNode["metadata"]): WorkflowNodeMetadata {
  return (md ?? {}) as WorkflowNodeMetadata;
}

function nodeTypeToKind(type: CanvasNode["type"]): WorkflowDslStep["kind"] {
  switch (type) {
    case CanvasNodeType.Text:
      return "text";
    case CanvasNodeType.Video:
      return "video";
    case CanvasNodeType.Audio:
      return "audio";
    default:
      return "image";
  }
}

/** meta 序列化字节数（不可序列化回 Infinity，对齐 schema.ts 的 meta 校验语义）。 */
function metaBytes(meta: Record<string, unknown>): number {
  try {
    return new TextEncoder().encode(JSON.stringify(meta)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** 单步是否过 schema 的 validateStep（id/title/kind/prompt/needs/model/size/count/gate/tool/meta）。 */
function isStepSchemaValid(step: WorkflowDslStep): boolean {
  if (typeof step.id !== "string" || !STEP_ID_PATTERN.test(step.id)) return false;
  if (typeof step.title !== "string" || step.title.length < 1 || step.title.length > 40) return false;
  if (step.kind !== undefined && !STEP_KINDS.has(step.kind)) return false;
  if (step.prompt !== undefined && (typeof step.prompt !== "string" || step.prompt.length > 4000)) return false;
  if (step.needs !== undefined && (!Array.isArray(step.needs) || step.needs.some((d) => typeof d !== "string" || d.length === 0))) return false;
  if (step.model !== undefined && typeof step.model !== "string") return false;
  if (step.size !== undefined && (typeof step.size !== "string" || !SIZE_PATTERN.test(step.size))) return false;
  if (step.count !== undefined && !(typeof step.count === "number" && Number.isInteger(step.count) && step.count >= 1 && step.count <= 8)) return false;
  if (step.gate !== undefined && typeof step.gate !== "boolean") return false;
  if (step.tool !== undefined && (typeof step.tool !== "string" || step.tool.length === 0)) return false;
  if (step.meta !== undefined) {
    if (typeof step.meta !== "object" || step.meta === null || Array.isArray(step.meta)) return false;
    try {
      if (JSON.stringify(step.meta).length > META_MAX_BYTES) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 输出前合法性保证（2026-10-09，对所有族生效）：核心承诺是「读到的 dsl 原样交回必须成功」，
 * 故反推器吐出的每个 step 都必须能过 compile 的 schema（schema.ts）+ 编译期校验（compile.ts）。
 * 降级原则：**能无损透传就透传、透传不了才截断、仍不合法才丢该步**。只对**违规值**动手，
 * 合法值逐字节不变（保族1/2/3 的 round-trip 幂等）。
 *
 * source 级：steps 数超 WORKFLOW_STEPS_MAX ⇒ **整份 source 不输出**（不截断、不谎报骨架）。
 *
 * 无损手段＝把无法表达的合法载荷挪进 meta：buildStepMetadata 最后写 meta 透传，会原样
 * 写回该节点 metadata，故值不丢（例：size 挪 meta ⇒ compile 写回 md.size 仍是原值）。
 * nodeById 供 title 兜底（node.title 前 40 字元）。
 */
function enforceCompileValidity(sources: WorkflowDslSource[], nodeById: Map<string, CanvasNode>): WorkflowDslSource[] {
  const out: WorkflowDslSource[] = [];
  for (const source of sources) {
    const steps: WorkflowDslStep[] = [];
    for (const step of source.steps) {
      // 1. size 不匹配 ^\d+x\d+$ → 原值挪 meta.size、删 step.size（无损：compile 写回 md.size）。
      if (step.size !== undefined && (typeof step.size !== "string" || !SIZE_PATTERN.test(step.size))) {
        step.meta = { ...(step.meta ?? {}), size: step.size };
        delete step.size;
      }
      // 2. count 非 1..8 整数 → 原值挪 meta.count、删 step.count（无损：compile 写回 md.count）。
      if (step.count !== undefined && !(typeof step.count === "number" && Number.isInteger(step.count) && step.count >= 1 && step.count <= 8)) {
        step.meta = { ...(step.meta ?? {}), count: step.count };
        delete step.count;
      }
      // 3. tool 不在 harness 清单 → 原值挪 meta.toolId、删 step.tool（无损：compile 写 md.toolId，同一目标）。
      if (step.tool !== undefined && !HARNESS_TOOL_IDS.has(step.tool)) {
        step.meta = { ...(step.meta ?? {}), toolId: step.tool };
        delete step.tool;
      }
      // 4. title 非 1..40 → 用 node.title 前 40 字元；仍空则用 stepId。
      if (typeof step.title !== "string" || step.title.length < 1 || step.title.length > 40) {
        const origin = step.meta?._origin_node_id;
        const nodeTitle = typeof origin === "string" ? nodeById.get(origin)?.title : undefined;
        const fallback = typeof nodeTitle === "string" ? nodeTitle.slice(0, 40) : "";
        step.title = fallback.length > 0 ? fallback : step.id.slice(0, 40);
      }
      // 5. prompt > 4000 → 截断（真资料未触发；截断无「无损」替代，如实回报）。
      if (typeof step.prompt === "string" && step.prompt.length > 4000) step.prompt = step.prompt.slice(0, 4000);
      // 6. meta 序列化 > 4096 → 按键插入序丢弃非 _origin_node_id 键直到 ≤ META_MAX_BYTES。
      if (step.meta !== undefined && metaBytes(step.meta) > META_MAX_BYTES) {
        for (const key of Object.keys(step.meta)) {
          if (key === "_origin_node_id") continue;
          if (metaBytes(step.meta) <= META_MAX_BYTES) break;
          delete step.meta[key];
        }
      }
      // 防御：跑完仍不合法 → 丢弃该步（不虚构、不带非法值出闸）。
      if (isStepSchemaValid(step)) steps.push(step);
    }
    // GAP A 镜像（2026-10-12）：compile 的 validateGraph 会拒绝「某步 meta._origin_node_id 恰好
    // 等于另一步的确定性节点 id」的 DSL（两步共写同一画布节点 ⇒ 静默覆盖）。反推器若吐出这种
    // 来源键，「读到的 dsl 原样交回必须成功」的承诺就会整份 ok:false 破裂。此处镜像该闸：只对
    // 存活步骤建立确定性 id 集（workflowNodeId(source.workflow, step.id)），撞到**兄弟步**的
    // 确定性 id 即删本步 _origin_node_id（compile 收编第三路 fallback 到 add_node，步骤不丢）；
    // 撞自己的确定性 id（族3 decompile→compile 原样带回）合法，保留。放在降级循环之后，与
    // compile 只看存活步骤的口径一致，也不干扰 title 兜底（其亦读 _origin_node_id）。
    const detIdOwner = new Map<string, string>();
    for (const step of steps) detIdOwner.set(workflowNodeId(source.workflow, step.id), step.id);
    for (const step of steps) {
      const meta = step.meta;
      if (meta === undefined) continue;
      const origin = meta._origin_node_id;
      if (typeof origin !== "string" || origin.length === 0) continue;
      const owner = detIdOwner.get(origin);
      if (owner !== undefined && owner !== step.id) delete meta._origin_node_id;
    }
    // source 级：steps 数须为 WORKFLOW_STEPS_MIN..WORKFLOW_STEPS_MAX。超上限 ⇒ **整份 source
    // 不输出**（诚实缺省，2026-10-09 裁定）：截断会把「读到的就是权威骨架」变成假话，且回写
    // 时被删步会以「步骤已从源码移除」警告出现，诱导 agent 去补步、可能造出平行节点。宁可让
    // agent 用 canvas_apply_ops 逐节点改，也不给一份不完整却被当成权威的声明。
    if (steps.length >= WORKFLOW_STEPS_MIN && steps.length <= WORKFLOW_STEPS_MAX) {
      out.push({ ...source, steps });
    }
  }
  return out;
}

interface GroupAccumulator {
  workflow: string;
  /** stepId → 反推中的 step（保插入序，输出前再按 stepIndex 排序）。 */
  steps: Map<string, WorkflowDslStep & { _stepIndex?: number | null; _family4?: boolean }>;
  /** stepId → 节点 id（连线反推用）。 */
  nodeIds: Map<string, string>;
}

/**
 * 画布当前真相 → DSL 源码清单（每个 workflow 命名空间一份）。
 * 只读 current；非产线节点（结果图／参考图／群组／导演台／场景卡／孤立备忘文字）一律
 * 跳过，不虚构步骤。
 */
export function decompileWorkflow(
  current: { nodes: CanvasNode[]; connections: CanvasConnection[] },
  context?: { namespace?: string },
): WorkflowDslSource[] {
  const groups = new Map<string, GroupAccumulator>();
  // 族1 归属索引（wf- 前缀连线 → 两端节点的 ns），先于节点扫描建好。
  const wfNsByNodeId = buildWfNsByNodeId(current.connections);

  // 族4 归属预扫描（2026-10-09）：生成配置节点＝config 且 model 非空，**且完全没有任何
  // 产线身份键**（与族1/2/3 互斥）：stepId / workflow_ns / workflow_id+stepIndex /
  // pipelineCard / 出现在 wf- 连线两端（族1 归属），任一命中即排除——否则模板卡的配置
  // 节点会被同时算作族4，连到它的备忘 text 被误收成步骤、单元被劈到两个 workflow。
  const family4ConfigNodeIds = new Set<string>();
  for (const node of current.nodes) {
    if (node.type !== CanvasNodeType.Config) continue;
    const md = asLooseMetadata(node.metadata);
    if (typeof md.model !== "string" || md.model.trim() === "") continue;
    const hasStepId = typeof md.stepId === "string" && md.stepId.length > 0;
    const hasNs = typeof md.workflow_ns === "string" && md.workflow_ns.length > 0;
    const hasTemplateCard =
      typeof md.workflow_id === "string" &&
      md.workflow_id.length > 0 &&
      typeof md.stepIndex === "number" &&
      Number.isFinite(md.stepIndex);
    const hasPipelineCard = "pipelineCard" in md;
    const hasWfConn = wfNsByNodeId.has(node.id);
    if (hasStepId || hasNs || hasTemplateCard || hasPipelineCard || hasWfConn) continue;
    family4ConfigNodeIds.add(node.id);
  }
  // 提示词节点候选＝存在一条连线指向族4 配置节点（「下游必须也是族4 配置节点」的刻意收窄）。
  const family4PromptNodeIds = new Set<string>();
  for (const conn of current.connections) {
    if (family4ConfigNodeIds.has(conn.toNodeId)) family4PromptNodeIds.add(conn.fromNodeId);
  }
  // 族4 的 ns＝画布级 namespace：context.namespace 优先；缺省倒退「全画布节点 id 升序第一个」
  // （确定性、不抛错）。卫生化失败（null）⇒ 族4 整族跳过，行为等同现状。
  const fallbackNsNodeId = current.nodes.map((n) => n.id).sort()[0] ?? "";
  const family4Ns = sanitizeWorkflowNs(context?.namespace ?? fallbackNsNodeId);
  // 族4 步骤排序表：按节点 position 定序（y→x→id 升序），序数从 0 起写进 _stepIndex。
  const family4Order: { workflow: string; stepId: string; y: number; x: number; nodeId: string }[] = [];

  for (const node of current.nodes) {
    const md = asLooseMetadata(node.metadata);
    const mdStepId = typeof md.stepId === "string" && md.stepId.length > 0 ? md.stepId : undefined;

    // 族4 候选（2026-10-09）：生成配置节点 / 提示词节点（下游是族4 配置节点）。
    const isFamily4Config = family4ConfigNodeIds.has(node.id);
    const isFamily4Prompt =
      (node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Prompt) &&
      typeof md.content === "string" &&
      md.content.trim() !== "" &&
      family4PromptNodeIds.has(node.id);

    let workflow: string | null = null;
    let stepId: string | undefined = mdStepId;
    if (mdStepId !== undefined) {
      // 族3 真键（或已收编回填键）：既有规则不动。
      if (typeof md.workflow_ns === "string" && md.workflow_ns.length > 0) {
        workflow = sanitizeWorkflowNs(md.workflow_ns);
      } else if (typeof md.workflow_id === "string" && md.workflow_id.length > 0) {
        workflow = sanitizeWorkflowNs(md.workflow_id); // 缺 workflow_ns 但有 workflow_id → 卫生化后采用
      }
    } else if (
      typeof md.workflow_id === "string" &&
      md.workflow_id.length > 0 &&
      typeof md.stepIndex === "number" &&
      Number.isFinite(md.stepIndex) &&
      !("pipelineCard" in md)
    ) {
      // 族2 存量（前端模板生成卡）：workflow_id+stepIndex 收纳，辅助卡（pipelineCard）刻意排除。
      workflow = sanitizeWorkflowNs(md.workflow_id);
      stepId = `step_${md.stepIndex}`;
    } else if (wfNsByNodeId.has(node.id)) {
      // 族1 存量（gateway 骨架）：出现在 wf- 前缀连线两端 → 按连线归属，node.id 卫生化为 stepId。
      workflow = wfNsByNodeId.get(node.id)!;
      stepId = sanitizeStepId(node.id) ?? undefined;
    } else if (family4Ns !== null && (isFamily4Config || isFamily4Prompt)) {
      // 族4 fallback（2026-10-09）：存量画布「生成单元」无任何产线身份键——ns 取画布级
      // namespace，stepId = node.id 卫生化（卫生化失败照旧跳过）。此分支在族链最后，
      // 只有前三族都没命中时才走。
      workflow = family4Ns;
      stepId = sanitizeStepId(node.id) ?? undefined;
    }
    if (workflow === null || stepId === undefined) continue; // 无任何族归属 → 跳过该节点

    let group = groups.get(workflow);
    if (!group) {
      group = { workflow, steps: new Map(), nodeIds: new Map() };
      groups.set(workflow, group);
    }
    group.nodeIds.set(stepId, node.id);
    if (!group.steps.has(stepId)) {
      const step: WorkflowDslStep & { _stepIndex?: number | null; _family4?: boolean } = {
        id: stepId,
        title: typeof node.title === "string" && node.title.length > 0 ? node.title : stepId,
        _stepIndex: typeof md.stepIndex === "number" && Number.isFinite(md.stepIndex) ? md.stepIndex : null,
      };
      step.kind = nodeTypeToKind(node.type); // 未知型别退 "image"（同 layout.ts toNodeType 的降级哲学）
      // 族4 兼容：config 节点 metadata.kind 已承载 image/video 生成意图，而
      // nodeTypeToKind(Config) 一律降级为 "image"——故族4 config 步按 md.kind 覆写
      // （仅 video 需覆写；image 与降级结果相同，不重复写）。
      if (isFamily4Config && md.kind === "video") step.kind = "video";
      if (typeof md.prompt === "string") step.prompt = md.prompt;
      else if (step.kind === "text" && typeof md.content === "string") step.prompt = md.content; // 族1 prompt 兜底：text 类节点正文当提示词
      if (typeof md.model === "string") step.model = md.model;
      if (typeof md.size === "string") step.size = md.size;
      if (typeof md.count === "number") step.count = md.count;
      if (md.gate === true) step.gate = true;
      if (typeof md.toolId === "string") step.tool = md.toolId;
      // meta 透传 = metadata 减去白名单栏位后的剩余（浅拷贝）。
      const meta: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(md)) {
        if (!METADATA_WHITELIST_KEYS.has(key)) meta[key] = value;
      }
      // 运输键：每个收纳 step 一律携带原节点 id，供 compile.ts 收编第三路回写原节点
      // （此键刻意不进 METADATA_WHITELIST_KEYS——编译侧负责扣下不写入产物 metadata）。
      meta._origin_node_id = node.id;
      step.meta = meta;
      group.steps.set(stepId, step);
      // 族4 步骤登记进排序表（position 定序，见下方扫描后处理）。
      if (isFamily4Config || isFamily4Prompt) {
        step._family4 = true;
        family4Order.push({
          workflow,
          stepId,
          y: node.position.y,
          x: node.position.x,
          nodeId: node.id,
        });
      }
    }
  }

  // 族4 步骤定序：节点 position 升序（y→x→id）→ 序数从 0 起写进 _stepIndex，让 DSL 步骤
  // 顺序＝画布视觉顺序（人看「第 3 张卡」能对上步骤）。只对族4 步骤做，族1/2/3 排序不变
  // （族1/3 的 _stepIndex 仍是 null，族2 仍是模板 stepIndex）。用 position 而非 id 定序的
  // 原因：族4 config/text 节点 id 卫生化后按 id 排会让 config 排到 text 之前（needs 指向上方
  // 步骤），position 才能让「提示词步」稳定排在它的「生成步」前面。
  family4Order.sort((a, b) => a.y - b.y || a.x - b.x || a.nodeId.localeCompare(b.nodeId));
  family4Order.forEach((info, index) => {
    const group = groups.get(info.workflow);
    const step = group?.steps.get(info.stepId);
    if (step?._family4) step._stepIndex = index;
  });

  const sources: WorkflowDslSource[] = [];
  // 全图连线 → 每节点上游清单（needs 传导用，桥接辅助卡不在组内但连线仍可穿）。
  const upstreamByNodeId = new Map<string, string[]>();
  for (const conn of current.connections) {
    const list = upstreamByNodeId.get(conn.toNodeId);
    if (list) list.push(conn.fromNodeId);
    else upstreamByNodeId.set(conn.toNodeId, [conn.fromNodeId]);
  }
  for (const group of groups.values()) {
    // needs 从组内节点间连线反推（上游传导版）：直接 from 节点是同组 step ⇒ 取其 stepId
    // 为依赖（既有行为）；from 节点无 stepId（辅助卡桥接）⇒ 沿连线继续向上游走，直到撞见
    // 同组 step 节点为止。BFS 深度上限 8、visited 防环；找不到就不加 needs。
    const ownerIdByNodeId = new Map<string, string>();
    for (const [stepId, nodeId] of group.nodeIds) ownerIdByNodeId.set(nodeId, stepId);
    for (const [stepId, nodeId] of group.nodeIds) {
      const step = group.steps.get(stepId);
      if (!step) continue;
      const deps: string[] = [];
      const visited = new Set<string>([nodeId]);
      let frontier = (upstreamByNodeId.get(nodeId) ?? []).slice();
      for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
        const next: string[] = [];
        for (const upId of frontier) {
          if (visited.has(upId)) continue;
          visited.add(upId);
          const owner = ownerIdByNodeId.get(upId);
          if (owner !== undefined) {
            if (owner !== stepId && !deps.includes(owner)) deps.push(owner);
            continue; // step 节点是依赖终点，不再穿过它继续上游
          }
          next.push(...(upstreamByNodeId.get(upId) ?? [])); // 桥接节点：继续向上游传导
        }
        frontier = next;
      }
      if (deps.length > 0) step.needs = deps;
    }

    // steps 按 stepIndex 排序（缺省沉底，按 stepId 定序保证确定性）。
    const steps = [...group.steps.values()].sort((a, b) => {
      const ia = a._stepIndex ?? Number.POSITIVE_INFINITY;
      const ib = b._stepIndex ?? Number.POSITIVE_INFINITY;
      return ia !== ib ? ia - ib : a.id.localeCompare(b.id);
    });
    for (const step of steps) {
      delete step._stepIndex;
      delete step._family4;
    }

    sources.push({ workflow: group.workflow, steps });
  }
  // 输出前合法性保证（对所有族生效；详见 enforceCompileValidity 头注）：
  // 「读到的 dsl 原样交回 compile 必须成功」的核心承诺在此兑现。
  const nodeById = new Map(current.nodes.map((n) => [n.id, n]));
  return enforceCompileValidity(sources, nodeById);
}
