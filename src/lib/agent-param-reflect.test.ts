import test from "node:test";
import assert from "node:assert/strict";
import { hasReflectedParams, reflectParams } from "./agent-param-reflect";

// 目录实测值（2026-08-09）：
//   gpt-image        比例 1:1 / 3:2 / 2:3，解析度只有 1k
//   gpt-image-2      比例含 4:3 / 16:9 等 8 项，解析度 1k / 2k / 4k
const BASE = "gpt-image-2";

test("没有参数就什么都不回填", () => {
  assert.deepEqual(reflectParams(undefined, BASE), {});
  assert.deepEqual(reflectParams("", BASE), {});
  assert.deepEqual(reflectParams("正在为你挑选模型", BASE), {});
});

test("目录里存在的模型才回填", () => {
  assert.equal(reflectParams(JSON.stringify({ model: "gpt-image-2" }), BASE).modelId, "gpt-image-2");
  // 目录里没有的 id 一律丢弃：写进 state 会让控件显示一个点了报错的选项
  assert.equal(reflectParams(JSON.stringify({ model: "sdxl-turbo-not-ours" }), BASE).modelId, undefined);
});

test("aspect_ratio 必须是该模型支持的值", () => {
  assert.equal(reflectParams(JSON.stringify({ aspect_ratio: "4:3" }), BASE).aspectRatio, "4:3");
  // gpt-image 只支持 1:1 / 3:2 / 2:3
  assert.equal(reflectParams(JSON.stringify({ aspect_ratio: "4:3" }), "gpt-image").aspectRatio, undefined);
});

test("没有 aspect_ratio 时从 size 反推比例", () => {
  assert.equal(reflectParams(JSON.stringify({ size: "1024x768" }), BASE).aspectRatio, "4:3");
});

test("算得出但目录里没有的比例要丢掉", () => {
  // 1000x999 会算出 "1000:999"，任何模型都不支持
  assert.equal(reflectParams(JSON.stringify({ size: "1000x999" }), BASE).aspectRatio, undefined);
});

test("比例合法性跟着回填后的模型走，不是跟着当前模型", () => {
  // 当前是 gpt-image（不支持 4:3），但助理换到了 gpt-image-2（支持）
  const r = reflectParams(JSON.stringify({ model: "gpt-image-2", aspect_ratio: "4:3" }), "gpt-image");
  assert.equal(r.modelId, "gpt-image-2");
  assert.equal(r.aspectRatio, "4:3", "应以助理选的模型为准判定比例合法性");
});

test("解析度从尺寸推档位，且必须被模型支持", () => {
  assert.equal(reflectParams(JSON.stringify({ size: "2048x2048" }), BASE).resolution, "2k");
  assert.equal(reflectParams(JSON.stringify({ size: "4096x4096" }), BASE).resolution, "4k");
  // gpt-image 只有 1k，2k 不能回填
  assert.equal(reflectParams(JSON.stringify({ size: "2048x2048" }), "gpt-image").resolution, undefined);
});

test("1k/2k/4k 字面量直接认", () => {
  assert.equal(reflectParams(JSON.stringify({ quality: "2k" }), BASE).resolution, "2k");
});

test("被截断的 args 也能回填捞得到的部分", () => {
  const r = reflectParams('{"model":"gpt-image-2","aspect_ratio":"16:9","prompt":"一只帅气的猫', BASE);
  assert.equal(r.modelId, "gpt-image-2");
  assert.equal(r.aspectRatio, "16:9");
});

test("LoRA / seed / sampler 不回填（普通模式没有对应控件）", () => {
  const r = reflectParams(JSON.stringify({ lora: "anime-v3", seed: 42, sampler: "euler_a" }), BASE);
  assert.deepEqual(r, {});
  assert.equal(hasReflectedParams(r), false);
});

test("hasReflectedParams 只在真有东西时为真", () => {
  assert.equal(hasReflectedParams({}), false);
  assert.equal(hasReflectedParams({ aspectRatio: "1:1" }), true);
});

test("坏输入不抛异常", () => {
  for (const bad of ["{{{{", '{"model":', "null", "[1,2]"]) {
    assert.doesNotThrow(() => reflectParams(bad, BASE));
  }
});
