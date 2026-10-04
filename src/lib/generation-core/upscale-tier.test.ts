// 一键超分到 4K（P1-4／对称差 D10）行为断言。
//
// 验的是**真函式**不是源码字串：档位白名单（含 4K）、不支援时的具名拒绝（正反例）、
// 4K 的长边保证由真实比例表推导（非手写数字）、体积上限与既有上限同源、
// 以及「不得把 2K 当 4K 卖／不得把 "4k" 当 size 送上游（上游会静默回 1k）」这两条红线。

import test from "node:test";
import assert from "node:assert/strict";

import {
  UPSCALE_TIERS,
  UPSCALE_BRIDGE_SIZES,
  UPSCALE_TIER_CONTRACTS,
  UPSCALE_TIER_THRESHOLDS_PX,
  UPSCALE_INPUT_MAX_BYTES,
  UPSCALE_OUTPUT_MAX_BYTES,
  PIXAI_BRIDGE_UPSCALE_RATIO_SIZES,
  UpscaleTierError,
  assertUpscaleBridgeSizeSupported,
  assertUpscaleInputWithinLimits,
  assertUpscaleOutputWithinLimits,
  defaultUpscaleTier,
  interpretUpscaleSize,
  isUpscaleTierServable,
  measureUpscaleInputBytes,
  resolveUpscaleSubmission,
  resolveUpscaleTier,
  servableUpscaleTiers,
  upscaleTierContractViolations,
} from "./upscale-tier.ts";
import { ARTIFACT_MAX_DOWNLOAD_BYTES } from "./artifact-service.ts";

/** env 开关是全域状态：每个用到 4K 的断言都自己设／自己清，不靠执行顺序。 */
function withFourKUpstream<T>(value: string | undefined, run: () => T): T {
  const before = process.env.UPSCALE_4K_UPSTREAM;
  if (value === undefined) delete process.env.UPSCALE_4K_UPSTREAM;
  else process.env.UPSCALE_4K_UPSTREAM = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.UPSCALE_4K_UPSTREAM;
    else process.env.UPSCALE_4K_UPSTREAM = before;
  }
}

const LONG_EDGES_1K = Object.values(PIXAI_BRIDGE_UPSCALE_RATIO_SIZES).map((row) => Math.max(row["1k"][0], row["1k"][1]));

test("档位白名单含 4K，且每个档位的保底长边真的达到自己的门槛（不是枚举里的字串）", () => {
  assert.deepEqual([...UPSCALE_TIERS], ["1k", "2k", "4k"]);
  assert.deepEqual(upscaleTierContractViolations(), []);

  // 4K＝3840 UHD 门槛；保底值由真实比例表（app.py:171-179 逐字转录）推导，
  // 这里用同一张表独立重算一次，证明不是拿被测模组的数字自己比自己。
  const contract = UPSCALE_TIER_CONTRACTS["4k"];
  assert.equal(contract.thresholdPx, 3840);
  const edges2k = Object.values(PIXAI_BRIDGE_UPSCALE_RATIO_SIZES).map((row) => Math.max(row["2k"][0], row["2k"][1]));
  assert.equal(contract.minOutputLongEdgePx, Math.min(...edges2k) * 4);
  assert.equal(contract.maxOutputLongEdgePx, Math.max(...edges2k) * 4);
  assert.ok(contract.minOutputLongEdgePx >= 3840, "4K 档位在最坏比例下也必须 ≥3840px");

  // 1k／2k 的保底值同样由表推导。
  assert.equal(UPSCALE_TIER_CONTRACTS["1k"].minOutputLongEdgePx, Math.min(...LONG_EDGES_1K) * 2);
  assert.equal(UPSCALE_TIER_CONTRACTS["2k"].minOutputLongEdgePx, Math.min(...edges2k) * 2);

  // 反例哨兵：2K 基底 ×2 在 1:1 下只有 2304px ⇒ 证明「2K 档位的参数化」不足以当 4K 卖。
  const square = PIXAI_BRIDGE_UPSCALE_RATIO_SIZES["1:1"]["2k"];
  assert.equal(Math.max(square[0], square[1]), 1152);
  assert.ok(UPSCALE_TIER_CONTRACTS["2k"].minOutputLongEdgePx < 3840);
  assert.notEqual(
    `${UPSCALE_TIER_CONTRACTS["2k"].bridgeSize}x${UPSCALE_TIER_CONTRACTS["2k"].factor}`,
    `${UPSCALE_TIER_CONTRACTS["4k"].bridgeSize}x${UPSCALE_TIER_CONTRACTS["4k"].factor}`,
  );
});

test("桥白名单就是上游真实白名单：size=\"4k\" 具名拒收（上游对未知 size 静默回 1k）", () => {
  assert.deepEqual([...UPSCALE_BRIDGE_SIZES], ["1k", "2k"]);
  assert.equal(assertUpscaleBridgeSizeSupported("1k"), "1k");
  assert.equal(assertUpscaleBridgeSizeSupported("2k"), "2k");
  for (const bad of ["4k", "4K", "2K", "8k", "1080p", ""]) {
    assert.throws(
      () => assertUpscaleBridgeSizeSupported(bad),
      (error: unknown) => error instanceof UpscaleTierError && error.code === "upscale_bridge_size_unsupported",
      `size "${bad}" 必须具名拒收`,
    );
  }
  // 每个档位送出去的 size 都在白名单内——4K 送的是 2k，靠 factor=4 推上去。
  for (const tier of UPSCALE_TIERS) {
    assert.ok(UPSCALE_BRIDGE_SIZES.includes(UPSCALE_TIER_CONTRACTS[tier].bridgeSize));
  }
  assert.equal(UPSCALE_TIER_CONTRACTS["4k"].bridgeSize, "2k");
  assert.equal(UPSCALE_TIER_CONTRACTS["4k"].factor, 4);
});

test("4K 未校准时 fail-closed（具名码），校准开关打开后回真契约（正反例）", () => {
  const closed = withFourKUpstream(undefined, () => resolveUpscaleTier("4k"));
  assert.equal(closed.ok, false);
  assert.equal(closed.ok === false ? closed.code : null, "upscale_4k_upstream_unverified");
  assert.equal(closed.ok === false ? closed.status : null, 400);

  const opened = withFourKUpstream("1", () => resolveUpscaleTier("4k"));
  assert.equal(opened.ok, true);
  assert.equal(opened.ok === true ? opened.bridgeSize : null, "2k");
  assert.equal(opened.ok === true ? opened.factor : null, 4);
  assert.equal(opened.ok === true ? opened.minOutputLongEdgePx : null, UPSCALE_TIER_CONTRACTS["4k"].minOutputLongEdgePx);
  assert.equal(opened.ok === true ? opened.semantics : null, "upstream-factor-unverified");
  assert.ok(opened.ok === true && opened.minOutputLongEdgePx >= UPSCALE_TIER_THRESHOLDS_PX["4k"]);
});

test("可提交档位＝宣告 ∩ 已校准；一键预设＝最高可提交档位", () => {
  withFourKUpstream(undefined, () => {
    assert.deepEqual([...servableUpscaleTiers()], ["1k", "2k"]);
    assert.deepEqual([...servableUpscaleTiers(["2k"])], ["2k"]);
    assert.equal(isUpscaleTierServable("4k"), false);
    assert.equal(defaultUpscaleTier(), "2k");
  });
  withFourKUpstream("true", () => {
    assert.deepEqual([...servableUpscaleTiers()], ["1k", "2k", "4k"]);
    assert.equal(isUpscaleTierServable("4k"), true);
    assert.equal(defaultUpscaleTier(), "4k", "4K 校准开启后，一键超分预设即 4K（免改码）");
  });
});

test("档位字串与像素尺寸两种 size 语义分得开（不把 1024x1024 当档位、不把 4k 当像素）", () => {
  assert.deepEqual(interpretUpscaleSize("2k"), { kind: "tier", tier: "2k", raw: "2k" });
  assert.deepEqual(interpretUpscaleSize("4K"), { kind: "tier", tier: "4k", raw: "4K" });
  assert.deepEqual(interpretUpscaleSize("1024x1024"), { kind: "pixels", width: 1024, height: 1024, raw: "1024x1024" });
  assert.deepEqual(interpretUpscaleSize("4096×2160"), { kind: "pixels", width: 4096, height: 2160, raw: "4096×2160" });
  assert.deepEqual(interpretUpscaleSize(""), { kind: "empty" });
  assert.deepEqual(interpretUpscaleSize(undefined), { kind: "empty" });
  assert.equal(interpretUpscaleSize("huge").kind, "unknown");
  assert.equal(interpretUpscaleSize("5k").kind, "unknown");
});

test("未知档位具名拒收；像素尺寸走一键预设（C 端原图尺寸只作计费提示）", () => {
  const unknown = resolveUpscaleTier("8k");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false ? unknown.code : null, "upscale_tier_unsupported");

  const pixels = resolveUpscaleTier("1024x1024");
  assert.equal(pixels.ok, true);
  assert.equal(pixels.ok === true ? pixels.tier : null, "2k");
  assert.equal(pixels.ok === true ? pixels.defaulted : null, true);
});

test("提交解析：一键（不带档位）＝最高可提交档位；factor 由契约决定，越界 factor 具名拒", () => {
  const submission = resolveUpscaleSubmission({ declaredTiers: ["1k", "2k", "4k"], input: { image: "https://x/y.png" } });
  assert.equal(submission.tier, "2k");
  assert.equal(submission.bridgeSize, "2k");
  assert.equal(submission.factor, 2);
  assert.equal(submission.defaultedTier, true);

  const matching = resolveUpscaleSubmission({ declaredTiers: ["1k", "2k", "4k"], input: { image: "https://x/y.png", factor: 2 } });
  assert.equal(matching.factor, 2);
  assert.equal(matching.tier, "2k", "只给 factor=2 ⇒ 取最高 factor-2 档位");

  // 未宣告的档位不得提交（modelId 只在讯息里出现）。
  const undeclared = (() => {
    try {
      resolveUpscaleSubmission({ declaredTiers: ["1k"], modelId: "pixai-upscale", input: { image: "https://x/y.png", tier: "2k" } });
      return null;
    } catch (error) {
      return error as UpscaleTierError;
    }
  })();
  assert.equal(undeclared?.code, "upscale_tier_not_declared_by_model");
});

test("倍率→档位是表驱动：factor 4 具名指向 4K 档位（不是被拒成「越界倍率」）", () => {
  const catchCode = (input: unknown): { code: string | null; message: string } => {
    try {
      resolveUpscaleSubmission({ declaredTiers: ["1k", "2k", "4k"], input });
      return { code: null, message: "" };
    } catch (error) {
      return { code: error instanceof UpscaleTierError ? error.code : "unexpected", message: String((error as Error).message) };
    }
  };

  // factor=4 ⇒ 唯一 factor-4 档位＝4k ⇒ 走 4K 档位闸（未校准时具名拒，不是「倍率非法」）。
  const four = catchCode({ image: "https://x/y.png", factor: 4 });
  assert.equal(four.code, "upscale_4k_upstream_unverified");
  // 旧配对 (size="2k", factor=4) ＝上游 (bridgeSize 2k × 4) ＝就是 4K 档位 ⇒ 同一条闸。
  const legacyPair = catchCode({ image: "https://x/y.png", size: "2k", factor: 4 });
  assert.equal(legacyPair.code, "upscale_4k_upstream_unverified");
  // 旧配对 (size="1k", factor=2) 仍是 1k 档位（既有行为不变）。
  const legacy1k = resolveUpscaleSubmission({ declaredTiers: ["1k", "2k", "4k"], input: { image: "https://x/y.png", size: "1k", factor: 2 } });
  assert.equal(legacy1k.tier, "1k");
  // (size="1k", factor=4) 没有任何档位贩售这个组合 ⇒ 具名拒（不静默改成别的档位）。
  assert.equal(catchCode({ image: "https://x/y.png", size: "1k", factor: 4 }).code, "upscale_factor_conflict");
  // factor 3／100 没有档位 ⇒ 具名拒（旧行为是原样转发上游）。
  assert.equal(catchCode({ image: "https://x/y.png", factor: 3 }).code, "upscale_factor_conflict");
  assert.equal(catchCode({ image: "https://x/y.png", factor: 100 }).code, "upscale_factor_conflict");
  // 显式档位与同时给的 factor 矛盾 ⇒ 具名拒（显式档位不被静默改写成 2k）。
  const contradictory = catchCode({ image: "https://x/y.png", tier: "4k", factor: 2 });
  assert.equal(contradictory.code, "upscale_factor_conflict");
  assert.match(contradictory.message, /4k/);
});

test("视频超分在上游无通道 ⇒ 具名拒收（不假交付）；缺图／音频同理", () => {
  const catchCode = (input: unknown): string | null => {
    try {
      resolveUpscaleSubmission({ declaredTiers: ["1k", "2k", "4k"], input });
      return null;
    } catch (error) {
      return error instanceof UpscaleTierError ? error.code : `unexpected:${String(error)}`;
    }
  };
  assert.equal(catchCode({ image: "https://x/y.mp4", mediaKind: "video" }), "upscale_video_upstream_unsupported");
  assert.equal(catchCode({ image: "https://x/y.png", media_type: "audio" }), "upscale_media_kind_unsupported");
  assert.equal(catchCode({}), "upscale_image_missing");
  assert.equal(catchCode({ image: "https://x/y.png", mediaKind: "image" }), null, "图像＋未指定档位必须放行（一键）");
});

test("体积上限与既有上限同源；data URL 输入超限具名拒（未知不回 0 冒充实测）", () => {
  // 输出上限＝平台抓回上游结果的硬上限（artifact-service 的真源），禁静默漂移。
  assert.equal(UPSCALE_OUTPUT_MAX_BYTES, ARTIFACT_MAX_DOWNLOAD_BYTES);
  assert.equal(UPSCALE_INPUT_MAX_BYTES, 25 * 1024 * 1024);

  // 4 bytes → "AAAAAA=="（base64 量测）：解出的位元组数必须等于真实解码长度。
  assert.equal(measureUpscaleInputBytes("data:image/png;base64,AAAAAA=="), 4);
  assert.equal(measureUpscaleInputBytes("data:image/png;base64,AAAA"), 3);
  assert.equal(measureUpscaleInputBytes("https://x/y.png"), null, "http(s) 输入由上游自取，回 null 不回 0");
  assert.equal(measureUpscaleInputBytes(42), null);

  const big = Buffer.alloc(UPSCALE_INPUT_MAX_BYTES + 1, 1).toString("base64");
  const tooLarge = (() => {
    try {
      assertUpscaleInputWithinLimits({ image: `data:image/png;base64,${big}` });
      return null;
    } catch (error) {
      return error as UpscaleTierError;
    }
  })();
  assert.equal(tooLarge?.code, "upscale_input_too_large");
  assert.equal(tooLarge?.status, 413);

  const okBytes = assertUpscaleInputWithinLimits({ image: "https://x/y.png" });
  assert.equal(okBytes, null);

  assert.throws(
    () => assertUpscaleOutputWithinLimits(UPSCALE_OUTPUT_MAX_BYTES + 1),
    (error: unknown) => error instanceof UpscaleTierError && error.code === "upscale_output_too_large" && error.status === 413,
  );
  assert.doesNotThrow(() => assertUpscaleOutputWithinLimits(UPSCALE_OUTPUT_MAX_BYTES));
});

test("4K 档位走同一条成本路径（generationCoins 吃得住 tier 值，且与 1k 同价＝现行一口价）", async () => {
  const { generationCoins } = await import("../generation-model-catalog.ts");
  const coins1k = generationCoins("pixai-upscale", { resolution: "1k" });
  const coins4k = generationCoins("pixai-upscale", { resolution: "4k" });
  assert.ok(coins1k > 0, "超分档位必须有价（非零）");
  assert.equal(coins4k, coins1k, "现行一口价：4K 与 1K 同价（定价口径未经授权不改，仅走同一条 cost gate）");
  assert.equal(coins4k, 0.001);
});