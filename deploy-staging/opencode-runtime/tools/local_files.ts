import { tool } from "@opencode-ai/plugin/tool";
import { ok, fail } from "../lib/client";

// local_files — 本機檔案橋（W6）的**雲端側工具**。
//
// 檔案在使用者自己的電腦上，本工具跑在 VPS；因此這裡**不做任何本機檔案讀取**，
// 也不得 import node:fs。一切走 loopback 的內部端點 `/internal/device/*`：
//   工具只知道 `session_id` → 閘道用 session 解出租戶 → 挑該租戶唯一在線裝置 →
//   既有 DeviceBridge.invoke（白名單/denylist/授權根/大小夾制全在閘道側）。
// 契約（凍結，與 gateway device-bridge.ts 一對一）：
//   POST /internal/device/invoke?session_id=…  body {op,path,pattern?,max_bytes?,limit?}
//   GET  /internal/device/status?session_id=…
// 總開關 EIMU_DEVICE_BRIDGE 預設 OFF：未開啟時閘道不掛此路由，呼叫會落到 404（由 router 處理）。

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081";

const DEVICE_OPS = ["list_dir", "read_file", "grep", "stat"] as const;

/**
 * 錯誤碼 → 面向使用者的引導語（繁中）。只在這些碼用引導語；
 * 其餘（session_unknown／bad_request／tool_not_allowed／internal_error）原樣帶出。
 */
const GUIDANCE: Record<string, string> = {
  no_device_registered:
    "你的帳號還沒在桌面版登入並開啟本機檔案授權。請開啟桌面版 → 設定 → 本機檔案，選擇要授權的資料夾。",
  device_offline: "桌面版目前沒連上。請開啟（或重新開啟）桌面版並保持開著，再試一次。",
  path_not_authorized:
    "這個路徑不在你已授權的資料夾內。請到桌面版 → 設定 → 本機檔案，選擇要授權的資料夾。",
  device_ambiguous: "你的帳號有多台裝置同時在線，請只保留一台。",
  device_timeout: "裝置沒有在時間內回應，請確認桌面版仍在執行。",
  sensitive_path: "該路徑屬於敏感位置（憑證、私鑰等），不會讀取。",
};

/** 需要補「目前授權根」的錯誤碼（裝置離線／路徑未授權時，使用者最需要看到可授權的範圍）。 */
const CODES_WITH_ROOTS = new Set(["device_offline", "path_not_authorized"]);

/**
 * 讀取本會話租戶目前已授權的資料夾清單。任何失敗（網路/非 JSON）回 null，
 * 呼叫端據此退回不含 root 的引導語（status 失敗不影響主錯誤訊息）。
 */
async function fetchAuthorizedRoots(sessionID: string): Promise<string[] | null> {
  try {
    const res = await fetch(
      `${GATEWAY}/internal/device/status?session_id=${encodeURIComponent(sessionID)}`,
      { method: "GET" },
    );
    const data = (await res.json().catch(() => null)) as { device?: { roots?: unknown } | null } | null;
    if (!res.ok || !data?.ok) return null;
    const device = data.device;
    if (!device) return [];
    return Array.isArray(device.roots) ? device.roots.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return null;
  }
}

export default tool({
  description:
    "讀取**使用者自己電腦上**的檔案（本機檔案橋）。這不是雲端工作區、也不是站內素材庫；" +
    "檔案實際躺在使用者的電腦裡，只能讀取他在桌面版「設定 → 本機檔案」**明確授權過的資料夾**，" +
    "範圍外一律被拒。四個 op：list_dir＝列出目錄內容；read_file＝讀取單一檔案內容（有大小上限，過長會截斷）；" +
    "grep＝在檔案內容裡搜尋文字；stat＝取得單一檔案或目錄的資訊（大小、時間、型別）。" +
    "當使用者說「看一下我 Downloads 裡的東西」「讀我電腦上那個檔案」「幫我在本機某個資料夾找…」時用本工具。" +
    "若回傳顯示裝置未連線或路徑未授權，請把回傳裡的引導語**照實轉達**給使用者（例如請他開啟桌面版並到設定授權資料夾），" +
    "不要只回「我做不到」。",
  args: {
    op: tool.schema
      .enum(["list_dir", "read_file", "grep", "stat"])
      .describe(
        "要執行的本機檔案操作：list_dir（列目錄）、read_file（讀單檔內容）、grep（在內容中搜尋）、stat（取單一檔案/目錄資訊）。",
      ),
    path: tool.schema
      .string()
      .describe("使用者電腦上的絕對路徑，必須位於他在桌面版已授權的資料夾內。"),
    pattern: tool.schema
      .string()
      .optional()
      .describe("grep 的搜尋樣式（關鍵字或正規表達式）。僅 op=grep 時需要。"),
    max_bytes: tool.schema
      .number()
      .optional()
      .describe("grep 時單一檔案的讀取位元組上限（超過即略過該檔）。僅 op=grep 適用。"),
    limit: tool.schema
      .number()
      .optional()
      .describe("read_file 的最大讀取位元組數，超過會截斷並標記。僅 op=read_file 適用。"),
  },
  async execute(args, context) {
    const op = args.op;
    if (!(DEVICE_OPS as readonly string[]).includes(op)) {
      return fail("bad_request", `不支援的本機檔案操作：${String(op)}（僅限 list_dir/read_file/grep/stat）。`);
    }

    // 只放行凍結契約欄位；undefined 不下發，讓閘道用自己的預設上限。
    const body: Record<string, unknown> = { op, path: args.path };
    if (args.pattern !== undefined) body.pattern = args.pattern;
    if (args.max_bytes !== undefined) body.max_bytes = args.max_bytes;
    if (args.limit !== undefined) body.limit = args.limit;

    let res: Response;
    try {
      res = await fetch(
        `${GATEWAY}/internal/device/invoke?session_id=${encodeURIComponent(context.sessionID)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch (e) {
      return fail("internal_error", `無法連上本機檔案閘道：${(e as Error).message}`);
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !data?.ok) {
      const err = (data?.error ?? {}) as Record<string, unknown>;
      const code = typeof err.code === "string" && err.code ? err.code : "internal_error";
      const rawMessage =
        typeof err.message === "string" && err.message
          ? err.message
          : `讀取本機檔案失敗（HTTP ${res.status}）。`;

      const guidance = GUIDANCE[code];
      if (!guidance) return fail(code, rawMessage);

      let message = guidance;
      if (CODES_WITH_ROOTS.has(code)) {
        const roots = await fetchAuthorizedRoots(context.sessionID);
        if (roots) {
          message += roots.length
            ? ` 目前已授權的資料夾：${roots.join("、")}`
            : " 目前尚未授權任何資料夾。";
        }
      }
      return fail(code, message);
    }

    const truncated = data.truncated === true;
    const payload: Record<string, unknown> = {
      op,
      result: data.result,
      truncated,
    };
    if (typeof data.bytes === "number") payload.bytes = data.bytes;
    if (truncated) {
      payload.note = "內容超過單次讀取上限，已截斷；如需更多內容請縮小範圍或分段讀取。";
    }
    return ok(payload);
  },
});