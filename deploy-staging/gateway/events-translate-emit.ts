import type { SessionState } from "./types-gateway.ts"
import { PLATFORM_BASE, IMAGE_URL_DEDUP_CAP, TOOL_STATUS_DEDUP_CAP } from "./constants-gateway.ts"
import { emitToSession } from "./sse-core.ts"
import { emitQuotaChanged, appendLedgerFor } from "./quota-ledger.ts"
import { flushPendingCompact } from "./messages-gw.ts"
import { boundMap, boundSet } from "./events-translate-core.ts"
import { emitCanvasResult } from "./events-translate-canvas.ts"
import type { AudioDoneMeta } from "./events-translate-types.ts"
// Shared image.done emission path, deduped per session by url (bounded Set, cap
// 100, evict oldest). Both the opencode tool-result translation and the
// /internal/emit entry point go through here, so the same image can never be
// announced twice to the frontend in one session.
// The platform hands back /v1/images/<id>/result — relative, Bearer-authed, and
// a 302 to a public store.tinchak0207.xyz .webp. An <img src> can send neither a
// host nor an auth header, and the frontend must never hold a backend key, so
// that URL is unrenderable as-is. Resolve the redirect here, server-side, and
// publish the terminal public URL instead.
//
// Verified 2026-08-07: GET the result path with the session key -> 302; Location
// is an unsigned, query-less, publicly readable image/webp (200 without auth).
// Because it carries no signature there is nothing to expire or leak.
export async function resolveResultUrl(rawUrl: string, key: string): Promise<string> {
  if (!rawUrl) return rawUrl
  // Already a public asset URL (poller/tool may hand one over directly).
  if (/^https?:\/\//i.test(rawUrl) && !/\/v1\/images\/[^/]+\/result\/?$/.test(rawUrl)) return rawUrl
  const absolute = /^https?:\/\//i.test(rawUrl) ? rawUrl : `${PLATFORM_BASE}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`
  // 平台 /v1/images/{id}/result 预设回 JSON，带 ?format=redirect 才 302 到公开 blob URL。
  const target = /\/v1\/images\/[^/]+\/result\/?$/.test(absolute) ? absolute + "?format=redirect" : absolute
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    })
    const loc = res.headers.get("location")
    if (loc && /^https?:\/\//i.test(loc)) return loc
    // Some deployments may serve the bytes directly instead of redirecting; the
    // absolute URL is then still wrong for the frontend, but it is the best we
    // have and at least names the right host.
    return absolute
  } catch {
    return absolute
  }
}

export async function emitImageDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  recipe?: { prompt?: string; model?: string; size?: string; lora?: string },
): Promise<void> {
  if (!url) return
  // Dedup on the RAW url: the same task resolved twice yields two different
  // public URLs only if the platform regenerates, but the raw form is stable.
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  const publicUrl = await resolveResultUrl(url, state.apiKey)
  emitToSession(state, "image.done", { url: publicUrl, cost_coins, task_id, ...(recipe ? { recipe } : {}) })
  // 自动制画布：task 挂过 unit 就更新该 unit 的结果图片节点。
  if (task_id) {
    emitCanvasResult(state, task_id, publicUrl, cost_coins)
  }
  void appendLedgerFor(state, {
    kind: "image",
    event: "done",
    task_id,
    cost_coins,
    result_url: publicUrl,
  })
  void emitQuotaChanged(state)
}

/**
 * 2026-10-05：把「已经到手的成片类成品」登记进会话任务表。
 * 为什么需要：任务表此前只由 image_* 的 attachCanvasTask 写（task_id）与 poller 的
 * emitCanvasResult 更新；非 image 工具（music_gen / video_upload / run_py）回的是成品
 * URL 而非 task_id，任何路径都不登记 ⇒ 卡片发了（用户看得见）、任务表仍是空的——父模型
 * 呼叫 image_get_result / delivery_assets 一律查不到这批成品。此处是唯一咽喉点：每张
 * video.done / audio.done 卡片都在此登记，主会话/子代理/poller 三条入口自动全覆盖。
 * 键＝task_id 优先，缺 task_id 时用 URL 本身（该键只用于去重覆盖，不出现在
 * /internal/session-tasks 的回传值里）。刻意**不含 image**：子代理会产大量中间关键帧，
 * 一并登记会灌爆清单（与 FIX-A「新图片一律不出卡」的既有不对称一致）。
 */
export function registerSessionArtifact(
  state: SessionState,
  entry: { url: string; kind: string; label?: string; task_id?: string },
): void {
  if (!entry.url) return
  const key = entry.task_id || entry.url
  const prev = state.sessionTasks.get(key)
  state.sessionTasks.set(key, {
    ...(prev ?? {}),
    ...(entry.task_id ? { task_id: entry.task_id } : {}),
    ...(entry.label ? { label: entry.label } : {}),
    status: "succeeded",
    url: entry.url,
    kind: entry.kind,
    submitted_at: prev?.submitted_at ?? Date.now(),
  })
  boundMap(state.sessionTasks, TOOL_STATUS_DEDUP_CAP)
  // 2026-10-18 止血：成品登记＝任务终态，冲刷 pendingCompact。
  flushPendingCompact(state)
}

export async function emitVideoDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  media_kind?: "video" | "film",
): Promise<void> {
  if (!url) return
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  registerSessionArtifact(state, { url, kind: media_kind === "film" ? "film" : "video", task_id })
  // 影片/成片 content 已是绝对公开 URL，无需 resolveResultUrl（它只重写 /v1/images/.../result 形态）。
  emitToSession(state, "video.done", { url, cost_coins, task_id, media_kind })
  void appendLedgerFor(state, {
    kind: "video",
    event: "done",
    task_id,
    cost_coins,
    result_url: url,
  })
  void emitQuotaChanged(state)
}

export async function emitAudioDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  media_kind?: "audio",
  meta?: AudioDoneMeta,
): Promise<void> {
  if (!url) return
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  registerSessionArtifact(state, { url, kind: "audio", task_id })
  // 音频 content 已是绝对公开 URL（平台 uploads），无需 resolveResultUrl（它只重写 /v1/images/.../result 形态）。
  // 可选元数据只带非空值：缺参数＝事件形状一字不变（向后兼容）。
  emitToSession(state, "audio.done", {
    url,
    cost_coins,
    task_id,
    media_kind,
    ...(meta?.title ? { title: meta.title } : {}),
    ...(meta?.cover ? { cover: meta.cover } : {}),
    ...(meta?.lyric_status ? { lyric_status: meta.lyric_status } : {}),
  })
  void appendLedgerFor(state, {
    kind: "audio",
    event: "done",
    task_id,
    cost_coins,
    result_url: url,
  })
  void emitQuotaChanged(state)
}
