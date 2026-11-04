"use client";

// 历史灯箱 = 赏阅（Viewer）的历史专属胶水。
//
// 渲染（图/视频/音频、缩放、键盘切换、焦点陷阱、滚动锁、返回键）全部由赏阅壳承担；
// 本档只做三件历史专属的事：
//   1. entries → ViewAsset 集合（与 entries 1:1 同下标：不可看的记录用文本占位，下标基准不漂移）；
//   2. 历史专属动作（收藏/下载/做同款/再来 N 组/微调变体/溯源/删除）以 extraActions 挂进壳的动作栏；
//   3. 壳内切换成员 → onNavigate 回报，删除后 entries 变短 → 按父级给的新 index 重开。
// 「灯箱/删除索引基准统一」语义（HistoryClient 以 displayEntries 为唯一基准计算 lightboxIndex）原样保持：
// 本组件不自己维护下标，只镜像父级 index 与壳内导航。

import { useEffect, useRef } from "react";
import { Coins, Download, GitBranch, Layers, RotateCcw, SlidersHorizontal, Star, Trash2 } from "lucide-react";
import { useViewer, type ViewerExtraAction } from "@/components/viewer/ViewerHost";
import { viewAssetFromHistoryEntry } from "@/lib/viewer/from-items";
import type { ViewAsset } from "@/lib/viewer/types";
import { formatCoins, inferEntryKind } from "@/lib/history-types";
import { canHistoryEntryRerun } from "@/lib/history-rerun";
import { historyDagNodes, historyDagNodesTotalCoins, workflowDagThumbnailUrl } from "@/lib/history-workflow-view";
import type { HistoryEntry } from "@/lib/history-types";

export interface HistoryLightboxProps {
  entries: HistoryEntry[];
  /** 当前展示的记录在 entries 中的下标；为 null 表示关闭。 */
  index: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onToggleStar: (id: string) => void;
  onDownload: (entry: HistoryEntry) => void | Promise<void>;
  onDelete: (id: string) => void;
  onReuse?: (entry: HistoryEntry) => void;
  /** 再来 N 组 / 微调变体（payload 级批量重跑）。缺席时工具栏不挂。 */
  onRerun?: (entry: HistoryEntry) => void;
  onRerunVariant?: (entry: HistoryEntry) => void;
  /** REQ-D1：打开这条记录的「溯源」抽屉（与历史卡入口同一抽屉实例）。 */
  onShowLineage?: (entry: HistoryEntry) => void;
}

/**
 * 一条记录 → 一件 ViewAsset（保持与 entries 同下标）。
 * 工作流先看后端渲染好的 DAG 图；其余走赏阅投影（多成果＝合集）；老记录只有裸 base64 图；
 * 都没有时给诚实的文本占位（「没有留存图片，参数仍可复用」），而不是把记录从集合里剔掉。
 */
function assetForEntry(entry: HistoryEntry): ViewAsset {
  const dag = workflowDagThumbnailUrl(entry);
  if (dag) return { id: entry.id, kind: "image", url: dag, title: "工作流结构图" };
  const projected = viewAssetFromHistoryEntry(entry);
  if (projected) return projected;
  const raw = entry.results.find((result) => result.image)?.image;
  if (raw) return { id: entry.id, kind: "image", url: `data:image/png;base64,${raw}` };
  return { id: entry.id, kind: "text", title: "生成记录", text: "这条记录没有留存图片。参数仍可复用。" };
}

const CHIP = "rounded-full bg-[rgba(255,255,255,0.12)] px-2.5 py-1 text-[13px] text-[rgba(255,255,255,0.82)]";

function EntryFooter({ entry }: { entry: HistoryEntry }) {
  const workflow = entry.workflow;
  const dagNodes = inferEntryKind(entry) === "workflow" ? historyDagNodes(entry) : null;
  const dagTotal = historyDagNodesTotalCoins(dagNodes);
  const quota = entry.quota !== undefined && entry.quota > 0 ? entry.quota : null;
  if (!workflow && !entry.retryOfTaskId && !dagNodes && quota === null) return null;
  return (
    <div className="w-full max-w-2xl px-2 text-white">
      <div className="flex flex-wrap justify-center gap-1.5">
        {quota !== null && <span className={CHIP}>消耗 {formatCoins(quota)} 张</span>}
        {workflow?.workflowPresetLabel && <span className={CHIP}>{workflow.workflowPresetLabel}</span>}
        {workflow?.imageSize && <span className={CHIP}>{workflow.imageSize}</span>}
        {workflow?.qualityProfile && <span className={CHIP}>{workflow.qualityProfile}</span>}
        {workflow?.estimatedCredits !== undefined && (
          <span className={`inline-flex items-center gap-1 ${CHIP}`}>
            <Coins className="h-3 w-3" aria-hidden="true" />
            预估 {workflow.estimatedCredits}
          </span>
        )}
        {entry.retryOfTaskId && (
          <span className={CHIP} title={`衍生自任务 ${entry.retryOfTaskId}`}>
            衍生自任务 {entry.retryOfTaskId.slice(0, 8)}
          </span>
        )}
      </div>
      {/* 节点产物清单：后端没有写入 dagNodes 时整块不渲染。 */}
      {dagNodes && (
        <div className="mt-3">
          <p className="text-[13px] font-medium text-[rgba(255,255,255,0.82)]">节点产物</p>
          <ul className="mt-1.5 space-y-1">
            {dagNodes.map((node, nodeIndex) => (
              <li key={`${node.role ?? node.kind ?? "node"}-${nodeIndex}`} className="flex items-center gap-2 text-[13px] text-white/70">
                <span className="min-w-0 flex-1 truncate">
                  {node.title ?? node.role ?? "未命名节点"}
                  {node.kind && <span className="ml-1.5 text-white/50">{node.kind}</span>}
                </span>
                {node.status && <span className="shrink-0 text-white/50">{node.status}</span>}
                {node.costCoins !== null && (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[#FFCE73]">
                    <Coins className="h-3 w-3" aria-hidden="true" />
                    {node.costCoins}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {dagTotal !== null && (
            <p className="mt-1.5 inline-flex items-center gap-1 text-[13px] text-[rgba(255,255,255,0.82)]">
              <Coins className="h-3 w-3 text-[#FFCE73]" aria-hidden="true" />
              节点合计 {dagTotal} 币
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function HistoryLightbox(props: HistoryLightboxProps) {
  const { entries, index } = props;
  const { open, close, update } = useViewer();

  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  /** 壳内成员（含合集子项）id → 记录。每次 open/update 刷新。 */
  const entryByAssetId = useRef(new Map<string, HistoryEntry>());
  /** 本组件持有的会话：sig=记录 id 序列，index=壳内当前下标。null＝没有会话。 */
  const sessionRef = useRef<{ sig: string; index: number } | null>(null);
  const downloadingRef = useRef(false);

  const isOpen = index !== null && index >= 0 && index < entries.length;

  useEffect(() => {
    if (!isOpen || index === null) {
      if (sessionRef.current) {
        sessionRef.current = null;
        close();
      }
      return;
    }

    const p = latest.current;
    const lookup = (asset: ViewAsset) => entryByAssetId.current.get(asset.id);

    /** 先收壳（RerunDialog/溯源抽屉在壳之下），再把控制权交给对应的页面级弹层。 */
    const dismissThen = (run: (entry: HistoryEntry) => void) => (asset: ViewAsset) => {
      const entry = lookup(asset);
      if (!entry) return;
      sessionRef.current = null;
      close();
      latest.current.onClose();
      run(entry);
    };

    const extraActions: ViewerExtraAction[] = [
      {
        id: "star",
        label: (asset) => (lookup(asset)?.starred ? "取消收藏" : "收藏"),
        icon: <Star className="h-4 w-4" aria-hidden="true" />,
        onClick: (asset) => {
          const entry = lookup(asset);
          if (entry) latest.current.onToggleStar(entry.id);
        },
      },
      {
        id: "download",
        label: "下载",
        icon: <Download className="h-4 w-4" aria-hidden="true" />,
        visible: (asset) => asset.kind !== "text",
        onClick: (asset) => {
          const entry = lookup(asset);
          if (!entry || downloadingRef.current) return;
          downloadingRef.current = true;
          void Promise.resolve(latest.current.onDownload(entry)).finally(() => {
            downloadingRef.current = false;
          });
        },
      },
    ];
    if (p.onReuse) {
      extraActions.push({
        id: "reuse",
        label: "用这套参数继续做图",
        icon: <RotateCcw className="h-4 w-4" aria-hidden="true" />,
        visible: (asset) => Boolean(lookup(asset)?.workflow),
        onClick: dismissThen((entry) => latest.current.onReuse?.(entry)),
      });
    }
    // payload 级重跑：配方完整才挂，按下去只会失败的按钮比不挂更糟。
    if (p.onRerun) {
      extraActions.push({
        id: "rerun",
        label: "再来 N 组",
        icon: <Layers className="h-4 w-4" aria-hidden="true" />,
        visible: (asset) => {
          const entry = lookup(asset);
          return entry ? canHistoryEntryRerun(entry) : false;
        },
        onClick: dismissThen((entry) => latest.current.onRerun?.(entry)),
      });
    }
    if (p.onRerunVariant) {
      extraActions.push({
        id: "variant",
        label: "微调变体",
        icon: <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />,
        visible: (asset) => {
          const entry = lookup(asset);
          return entry ? canHistoryEntryRerun(entry) : false;
        },
        onClick: dismissThen((entry) => latest.current.onRerunVariant?.(entry)),
      });
    }
    if (p.onShowLineage) {
      extraActions.push({
        id: "lineage",
        label: "溯源",
        icon: <GitBranch className="h-4 w-4" aria-hidden="true" />,
        onClick: dismissThen((entry) => latest.current.onShowLineage?.(entry)),
      });
    }
    extraActions.push({
      id: "delete",
      label: "删除",
      danger: true,
      icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
      onClick: (asset) => {
        const entry = lookup(asset);
        if (!entry) return;
        // 不可逆删除：沿用仓库既有的 window.confirm 确认模式（吊销密钥/删除渠道等同款），取消即什么都不发生。
        if (!window.confirm("确定删除这条作品？删除后无法恢复。")) return;
        latest.current.onDelete(entry.id);
      },
    });

    const extraFooter = (asset: ViewAsset) => {
      const entry = lookup(asset);
      return entry ? <EntryFooter entry={entry} /> : null;
    };

    const sig = entries.map((entry) => entry.id).join("\u0001");
    const current = sessionRef.current;
    const map = new Map<string, HistoryEntry>();
    const assets = entries.map((entry) => {
      const asset = assetForEntry(entry);
      map.set(asset.id, entry);
      for (const child of asset.children ?? []) map.set(child.id, entry);
      return asset;
    });
    entryByAssetId.current = map;

    if (current && current.sig === sig && current.index === index) {
      // 集合与位置都没变（收藏/内容刷新）：只原位更新动作与脚注，不重挂载舞台。
      update({ extraActions, extraFooter });
      return;
    }
    // 首次打开、父级改了位置（溯源跳转）、或集合变了（删除后）：以父级 index 为准重开。
    sessionRef.current = { sig, index };
    open(assets, {
      index,
      extraActions,
      extraFooter,
      onIndexChange: (next) => {
        const live = sessionRef.current;
        if (!live) return;
        live.index = next;
        latest.current.onNavigate(next);
      },
      onClose: () => {
        if (!sessionRef.current) return;
        sessionRef.current = null;
        latest.current.onClose();
      },
    });
  }, [isOpen, entries, index, open, close, update]);

  // 卸载（换路由）时收掉自己的会话，且不回调父级。
  useEffect(
    () => () => {
      if (sessionRef.current) {
        sessionRef.current = null;
        close();
      }
    },
    [close],
  );

  return null;
}
