// 路由错误页的恢复语义（吸收 AID RouteRecoveryBoundary / StorageConfigNotice）。
//
// 旧页面在站点发版后请求已不存在的 chunk，会抛 ChunkLoadError——这不是用户的项目坏了，
// 是「页面是旧版本」。此时该做的是：告诉用户进度已保存、刷新即可恢复，而不是一句「页面出错了」。
// 其余错误仍走通用提示；两种都带上 digest 作为工单号，求助时不用复制整屏日志／提示词。

export type RouteErrorKind = "stale-version" | "generic";

export interface RouteErrorView {
  kind: RouteErrorKind;
  title: string;
  hint: string;
  /** 主按钮文案；`stale-version` 必须整页刷新（reset 只重渲染，拿不到新 chunk）。 */
  action: string;
  needsReload: boolean;
  /** 工单号（Next 给的 error.digest）；缺席＝不显示。 */
  supportRef?: string;
}

const STALE_PATTERNS = [
  /ChunkLoadError/i,
  /Loading chunk [\w-]+ failed/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
];

export function describeRouteError(error: { name?: string; message?: string; digest?: string } | null | undefined): RouteErrorView {
  const text = `${error?.name ?? ""} ${error?.message ?? ""}`;
  const supportRef = error?.digest?.trim() || undefined;
  if (STALE_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      kind: "stale-version",
      title: "页面刚刚更新了",
      hint: "你正在看的是旧版本页面。已编辑的内容和历史都保存着，刷新一下就能接着做。",
      action: "刷新继续",
      needsReload: true,
      ...(supportRef ? { supportRef } : {}),
    };
  }
  return {
    kind: "generic",
    title: "页面出错了",
    hint: "先重试一次；还不行就刷新页面。",
    action: "重试",
    needsReload: false,
    ...(supportRef ? { supportRef } : {}),
  };
}
