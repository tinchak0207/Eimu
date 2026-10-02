import test from "node:test";
import assert from "node:assert/strict";

import { mediaExtensionFromUrl, downloadExtension } from "./image-helpers.ts";

test("mediaExtensionFromUrl 认出常见媒体副档名", () => {
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.mp3"), "mp3");
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.m4a"), "m4a");
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.mp4"), "mp4");
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.webp"), "webp");
});

test("mediaExtensionFromUrl 带 query 或 hash 也认，大小写归一", () => {
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.mp3?download=1&token=xyz"), "mp3");
  assert.equal(mediaExtensionFromUrl("https://blob.example/a.M4A#t=3"), "m4a");
});

test("mediaExtensionFromUrl 非媒体/无副档名返回 null，downloadExtension 回落 png", () => {
  assert.equal(mediaExtensionFromUrl("https://blob.example/download"), null);
  assert.equal(mediaExtensionFromUrl("https://blob.example/archive.zip"), null);
  assert.equal(mediaExtensionFromUrl("data:image/png;base64,AAAA"), null);
  assert.equal(downloadExtension("https://blob.example/download"), "png");
  assert.equal(downloadExtension("data:image/png;base64,AAAA"), "png");
});
