// workflow-dsl/schema.ts — AI 画笔的紧凑宣告式 DSL：型别定义与手写校验。
//
// 角色（暴君裁定 2026-09-02）：画布图为唯一运行时真相；AI 不直接吐 CanvasAgentOp，
// 而是吐本档定义的 WorkflowDslSource，由 compile.ts 编译成既有 8-op DSL。
// 契约真源 = src/lib/canvas/types.ts 的 CanvasAgentOp（L239-247）；
// 栏位语义对齐 src/lib/agent-templates.ts 的 AgentPipelineStep。
//
// 零新依赖：repo 无 zod，校验全手写。错误文案一律简体中文（gateway 文案铁律），
// 且每条 message 自带修复提示（教学式报错，2026-09-02 暴君追加）——
// agent 不用翻文档就能改对；简短建议另放可选 hint 栏位。

/** 校验议题：step = 步骤 id（档级问题缺省）、field = 栏位名、message = 简体中文问题+修复提示、hint = 简短修复建议（可选，2026-09-02 教学式报错追加）。 */
export interface WorkflowValidationIssue {
  step?: string;
  field?: string;
  message: string;
  hint?: string;
}

/** 单步宣告：id 为档内符号名，其余栏位皆可选（缺省语义见注释）。 */
export interface WorkflowDslStep {
  /** 符合 ^[a-z][a-z0-9_]{0,47}$，档内唯一；决定确定性节点 id 的一部分。 */
  id: string;
  /** 卡面标题 1..40 字。 */
  title: string;
  /** 缺省 "image"。director = 3D 白模预演步（导演台节点，2026-09-03）。 */
  kind?: "image" | "text" | "video" | "audio" | "director";
  /** ≤4000 字。 */
  prompt?: string;
  /** 依赖步骤 id（=画布连线 dep→step），编译时去重。 */
  needs?: string[];
  model?: string;
  /** /^\d+x\d+$/ 格式。 */
  size?: string;
  /** 整数 1..8。 */
  count?: number;
  /** 门禁步（人工批准后才续跑）。 */
  gate?: boolean;
  /** 必须 ∈ HARNESS_TOOL_IDS（src/lib/harness-tool-registry.ts；在校验顺序的 tool 段检查，见 compile.ts）。 */
  tool?: string;
  /** 透传进节点 metadata 的自由栏位；序列化 ≤4KB。 */
  meta?: Record<string, unknown>;
}

/** 一份工作流源码：steps 数为 WORKFLOW_STEPS_MIN..WORKFLOW_STEPS_MAX（见下方常量）。 */
export interface WorkflowDslSource {
  /** 命名空间 ^[a-z][a-z0-9_-]{0,47}$。 */
  workflow: string;
  /** ≤60 字。 */
  title?: string;
  steps: WorkflowDslStep[];
}

// ─────────────────────────── 模式与边界（compile/decompile 共用）

export const WORKFLOW_NS_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
export const STEP_ID_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
export const SIZE_PATTERN = /^\d+x\d+$/;
export const WORKFLOW_STEPS_MIN = 1;
// 作者防呆上限（2026-10-09 裁定由 24 抬到 256；实测存量最大 221 步）。上限只防呆，不是
// 画布容量的真约束——真约束是快照 460KB 预算，超了会按既有守卫整份丢 dsl。
export const WORKFLOW_STEPS_MAX = 256;
export const META_MAX_BYTES = 4096;

const STEP_KINDS = new Set(["image", "text", "video", "audio", "director"]);

// ─────────────────────────── 校验

/**
 * 校验未知来源的 DSL 源码（JSON 反序列化产物视为 unknown）。
 * 只做结构与格式检查（型别/长度/正则/meta 大小）；跨步骤语义
 * （id 唯一、needs 引用、拓扑、tool 成员）归 compile.ts 的编译期校验。
 */
export function validateWorkflowDsl(raw: unknown): { ok: true; source: WorkflowDslSource } | { ok: false; errors: WorkflowValidationIssue[] } {
  const errors: WorkflowValidationIssue[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ message: "输入须为一个 JSON 对象：{ workflow, title?, steps }；收到的是 " + describeValueKind(raw), hint: "传 {\"workflow\":\"...\",\"steps\":[...]} 结构" }],
    };
  }
  const obj = raw as Record<string, unknown>;

  const workflow = obj.workflow;
  if (typeof workflow !== "string" || !WORKFLOW_NS_PATTERN.test(workflow)) {
    errors.push({
      field: "workflow",
      message: `workflow 名称 ${describeValueKind(workflow) === "string" ? `"${workflow}"` : describeValueKind(workflow)} 不合规；须为小写字母开头、仅含 [a-z0-9_-] 的 1..48 字符串，如 'novel_film'`,
      hint: "例如 workflow: \"novel_film\"",
    });
  }

  if (obj.title !== undefined && obj.title !== null) {
    if (typeof obj.title !== "string" || obj.title.length < 1 || obj.title.length > 60) {
      errors.push({
        field: "title",
        message: `title ${describeValueKind(obj.title) === "string" ? `长度为 ${(obj.title as string).length}` : `类型为 ${describeValueKind(obj.title)}`}；须为 1..60 字的字符串`,
        hint: "删掉 title 字段或缩短到 60 字内",
      });
    }
  }

  const stepsRaw = obj.steps;
  if (!Array.isArray(stepsRaw)) {
    errors.push({
      field: "steps",
      message: `steps ${describeValueKind(stepsRaw) === "missing" ? "缺失" : `类型为 ${describeValueKind(stepsRaw)}`}；须为 ${WORKFLOW_STEPS_MIN}..${WORKFLOW_STEPS_MAX} 个步骤对象的数组`,
      hint: "至少写一个步骤，如 steps: [{ id: \"first\", title: \"第一步\" }]",
    });
  } else {
    if (stepsRaw.length < WORKFLOW_STEPS_MIN || stepsRaw.length > WORKFLOW_STEPS_MAX) {
      errors.push({
        field: "steps",
        message: `steps 数量为 ${stepsRaw.length}；步骤数量须为 ${WORKFLOW_STEPS_MIN}..${WORKFLOW_STEPS_MAX} 个`,
        hint: stepsRaw.length === 0 ? "至少写一个步骤" : "拆成多份工作流或合并步骤",
      });
    }
    stepsRaw.forEach((stepRaw, index) => {
      errors.push(...validateStep(stepRaw, index));
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, source: raw as unknown as WorkflowDslSource };
}

function validateStep(stepRaw: unknown, index: number): WorkflowValidationIssue[] {
  const errors: WorkflowValidationIssue[] = [];
  if (typeof stepRaw !== "object" || stepRaw === null || Array.isArray(stepRaw)) {
    return [{ field: `steps[${index}]`, message: `steps[${index}] ${describeValueKind(stepRaw) === "missing" ? "缺失" : `类型为 ${describeValueKind(stepRaw)}`}；须为步骤对象 { id, title, ... }`, hint: "每个步骤至少带 id 与 title" }];
  }
  const step = stepRaw as Record<string, unknown>;
  const stepLabel = typeof step.id === "string" && step.id.length > 0 ? step.id : `steps[${index}]`;

  if (typeof step.id !== "string" || !STEP_ID_PATTERN.test(step.id)) {
    errors.push({
      step: typeof step.id === "string" ? step.id : undefined,
      field: "id",
      message: `步骤 ${stepLabel} 的 id ${describeValueKind(step.id) === "string" ? `"${step.id}" 不合规` : `类型为 ${describeValueKind(step.id)}`}；id 须为小写字母开头的 [a-z0-9_]（1..48 字符），如 'keyframe_01'`,
      hint: "例如 id: \"keyframe_01\"",
    });
  }

  if (typeof step.title !== "string" || step.title.length < 1 || step.title.length > 40) {
    errors.push({
      step: typeof step.id === "string" ? step.id : undefined,
      field: "title",
      message: `步骤 ${stepLabel} 的 title ${describeValueKind(step.title) === "string" ? `长度为 ${(step.title as string).length}` : `类型为 ${describeValueKind(step.title)}`}；须为 1..40 字的字符串`,
      hint: "写一句能看懂的卡面标题，如 title: \"生成主角三视图\"",
    });
  }

  if (step.kind !== undefined && step.kind !== null) {
    if (typeof step.kind !== "string" || !STEP_KINDS.has(step.kind)) {
      errors.push({
        step: typeof step.id === "string" ? step.id : undefined,
        field: "kind",
        message: `步骤 ${stepLabel} 的 kind ${describeValueKind(step.kind) === "string" ? `"${step.kind}" 不在支持清单` : `类型为 ${describeValueKind(step.kind)}`}；kind 只接受 'image' | 'text' | 'video' | 'audio' | 'director'`,
        hint: "不写 kind 等价于 'image'",
      });
    }
  }

  if (step.prompt !== undefined && step.prompt !== null) {
    if (typeof step.prompt !== "string" || step.prompt.length > 4000) {
      errors.push({
        step: typeof step.id === "string" ? step.id : undefined,
        field: "prompt",
        message: `步骤 ${stepLabel} 的 prompt ${describeValueKind(step.prompt) === "string" ? `长度为 ${(step.prompt as string).length}` : `类型为 ${describeValueKind(step.prompt)}`}；prompt 须为 ≤4000 字的字符串`,
        hint: "缩短提示词，或把细节挪进 meta 自由字段",
      });
    }
  }

  if (step.needs !== undefined && step.needs !== null) {
    if (!Array.isArray(step.needs) || step.needs.some((d) => typeof d !== "string" || d.length === 0)) {
      errors.push({
        step: typeof step.id === "string" ? step.id : undefined,
        field: "needs",
        message: `步骤 ${stepLabel} 的 needs ${!Array.isArray(step.needs) ? `类型为 ${describeValueKind(step.needs)}` : "含非字符串项"}；needs 须为步骤 id 字符串数组`,
        hint: "如 needs: [\"script\", \"cast\"]，引用同档其它步骤的 id",
      });
    }
  }

  if (step.model !== undefined && step.model !== null && typeof step.model !== "string") {
    errors.push({
      step: typeof step.id === "string" ? step.id : undefined,
      field: "model",
      message: `步骤 ${stepLabel} 的 model 类型为 ${describeValueKind(step.model)}；须为字符串`,
      hint: "去掉 model 字段用平台默认模型",
    });
  }

  if (step.size !== undefined && step.size !== null) {
    if (typeof step.size !== "string" || !SIZE_PATTERN.test(step.size)) {
      errors.push({
        step: typeof step.id === "string" ? step.id : undefined,
        field: "size",
        message: `步骤 ${stepLabel} 的 size ${describeValueKind(step.size) === "string" ? `"${step.size}" 格式不对` : `类型为 ${describeValueKind(step.size)}`}；size 须为 '宽x高' 格式，如 '2048x2048'`,
        hint: "例如 size: \"2048x2048\"",
      });
    }
  }

  if (step.count !== undefined && step.count !== null) {
    const count = step.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 8) {
      errors.push({
        step: typeof step.id === "string" ? step.id : undefined,
        field: "count",
        message: `步骤 ${stepLabel} 的 count ${describeValueKind(count) === "number" ? `为 ${count}` : `类型为 ${describeValueKind(count)}`}；count 须为 1..8 的整数`,
        hint: "一次生成 1..8 张，如 count: 4",
      });
    }
  }

  if (step.gate !== undefined && step.gate !== null && typeof step.gate !== "boolean") {
    errors.push({
      step: typeof step.id === "string" ? step.id : undefined,
      field: "gate",
      message: `步骤 ${stepLabel} 的 gate 类型为 ${describeValueKind(step.gate)}；gate 须为布尔值`,
      hint: "需要人工批准的步骤写 gate: true",
    });
  }

  if (step.tool !== undefined && step.tool !== null) {
    if (typeof step.tool !== "string" || step.tool.length === 0) {
      errors.push({
        step: typeof step.id === "string" ? step.id : undefined,
        field: "tool",
        message: `步骤 ${stepLabel} 的 tool ${describeValueKind(step.tool)}；须为非空字符串（合法 id 清单见 harness 工具面）`,
        hint: "常用生成类 id：image_generate、image_edit",
      });
    }
  }

  if (step.meta !== undefined && step.meta !== null) {
    if (typeof step.meta !== "object" || Array.isArray(step.meta)) {
      errors.push({
        step: typeof step.id === "string" ? step.id : undefined,
        field: "meta",
        message: `步骤 ${stepLabel} 的 meta 类型为 ${describeValueKind(step.meta)}；meta 须为键值对象`,
        hint: "如 meta: { character_id: \"hero_01\" }",
      });
    } else {
      let bytes = -1;
      try {
        bytes = JSON.stringify(step.meta).length;
      } catch {
        bytes = -1;
      }
      if (bytes < 0) {
        errors.push({
          step: typeof step.id === "string" ? step.id : undefined,
          field: "meta",
          message: `步骤 ${stepLabel} 的 meta 无法 JSON 序列化（可能含循环引用）；去掉循环引用或非可序列化值`,
          hint: "meta 只放普通 JSON 值",
        });
      } else if (bytes > META_MAX_BYTES) {
        errors.push({
          step: typeof step.id === "string" ? step.id : undefined,
          field: "meta",
          message: `步骤 ${stepLabel} 的 meta 序列化后为 ${bytes} 字节，超过 ${META_MAX_BYTES}（4KB）上限；精简 meta 或拆分步骤`,
          hint: "把大段文本挪进 prompt，meta 只放标识符",
        });
      }
    }
  }

  return errors;
}

function describeValueKind(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ─────────────────────────── DSL v2（target:"project"，2026-10-28，设计文档 project-graph.md §3.4）
//
// 旧画布 DSL（WorkflowDslStep / validateWorkflowDsl）一字不动；v2 是并列新路径：
// kind 扩到工程图 NodeType，并新增 intent/params/inputs/refs/forEach/takes/onFail/pinned。
// 编译落点 = project-ops.ts 的 compileProjectDsl（输出强类型 PatchOp[]）。
// 字段取值范围取自契约 deploy-staging/gateway/project/types.ts（LIMITS 与 ForEach/TakesSpec/OnFail）。

/** 契约 NodeType 的 13 个值（types.ts NodeType）。 */
export const PROJECT_NODE_KINDS = [
  "reference", "script", "shotlist", "keyframe", "clip", "voice", "music", "timeline", "subtitle", "mix", "export", "qc", "render3d",
] as const;
export type ProjectNodeKind = (typeof PROJECT_NODE_KINDS)[number];
/** 旧 DSL kind 在工程图里的对应（audio 要分 voice/music、director 无对应，不做别名）。 */
export const PROJECT_KIND_ALIASES: Record<string, ProjectNodeKind> = { image: "keyframe", video: "clip", text: "script" };

/** types.ts NodeId：'#' 后是 forEach 实例的 row.id。 */
export const PROJECT_NODE_ID_PATTERN = /^[a-z][a-z0-9_]{0,47}(#[a-z0-9_]{1,32})?$/;
export const PROJECT_ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{16}$/;
const FOREACH_AS_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** types.ts LIMITS.INTENT_CHARS / INPUT_CAP_BYTES（project-ops.test.ts 与 LIMITS 等值锁定）。 */
export const PROJECT_INTENT_MAX = 200;
export const PROJECT_PARAMS_MAX_BYTES = 65536;

export interface ProjectDslForEach { over: string; as: string }
export interface ProjectDslTakes { n: number; select: "qc" | "first" | "user"; rubric?: string }
export type ProjectDslOnFail =
  | { action: "regenerate"; max: number; on?: "error" | "qc_fail" | "any"; then?: "fail" | "skip" | "ask_user" }
  | { action: "fail" } | { action: "skip" } | { action: "ask_user" };
export interface ProjectDslInputRef { from: string; port?: string }
export interface ProjectDslFileRef { artifactId: string; role: string }

/** v2 单步：id 即工程图 NodeId；kind 为 NodeType（或 image/video/text 别名）。 */
export interface ProjectDslStep {
  id: string;
  /** 新增节点必填；已存在节点缺省沿用其类型（类型不可改）。 */
  kind?: ProjectNodeKind | "image" | "video" | "text";
  /** 缺 intent 时用 title 当 intent。 */
  title?: string;
  /** ≤200 字，人话说明，不进签名。 */
  intent?: string;
  /** 快捷写法 → params.prompt / model / size / n（count）；显式 params 里同名键被它们覆盖。 */
  prompt?: string;
  model?: string;
  size?: string;
  count?: number;
  params?: Record<string, unknown>;
  /** 透传 → params（优先级最低，_origin_node_id 除外）。 */
  meta?: Record<string, unknown>;
  /** 依赖节点 id：输入口名 = 依赖 id，主口。可指向 DSL 内步骤或工程里已有节点。 */
  needs?: string[];
  /** 具名输入口：口名 → { from, port? }。 */
  inputs?: Record<string, ProjectDslInputRef>;
  refs?: ProjectDslFileRef[] | null;
  forEach?: ProjectDslForEach | null;
  takes?: ProjectDslTakes | null;
  onFail?: ProjectDslOnFail | null;
  /** true=钉住当前产物；{take,reason}；false=解钉。 */
  pinned?: boolean | { take?: number; reason?: string };
  /** 工程图无对应概念，编译时忽略并回 warning。 */
  gate?: boolean;
  tool?: string;
}

export interface ProjectDslSource {
  /** v2 可省；给了就按旧命名空间规则校验。 */
  workflow?: string;
  title?: string;
  steps: ProjectDslStep[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (v === null || typeof v === "boolean" || typeof v === "string") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (isPlainObject(v)) return Object.values(v).every((x) => x !== undefined && isJsonValue(x, depth + 1));
  return false;
}

function jsonBytes(v: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** 校验未知来源的 v2 DSL（只做结构/格式；跨步骤语义归 project-ops.ts）。旧字段（prompt/needs/model/size/count/gate/tool/meta）复用旧 validateStep。 */
export function validateProjectDsl(raw: unknown): { ok: true; source: ProjectDslSource } | { ok: false; errors: WorkflowValidationIssue[] } {
  const errors: WorkflowValidationIssue[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ message: "输入须为一个 JSON 对象：{ steps, workflow?, title? }；收到的是 " + describeValueKind(raw), hint: "传 {\"steps\":[...]}" }] };
  }
  if (raw.workflow !== undefined && raw.workflow !== null && (typeof raw.workflow !== "string" || !WORKFLOW_NS_PATTERN.test(raw.workflow))) {
    errors.push({ field: "workflow", message: "workflow 不合规；v2 可省略，给了须为小写字母开头、仅含 [a-z0-9_-] 的 1..48 字符串", hint: "删掉 workflow 字段" });
  }
  if (raw.title !== undefined && raw.title !== null && (typeof raw.title !== "string" || raw.title.length < 1 || raw.title.length > 60)) {
    errors.push({ field: "title", message: "title 须为 1..60 字的字符串", hint: "删掉 title 字段或缩短到 60 字内" });
  }
  const stepsRaw = raw.steps;
  if (!Array.isArray(stepsRaw)) {
    errors.push({ field: "steps", message: `steps 须为 ${WORKFLOW_STEPS_MIN}..${WORKFLOW_STEPS_MAX} 个步骤对象的数组；收到 ${describeValueKind(stepsRaw)}` });
  } else {
    if (stepsRaw.length < WORKFLOW_STEPS_MIN || stepsRaw.length > WORKFLOW_STEPS_MAX) {
      errors.push({ field: "steps", message: `steps 数量为 ${stepsRaw.length}；须为 ${WORKFLOW_STEPS_MIN}..${WORKFLOW_STEPS_MAX} 个` });
    }
    stepsRaw.forEach((s, i) => errors.push(...validateProjectStep(s, i)));
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, source: raw as unknown as ProjectDslSource };
}

function validateProjectStep(stepRaw: unknown, index: number): WorkflowValidationIssue[] {
  if (!isPlainObject(stepRaw)) {
    return [{ field: `steps[${index}]`, message: `steps[${index}] 须为步骤对象 { id, kind, ... }；收到 ${describeValueKind(stepRaw)}` }];
  }
  const step = stepRaw;
  const sid = typeof step.id === "string" ? step.id : undefined;
  const label = sid ?? `steps[${index}]`;
  const issue = (field: string, message: string, hint?: string): WorkflowValidationIssue => ({ step: sid, field, message: `步骤 ${label} 的 ${message}`, hint });

  // 旧字段复用旧校验：kind/title 换成占位（v2 的 kind/title 规则在下面单独查），其余原样交给 validateStep。
  const titleAbsent = step.title === undefined || step.title === null;
  const errors = validateStep({ ...step, kind: undefined, title: titleAbsent ? "t" : step.title }, index);
  if (step.title === null) errors.push(issue("title", "title 不能为 null；省略即可"));

  if (step.kind !== undefined && step.kind !== null) {
    const ok = typeof step.kind === "string" && ((PROJECT_NODE_KINDS as readonly string[]).includes(step.kind) || step.kind in PROJECT_KIND_ALIASES);
    if (!ok) errors.push(issue("kind", `kind ${JSON.stringify(step.kind)} 不在支持清单；须为 ${PROJECT_NODE_KINDS.join("|")}（或别名 image|video|text）`, "audio 请改 voice 或 music"));
  }
  if (step.intent !== undefined && step.intent !== null && (typeof step.intent !== "string" || step.intent.length > PROJECT_INTENT_MAX)) {
    errors.push(issue("intent", `intent 须为 ≤${PROJECT_INTENT_MAX} 字的字符串`));
  }
  if (step.params !== undefined && step.params !== null) {
    if (!isPlainObject(step.params) || !isJsonValue(step.params)) {
      errors.push(issue("params", "params 须为 JSON 键值对象（值为 null/布尔/有限数字/字符串/数组/对象）"));
    } else if (Object.keys(step.params).some((k) => k.length === 0 || k.includes("."))) {
      errors.push(issue("params", "params 的键不能为空或含 '.'（set 路径是 params.<键>）"));
    } else if (jsonBytes(step.params) > PROJECT_PARAMS_MAX_BYTES) {
      errors.push(issue("params", `params 序列化超过 ${PROJECT_PARAMS_MAX_BYTES} 字节`));
    }
  }
  if (step.meta !== undefined && step.meta !== null && isPlainObject(step.meta) && !isJsonValue(step.meta)) {
    errors.push(issue("meta", "meta 在 target:\"project\" 下会并入 params，须是纯 JSON 值"));
  }
  if (step.inputs !== undefined && step.inputs !== null) {
    if (!isPlainObject(step.inputs)) {
      errors.push(issue("inputs", "inputs 须为 { 口名: { from, port? } } 对象"));
    } else {
      for (const [name, ref] of Object.entries(step.inputs)) {
        if (name.length === 0 || name.includes(".") || !isPlainObject(ref) || typeof ref.from !== "string" || !PROJECT_NODE_ID_PATTERN.test(ref.from)
          || (ref.port !== undefined && (typeof ref.port !== "string" || ref.port.length === 0))) {
          errors.push(issue("inputs", `inputs.${name} 须为 { from: 节点id, port?: 字符串 }，口名非空且不含 '.'`));
        }
      }
    }
  }
  if (step.needs !== undefined && step.needs !== null && Array.isArray(step.needs) && step.needs.some((d) => typeof d === "string" && !PROJECT_NODE_ID_PATTERN.test(d))) {
    errors.push(issue("needs", "needs 含不合规的节点 id"));
  }
  if (step.refs !== undefined && step.refs !== null) {
    if (!Array.isArray(step.refs) || step.refs.some((r) => !isPlainObject(r) || typeof r.artifactId !== "string" || !PROJECT_ARTIFACT_ID_PATTERN.test(r.artifactId) || typeof r.role !== "string" || r.role.length === 0)) {
      errors.push(issue("refs", "refs 须为 [{ artifactId: 'art_'+16位小写hex, role }] 数组"));
    }
  }
  if (step.forEach !== undefined && step.forEach !== null) {
    const f = step.forEach;
    if (!isPlainObject(f) || typeof f.over !== "string" || !STEP_ID_PATTERN.test(f.over) || typeof f.as !== "string" || !FOREACH_AS_PATTERN.test(f.as) || f.as === "row") {
      errors.push(issue("forEach", "forEach 须为 { over: shotlist 节点id, as: 别名 }，as 为 [a-z][a-z0-9_]* 且不能是 'row'"));
    }
  }
  if (step.takes !== undefined && step.takes !== null) {
    const t = step.takes;
    if (!isPlainObject(t) || typeof t.n !== "number" || !Number.isInteger(t.n) || t.n < 2 || t.n > 4 || (t.select !== "qc" && t.select !== "first" && t.select !== "user")
      || (t.rubric !== undefined && (typeof t.rubric !== "string" || t.rubric.length === 0))) {
      errors.push(issue("takes", "takes 须为 { n: 2..4, select: 'qc'|'first'|'user', rubric?: 字符串 }"));
    }
  }
  if (step.onFail !== undefined && step.onFail !== null) {
    const o = step.onFail;
    let ok = false;
    if (isPlainObject(o)) {
      if (o.action === "fail" || o.action === "skip" || o.action === "ask_user") ok = true;
      else if (o.action === "regenerate") {
        ok = typeof o.max === "number" && Number.isInteger(o.max) && o.max >= 1 && o.max <= 2
          && (o.on === undefined || o.on === "error" || o.on === "qc_fail" || o.on === "any")
          && (o.then === undefined || o.then === "fail" || o.then === "skip" || o.then === "ask_user");
      }
    }
    if (!ok) errors.push(issue("onFail", "onFail 须为 {action:'fail'|'skip'|'ask_user'} 或 {action:'regenerate', max:1..2, on?, then?}"));
  }
  if (step.pinned !== undefined && step.pinned !== null && typeof step.pinned !== "boolean") {
    const p = step.pinned;
    if (!isPlainObject(p) || (p.take !== undefined && (typeof p.take !== "number" || !Number.isInteger(p.take) || p.take < 1)) || (p.reason !== undefined && typeof p.reason !== "string")) {
      errors.push(issue("pinned", "pinned 须为 true|false 或 { take?: 正整数, reason?: 字符串 }"));
    }
  }
  return errors;
}
