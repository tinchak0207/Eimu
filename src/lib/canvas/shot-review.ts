// 手机端「作品审阅」的数据投影与「用这条／回旧版」写入（纯函式，不碰存储）。
//
// 目标体验：第一次收到能看的片 → 点进一镜 → 对照前后两版 → 用这条 → 下次从这版继续。
// 三条硬约束（用户真正在乎的）：
//   ①满意的部分不被动：采用某一版只改**这一镜**的 selectedVersion／selectedId，其余节点、其余字段原样；
//   ②旧版回得去：永远不删版本，「回旧版」＝再选一次；
//   ③说得清「做完了没有」：每镜四态（可直接用／旧稿待补跑／生成中／失败可补跑／还没出），
//     汇总给出「现在手里有什么、缺什么、下一步」，失败的一段不拖累已成的。

import { shotMediaReadiness, shotNumberOf, selectShotCandidate, shotInputSignature, normalizeShotCandidates } from "./storyboard-shots";
import { normalizeTaskVersions, selectTaskVersion, type TaskTag } from "./task-versions";
import type { CanvasNode, CanvasProject } from "./types";

export type ShotReviewState = "ready" | "stale" | "pending" | "failed" | "empty";

export interface ShotReviewVersion {
  /** 版本识别（ISO 时间，字典序＝时间序）。 */
  version: string;
  kind: "image" | "video";
  url?: string;
  status?: string;
  /** 是否当前采用。 */
  adopted: boolean;
  /** 产出它的输入已被改过（旧稿：可看、可回，但不是当前输入的成果）。 */
  stale: boolean;
}

export interface ShotReviewCandidate {
  id: string;
  url?: string;
  status?: string;
  adopted: boolean;
}

export interface ShotReviewShot {
  nodeId: string;
  shotNumber: string;
  episodeId?: string;
  episodeNo?: number;
  title: string;
  /** 一句话画面描述（给人认镜头用）。 */
  summary: string;
  state: ShotReviewState;
  adoptedUrl?: string;
  adoptedKind?: "image" | "video";
  hasAudio: boolean;
  /** 有一版新稿（对应当前输入）还没被采用、当前采用的是旧稿或没有——等用户点「用这条」。 */
  newVersionWaiting: boolean;
  versions: ShotReviewVersion[];
  candidates: ShotReviewCandidate[];
}

export interface ProjectReviewSummary {
  total: number;
  ready: number;
  stale: number;
  pending: number;
  failed: number;
  empty: number;
  /** 有新版待选的镜数。 */
  waitingChoice: number;
  /** 一句人话：现在手里有什么、缺什么。 */
  headline: string;
  /** 下一步该点什么（给手机端主按钮）；全部可用＝null。 */
  nextAction: null | { kind: "choose_version" | "rerun_failed" | "wait" | "refresh_stale" | "generate_missing"; nodeIds: string[]; label: string };
}

export interface ProjectReview {
  projectId: string;
  title: string;
  episodes: { id: string; episodeNo: number; title: string; shots: number; ready: number }[];
  shots: ShotReviewShot[];
  summary: ProjectReviewSummary;
  /** 跨集沿用的决定放在哪里（让用户知道「上次的选择」被留着）。 */
  continuity: { cardCount: number; narrationVoice?: string; styleId?: string };
}

function tagKind(tags: readonly TaskTag[]): "image" | "video" {
  return tags.includes("main_video") ? "video" : "image";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function shotBag(node: CanvasNode): Record<string, unknown> {
  return (node.metadata ?? {}) as Record<string, unknown>;
}

function summaryOf(node: CanvasNode): string {
  const bag = shotBag(node);
  const nested = (bag.storyboardShot ?? {}) as Record<string, unknown>;
  const text = str(nested.visualDescription) || str(bag.visualDescription) || str(nested.prompt) || str(bag.prompt) || node.title;
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function reviewShot(node: CanvasNode, episodeNo?: number): ShotReviewShot | null {
  const shotNumber = shotNumberOf(node);
  if (!shotNumber) return null;
  const bag = shotBag(node);
  const set = normalizeTaskVersions(bag.taskVersions);
  const candidates = normalizeShotCandidates(bag.shotCandidates);
  const currentSig = { image: shotInputSignature(bag, "image"), video: shotInputSignature(bag, "video") };

  const versions: ShotReviewVersion[] = (set?.items ?? []).map((entry) => {
    const kind = tagKind(entry.tags);
    return {
      version: entry.version,
      kind,
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      adopted: set?.selectedVersion === entry.version,
      stale: !!entry.inputSig && entry.inputSig !== currentSig[kind],
    };
  });
  // 存量作品（本版本之前落地的成果）没有 taskVersions：把节点自己的成果当作唯一一版，保证老作品也能审阅、存走。
  if (versions.length === 0 && typeof bag.content === "string" && /^https?:\/\//.test(bag.content)) {
    versions.push({ version: "legacy", kind: node.type === "video" ? "video" : "image", url: bag.content, status: "success", adopted: true, stale: false });
  }
  const candidateViews: ShotReviewCandidate[] = (candidates?.items ?? []).map((item) => ({
    id: item.id,
    ...(item.url ? { url: item.url } : {}),
    ...(item.status ? { status: item.status } : {}),
    adopted: candidates?.selectedId === item.id,
  }));

  const readiness = shotMediaReadiness(bag);
  const adoptedEntry = versions.find((v) => v.adopted);
  // 比当前采用稿更新、对应当前输入、已出成果的版本＝「新版等你选」（再来一版、改镜头后重生成都算）。
  const newVersionWaiting = versions.some(
    (v) => !v.adopted && !v.stale && !!v.url && v.status !== "error" && v.status !== "loading" && v.version !== "legacy" && (!adoptedEntry || v.version > adoptedEntry.version || adoptedEntry.stale),
  );
  const adoptedVersion = versions.find((v) => v.adopted && v.url);
  const adoptedCandidate = candidateViews.find((c) => c.adopted && c.url);
  const adoptedUrl = adoptedVersion?.url ?? adoptedCandidate?.url;
  const adoptedKind = adoptedVersion?.kind ?? (adoptedCandidate ? "video" : undefined);

  const anyLoading = versions.some((v) => v.status === "loading") || candidateViews.some((c) => c.status === "loading") || node.metadata?.status === "loading";
  const latest = versions[versions.length - 1];
  const delivered = readiness.hasImage || readiness.hasVideo || versions.some((v) => v.version === "legacy");
  let state: ShotReviewState;
  if (delivered && !anyLoading) state = "ready";
  else if (anyLoading) state = "pending";
  else if (versions.some((v) => v.url) && !delivered) state = "stale";
  else if (latest?.status === "error" || candidateViews.some((c) => c.status === "error")) state = "failed";
  else state = "empty";

  return {
    nodeId: node.id,
    shotNumber,
    ...(typeof bag.episodeId === "string" ? { episodeId: bag.episodeId } : {}),
    ...(episodeNo !== undefined ? { episodeNo } : {}),
    title: node.title,
    summary: summaryOf(node),
    state,
    ...(adoptedUrl ? { adoptedUrl } : {}),
    ...(adoptedKind ? { adoptedKind } : {}),
    hasAudio: readiness.hasAudio,
    newVersionWaiting,
    versions,
    candidates: candidateViews,
  };
}

export function buildProjectReview(project: CanvasProject): ProjectReview {
  const episodeNoById = new Map((project.episodes ?? []).map((e) => [e.id, e.episodeNo]));
  const shots = project.nodes
    .map((node) => {
      const epId = typeof node.metadata?.episodeId === "string" ? node.metadata.episodeId : undefined;
      return reviewShot(node, epId ? episodeNoById.get(epId) : undefined);
    })
    .filter((shot): shot is ShotReviewShot => shot !== null)
    .sort((a, b) => (a.episodeNo ?? 0) - (b.episodeNo ?? 0) || a.shotNumber.localeCompare(b.shotNumber, undefined, { numeric: true }));

  const count = (state: ShotReviewState) => shots.filter((s) => s.state === state).length;
  const summary: ProjectReviewSummary = {
    total: shots.length,
    ready: count("ready"),
    stale: count("stale"),
    pending: count("pending"),
    failed: count("failed"),
    empty: count("empty"),
    waitingChoice: shots.filter((s) => s.newVersionWaiting).length,
    headline: "",
    nextAction: null,
  };
  const ids = (state: ShotReviewState) => shots.filter((s) => s.state === state).map((s) => s.nodeId);
  const parts: string[] = [];
  if (summary.total === 0) parts.push("还没有分镜");
  else {
    parts.push(`${summary.ready}/${summary.total} 镜可直接用`);
    if (summary.waitingChoice) parts.push(`${summary.waitingChoice} 镜有新版等你选`);
    if (summary.pending) parts.push(`${summary.pending} 镜生成中`);
    if (summary.failed) parts.push(`${summary.failed} 镜失败（已成的不受影响，可单独补跑）`);
    if (summary.stale) parts.push(`${summary.stale} 镜改过内容、旧稿待重做`);
    if (summary.empty) parts.push(`${summary.empty} 镜还没出`);
  }
  summary.headline = parts.join(" · ");
  const waitingIds = shots.filter((s) => s.newVersionWaiting).map((s) => s.nodeId);
  if (summary.waitingChoice) summary.nextAction = { kind: "choose_version", nodeIds: waitingIds, label: `看看 ${summary.waitingChoice} 镜的新版，选用哪一条` };
  else if (summary.failed) summary.nextAction = { kind: "rerun_failed", nodeIds: ids("failed"), label: `补跑失败的 ${summary.failed} 镜` };
  else if (summary.pending) summary.nextAction = { kind: "wait", nodeIds: ids("pending"), label: "等生成完成" };
  else if (summary.stale) summary.nextAction = { kind: "refresh_stale", nodeIds: ids("stale"), label: `重做改过的 ${summary.stale} 镜` };
  else if (summary.empty) summary.nextAction = { kind: "generate_missing", nodeIds: ids("empty"), label: `生成还没出的 ${summary.empty} 镜` };

  return {
    projectId: project.id,
    title: project.title,
    episodes: (project.episodes ?? []).map((episode) => {
      const own = shots.filter((s) => s.episodeId === episode.id);
      return { id: episode.id, episodeNo: episode.episodeNo, title: episode.title, shots: own.length, ready: own.filter((s) => s.state === "ready").length };
    }),
    shots,
    summary,
    continuity: {
      cardCount: project.cardIds?.length ?? 0,
      ...(project.narrationVoice ? { narrationVoice: project.narrationVoice } : {}),
      ...(project.styleId ? { styleId: project.styleId } : {}),
    },
  };
}

export interface AdoptReceipt {
  ok: boolean;
  reason?: "not_found" | "not_a_shot" | "version_not_found";
  nodeId: string;
  /** 本次动过的节点数（恒为 0 或 1）：「照旧」的可核对证据。 */
  touchedNodes: number;
  previous?: string;
  adopted?: string;
}

/** 采用某一版（任务版本或候选）。只改这一个节点的星标，其余节点原样返回同一引用。 */
export function adoptShotVersion(
  project: CanvasProject,
  input: { nodeId: string; version?: string; candidateId?: string },
): { project: CanvasProject; receipt: AdoptReceipt } {
  const index = project.nodes.findIndex((n) => n.id === input.nodeId);
  const base: AdoptReceipt = { ok: false, nodeId: input.nodeId, touchedNodes: 0 };
  if (index < 0) return { project, receipt: { ...base, reason: "not_found" } };
  const node = project.nodes[index];
  if (!shotNumberOf(node)) return { project, receipt: { ...base, reason: "not_a_shot" } };
  const bag = shotBag(node);

  let metadata: Record<string, unknown> | null = null;
  let previous: string | undefined;
  let adopted: string | undefined;
  if (input.version) {
    const set = normalizeTaskVersions(bag.taskVersions);
    const picked = selectTaskVersion(set, input.version);
    if (!picked.selected) return { project, receipt: { ...base, reason: "version_not_found" } };
    previous = set?.selectedVersion;
    adopted = picked.set.selectedVersion;
    metadata = { ...bag, taskVersions: picked.set };
  } else if (input.candidateId) {
    const set = normalizeShotCandidates(bag.shotCandidates);
    const picked = selectShotCandidate(set, input.candidateId);
    if (!picked.selected) return { project, receipt: { ...base, reason: "version_not_found" } };
    previous = set?.selectedId;
    adopted = picked.set.selectedId;
    metadata = { ...bag, shotCandidates: picked.set };
  } else {
    return { project, receipt: { ...base, reason: "version_not_found" } };
  }

  const nodes = project.nodes.map((n, i) => (i === index ? ({ ...n, metadata } as CanvasNode) : n));
  return {
    project: { ...project, nodes },
    receipt: { ok: true, nodeId: input.nodeId, touchedNodes: 1, ...(previous ? { previous } : {}), ...(adopted ? { adopted } : {}) },
  };
}
