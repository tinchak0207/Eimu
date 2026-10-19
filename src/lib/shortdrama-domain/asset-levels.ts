export interface ParentAsset {
  id: string;
}

export interface ChildAssetItem {
  id: string;
  assetId: string;
}

/** 剧本绑主资产。绑到子立绘 id 或未知 id 都不通过。 */
export function scriptBindsParents(
  boundIds: string[],
  parents: ParentAsset[],
  items: ChildAssetItem[],
): { ok: boolean; detail: string } {
  const parentIds = new Set(parents.map((parent) => parent.id));
  const itemIds = new Set(items.map((item) => item.id));
  const bad = boundIds.filter((id) => !id || itemIds.has(id) || !parentIds.has(id));
  if (boundIds.length === 0 || bad.length > 0) {
    return { ok: false, detail: `剧本必须绑主资产，不能绑子立绘：${bad.join(",") || "空"}` };
  }
  return { ok: true, detail: "剧本绑主资产" };
}

/** 分镜绑子立绘，且子立绘必须属于该镜已绑的主资产。 */
export function storyboardBindsItems(
  shots: Array<{ characterCardIds?: string[]; assetItemIds?: string[] }>,
  items: ChildAssetItem[],
): { ok: boolean; detail: string } {
  const byId = new Map(items.map((item) => [item.id, item]));
  const bad: string[] = [];
  for (const shot of shots) {
    const itemIds = shot.assetItemIds ?? [];
    if (itemIds.length === 0) {
      bad.push("missing-item");
      continue;
    }
    for (const itemId of itemIds) {
      const item = byId.get(itemId);
      const parents = shot.characterCardIds ?? [];
      if (!item || !parents.includes(item.assetId)) bad.push(itemId);
    }
  }
  if (shots.length === 0 || bad.length > 0) {
    return { ok: false, detail: `分镜必须绑子立绘，且子立绘属于该镜主资产：${bad.join(",")}` };
  }
  return { ok: true, detail: "分镜绑子立绘" };
}

/** 一个剧本集只能钉在一个分镜集上。同一对重复声明算成功。 */
export function claimScriptEpisode(
  bindings: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  storyboardEpisodeId: string,
  scriptEpisodeId: string,
): { ok: boolean; detail: string } {
  if (!storyboardEpisodeId || !scriptEpisodeId) {
    return { ok: false, detail: "集级绑定缺 id" };
  }
  const entries = bindings instanceof Map ? [...bindings.entries()] : Object.entries(bindings);
  const owner = entries.find(([storyboardId, scriptId]) => scriptId === scriptEpisodeId && storyboardId !== storyboardEpisodeId);
  if (owner) {
    return { ok: false, detail: `剧本集 ${scriptEpisodeId} 已绑在分镜集 ${owner[0]}` };
  }
  return { ok: true, detail: "集级绑定唯一" };
}
