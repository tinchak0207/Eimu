// 记忆库第五类型 `workflow`：从工作站跑批资料**机器抽取**记忆 doc body。
//
// 设计铁律：
// - **不调 LLM**。workflow 记忆的内容就是配置本身（六槽 config JSON），机器抽取
//   比特化、可复现、零幻觉；模型的角色只剩「值不值得进库」的闸门判定（gateway
//   jev-gate.ts `gateWorkflowMemory`）。
// - **不越 2000 上限**（`agent-memory-store.ts` isStructurallyValid 硬线）：
//   超长**截断而非抛错**（抛错 = 这条记忆静默消失，违背「不骗」纪律）。
// - 本档为纯函数 + `import type`，可被 `node --test` 直接 import（零 Next.js 依赖）。

import type { WorkflowRecallConfig } from "./workflow-recall.ts";

/** body 硬上限（`isStructurallyValid`：body.length 1..2000）。 */
export const WORKFLOW_MEMORY_BODY_MAX = 2000;

/** 截断标记（尾端加在可读文本之后；JSON 段自身永不被切半）。 */
export const WORKFLOW_MEMORY_TRUNCATION_MARK = "...";

/** config JSON 段的字符预算：留出头部与 nodes 行的空间。 */
const CONFIG_BUDGET = 1400;

/** nodes 段最多列几个节点。 */
const MAX_NODE_ENTRIES = 40;

/** 单条节点标签字符上限。 */
const NODE_LABEL_MAX = 48;

/** `shouldPersistWorkflow` 判定用：至少几个非空槽位才值得存。 */
export const WORKFLOW_MIN_NON_EMPTY_SLOTS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 非空判定：字符串 trim 后非空 / 数字有限 / 布尔 true / 非空数组 / 非空对象。 */
function isFilledSlot(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return false;
}

/** 非空槽位数（六槽 config 的「实质含量」度量）。 */
export function countWorkflowFilledSlots(config: Record<string, unknown> | undefined | null): number {
  if (!isRecord(config)) return 0;
  let count = 0;
  for (const value of Object.values(config)) {
    if (isFilledSlot(value)) count += 1;
  }
  return count;
}

/**
 * 机器判定这条 workflow 值不值得进记忆库（**不是** Jev 职责）。
 * 规则：`config.prompt` 非空 **且** config 至少有 2 个非空槽位。
 */
export function shouldPersistWorkflow(config: Record<string, unknown> | undefined | null): boolean {
  if (!isRecord(config)) return false;
  if (!isFilledSlot(config.prompt)) return false;
  return countWorkflowFilledSlots(config) >= WORKFLOW_MIN_NON_EMPTY_SLOTS;
}

/** 节点标签：优先 role/title/name，退 id，再退 kind/type；无字串可用则 null。 */
function nodeLabel(node: unknown): string | null {
  if (typeof node === "string") {
    const text = node.trim();
    return text ? text : null;
  }
  if (!isRecord(node)) return null;
  const role = typeof node.role === "string" && node.role.trim() ? node.role.trim() : "";
  const kind =
    (typeof node.kind === "string" && node.kind.trim() ? node.kind.trim() : "") ||
    (typeof node.type === "string" && node.type.trim() ? node.type.trim() : "");
  if (role && kind) return `${role}:${kind}`;
  if (role) return role;
  for (const key of ["title", "name", "id", "label"]) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (kind) return kind;
  return null;
}

function buildNodeLines(dagNodes: unknown[] | undefined, budgetChars: number): string[] {
  if (!Array.isArray(dagNodes) || dagNodes.length === 0 || budgetChars <= 0) return [];
  const lines: string[] = [];
  let used = 0;
  let total = 0;
  for (const node of dagNodes) {
    total += 1;
    if (lines.length >= MAX_NODE_ENTRIES) continue;
    const label = nodeLabel(node);
    if (!label) continue;
    const clipped = label.length > NODE_LABEL_MAX ? `${label.slice(0, NODE_LABEL_MAX - 1)}…` : label;
    const line = clipped.length + 1; // +1 = 换行符
    if (used + line > budgetChars) continue;
    used += line;
    lines.push(clipped);
  }
  if (total === 0) return [];
  // 被砍掉的节点数如实标注（不谎报全量）。
  if (lines.length < total) lines.push(`…(+${total - lines.length} nodes truncated)`);
  return lines;
}

/**
 * 从 workflow 跑批资料机器抽取记忆 doc body（六槽 config JSON 序列化，非自然语言）。
 *
 * 形状：
 * ```
 * [workflow] name=<name>
 * config=<JSON.stringify(config)>
 * nodes=<role:kind> | <role:kind>
 * ```
 * 回传长度**恒 ≤2000**（`isStructurallyValid` 硬上限）；超长时按
 * 「优先保留 config → nodes 按剩余预算逐条裁剪 → 最后才硬截断并加 `...`」的顺序让步，
 * 绝不抛错。
 */
export function extractWorkflowMemoryBody(input: {
  name: string;
  config: Record<string, unknown>;
  dagNodes?: unknown[];
  dagConnections?: unknown[];
}): string {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const config = isRecord(input?.config) ? input.config : {};

  let configJson: string;
  try {
    configJson = JSON.stringify(config) ?? "{}";
  } catch {
    configJson = "{}"; // 循环引用等：如实降级，不抛
  }
  let configTruncated = false;
  if (configJson.length > CONFIG_BUDGET) {
    configJson = configJson.slice(0, CONFIG_BUDGET);
    configTruncated = true;
  }

  const header = `[workflow] name=${name || "(unnamed)"}`;
  // nodes/尾端标记的保留预算：max(剩余空间, 0)
  const reservedForTail =
    WORKFLOW_MEMORY_TRUNCATION_MARK.length + (configTruncated ? `\nconfig_truncated=true`.length : 0);

  const build = (nodeBudget: number): string => {
    const lines = [header, `config=${configJson}`];
    const nodes = buildNodeLines(input?.dagNodes, nodeBudget);
    if (nodes.length) lines.push(`nodes=${nodes.join(" | ")}`);
    return lines.join("\n");
  };

  // dagConnections 只做数量标注（连线细节对「这条跑批值不值得复用」无检索价值）。
  const connectionsCount = Array.isArray(input?.dagConnections) ? input.dagConnections.length : 0;

  let body = build(Math.max(0, WORKFLOW_MEMORY_BODY_MAX - header.length - configJson.length - 8));
  if (configTruncated) body += `\nconfig_truncated=true`;

  if (body.length > WORKFLOW_MEMORY_BODY_MAX) {
    // config 本身吃掉预算：拆掉 nodes 再试。
    body = build(0);
    if (configTruncated) body += `\nconfig_truncated=true`;
  }
  if (connectionsCount > 0 && body.length + `\nconnections=${connectionsCount}`.length <= WORKFLOW_MEMORY_BODY_MAX) {
    body += `\nconnections=${connectionsCount}`;
  }
  if (body.length > WORKFLOW_MEMORY_BODY_MAX) {
    // 最后让步：硬截断，尾端加 `...` 明示不全（长度仍 ≤ 上限）。
    body = `${body.slice(0, WORKFLOW_MEMORY_BODY_MAX - WORKFLOW_MEMORY_TRUNCATION_MARK.length)}${WORKFLOW_MEMORY_TRUNCATION_MARK}`;
  }
  return body;
}

/** 便利：workflow-recall 的六槽 config（弱类型）直接喂入。 */
export function extractWorkflowMemoryBodyFromRecallConfig(input: {
  name: string;
  config: WorkflowRecallConfig;
  dagNodes?: unknown[];
  dagConnections?: unknown[];
}): string {
  return extractWorkflowMemoryBody({
    name: input.name,
    config: input.config as unknown as Record<string, unknown>,
    dagNodes: input.dagNodes,
    dagConnections: input.dagConnections,
  });
}
