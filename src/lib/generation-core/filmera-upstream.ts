import {
  DEFAULT_IMAGE_MODEL_ID,
  NANO_BANANA_PRO_MODEL_ID,
  NANO_BANANA_2_MODEL_ID,
  SEEDANCE_20_MODEL_ID,
  SEEDREAM_50_PRO_MODEL_ID,
  SEEDREAM_50_LITE_MODEL_ID,
} from "../image-model-ids.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { SupplierRequestError } from "./failure-classifier";
import { cleanFilmeraWatermark, isFilmeraMediaUrl } from "./filmera-cleaner";
import type { SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

// filmera.ai 上游封装（2026-08-24 实测打通）。
//
// filmera 是 Next.js App Router + Supabase + pika 网关的套壳平台：所有生成走
// Next.js Server Action（纯 HTTP 可调），结果异步落入 Supabase 表，媒体走
// 公开 CDN。adapter 在请求内完成「改节点 → 触发 → 轮询 job → 拿 take URL」，
// 因为 worker 不做轮询，202 语义在这里由 adapter 内部消化。

const FILMERA_SERVER_ACTIONS = {
  generateImageRefTake: "70b05ecb88fca7de51fff8609b362f6f0ec96ae4c1",
  generateCanvasVideo: "70fffd9543c70a94e7897809c2c822e5968014be94",
  updateCanvasNode: "60b721a536f4e471e4adeda526d9ab41d5825115ba",
  // 2026-08-25 實證：新帳號自動初始化工作區用（createProject POST 到 /studio，body ["名稱"]）
  createProject: "00e97c7cc6cfabf5f9709263412f7086cefc6e6afe",
  // body [projectId, {type:"image-ref", data:{prompt:"", modelId:"gpt-image-2"}}]；成功時 RSC 無 ok 行，需查 Supabase 驗證
  addCanvasNode: "608ccb0a69a302ccbd2f02aebdf80aa10707feda0a",
} as const;

/** 平台模型 id → filmera 节点 modelId（图片）。 */
export const FILMERA_IMAGE_MODEL: Record<string, string> = {
  [DEFAULT_IMAGE_MODEL_ID]: "gpt-image-2",
  [NANO_BANANA_PRO_MODEL_ID]: "nano-banana-pro",
  [NANO_BANANA_2_MODEL_ID]: "nano-banana-2",
  [SEEDREAM_50_PRO_MODEL_ID]: "seedream-5.0-pro",
  [SEEDREAM_50_LITE_MODEL_ID]: "seedream-5.0-lite",
};

/** 平台模型 id → filmera 节点 modelId（视频）。 */
export const FILMERA_VIDEO_MODEL: Record<string, string> = {
  [SEEDANCE_20_MODEL_ID]: "seedance-2.0",
};

export const FILMERA_SUPPORTED_MODEL_IDS: string[] = [
  ...Object.keys(FILMERA_IMAGE_MODEL),
  ...Object.keys(FILMERA_VIDEO_MODEL),
];

export function isFilmeraModel(modelId: string): boolean {
  return modelId in FILMERA_IMAGE_MODEL || modelId in FILMERA_VIDEO_MODEL;
}

export function resolveFilmeraImageModelId(modelId: string): string | null {
  return FILMERA_IMAGE_MODEL[modelId] ?? null;
}

export function resolveFilmeraVideoModelId(modelId: string): string | null {
  return FILMERA_VIDEO_MODEL[modelId] ?? null;
}

/** 額度耗盡信號：讓 VPS 帳號池守護切換帳號（信號目錄掛載共享，best-effort 不擋出圖流程）。 */
function requestFilmeraAccountSwitch(reason: string): void {
  const signalDir = process.env.FILMERA_ACCOUNTS_DIR ?? "/opt/filmera-accounts";
  try {
    mkdirSync(signalDir, { recursive: true });
    appendFileSync(`${signalDir}/switch-requested`, `${Date.now()} ${reason}\n`);
    console.warn(`[filmera-upstream] 帳號額度耗盡，已發出切換信號: ${reason.slice(0, 100)}`);
  } catch (error) {
    console.warn(`[filmera-upstream] 切換信號寫入失敗: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const FILMERA_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

type FilmeraConfig = {
  supabaseUrl: string;
  anonKey: string;
  /** projectId/nodeId 僅作 cache 起點，可缺省——缺失時由 ensureFilmeraContext 動態解析。 */
  projectId?: string;
  nodeId?: string;
  /** video-gen 节点（可选，视频生成用；缺省回退 nodeId）。 */
  videoNodeId?: string;
};

function readConfig(supplier: SupplierRecord): FilmeraConfig {
  const raw = supplier.configuration;
  const config = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : raw;
  const env = process.env;
  const supabaseUrl = String(config.supabaseUrl ?? env.FILMERA_SUPABASE_URL ?? "");
  const anonKey = String(config.anonKey ?? env.FILMERA_ANON_KEY ?? "");
  const projectId = String(config.projectId ?? env.FILMERA_PROJECT_ID ?? "");
  const nodeId = String(config.nodeId ?? env.FILMERA_NODE_ID ?? "");
  const videoNodeId = String(config.videoNodeId ?? env.FILMERA_VIDEO_NODE_ID ?? "");
  if (!supabaseUrl || !anonKey) {
    throw new SupplierRequestError(
      "Filmera supplier is missing configuration: FILMERA_SUPABASE_URL / FILMERA_ANON_KEY.",
      500,
    );
  }
  return { supabaseUrl, anonKey, ...(projectId ? { projectId } : {}), ...(nodeId ? { nodeId } : {}), ...(videoNodeId ? { videoNodeId } : {}) };
}

// 完整 session cookie：Supabase SSR middleware 需要 user 字段才能通过认证，
// 最小 session（只有 access_token）会让 server action 静默失败（HTTP 200 但不写库）。
type FilmeraUser = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Token 生命週期管理（2026-08-25）：access_token 壽命 3600s，過期前 5 分鐘自動
// 用 refresh_token 輪換（POST /auth/v1/token?grant_type=refresh_token，refresh_token
// 每次輪換）。輪換成功後回調 onFilmeraTokenRotated 讓控制面持久化新值（本地默認 no-op）。
// ---------------------------------------------------------------------------

interface FilmeraTokenState {
  accessToken: string;
  refreshToken: string;
  /** unix 秒 */
  expiresAt: number;
  user: FilmeraUser | null;
}

type TokenRotatedCallback = (next: { accessToken: string; refreshToken: string; expiresAt: number }) => void;

let tokenState: FilmeraTokenState | null = null;
let tokenRotatedCallback: TokenRotatedCallback | null = null;
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;

/** 控制面註冊持久化回調（寫回 .env / DB），保持 token 輪換跨重啟不丟。 */
export function onFilmeraTokenRotated(callback: TokenRotatedCallback): void {
  tokenRotatedCallback = callback;
}

function loadTokenStateFromEnv(): FilmeraTokenState | null {
  const accessToken = (process.env.FILMERA_AUTH_TOKEN ?? "").trim();
  if (!accessToken) return null;
  const refreshToken = (process.env.FILMERA_REFRESH_TOKEN ?? "").trim();
  return {
    accessToken,
    refreshToken,
    // 無獨立過期信息時視為即將過期，首次調用即觸發 refresh（有 refresh_token 才會真正刷）
    expiresAt: refreshToken ? 0 : Math.floor(Date.now() / 1000) + 3600,
    user: null,
  };
}

async function refreshFilmeraToken(config: FilmeraConfig, state: FilmeraTokenState, signal?: AbortSignal): Promise<FilmeraTokenState> {
  if (!state.refreshToken) {
    throw new SupplierRequestError("Filmera refresh token missing; cannot renew access token.", 401);
  }
  const url = `${config.supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`;
  const response = await fetch(url, {
    method: "POST",
    headers: { apikey: config.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: state.refreshToken }),
    signal,
  });
  if (!response.ok) {
    throw new SupplierRequestError(`Filmera token refresh failed: HTTP ${response.status}.`, response.status === 400 || response.status === 401 || response.status === 403 ? 401 : 502);
  }
  const session = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    expires_in?: number;
    user?: FilmeraUser;
  };
  if (!session.access_token) {
    throw new SupplierRequestError("Filmera token refresh returned no access_token.", 502);
  }
  const next: FilmeraTokenState = {
    accessToken: session.access_token,
    refreshToken: session.refresh_token ?? state.refreshToken,
    expiresAt: session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
    user: session.user ?? state.user,
  };
  tokenState = next;
  try {
    tokenRotatedCallback?.({ accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt });
  } catch (error) {
    console.warn(`[filmera-upstream] token persisted callback failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return next;
}

/** 取新鮮 access_token：距過期 < 5 分鐘自動輪換；供 health 檢查與生成分流共用。 */
async function getValidFilmeraToken(config: FilmeraConfig, signal?: AbortSignal): Promise<FilmeraTokenState> {
  if (!tokenState) tokenState = loadTokenStateFromEnv();
  if (!tokenState) {
    throw new SupplierRequestError("Missing configured credential FILMERA_AUTH_TOKEN.", 401);
  }
  const expiresSoon = tokenState.expiresAt * 1000 - Date.now() < TOKEN_EXPIRY_MARGIN_MS;
  if (expiresSoon && tokenState.refreshToken) {
    return refreshFilmeraToken(config, tokenState, signal);
  }
  return tokenState;
}

/** health 探測入口：拿（必要時刷新後的）access token 與 user。 */
export async function getFilmeraAccessToken(config: { supabaseUrl?: string; anonKey?: string } = {}): Promise<{ token: string; user: FilmeraUser | null }> {
  const resolved: FilmeraConfig = {
    supabaseUrl: config.supabaseUrl || process.env.FILMERA_SUPABASE_URL || "https://wxoujoeuqbkaniujulag.supabase.co",
    anonKey: config.anonKey || process.env.FILMERA_ANON_KEY || "",
  };
  if (!resolved.anonKey) throw new SupplierRequestError("Missing FILMERA_ANON_KEY.", 500);
  const state = await getValidFilmeraToken(resolved);
  return { token: state.accessToken, user: state.user };
}

/** 測試輔助：重置 token 與 context 緩存。 */
export function resetFilmeraUserCache(): void {
  tokenState = null;
  contextCache = null;
}

async function fetchFilmeraUser(config: FilmeraConfig, token: string, signal?: AbortSignal): Promise<FilmeraUser> {
  const url = `${config.supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`;
  const response = await fetch(url, {
    headers: { apikey: config.anonKey, Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) {
    throw new SupplierRequestError(`Filmera auth check failed: HTTP ${response.status}.`, response.status === 401 || response.status === 403 ? 401 : 502);
  }
  const user = (await response.json()) as FilmeraUser;
  if (tokenState && tokenState.accessToken === token) tokenState.user = user;
  return user;
}

function cookieValue(accessToken: string, refreshToken: string, expiresAt: number, user: FilmeraUser): string {
  const session = {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: refreshToken,
    user,
  };
  const encoded = Buffer.from(JSON.stringify(session)).toString("base64");
  return `base64-${encoded}`;
}

type ServerActionResult = { ok: boolean; message?: string; status?: number };

/** 調 server action 並返回原始 RSC 文本（createProject 這類回路由樹的 action 用）。 */
async function callServerActionText(
  cookie: string,
  actionId: string,
  args: unknown[],
  pagePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const page = `https://www.filmera.ai${pagePath}`;
  const response = await fetch(page, {
    method: "POST",
    headers: {
      "User-Agent": FILMERA_UA,
      Accept: "text/x-component",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "text/plain;charset=UTF-8",
      Origin: "https://www.filmera.ai",
      Referer: page,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      Cookie: `sb-wxoujoeuqbkaniujulag-auth-token=${cookie}`,
      "Next-Action": actionId,
    },
    body: JSON.stringify(args),
    signal,
  });
  if (!response.ok) {
    throw new SupplierRequestError(`Filmera server action failed: HTTP ${response.status}.`, response.status);
  }
  return response.text();
}

async function callServerAction(
  cookie: string,
  projectId: string,
  actionId: string,
  args: unknown[],
  signal?: AbortSignal,
  /** false = 该 action 无业务返回值（如 updateCanvasNode 只回 RSC UI 流），HTTP 200 即成功。 */
  expectResult = true,
  /** action 所在頁面；默認 canvas 頁。createProject 在 /studio。 */
  pagePath = "",
): Promise<ServerActionResult> {
  const path = pagePath || (projectId ? `/studio/p/${projectId}/canvas` : "/studio");
  const page = `https://www.filmera.ai${path}`;
  const response = await fetch(page, {
    method: "POST",
    headers: {
      "User-Agent": FILMERA_UA,
      Accept: "text/x-component",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "text/plain;charset=UTF-8",
      Origin: "https://www.filmera.ai",
      Referer: page,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      Cookie: `sb-wxoujoeuqbkaniujulag-auth-token=${cookie}`,
      "Next-Action": actionId,
    },
    body: JSON.stringify(args),
    signal,
  });
  if (!response.ok) {
    throw new SupplierRequestError(`Filmera server action failed: HTTP ${response.status}.`, response.status);
  }
  if (!expectResult) return { ok: true };
  const text = await response.text();
  for (const line of text.split("\n")) {
    if (!line.includes('"ok"')) continue;
    try {
      // RSC 流行首是序号前缀（如 "1:{...}"），剥掉再解析。
      const payload = line.replace(/^\d+:/, "");
      const parsed = JSON.parse(payload) as ServerActionResult;
      if (typeof parsed.ok === "boolean") return parsed;
    } catch {
      // RSC 流里可能夹带非 JSON 行，跳过继续找。
    }
  }
  throw new SupplierRequestError("Filmera server action returned no recognizable result.", 502);
}

type SupabaseRow = Record<string, unknown>;

async function supabaseSelect(
  config: FilmeraConfig,
  token: string,
  table: string,
  query: string,
  signal?: AbortSignal,
): Promise<SupabaseRow[]> {
  const url = `${config.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${table}?${query}`;
  const response = await fetch(url, {
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${token}`,
    },
    signal,
  });
  if (!response.ok) {
    throw new SupplierRequestError(`Filmera Supabase query failed: HTTP ${response.status}.`, response.status);
  }
  return (await response.json()) as SupabaseRow[];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new SupplierRequestError("Filmera generation timed out.", 408));
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Project / Node 上下文自愈（2026-08-25）：env 的 PROJECT_ID/NODE_ID 只是 cache
// 起點。帳號輪換後舊 ID 跨帳號無權限 → server action 500。ensureFilmeraContext
// 查當前用戶名下最新 project → 無則 createProject → 查 image-ref 節點 → 無則
// addCanvasNode（成功時 RSC 無 ok 行，需重查 Supabase 拿新節點 id）。
// ---------------------------------------------------------------------------

interface FilmeraContext {
  projectId: string;
  imageNodeId: string;
}

let contextCache: FilmeraContext | null = null;

async function ensureFilmeraContext(
  config: FilmeraConfig,
  token: string,
  user: FilmeraUser,
  signal?: AbortSignal,
  force = false,
): Promise<FilmeraContext> {
  if (!force && contextCache) return contextCache;

  const userId = String(user.id ?? "");
  if (!userId) throw new SupplierRequestError("Filmera user payload has no id; cannot resolve workspace.", 401);

  // 1) 查用戶名下最新非模板 project；env/config 提供的 projectId 也先驗證歸屬
  const projects = await supabaseSelect(
    config,
    token,
    "studio_projects",
    `select=id,owner_id&template_snapshot=eq.false&order=created_at.desc&limit=5`,
    signal,
  );
  let projectId = projects.find((p) => String(p.owner_id ?? "") === userId)?.id as string | undefined;
  if (!projectId) {
    // 2) 無 project → createProject（POST 到 /studio，body ["名稱"]）
    //    RSC 響應的 ok 行解析不可靠（createProject 回的是路由樹），改為直接讀 text 提取 projectId
    const createdText = await callServerActionText(
      buildSessionCookie(token, "", 0, user),
      FILMERA_SERVER_ACTIONS.createProject,
      ["Emu Worker"],
      "/studio",
      signal,
    );
    const match = createdText.match(/"projectId":"([0-9a-f-]{36})"/);
    projectId = match?.[1];
    if (!projectId) {
      // RSC 結構不可解析時退回重查
      const retry = await supabaseSelect(
        config,
        token,
        "studio_projects",
        `select=id&template_snapshot=eq.false&order=created_at.desc&limit=1`,
        signal,
      );
      projectId = retry[0]?.id as string | undefined;
    }
  }
  if (!projectId) throw new SupplierRequestError("Filmera workspace init failed: no project id.", 502);

  // 3) 查 image-ref 節點
  const nodes = await supabaseSelect(
    config,
    token,
    "studio_canvas_nodes",
    `select=id,type&project_id=eq.${projectId}&limit=20`,
    signal,
  );
  let imageNodeId = nodes.find((n) => String(n.type ?? "") === "image-ref")?.id as string | undefined;

  // 4) 無節點 → addCanvasNode（body 必須是 [projectId, {type, data}] 對象形式；位置參數形式會 500）
  if (!imageNodeId) {
    await callServerAction(
      buildSessionCookie(token, "", 0, user),
      projectId,
      FILMERA_SERVER_ACTIONS.addCanvasNode,
      [projectId, { type: "image-ref", data: { prompt: "", modelId: "gpt-image-2" } }],
      signal,
      false,
    );
    const retryNodes = await supabaseSelect(
      config,
      token,
      "studio_canvas_nodes",
      `select=id,type&project_id=eq.${projectId}&limit=20`,
      signal,
    );
    imageNodeId = retryNodes.find((n) => String(n.type ?? "") === "image-ref")?.id as string | undefined;
  }
  if (!imageNodeId) throw new SupplierRequestError("Filmera workspace init failed: no image-ref node.", 502);

  contextCache = { projectId, imageNodeId };
  return contextCache;
}

function buildSessionCookie(accessToken: string, refreshToken: string, expiresAt: number, user: FilmeraUser): string {
  return cookieValue(accessToken, refreshToken || "x", expiresAt || Math.floor(Date.now() / 1000) + 3600, user);
}

async function pollJob(
  config: FilmeraConfig,
  token: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ jobId: string; takeId: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = await supabaseSelect(
      config,
      token,
      "studio_generation_jobs",
      "select=id,status,progress,result_take_id,error&order=created_at.desc&limit=1",
      signal,
    );
    const job = jobs[0];
    if (job) {
      const status = String(job.status ?? "");
      if (status === "done") {
        const takeId = job.result_take_id ? String(job.result_take_id) : null;
        if (takeId) return { jobId: String(job.id), takeId };
        throw new SupplierRequestError("Filmera job finished without a result take.", 502);
      }
      if (status === "failed" || status === "error") {
        throw new SupplierRequestError(String(job.error ?? "Filmera generation failed."), 502);
      }
    }
    await sleep(8_000, signal);
  }
  throw new SupplierRequestError("Filmera generation timed out while polling.", 408);
}

async function resolveTakeMedia(
  config: FilmeraConfig,
  token: string,
  takeId: string,
  signal?: AbortSignal,
): Promise<string> {
  const takes = await supabaseSelect(
    config,
    token,
    "studio_media_takes",
    `select=id,image_url,video_url&id=eq.${takeId}`,
    signal,
  );
  const take = takes[0];
  const url = take ? String(take.image_url ?? take.video_url ?? "") : "";
  if (!url) throw new SupplierRequestError("Filmera take has no media URL.", 502);
  return url;
}

export async function generateWithFilmera(
  supplier: SupplierRecord,
  input: SupplierGenerationInput,
  signal?: AbortSignal,
): Promise<SupplierGenerationOutput> {
  if (!(process.env[supplier.credentialRef] ?? process.env[supplier.account.credentialRef] ?? "").trim() && !process.env.FILMERA_REFRESH_TOKEN) {
    throw new SupplierRequestError(`Missing configured credential ${supplier.credentialRef}.`, 401);
  }
  const config = readConfig(supplier);

  const isVideo = input.kind === "video_generate";
  const filmeraModel = isVideo ? resolveFilmeraVideoModelId(input.modelId) : resolveFilmeraImageModelId(input.modelId);
  if (!filmeraModel) {
    throw new SupplierRequestError(`Filmera does not serve model ${input.modelId}.`, 400);
  }
  if (!isVideo && input.kind !== "image_generate" && input.kind !== "image_edit") {
    throw new SupplierRequestError(`Filmera does not serve kind ${input.kind}.`, 400);
  }

  // 内部超时：server action / supabase / 轮询共享同一 signal
  const timeoutMs = isVideo ? 600_000 : 180_000;
  const internalSignal = signal ?? AbortSignal.timeout(timeoutMs);

  // Token 生命週期：距過期 < 5 分鐘自動用 refresh_token 輪換
  const state = await getValidFilmeraToken(config, internalSignal);
  const token = state.accessToken;
  const refreshToken = state.refreshToken;
  const expiresAt = state.expiresAt;

  // 完整 session cookie（含 user）——认证必需
  const user = state.user ?? await fetchFilmeraUser(config, token, internalSignal);
  const cookie = cookieValue(token, refreshToken, expiresAt, user);

  // 上下文自愈：動態解析 projectId/imageNodeId（env 只是 cache 起點）
  const context = await ensureFilmeraContext(config, token, user, internalSignal);
  const genNodeId = isVideo ? (config.videoNodeId || context.imageNodeId) : context.imageNodeId;

  // 1) 改写节点 prompt + modelId（filmera 生成用的是节点的 data.prompt；图片/视频节点不同）
  //    500 時（跨帳號節點失效等）強制重建上下文重試一次
  const runGeneration = async (ctx: FilmeraContext): Promise<SupplierGenerationOutput> => {
    const nodeId = isVideo ? (config.videoNodeId || ctx.imageNodeId) : ctx.imageNodeId;
    const update = await callServerAction(
      cookieValue(token, refreshToken, expiresAt, user),
      ctx.projectId,
      FILMERA_SERVER_ACTIONS.updateCanvasNode,
      [nodeId, { data: { prompt: input.prompt, modelId: filmeraModel } }],
      internalSignal,
      false,
    );
    if (!update.ok) {
      throw new SupplierRequestError(`Filmera node update failed: ${update.message ?? "unknown"}.`, update.status ?? 502);
    }

    // 2) 触发生成
    const actionId = isVideo ? FILMERA_SERVER_ACTIONS.generateCanvasVideo : FILMERA_SERVER_ACTIONS.generateImageRefTake;
    const trigger = await callServerAction(
      cookieValue(token, refreshToken, expiresAt, user),
      ctx.projectId,
      actionId,
      [ctx.projectId, nodeId, {}],
      internalSignal,
    );
    if (!trigger.ok) {
      if (trigger.status === 402) {
        // 額度耗盡（實測信號：{ok:false,status:402,message:"Insufficient credits..."}}）。
        // 觸碰切換信號文件，帳號池守護檢出後自動切下一個帳號。
        requestFilmeraAccountSwitch(String(trigger.message ?? "insufficient credits"));
      }
      throw new SupplierRequestError(`Filmera generation rejected: ${trigger.message ?? "unknown"}.`, trigger.status ?? 502);
    }

    // 3) 轮询 job（concurrency_limit=1 保证同一项目同一时刻只有一个 job，取最新即本次）
    const { jobId, takeId } = await pollJob(config, token, timeoutMs, internalSignal);

    // 4) 拿媒体 URL
    const url = await resolveTakeMedia(config, token, takeId, internalSignal);

    // 5) filmera 免費層導出帶水印 → 下載清洗後以 base64 交付（清洗失敗安全回退原 URL）
    if (!isVideo && isFilmeraMediaUrl(url)) {
      try {
        const cleaned = await cleanFilmeraWatermark(url, internalSignal);
        return {
          base64: cleaned.buffer.toString("base64"),
          url,
          providerRequestId: undefined,
          providerTaskId: jobId,
          httpStatus: 200,
          endpointLabel: supplier.label,
          supplierModelId: filmeraModel,
          evidence: {
            adapter: "filmera",
            supplierId: supplier.id,
            failureDomain: supplier.failureDomain,
            watermarkCleaned: true,
          },
        };
      } catch (error) {
        console.warn(`[filmera-upstream] watermark clean failed, serving raw media: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      base64: null,
      url,
      providerRequestId: undefined,
      providerTaskId: jobId,
      httpStatus: 200,
      endpointLabel: supplier.label,
      supplierModelId: filmeraModel,
      evidence: {
        adapter: "filmera",
        supplierId: supplier.id,
        failureDomain: supplier.failureDomain,
      },
    };
  };

  try {
    return await runGeneration(context);
  } catch (error) {
    const isServerError = error instanceof SupplierRequestError && (error.status === 500 || error.status === 502);
    if (!isServerError) throw error;
    // 自愈重試：強制重建 project/node 上下文後再試一次（只重試一次）
    contextCache = null;
    const freshContext = await ensureFilmeraContext(config, token, user, internalSignal, true);
    return await runGeneration(freshContext);
  }
}
