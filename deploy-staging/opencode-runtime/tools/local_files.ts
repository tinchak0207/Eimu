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
    "你的帐号还没在桌面版登入并开启本机档案桥。请开启桌面版并授权要读取的资料夹，或在对话中直接同意授权。",
  device_offline: "桌面版目前没连上。请开启（或重新开启）桌面版并保持开着，再试一次。",
  path_not_authorized:
    "这个路径不在你已授权的资料夹内。请在对话中同意授权这个资料夹，或在桌面版授权要读取的资料夹。",
  device_ambiguous: "你的帐号有多台装置同时在线，请只保留一台。",
  device_timeout: "装置没有在时间内回应，请确认桌面版仍在执行。",
  sensitive_path:
    "该路径属于敏感位置（凭证、私钥等）的硬性禁止范围，不会读取、也**不能授权**；请改用其他路径。",
};

/** 需要補「目前授權根」的錯誤碼（裝置離線／路徑未授權時，使用者最需要看到可授權的範圍）。 */
const CODES_WITH_ROOTS = new Set(["device_offline", "path_not_authorized"]);

/**
 * `needs_authorization` 時給模型的**三段式選項逐字文案**。
 * 模型必須把 label 原樣列給使用者，等他選定後，把該項的 scope 原封不動傳給
 * `local_files_authorize`；不得升級（尤其不得自行選 permanent）。
 */
const AUTHORIZATION_OPTIONS = [
  { scope: "once", label: "允许一次" },
  { scope: "session", label: "本会话允许此目录" },
  { scope: "permanent", label: "永久允许（加入本机授权清单）" },
] as const;

/** 給模型的明確指令：先問使用者，不得自行決定。 */
const AUTHORIZATION_INSTRUCTION =
  "把上面三个选项原样列给使用者，等他回答后再呼叫 local_files_authorize；不要自行决定。";

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
    "读取**使用者自己电脑上**的档案（本机档案桥）。这不是云端工作区、也不是站内素材库；" +
    "档案实际躺在使用者的电脑里，只能读取他**明确授权过的资料夹**（在对话中同意授权，或在桌面版授权），" +
    "范围外一律被拒。四个 op：list_dir＝列出目录内容；read_file＝读取单一档案内容（有大小上限，过长会截断）；" +
    "grep＝在档案内容里搜寻文字；stat＝取得单一档案或目录的资讯（大小、时间、型别）。" +
    "当使用者说「看一下我 Downloads 里的东西」「读我电脑上那个档案」「帮我在本机某个资料夹找…」时用本工具。" +
    "若回传显示装置未连线或路径未授权，请把回传里的引导语**照实转达**给使用者（例如请他在对话中同意授权、或在桌面版授权资料夹），" +
    "不要只回「我做不到」。" +
    "若回传 action_required=authorize_local_files（error.code=needs_authorization），代表这个路径还没授权：" +
    "**不要**当成失败，必须把回传的 options 三段式选项**逐字**列给使用者（允许一次／本会话允许此目录／永久允许），" +
    "等他明确选一个之后，再用 local_files_authorize 带入**他选的那个 scope 原样**授权；" +
    "不得自行替他决定，尤其**不得未经同意选 permanent**。" +
    "若错误码是 sensitive_path，那是硬性禁止位置，**不能授权**，不要引导使用者去授权它。" +
    "【列出档名的硬规矩】" +
    "① 列出的 name 一律**逐字原样照抄**：不得简繁转换、不得改写、不得省略括号／空白／大小写，" +
    "任何字都不得自行美化或补充。" +
    "② 使用者说「列出**所有** X（例如所有 .pdf）」时，必须用 op=list_dir 带 name_glob（例：*.pdf）让机制过滤，" +
    "并以回传的 count 当作数量**直接引用**——**不得自己数**，也不得凭印象增删清单。" +
    "③ 若回传带 incomplete=true，必须**明白告诉使用者清单不完整**（把 note 照实转达），" +
    "不得把不完整清单当成全部交付。" +
    "④ needs_authorization 的三段式 options 必须**连标点原样**照抄，尤其「永久允许（加入本机授权清单）」" +
    "的全形括号与字句不可改成破折号或半形括号。",
  args: {
    op: tool.schema
      .enum(["list_dir", "read_file", "grep", "stat"])
      .describe(
        "要执行的本机档案操作：list_dir（列目录）、read_file（读单档内容）、grep（在内容中搜寻）、stat（取单一档案/目录资讯）。",
      ),
    path: tool.schema
      .string()
      .describe("使用者电脑上的绝对路径，必须位于他在桌面版已授权的资料夹内。"),
    name_glob: tool.schema
      .string()
      .optional()
      .describe(
        "仅 op=list_dir 适用：在云端以档名样式过滤（支援 * 与 ?，例：*.pdf、*.txt、报告*）。" +
          "只比对档名（basename）、大小写敏感；不可含 /。要「列出所有 X」时必须用它，并引用回传的 count 当数量。",
      ),
    pattern: tool.schema
      .string()
      .optional()
      .describe("grep 的搜寻样式（关键字或正规表达式）。仅 op=grep 时需要。"),
    max_bytes: tool.schema
      .number()
      .optional()
      .describe("grep 时单一档案的读取位元组上限（超过即略过该档）。仅 op=grep 适用。"),
    limit: tool.schema
      .number()
      .optional()
      .describe("read_file 的最大读取位元组数，超过会截断并标记。仅 op=read_file 适用。"),
  },
  async execute(args, context) {
    const op = args.op;
    if (!(DEVICE_OPS as readonly string[]).includes(op)) {
      return fail("bad_request", `不支援的本机档案操作：${String(op)}（仅限 list_dir/read_file/grep/stat）。`);
    }

    // name_glob 只在雲端 runtime 過濾，**不下發**給閘道／裝置（凍結契約欄位不得增改）。
    const nameGlob = typeof args.name_glob === "string" ? args.name_glob : "";
    const useGlob = nameGlob.length > 0;
    if (useGlob && op !== "list_dir") {
      return fail("bad_request", `name_glob 仅支援 op=list_dir，不能用于 ${op}。`);
    }
    if (useGlob && nameGlob.includes("/")) {
      return fail("bad_request", "name_glob 只比对档名（basename），不可包含路径分隔符号（/）。");
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
      return fail("internal_error", `无法连上本机档案闸道：${(e as Error).message}`);
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !data?.ok) {
      const err = (data?.error ?? {}) as Record<string, unknown>;
      const code = typeof err.code === "string" && err.code ? err.code : "internal_error";

      // 路徑尚未授權（凍結契約）：回結構化結果，讓模型當場引導使用者三選一。
      // ⚠ denylist 不走這條（閘道回硬 deny／sensitive_path），故這裡不得引導授權 denylist。
      if (code === "needs_authorization") {
        return ok({
          title: "需要授权",
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
          : `读取本机档案失败（HTTP ${res.status}）。`;

      const guidance = GUIDANCE[code];
      if (!guidance) return fail(code, rawMessage);

      let message = guidance;
      if (CODES_WITH_ROOTS.has(code)) {
        const roots = await fetchAuthorizedRoots(context.sessionID);
        if (roots) {
          message += roots.length
            ? ` 目前已授权的资料夹：${roots.join("、")}`
            : " 目前尚未授权任何资料夹。";
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
            `清单不完整：装置只回传 ${total} 项` +
            (truncated ? "（内容超过单次传输上限）" : "（已达单次列举上限）") +
            `，可能还有符合「${nameGlob}」的项目未列出；请缩小目录范围或改列子目录后再试。`;
        } else if (useGlob) {
          payload.note =
            `档名符合「${nameGlob}」的项目共 ${count} 项（装置回传 ${total} 项）。` +
            "列出时请逐字照抄 name，不得改写、转换或省略。";
        }
      } else if (useGlob) {
        // 內容過大被閘道截斷、拿不到 entries 陣列：不得靜默給清單。
        payload.incomplete = true;
        payload.note = `清单不完整：装置回传内容过大被截断，无法完整列出符合「${nameGlob}」的项目；请缩小目录范围后再试。`;
      }
    } else if (truncated) {
      payload.note = "内容超过单次读取上限，已截断；如需更多内容请缩小范围或分段读取。";
    }
    return ok(payload);
  },
});