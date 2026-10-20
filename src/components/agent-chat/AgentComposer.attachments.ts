import type { AgentAttachmentRef } from "@/lib/agent-chat-types";
import type { PendingAttachment } from "./AgentComposer.types";

/**
 * 输入框跟着内容长高，上限交给 CSS 的 max-h-[15rem]（=240px＠16px 根字级）（到顶后自己滚）。
 * rows=1 的固定高度下，续写一段长愿望只能看见最后一行，看不到自己写了什么。
 */
export function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** 释放一条 chip 持有的所有 Object URL（原片 + 缩图）。 */
export function releaseUrls(att: PendingAttachment) {
  if (att.videoUrl) URL.revokeObjectURL(att.videoUrl);
  att.frames?.forEach((f) => URL.revokeObjectURL(f.url));
}

/** 附件的存储路径（path），写进 [附件] 区块的「1. {path} | {mime} | {size}」。 */
function attachmentLine(ref: AgentAttachmentRef): string {
  const mime = ref.mime ?? "application/octet-stream";
  const size = typeof ref.size === "number" ? String(ref.size) : "?";
  return `${ref.path} | ${mime} | ${size}`;
}

export function buildAttachmentBlock(attachments: AgentAttachmentRef[]): string {
  const lines = attachments
    .map((ref, i) => `${i + 1}. ${attachmentLine(ref)}`)
    .join("\n");
  return `\n[ATTACHMENTS_BLOCK]\n[附件]\n${lines}\n[/ATTACHMENTS_BLOCK]`;
}

/** 是否存在仍在 uploading/extracting 的附件——存在时禁止送出。纯函数，可直测。 */
export function hasPendingAttachments(attachments: Pick<PendingAttachment, "status">[]): boolean {
  return attachments.some((a) => a.status === "uploading" || a.status === "extracting");
}

/** 送出资格：有文字或有已就绪附件，且没有仍在途的附件。纯函数，可直测。 */
export function computeCanSend(
  trimmedText: string,
  readyRefCount: number,
  attachments: Pick<PendingAttachment, "status">[],
): boolean {
  return (Boolean(trimmedText) || readyRefCount > 0) && !hasPendingAttachments(attachments);
}

/**
 * 「在途」的下一个值（纯函数，可直测）。内部送出锁或面板喂进来的在途任一为真
 * 就是在途；两边都放下才真的放下（面板收了在途、但输入区自己的投递还在飞，
 * 仍然是在途）。回传 null ＝与当前值相同、不必动——render 期收敛靠这个 bail out，
 * 不然每次渲染都要多跑一轮。
 */
export function nextSendBusy(
  current: boolean,
  internalSendInFlight: boolean,
  externalSendPending: boolean,
): boolean | null {
  const next = internalSendInFlight || externalSendPending;
  return next === current ? null : next;
}
