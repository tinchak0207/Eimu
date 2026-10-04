import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  validateImageBuffer,
  validateAndDescribeBase64Image,
  validateOutputMediaBuffer,
  outputBuffer,
  artifactBodyTimeoutMs,
  ARTIFACT_MAX_DOWNLOAD_BYTES,
  ARTIFACT_DOWNLOAD_MAX_TIMEOUT_MS,
  type ArtifactDownloadTimeouts,
} from "./artifact-service.ts";

/** 起一个真实 HTTP server（127.0.0.1 随机埠）供 outputBuffer 的真行为断言使用。 */
function startArtifactServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/artifact.png`,
        close: () =>
          new Promise<void>((done) => {
            // keep-alive 连线会让 close() 久等；先切断既有连线再关。
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// 1x1 透明 PNG（真实字节，67 字节）。
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// 手工构造的最小合法 JPEG：SOI + SOF0(1x1, 单分量) + EOI。
const JPEG_1X1_BYTES = Buffer.from([
  0xff, 0xd8, // SOI
  0xff, 0xc0, // SOF0
  0x00, 0x0b, // Lf = 11
  0x08, // precision
  0x00, 0x01, // height = 1
  0x00, 0x01, // width = 1
  0x01, // Nf = 1
  0x01, 0x11, 0x00, // component
  0xff, 0xd9, // EOI
]);

// 手工构造的最小合法 WEBP：RIFF + WEBP + VP8X(canvas 1x1)。
const WEBP_1X1_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x16, 0x00, 0x00, 0x00, // file size (无关字段，不校验)
  0x57, 0x45, 0x42, 0x50, // "WEBP"
  0x56, 0x50, 0x38, 0x58, // "VP8X"
  0x0a, 0x00, 0x00, 0x00, // chunk size = 10
  0x00, // flags
  0x00, 0x00, 0x00, // reserved
  0x00, 0x00, 0x00, // canvas width - 1 = 0 -> width = 1
  0x00, 0x00, 0x00, // canvas height - 1 = 0 -> height = 1
]);

test("validateImageBuffer 正确识别 PNG 并读出尺寸", () => {
  const buffer = Buffer.from(PNG_1X1_BASE64, "base64");
  const result = validateImageBuffer(buffer);
  assert.equal("error" in result, false);
  if ("error" in result) return;
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.sha256, createHash("sha256").update(buffer).digest("hex"));
});

test("validateImageBuffer 正确识别 JPEG 并读出尺寸", () => {
  const result = validateImageBuffer(JPEG_1X1_BYTES);
  assert.equal("error" in result, false);
  if ("error" in result) return;
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
});

test("validateImageBuffer 正确识别 WEBP 并读出尺寸", () => {
  const result = validateImageBuffer(WEBP_1X1_BYTES);
  assert.equal("error" in result, false);
  if ("error" in result) return;
  assert.equal(result.mimeType, "image/webp");
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
});

test("validateImageBuffer 拒绝非图片字节，且不抛出", () => {
  const buffer = Buffer.from("this is definitely not an image, just plain text padding data", "utf8");
  const result = validateImageBuffer(buffer);
  assert.equal("error" in result, true);
});

test("validateImageBuffer 拒绝截断/损坏的头部，且不抛出", () => {
  const truncatedPng = Buffer.from(PNG_1X1_BASE64, "base64").subarray(0, 10);
  const result = validateImageBuffer(truncatedPng);
  assert.equal("error" in result, true);

  const truncatedJpeg = JPEG_1X1_BYTES.subarray(0, 5);
  const jpegResult = validateImageBuffer(truncatedJpeg);
  assert.equal("error" in jpegResult, true);

  const truncatedWebp = WEBP_1X1_BYTES.subarray(0, 16);
  const webpResult = validateImageBuffer(truncatedWebp);
  assert.equal("error" in webpResult, true);
});

test("validateImageBuffer 对同样的输入产生确定性的 sha256", () => {
  const buffer = Buffer.from(PNG_1X1_BASE64, "base64");
  const first = validateImageBuffer(buffer);
  const second = validateImageBuffer(Buffer.from(buffer));
  assert.equal("error" in first, false);
  assert.equal("error" in second, false);
  if ("error" in first || "error" in second) return;
  assert.equal(first.sha256, second.sha256);
});

test("validateImageBuffer 传入 null/undefined 时抛出（编程错误）", () => {
  assert.throws(() => validateImageBuffer(null as unknown as Buffer));
});

test("validateAndDescribeBase64Image 解码、校验体积上限并复用 validateImageBuffer", () => {
  const withPrefix = `data:image/png;base64,${PNG_1X1_BASE64}`;
  const result = validateAndDescribeBase64Image(withPrefix, 1024);
  assert.equal("error" in result, false);
  if ("error" in result) return;
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.byteSize, result.buffer.length);
});

test("durable output validation accepts signed MP4 and WebM video artifacts", () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(12)]);
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
  const mp4Result = validateOutputMediaBuffer(mp4, "video");
  const webmResult = validateOutputMediaBuffer(webm, "video");
  assert.ok(!("error" in mp4Result));
  assert.ok(!("error" in webmResult));
  assert.equal(mp4Result.mimeType, "video/mp4");
  assert.equal(webmResult.mimeType, "video/webm");
});

test("validateAndDescribeBase64Image 超过体积上限时返回 error", () => {
  const result = validateAndDescribeBase64Image(PNG_1X1_BASE64, 1);
  assert.equal("error" in result, true);
});

test("validateAndDescribeBase64Image 空字符串返回 error", () => {
  const result = validateAndDescribeBase64Image("", 1024);
  assert.equal("error" in result, true);
});

// ── outputBuffer 下载时限：真行为断言（真实 HTTP server、真位元组，非源码字串比对）──

const MIB = 1024 * 1024;

test("预设时限对 18MB 4K 产物放大到 >30s，未知大小仍有硬上界（非无限等待）", () => {
  const eighteenMb = 18 * MIB;
  const scaled = artifactBodyTimeoutMs(eighteenMb);
  assert.ok(scaled > 30_000, `18MB 产物需 >30s（实测 ${scaled}ms）`);
  assert.ok(scaled <= ARTIFACT_DOWNLOAD_MAX_TIMEOUT_MS, `不得超过硬上界（实测 ${scaled}ms）`);
  // chunked（无 Content-Length）→ 用硬上界，但仍具上界。
  assert.equal(artifactBodyTimeoutMs(0), ARTIFACT_DOWNLOAD_MAX_TIMEOUT_MS);
  // 上限封顶：25MiB 级亦不得超过硬上界。
  assert.ok(artifactBodyTimeoutMs(ARTIFACT_MAX_DOWNLOAD_BYTES) <= ARTIFACT_DOWNLOAD_MAX_TIMEOUT_MS);
});

test("outputBuffer：≥10MB 慢速串流在依 Content-Length 放大的时限内完成", async () => {
  const total = 10 * MIB;
  const chunk = Buffer.alloc(64 * 1024, 7);
  const server = await startArtifactServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png", "content-length": String(total) });
    res.flushHeaders(); // 标头立即送出，隔离出「主体读取」阶段
    let sent = 0;
    const push = () => {
      if (sent >= total) {
        res.end();
        return;
      }
      const slice = chunk.subarray(0, Math.min(chunk.length, total - sent));
      sent += slice.length;
      res.write(slice);
      setTimeout(push, 4);
    };
    setTimeout(push, 300); // 模拟 TTFB：总时长超过标头上限
  });
  try {
    const timeouts: ArtifactDownloadTimeouts = { headerTimeoutMs: 250, minBytesPerSecond: 2 * MIB, maxTimeoutMs: 20_000 };
    // 10MB / 2MBps = 5000ms 为放大后的主体上限。
    const started = Date.now();
    const bytes = await outputBuffer({ base64: null, url: server.url }, timeouts);
    const elapsed = Date.now() - started;
    assert.equal(bytes.length, total);
    assert.ok(elapsed > timeouts.headerTimeoutMs, `应超过标头上限（实测 ${elapsed}ms）`);
    assert.ok(elapsed < 20_000, `应在放大后的上限内完成（实测 ${elapsed}ms）`);
  } finally {
    await server.close();
  }
});

test("outputBuffer：小档不受放大影响，保底为标头上限且真位元组等价", async () => {
  const body = Buffer.from(PNG_1X1_BASE64, "base64");
  const server = await startArtifactServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
    res.end(body);
  });
  try {
    const timeouts: ArtifactDownloadTimeouts = { headerTimeoutMs: 500, minBytesPerSecond: 1 * MIB, maxTimeoutMs: 10_000 };
    assert.equal(artifactBodyTimeoutMs(body.length, timeouts), timeouts.headerTimeoutMs);
    const started = Date.now();
    const bytes = await outputBuffer({ base64: null, url: server.url }, timeouts);
    assert.deepEqual(bytes, body);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await server.close();
  }
});

test("outputBuffer：超过硬上界仍具名逾时失败（不无限等待）", async () => {
  const server = await startArtifactServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png", "content-length": String(10 * MIB) });
    res.flushHeaders();
    res.write(Buffer.alloc(64 * 1024)); // 先吐一点，之后停住 → 主体读取逾时
  });
  try {
    const timeouts: ArtifactDownloadTimeouts = { headerTimeoutMs: 500, minBytesPerSecond: 1 * MIB, maxTimeoutMs: 800 };
    // 10MB / 1MBps = 10000ms → 被硬上界 800ms 封顶。
    const started = Date.now();
    await assert.rejects(
      () => outputBuffer({ base64: null, url: server.url }, timeouts),
      /Artifact download failed: body read timed out after 800ms/,
    );
    assert.ok(Date.now() - started < 4_000, "应在硬上界附近失败，而非无限等待");
  } finally {
    await server.close();
  }
});

test("outputBuffer：Content-Length 超过 25MiB 的产物具名拒绝", async () => {
  const server = await startArtifactServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png", "content-length": String(ARTIFACT_MAX_DOWNLOAD_BYTES + 1) });
    res.flushHeaders();
  });
  try {
    await assert.rejects(
      () => outputBuffer({ base64: null, url: server.url }),
      /Artifact download failed: file exceeds 25 MiB/,
    );
  } finally {
    await server.close();
  }
});
