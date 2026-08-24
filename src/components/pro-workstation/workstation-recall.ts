"use client";

import type { Dispatch, SetStateAction } from "react";
import { WORKFLOW_SCHEMA_VERSION } from "@/lib/generation-workflow";
import type { PersistedGenerationEntry } from "@/lib/generation-cache";
import type { ImageResult, ReferenceImage } from "@/lib/image-types";
import { normalizeSizeSelection } from "@/lib/ad-formats";
import { extractPromptSection, parseWorkflowRecallConfig, type WorkflowRecallConfig } from "@/lib/workflow-recall";
import { getStyleById } from "@/lib/style-library";
import { modelBaseName } from "@/lib/generation-model-catalog";
import {
  WORKFLOW_PRESETS,
  type LeftPanelTab,
  type NoticeLevel,
  type RegionalPromptItem,
  type TemplateStateSnapshot,
  type WorkstationPreset,
  useEventCallback,
} from "./workstation-constants";

export interface WorkstationRecallSetters {
  setPrompt: Dispatch<SetStateAction<string>>;
  setContextPrompt: Dispatch<SetStateAction<string>>;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  setWorkflowPreset: Dispatch<SetStateAction<string>>;
  setProductionIntent: Dispatch<SetStateAction<string>>;
  setImageSizes: Dispatch<SetStateAction<string[]>>;
  setStyleTemplateId: Dispatch<SetStateAction<string | null>>;
  setQualityProfile: Dispatch<SetStateAction<string>>;
  setSeedHint: Dispatch<SetStateAction<string>>;
  setCopies: Dispatch<SetStateAction<number>>;
  setConcurrency: Dispatch<SetStateAction<number>>;
  setTemplateUndo: Dispatch<SetStateAction<{ label: string; snapshot: TemplateStateSnapshot } | null>>;
  setRegionalPrompts: Dispatch<SetStateAction<RegionalPromptItem[]>>;
}

export interface WorkstationRecallApi {
  buildProvenanceConfig: (image?: ImageResult) => Record<string, unknown>;
  copyProvenanceConfig: (image?: ImageResult) => Promise<void>;
  restoreProvenanceConfig: () => void;
  restoreProvenanceConfigFromPng: (workflowJson: string) => void;
  restoreHistoryEntry: (entry: PersistedGenerationEntry) => void;
  /** R 键复用：把这张成片的完整配方（六槽提示词/模型/尺寸/角色/区域提示词/seed）回填进表单。 */
  applyResultRecipe: (image?: ImageResult) => boolean;
  /** 模板=六槽具名 profile：把一份配方（内置模板/用户模板）摊开进表单，可撤销可改。 */
  applyRecipeTemplate: (config: WorkflowRecallConfig & { modelId?: string }, label: string) => boolean;
}

/**
 * 配置召回（2026-08-22 从 InvokeInspiredWorkstation 拆出）。
 *
 * 拥有「这张成片当时的配置」的权威构造（buildProvenanceConfig，下载 PNG 嵌入、
 * 复制配置、历史还原三方共用）与粘贴 JSON / PNG 内嵌工作流 / 历史记录三条
 * 还原路径。编辑器 state 留在入口，通过 setters 物件参数化写回。
 */
export function useWorkstationRecall(options: {
  modelId: string;
  prompt: string;
  contextPrompt: string;
  negativePrompt: string;
  workflowPreset: string;
  productionIntent: string;
  imageSize: string;
  imageSizes: string[];
  styleTemplateId: string | null;
  qualityProfile: string;
  seedHint: string;
  copies: number;
  concurrency: number;
  activeRegionalPrompts: RegionalPromptItem[];
  activePreset: WorkstationPreset;
  referenceImages: ReferenceImage[];
  restoreConfigText: string;
  promptForResult: (image: ImageResult) => string | undefined;
  captureTemplateState: () => TemplateStateSnapshot;
  onModelChange: (modelId: string) => void;
  onReferenceImagesChange: (images: ReferenceImage[]) => void;
  setCanvasNotice: (text: string, level?: NoticeLevel) => void;
  setLeftPanelTab: (tab: LeftPanelTab) => void;
  setRestoreConfigMessage: (message: string) => void;
  setters: WorkstationRecallSetters;
}): WorkstationRecallApi {
  const {
    modelId,
    prompt,
    contextPrompt,
    negativePrompt,
    workflowPreset,
    productionIntent,
    imageSize,
    imageSizes,
    styleTemplateId,
    qualityProfile,
    seedHint,
    copies,
    concurrency,
    activeRegionalPrompts,
    activePreset,
    referenceImages,
    restoreConfigText,
    promptForResult,
    captureTemplateState,
    onModelChange,
    onReferenceImagesChange,
    setCanvasNotice,
    setLeftPanelTab,
    setRestoreConfigMessage,
    setters,
  } = options;
  const {
    setPrompt,
    setContextPrompt,
    setNegativePrompt,
    setWorkflowPreset,
    setProductionIntent,
    setImageSizes,
    setStyleTemplateId,
    setQualityProfile,
    setSeedHint,
    setCopies,
    setConcurrency,
    setTemplateUndo,
    setRegionalPrompts,
  } = setters;

  const restoreRegionalPrompts = (entries?: Array<{ text: string; weight?: number }>) => {
    if (!entries?.length) return;
    setRegionalPrompts(entries.map((entry, index) => ({
      id: `recall-${Date.now()}-${index}`,
      text: entry.text,
      enabled: true,
    })));
  };

  /**
   * 以「这张成片的」配置为准，缺字段才回落到当前编辑器 state。
   *
   * 与 copyProvenanceConfig / downloadResult（PNG 嵌入）共用同一个权威来源，
   * 避免「可以复现的东西会在两处各写一份各不相同」。
   */
  const buildProvenanceConfig = (image?: ImageResult) => {
    const workflow = image?.workflow;
    return {
      schemaVersion: workflow?.schemaVersion ?? WORKFLOW_SCHEMA_VERSION,
      prompt: (image ? promptForResult(image) : undefined) ?? prompt.trim(),
      contextPrompt: workflow?.contextPrompt ?? contextPrompt.trim(),
      negativePrompt: workflow?.negativePrompt ?? negativePrompt.trim(),
      workflowPreset: workflow?.workflowPreset ?? workflowPreset,
      workflowPresetLabel: workflow?.workflowPresetLabel ?? activePreset.label,
      promptHint: workflow?.promptHint ?? activePreset.promptHint,
      negativeHint: workflow?.negativeHint ?? activePreset.negativeHint,
      productionIntent: workflow?.productionIntent ?? productionIntent,
      imageSize: workflow?.imageSize ?? imageSize,
      imageSizes: workflow?.imageSizes ?? imageSizes,
      styleTemplate: workflow?.styleTemplate ?? styleTemplateId ?? undefined,
      qualityProfile: workflow?.qualityProfile ?? qualityProfile,
      seedHint: workflow?.seedHint ?? seedHint,
      regionalPrompts: workflow?.regionalPrompts
        ?? activeRegionalPrompts.map((item) => ({ text: item.text.trim() })),
      copies: workflow?.copies ?? copies,
      concurrency: workflow?.concurrency ?? concurrency,
      modelId: image?.modelId ?? modelId,
      referenceImages: workflow?.referenceImages ?? referenceImages.map((ref) => ({
        name: ref.name,
        role: ref.role ?? activePreset.defaultRole,
        size: ref.size,
        strength: ref.strength ?? 80,
      })),
    };
  };

  /**
   * R 键「复用当前结果」的配方回填：除参考图外，把这张成片当时的完整配方
   * （六槽提示词、negative、模型 id、尺寸、质量档、seed、区域提示词、参考图角色）
   * 全量预填进工作台表单，让用户从套用者变成理解结构的创作者。
   *
   * 与复制配置 / PNG 嵌入共用同一个权威来源 buildProvenanceConfig，避免同一张图
   * 的配方在两处各写一份；走 parseWorkflowRecallConfig 校验，与粘贴 / PNG 还原
   * 完全同一条路径。整份覆盖前先存撤销快照，与其他还原动作同一套机制。
   * 成片没有 workflow 元数据也没有模型信息时（如历史合成的裸图）返回 false，
   * 复用动作退回「只放参考图」的旧行为。
   */
  const applyResultRecipe = useEventCallback((image?: ImageResult): boolean => {
    if (!image) return false;
    const recipeModelId = typeof image.modelId === "string" && image.modelId ? image.modelId : undefined;
    if (!image.workflow && !recipeModelId) return false;
    const config = buildProvenanceConfig(image);
    const result = parseWorkflowRecallConfig(JSON.stringify(config));
    if (!result.ok) return false;
    setTemplateUndo({ label: "回填成片配方", snapshot: captureTemplateState() });
    if (recipeModelId && recipeModelId !== modelId) onModelChange(recipeModelId);
    applyWorkflowRecallConfig(result.config);
    return true;
  });

  /**
   * 模板套用（模板=六槽具名 profile）：与 R 键回填同一条解析路径
   * （parseWorkflowRecallConfig），但语义是「整份替换」——
   * 模板没有声明风格槽时显式清空当前风格，保证套用后六槽就是模板的六槽，
   * 摊开在提示词页可改，而不是和旧表单残余混在一起。
   * 用户模板带 modelId（契约加法式扩展）时一并切回当时的模型。
   */
  const applyRecipeTemplate = useEventCallback((
    config: WorkflowRecallConfig & { modelId?: string },
    label: string,
  ): boolean => {
    const result = parseWorkflowRecallConfig(JSON.stringify(config));
    if (!result.ok) {
      setCanvasNotice("这份模板的配方无法解析。", "warn");
      return false;
    }
    setTemplateUndo({ label: `套用模板「${label}」`, snapshot: captureTemplateState() });
    const templateModelId = config.modelId?.trim();
    if (templateModelId && templateModelId !== modelId) onModelChange(templateModelId);
    // 空字符串/缺省都算「模板声明风格槽为空」：显式清空，保证六槽=模板的六槽
    // （空串经 parseWorkflowRecallConfig 会被剥成缺省，所以判据放在 parse 前的输入上）
    if (!config.styleTemplate?.trim()) setStyleTemplateId(null);
    applyWorkflowRecallConfig(result.config);
    setLeftPanelTab("prompt");
    setCanvasNotice(`已套用模板「${label}」，六槽已摊开可改，可撤销。`);
    return true;
  });

  /**
   * 复制「这张成片的」配置，而不是「编辑器现在的」配置。
   *
   * 旧版无论点哪张图，导出的 JSON 全部读当前 state —— 只有 modelId 来自那张图。
   * 于是「复制配置 → 粘贴回来复现」得到的是现在的参数配上旧模型名，
   * 这个功能存在的唯一理由（复现某张图）恰好是它做不到的事。
   * 传入的成片带 workflow 元数据时以它为准，缺字段才回落到当前 state。
   */
  const copyProvenanceConfig = async (image?: ImageResult) => {
    const fromResult = Boolean(image?.workflow);
    const config = buildProvenanceConfig(image);
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    setCanvasNotice(fromResult ? "已复制这张成片的配置。" : "已复制当前配置。");
  };

  /** 把解析出的工作流配置写回编辑器（粘贴 JSON 与 PNG 内嵌工作流共用）。 */
  const applyWorkflowRecallConfig = (config: WorkflowRecallConfig) => {
    if (config.prompt !== undefined) setPrompt(config.prompt);
    if (config.contextPrompt !== undefined) setContextPrompt(config.contextPrompt);
    if (config.negativePrompt !== undefined) setNegativePrompt(config.negativePrompt);
    if (config.workflowPreset && WORKFLOW_PRESETS.some((preset) => preset.id === config.workflowPreset)) {
      setWorkflowPreset(config.workflowPreset);
    }
    if (config.productionIntent) setProductionIntent(config.productionIntent);
    if (config.imageSizes?.length) {
      setImageSizes(normalizeSizeSelection(config.imageSizes));
    } else if (config.imageSize) {
      setImageSizes(normalizeSizeSelection([config.imageSize]));
    }
    if (config.styleTemplate !== undefined) {
      setStyleTemplateId(getStyleById(config.styleTemplate)?.id ?? null);
    }
    if (config.qualityProfile) setQualityProfile(config.qualityProfile);
    if (config.seedHint !== undefined) setSeedHint(config.seedHint);
    if (config.copies) setCopies(config.copies);
    if (config.concurrency) setConcurrency(config.concurrency);
    restoreRegionalPrompts(config.regionalPrompts);
    if (config.referenceImageRolesByName) {
      onReferenceImagesChange(referenceImages.map((image) => {
        const role = config.referenceImageRolesByName?.[image.name];
        return role ? { ...image, role } : image;
      }));
    }
  };

  const restoreProvenanceConfig = () => {
    const result = parseWorkflowRecallConfig(restoreConfigText);
    if (!result.ok) {
      setRestoreConfigMessage(result.error);
      return;
    }

    applyWorkflowRecallConfig(result.config);
    setRestoreConfigMessage("配置已导入。");
  };

  /** 拖入带内嵌工作流的 PNG 时的一键还原：沿用粘贴还原路径，并补回模型。 */
  const restoreProvenanceConfigFromPng = useEventCallback((workflowJson: string) => {
    const result = parseWorkflowRecallConfig(workflowJson);
    if (!result.ok) {
      setRestoreConfigMessage(result.error);
      setCanvasNotice("这张图片的内嵌工作流无法还原。", "warn");
      return;
    }

    setTemplateUndo({ label: "还原 PNG 工作流", snapshot: captureTemplateState() });
    let embeddedModelId: string | undefined;
    try {
      const raw = JSON.parse(workflowJson) as { modelId?: unknown };
      embeddedModelId = typeof raw.modelId === "string" ? raw.modelId : undefined;
    } catch {
      // parseWorkflowRecallConfig 已保证可解析，这里只是取额外字段
    }
    if (embeddedModelId && embeddedModelId !== modelId) onModelChange(embeddedModelId);

    applyWorkflowRecallConfig(result.config);
    setLeftPanelTab("prompt");
    setRestoreConfigMessage("已还原 PNG 内嵌的工作流。");
    setCanvasNotice(embeddedModelId && embeddedModelId !== modelId
      ? `已还原 PNG 内嵌的工作流，并切回 ${modelBaseName(embeddedModelId)}。可撤销。`
      : "已还原 PNG 内嵌的工作流。可撤销。");
  });

  const restoreHistoryEntry = (entry: PersistedGenerationEntry) => {
    const workflow = entry.workflow;
    /**
     * 恢复历史会整份覆盖编辑器，因此先存一份撤销快照 —— 与「套用场景 / 套用模板」
     * 同一套机制。旧版这里没有快照：点错一条历史记录，正在写的提示词、尺寸、张数
     * 全部消失且无法回退。
     */
    setTemplateUndo({ label: "恢复历史", snapshot: captureTemplateState() });
    /**
     * 模型也要跟着回到当时那个。
     *
     * 旧版只改本地状态、从不调 onModelChange，于是恢复一条 PixAI 的历史后，
     * 界面显示的是历史里的参数、真正发请求用的却是当前模型 —— 出图与预期不符，
     * 且完全没有任何提示。
     */
    const historyModelId = entry.results.find((result) => result.modelId)?.modelId;
    if (historyModelId && historyModelId !== modelId) onModelChange(historyModelId);
    setPrompt(extractPromptSection(entry.prompt));
    setContextPrompt(workflow?.contextPrompt ?? "");
    setNegativePrompt(workflow?.negativePrompt ?? "");
    if (workflow?.workflowPreset && WORKFLOW_PRESETS.some((preset) => preset.id === workflow.workflowPreset)) {
      setWorkflowPreset(workflow.workflowPreset);
    }
    if (workflow?.productionIntent) setProductionIntent(workflow.productionIntent);
    if (workflow?.imageSizes?.length) {
      setImageSizes(normalizeSizeSelection(workflow.imageSizes));
    } else if (workflow?.imageSize) {
      setImageSizes(normalizeSizeSelection([workflow.imageSize]));
    }
    // 历史记录里的提示词已包含风格文本，这里不再恢复风格，避免二次套用
    setStyleTemplateId(null);
    if (workflow?.qualityProfile) setQualityProfile(workflow.qualityProfile);
    setSeedHint(workflow?.seedHint ?? "");
    if (workflow?.copies) setCopies(workflow.copies);
    if (workflow?.concurrency) setConcurrency(workflow.concurrency);
    restoreRegionalPrompts(workflow?.regionalPrompts);
    if (workflow?.referenceImages?.length) {
      const rolesByName = Object.fromEntries(workflow.referenceImages.map((image) => [image.name, image.role]));
      onReferenceImagesChange(referenceImages.map((image) => {
        const role = rolesByName[image.name];
        return role ? { ...image, role } : image;
      }));
    }
    setLeftPanelTab("prompt");
    // 提示走画布通知：setRestoreConfigMessage 只渲染在右栏「导入配置」手风琴里，
    // 而历史列表在另一个 tab —— 旧版恢复成功后用户看不到任何反馈。
    setRestoreConfigMessage("已恢复最近任务。");
    setCanvasNotice(
      historyModelId && historyModelId !== modelId
        ? `已恢复这条历史，并切回 ${modelBaseName(historyModelId)}。可撤销。`
        : "已恢复这条历史的全部参数。可撤销。",
    );
  };

  return {
    buildProvenanceConfig,
    copyProvenanceConfig,
    restoreProvenanceConfig,
    restoreProvenanceConfigFromPng,
    restoreHistoryEntry,
    applyResultRecipe,
    applyRecipeTemplate,
  };
}
