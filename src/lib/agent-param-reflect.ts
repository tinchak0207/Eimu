// D-12：助理动过的参数要能回到工作台控件上，并且可以逐项撤销。
//
// 时机上的现实：SSE 契约里没有「我打算用这些参数」这种事件，参数只在
// tool.invoke 的 args_summary 里出现——也就是助理**已经调用工具之后**。
// 所以这里做的是「事后反映」而不是「事前提案」：助理出完图，工作台控件
// 跟着显示它实际用的模型/比例/解析度，使用者退出聊天区时手上是助理调好的
// 那套设定，不满意就逐项撤销。
//
// 只反映本站控件真的有的三项（模型/比例/解析度）。LoRA、采样器、seed 这些
// 普通模式没有对应控件，硬塞会造出一个看不见的幽灵状态——那些由 D-11 的
// 提示直说「不会回填」。

import {
  aspectRatioFromImageSize,
  generationModel,
  modelAspectRatios,
  modelResolutions,
  type AspectRatio,
  type OutputResolution,
} from "@/lib/generation-model-catalog";
import { parseToolParams } from "@/lib/agent-tool-params";

/** 助理这次实际用上、且本站控件表达得出来的参数。字段缺席 = 这项没动。 */
export interface ReflectedParams {
  modelId?: string;
  aspectRatio?: AspectRatio;
  resolution?: OutputResolution;
}

/** 解析度字面量 → 本站枚举。上游写法不统一，都收敛到 1k/2k/4k。 */
function normalizeResolution(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^[124]k$/.test(v)) return v;
  // "1024x1024" / "2048x2048" 这类尺寸也能推出档位
  const [w, h] = v.split("x").map(Number);
  const longest = Math.max(w || 0, h || 0);
  if (!longest) return null;
  if (longest >= 3500) return "4k";
  if (longest >= 1800) return "2k";
  if (longest >= 700) return "1k";
  return null;
}

/**
 * 从 tool.invoke 的 args_summary 反推出可回填的参数。
 *
 * @param argsSummary 网关给的参数摘要（可能被截断、可能不是 JSON）
 * @param currentModelId 当前控件上的模型。比例/解析度的合法集合取决于模型，
 *                       所以要先定下模型再校验另两项。
 *
 * 校验一律以本站目录为准：目录里没有的模型、该模型不支持的比例/解析度，
 * 一概丢弃而不是硬写进 state——写进去会让控件显示一个点了会报错的选项。
 */
export function reflectParams(
  argsSummary: string | undefined,
  currentModelId: string,
): ReflectedParams {
  const parsed = parseToolParams(argsSummary);
  if (!parsed || parsed.params.length === 0) return {};

  const byKey = new Map(parsed.params.map((p) => [p.key, p.value]));
  const out: ReflectedParams = {};

  // 1) 模型：只认目录里存在的 id
  const rawModel = byKey.get("model");
  if (rawModel && generationModel(rawModel)) {
    out.modelId = rawModel;
  }

  // 比例与解析度的合法集合跟着模型走
  const effectiveModelId = out.modelId ?? currentModelId;

  // 2) 比例：aspect_ratio 优先，其次从 size 反推
  const allowedRatios = modelAspectRatios(effectiveModelId);
  const rawRatio = byKey.get("aspect_ratio");
  const candidateRatio = rawRatio
    ? (rawRatio.trim() as AspectRatio)
    : byKey.has("size")
      ? aspectRatioFromImageSize(byKey.get("size"))
      : null;
  // aspectRatioFromImageSize 会算出 "1000:999" 这种目录里没有的值，必须过滤
  if (candidateRatio && allowedRatios.includes(candidateRatio)) {
    out.aspectRatio = candidateRatio;
  }

  // 3) 解析度：quality / size 都可能带信息
  const allowedResolutions = modelResolutions(effectiveModelId);
  const rawRes = byKey.get("quality") ?? byKey.get("size");
  if (rawRes) {
    const normalized = normalizeResolution(rawRes);
    if (normalized && (allowedResolutions as readonly string[]).includes(normalized)) {
      out.resolution = normalized as OutputResolution;
    }
  }

  return out;
}

/** 有没有任何一项可回填。用来决定要不要显示「助理改了设置」那条提示。 */
export function hasReflectedParams(p: ReflectedParams): boolean {
  return p.modelId !== undefined || p.aspectRatio !== undefined || p.resolution !== undefined;
}
