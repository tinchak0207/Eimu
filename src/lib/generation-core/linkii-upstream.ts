import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AspectRatio } from "@/lib/generation-model-catalog";
import { nearestAspectRatio } from "@/lib/generation-model-catalog/resolution";
import {
  GPT_IMAGE_25_FLARE_MODEL_ID,
  GPT_IMAGE_25_SUNBURST_MODEL_ID,
  KLING_21_IMAGE_MODEL_ID,
  SI_45_IMAGE_MODEL_ID,
  VIDU_Q2_IMAGE_MODEL_ID,
  VIDU_Q3_TURBO_VIDEO_MODEL_ID,
} from "../image-model-ids.js";
import { SupplierRequestError } from "./failure-classifier";
import type { SupplyAdapter } from "./supply-registry";
import type {
  ProviderTaskPollResult,
  SupplierGenerationInput,
  SupplierGenerationOutput,
  SupplierRecord,
} from "./types";

const DEFAULT_LINKII_BASE_URL = "https://www.linkii.tech/api/admin";
const DEFAULT_LINKII_MEDIA_BASE_URL = "https://res.linkii.tech/";
const DEFAULT_LINKII_TOKEN_CACHE_FILE = "/tmp/linkii-cp-token-cache.json";
const LINKII_CLIENT_ID = "195da9fcce574852b850068771cde035";
const LINKII_LOCALE = "zh-MO";

const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const C1015_COOLDOWN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const DRAWING_POLL_INTERVAL_MS = 3_500;
const DRAWING_MAX_WAIT_MS = 10 * 60_000;
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_MAX_WAIT_MS = 18 * 60_000;

const DRAWING_SUPPORTED_RATIOS: readonly AspectRatio[] = ["1:1", "4:3", "3:4", "16:9", "9:16"];
const DRAWING_ALLOWED_RATIOS = new Set<string>(DRAWING_SUPPORTED_RATIOS);
const DRAWING_EXPLICIT_RATIO_MAP: Record<string, string> = {
  "3:2": "4:3",
  "2:3": "3:4",
  "5:4": "4:3",
  "4:5": "3:4",
  "21:9": "16:9",
  "9:21": "9:16",
};
const VIDEO_ALLOWED_RATIOS = new Set(["16:9", "9:16", "3:4", "4:3", "1:1"]);
const SUCCESS_CODES = new Set(["0", "200", "0000", "00000", "ok", "success"]);

export interface LinkiiDeploymentSpec {
  deploymentId: number;
  upstreamModel: string;
}

export const LINKII_IMAGE_DEPLOYMENTS: Record<string, LinkiiDeploymentSpec> = {
  [GPT_IMAGE_25_SUNBURST_MODEL_ID]: { deploymentId: 543, upstreamModel: "og-image2.5-sunburst-medium" },
  [GPT_IMAGE_25_FLARE_MODEL_ID]: { deploymentId: 549, upstreamModel: "og-image2.5-flare-high" },
  [KLING_21_IMAGE_MODEL_ID]: { deploymentId: 515, upstreamModel: "kling-2.1" },
  [VIDU_Q2_IMAGE_MODEL_ID]: { deploymentId: 519, upstreamModel: "vidu-q2" },
  [SI_45_IMAGE_MODEL_ID]: { deploymentId: 511, upstreamModel: "si-4.5" },
};

export const LINKII_VIDEO_DEPLOYMENTS: Record<string, LinkiiDeploymentSpec> = {
  [VIDU_Q3_TURBO_VIDEO_MODEL_ID]: { deploymentId: 603, upstreamModel: "video-vidu-q3-turbo" },
};

export const LINKII_SUPPORTED_MODEL_IDS: readonly string[] = [
  ...Object.keys(LINKII_IMAGE_DEPLOYMENTS),
  ...Object.keys(LINKII_VIDEO_DEPLOYMENTS),
];

interface LinkiiTokenCacheEntry {
  accountHash: string;
  accessToken: string;
  expMs: number | null;
}

let memoryTokenCache: LinkiiTokenCacheEntry | null = null;
let loginInFlight: Promise<string> | null = null;
let c1015CooldownUntilMs = 0;

function readLinkiiBaseUrl(supplier?: SupplierRecord): string {
  const raw = (process.env.LINKII_BASE_URL ?? supplier?.baseUrl ?? DEFAULT_LINKII_BASE_URL).trim();
  return (raw || DEFAULT_LINKII_BASE_URL).replace(/\/+$/, "");
}

function readLinkiiMediaBaseUrl(): string {
  const raw = (process.env.LINKII_MEDIA_BASE_URL ?? DEFAULT_LINKII_MEDIA_BASE_URL).trim();
  const base = (raw || DEFAULT_LINKII_MEDIA_BASE_URL).replace(/\/+$/, "");
  return `${base}/`;
}

function readLinkiiTokenCacheFile(): string {
  const raw = (process.env.LINKII_TOKEN_CACHE_FILE ?? "").trim();
  return raw || DEFAULT_LINKII_TOKEN_CACHE_FILE;
}

function readLinkiiCredentials(): { username: string; password: string } {
  const username = (process.env.LINKII_USERNAME ?? "").trim();
  const password = process.env.LINKII_PASSWORD ?? "";
  return { username, password };
}

function computeAccountHash(baseUrl: string, username: string): string {
  return createHash("sha256").update(`${baseUrl}\0${username}`).digest("hex");
}

function parseJwtExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { exp?: unknown };
    if (typeof decoded.exp === "number" && Number.isFinite(decoded.exp)) {
      return decoded.exp * 1000;
    }
  } catch {
    return null;
  }
  return null;
}

function isTokenFresh(expMs: number | null, nowMs = Date.now()): boolean {
  if (expMs === null) return false;
  return expMs - nowMs >= TOKEN_REFRESH_MARGIN_MS;
}

function loadDiskTokenCache(accountHash: string): LinkiiTokenCacheEntry | null {
  const cacheFile = readLinkiiTokenCacheFile();
  try {
    const raw = readFileSync(cacheFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<LinkiiTokenCacheEntry>;
    if (
      parsed.accountHash === accountHash &&
      typeof parsed.accessToken === "string" &&
      parsed.accessToken.trim() &&
      isTokenFresh(typeof parsed.expMs === "number" ? parsed.expMs : null)
    ) {
      return {
        accountHash,
        accessToken: parsed.accessToken.trim(),
        expMs: typeof parsed.expMs === "number" ? parsed.expMs : null,
      };
    }
  } catch {
    // Missing or unreadable cache file is expected on cold start.
  }
  return null;
}

function saveDiskTokenCache(entry: LinkiiTokenCacheEntry): void {
  const cacheFile = readLinkiiTokenCacheFile();
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
    chmodSync(cacheFile, 0o600);
  } catch (error) {
    console.warn(`[linkii-upstream] failed to persist token cache: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clearTokenCache(): void {
  memoryTokenCache = null;
  const cacheFile = readLinkiiTokenCacheFile();
  try {
    writeFileSync(cacheFile, "{}", { encoding: "utf8", mode: 0o600 });
    chmodSync(cacheFile, 0o600);
  } catch {
    // Best-effort clear only.
  }
}

function resolveMediaUrl(raw: string, mediaBaseUrl: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${mediaBaseUrl.replace(/\/+$/, "")}/${trimmed.replace(/^\/+/, "")}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function extractMessage(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  for (const key of ["msg", "message", "errorMessage", "error"] as const) {
    const val = payload[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

function isLinkiiSuccessCode(code: unknown): boolean {
  if (code === undefined || code === null) return true;
  return SUCCESS_CODES.has(String(code).trim().toLowerCase());
}

function classifyLinkiiBusinessFailure(
  message: string,
  httpStatus: number,
  rawBody: string,
  providerTaskId?: string,
  code?: unknown,
): SupplierRequestError {
  const codeText = code !== undefined && code !== null ? String(code).trim() : "";
  const combined = `${codeText} ${message}`;
  const non2xxUpstreamStatus = (fallback: number) => (httpStatus >= 400 ? httpStatus : fallback);
  if (
    codeText === "C9999" &&
    /(正在生成中|請等待完成|请等待完成|等待完成後再提交|等待完成后再提交|already generating|in progress)/i.test(
      message,
    )
  ) {
    return new SupplierRequestError(
      message || "Linkii drawing slot busy (C9999).",
      503,
      "10",
      rawBody,
      "overloaded",
      providerTaskId,
      503,
    );
  }
  if (codeText === "C1015" || httpStatus === 429) {
    return new SupplierRequestError(
      message || "Linkii rate limited.",
      429,
      "300",
      rawBody,
      "rate_limited",
      providerTaskId,
      non2xxUpstreamStatus(429),
    );
  }
  if (
    httpStatus === 402 ||
    /配额|额度不足|余额不足|积分不足|次数不足|次数已用完|quota|insufficient.*(credit|balance|quota)|balance.*exhausted/i.test(
      combined,
    )
  ) {
    return new SupplierRequestError(
      message || "Linkii quota exhausted.",
      402,
      undefined,
      rawBody,
      "quota_exhausted",
      providerTaskId,
      non2xxUpstreamStatus(402),
    );
  }
  if (
    httpStatus === 451 ||
    /内容审查|违规|敏感词|安全审核|审核未通过|未通过审核|不合规|违禁|content.*reject|moderation|nsfw|safety|sensitive|prohibited|violat/i.test(
      combined,
    )
  ) {
    return new SupplierRequestError(
      message || "Linkii content rejected.",
      400,
      undefined,
      rawBody,
      "content_rejected",
      providerTaskId,
      non2xxUpstreamStatus(400),
    );
  }
  const normalizedStatus = httpStatus >= 400 && httpStatus <= 499 ? httpStatus : 502;
  return new SupplierRequestError(
    message || `Linkii request failed (HTTP ${httpStatus}${codeText ? `, code=${codeText}` : ""}).`,
    normalizedStatus,
    undefined,
    rawBody,
    undefined,
    providerTaskId,
    non2xxUpstreamStatus(normalizedStatus),
  );
}

function encryptLinkiiPassword(password: string, secretKey: string): { encrypted: string; ivBase64: string } {
  const iv12 = randomBytes(12);
  const keyBuf = Buffer.from(secretKey, "utf8");
  const cipher = createCipheriv("aes-128-gcm", keyBuf, iv12);
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
  return { encrypted, ivBase64: iv12.toString("base64") };
}

async function performLogin(baseUrl: string): Promise<string> {
  if (Date.now() < c1015CooldownUntilMs) {
    const remainingSec = Math.max(1, Math.ceil((c1015CooldownUntilMs - Date.now()) / 1000));
    throw new SupplierRequestError(
      "Linkii login rate limited (C1015 cooldown active).",
      429,
      String(remainingSec),
      undefined,
      "rate_limited",
    );
  }

  const { username, password } = readLinkiiCredentials();
  if (!username || !password) {
    throw new SupplierRequestError("Missing LINKII_USERNAME or LINKII_PASSWORD for Linkii authentication.", 401, undefined, undefined, "authentication");
  }

  let challengeRes: Response;
  try {
    challengeRes = await fetch(`${baseUrl}/web/auth/challenge`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Locale": LINKII_LOCALE,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SupplierRequestError("Linkii auth challenge timed out.", 408);
    }
    throw new SupplierRequestError("Linkii auth challenge transport error.", 502);
  }

  const challengeRaw = await challengeRes.text();
  let challengePayload: Record<string, unknown> | null = null;
  try {
    challengePayload = JSON.parse(challengeRaw) as Record<string, unknown>;
  } catch {
    throw new SupplierRequestError(`Linkii auth challenge returned invalid JSON (HTTP ${challengeRes.status}).`, 502, undefined, challengeRaw.slice(0, 500));
  }

  if (challengePayload?.code === "C1015" || challengeRes.status === 429) {
    c1015CooldownUntilMs = Date.now() + C1015_COOLDOWN_MS;
    throw new SupplierRequestError(
      extractMessage(challengePayload) || "Linkii login requests exceeded maximum limit (C1015).",
      429,
      "300",
      challengeRaw.slice(0, 500),
      "rate_limited",
    );
  }

  const challengeData = (challengePayload?.data ?? null) as Record<string, unknown> | null;
  const requestId = typeof challengeData?.requestId === "string" ? challengeData.requestId : "";
  const secretKey = typeof challengeData?.secretKey === "string" ? challengeData.secretKey : "";
  if (!challengeRes.ok || !requestId || !secretKey) {
    throw new SupplierRequestError(
      extractMessage(challengePayload) || `Linkii auth challenge failed (HTTP ${challengeRes.status}).`,
      challengeRes.status === 401 || challengeRes.status === 403 ? 401 : 502,
      undefined,
      challengeRaw.slice(0, 500),
      challengeRes.status === 401 || challengeRes.status === 403 ? "authentication" : undefined,
    );
  }

  const { encrypted, ivBase64 } = encryptLinkiiPassword(password, secretKey);

  let loginRes: Response;
  try {
    loginRes = await fetch(`${baseUrl}/web/auth/login`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Locale": LINKII_LOCALE,
      },
      body: JSON.stringify({
        username,
        password: encrypted,
        requestId,
        iv: ivBase64,
        clientId: LINKII_CLIENT_ID,
        grantType: "webPassword",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SupplierRequestError("Linkii login timed out.", 408);
    }
    throw new SupplierRequestError("Linkii login transport error.", 502);
  }

  const loginRaw = await loginRes.text();
  let loginPayload: Record<string, unknown> | null = null;
  try {
    loginPayload = JSON.parse(loginRaw) as Record<string, unknown>;
  } catch {
    throw new SupplierRequestError(`Linkii login returned invalid JSON (HTTP ${loginRes.status}).`, 502, undefined, loginRaw.slice(0, 500));
  }

  if (loginPayload?.code === "C1015" || loginRes.status === 429) {
    c1015CooldownUntilMs = Date.now() + C1015_COOLDOWN_MS;
    throw new SupplierRequestError(
      extractMessage(loginPayload) || "Linkii login rate limited (C1015).",
      429,
      "300",
      loginRaw.slice(0, 500),
      "rate_limited",
    );
  }

  const loginData = (loginPayload?.data ?? null) as Record<string, unknown> | null;
  const accessToken = String(loginData?.accessToken ?? loginData?.token ?? "").trim();
  if (!loginRes.ok || !isLinkiiSuccessCode(loginPayload?.code) || !accessToken) {
    throw new SupplierRequestError(
      extractMessage(loginPayload) || `Linkii login failed (HTTP ${loginRes.status}).`,
      401,
      undefined,
      loginRaw.slice(0, 500),
      "authentication",
    );
  }

  const accountHash = computeAccountHash(baseUrl, username);
  const expMs = parseJwtExpMs(accessToken) ?? Date.now() + 30 * 60_000;
  const entry: LinkiiTokenCacheEntry = { accountHash, accessToken, expMs };
  memoryTokenCache = entry;
  saveDiskTokenCache(entry);
  return accessToken;
}

async function singleFlightLogin(baseUrl: string): Promise<string> {
  if (!loginInFlight) {
    loginInFlight = performLogin(baseUrl).finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

async function getValidAccessToken(baseUrl: string): Promise<string> {
  const { username } = readLinkiiCredentials();
  const accountHash = computeAccountHash(baseUrl, username);

  if (
    memoryTokenCache &&
    memoryTokenCache.accountHash === accountHash &&
    isTokenFresh(memoryTokenCache.expMs)
  ) {
    return memoryTokenCache.accessToken;
  }

  const disk = loadDiskTokenCache(accountHash);
  if (disk) {
    memoryTokenCache = disk;
    return disk.accessToken;
  }

  const envAuthToken = (process.env.LINKII_AUTH_TOKEN ?? "").trim().replace(/^Bearer\s+/i, "");
  if (envAuthToken) {
    const envExpMs = parseJwtExpMs(envAuthToken);
    if (isTokenFresh(envExpMs)) {
      const entry: LinkiiTokenCacheEntry = { accountHash, accessToken: envAuthToken, expMs: envExpMs };
      memoryTokenCache = entry;
      return envAuthToken;
    }
  }

  return singleFlightLogin(baseUrl);
}

async function refreshAccessTokenAfterAuthFailure(baseUrl: string, failedToken: string): Promise<string> {
  const { username } = readLinkiiCredentials();
  const accountHash = computeAccountHash(baseUrl, username);
  if (
    memoryTokenCache &&
    memoryTokenCache.accountHash === accountHash &&
    memoryTokenCache.accessToken !== failedToken &&
    isTokenFresh(memoryTokenCache.expMs)
  ) {
    return memoryTokenCache.accessToken;
  }
  if (memoryTokenCache?.accessToken === failedToken) {
    clearTokenCache();
  }
  return singleFlightLogin(baseUrl);
}

async function linkiiAuthedRequest(
  baseUrl: string,
  path: string,
  makeInit: () => { method: "GET" | "POST"; headers?: Record<string, string>; body?: BodyInit; timeoutMs?: number },
  options: { signal?: AbortSignal; providerTaskId?: string } = {},
): Promise<Record<string, unknown>> {
  let token = await getValidAccessToken(baseUrl);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    options.signal?.throwIfAborted();
    const spec = makeInit();
    const timeoutMs = spec.timeoutMs ?? REQUEST_TIMEOUT_MS;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: spec.method,
        headers: {
          Accept: "application/json",
          "X-SXKJ-AIGC-Token": `Bearer ${token}`,
          "X-Locale": LINKII_LOCALE,
          ...spec.headers,
        },
        body: spec.body,
        signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new SupplierRequestError(`Linkii request timed out (${path}).`, 408, undefined, undefined, undefined, options.providerTaskId);
      }
      throw new SupplierRequestError(`Linkii request transport failed (${path}).`, 502, undefined, undefined, undefined, options.providerTaskId);
    }

    const rawText = await response.text();
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      if (response.status === 401) {
        if (attempt === 0) {
          token = await refreshAccessTokenAfterAuthFailure(baseUrl, token);
          continue;
        }
        throw new SupplierRequestError("Linkii authentication failed (HTTP 401).", 401, undefined, rawText.slice(0, 500), "authentication", options.providerTaskId, 401);
      }
      throw new SupplierRequestError(
        `Linkii returned invalid JSON (HTTP ${response.status}).`,
        response.status >= 400 && response.status <= 499 ? response.status : 502,
        undefined,
        rawText.slice(0, 500),
        undefined,
        options.providerTaskId,
        response.status,
      );
    }

    const code = payload?.code;
    if (response.status === 401 || code === "C105") {
      if (attempt === 0) {
        token = await refreshAccessTokenAfterAuthFailure(baseUrl, token);
        continue;
      }
      throw new SupplierRequestError(
        extractMessage(payload) || "Linkii authentication failed (C105/401).",
        401,
        undefined,
        rawText.slice(0, 500),
        "authentication",
        options.providerTaskId,
        response.status,
      );
    }

    if (!response.ok || !isLinkiiSuccessCode(code)) {
      throw classifyLinkiiBusinessFailure(
        extractMessage(payload),
        response.status,
        rawText.slice(0, 1000),
        options.providerTaskId,
        code,
      );
    }

    return payload;
  }

  throw new SupplierRequestError("Linkii authentication failed.", 401, undefined, undefined, "authentication", options.providerTaskId);
}

async function uploadReferenceImage(
  baseUrl: string,
  mediaBaseUrl: string,
  reference: { url: string; mimeType?: string; name?: string },
  signal?: AbortSignal,
): Promise<Record<string, unknown> | string> {
  let downloadRes: Response;
  try {
    downloadRes = await fetch(reference.url, {
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SupplierRequestError(`Failed to download reference image for Linkii upload: ${error instanceof Error ? error.message : String(error)}`, 502);
  }
  if (!downloadRes.ok) {
    throw new SupplierRequestError(`Failed to download reference image: HTTP ${downloadRes.status}.`, downloadRes.status);
  }
  const bytes = await downloadRes.arrayBuffer();
  const mimeType = reference.mimeType || downloadRes.headers.get("content-type") || "image/png";
  const filename = reference.name || "reference-image.png";

  const uploadPayload = await linkiiAuthedRequest(
    baseUrl,
    "/web/ai/drawing/upload-image",
    () => {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mimeType }), filename);
      return { method: "POST", body: form, timeoutMs: UPLOAD_TIMEOUT_MS };
    },
    { signal },
  );

  const data = uploadPayload.data;
  if (typeof data === "string") {
    return resolveMediaUrl(data, mediaBaseUrl);
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = { ...(data as Record<string, unknown>) };
    const rawUrl = typeof obj.url === "string" && obj.url.trim()
      ? obj.url.trim()
      : typeof obj.objectName === "string" && obj.objectName.trim()
        ? obj.objectName.trim()
        : "";
    if (rawUrl) {
      obj.url = resolveMediaUrl(rawUrl, mediaBaseUrl);
    }
    return obj;
  }
  throw new SupplierRequestError("Linkii upload-image returned unexpected payload.", 502, undefined, JSON.stringify(uploadPayload).slice(0, 500));
}

function uploadedRefToUrl(uploaded: Record<string, unknown> | string, mediaBaseUrl: string): string {
  if (typeof uploaded === "string") return resolveMediaUrl(uploaded, mediaBaseUrl);
  const raw = String(uploaded.url ?? uploaded.objectName ?? "").trim();
  return raw ? resolveMediaUrl(raw, mediaBaseUrl) : "";
}

function parseResultFiles(raw: unknown): Array<Record<string, unknown> | string> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown> | string>;
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown> | string>;
    } catch {
      return [];
    }
  }
  return [];
}

function fileItemUrl(item: Record<string, unknown> | string, mediaBaseUrl: string): string {
  if (typeof item === "string") return resolveMediaUrl(item, mediaBaseUrl);
  const raw = String(item.url ?? item.objectName ?? "").trim();
  return raw ? resolveMediaUrl(raw, mediaBaseUrl) : "";
}

function extractWorkMediaUrl(
  work: Record<string, unknown>,
  mediaKind: "image" | "video",
  mediaBaseUrl: string,
): string {
  const files = parseResultFiles(work.resultFiles);
  if (mediaKind === "video") {
    for (const item of files) {
      if (item && typeof item === "object") {
        const type = String(item.type ?? "").toLowerCase();
        if (type === "video" || type.startsWith("video/")) {
          const url = fileItemUrl(item, mediaBaseUrl);
          if (url) return url;
        }
      }
    }
  } else {
    for (const item of files) {
      const url = fileItemUrl(item, mediaBaseUrl);
      if (url) return url;
    }
  }

  const content = typeof work.resultContent === "string" ? work.resultContent.trim() : "";
  if (content) {
    return resolveMediaUrl(content, mediaBaseUrl);
  }

  for (const item of files) {
    const url = fileItemUrl(item, mediaBaseUrl);
    if (url) return url;
  }

  return "";
}

function resolveDeployment(
  supplier: SupplierRecord,
  modelId: string,
  kind: SupplierGenerationInput["kind"],
): LinkiiDeploymentSpec {
  const map = kind === "video_generate" ? LINKII_VIDEO_DEPLOYMENTS : LINKII_IMAGE_DEPLOYMENTS;
  if (map[modelId]) return map[modelId];
  const supplierKey = supplier.supplierModelId?.trim();
  if (supplierKey) {
    for (const spec of Object.values(map)) {
      if (String(spec.deploymentId) === supplierKey || spec.upstreamModel === supplierKey) {
        return spec;
      }
    }
  }
  throw new SupplierRequestError(`Linkii does not serve ${kind} model "${modelId}".`, 400);
}

function resolveVideoResolution(resolution: string | null | undefined): string {
  const lower = String(resolution ?? "").trim().toLowerCase();
  if (lower === "540p") return "540P";
  if (lower === "1080p") return "1080P";
  return "720P";
}

function resolveVideoDuration(durationSeconds: unknown): number {
  const rawDuration = Math.round(Number(durationSeconds ?? 5));
  return Math.min(16, Math.max(1, Number.isFinite(rawDuration) ? rawDuration : 5));
}

function parseAspectTarget(raw: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(raw);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w / h;
}

function resolveDrawingAspectRatio(ratio?: string | null, size?: string | null): string {
  const trimmedRatio = typeof ratio === "string" ? ratio.trim() : "";
  if (trimmedRatio) {
    if (DRAWING_ALLOWED_RATIOS.has(trimmedRatio)) return trimmedRatio;
    if (DRAWING_EXPLICIT_RATIO_MAP[trimmedRatio]) return DRAWING_EXPLICIT_RATIO_MAP[trimmedRatio];
    const target = parseAspectTarget(trimmedRatio);
    if (target !== null) return nearestAspectRatio(target, DRAWING_SUPPORTED_RATIOS);
    return "畫面比例不限";
  }

  const trimmedSize = typeof size === "string" ? size.trim() : "";
  if (trimmedSize) {
    const target = parseAspectTarget(trimmedSize);
    if (target !== null) return nearestAspectRatio(target, DRAWING_SUPPORTED_RATIOS);
  }

  return "畫面比例不限";
}

function extractWorkError(work: Record<string, unknown>, fallback: string): string {
  for (const key of ["errorMessage", "errorMsg", "failReason", "msg", "message"] as const) {
    const val = work[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return fallback;
}

async function submitDrawing(supplier: SupplierRecord, input: SupplierGenerationInput): Promise<SupplierGenerationOutput> {
  const baseUrl = readLinkiiBaseUrl(supplier);
  const mediaBaseUrl = readLinkiiMediaBaseUrl();
  const { deploymentId, upstreamModel } = resolveDeployment(supplier, input.modelId, input.kind);

  const references = input.workflow.references ?? [];
  const images: Array<Record<string, unknown> | string> = [];
  for (const reference of references) {
    images.push(await uploadReferenceImage(baseUrl, mediaBaseUrl, reference, input.signal));
  }

  const aspectRatio = resolveDrawingAspectRatio(input.ratio, input.size);

  const createPayload = await linkiiAuthedRequest(
    baseUrl,
    "/web/ai/drawing/create",
    () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deploymentId,
        prompt: input.prompt,
        styleCode: "",
        styleLabel: "風格不限",
        aspectRatio,
        images,
      }),
      timeoutMs: 240_000,
    }),
    { signal: input.signal },
  );

  const createData = (createPayload.data ?? null) as Record<string, unknown> | null;
  const rawWorkId = createData?.id ?? (typeof createPayload.data === "string" || typeof createPayload.data === "number" ? createPayload.data : null);
  const workId = rawWorkId !== null && rawWorkId !== undefined ? String(rawWorkId).trim() : "";
  if (!workId) {
    throw new SupplierRequestError("Linkii drawing/create response is missing data.id.", 502, undefined, JSON.stringify(createPayload).slice(0, 500));
  }

  const providerTaskId = `drawing:${workId}`;
  await input.onProviderTaskSubmitted?.(providerTaskId, "linkii");

  if (createData) {
    const createStatus = String(createData.status ?? "").trim().toLowerCase();
    if (createStatus === "failed" || createStatus === "abandoned") {
      const errorMessage = extractWorkError(createData, "Linkii drawing failed");
      throw classifyLinkiiBusinessFailure(errorMessage, 502, JSON.stringify(createData).slice(0, 500), providerTaskId);
    }

    const isPendingStatus =
      createStatus === "running" ||
      createStatus === "pending" ||
      createStatus === "processing" ||
      createStatus === "queued";
    const createUrl = isPendingStatus ? "" : extractWorkMediaUrl(createData, "image", mediaBaseUrl);

    if (createStatus === "completed" || createUrl) {
      if (!createUrl) {
        throw new SupplierRequestError(
          `Linkii drawing work ${workId} completed with empty result URL.`,
          502,
          undefined,
          JSON.stringify(createData).slice(0, 500),
          "empty_result",
          providerTaskId,
        );
      }
      return {
        base64: null,
        url: createUrl,
        providerTaskId,
        providerRequestId: workId,
        httpStatus: 200,
        endpointLabel: supplier.label,
        supplierModelId: upstreamModel,
        evidence: {
          adapter: "linkii",
          supplierId: supplier.id,
          failureDomain: supplier.failureDomain,
          deploymentId,
        },
      };
    }
  }

  const deadline = Date.now() + DRAWING_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    input.signal?.throwIfAborted();
    const workPayload = await linkiiAuthedRequest(
      baseUrl,
      `/web/works/${encodeURIComponent(workId)}`,
      () => ({ method: "GET" }),
      { signal: input.signal, providerTaskId },
    );
    const work = ((workPayload.data && typeof workPayload.data === "object" ? workPayload.data : workPayload) ?? {}) as Record<string, unknown>;
    const status = String(work.status ?? "").trim().toLowerCase();

    if (status === "completed") {
      const url = extractWorkMediaUrl(work, "image", mediaBaseUrl);
      if (!url) {
        throw new SupplierRequestError(
          `Linkii drawing work ${workId} completed with empty result URL.`,
          502,
          undefined,
          JSON.stringify(work).slice(0, 500),
          "empty_result",
          providerTaskId,
        );
      }
      return {
        base64: null,
        url,
        providerTaskId,
        providerRequestId: workId,
        httpStatus: 200,
        endpointLabel: supplier.label,
        supplierModelId: upstreamModel,
        evidence: {
          adapter: "linkii",
          supplierId: supplier.id,
          failureDomain: supplier.failureDomain,
          deploymentId,
        },
      };
    }

    if (status === "failed" || status === "abandoned") {
      const errorMessage = extractWorkError(work, "Linkii drawing failed");
      throw classifyLinkiiBusinessFailure(errorMessage, 502, JSON.stringify(work).slice(0, 500), providerTaskId);
    }

    await sleep(DRAWING_POLL_INTERVAL_MS, input.signal);
  }

  throw new SupplierRequestError(
    `Linkii drawing work ${workId} timed out after ${Math.round(DRAWING_MAX_WAIT_MS / 1000)}s.`,
    504,
    undefined,
    undefined,
    undefined,
    providerTaskId,
  );
}

async function submitVideo(supplier: SupplierRecord, input: SupplierGenerationInput): Promise<SupplierGenerationOutput> {
  const baseUrl = readLinkiiBaseUrl(supplier);
  const mediaBaseUrl = readLinkiiMediaBaseUrl();
  const { deploymentId, upstreamModel } = resolveDeployment(supplier, input.modelId, input.kind);

  const firstRef = input.workflow.references?.[0];
  let videoMode: "text" | "image" = "text";
  let imageUrls: string[] = [];
  if (firstRef) {
    const uploaded = await uploadReferenceImage(baseUrl, mediaBaseUrl, firstRef, input.signal);
    const uploadedUrl = uploadedRefToUrl(uploaded, mediaBaseUrl);
    if (!uploadedUrl) {
      throw new SupplierRequestError("Linkii upload-image returned no usable URL for video reference.", 502);
    }
    videoMode = "image";
    imageUrls = [uploadedUrl];
  }

  const resolution = resolveVideoResolution(input.resolution);
  const duration = resolveVideoDuration(input.workflow.durationSeconds);
  const rawRatio = input.ratio ?? "16:9";
  const aspectRatio = VIDEO_ALLOWED_RATIOS.has(rawRatio) ? rawRatio : "16:9";
  const generateAudio = Boolean(input.workflow.generateAudio);

  const createPayload = await linkiiAuthedRequest(
    baseUrl,
    "/web/ai/video/create",
    () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deploymentId,
        prompt: input.prompt,
        params: JSON.stringify({
          light: "光線不限",
          shot: "景別不限",
          style: "風格不限",
          videoMode,
          duration,
          resolution,
          aspectRatio,
          generateAudio,
          imageUrls,
          videoUrls: [],
        }),
      }),
    }),
    { signal: input.signal },
  );

  const createData = (createPayload.data ?? createPayload) as Record<string, unknown>;
  const taskId = String(createData?.id ?? createData?.taskId ?? "").trim();
  const creationId = String(createData?.creationId ?? "").trim();
  if (!taskId || !creationId) {
    throw new SupplierRequestError(
      "Linkii video/create response is missing id or creationId.",
      502,
      undefined,
      JSON.stringify(createPayload).slice(0, 500),
    );
  }

  const providerTaskId = `video:${taskId}:${creationId}`;
  await input.onProviderTaskSubmitted?.(providerTaskId, "linkii");

  const deadline = Date.now() + VIDEO_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    input.signal?.throwIfAborted();
    const taskPayload = await linkiiAuthedRequest(
      baseUrl,
      `/web/ai/task/${encodeURIComponent(taskId)}`,
      () => ({ method: "GET" }),
      { signal: input.signal, providerTaskId },
    );
    const task = ((taskPayload.data && typeof taskPayload.data === "object" ? taskPayload.data : taskPayload) ?? {}) as Record<string, unknown>;
    const status = String(task.status ?? "").trim().toLowerCase();

    if (status === "completed") {
      const targetCreationId = String(creationId || task.creationId || "").trim();
      const workPayload = await linkiiAuthedRequest(
        baseUrl,
        `/web/works/${encodeURIComponent(targetCreationId)}`,
        () => ({ method: "GET" }),
        { signal: input.signal, providerTaskId },
      );
      const work = ((workPayload.data && typeof workPayload.data === "object" ? workPayload.data : workPayload) ?? {}) as Record<string, unknown>;
      const url = extractWorkMediaUrl(work, "video", mediaBaseUrl);
      if (!url) {
        throw new SupplierRequestError(
          `Linkii video work ${targetCreationId} completed with empty result URL.`,
          502,
          undefined,
          JSON.stringify(work).slice(0, 500),
          "empty_result",
          providerTaskId,
        );
      }
      return {
        base64: null,
        url,
        providerTaskId,
        providerRequestId: taskId,
        httpStatus: 200,
        endpointLabel: supplier.label,
        supplierModelId: upstreamModel,
        evidence: {
          adapter: "linkii",
          supplierId: supplier.id,
          failureDomain: supplier.failureDomain,
          deploymentId,
          creationId: targetCreationId,
        },
      };
    }

    if (status === "failed" || status === "abandoned" || status === "cancelled") {
      const errorMessage = extractWorkError(task, "Linkii video generation failed");
      throw classifyLinkiiBusinessFailure(errorMessage, 502, JSON.stringify(task).slice(0, 500), providerTaskId);
    }

    await sleep(VIDEO_POLL_INTERVAL_MS, input.signal);
  }

  throw new SupplierRequestError(
    `Linkii video task ${taskId} timed out after ${Math.round(VIDEO_MAX_WAIT_MS / 1000)}s.`,
    504,
    undefined,
    undefined,
    undefined,
    providerTaskId,
  );
}

export async function generateWithLinkii(
  supplier: SupplierRecord,
  input: SupplierGenerationInput,
): Promise<SupplierGenerationOutput> {
  if (input.kind === "video_generate") {
    return submitVideo(supplier, input);
  }
  if (input.kind === "image_generate" || input.kind === "image_edit") {
    return submitDrawing(supplier, input);
  }
  throw new SupplierRequestError(`Linkii does not support generation kind "${input.kind}".`, 400);
}

export async function pollLinkiiTask(
  supplier: SupplierRecord,
  providerTaskId: string,
): Promise<ProviderTaskPollResult> {
  const baseUrl = readLinkiiBaseUrl(supplier);
  const mediaBaseUrl = readLinkiiMediaBaseUrl();

  if (providerTaskId.startsWith("drawing:")) {
    const workId = providerTaskId.slice("drawing:".length).trim();
    if (!workId) return { state: "failed", reason: `Invalid Linkii drawing task id: ${providerTaskId}` };

    const workPayload = await linkiiAuthedRequest(baseUrl, `/web/works/${encodeURIComponent(workId)}`, () => ({ method: "GET" }));
    const work = ((workPayload.data && typeof workPayload.data === "object" ? workPayload.data : workPayload) ?? {}) as Record<string, unknown>;
    const status = String(work.status ?? "").trim().toLowerCase();

    if (status === "completed") {
      const url = extractWorkMediaUrl(work, "image", mediaBaseUrl);
      if (!url) return { state: "failed", reason: `Linkii drawing ${workId} completed without result URL.` };
      return { state: "succeeded", url, base64: null };
    }
    if (status === "failed" || status === "abandoned") {
      return { state: "failed", reason: extractWorkError(work, "Linkii drawing failed") };
    }
    return { state: "running" };
  }

  if (providerTaskId.startsWith("video:")) {
    const rest = providerTaskId.slice("video:".length);
    const sep = rest.indexOf(":");
    if (sep <= 0) return { state: "failed", reason: `Invalid Linkii video task id: ${providerTaskId}` };
    const taskId = rest.slice(0, sep).trim();
    const creationId = rest.slice(sep + 1).trim();
    if (!taskId) return { state: "failed", reason: `Invalid Linkii video task id: ${providerTaskId}` };

    const taskPayload = await linkiiAuthedRequest(baseUrl, `/web/ai/task/${encodeURIComponent(taskId)}`, () => ({ method: "GET" }));
    const task = ((taskPayload.data && typeof taskPayload.data === "object" ? taskPayload.data : taskPayload) ?? {}) as Record<string, unknown>;
    const status = String(task.status ?? "").trim().toLowerCase();

    if (status === "completed") {
      const targetCreationId = String(creationId || task.creationId || "").trim();
      if (!targetCreationId) {
        return { state: "failed", reason: `Linkii video task ${taskId} completed without creationId.` };
      }
      const workPayload = await linkiiAuthedRequest(baseUrl, `/web/works/${encodeURIComponent(targetCreationId)}`, () => ({ method: "GET" }));
      const work = ((workPayload.data && typeof workPayload.data === "object" ? workPayload.data : workPayload) ?? {}) as Record<string, unknown>;
      const url = extractWorkMediaUrl(work, "video", mediaBaseUrl);
      if (!url) return { state: "failed", reason: `Linkii video ${targetCreationId} completed without result URL.` };
      return { state: "succeeded", url, base64: null };
    }
    if (status === "failed" || status === "abandoned" || status === "cancelled") {
      return { state: "failed", reason: extractWorkError(task, "Linkii video generation failed") };
    }
    return { state: "running" };
  }

  return { state: "failed", reason: `Unrecognized Linkii providerTaskId: ${providerTaskId}` };
}

export const linkiiAdapter: SupplyAdapter = {
  protocol: "linkii",
  submit: (supplier, input) => generateWithLinkii(supplier, input),
  poll: (supplier, providerTaskId) => pollLinkiiTask(supplier, providerTaskId),
  paidVideoFacts: (supplier, input) => ({
    supplierModelId: supplier.supplierModelId ?? "603",
    resolution: input.resolution ?? null,
    seconds: resolveVideoDuration(input.workflow.durationSeconds),
  }),
};
