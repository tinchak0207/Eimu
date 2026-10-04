import assert from "node:assert/strict";
import test from "node:test";
import { classifyPricingStage } from "./device-tier.ts";

const strong = { renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Laptop GPU Direct3D11 vs_5_0 ps_5_0)", cores: 16, memoryGb: 8 };

test("强 GPU 跑 3D；WebGL 不可用退回封面卡", () => {
  assert.equal(classifyPricingStage(strong), "3d");
  assert.equal(classifyPricingStage({ ...strong, renderer: "Apple M3 Pro" }), "3d");
  assert.equal(classifyPricingStage({ ...strong, renderer: null }), "off");
});

test("Intel 核显／软体渲染／旧手机 GPU → 静态图（Intel Arc 独显不算）", () => {
  for (const renderer of [
    "Mesa Intel(R) Graphics (RPL-S)",
    "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "Intel Iris Plus Graphics",
    "Google SwiftShader",
    "llvmpipe (LLVM 17.0.6, 256 bits)",
    "Mali-G52",
    "Adreno (TM) 506",
    "PowerVR Rogue GE8320",
  ]) {
    assert.equal(classifyPricingStage({ ...strong, renderer }), "lite", renderer);
  }
  assert.equal(classifyPricingStage({ ...strong, renderer: "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11)" }), "3d");
  assert.equal(classifyPricingStage({ ...strong, renderer: "Adreno (TM) 740" }), "3d");
  assert.equal(classifyPricingStage({ ...strong, renderer: "Mali-G715" }), "3d");
});

test("少核／小记忆体／省流量 → 静态图", () => {
  assert.equal(classifyPricingStage({ ...strong, cores: 4 }), "lite");
  assert.equal(classifyPricingStage({ ...strong, memoryGb: 4 }), "lite");
  assert.equal(classifyPricingStage({ ...strong, saveData: true }), "lite");
  assert.equal(classifyPricingStage({ ...strong, cores: 0 }), "3d");
});

test("URL 覆写优先", () => {
  assert.equal(classifyPricingStage({ ...strong, override: "lite" }), "lite");
  assert.equal(classifyPricingStage({ ...strong, renderer: "Mesa Intel(R) Graphics", override: "full" }), "3d");
});
