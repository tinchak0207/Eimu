import { get, put } from "@/lib/blob-backend";

/** 兼容两条 blob 后端读文本：Vercel 返回 { blob }，VPS 返回 { stream }。 */
async function readBlobText(
  result: Awaited<ReturnType<typeof get>> | null,
): Promise<string | null> {
  if (!result) return null;
  const anyResult = result as unknown as { blob?: Blob; stream?: ReadableStream<Uint8Array> | null };
  if (anyResult.blob) return await anyResult.blob.text();
  if (anyResult.stream) {
    const reader = anyResult.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return new TextDecoder().decode(new Uint8Array(Buffer.concat(chunks as Buffer[])));
  }
  return null;
}

/** 读 blob 文本；任何失败回 null（由调用方回退 Map）。 */
async function readBlobTextAt(key: string): Promise<string | null> {
  try {
    const result = await get(key, { access: "private" }).catch(() => null);
    if (!result) return null;
    // VPS adapter 的 get() 在 404 时仍回非空结果（statusCode=404，stream 是错误响应体）。
    // 非 2xx 一律视为不存在，绝不把错误 JSON 当正文解析。Vercel 结果无此栏 → 照旧。
    const statusCode = (result as unknown as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300)) {
      return null;
    }
    return await readBlobText(result);
  } catch {
    return null;
  }
}

async function readBlobJson<T>(key: string): Promise<T | null> {
  const text = await readBlobTextAt(key);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 写文本到 blob；失败静默（调用方另有 Map 兜底）。 */
async function writeBlobText(key: string, text: string): Promise<boolean> {
  try {
    await put(key, text, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return true;
  } catch {
    return false;
  }
}

export { readBlobTextAt, readBlobJson, writeBlobText };
