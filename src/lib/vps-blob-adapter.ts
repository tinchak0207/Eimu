/**
 * VPS-backed replacement for the @vercel/blob subset used by image-studio.
 *
 * When IMAGE_DATA_BASE_URL + IMAGE_DATA_API_KEY are set, all blob reads/writes
 * go to the VPS `image-data-api` service (postgres kv_store + static files)
 * instead of Vercel Blob. This removes the Hobby usage/suspension dependency.
 */

const BASE_URL = process.env.IMAGE_DATA_BASE_URL?.trim().replace(/\/+$/, "");
const API_KEY = process.env.IMAGE_DATA_API_KEY?.trim();

export function isVpsBlobBackend(): boolean {
  return Boolean(BASE_URL && API_KEY);
}

function authHeaders(): Record<string, string> {
  return { "x-image-data-key": API_KEY ?? "" };
}

function encodePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toPathname(urlOrPathname: string): string {
  const value = urlOrPathname.trim();
  if (BASE_URL && value.startsWith(`${BASE_URL}/files/`)) {
    return value.slice(`${BASE_URL}/files/`.length);
  }
  if (value.startsWith("https://") || value.startsWith("http://")) {
    const idx = value.indexOf("/files/");
    return idx >= 0 ? value.slice(idx + "/files/".length) : value.split("/").pop() ?? "";
  }
  return value.replace(/^\/+/, "");
}

function fileUrl(pathname: string): string {
  return `${BASE_URL}/files/${pathname}`;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  if (!BASE_URL || !API_KEY) throw new Error("IMAGE_DATA_BASE_URL / IMAGE_DATA_API_KEY are not configured.");
  const timeoutMs = 20_000;
  const timeoutSignal = typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  const signal = init.signal
    ? typeof AbortSignal.any === "function"
      ? AbortSignal.any([init.signal, ...(timeoutSignal ? [timeoutSignal] : [])])
      : init.signal
    : timeoutSignal;
  return fetch(`${BASE_URL}${path}`, { ...init, signal, headers: { ...authHeaders(), ...init.headers } });
}

export interface VpsBlobRef {
  url: string;
  pathname: string;
  size: number;
  uploadedAt: Date;
}

export async function list(options: {
  prefix?: string;
  cursor?: string;
  limit?: number;
  abortSignal?: AbortSignal;
} = {}): Promise<{ blobs: VpsBlobRef[]; cursor?: string; hasMore: boolean }> {
  const query = new URLSearchParams();
  if (options.prefix) query.set("prefix", options.prefix);
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.limit) query.set("limit", String(options.limit));
  const resp = await api(`/api/blob/list?${query.toString()}`, { signal: options.abortSignal });
  if (!resp.ok) throw new Error(`VPS blob list failed: HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    blobs: Array<{ url: string; pathname: string; size: number; uploadedAt: string }>;
    cursor?: string;
    hasMore: boolean;
  };
  return {
    blobs: data.blobs.map((blob) => ({
      url: blob.url,
      pathname: blob.pathname,
      size: blob.size,
      uploadedAt: new Date(blob.uploadedAt),
    })),
    cursor: data.cursor,
    hasMore: data.hasMore,
  };
}

export async function get(
  urlOrPathname: string,
  options: { access?: "public" | "private"; abortSignal?: AbortSignal } = {},
): Promise<{
  url: string;
  pathname: string;
  size: number;
  uploadedAt: Date;
  statusCode: number;
  stream: ReadableStream<Uint8Array> | null;
}> {
  const pathname = toPathname(urlOrPathname);
  const resp = await api(`/api/blob/get?path=${encodeURIComponent(pathname)}`, {
    signal: options.abortSignal,
  });
  return {
    url: fileUrl(pathname),
    pathname,
    size: Number(resp.headers.get("x-blob-size") || 0),
    uploadedAt: new Date(resp.headers.get("x-blob-uploaded-at") || Date.now()),
    statusCode: resp.status,
    stream: resp.body,
  };
}

export async function put(
  pathname: string,
  body: string | ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array> | { pipe: unknown },
  options: {
    access?: "public" | "private";
    contentType?: string;
    cacheControlMaxAge?: number;
    addRandomSuffix?: boolean;
    allowOverwrite?: boolean;
    abortSignal?: AbortSignal;
  } = {},
): Promise<{ url: string; pathname: string; size: number; uploadedAt: Date }> {
  const buffer = await toBodyBuffer(body);
  const contentType = options.contentType ?? "application/octet-stream";
  const resp = await api(`/api/blob/${encodePath(pathname.replace(/^\/+/, ""))}`, {
    method: "PUT",
    body: buffer as unknown as BodyInit,
    signal: options.abortSignal,
    headers: {
      "Content-Type": "application/octet-stream",
      "x-content-type": contentType,
    },
  });
  if (!resp.ok) throw new Error(`VPS blob put failed: HTTP ${resp.status}`);
  const data = (await resp.json()) as { url: string; pathname: string; size: number; uploadedAt: string };
  return { url: data.url, pathname: data.pathname, size: data.size, uploadedAt: new Date(data.uploadedAt) };
}

async function toBodyBuffer(
  body: string | ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array> | { pipe: unknown },
): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof (body as { pipe?: unknown }).pipe === "function") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
    }
    return new Uint8Array(Buffer.concat(chunks as Uint8Array[]));
  }
  return new Uint8Array(await (body as Blob).arrayBuffer());
}

export async function del(
  urls: string[],
  options: { abortSignal?: AbortSignal } = {},
): Promise<{ deleted: number }> {
  for (const url of urls) {
    const pathname = toPathname(url);
    const resp = await api(`/api/blob/${encodePath(pathname)}`, {
      method: "DELETE",
      signal: options.abortSignal,
    });
    if (!resp.ok) throw new Error(`VPS blob del failed: HTTP ${resp.status}`);
  }
  return { deleted: urls.length };
}
