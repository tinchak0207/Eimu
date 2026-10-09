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
