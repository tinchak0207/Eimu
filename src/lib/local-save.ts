// 產物直接寫進使用者選定的本機目錄（File System Access API）。
//
// 這是純漸進增強層：能力偵測走「端點是否存在」（不是 UA 字串）。
// 沒有 showSaveFilePicker / showDirectoryPicker 的環境（Firefox、Safari、
// 手機、未開放的桌面殼）一律回 "unsupported"，由呼叫端回落今天的
// blob + <a download> 行為；桌面殼的 will-download 攔截仍是那條落地面。
//
// 本模組不得在頂層觸碰 window / document：image-helpers 等可能在 SSR
// 被 import，只有函式本體在呼叫當下才讀 globalThis。

export type LocalSaveResult = "saved" | "cancelled" | "unsupported";

/** File System Access API 的最小結構型別（不依賴 lib.dom 是否收錄）。 */
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

/** 使用者取消存檔對話框時瀏覽器丟的 AbortError（用 name 判定，跨 realm 穩）。 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** 從檔名尾端取副檔名（含點），取不到回 null。 */
function extensionOf(fileName: string): string | null {
  const match = /(\.[a-z0-9]+)$/i.exec(fileName);
  return match ? match[1] : null;
}

/** 能力偵測：兩種 picker 有任一個即視為可本機直存（不是 UA 字串）。 */
export function hasLocalFileSave(): boolean {
  return getSaveFilePicker() !== undefined || getDirectoryPicker() !== undefined;
}

/**
 * 用原生「另存新檔」對話框存單一 blob。
 * 使用者取消回 "cancelled"（不 throw）；端點不存在回 "unsupported"。
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
    // 取消不是錯誤：回 "cancelled" 讓呼叫端不重複觸發下載。
    if (isAbortError(error)) return "cancelled";
    // 漸進增強的增強路徑失敗**不得弄壞基礎流程**：非取消的寫入錯誤一律降級成
    // "unsupported"，讓呼叫端回落到既有的 blob + <a download>。原因只留在 console
    // 供除錯，不外拋給使用者（呼叫端把非 "unsupported" 當成「已處理」而不再回落）。
    console.warn("[local-save] 本機直存失敗，回落一般下載：", error);
    return "unsupported";
  }
}

/**
 * 用 showDirectoryPicker 取得一次授權後，把多個 blob 逐一寫進該目錄。
 * 使用者取消回 "cancelled"；端點不存在回 "unsupported"。
 */
export async function saveManyLocally(
  files: Array<{ name: string; blob: Blob }>,
  opts?: { directoryName?: string },
): Promise<LocalSaveResult> {
  const picker = getDirectoryPicker();
  if (!picker) return "unsupported";

  // showDirectoryPicker 沒有「目錄名稱」提示的 API；opts.directoryName 只作為
  // 呼叫端語意標註保留，未使用。以 id 記住上次目錄是好的行為，但不強加。
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
    // 同上：非取消的寫入錯誤降級成 "unsupported" 讓呼叫端回落，原因記 console。
    console.warn("[local-save] 本機直存失敗，回落一般下載：", error);
    return "unsupported";
  }
}
