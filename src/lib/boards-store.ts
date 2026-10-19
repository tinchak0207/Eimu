import { createStore, del, get, set, type UseStore } from "idb-keyval";

export interface BoardFolder {
  id: string;
  name: string;
  createdAt: number;
}

export interface SavedShotMeta {
  id: string;
  boardId: string;
  name: string;
  createdAt: number;
  starred: boolean;
  modelId?: string;
  endpointLabel?: string;
  presetLabel?: string;
  prompt?: string;
  imageSize?: string;
}

export const DEFAULT_BOARD_NAME = "默认项目";

const BOARDS_KEY = "boards";
const SHOTS_KEY = "shots";

// blob 单独存键，避免每次写入都重写整个大对象
function blobKey(id: string): string {
  return `blob:${id}`;
}

let store: UseStore | undefined;

// createStore 会立即打开 IndexedDB，必须延迟到运行时调用，保证 SSR 安全
function getStore(): UseStore | undefined {
  if (typeof indexedDB === "undefined") return undefined;
  if (!store) store = createStore("pro-workstation", "boards-v1");
  return store;
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readBoards(s: UseStore): Promise<BoardFolder[]> {
  return (await get<BoardFolder[]>(BOARDS_KEY, s)) ?? [];
}

async function readShots(s: UseStore): Promise<SavedShotMeta[]> {
  return (await get<SavedShotMeta[]>(SHOTS_KEY, s)) ?? [];
}

export async function listBoards(): Promise<BoardFolder[]> {
  const s = getStore();
  if (!s) return [];
  return readBoards(s);
}

export async function createBoard(name: string): Promise<BoardFolder> {
  const trimmed = name.trim();
  const board: BoardFolder = {
    id: genId(),
    name: trimmed === "" ? DEFAULT_BOARD_NAME : trimmed,
    createdAt: Date.now(),
  };
  const s = getStore();
  if (!s) return board;
  const boards = await readBoards(s);
  boards.push(board);
  await set(BOARDS_KEY, boards, s);
  return board;
}

export async function renameBoard(id: string, name: string): Promise<void> {
  const s = getStore();
  if (!s) return;
  const trimmed = name.trim();
  const nextName = trimmed === "" ? DEFAULT_BOARD_NAME : trimmed;
  const boards = await readBoards(s);
  const target = boards.find((b) => b.id === id);
  if (!target) return;
  target.name = nextName;
  await set(BOARDS_KEY, boards, s);
}

export async function deleteBoard(id: string): Promise<void> {
  const s = getStore();
  if (!s) return;
  const boards = await readBoards(s);
  await set(
    BOARDS_KEY,
    boards.filter((b) => b.id !== id),
    s,
  );
  const shots = await readShots(s);
  const removed = shots.filter((shot) => shot.boardId === id);
  if (removed.length === 0) return;
  await set(
    SHOTS_KEY,
    shots.filter((shot) => shot.boardId !== id),
    s,
  );
  for (const shot of removed) {
    await del(blobKey(shot.id), s);
  }
}

export async function ensureDefaultBoard(): Promise<BoardFolder> {
  const s = getStore();
  if (!s) {
    return { id: genId(), name: DEFAULT_BOARD_NAME, createdAt: Date.now() };
  }
  const boards = await readBoards(s);
  if (boards.length > 0) return boards[0];
  return createBoard(DEFAULT_BOARD_NAME);
}

export async function listShots(): Promise<SavedShotMeta[]> {
  const s = getStore();
  if (!s) return [];
  const shots = await readShots(s);
  return [...shots].sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveShot(
  blob: Blob,
  meta: Omit<SavedShotMeta, "id" | "createdAt" | "starred">,
): Promise<SavedShotMeta> {
  const shot: SavedShotMeta = {
    ...meta,
    id: genId(),
    createdAt: Date.now(),
    starred: false,
  };
  const s = getStore();
  if (!s) return shot;
  await set(blobKey(shot.id), blob, s);
  const shots = await readShots(s);
  shots.push(shot);
  await set(SHOTS_KEY, shots, s);
  return shot;
}

export async function moveShot(id: string, boardId: string): Promise<void> {
  const s = getStore();
  if (!s) return;
  const shots = await readShots(s);
  const target = shots.find((shot) => shot.id === id);
  if (!target || target.boardId === boardId) return;
  target.boardId = boardId;
  await set(SHOTS_KEY, shots, s);
}

export async function toggleShotStar(id: string): Promise<void> {
  const s = getStore();
  if (!s) return;
  const shots = await readShots(s);
  const target = shots.find((shot) => shot.id === id);
  if (!target) return;
  target.starred = !target.starred;
  await set(SHOTS_KEY, shots, s);
}

export async function deleteShot(id: string): Promise<void> {
  const s = getStore();
  if (!s) return;
  const shots = await readShots(s);
  if (shots.some((shot) => shot.id === id)) {
    await set(
      SHOTS_KEY,
      shots.filter((shot) => shot.id !== id),
      s,
    );
  }
  await del(blobKey(id), s);
}

export async function getShotBlob(id: string): Promise<Blob | undefined> {
  const s = getStore();
  if (!s) return undefined;
  return get<Blob>(blobKey(id), s);
}
