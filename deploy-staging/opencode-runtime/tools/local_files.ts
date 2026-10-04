import { tool } from "@opencode-ai/plugin/tool";
import { ok, fail } from "../lib/client";

// local_files — 本机档案桥（W6）的**云端侧工具**。
//
// 档案在使用者自己的电脑上，本工具跑在 VPS；因此这里**不做任何本机档案读取**，
// 也不得 import node:fs。一切走 loopback 的内部端点 `/internal/device/*`：
//   工具只知道 `session_id` → 闸道用 session 解出租户 → 挑该租户唯一在线装置 →
//   既有 DeviceBridge.invoke（白名单/denylist/授权根/大小夹制全在闸道侧）。
// 契约（冻结，与 gateway device-bridge.ts 一对一）：
//   POST /internal/device/invoke?session_id=…  body {op,path,pattern?,max_bytes?,limit?}
//   GET  /internal/device/status?session_id=…
// 总开关 EIMU_DEVICE_BRIDGE 预设 OFF：未开启时闸道不挂此路由，呼叫会落到 404（由 router 处理）。

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081";

const DEVICE_OPS = ["list_dir", "read_file", "grep", "stat"] as const;

/** 装置端 list_dir 的既有硬上限（desktop bridge-protocol MAX_LIST_ENTRIES＝闸道 max_entries 上界）。 */
const DEVICE_LIST_MAX_ENTRIES = 2000;
/** 装置端未带 max_entries 时的预设笔数（desktop bridge-executor MAX_LIST_DEFAULT）。 */
const DEVICE_LIST_DEFAULT_ENTRIES = 200;

/**
 * 把简易 glob（仅 `*`、`?`）转成整串锚定的 RegExp；其余字元逐一转义，
 * 避免使用者输入被当成任意正则（不含 `/`，只比对 basename）。
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
 * `name_glob` 匹配器（runtime 端过滤，装置呼叫完全不变）：
 * 只比对档名（basename）、**大小写敏感**（Linux 真实语义），支援 `*`（任意长度）与
 * `?`（单一字元）；不得含 `/`。
 */
export function nameGlobMatcher(nameGlob: string): (name: string) => boolean {
  const re = globToRegExp(nameGlob);
  return (name) => re.test(name);
}

/**
 * 错误码 → 面向使用者的引导语（繁中）。只在这些码用引导语；
 * 其余（session_unknown／bad_request／tool_not_allowed／internal_error）原样带出。
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

/** 需要补「目前授权根」的错误码（装置离线／路径未授权时，使用者最需要看到可授权的范围）。 */
const CODES_WITH_ROOTS = new Set(["device_offline", "path_not_authorized"]);

/**
 * `needs_authorization` 时给模型的**三段式选项逐字文案**。
 * 模型必须把 label 原样列给使用者，等他选定后，把该项的 scope 原封不动传给
 * `local_files_authorize`；不得升级（尤其不得自行选 permanent）。
 */
const AUTHORIZATION_OPTIONS = [
  { scope: "once", label: "允许一次" },
  { scope: "session", label: "本会话允许此目录" },
  { scope: "permanent", label: "永久允许（加入本机授权清单）" },
] as const;

/** 给模型的明确指令：先问使用者，不得自行决定。 */
const AUTHORIZATION_INSTRUCTION =
  "把上面三个选项原样列给使用者，等他回答后再呼叫 local_files_authorize；不要自行决定。";

/**
 * 读取本会话租户目前已授权的资料夹清单。任何失败（网路/非 JSON）回 null，
 * 呼叫端据此退回不含 root 的引导语（status 失败不影响主错误讯息）。
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
    "范围外一律被拒。四个 op：list_dir＝列出目录内容；read_file＝读取单一档案内容（有大小上限，过长会截断，回传 offset 时可用它分段续读整份）；" +
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
    "的全形括号与字句不可改成破折号或半形括号。" +
    "【读大档的硬规矩（read_file / offset）】" +
    "① read_file 单次有大小上限，档案过长只会回传第一段；回传会带 offset（本次起点）、bytes（本次实际读到的位元组数）、" +
    "next_offset（下一段起点＝offset+bytes）、has_more（是否还有后续）。" +
    "② has_more=true 时**必须**再呼叫 read_file 并把 offset 设为回传的 next_offset，反复续读直到 has_more=false，或改用 op=grep；" +
    "**不得**只读到第一段就宣称「已读完整份」「档案只有这些内容」。" +
    "③ 回报「所有」符合的项（例如所有含某关键字的段落／档案）时，必须说明依据：是分段读完（可列出各段 offset）还是 grep 的真实结果；" +
    "未读完或不完整时必须明说，不得当成全部。" +
    "④ has_more=null 表示装置未回报档案大小、无法判断是否读完；此时请自行比对回传的 size 与 offset+bytes 的大小，" +
    "或再带 offset=next_offset 读一次，直到回传内容为空。",
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
    offset: tool.schema
      .number()
      .optional()
      .describe(
        "read_file 的起始位元组位移（非负整数），用于分段续读大档：回传 has_more=true 时，把 offset 设为回传的 next_offset 再读。仅 op=read_file 适用。",
      ),
  },
  async execute(args, context) {
    const op = args.op;
    if (!(DEVICE_OPS as readonly string[]).includes(op)) {
      return fail("bad_request", `不支援的本机档案操作：${String(op)}（仅限 list_dir/read_file/grep/stat）。`);
    }

    // name_glob 只在云端 runtime 过滤，**不下发**给闸道／装置（冻结契约栏位不得增改）。
    const nameGlob = typeof args.name_glob === "string" ? args.name_glob : "";
    const useGlob = nameGlob.length > 0;
    if (useGlob && op !== "list_dir") {
      return fail("bad_request", `name_glob 仅支援 op=list_dir，不能用于 ${op}。`);
    }
    if (useGlob && nameGlob.includes("/")) {
      return fail("bad_request", "name_glob 只比对档名（basename），不可包含路径分隔符号（/）。");
    }

    // 只放行冻结契约栏位；undefined 不下发，让闸道用自己的预设上限。
    const body: Record<string, unknown> = { op, path: args.path };
    if (args.pattern !== undefined) body.pattern = args.pattern;
    if (args.max_bytes !== undefined) body.max_bytes = args.max_bytes;
    if (args.limit !== undefined) body.limit = args.limit;
    // offset：分段续读的起点（非负整数）。夹制仍在闸道 sanitizeToolArgs（唯一夹制点）。
    if (args.offset !== undefined) body.offset = args.offset;
    // 带 name_glob（＝要「列出所有」）时把 list_dir 的 max_entries 拉到装置既有上限 2000，
    // 以免预设 200 笔上限造成静默漏列；不超过装置上限，也不改装置端上限。
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

      // 路径尚未授权（冻结契约）：回结构化结果，让模型当场引导使用者三选一。
      // ⚠ denylist 不走这条（闸道回硬 deny／sensitive_path），故这里不得引导授权 denylist。
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
        const total = rawEntries.length; // 装置回的总项数（过滤前）
        const entries = useGlob
          ? rawEntries.filter((e) => nameGlobMatcher(nameGlob)(e.name))
          : rawEntries;
        const count = entries.length; // 本次回传的 entries 数（过滤后＝匹配数）
        // 把机制算好的过滤清单与计数写回 result，模型只需照抄。
        payload.result = { ...rawResult, entries, count };
        payload.count = count;
        payload.total = total;
        // 截断痕迹：闸道已标 truncated，或装置回满列举上限（请求 2000；另防闸道未下发
        // max_entries、装置沿用预设 200 造成的漏列）。只在 name_glob 有给时报 incomplete。
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
        // 内容过大被闸道截断、拿不到 entries 阵列：不得静默给清单。
        payload.incomplete = true;
        payload.note = `清单不完整：装置回传内容过大被截断，无法完整列出符合「${nameGlob}」的项目；请缩小目录范围后再试。`;
      }
    } else if (op === "read_file") {
      // 分段续读：装置端回 {offset, limit, size, bytes_read, text}，闸道原样保留这些后设栏位。
      const rawResult =
        data.result && typeof data.result === "object" ? (data.result as Record<string, unknown>) : {};
      const startOffset =
        typeof rawResult.offset === "number"
          ? rawResult.offset
          : typeof args.offset === "number"
            ? args.offset
            : 0;
      // 本次实际读到长度（位元组）：优先用装置回报的 bytes_read，退回闸道回报的 bytes。
      const readBytes =
        typeof rawResult.bytes_read === "number"
          ? rawResult.bytes_read
          : typeof data.bytes === "number"
            ? data.bytes
            : null;
      const size = typeof rawResult.size === "number" ? rawResult.size : null;
      payload.offset = startOffset;
      if (readBytes !== null) payload.bytes = readBytes;
      payload.next_offset = readBytes !== null ? startOffset + readBytes : null;
      // 是否还有后续：以「起点＋本次长度 < 档案大小」为准；资讯不足时退回闸道 truncated；
      // 两者都无法判断则 null（模型依 description 指示自行比对 size 与 offset+bytes，或再读一次）。
      if (size !== null && readBytes !== null) {
        payload.has_more = startOffset + readBytes < size;
      } else if (truncated) {
        payload.has_more = true;
      } else {
        payload.has_more = null;
      }
      if (payload.has_more === true) {
        payload.note =
          `本次只读到第 ${startOffset} 位元组起共 ${readBytes ?? "未知"} 位元组` +
          `（档案共 ${size ?? "未知"} 位元组），还有后续内容；**必须**再呼叫 read_file 带 ` +
          `offset=${payload.next_offset} 续读，直到 has_more=false，或改用 grep，才能宣称「已读完整份」／「所有符合项」。`;
      }
    } else if (truncated) {
      payload.note = "内容超过单次读取上限，已截断；如需更多内容请缩小范围或分段读取。";
    }
    return ok(payload);
  },
});