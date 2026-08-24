"use client";

/**
 * 模板捕获器命名卡：把一次成功出图的配方（workflow-recall 既有快照）
 * 存为用户具名模板。玻璃 overlay 沿用工作台命令面板的同款形态。
 */

import { useState } from "react";
import { BookmarkPlus, Loader2, X } from "lucide-react";
import type { ImageResult } from "@/lib/image-types";

export interface RecipeTemplateSaveDialogProps {
  /** 要捕获的成片：展示摘要用；配方本身由父级用 buildProvenanceConfig 构造。 */
  image: ImageResult;
  /** workflow-recall 规范化配方（父级 buildProvenanceConfig(image) 的产物）。 */
  config: Record<string, unknown>;
  /** 默认模板名（通常取 workflowPresetLabel / preset label）。 */
  defaultName: string;
  onClose: () => void;
  onSave: (name: string) => Promise<{ ok: boolean; message: string }>;
  /** 保存成功回调：父级负责提示与关闭（成功路径不由 dialog 自行关闭）。 */
  onSaved: (message: string) => void;
}

function summarizePrompt(config: Record<string, unknown>): string {
  const prompt = typeof config.prompt === "string" ? config.prompt.trim() : "";
  return prompt.length > 90 ? `${prompt.slice(0, 90)}…` : prompt || "（无画面描述）";
}

export function RecipeTemplateSaveDialog({
  image,
  config,
  defaultName,
  onClose,
  onSave,
  onSaved,
}: RecipeTemplateSaveDialogProps) {
  const [name, setName] = useState(defaultName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("模板名称不能为空。");
      return;
    }
    setSaving(true);
    setError("");
    const result = await onSave(trimmed);
    setSaving(false);
    if (result.ok) onSaved(result.message);
    else setError(result.message);
  };

  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/55 p-4 backdrop-blur-lg"
      role="dialog"
      aria-modal="true"
      aria-label="存为我的模板"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-ios-3xl lg-sheet p-5"
        style={{ boxShadow: "0 24px 60px rgba(0,0,0,0.18)" }}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p
              className="text-ios-caption2 font-bold uppercase text-muted-foreground"
              style={{ letterSpacing: "0.18em", fontSize: "11px" }}
            >
              模板捕获器
            </p>
            <h3 className="mt-1 text-[17px] font-bold text-foreground">存为我的模板</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/5 text-muted-foreground transition-colors hover:bg-black/10"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-ios-footnote leading-relaxed text-muted-foreground">
          把这张成片的完整配方（画面描述、场景、构图、避免内容、风格、质量档、模型、尺寸）
          存为可复用的具名模板。模板摊开可改，不是黑盒封装。
        </p>

        <div className="mt-3 rounded-ios-2xl bg-white/45 p-3">
          <p className="text-ios-caption2 font-semibold text-foreground/45">配方摘要</p>
          <p className="mt-1 line-clamp-2 text-ios-caption1 font-medium leading-relaxed text-foreground/70">
            {summarizePrompt(config)}
          </p>
          <p className="mt-1 text-ios-caption2 font-semibold text-foreground/45">
            {typeof config.modelId === "string" && config.modelId ? config.modelId : "当前模型"}
            {image.workflow?.imageSize ? ` · ${image.workflow.imageSize}` : ""}
          </p>
        </div>

        <label className="mt-3 block">
          <span className="text-ios-caption1 font-bold text-foreground/60">模板名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={30}
            placeholder="给这份配方起个名字"
            className="mt-1 w-full rounded-ios-xl border-0 bg-white/50 px-3.5 py-2.5 text-ios-footnote text-foreground outline-none ring-0 transition-all focus:bg-white/70 focus:ring-2 focus:ring-ios-blue/20"
            autoFocus
          />
        </label>

        {error && <p className="mt-2 text-ios-caption1 font-semibold text-red-500">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white/55 px-5 py-2.5 text-ios-footnote font-bold text-muted-foreground transition-colors hover:bg-white/80"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#2d3142] px-6 py-2.5 text-ios-footnote font-bold text-white transition-transform duration-300 hover:scale-[1.03] active:scale-95 disabled:opacity-60"
            style={{ transitionTimingFunction: "cubic-bezier(0.34,1.56,0.64,1)" }}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookmarkPlus className="h-3.5 w-3.5" />}
            {saving ? "保存中…" : "保存模板"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default RecipeTemplateSaveDialog;
