import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { validateImageBuffer, validateAndDescribeBase64Image, validateOutputMediaBuffer } from "./artifact-service.ts";

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
