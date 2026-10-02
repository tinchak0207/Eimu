// Media endpoint resolution for agent-poller.
//
// Background (why this module exists): the poller used to build the poll URL as
// `/v1/images/{task_id}` for EVERY task kind, and always emitted `image.done` on
// success. Video job ids do NOT live in the /v1/images namespace, so a video
// task 404'd on every tick, backed off for its whole 30-minute lifetime and died
// with zero frames — never producing a card. The sibling tool
// `opencode-runtime/tools/image_get_result.ts:47-56` already knew this and falls
// back to `/videos/{id}` on 404; the poller never received that fix because it
// had no repo source of truth.
//
// Keeping kind→path and kind→event in one tested place makes the two mappings
// impossible to drift apart again.

export type TaskKind = "image" | "video";

/**
 * Platform poll path for a task.
 * image → /v1/images/{id} ; video → /v1/videos/{id}
 * The id is URL-encoded (ids may contain "/" or spaces).
 */
export function pollPathFor(kind: TaskKind, taskId: string): string {
  const namespace = kind === "video" ? "videos" : "images";
  return `/v1/${namespace}/${encodeURIComponent(taskId)}`;
}

/** Terminal success event the gateway/frontend route on. */
export function doneEventFor(kind: TaskKind): "image.done" | "video.done" {
  return kind === "video" ? "video.done" : "image.done";
}
