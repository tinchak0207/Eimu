// 專案級風格綁定：風格是可引用的**一等 id**，套用時把 id 展開成全文素材（P1-8／對稱差 D34）。
//
// 對標口徑（eimu-competition-report「Dramagic對稱差-全站-0928.md」）：
//   對手 `CreateProject { …, VisualPromptId:"realistic_common" }` —— 風格 id 是專案建立時的一等參數；
//   解析後 `Script { …, VisualMeta:{Ratio, VisualStyle} }` —— 風格的**全文**素材化進腳本層。
//   我方此前「風格只在 skill/prompt 層，無 VisualPromptId 一等物件」。
// 本模組即該對應物：**id 進、全文出**。
//
// 三條不變量：
//   ① 唯一註冊面 = `STYLE_LIBRARY`（一律經 `getStyleById` 查）。查不到 ⇒ null，
//      不製造半形綁定、不回退「第一個風格」、不猜近似 id。
//   ② 素材化一律呼叫既有輪子 `applyStyleToPrompt` / `mergeStyleNegative`
//      （src/lib/style-library.ts，MIT · twri/sdxl_prompt_styler）——本模組不另寫套用邏輯。
//   ③ 無風格（style === null）⇒ prompt / negativePrompt **逐位不變**（零回歸）。
//
// 葉模組鐵律：只 import `@/lib/style-library` 的型別與函式。
// 不得 import DB／`node:*`／catalog runtime —— 本檔同時被伺服器路由與前端 hook 鏈路使用。
import { applyStyleToPrompt, getStyleById, mergeStyleNegative, type StyleTemplate } from "@/lib/style-library";

/** 風格的來源：`request`＝本次呼叫自帶（優先），`project`＝專案持久化綁定。 */
export type ProjectStyleSource = "request" | "project";

/** 套用結果的來源；`none`＝這次生成沒有用任何風格（明示，不靜默）。 */
export type AppliedStyleSource = ProjectStyleSource | "none";

/** 解析後的風格（id ＋ 當次查得的全文）。 */
export interface ResolvedProjectStyle {
  styleId: string;
  /** 註冊表中的中文名（給回報/UI 明示用了哪個風格）。 */
  name: string;
  source: ProjectStyleSource;
  /** 註冊表中的原始模板（含 `{prompt}` 佔位）。 */
  promptTemplate: string;
  negativePrompt: string;
}

/**
 * 清洗一個風格 id：trim 後在 `STYLE_LIBRARY` 查得到才回合法 id，否則 null。
 *
 * 這是落盤/讀取/請求三條路徑的**唯一**值域判據（同 `isValidCreationStep` 的地位）：
 * 各處不各寫一份「哪些 id 算合法」。回傳的是**註冊表裡的 id 字面**（不是原始輸入），
 * 免得前後空白之類的差異被當成第二個 id 存進 Blob。
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
 * 解析本次生成要用的風格，優先序 **request > project**（呼叫端自帶的明確意圖蓋過專案綁定）。
 * 兩者都查不到 ⇒ null（＝不套用任何風格；呼叫端若要對「帶了未知 id」報錯，須自己先過
 * `normalizeProjectStyleId` 判 400，本函式只做解析、不吞錯也不編造）。
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
 * 把風格素材化進 prompt / 負面詞（對手的 `VisualMeta.VisualStyle` 全文那一步）。
 *
 * - `style === null` ⇒ `prompt` 逐位不變、`negativePrompt` 照既有語義（空字串 → null）。
 * - 有風格 ⇒ prompt 由 `applyStyleToPrompt` 把 `{prompt}` 換成用戶提示詞（**不得留佔位符**），
 *   負面詞由 `mergeStyleNegative` 合併（一方已包含另一方時不重複堆疊）。
 * - 風格已「解析成功但註冊表查不到」是不可能態（ResolvedProjectStyle 只能由本模組產生）；
 *   萬一以手造物件傳入，`applyStyleToPrompt`/`mergeStyleNegative` 收 undefined 會原樣放行
 *   （輪子自身的防禦），但 `styleId` 仍照實回報，不假裝套用過。
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