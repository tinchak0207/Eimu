// 「成片接着做」：把一个画布项目复制成独立的可续作副本（吸收 AID 公开作品→可续作项目）。
//
// 副本语义（每条都是用户能感知的）：
//   ·身份稳定：节点／连线／分集全部换新 id，且所有互相引用（批次子节点、参考节点、分集归属、连线端点、
//     版本历史）按同一张映射表改写——副本里改一镜，不会碰到原项目的任何节点。
//   ·已采纳版本保留：节点 metadata（含 taskVersions／shotCandidates／音轨 id）原样带过去；
//     音轨、图片、视频是资产 id／URL，不是节点 id，所以不重写、不重新生成、不重复扣费。
//   ·软删节点与版本历史一并带走（可回退），但丢掉原项目的花费计数与团队归属——副本是个人项目，
//     预算从零计。
// 纯函式：不碰存储，调用方负责落盘。

import type { CanvasNode, CanvasProject } from "./types";

export interface ForkOptions {
  /** 新项目 id（调用方生成）。 */
  newProjectId: string;
  /** 生成新节点／连线／分集 id 的函式（缺省 crypto.randomUUID）。 */
  newId?: () => string;
  now?: string;
  title?: string;
}

export interface ForkResult {
  project: CanvasProject;
  /** 旧 id → 新 id（节点＋连线＋分集），供调用方返回给用户做定位。 */
  idMap: Record<string, string>;
}

export function forkCanvasProject(source: CanvasProject, options: ForkOptions): ForkResult {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const now = options.now ?? new Date().toISOString();
  const idMap = new Map<string, string>();
  const remap = (id: string): string => {
    let next = idMap.get(id);
    if (!next) {
      next = newId();
      idMap.set(id, next);
    }
    return next;
  };
  // 已知 id 才改写；找不到映射的引用（指向项目外）原样保留，不凭空造 id。
  const remapKnown = (id: string): string => idMap.get(id) ?? id;

  // 先给所有节点／分集定好新 id，再改写引用，避免前向引用漏改。
  for (const node of source.nodes) remap(node.id);
  for (const episode of source.episodes ?? []) remap(episode.id);

  const remapNode = (node: CanvasNode): CanvasNode => {
    const metadata = node.metadata ? ({ ...node.metadata } as NonNullable<CanvasNode["metadata"]>) : undefined;
    if (metadata) {
      if (typeof metadata.episodeId === "string") metadata.episodeId = remapKnown(metadata.episodeId);
      if (Array.isArray(metadata.referenceNodeIds)) metadata.referenceNodeIds = metadata.referenceNodeIds.map(remapKnown);
    }
    return {
      ...node,
      id: remap(node.id),
      ...(metadata ? { metadata } : {}),
      ...(node.batchChildren ? { batchChildren: node.batchChildren.map(remapKnown) } : {}),
      ...(node.batchPrimaryImageId ? { batchPrimaryImageId: remapKnown(node.batchPrimaryImageId) } : {}),
    };
  };

  const project: CanvasProject = {
    ...source,
    id: options.newProjectId,
    title: options.title?.trim() || `${source.title}（副本）`,
    createdAt: now,
    updatedAt: now,
    nodes: source.nodes.map(remapNode),
    connections: source.connections.map((connection) => ({
      ...connection,
      id: remap(connection.id),
      fromNodeId: remapKnown(connection.fromNodeId),
      toNodeId: remapKnown(connection.toNodeId),
    })),
    ...(source.episodes ? { episodes: source.episodes.map((episode) => ({ ...episode, id: remap(episode.id) })) } : {}),
    ...(source.nodeVersions
      ? { nodeVersions: source.nodeVersions.map((version) => ({ ...version, nodeId: remapKnown(version.nodeId) })) }
      : {}),
    // 花费计数归零；团队归属不带走（副本是个人项目，写入走个人库）。
    ...(source.budget ? { budget: { totalCoins: source.budget.totalCoins, usedCoins: 0 } } : {}),
    scope: "personal",
  };
  delete (project as { teamId?: string }).teamId;
  return { project, idMap: Object.fromEntries(idMap) };
}
