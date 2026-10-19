// 产物直接写进使用者选定的本机目录（File System Access API）。
//
// 这是纯渐进增强层：能力侦测走「端点是否存在」（不是 UA 字串）。
// 没有 showSaveFilePicker / showDirectoryPicker 的环境（Firefox、Safari、
// 手机、未开放的桌面壳）一律回 "unsupported"，由呼叫端回落今天的
// blob + <a download> 行为；桌面壳的 will-download 拦截仍是那条落地面。
//
// 本模组不得在顶层触碰 window / document：image-helpers 等可能在 SSR
// 被 import，只有函式本体在呼叫当下才读 globalThis。

export type LocalSaveResult = "saved" | "cancelled" | "unsupported";

/** File System Access API 的最小结构型别（不依赖 lib.dom 是否收录）。 */
interface WritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
}

interface DirectoryHandleLike {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
}

interface SaveFileType {
  description?: string;
  accept: Record<string, string[]>;
}

type SaveFilePickerFn = (opts?: {
  suggestedName?: string;
  types?: SaveFileType[];
}) => Promise<FileHandleLike>;

type DirectoryPickerFn = (opts?: {
  mode?: "read" | "readwrite";
}) => Promise<DirectoryHandleLike>;

function readGlobal<T>(name: string): T | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === "function" ? (value as T) : undefined;
}

function getSaveFilePicker(): SaveFilePickerFn | undefined {
  return readGlobal<SaveFilePickerFn>("showSaveFilePicker");
}

function getDirectoryPicker(): DirectoryPickerFn | undefined {
  return readGlobal<DirectoryPickerFn>("showDirectoryPicker");
}

/** 使用者取消存档对话框时浏览器丢的 AbortError（用 name 判定，跨 realm 稳）。 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** 从档名尾端取副档名（含点），取不到回 null。 */
function extensionOf(fileName: string): string | null {
  const match = /(\.[a-z0-9]+)$/i.exec(fileName);
  return match ? match[1] : null;
}

/** 能力侦测：两种 picker 有任一个即视为可本机直存（不是 UA 字串）。 */
export function hasLocalFileSave(): boolean {
  return getSaveFilePicker() !== undefined || getDirectoryPicker() !== undefined;
}

/**
 * 用原生「另存新档」对话框存单一 blob。
 * 使用者取消回 "cancelled"（不 throw）；端点不存在回 "unsupported"。
 */
export async function saveBlobLocally(
  blob: Blob,
  fileName: string,
  opts?: { mimeType?: string },
): Promise<LocalSaveResult> {
  const picker = getSaveFilePicker();
  if (!picker) return "unsupported";

  const extension = extensionOf(fileName);
  const types: SaveFileType[] | undefined =
    opts?.mimeType && extension
      ? [{ accept: { [opts.mimeType]: [extension] } }]
      : undefined;

  try {
    const handle = await picker({
      suggestedName: fileName,
      ...(types ? { types } : {}),
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return "saved";
  } catch (error) {
    // 取消不是错误：回 "cancelled" 让呼叫端不重复触发下载。
    if (isAbortError(error)) return "cancelled";
    // 渐进增强的增强路径失败**不得弄坏基础流程**：非取消的写入错误一律降级成
    // "unsupported"，让呼叫端回落到既有的 blob + <a download>。原因只留在 console
    // 供除错，不外抛给使用者（呼叫端把非 "unsupported" 当成「已处理」而不再回落）。
    console.warn("[local-save] 本机直存失败，回落一般下载：", error);
    return "unsupported";
  }
}

/**
 * 用 showDirectoryPicker 取得一次授权后，把多个 blob 逐一写进该目录。
 * 使用者取消回 "cancelled"；端点不存在回 "unsupported"。
 */
export async function saveManyLocally(
  files: Array<{ name: string; blob: Blob }>,
  opts?: { directoryName?: string },
): Promise<LocalSaveResult> {
  const picker = getDirectoryPicker();
  if (!picker) return "unsupported";

  // showDirectoryPicker 没有「目录名称」提示的 API；opts.directoryName 只作为
  // 呼叫端语意标注保留，未使用。以 id 记住上次目录是好的行为，但不强加。
  void opts;

  try {
    const directory = await picker({ mode: "readwrite" });
    for (const file of files) {
      const handle = await directory.getFileHandle(file.name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(file.blob);
      await writable.close();
    }
    return "saved";
  } catch (error) {
    if (isAbortError(error)) return "cancelled";
    // 同上：非取消的写入错误降级成 "unsupported" 让呼叫端回落，原因记 console。
    console.warn("[local-save] 本机直存失败，回落一般下载：", error);
    return "unsupported";
  }
}
