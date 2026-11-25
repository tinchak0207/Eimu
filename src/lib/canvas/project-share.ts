// 公开作品页 → 可续作项目（吸收 AID「公开作品可复制成项目」）。
//
// 与图片分享（share-store.ts）同一套存储后端与路径约定，但存的是**项目快照**：
//   ·发布＝不可变快照（读者看到的是发布那一刻的版本；作者之后再改不影响已发布的那份，也不会被读者改）；
//   ·快照保留节点、分集、连线、已采用版本、音轨 id——读者「复制成我的项目」后用 forkCanvasProject 换新 id，
//     带着作者定下的采用稿继续做；团队归属／花费／软删节点不外泄；
//   ·可撤销：删快照＋所有权记录，/p 页与复制入口当场 404（VPS 后端即时；Vercel Blob 受 CDN 最短 60 秒）。
// 所有权记录与快照分文件存放：快照是公开读，owner 不进公开文档。

import { del, ensureBlobBackendWritable, get, put } from "../blob-backend";
import { generateShareId, isShareId } from "../share-id";
import type { CanvasProject } from "./types";

const ROOT = "shares/canvas-project";
const memorySnapshots = new Map<string, ProjectShareSnapshot>();
const memoryOwners = new Map<string, number>();

export interface ProjectShareSnapshot {
  shareId: string;
  createdAt: number;
  project: CanvasProject;
}

const snapshotPath = (shareId: string) => `${ROOT}/${shareId}.json`;
const ownerPath = (shareId: string) => `${ROOT}-owner/${shareId}.json`;

/** 发布前剥掉不该公开的东西：团队归属、花费、软删节点、编辑历史。 */
export function sanitizeProjectForShare(project: CanvasProject): CanvasProject {
  const { budget: _budget, teamId: _teamId, nodeVersions: _history, ...rest } = project;
  void _budget; void _teamId; void _history;
  const nodes = project.nodes.filter((node) => !node.deletedAt);
  const alive = new Set(nodes.map((n) => n.id));
  return {
    ...rest,
    scope: "personal",
    nodes,
    connections: project.connections.filter((c) => alive.has(c.fromNodeId) && alive.has(c.toNodeId)),
  };
}

async function readJson(url: string): Promise<unknown | null> {
  try {
    const blob = await get(url, { access: "public", useCache: false });
    if (!blob || blob.statusCode !== 200 || !blob.stream) return null;
    const text = await new Response(blob.stream).text();
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await put(path, JSON.stringify(value), { access: "public", contentType: "application/json", cacheControlMaxAge: 60, allowOverwrite: true });
}

export async function createProjectShare(userId: number, project: CanvasProject): Promise<{ shareId: string }> {
  const shareId = generateShareId();
  const snapshot: ProjectShareSnapshot = { shareId, createdAt: Date.now(), project: sanitizeProjectForShare(project) };
  memorySnapshots.set(shareId, snapshot);
  memoryOwners.set(shareId, userId);
  if (ensureBlobBackendWritable("project-share.create")) {
    await writeJson(snapshotPath(shareId), snapshot);
    await writeJson(ownerPath(shareId), { ownerUserId: userId });
  }
  return { shareId };
}

/** 公开读取：不存在／畸形 id／已撤销一律 null。 */
export async function getProjectShare(shareId: string): Promise<ProjectShareSnapshot | null> {
  if (!isShareId(shareId)) return null;
  if (!ensureBlobBackendWritable("project-share.read")) return memorySnapshots.get(shareId) ?? null;
  const payload = (await readJson(snapshotPath(shareId))) as Partial<ProjectShareSnapshot> | null;
  if (!payload || payload.shareId !== shareId || !payload.project || !Array.isArray(payload.project.nodes)) return null;
  return payload as ProjectShareSnapshot;
}

export async function revokeProjectShare(userId: number, shareId: string): Promise<boolean> {
  if (!isShareId(shareId)) return false;
  let owner: number | undefined;
  if (ensureBlobBackendWritable("project-share.revoke")) {
    const record = (await readJson(ownerPath(shareId))) as { ownerUserId?: number } | null;
    owner = typeof record?.ownerUserId === "number" ? record.ownerUserId : undefined;
  } else owner = memoryOwners.get(shareId);
  if (owner !== userId) return false;
  memorySnapshots.delete(shareId);
  memoryOwners.delete(shareId);
  if (ensureBlobBackendWritable("project-share.revoke")) {
    await del([snapshotPath(shareId), ownerPath(shareId)]).catch(async () => {
      // 删不掉就把快照换成空壳：宁可作废，也不能「按了撤销、页面还在」。
      await writeJson(snapshotPath(shareId), { shareId, createdAt: 0, project: null }).catch(() => undefined);
    });
  }
  return true;
}
