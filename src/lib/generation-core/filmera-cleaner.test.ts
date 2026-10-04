import assert from "node:assert/strict";
import test from "node:test";

import { cleanFilmeraWatermark, isFilmeraMediaUrl, __internals } from "./filmera-cleaner.ts";

const { decodePng, encodePng, cleanPngBuffer } = __internals;

/** 构造一张带模拟水印的小 PNG：纯色背景 + 右下角半透明白色污染区。 */
function makeWatermarkedPng(width: number, height: number): Buffer {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  // 背景：中灰 (100, 100, 100)
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = 100;
    data[i * 3 + 1] = 100;
    data[i * 3 + 2] = 100;
  }
  // 水印区（按 cleaner 的 bbox 常量）：半透明白 alpha 0.55 叠加
  const alpha = 0.55;
  const x0 = width - __internals.WATERMARK_RIGHT_OFFSET_START;
  const x1 = width - __internals.WATERMARK_RIGHT_OFFSET_END;
  const y0 = height - __internals.WATERMARK_BOTTOM_OFFSET_START;
  const y1 = height - __internals.WATERMARK_BOTTOM_OFFSET_END;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const idx = (y * width + x) * channels;
      for (let ch = 0; ch < 3; ch++) {
        data[idx + ch] = Math.round(100 * (1 - alpha) + 255 * alpha);
      }
    }
  }
  return encodePng({ width, height, channels, data });
}

test("isFilmeraMediaUrl：正负例", () => {
  assert.ok(isFilmeraMediaUrl("https://media.filmera.ai/ref/abc.png"));
  assert.ok(!isFilmeraMediaUrl("https://www.filmera.ai/ref/abc.png"));
  assert.ok(!isFilmeraMediaUrl("https://cdn.example.com/x.png"));
  assert.ok(!isFilmeraMediaUrl("not a url"));
});

test("cleanPngBuffer：水印区像素被修复回接近背景色", () => {
  const width = 240;
  const height = 120;
  const marked = makeWatermarkedPng(width, height);
  const cleaned = cleanPngBuffer(marked);
  const img = decodePng(cleaned);

  // 水印中心点采样
  const cx = width - 105;
  const cy = height - 56;
  const idx = (cy * width + cx) * img.channels;
  const [r, g, b] = [img.data[idx], img.data[idx + 1], img.data[idx + 2]];
  assert.ok(
    Math.abs(r - 100) < 40 && Math.abs(g - 100) < 40 && Math.abs(b - 100) < 40,
    `水印区未修复：rgb=(${r},${g},${b})`,
  );
});

test("cleanFilmeraWatermark：mock fetch 成功路径返回清洗后 PNG", async () => {
  const marked = makeWatermarkedPng(240, 120);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => marked,
  })) as unknown as typeof fetch;
  try {
    const result = await cleanFilmeraWatermark("https://media.filmera.ai/ref/test.png");
    assert.equal(result.contentType, "image/png");
    assert.ok(result.buffer.length > 8);
    // 仍是合法 PNG
    assert.equal(result.buffer[0], 0x89);
    assert.equal(result.buffer[1], 0x50);
  } finally {
    globalThis.fetch = original;
  }
});

test("cleanFilmeraWatermark：非 PNG 内容 → 原样返回原 buffer", async () => {
  const jpegish = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => jpegish,
  })) as unknown as typeof fetch;
  try {
    const result = await cleanFilmeraWatermark("https://media.filmera.ai/ref/x.jpg");
    assert.ok(result.buffer.equals(jpegish));
  } finally {
    globalThis.fetch = original;
  }
});

test("cleanFilmeraWatermark：HTTP 失败 → 抛错（调用方回退原始 URL）", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 404,
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      cleanFilmeraWatermark("https://media.filmera.ai/ref/404.png"),
      /HTTP 404/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("cleanFilmeraWatermark：网络异常 → 抛错（调用方回退原始 URL）", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(
      cleanFilmeraWatermark("https://media.filmera.ai/ref/net.png"),
      /network down/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
