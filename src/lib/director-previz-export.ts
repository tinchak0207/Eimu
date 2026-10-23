/**
 * 预演关键帧导出胶水（S4）：dataURL → 现有会话附件上传 → https URL → 写回 shot.previz.keyframes。
 * 上传通道复用 DirectorMiniViewport「生成真实画面」同款：
 *   uploadAgentAttachments + mintUploadsTicket + buildAssetUrl
 * 禁止新造存储。
 */
"use client";

import { uploadAgentAttachments } from "@/lib/agent-chat-client";
import { buildAssetUrl, mintUploadsTicket } from "@/lib/agent-uploads";
import { authHeaders } from "@/lib/canvas/client";
import { capturePlanKeyframes, type CapturePlanKeyframesOpts, type CapturedPlanKeyframe } from "@/lib/director-engine/capture-previz";
import type { DirectorEngine } from "@/lib/director-engine/engine";
import type { DirectorElement, DirectorPlan } from "@/lib/director-engine/types";

export type UploadedPrevizKeyframe = {
  shotId: string;
  label: string;
  timeSec: number;
  url: string;
  path: string;
  /** 原始 dataURL（证据落盘用；生产写回不必保留） */
  dataUrl: string;
};

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || "image/png" });
}

/**
 * 把 dataURL 关键帧上传到现有 agent 会话附件通道，返回可进 reference_images 的 https URL。
 * 无会话/未登录时抛错（调用方可 catch 后仅用 dataURL 落盘冒充证据）。
 */
export async function uploadPrevizDataUrls(
  sessionId: string,
  frames: CapturedPlanKeyframe[],
): Promise<UploadedPrevizKeyframe[]> {
  if (!sessionId.trim()) throw new Error("sessionId 为空，无法走附件上传");
  const out: UploadedPrevizKeyframe[] = [];
  // 逐张上传：单张失败不吞，便于定位鉴权/CORS
  for (const frame of frames) {
    const file = await dataUrlToFile(
      frame.dataUrl,
      `previz-${frame.shotId}-${frame.label}-${Date.now()}.png`,
    );
    const [attachment] = await uploadAgentAttachments(sessionId, [file]);
    if (!attachment?.path) throw new Error("上传响应缺少附件路径");
    const { ticket } = await mintUploadsTicket(sessionId);
    const url = buildAssetUrl(sessionId, attachment.path, ticket);
    out.push({
      shotId: frame.shotId,
      label: frame.label,
      timeSec: frame.timeSec,
      url,
      path: attachment.path,
      dataUrl: frame.dataUrl,
    });
  }
  return out;
}

/** 经站内 director 代理写回 shot.previz.keyframes（照抄网关 ShotJson.previz 形状）。 */
export async function writeShotPrevizKeyframes(
  sessionId: string,
  shotId: string,
  keyframeUrls: string[],
  reason: string,
): Promise<{ revision: number }> {
  const auth = authHeaders();
  if (!auth) throw new Error("尚未登录，无法写回预演关键帧。");
  const headers = {
    ...auth,
    "Content-Type": "application/json",
  };
  const resp = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/director/op`, {
    method: "POST",
    headers,
    cache: "no-store",
    body: JSON.stringify({
      ops: [
        {
          op: "updateShot",
          shot_id: shotId,
          patch: { previz: { keyframes: keyframeUrls } },
        },
        { op: "save" },
      ],
      reason,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`director op ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json().catch(() => ({}))) as { revision?: number };
  return { revision: typeof data.revision === "number" ? data.revision : 0 };
}

export type ExportPrevizResult = {
  uploaded: UploadedPrevizKeyframe[];
  /** shotId → 写入的 https URL[] */
  byShot: Record<string, string[]>;
  revisions: Record<string, number>;
  /** 上传失败时仍保留的本地 dataURL（证据用） */
  localOnly?: CapturedPlanKeyframe[];
  uploadError?: string;
};

/**
 * 捕获 + 上传 + 按镜写回 previz.keyframes。
 * 上传因鉴权/无会话失败时：仍返回 localOnly dataURL，不假装已写网关。
 */
export async function exportPlanPrevizKeyframes(
  engine: DirectorEngine,
  plan: DirectorPlan,
  elements: DirectorElement[],
  sessionId: string | null | undefined,
  opts: CapturePlanKeyframesOpts = {},
): Promise<ExportPrevizResult> {
  const captured = capturePlanKeyframes(engine, plan, elements, opts);
  if (!captured.length) {
    return { uploaded: [], byShot: {}, revisions: {} };
  }

  if (!sessionId?.trim()) {
    return {
      uploaded: [],
      byShot: {},
      revisions: {},
      localOnly: captured,
      uploadError: "无会话：已截帧但未上传；代码路径仍接 uploadPrevizDataUrls",
    };
  }

  try {
    const uploaded = await uploadPrevizDataUrls(sessionId, captured);
    const byShot: Record<string, string[]> = {};
    for (const item of uploaded) {
      (byShot[item.shotId] ??= []).push(item.url);
    }
    const revisions: Record<string, number> = {};
    for (const [shotId, urls] of Object.entries(byShot)) {
      const { revision } = await writeShotPrevizKeyframes(
        sessionId,
        shotId,
        urls,
        `S4 previz keyframes ${urls.length} frames`,
      );
      revisions[shotId] = revision;
    }
    return { uploaded, byShot, revisions };
  } catch (err) {
    return {
      uploaded: [],
      byShot: {},
      revisions: {},
      localOnly: captured,
      uploadError: err instanceof Error ? err.message : String(err).slice(0, 300),
    };
  }
}
