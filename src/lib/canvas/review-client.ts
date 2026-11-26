// 网页端「我的作品」的前端封装：与小程序 apps/miniapp/src/lib/project-review.ts 同一组服务端接口。
import { getStoredUser } from "@/lib/new-api-client";
import { authHeaders } from "@/lib/canvas/client";
import type { ProjectReview } from "@/lib/canvas/shot-review";

export type { ProjectReview };
export interface ProjectSummaryRow { id: string; title: string; updatedAt: string; nodeCount: number }
export interface MasterReceipt { known: boolean; hasCut: boolean; latest?: { deliveryUrl: string; coverUrl?: string | null; durationSec?: number | null; createdAt: string } }
export interface ImportScriptResult { projectId: string; policy: "finished" | "seed"; shotCount: number; sampleNodeId: string | null; sampleDraft: string; fidelity: { sourceLines: number; coveredLines: number; verbatim: boolean } }
export interface SharedView { ok: boolean; shareId: string; title: string; summary: string; shots: { shotNumber: string; episodeNo?: number; summary: string; state: string; adoptedUrl?: string; adoptedKind?: "image" | "video" }[] }

async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.auth !== false) {
    const auth = authHeaders();
    if (!auth) throw new Error("请先登录");
    Object.assign(headers, auth);
  }
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), cache: "no-store" });
  const json = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok || !json) throw new Error(json?.error || json?.message || `请求失败（${res.status}）`);
  return json;
}

export const isSignedIn = () => authHeaders() !== null;
export const fetchProjects = async () => (await call<{ summaries?: ProjectSummaryRow[] }>("/api/canvas/projects?view=summary")).summaries ?? [];
export const fetchReview = async (id: string) => (await call<{ review: ProjectReview }>(`/api/canvas/projects/review?projectId=${encodeURIComponent(id)}`)).review;
export const adoptVersion = async (projectId: string, nodeId: string, pick: { version?: string; candidateId?: string }) =>
  (await call<{ review: ProjectReview }>("/api/canvas/projects/review", { method: "POST", body: { projectId, nodeId, ...pick } })).review;
export const fetchMaster = (id: string) => call<MasterReceipt>(`/api/canvas/masters?projectId=${encodeURIComponent(id)}`).catch((): MasterReceipt => ({ known: false, hasCut: false }));
export const importScript = (script: string) => call<ImportScriptResult>("/api/canvas/projects/import-script", { method: "POST", body: { script, references: [] } });
export const publishShare = async (projectId: string) => (await call<{ shareId: string }>("/api/canvas/projects/share", { method: "POST", body: { projectId } })).shareId;
export const revokeShare = (shareId: string) => call("/api/canvas/projects/share?shareId=" + encodeURIComponent(shareId), { method: "DELETE" });
export const fetchShared = (shareId: string) => call<SharedView>(`/api/canvas/projects/share?shareId=${encodeURIComponent(shareId)}`, { auth: false });
export const forkShared = async (shareId: string) => (await call<{ projectId: string }>("/api/canvas/projects/fork", { method: "POST", body: { shareId } })).projectId;

const DRAFT_KEY = "eimu_pending_agent_draft";
/** 点选→对话交接：把「第 N 镜：」带进助理输入框（只存本账号、一次消费）。 */
export function stashAgentDraft(text: string): void {
  const owner = getStoredUser()?.id;
  if (!owner) return;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ owner, text })); } catch { /* 存储不可用就只是少了预填 */ }
}
export function consumeAgentDraft(): string | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    localStorage.removeItem(DRAFT_KEY);
    const v = raw ? (JSON.parse(raw) as { owner?: number; text?: string }) : null;
    if (!v || v.owner !== getStoredUser()?.id || typeof v.text !== "string" || !v.text.trim()) return null;
    return v.text;
  } catch { return null; }
}
