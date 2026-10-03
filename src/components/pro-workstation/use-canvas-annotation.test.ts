// use-canvas-annotation：canvas.toBlob 无错误通道 → 必须有 timeout 兜底，不留永久 pending。
// 形态对齐 src/lib/video-frames.ts 的 captureFrame（settled 标志 + 具名 reject）。
import test from "node:test";
import assert from "node:assert/strict";

import { ANNOTATION_EXPORT_TIMEOUT_MS, canvasToBlob } from "./use-canvas-annotation.ts";

/** promise 若在窗口内不 settle 就以「未 settle」失败（先红后绿用）。 */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, gate]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("canvasToBlob：toBlob 回调永不触发 → timeout 具名 reject（限时内 settle，不永久 pending）", async () => {
  const canvas = { toBlob() {} } as unknown as HTMLCanvasElement;
  const started = Date.now();
  await assert.rejects(
    settlesWithin(canvasToBlob(canvas, 40), 400),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error).message, "导出标注图超时，请重试。");
      return true;
    },
  );
  assert.ok(Date.now() - started < 400, "逾时必须限时生效");
});

test("canvasToBlob：正常回调 → resolve 该 blob（timeout 不误杀快路径）", async () => {
  const good = new Blob(["png"], { type: "image/png" });
  const canvas = {
    toBlob(cb: (blob: Blob | null) => void) {
      cb(good);
    },
  } as unknown as HTMLCanvasElement;
  const blob = await canvasToBlob(canvas, 5_000);
  assert.equal(blob, good);
});

test("ANNOTATION_EXPORT_TIMEOUT_MS 是秒级上限（不长到掩盖卡死，也不短到误杀）", () => {
  assert.ok(ANNOTATION_EXPORT_TIMEOUT_MS >= 5_000);
  assert.ok(ANNOTATION_EXPORT_TIMEOUT_MS <= 30_000);
});