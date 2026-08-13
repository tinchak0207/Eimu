import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_NET_PREPROCESSORS,
  MAX_CONTROL_NETS,
  normalizeControlNetSpec,
  normalizeControlNets,
  toPixaiControlNet,
  toPixaiControlNets,
  type ControlNetSpec,
} from "./pixai-controlnets";

test("canny spec maps to pixai controlNets entry with canonical preprocessor", () => {
  const normalized = normalizeControlNetSpec({ image: "https://cdn.example.com/canny.png", type: "canny" });
  assert.ok(normalized);
  const entry = toPixaiControlNet(normalized);
  assert.deepEqual(entry, {
    imageUrl: "https://cdn.example.com/canny.png",
    preprocessor: "Canny",
    controlMode: 1,
    pixelPerfect: true,
    startStep: 0,
    endStep: 1,
    weight: 1,
  });
});

test("uppercase type and custom knobs survive mapping with clamping", () => {
  const spec = normalizeControlNetSpec({
    image: "https://cdn.example.com/depth.png",
    type: "Depth",
    weight: 3,
    controlMode: 5,
    pixelPerfect: false,
    startStep: -1,
    endStep: 0.55,
  });
  assert.ok(spec);
  const entry = toPixaiControlNet(spec);
  assert.equal(entry.preprocessor, "Depth");
  assert.equal(entry.weight, 2); // clamped to [0,2]
  assert.equal(entry.controlMode, 3); // clamped to 0..3
  assert.equal(entry.pixelPerfect, false);
  assert.equal(entry.startStep, 0); // clamped
  assert.equal(entry.endStep, 0.55);
});

test("unknown-but-clean type passes through verbatim for future preprocessors", () => {
  const spec = normalizeControlNetSpec({ image: "https://x.example/a.png", type: "IpAdapterPlus" });
  assert.ok(spec);
  assert.equal(toPixaiControlNet(spec).preprocessor, "IpAdapterPlus");
});

test("dirty inputs are rejected", () => {
  assert.equal(normalizeControlNetSpec(null), null);
  assert.equal(normalizeControlNetSpec({}), null);
  assert.equal(normalizeControlNetSpec({ image: "", type: "canny" }), null);
  assert.equal(normalizeControlNetSpec({ image: "https://x.example/a.png", type: "" }), null);
  assert.equal(normalizeControlNetSpec({ image: "javascript:alert(1)", type: "canny" }), null);
  assert.equal(normalizeControlNetSpec({ image: "https://x.example/a.png", type: "bad type!\\n" }), null);
});

test("mediaId-style image reference is accepted (upload flow)", () => {
  const spec = normalizeControlNetSpec({ image: "m_8Fk2ZqPwQ3R7xL1", type: "openpose" });
  assert.ok(spec);
  assert.equal(toPixaiControlNet(spec).imageUrl, "m_8Fk2ZqPwQ3R7xL1");
  assert.equal(toPixaiControlNet(spec).preprocessor, "OpenPose");
});

test("normalizeControlNets keeps order and reports rejected indices", () => {
  const result = normalizeControlNets([
    { image: "https://a.example/1.png", type: "canny" },
    { image: "", type: "depth" },
    { image: "https://a.example/3.png", type: "lineart", weight: 0.8 },
  ]);
  assert.equal(result.valid.length, 2);
  assert.deepEqual(result.rejected, [1]);
  assert.equal(result.valid[0].type, "Canny");
  assert.equal(result.valid[1].weight, 0.8);
});

test("non-array and oversized controlNets are fully rejected", () => {
  assert.deepEqual(normalizeControlNets(undefined), { valid: [], rejected: [] });
  assert.deepEqual(normalizeControlNets("nope"), { valid: [], rejected: [] });
  const tooMany = Array.from({ length: MAX_CONTROL_NETS + 1 }, () => ({
    image: "https://a.example/x.png",
    type: "canny",
  }));
  const oversized = normalizeControlNets(tooMany);
  assert.equal(oversized.valid.length, 0);
  assert.equal(oversized.rejected.length, MAX_CONTROL_NETS + 1);
});

test("toPixaiControlNets emits a pixai-shaped array that is never a placeholder empty list", () => {
  // 路由的標準順序是 normalize → toPixai：toPixai 吃的是已歸一成 canonical 名、
  // 已 clamp 過、而且 image 已通過白名單的 specs。呼叫方不該把 raw input 直接
  // 塞給 toPixai（那會把 alias 原樣當 preprocessor 餵出去）。
  const specs: ControlNetSpec[] = [
    normalizeControlNetSpec({ image: "https://a.example/1.png", type: "softedge" })!,
    normalizeControlNetSpec({ image: "https://a.example/2.png", type: "depth", weight: 0.5 })!,
  ];
  const pixai = toPixaiControlNets(specs);
  assert.equal(pixai.length, 2);
  assert.deepEqual(
    pixai.map((entry) => entry.preprocessor),
    ["SoftEdge", "Depth"],
  );
  assert.ok(pixai.every((entry) => typeof entry.imageUrl === "string" && entry.imageUrl.length > 0));
  // 空 specs 產出空陣列 = 舊行為（無控制網），而不是塞一個假 entry。
  assert.deepEqual(toPixaiControlNets([]), []);
});

test("preprocessor alias table covers the headline control types", () => {
  for (const type of ["canny", "depth", "openpose", "softedge", "lineart", "scribble", "mlsd", "normal", "segmentation", "tile", "recolor", "inpaint"]) {
    assert.ok(CONTROL_NET_PREPROCESSORS[type], `missing alias for ${type}`);
  }
});
