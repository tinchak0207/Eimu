"use client";

import { useState } from "react";
import type { ChangeEvent } from "react";
import { LOCAL_TEST_MODE } from "@/lib/local-test-mode";
import {
  PixaiError,
  type PickedImage,
  resolveToPayload,
  runEdit,
  runUpscale,
  uploadMedia,
} from "@/components/pixai-tools/shared";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";

/** 改图比例胶囊：跟随原图 = 服务端回退 1024x1024，其余按固定尺寸传给 edit API。 */
export type PixaiRatioKey = "original" | "1:1" | "4:3" | "3:4" | "9:16";
export const PIXAI_RATIO_SIZES: Record<Exclude<PixaiRatioKey, "original">, string> = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "9:16": "768x1365",
};
export const PIXAI_RATIO_CHIPS: PixaiRatioKey[] = ["original", "1:1", "4:3", "3:4", "9:16"];

export type PixaiStage = "idle" | "uploading" | "generating" | "done" | "error";

const redirectToGithub = () => {
  window.location.href = "/api/auth/github/start";
};

export const pickSourceFile = (
  e: ChangeEvent<HTMLInputElement>,
  onPick: (image: PickedImage) => void,
) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  onPick({
    source: { kind: "file", file, mimeType: file.type || "image/png" },
    previewUrl: URL.createObjectURL(file),
    label: file.name,
  });
};

/**
 * 改图完整管线（Task 3 自 PromptInput 抽出）：来源图 / 比例 / 阶段 / 结果的
 * 10 个 state 中属于改图的 5 个 + 送出 handler。模式切换只换控件区，状态保留。
 */
export function usePixaiEdit({
  prompt,
  isLoggedIn,
  onEditResult,
  suppress,
}: {
  /** 描述框正文：改图提示词与空文案校验都用它。 */
  prompt: string;
  isLoggedIn?: boolean;
  onEditResult?: (url: string) => void;
  /** D-24 提示抑制下發（useAgentHint 回傳）：三條送出路徑閉包共享同一個。 */
  suppress: () => void;
}) {
  const { token, user } = useAuth();
  const { toast } = useToast();
  const [editSource, setEditSource] = useState<PickedImage | null>(null);
  const [editRatio, setEditRatio] = useState<PixaiRatioKey>("original");
  const [editStage, setEditStage] = useState<PixaiStage>("idle");
  const [editError, setEditError] = useState("");
  const [editResultUrl, setEditResultUrl] = useState("");

  const editBusy = editStage === "uploading" || editStage === "generating";

  const handleEditSubmit = async () => {
    if (!editSource) {
      toast({ title: "请先选择图片", variant: "destructive" });
      return;
    }
    if (!prompt.trim()) {
      toast({ title: "请描述想改成什么样子", variant: "destructive" });
      return;
    }
    if (!LOCAL_TEST_MODE && !isLoggedIn) {
      redirectToGithub();
      return;
    }
    const tokenValue = token ?? "";
    // 编辑请求已送出：之后的看图/调整时段不再弹「AI 助理帮你完成」。
    suppress();
    try {
      setEditError("");
      setEditStage("uploading");
      const payload = await resolveToPayload(editSource.source);
      const mediaId = await uploadMedia(payload, tokenValue, user?.id ?? 0);
      setEditStage("generating");
      const size = editRatio === "original" ? "1024x1024" : PIXAI_RATIO_SIZES[editRatio];
      const url = await runEdit({ mediaId, prompt: prompt.trim(), size, token: tokenValue, userId: user?.id ?? 0 });
      setEditResultUrl(url);
      setEditStage("done");
      onEditResult?.(url);
    } catch (e) {
      const message = e instanceof PixaiError ? e.message : e instanceof Error ? e.message : "生成失败，请重试";
      setEditError(message);
      setEditStage("error");
      toast({ title: "改图失败", description: message, variant: "destructive" });
    }
  };

  return {
    editSource,
    setEditSource,
    editRatio,
    setEditRatio,
    editStage,
    setEditStage,
    editError,
    setEditError,
    editResultUrl,
    setEditResultUrl,
    editBusy,
    handleEditSubmit,
  };
}

/**
 * 放大完整管线（Task 3 自 PromptInput 抽出）：来源图 / 原始尺寸 / 阶段 / 结果
 * 的 5 个 state + 送出 handler。与改图同构，但不吃描述框正文。
 */
export function usePixaiUpscale({
  isLoggedIn,
  onUpscaleResult,
  suppress,
}: {
  isLoggedIn?: boolean;
  onUpscaleResult?: (url: string) => void;
  /** D-24 提示抑制下發（useAgentHint 回傳）：三條送出路徑閉包共享同一個。 */
  suppress: () => void;
}) {
  const { token, user } = useAuth();
  const { toast } = useToast();
  const [upscaleSource, setUpscaleSource] = useState<PickedImage | null>(null);
  const [upscaleSourceSize, setUpscaleSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [upscaleStage, setUpscaleStage] = useState<PixaiStage>("idle");
  const [upscaleError, setUpscaleError] = useState("");
  const [upscaleResultUrl, setUpscaleResultUrl] = useState("");

  const upscaleBusy = upscaleStage === "uploading" || upscaleStage === "generating";

  const handleUpscaleSubmit = async () => {
    if (!upscaleSource) {
      toast({ title: "请先选择图片", variant: "destructive" });
      return;
    }
    if (!LOCAL_TEST_MODE && !isLoggedIn) {
      redirectToGithub();
      return;
    }
    const tokenValue = token ?? "";
    // 放大请求已送出：之后的看图/调整时段不再弹「AI 助理帮你完成」。
    suppress();
    try {
      setUpscaleError("");
      setUpscaleStage("uploading");
      const payload = await resolveToPayload(upscaleSource.source);
      const mediaId = await uploadMedia(payload, tokenValue, user?.id ?? 0);
      setUpscaleStage("generating");
      const sizeLabel = upscaleSourceSize ? `${upscaleSourceSize.width}x${upscaleSourceSize.height}` : undefined;
      const url = await runUpscale({ mediaId, factor: 2, size: sizeLabel, token: tokenValue, userId: user?.id ?? 0 });
      setUpscaleResultUrl(url);
      setUpscaleStage("done");
      onUpscaleResult?.(url);
    } catch (e) {
      const message = e instanceof PixaiError ? e.message : e instanceof Error ? e.message : "生成失败，请重试";
      setUpscaleError(message);
      setUpscaleStage("error");
      toast({ title: "放大失败", description: message, variant: "destructive" });
    }
  };

  return {
    upscaleSource,
    setUpscaleSource,
    upscaleSourceSize,
    setUpscaleSourceSize,
    upscaleStage,
    setUpscaleStage,
    upscaleError,
    setUpscaleError,
    upscaleResultUrl,
    setUpscaleResultUrl,
    upscaleBusy,
    handleUpscaleSubmit,
  };
}
