// 专案级风格绑定：风格是可引用的**一等 id**，套用时把 id 展开成全文素材（P1-8／对称差 D34）。
//
// 对标口径（eimu-competition-report「Dramagic对称差-全站-0928.md」）：
//   对手 `CreateProject { …, VisualPromptId:"realistic_common" }` —— 风格 id 是专案建立时的一等参数；
//   解析后 `Script { …, VisualMeta:{Ratio, VisualStyle} }` —— 风格的**全文**素材化进脚本层。
//   我方此前「风格只在 skill/prompt 层，无 VisualPromptId 一等物件」。
// 本模组即该对应物：**id 进、全文出**。
//
// 三条不变量：
//   ① 唯一注册面 = `STYLE_LIBRARY`（一律经 `getStyleById` 查）。查不到 ⇒ null，
//      不制造半形绑定、不回退「第一个风格」、不猜近似 id。
//   ② 素材化一律呼叫既有轮子 `applyStyleToPrompt` / `mergeStyleNegative`
//      （src/lib/style-library.ts，MIT · twri/sdxl_prompt_styler）——本模组不另写套用逻辑。
//   ③ 无风格（style === null）⇒ prompt / negativePrompt **逐位不变**（零回归）。
//
// 叶模组铁律：只 import `@/lib/style-library` 的型别与函式。
// 不得 import DB／`node:*`／catalog runtime —— 本档同时被伺服器路由与前端 hook 链路使用。
import { applyStyleToPrompt, getStyleById, mergeStyleNegative, type StyleTemplate } from "@/lib/style-library";

/** 风格的来源：`request`＝本次呼叫自带（优先），`project`＝专案持久化绑定。 */
export type ProjectStyleSource = "request" | "project";

/** 套用结果的来源；`none`＝这次生成没有用任何风格（明示，不静默）。 */
export type AppliedStyleSource = ProjectStyleSource | "none";

/** 解析后的风格（id ＋ 当次查得的全文）。 */
export interface ResolvedProjectStyle {
  styleId: string;
  /** 注册表中的中文名（给回报/UI 明示用了哪个风格）。 */
  name: string;
  source: ProjectStyleSource;
  /** 注册表中的原始模板（含 `{prompt}` 占位）。 */
  promptTemplate: string;
  negativePrompt: string;
}

/**
 * 清洗一个风格 id：trim 后在 `STYLE_LIBRARY` 查得到才回合法 id，否则 null。
 *
 * 这是落盘/读取/请求三条路径的**唯一**值域判据（同 `isValidCreationStep` 的地位）：
 * 各处不各写一份「哪些 id 算合法」。回传的是**注册表里的 id 字面**（不是原始输入），
 * 免得前后空白之类的差异被当成第二个 id 存进 Blob。
 */
export function normalizeProjectStyleId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (id.length === 0) return null;
  return getStyleById(id)?.id ?? null;
}

function resolveOne(styleId: string, source: ProjectStyleSource): ResolvedProjectStyle | null {
  const style = getStyleById(styleId);
  if (!style) return null;
  return {
    styleId: style.id,
    name: style.name,
    source,
    promptTemplate: style.prompt,
    negativePrompt: style.negativePrompt,
  };
}

/**
 * 解析本次生成要用的风格，优先序 **request > project**（呼叫端自带的明确意图盖过专案绑定）。
 * 两者都查不到 ⇒ null（＝不套用任何风格；呼叫端若要对「带了未知 id」报错，须自己先过
 * `normalizeProjectStyleId` 判 400，本函式只做解析、不吞错也不编造）。
 */
export function resolveProjectStyle(input: {
  requestStyleId?: unknown;
  projectStyleId?: unknown;
}): ResolvedProjectStyle | null {
  const request = normalizeProjectStyleId(input?.requestStyleId);
  if (request) return resolveOne(request, "request");
  const project = normalizeProjectStyleId(input?.projectStyleId);
  if (project) return resolveOne(project, "project");
  return null;
}

/**
 * 把风格素材化进 prompt / 负面词（对手的 `VisualMeta.VisualStyle` 全文那一步）。
 *
 * - `style === null` ⇒ `prompt` 逐位不变、`negativePrompt` 照既有语义（空字串 → null）。
 * - 有风格 ⇒ prompt 由 `applyStyleToPrompt` 把 `{prompt}` 换成用户提示词（**不得留占位符**），
 *   负面词由 `mergeStyleNegative` 合并（一方已包含另一方时不重复堆叠）。
 * - 风格已「解析成功但注册表查不到」是不可能态（ResolvedProjectStyle 只能由本模组产生）；
 *   万一以手造物件传入，`applyStyleToPrompt`/`mergeStyleNegative` 收 undefined 会原样放行
 *   （轮子自身的防御），但 `styleId` 仍照实回报，不假装套用过。
 */
export function applyProjectStyle(input: {
  style: ResolvedProjectStyle | null;
  prompt: unknown;
  negativePrompt?: unknown;
}): { prompt: string; negativePrompt: string | null; styleId: string | null; styleSource: AppliedStyleSource } {
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  const userNegative = typeof input?.negativePrompt === "string" ? input.negativePrompt : "";
  if (!input?.style) {
    return {
      prompt,
      negativePrompt: userNegative.length > 0 ? userNegative : null,
      styleId: null,
      styleSource: "none",
    };
  }
  const style: StyleTemplate | undefined = getStyleById(input.style.styleId);
  const merged = mergeStyleNegative(style, userNegative);
  return {
    prompt: applyStyleToPrompt(style, prompt),
    negativePrompt: merged.length > 0 ? merged : null,
    styleId: input.style.styleId,
    styleSource: input.style.source,
  };
}