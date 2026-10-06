// 离站边界脱敏（Edge middleware）——控面代理路径的清洗点（durable 4 条除外，见下方清单：
// 那 4 条由生成源负责脱敏，因为本层在 Edge runtime 无法在平台时限内等到 status）。
//
// 问题（红队 2026-10-05 Hack 实测）：`next.config.mjs` 的 `beforeFiles` rewrite 由
// `src/lib/control-plane-proxy-routes.mjs` 的清单驱动；只要
// `GENERATION_CONTROL_PLANE_PROXY_ORIGIN` 有值（＝生产常态），命中路径会被直写到
// `<origin>/image-control<path>`，**同名 route.ts 及其脱敏永不执行**——前两轮在
// route.ts 里加的脱敏在生产是死码。
//
// 为什么 middleware 免疫 rewrite 绕过：Next 请求生命周期顺序为
// 「redirects → middleware → beforeFiles rewrites → filesystem routes」。
// middleware 先于 beforeFiles 执行；命中清单的请求由本档直接 fetch 上游并回传，
// 于是 beforeFiles rewrite 对这些路径**根本不会触发**。这是唯一在「不改控面、
// 不把长任务搬回 Vercel 函数（平台函数时限会杀掉生成中的同步等待）」前提下
// 能收口的位置。
//
// 清洗口径：
//  - 非 2xx：缓冲 body，结构内清洗（错误负载连键名一起洗）。
//  - 2xx：默认**逐位透传、不缓冲**（成功体是功能面，图片／SSE／大 JSON 必须原样）。
//    仅当 content-type 为 JSON 且体积小时，检视 payload 形状；若为错误形状
//    （`success:false` 或顶层 `error`），**键名与值一并清洗**——内部头名（`New-Api-User`）
//    与栏位名本身就是泄漏面，只洗值不洗键等于没洗（红队 2026-10-05 Hack 实测）。
//    判据在 upstream-sanitizer 的 isErrorShapedPayload（含功能键正向白名单，不误伤成功体）。
//    成功信封再补一道**栏位闸**：黑名单内的内部基础设施栏位名一并移除（只动键名、不动值），
//    与 `src/lib/proxy.ts` 共用 `stripInternalSuccessKeys`；无命中时逐位透传原文
//    （红队 2026-10-05 Hack 实测：成功信封的内部栏位名原样穿过，两条入口口径曾不一致）。
//    键名匹配前先 canonicalize（NFKC／去零宽／分隔符归一／限定同形字折叠）——H9 独立复验
//    反例②：零宽 `vendor\u200b_id`、全角 `model＿ratio`、中点 `model·price`、Cyrillic
//    `оwner_by` 曾在三入口全部穿透；media type 判定大小写不敏感（H9 反例①）。
//  - 上游连线失败：回固定文案 502，不夹带内部讯息。

import { NextRequest, NextResponse } from "next/server";
import { CONTROL_PLANE_PROXY_SOURCES } from "@/lib/control-plane-proxy-routes.mjs";
import {
  containsInternalLeak,
  isErrorShapedPayload,
  sanitizeErrorShapedPayload,
  sanitizeUpstreamBody,
  stripInternalKeysFromJson,
} from "@/lib/upstream-sanitizer";

// matcher 与内部判准的**大小写语义必须一致**（红队 2026-10-05 Hack 实测）：
// Next 的 `beforeFiles` rewrite 由 path-to-regexp 编译，**大小写不敏感**；但 middleware 的
// matcher 在 Next 建置期被序列化成「正则字串」后于运行时 `new RegExp(matcher.regexp)` 重建
// （见 next/dist/shared/lib/router/utils/middleware-route-matcher.js），**`i` 旗标在序列化时
// 丢失 ⇒ matcher 实际大小写敏感**。若 matcher 写具体前缀（`/api/:path*`），`/API/PIXAI/EDIT`
// 这类大写路径就「matcher 不命中 → middleware 不执行 → rewrite 直穿」，回到未脱敏的内部
// payload（Hack 实测：20 条 CP 路径大小写变体全可绕）。

// 修法（杜绝接缝）：matcher 只留**一个全覆盖模式**，真正的判准单一真源在 middleware 内用
// `CONTROL_PLANE_PROXY_SOURCES`（同一份清单）编译的正则——它带 `i` 旗标，且被本档直接持有，
// 不存在「matcher 编译丢失旗标」的接缝。未命中清单的请求立刻 `next()`，无 fetch、无缓冲。
// 只排除 Next 内部静态资源前缀（它们永远不可能出现在 CP 清单里）：减少无谓的 middleware 调用。
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

/**
 * 由清单编译 pathname 正则。两条铁律（红队 2026-10-05 Hack 实测，缺一即绕过）：
 *  ① `:path*` 语义＝**零或更多**段（与 Next/path-to-regexp 的 rewrite 一致）——
 *     裸 `/api/v1`、`/v1`、`/openai/v1`（零段）也必须命中。旧版编译成 `.+`
 *     （至少一段），零段直穿。故把 `:path*` 编译成可选组 `(?:/.*)?`。
 *  ② 大小写**不敏感**（`i`）：与 rewrite 侧一致，杜绝大写路径绕过。本正则由本档
 *     直接 new RegExp，不经过 Next 的 matcher 序列化，`i` 旗标不会丢失。
 */
const CONTROL_PLANE_PATTERNS: RegExp[] = CONTROL_PLANE_PROXY_SOURCES.map((source) => {
  let pattern = "";
  for (const segment of source.split("/")) {
    if (!segment) continue;
    if (segment === ":path*") {
      pattern += "(?:/.*)?";
      continue;
    }
    if (segment.startsWith(":")) {
      // 其他参数形态（当前清单未用到）：保守当作单段通配。
      pattern += "/[^/]+";
      continue;
    }
    pattern += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
  }
  return new RegExp(`^${pattern}$`, "i");
});

function matchesControlPlanePath(pathname: string): boolean {
  return CONTROL_PLANE_PATTERNS.some((re) => re.test(pathname));
}

/**
 * 长时同步端点的放行清单（**显式、不沉默**：本层物理上无法在时限内收口，收口在生成源）。
 *
 * 为什么本层**不能**拦截这 4 条（证据，非推测）：
 *  · 拦截＝必须先 `await` 上游响应头才能知道 status（成功/失败同一条生成链，只有跑完才产生）；
 *  · 本 middleware 在 Vercel 是 Edge runtime，平台硬限制：**必须 25 秒内开始发送响应**，
 *    之后才允许最多 300 秒的流式（Vercel 官方 limits：“Vercel Functions using the Edge
 *    runtime must begin sending a response within 25 seconds…streaming…up to 300 seconds”）。
 *    而这 4 条的首字节远慢于此：`/openai/v1/images/generations` 同步等待 p50 ≈36s（本仓
 *    实测，见 control-plane-proxy-routes.mjs 注释）；`/api/generate-images` 内联跑完整条
 *    生成回圈；voiceover 逐镜 TTS 轮询。拦截 ⇒ 长任务在 25s 被平台硬杀 ⇒ **durable work
 *    直接损坏**（正是本清单存在的原因）。
 *  · 「超时后回退 rewrite」不可行：请求已发给控面并可能已开始生成/扣费，回退＝二次提交、
 *    二次扣费（违反幂等不重复扣费）。
 *  故本层对这 4 条保持平台层直转（不占函数时限）。Hack 若用 mock 控面直出内部 payload，
 *  本层确实原样透传——这是设计取舍，不是遗漏。
 *
 * 收口改在**生成源**（这 4 条的错误体都由本仓 `src/` 内的 route 组装，运行在控面，
 * 见各档 file:line）：
 *   · `/openai/v1/images/generations` `src/app/openai/v1/images/generations/route.ts`
 *     ＋ `src/lib/openai-compat/{errors,generation}.ts`（上游 message 出站前过 sanitize）。
 *   · `/openai/v1/chat/completions` 同两条共享库（含 SSE error chunk）。
 *   · `/api/generate-images` `src/app/api/generate-images/route.ts`（failureReasons 过 sanitize）。
 *   · `/api/canvas/storyboard-voiceover` `src/app/api/canvas/storyboard-voiceover/route.ts`
 *     （job.failureDetail／error.message 过 sanitize）。
 * 判定依据：这 4 条的上游是生图／TTS 供应商与控面任务 API，**不是** new-api 的 SQL 面；
 * 其错误体经我方 route 重组，非裸 SQL 直出。红队实测的泄漏点位在 `/v1/*`、`/api/v1/*`、
 * `/api/token`、`/api/models`，全部不在本清单内且已被本层覆盖。
 *
 * 大小写不敏感：`/API/GENERATE-IMAGES` 等大写变体同样必须放行——否则本层会去 fetch
 * 长时端点并被 25s 硬杀（真实功能损伤）。与 CONTROL_PLANE_PATTERNS 同一 `i` 语义。
 */
const DURABLE_PASS_THROUGH: RegExp[] = [
  /^\/openai\/v1\/images\/generations$/i,
  /^\/openai\/v1\/chat\/completions$/i,
  /^\/api\/generate-images$/i,
  /^\/api\/canvas\/storyboard-voiceover$/i,
];

function isDurablePassThrough(pathname: string): boolean {
  return DURABLE_PASS_THROUGH.some((re) => re.test(pathname));
}

/** 请求头中不得透传的逐跳／长度相关头（由 fetch 依据实际 body 重算）。 */
const DROPPED_REQUEST_HEADERS = [
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
];

/** 2xx 时若 JSON 体积超过此值则直接串流透传，不缓冲（避免大 base64 常驻内存）。 */
const SUCCESS_INSPECT_MAX_BYTES = 512 * 1024;

function controlPlaneOrigin(): string {
  return (process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN ?? "").trim().replace(/\/+$/, "");
}

function safeResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  return headers;
}

export async function middleware(req: NextRequest): Promise<Response> {
  const origin = controlPlaneOrigin();
  // 未配置控面 origin（本地开发常态）＝beforeFiles rewrite 也不会生成，直接放行，
  // 让本地同名 route.ts 正常执行。
  if (!origin) return NextResponse.next();
  if (!matchesControlPlanePath(req.nextUrl.pathname)) return NextResponse.next();
  // 长时同步／流式端点：放行给既有外部 rewrite，不做本层缓冲（见 DURABLE_PASS_THROUGH）。
  if (isDurablePassThrough(req.nextUrl.pathname)) return NextResponse.next();

  const upstreamUrl = `${origin}/image-control${req.nextUrl.pathname}${req.nextUrl.search}`;

  const headers = new Headers(req.headers);
  for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      body = await req.arrayBuffer();
    } catch {
      body = undefined;
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      ...(body && body.byteLength > 0 ? { body } : {}),
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { success: false, message: "服务暂时不可用，请稍后再试" },
      { status: 502 },
    );
  }

  // ── 非 2xx：缓冲并清洗（错误负载连键名一起洗） ─────────────────────────────
  if (upstream.status >= 400) {
    const text = await upstream.text();
    const safe = sanitizeUpstreamBody(text);
    return new NextResponse(safe, {
      status: upstream.status,
      headers: safeResponseHeaders(upstream),
    });
  }

  // ── 2xx：默认逐位透传 ──────────────────────────────────────────────────────
  // media type 判定必须大小写不敏感（H9 反例①：旧写法 `includes("application/json")`
  // 大小写敏感，上游回 `Application/JSON` 时成功负载绕过栏位闸）。HTTP media type 大小写
  // 不敏感，故取 `;` 前的主型别 `toLowerCase()` 后全等比对；`+json`（如
  // `application/problem+json`）同样按 JSON 处理，不收窄旧子串匹配本就覆盖的范围。
  // **已声明边界（不要动）**：`text/plain` 等非 JSON 体不缓冲、直接串流——上游语义由
  // 生成源负责，不是本闸的漏；`>512KB` 大 body 同理（下方两处直接 return upstream）。
  const contentType = upstream.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  const isJsonMediaType = mediaType === "application/json" || mediaType.endsWith("+json");
  if (!isJsonMediaType) {
    // 图片／SSE／纯文本（含 text/plain）：直接串流，绝不缓冲。
    return upstream;
  }
  const declaredLength = Number(upstream.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > SUCCESS_INSPECT_MAX_BYTES) {
    return upstream;
  }

  const text = await upstream.text();
  // 大 JSON（无 content-length 或未超限但实际很大）也直接透传。
  if (text.length > SUCCESS_INSPECT_MAX_BYTES) {
    return new NextResponse(text, { status: upstream.status, headers: safeResponseHeaders(upstream) });
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isErrorShapedPayload(parsed)) {
      // 200 带错误体（例：{"success":false,"New-Api-User":"7","model_ratio":5}）：
      // 判据见 upstream-sanitizer 的 isErrorShapedPayload。判为错误形状则**键名与值一并清洗**
      // （内部头名/栏位名本身可能就是泄漏面）；正常成功体不进入此分支，功能字段一字不动。
      const safe = containsInternalLeak(text) ? sanitizeErrorShapedPayload(text) : text;
      return new NextResponse(safe, { status: upstream.status, headers: safeResponseHeaders(upstream) });
    }
    // 成功负载的「栏位闸」（红队 2026-10-05 Hack 实测：成功信封里的内部栏位名原样穿过）：
    // 只清键名黑名单（见 upstream-sanitizer 的 INTERNAL_SUCCESS_PAYLOAD_KEYS，含逐条收录证据），
    // 值一字不动；无命中回 null ⇒ 逐位透传原文（字节不变）。与 proxy.ts 共用同一 helper。
    const stripped = stripInternalKeysFromJson(text);
    if (stripped !== null) {
      return new NextResponse(stripped, { status: upstream.status, headers: safeResponseHeaders(upstream) });
    }
  } catch {
    // 非 JSON：原样透传。
  }
  // 成功负载透传：未命中栏位闸黑名单（或非 JSON）时逐位原样回传，功能字段一字不动。
  return new NextResponse(text, { status: upstream.status, headers: safeResponseHeaders(upstream) });
}