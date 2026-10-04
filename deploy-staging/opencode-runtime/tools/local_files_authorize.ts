import { tool } from "@opencode-ai/plugin/tool";
import { ok, fail } from "../lib/client";

// local_files_authorize — 本機檔案橋（W6）的**授權落地工具**。
//
// 當 local_files 回傳 action_required=authorize_local_files（error.code=needs_authorization）
// 時，模型必須先把三段式選項逐字列給使用者、等他**明確選一個**，才能呼叫本工具把規則落下去。
// 本工具只做一件事：把使用者選定的 {scope, root} 原樣 POST 給閘道 /internal/device/authorize。
// 不得自行決定 scope，尤其不得未經同意升級成 permanent。
//
// 契約（凍結，與 gateway device-bridge.ts 一對一）：
//   POST /internal/device/authorize?session_id=…  body {scope, root, tool?}
//   200: { ok: true, applied: {scope, root}, rules: [...], persist_on_device?: true }
//   錯誤: { ok:false, error:{ code, message } }  code ∈ bad_request|session_unknown|
//         root_not_absolute|root_too_broad|denylisted_root

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081";

const SCOPES = ["once", "session", "permanent"] as const;

/**
 * 授權端點錯誤碼 → 面向使用者的繁中引導語。
 * 其餘碼（internal_error 等）原樣帶出閘道 message。
 */
const GUIDANCE: Record<string, string> = {
  bad_request: "授權請求格式不正確，請確認 scope 與 root 後再試。",
  session_unknown: "這個對話已失效，請重新開始對話後再試一次。",
  root_not_absolute: "請提供絕對路徑。",
  root_too_broad: "這個範圍太寬（例如整個家目錄或根目錄），請指定更具體的資料夾。",
  denylisted_root: "該位置屬硬性禁止，不能授權。",
};

export default tool({
  description:
    "把使用者對本機檔案路徑的授權決定**落到規則**（本機檔案橋）。" +
    "**只在使用者明確同意之後才可呼叫**：當 local_files 回傳 action_required=authorize_local_files 時，" +
    "先把三段式選項逐字列給使用者，等他回答後，把**他選的那一個 scope** 原樣傳進來。" +
    "scope：once＝只允許這一次（用完即失效）；session＝本會話允許此目錄；permanent＝永久允許（加入本機授權清單）。" +
    "root 用 local_files 回傳裡建議的 root。" +
    "**不得**自行決定 scope，**不得**擅自把 once/session 升級成 permanent；" +
    "使用者的授權範圍疑義一律回去問他。" +
    "若回傳顯示該位置屬硬性禁止（denylisted_root）或範圍太寬（root_too_broad），把引導語照實轉達，不要重試。",
  args: {
    scope: tool.schema
      .enum(["once", "session", "permanent"])
      .describe(
        "授權範圍，必須是使用者從三個選項中選定的那一個，不得自行改動：once（允許一次）、session（本會話允許此目錄）、permanent（永久允許）。",
      ),
    root: tool.schema
      .string()
      .describe("要授權的資料夾絕對路徑（用 local_files 回傳裡建議的 root）。"),
    tool: tool.schema
      .string()
      .optional()
      .describe("選填：限定此授權只給某個工具使用；一般不需要帶。"),
  },
  async execute(args, context) {
    const scope = args.scope;
    if (!(SCOPES as readonly string[]).includes(scope)) {
      return fail(
        "bad_request",
        `不支援的授權範圍：${String(scope)}（僅限 once/session/permanent）。`,
      );
    }
    if (typeof args.root !== "string" || !args.root.trim()) {
      return fail("bad_request", "需要提供要授權的資料夾絕對路徑（root）。");
    }

    const body: Record<string, unknown> = { scope, root: args.root };
    if (args.tool !== undefined) body.tool = args.tool;

    let res: Response;
    try {
      res = await fetch(
        `${GATEWAY}/internal/device/authorize?session_id=${encodeURIComponent(context.sessionID)}`,
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
          : `授權本機檔案失敗（HTTP ${res.status}）。`;
      return fail(code, GUIDANCE[code] ?? rawMessage);
    }

    const applied = (data.applied ?? {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {
      op: "authorize_local_files",
      applied,
      note: "已授權。下一次讀取會自動放行（once 為一次性，用完即失效）。",
    };
    if (typeof data.persist_on_device === "boolean") payload.persist_on_device = data.persist_on_device;
    if (data.rules !== undefined) payload.rules = data.rules;
    return ok(payload);
  },
});