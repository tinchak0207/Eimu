"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_REFERENCE_IMAGES } from "@/components/ReferenceImageUpload";
import type { ImageResult, ReferenceImage } from "@/lib/image-types";
import {
  type BoardFolder,
  type SavedShotMeta,
  createBoard,
  deleteBoard,
  deleteShot,
  ensureDefaultBoard,
  getShotBlob,
  listBoards,
  listShots,
  moveShot,
  saveShot,
  toggleShotStar,
} from "@/lib/boards-store";
import { exportShotsZip } from "@/lib/export-zip";
import {
  type NoticeLevel,
  type WorkstationPreset,
  useEventCallback,
} from "./workstation-constants";

export interface BoardsLibraryApi {
  boards: BoardFolder[];
  shots: SavedShotMeta[];
  shotUrls: Record<string, string>;
  activeBoardId: string;
  setActiveBoardId: (boardId: string) => void;
  newBoardName: string;
  setNewBoardName: (name: string) => void;
  referenceImportBoardId: string;
  setReferenceImportBoardId: (boardId: string) => void;
  referenceImportingId: string | null;
  referenceImportMessage: string;
  filteredShots: SavedShotMeta[];
  referenceImportShots: SavedShotMeta[];
  shotCounts: Map<string, number>;
  activeBoard: BoardFolder | undefined;
  refreshBoards: () => Promise<void>;
  handleImportShotAsReference: (shot: SavedShotMeta) => Promise<void>;
  handleCreateBoard: () => Promise<void>;
  handleDeleteBoard: (boardId: string) => Promise<void>;
  handleDeleteActiveBoard: () => void;
  saveResultToBoard: (image?: ImageResult) => Promise<void>;
  handleMoveShot: (shotId: string, boardId: string) => Promise<void>;
  handleToggleStar: (shotId: string) => Promise<void>;
  handleDeleteShot: (shotId: string) => Promise<void>;
  downloadShot: (shot: SavedShotMeta) => void;
  handleExportBoard: () => Promise<void>;
}

/**
 * 成片文件夹库（2026-08-22 从 InvokeInspiredWorkstation 拆出）。
 *
 * 拥有板夹/快照的全部 CRUD state（boards / shots / shotUrls / 选中文件夹 /
 * 参考图导入 UI state）、派生值（filteredShots / shotCounts / activeBoard）、
 * 缩略图并行加载 effect，以及把成片存入 IndexedDB 与导出 zip 的全部函数。
 * promptForResult / resultToBlob 与生成编排共享，仍归入口所有，作为参数传入。
 */
export function useBoardsLibrary(options: {
  referenceImages: ReferenceImage[];
  onReferenceImagesChange: (images: ReferenceImage[]) => void;
  activePreset: WorkstationPreset;
  images: ImageResult[];
  setCanvasNotice: (text: string, level?: NoticeLevel) => void;
  resultToBlob: (image: ImageResult) => Promise<Blob>;
  promptForResult: (image: ImageResult) => string | undefined;
}): BoardsLibraryApi {
  const {
    referenceImages,
    onReferenceImagesChange,
    activePreset,
    images,
    setCanvasNotice,
    resultToBlob,
    promptForResult,
  } = options;

  const [boards, setBoards] = useState<BoardFolder[]>([]);
  const [shots, setShots] = useState<SavedShotMeta[]>([]);
  const [shotUrls, setShotUrls] = useState<Record<string, string>>({});
  const [activeBoardId, setActiveBoardId] = useState<string>("all");
  const [referenceImportBoardId, setReferenceImportBoardId] = useState<string>("all");
  const [referenceImportingId, setReferenceImportingId] = useState<string | null>(null);
  const [referenceImportMessage, setReferenceImportMessage] = useState("");
  const [newBoardName, setNewBoardName] = useState("");
  const shotUrlPendingRef = useRef<Set<string>>(new Set());

  const filteredShots = useMemo(() => shots
    .filter((shot) => activeBoardId === "all" || shot.boardId === activeBoardId)
    .sort((a, b) => Number(b.starred) - Number(a.starred) || b.createdAt - a.createdAt), [shots, activeBoardId]);
  const referenceImportShots = useMemo(() => shots
    .filter((shot) => referenceImportBoardId === "all" || shot.boardId === referenceImportBoardId)
    .sort((a, b) => Number(b.starred) - Number(a.starred) || b.createdAt - a.createdAt), [shots, referenceImportBoardId]);
  const shotCounts = useMemo(() => {
    const counts = new Map<string, number>();
    shots.forEach((shot) => counts.set(shot.boardId, (counts.get(shot.boardId) ?? 0) + 1));
    return counts;
  }, [shots]);
  const activeBoard = boards.find((board) => board.id === activeBoardId);

  const refreshBoards = async () => {
    const [boardList, shotList] = await Promise.all([listBoards(), listShots()]);
    setBoards(boardList);
    setShots(shotList);
  };

  const handleImportShotAsReference = useEventCallback(async (shot: SavedShotMeta) => {
    const referenceId = `shot-${shot.id}`;
    if (referenceImages.some((image) => image.id === referenceId)) {
      setReferenceImportMessage("这张图片已经在参考图中。");
      return;
    }
    if (referenceImages.length >= MAX_REFERENCE_IMAGES) {
      setReferenceImportMessage(`参考图已达上限，最多 ${MAX_REFERENCE_IMAGES} 张。`);
      return;
    }
    setReferenceImportingId(shot.id);
    setReferenceImportMessage("");
    try {
      const blob = await getShotBlob(shot.id);
      if (!blob) throw new Error("missing shot blob");
      const file = new File([blob], shot.name, { type: blob.type || "image/png" });
      onReferenceImagesChange([
        ...referenceImages,
        {
          id: referenceId,
          name: shot.name,
          file,
          previewUrl: URL.createObjectURL(file),
          size: file.size,
          role: activePreset.defaultRole,
        },
      ]);
      setReferenceImportMessage(`已从文件夹导入「${shot.name}」。`);
    } catch {
      setReferenceImportMessage("导入失败，请重试。");
    } finally {
      setReferenceImportingId(null);
    }
  });

  const handleCreateBoard = useEventCallback(async () => {
    const board = await createBoard(newBoardName.trim());
    setNewBoardName("");
    setActiveBoardId(board.id);
    await refreshBoards();
    setCanvasNotice(`已创建「${board.name}」。`);
  });

  const handleDeleteBoard = useEventCallback(async (boardId: string) => {
    const board = boards.find((item) => item.id === boardId);
    if (!board) return;
    const count = shots.filter((shot) => shot.boardId === boardId).length;
    if (count > 0 && !window.confirm(`删除文件夹「${board.name}」会同时删除其中 ${count} 张图片，确定吗？`)) return;
    setShotUrls((current) => {
      shots.filter((shot) => shot.boardId === boardId).forEach((shot) => {
        if (current[shot.id]) URL.revokeObjectURL(current[shot.id]);
      });
      return Object.fromEntries(Object.entries(current).filter(([id]) => !shots.some((shot) => shot.id === id && shot.boardId === boardId)));
    });
    await deleteBoard(boardId);
    setActiveBoardId("all");
    await refreshBoards();
    setCanvasNotice(`已删除「${board.name}」。`);
  });

  const handleDeleteActiveBoard = useEventCallback(() => {
    if (activeBoard) handleDeleteBoard(activeBoard.id);
  });

  const saveResultToBoard = async (image?: ImageResult) => {
    if (!image || (!image.image && !image.imageUrl)) {
      setCanvasNotice("还没有可存入的成片。");
      return;
    }
    try {
      const blob = await resultToBlob(image);
      const target = activeBoard ?? await ensureDefaultBoard();
      const presetLabel = image.workflow?.workflowPresetLabel ?? activePreset.label;
      await saveShot(blob, {
        boardId: target.id,
        name: `${presetLabel}-${(image.slotId ?? `${images.indexOf(image) + 1}`).slice(-4)}.png`,
        modelId: image.modelId,
        presetLabel,
        // 存的是「这张图当时的提示词」，不是编辑器里现在的内容。
        // 旧版写 prompt.trim()：半小时前生成的图，存进文件夹时被贴上刚写的另一段描述，
        // 之后凭这条记录复现只会得到完全不同的画面。
        prompt: promptForResult(image),
        imageSize: image.workflow?.imageSize,
      });
      await refreshBoards();
      setCanvasNotice(`已存入「${target.name}」。`);
    } catch {
      setCanvasNotice("存入失败，请重试。");
    }
  };

  const handleMoveShot = useEventCallback(async (shotId: string, boardId: string) => {
    await moveShot(shotId, boardId);
    await refreshBoards();
  });

  const handleToggleStar = useEventCallback(async (shotId: string) => {
    await toggleShotStar(shotId);
    await refreshBoards();
  });

  const handleDeleteShot = useEventCallback(async (shotId: string) => {
    /**
     * 删除文件夹里的成片是不可逆的（IndexedDB 里删掉就没有了，也没有回收站），
     * 而这个按钮在卡片上跟「下载」紧挨着。旧版点下去立刻删，只留一句「已删除」。
     */
    const shot = shots.find((item) => item.id === shotId);
    if (!window.confirm(`删除「${shot?.name ?? "这张成片"}」？此操作无法撤销。`)) return;
    setShotUrls((current) => {
      if (current[shotId]) URL.revokeObjectURL(current[shotId]);
      const next = { ...current };
      delete next[shotId];
      return next;
    });
    await deleteShot(shotId);
    await refreshBoards();
    setCanvasNotice("成片已从文件夹删除");
  });

  const downloadShot = useEventCallback((shot: SavedShotMeta) => {
    const url = shotUrls[shot.id];
    if (!url) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = shot.name;
    anchor.click();
  });

  const handleExportBoard = useEventCallback(async () => {
    if (!filteredShots.length) {
      setCanvasNotice("当前文件夹没有可导出的图片。");
      return;
    }
    const items: Array<{ name: string; blob: Blob }> = [];
    for (const shot of filteredShots) {
      const blob = await getShotBlob(shot.id);
      if (blob) items.push({ name: shot.name, blob });
    }
    await exportShotsZip(items, `${activeBoard?.name ?? "全部成片"}`);
    setCanvasNotice(`已导出 ${items.length} 张图片。`);
  });

  useEffect(() => {
    let cancelled = false;
    const missing = shots.filter((shot) => !shotUrls[shot.id] && !shotUrlPendingRef.current.has(shot.id));
    if (!missing.length) return;
    missing.forEach((shot) => shotUrlPendingRef.current.add(shot.id));
    (async () => {
      // 并行读 IndexedDB：30 张缩略图从串行 N×RTT 降到 ~max(RTT)
      const entries = (await Promise.all(missing.map(async (shot) => {
        const blob = await getShotBlob(shot.id);
        return blob ? ([shot.id, URL.createObjectURL(blob)] as const) : null;
      }))).filter((entry): entry is readonly [string, string] => !!entry);
      missing.forEach((shot) => shotUrlPendingRef.current.delete(shot.id));
      if (cancelled) {
        entries.forEach(([, url]) => URL.revokeObjectURL(url));
        return;
      }
      if (entries.length) {
        setShotUrls((current) => ({ ...current, ...Object.fromEntries(entries) }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shots]);

  return {
    boards,
    shots,
    shotUrls,
    activeBoardId,
    setActiveBoardId,
    newBoardName,
    setNewBoardName,
    referenceImportBoardId,
    setReferenceImportBoardId,
    referenceImportingId,
    referenceImportMessage,
    filteredShots,
    referenceImportShots,
    shotCounts,
    activeBoard,
    refreshBoards,
    handleImportShotAsReference,
    handleCreateBoard,
    handleDeleteBoard,
    handleDeleteActiveBoard,
    saveResultToBoard,
    handleMoveShot,
    handleToggleStar,
    handleDeleteShot,
    downloadShot,
    handleExportBoard,
  };
}
