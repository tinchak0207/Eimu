// Media endpoint resolution for agent-poller.
//
// Background (why this module exists): the poller used to emit `image.done` on
// EVERY task kind. A finished video is an .mp4, but `image.done` makes the
// frontend render it into an <img> — a broken image, so the video card never
// showed. Keeping kind→event (and kind→path) in one tested place makes the
// mappings impossible to drift apart again.
//
// ROOT-CAUSE CORRECTION (2026-10-02; the original assumption is overturned).
// An earlier version of this comment claimed video job ids "do NOT live in the
// /v1/images namespace", so a video task 404'd on every tick. That is FALSE and
// was disproven against the live site:
//   - src/app/api/v1/images/[id]/route.ts:45 and
//     src/app/api/v1/videos/[id]/route.ts:24 call the SAME
//     getGenerationJobForTenant(id, "biz:" + key.id).
//   - src/lib/generation-core/job-repository.ts:200-202 runs
//     `SELECT * FROM generation_job WHERE id = ? AND tenant_id = ? LIMIT 1`
//     with NO kind filter.
//   - So `/v1/images/{videoId}` returns 200 for the same key that owns the job.
//     The real 404 cause is a TENANT MISMATCH (a different key, or the fallback
//     HARNESS_API_KEY), not a namespace. nginx access logs confirm the old code
//     did get 200 from `/v1/images/<id>` for a video-kind task.
//   - Routing video polls to `/v1/videos/{id}` is therefore a NO-OP against the
//     current site implementation: correct direction, but not a necessary fix.
//
// The half of the 2026-10-02 fix that was REAL is kind→event: emitting
// `video.done` (with media_kind:"video") instead of `image.done`, so the .mp4 is
// delivered as a video rather than jammed into an <img> as a broken image.

export type TaskKind = "image" | "video";

/**
 * Platform poll path for a task.
 * image → /v1/images/{id} ; video → /v1/videos/{id}
 * NOTE (2026-10-02): both endpoints share the same tenant-scoped lookup with no
 * kind filter (see the correction above), so either path resolves for the owning
 * key. This mapping is therefore cosmetic on the current site; it is kept for
 * clear intent and forward compatibility with older site versions.
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
