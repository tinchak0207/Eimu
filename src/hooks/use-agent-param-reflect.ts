"use client";

import { useCallback, useState } from "react";
import type { AspectRatio, OutputResolution } from "@/lib/generation-model-catalog";
import type { ReflectedParams } from "@/lib/agent-param-reflect";

/** D-12 撤销条上的项目名。顺序即显示顺序。 */
export const AGENT_PARAM_LABELS: ReadonlyArray<{
  key: "modelId" | "aspectRatio" | "resolution";
  label: string;
}> = [
  { key: "modelId", label: "模型" },
  { key: "aspectRatio", label: "比例" },
  { key: "resolution", label: "解析度" },
];

export interface UseAgentParamReflectOptions {
  /** 现行模型 id（快照 baseline 用，即调用方的 selectedModels.image_tinchak）。 */
  modelId: string;
  aspectRatio: AspectRatio;
  outputResolution: OutputResolution;
  /** 模型切换的统一入口（调用方保证稳定引用的 useCallback）。 */
  handleModelChange: (modelId: string) => void;
  setAspectRatio: (next: AspectRatio) => void;
  setOutputResolution: (next: OutputResolution) => void;
}

/**
 * D-12：助理动过的参数回流到工作台控件（三态复原）。
 *
 * 三态就是这里的 baseline / 现值 两者比对出来的：
 *   原值      = agentBaseline 里存的那份（助理第一次改之前的快照）
 *   agent 改成 = agentTouched 里有这个 key，且现值 !== baseline
 *   使用者手改 = 使用者自己动了控件 → 该 key 从 agentTouched 移除
 * 只快照一次：助理连改三轮，「恢复我的设定」也要回到它插手之前那一版。
 *
 * 参数本体（modelId/aspectRatio/outputResolution 的 state）仍归调用方所有——
 * 这里只持有 baseline/touched 两份标记与包装 setter。
 */
export function useAgentParamReflect({
  modelId,
  aspectRatio,
  outputResolution,
  handleModelChange,
  setAspectRatio,
  setOutputResolution,
}: UseAgentParamReflectOptions) {
  const [agentBaseline, setAgentBaseline] = useState<{
    modelId: string;
    aspectRatio: AspectRatio;
    resolution: OutputResolution;
  } | null>(null);
  const [agentTouched, setAgentTouched] = useState<Set<"modelId" | "aspectRatio" | "resolution">>(
    new Set(),
  );

  const handleParamsReflected = useCallback((params: ReflectedParams) => {
    setAgentBaseline((prev) =>
      prev ?? {
        modelId,
        aspectRatio,
        resolution: outputResolution,
      },
    );
    const touched = new Set<"modelId" | "aspectRatio" | "resolution">();
    if (params.modelId !== undefined) {
      touched.add("modelId");
      handleModelChange(params.modelId);
    }
    // 模型换了之后比例/解析度的合法集合也变了，但 reflectParams 已按
    // 助理选的模型校验过，这里直接写入即可。
    if (params.aspectRatio !== undefined) {
      touched.add("aspectRatio");
      setAspectRatio(params.aspectRatio);
    }
    if (params.resolution !== undefined) {
      touched.add("resolution");
      setOutputResolution(params.resolution);
    }
    setAgentTouched((prev) => new Set([...prev, ...touched]));
  }, [modelId, aspectRatio, outputResolution, handleModelChange, setAspectRatio, setOutputResolution]);

  /** 逐项撤销：把某一项还原成助理插手之前的值。 */
  const undoAgentParam = useCallback((key: "modelId" | "aspectRatio" | "resolution") => {
    if (!agentBaseline) return;
    if (key === "modelId") handleModelChange(agentBaseline.modelId);
    if (key === "aspectRatio") setAspectRatio(agentBaseline.aspectRatio);
    if (key === "resolution") setOutputResolution(agentBaseline.resolution);
    setAgentTouched((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, [agentBaseline, handleModelChange, setAspectRatio, setOutputResolution]);

  // 三态里的第三态：使用者自己动了控件 → 这一项不再算「agent 改成」。
  // 关键是不共用 setter：助理回流走 setAspectRatio/setOutputResolution 原始
  // setter，使用者走下面这两个包装。这样不需要任何「现在是谁在改」的标志位，
  // 也就没有标志位漏关导致误判的可能。
  const userSetAspectRatio = useCallback((next: AspectRatio) => {
    setAspectRatio(next);
    setAgentTouched((prev) => {
      if (!prev.has("aspectRatio")) return prev;
      const s = new Set(prev);
      s.delete("aspectRatio");
      return s;
    });
  }, [setAspectRatio]);

  const userSetOutputResolution = useCallback((next: OutputResolution) => {
    setOutputResolution(next);
    setAgentTouched((prev) => {
      if (!prev.has("resolution")) return prev;
      const s = new Set(prev);
      s.delete("resolution");
      return s;
    });
  }, [setOutputResolution]);

  const userSetModel = useCallback((next: string) => {
    handleModelChange(next);
    // 换模型会顺带重置比例与解析度（normalizeGenerationConfig），
    // 所以这三项的 agent 标记一起清掉，否则会留下指向旧模型的假标记。
    setAgentTouched((prev) => (prev.size === 0 ? prev : new Set()));
  }, [handleModelChange]);

  /** 全局「恢复我的设定」：三项一起回到助理插手之前。 */
  const restoreMyParams = useCallback(() => {
    if (!agentBaseline) return;
    handleModelChange(agentBaseline.modelId);
    setAspectRatio(agentBaseline.aspectRatio);
    setOutputResolution(agentBaseline.resolution);
    setAgentTouched(new Set());
  }, [agentBaseline, handleModelChange, setAspectRatio, setOutputResolution]);

  return {
    agentBaseline,
    agentTouched,
    handleParamsReflected,
    undoAgentParam,
    restoreMyParams,
    userSetAspectRatio,
    userSetOutputResolution,
    userSetModel,
  };
}
