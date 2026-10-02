/**
 * 跨邊界路徑規則（2026-10-02）。
 *
 * 同一個字串 `/tmp/...` 在三個地方指向三個不同目錄，兩兩互不可見：
 *   (1) 沙箱（bash / run_py）：`/tmp` 被 bind 成 `<workspace>/.run/<slug>/tmp`，每個會話私有；
 *   (2) 受信工具（opencode-server，systemd `PrivateTmp=true`）：`/tmp` 是服務私有的 tmpfs；
 *   (3) 宿主：又是第三個。
 * 於是兩邊互丟 /tmp 路徑必有一端找不到檔（2026-10-02 審計：實測沙箱寫 `/tmp/x` 後，
 * 服務側讀同路徑為 No such file）。
 *
 * 唯一兩側同一個絕對路徑的交換區是 workspace（`.run/<slug>/run` 亦然，兩側以同一路徑 bind）。
 * 本檔提供：(a) 給工具說明用的規則句；(b) 缺檔時把裸 ENOENT 換成可行動說明的 helper。
 */

export const CROSS_BOUNDARY_RULE =
  "跨邊界交接檔案一律放 workspace 內的絕對路徑（例如 <workspace>/out/final.mp4），" +
  "/tmp 只當單側暫存，不要把 /tmp 路徑傳過邊界。";

/**
 * 缺檔說明：路徑是 `/tmp/...` 時回可行動提示，其餘回 null（交給呼叫端原本的錯誤訊息）。
 * 掛在「讀 agent 給的來源檔」失敗分支上，把靜默陷阱變成教學錯誤。
 */
export function explainMissingPath(p: string): string | null {
  if (!p.startsWith("/tmp/")) return null;
  return `（${p} 是沙箱會話私有的 /tmp，受信工具端看不到；宿主 /tmp 又是第三個目錄）${CROSS_BOUNDARY_RULE}`;
}

/** 工具說明用的短句（放進 describe，讓 agent 在呼叫當下就看到正確用法）。 */
export const LOCAL_PATH_HINT =
  "本機檔案請給 workspace 內的絕對路徑（如 <workspace>/out/final.mp4）；沙箱的 /tmp 是會話私有目錄，工具端讀不到。";
