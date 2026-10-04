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

/** 裝置端 list_dir 的既有硬上限（desktop bridge-protocol MAX_LIST_ENTRIES＝閘道 max_entries 上界）。 */
const DEVICE_LIST_MAX_ENTRIES = 2000;
/** 裝置端未帶 max_entries 時的預設筆數（desktop bridge-executor MAX_LIST_DEFAULT）。 */
const DEVICE_LIST_DEFAULT_ENTRIES = 200;

/**
 * 把簡易 glob（僅 `*`、`?`）轉成整串錨定的 RegExp；其餘字元逐一轉義，
 * 避免使用者輸入被當成任意正則（不含 `/`，只比對 basename）。
 */
function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (const ch of glob) {
    if (ch === "*") pattern += ".*";
    else if (ch === "?") pattern += ".";
    else pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(pattern + "$");
}

/**
 * `name_glob` 匹配器（runtime 端過濾，裝置呼叫完全不變）：
 * 只比對檔名（basename）、**大小寫敏感**（Linux 真實語義），支援 `*`（任意長度）與
 * `?`（單一字元）；不得含 `/`。
 */
export function nameGlobMatcher(nameGlob: string): (name: string) => boolean {
  const re = globToRegExp(nameGlob);
  return (name) => re.test(name);
}

/**
 * 錯誤碼 → 面向使用者的引導語（繁中）。只在這些碼用引導語；
 * 其餘（session_unknown／bad_request／tool_not_allowed／internal_error）原樣帶出。
 */
const GUIDANCE: Record<string, string> = {
  no_device_registered:
    "你的帳號還沒在桌面版登入並開啟本機檔案橋。請開啟桌面版並授權要讀取的資料夾，或在對話中直接同意授權。",
  device_offline: "桌面版目前沒連上。請開啟（或重新開啟）桌面版並保持開著，再試一次。",
  path_not_authorized:
    "這個路徑不在你已授權的資料夾內。請在對話中同意授權這個資料夾，或在桌面版授權要讀取的資料夾。",
  device_ambiguous: "你的帳號有多台裝置同時在線，請只保留一台。",
  device_timeout: "裝置沒有在時間內回應，請確認桌面版仍在執行。",
  sensitive_path:
    "該路徑屬於敏感位置（憑證、私鑰等）的硬性禁止範圍，不會讀取、也**不能授權**；請改用其他路徑。",
};

/** 需要補「目前授權根」的錯誤碼（裝置離線／路徑未授權時，使用者最需要看到可授權的範圍）。 */
const CODES_WITH_ROOTS = new Set(["device_offline", "path_not_authorized"]);

/**
 * `needs_authorization` 時給模型的**三段式選項逐字文案**。
 * 模型必須把 label 原樣列給使用者，等他選定後，把該項的 scope 原封不動傳給
 * `local_files_authorize`；不得升級（尤其不得自行選 permanent）。
 */
const AUTHORIZATION_OPTIONS = [
  { scope: "once", label: "允許一次" },
  { scope: "session", label: "本會話允許此目錄" },
  { scope: "permanent", label: "永久允許（加入本機授權清單）" },
] as const;

/** 給模型的明確指令：先問使用者，不得自行決定。 */
const AUTHORIZATION_INSTRUCTION =
  "把上面三個選項原樣列給使用者，等他回答後再呼叫 local_files_authorize；不要自行決定。";

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
    "檔案實際躺在使用者的電腦裡，只能讀取他**明確授權過的資料夾**（在對話中同意授權，或在桌面版授權），" +
    "範圍外一律被拒。四個 op：list_dir＝列出目錄內容；read_file＝讀取單一檔案內容（有大小上限，過長會截斷）；" +
    "grep＝在檔案內容裡搜尋文字；stat＝取得單一檔案或目錄的資訊（大小、時間、型別）。" +
    "當使用者說「看一下我 Downloads 裡的東西」「讀我電腦上那個檔案」「幫我在本機某個資料夾找…」時用本工具。" +
    "若回傳顯示裝置未連線或路徑未授權，請把回傳裡的引導語**照實轉達**給使用者（例如請他在對話中同意授權、或在桌面版授權資料夾），" +
    "不要只回「我做不到」。" +
    "若回傳 action_required=authorize_local_files（error.code=needs_authorization），代表這個路徑還沒授權：" +
    "**不要**當成失敗，必須把回傳的 options 三段式選項**逐字**列給使用者（允許一次／本會話允許此目錄／永久允許），" +
    "等他明確選一個之後，再用 local_files_authorize 帶入**他選的那個 scope 原樣**授權；" +
    "不得自行替他決定，尤其**不得未經同意選 permanent**。" +
    "若錯誤碼是 sensitive_path，那是硬性禁止位置，**不能授權**，不要引導使用者去授權它。" +
    "【列出檔名的硬規矩】" +
    "① 列出的 name 一律**逐字原樣照抄**：不得簡繁轉換、不得改寫、不得省略括號／空白／大小寫，" +
    "任何字都不得自行美化或補充。" +
    "② 使用者說「列出**所有** X（例如所有 .pdf）」時，必須用 op=list_dir 帶 name_glob（例：*.pdf）讓機制過濾，" +
    "並以回傳的 count 當作數量**直接引用**——**不得自己數**，也不得憑印象增刪清單。" +
    "③ 若回傳帶 incomplete=true，必須**明白告訴使用者清單不完整**（把 note 照實轉達），" +
    "不得把不完整清單當成全部交付。" +
    "④ needs_authorization 的三段式 options 必須**連標點原樣**照抄，尤其「永久允許（加入本機授權清單）」" +
    "的全形括號與字句不可改成破折號或半形括號。",
  args: {
    op: tool.schema
      .enum(["list_dir", "read_file", "grep", "stat"])
      .describe(
        "要執行的本機檔案操作：list_dir（列目錄）、read_file（讀單檔內容）、grep（在內容中搜尋）、stat（取單一檔案/目錄資訊）。",
      ),
    path: tool.schema
      .string()
      .describe("使用者電腦上的絕對路徑，必須位於他在桌面版已授權的資料夾內。"),
    name_glob: tool.schema
      .string()
      .optional()
      .describe(
        "僅 op=list_dir 適用：在雲端以檔名樣式過濾（支援 * 與 ?，例：*.pdf、*.txt、報告*）。" +
          "只比對檔名（basename）、大小寫敏感；不可含 /。要「列出所有 X」時必須用它，並引用回傳的 count 當數量。",
      ),
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

    // name_glob 只在雲端 runtime 過濾，**不下發**給閘道／裝置（凍結契約欄位不得增改）。
    const nameGlob = typeof args.name_glob === "string" ? args.name_glob : "";
    const useGlob = nameGlob.length > 0;
    if (useGlob && op !== "list_dir") {
      return fail("bad_request", `name_glob 僅支援 op=list_dir，不能用於 ${op}。`);
    }
    if (useGlob && nameGlob.includes("/")) {
      return fail("bad_request", "name_glob 只比對檔名（basename），不可包含路徑分隔符號（/）。");
    }

    // 只放行凍結契約欄位；undefined 不下發，讓閘道用自己的預設上限。
    const body: Record<string, unknown> = { op, path: args.path };
    if (args.pattern !== undefined) body.pattern = args.pattern;
    if (args.max_bytes !== undefined) body.max_bytes = args.max_bytes;
    if (args.limit !== undefined) body.limit = args.limit;
    // 帶 name_glob（＝要「列出所有」）時把 list_dir 的 max_entries 拉到裝置既有上限 2000，
    // 以免預設 200 筆上限造成靜默漏列；不超過裝置上限，也不改裝置端上限。
    if (useGlob) body.max_entries = DEVICE_LIST_MAX_ENTRIES;

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

      // 路徑尚未授權（凍結契約）：回結構化結果，讓模型當場引導使用者三選一。
      // ⚠ denylist 不走這條（閘道回硬 deny／sensitive_path），故這裡不得引導授權 denylist。
      if (code === "needs_authorization") {
        return ok({
          title: "需要授權",
          action_required: "authorize_local_files",
          op,
          path: args.path,
          root: typeof err.root === "string" ? err.root : "",
          reason: typeof err.reason === "string" ? err.reason : "",
          options: AUTHORIZATION_OPTIONS,
          instruction: AUTHORIZATION_INSTRUCTION,
        });
      }

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

    if (op === "list_dir") {
      const rawResult =
        data.result && typeof data.result === "object" ? (data.result as Record<string, unknown>) : {};
      if (Array.isArray(rawResult.entries)) {
        const rawEntries = (rawResult.entries as unknown[]).filter(
          (e): e is { name: string } =>
            typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string",
        );
        const total = rawEntries.length; // 裝置回的總項數（過濾前）
        const entries = useGlob
          ? rawEntries.filter((e) => nameGlobMatcher(nameGlob)(e.name))
          : rawEntries;
        const count = entries.length; // 本次回傳的 entries 數（過濾後＝匹配數）
        // 把機制算好的過濾清單與計數寫回 result，模型只需照抄。
        payload.result = { ...rawResult, entries, count };
        payload.count = count;
        payload.total = total;
        // 截斷痕跡：閘道已標 truncated，或裝置回滿列舉上限（請求 2000；另防閘道未下發
        // max_entries、裝置沿用預設 200 造成的漏列）。只在 name_glob 有給時報 incomplete。
        const capHit = total >= DEVICE_LIST_MAX_ENTRIES || total === DEVICE_LIST_DEFAULT_ENTRIES;
        if (useGlob && (truncated || capHit)) {
          payload.incomplete = true;
          payload.note =
            `清單不完整：裝置只回傳 ${total} 項` +
            (truncated ? "（內容超過單次傳輸上限）" : "（已達單次列舉上限）") +
            `，可能還有符合「${nameGlob}」的項目未列出；請縮小目錄範圍或改列子目錄後再試。`;
        } else if (useGlob) {
          payload.note =
            `檔名符合「${nameGlob}」的項目共 ${count} 項（裝置回傳 ${total} 項）。` +
            "列出時請逐字照抄 name，不得改寫、轉換或省略。";
        }
      } else if (useGlob) {
        // 內容過大被閘道截斷、拿不到 entries 陣列：不得靜默給清單。
        payload.incomplete = true;
        payload.note = `清單不完整：裝置回傳內容過大被截斷，無法完整列出符合「${nameGlob}」的項目；請縮小目錄範圍後再試。`;
      }
    } else if (truncated) {
      payload.note = "內容超過單次讀取上限，已截斷；如需更多內容請縮小範圍或分段讀取。";
    }
    return ok(payload);
  },
});