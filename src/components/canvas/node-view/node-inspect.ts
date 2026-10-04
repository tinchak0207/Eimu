// 語義縮放 LOD 3「拆機」內容：節點 → 分段參數（純函式，2026-10-01）。
//
// 卡片還是那張卡（標題列、類型色頂線、徽章不變），只是正文區放大後換成這顆節點的內部參數。
// 內容紀律：每一行都要對調參/排錯有用——中文標籤、完整值（不從左截 id）、按節點類型挑欄位；
// 不放節點座標/尺寸/內部 id 這類對使用者無意義的欄位，不放任何裝飾性假資訊。
// 版面由呈現端決定（字級恆定螢幕尺寸，放大＝同一張卡裝得下更多段落）。

import { CanvasNodeType, errorDetailsText, type CanvasNode } from "@/lib/canvas/types";
import { REFERENCE_IMAGE_ROLES } from "../../../lib/reference-image-roles";
import { STATUS_LABEL, TYPE_LABEL } from "./constants";
import { SHOT_FIELD_LABEL } from "./StoryboardShotBody";

export interface InspectInput {
  id: string;
  label: string;
  type: CanvasNodeType | string;
}

export type InspectRow =
  | { kind: "field"; label: string; value: string; mono?: boolean; tone?: "error" | "accent" }
  | { kind: "text"; label: string; value: string; mono?: boolean; tone?: "error" | "negative" }
  | { kind: "chips"; label: string; items: string[] };

export type InspectIcon = "input" | "core" | "prompt" | "params" | "task" | "versions" | "shot" | "tool" | "text";

export interface InspectSection {
  key: string;
  title: string;
  icon: InspectIcon;
  rows: InspectRow[];
}

const TAG_LABEL: Record<string, string> = { main_image: "主图", main_video: "主视频" };

function roleLabel(role: string | undefined): string | undefined {
  if (!role) return undefined;
  return REFERENCE_IMAGE_ROLES.find((r) => r.id === role)?.label ?? role;
}

function clock(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

function isoClock(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : clock(t);
}

/** 工具輸入/輸出常是 JSON 字串：能解析就縮排排版，不能就原樣。 */
function pretty(raw: string): { value: string; mono: boolean } {
  const s = raw.trim();
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      return { value: JSON.stringify(JSON.parse(s), null, 2), mono: true };
    } catch {
      /* 非 JSON：原樣 */
    }
  }
  return { value: raw, mono: false };
}

function push(rows: InspectRow[], row: InspectRow | null | undefined) {
  if (!row) return;
  if (row.kind === "chips" ? row.items.length === 0 : !row.value?.toString().trim()) return;
  rows.push(row);
}

function field(label: string, value: unknown, opts: { mono?: boolean; tone?: "error" | "accent" } = {}): InspectRow | null {
  if (value === undefined || value === null || value === "") return null;
  return { kind: "field", label, value: String(value), ...opts };
}

export function inspectSections(node: CanvasNode, inputs: readonly InspectInput[] = []): InspectSection[] {
  const m = node.metadata ?? {};
  const sections: InspectSection[] = [];
  const add = (s: InspectSection) => {
    if (s.rows.length > 0) sections.push(s);
  };

  // 輸入：連到這顆節點的上游（誰在餵它）。
  add({
    key: "inputs",
    title: "输入",
    icon: "input",
    rows: inputs.map((inp) => ({
      kind: "field" as const,
      label: TYPE_LABEL[inp.type as CanvasNodeType] ?? String(inp.type),
      value: inp.label || "未命名",
    })),
  });

  // 核心：模型／工具／步驟／門禁。
  const core: InspectRow[] = [];
  push(core, field("模型", m.model, { mono: true, tone: "accent" }));
  if (m.pipelineCard === "step_head") {
    push(core, field("步骤", [m.stepIndex !== undefined ? `第 ${m.stepIndex} 步` : "", m.stepName ?? ""].filter(Boolean).join(" · ")));
    push(core, { kind: "chips", label: "工具", items: m.toolIds ?? [] });
    push(core, field("人工确认", m.gate === true || m.gate === "true" ? "需要" : m.gate ? String(m.gate) : undefined));
  }
  if (m.pipelineCard === "tool" || m.toolId) {
    push(core, field("工具", m.toolId, { mono: true, tone: "accent" }));
    push(core, field("需要能力", m.requiredCapability, { mono: true }));
    if (m.unsupported) push(core, field("可用性", "当前环境不支持", { tone: "error" }));
  }
  if (m.gateConfirm) {
    push(core, field("门禁", m.gateConfirm.status === "pending" ? "待确认" : m.gateConfirm.status === "approved" ? "已批准" : "已退回"));
    push(core, field("确认请求", m.gateConfirm.request_id, { mono: true }));
  }
  add({ key: "core", title: m.model ? "模型" : m.pipelineCard === "step_head" ? "步骤" : m.toolId ? "工具" : "节点", icon: m.toolId ? "tool" : "core", rows: core });

  // 提示詞（生成類）／正文（文本類）。
  const prompt: InspectRow[] = [];
  const isText = node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Prompt;
  if (m.prompt) push(prompt, { kind: "text", label: "提示词", value: m.prompt });
  if (m.negativePrompt) push(prompt, { kind: "text", label: "反向提示词", value: m.negativePrompt, tone: "negative" });
  if (isText && m.content) {
    push(prompt, { kind: "text", label: "正文", value: m.content });
    push(prompt, field("字数", [...m.content].length));
  }
  add({ key: "prompt", title: isText && !m.prompt ? "正文" : "提示词", icon: isText && !m.prompt ? "text" : "prompt", rows: prompt });

  // 流水線卡：交付物、輸入來源、工具輸入/輸出。
  const pipe: InspectRow[] = [];
  if (m.deliverable) push(pipe, { kind: "text", label: "交付物", value: m.deliverable });
  if (m.inputFrom) push(pipe, { kind: "text", label: "输入来源", value: m.inputFrom });
  if (m.toolInput) push(pipe, { kind: "text", label: "工具输入", ...pretty(m.toolInput) });
  if (m.toolOutput) push(pipe, { kind: "text", label: "工具输出", ...pretty(m.toolOutput) });
  add({ key: "pipeline", title: "流程", icon: "tool", rows: pipe });

  // 生成參數。
  const params: InspectRow[] = [];
  push(params, field("尺寸", m.size, { mono: true }));
  push(params, field("画质", m.quality));
  push(params, field("数量", m.count));
  push(params, field("参考角色", roleLabel(m.referenceRole)));
  push(params, field("镜号", m.shotId, { mono: true }));
  push(params, field("分集", m.episodeId, { mono: true }));
  push(params, field("3D 导演台", m.directorStageId, { mono: true }));
  if (m.naturalWidth && m.naturalHeight) push(params, field("原图像素", `${m.naturalWidth}×${m.naturalHeight}`, { mono: true }));
  add({ key: "params", title: "参数", icon: "params", rows: params });

  // 任務與執行。
  const task: InspectRow[] = [];
  const status = m.status ?? "idle";
  push(task, field("状态", STATUS_LABEL[status] ?? status, { tone: status === "error" ? "error" : undefined }));
  if (status === "loading" && typeof m.progress === "number") push(task, field("进度", `${Math.round(m.progress)}%`));
  push(task, field("开始时间", clock(m.startedAt), { mono: true }));
  push(task, field("任务 ID", m.imageTaskId, { mono: true }));
  const err = errorDetailsText(m.errorDetails);
  if (err) push(task, { kind: "text", label: "错误", value: err, tone: "error" });
  if (typeof m.cost_coins === "number") push(task, field("花费", `${m.cost_coins} 币`));
  else if (typeof m.cost_hint === "number") push(task, field("预估花费", `${m.cost_hint} 币`));
  add({ key: "task", title: "执行", icon: "task", rows: task });

  // 版本史與候選。
  const hist: InspectRow[] = [];
  const versions = m.taskVersions?.items ?? [];
  for (const v of [...versions].reverse()) {
    const selected = m.taskVersions?.selectedVersion === v.version;
    const tags = (v.tags ?? []).map((t) => TAG_LABEL[t] ?? t);
    push(hist, field(isoClock(v.version) ?? v.version, [v.status ? STATUS_LABEL[v.status] : "", ...tags, selected ? "★ 采用" : ""].filter(Boolean).join(" · ") || "—", { tone: selected ? "accent" : undefined }));
  }
  const cands = m.shotCandidates?.items ?? [];
  if (cands.length > 0) {
    const sel = cands.find((c) => c.id === m.shotCandidates?.selectedId);
    push(hist, field("候选", `${cands.length} 条${sel ? " · 已星标 1 条" : ""}`));
    if (sel?.prompt) push(hist, { kind: "text", label: "采用的候选", value: sel.prompt });
  }
  add({ key: "versions", title: "版本", icon: "versions", rows: hist });

  // 分鏡 21 欄（AID 契約順序）。
  const shot = m.storyboardShot as Record<string, string> | undefined;
  if (shot) {
    const rows: InspectRow[] = [];
    for (const [key, label] of Object.entries(SHOT_FIELD_LABEL)) {
      const v = shot[key];
      if (typeof v === "string" && v.trim()) push(rows, v.length > 24 ? { kind: "text", label, value: v } : field(label, v));
    }
    add({ key: "shot", title: "分镜", icon: "shot", rows });
  }

  return sections;
}

/** 總行數（呈現端算「還有 N 項」用）。 */
export function inspectRowCount(sections: readonly InspectSection[]): number {
  return sections.reduce((n, s) => n + s.rows.length, 0);
}
