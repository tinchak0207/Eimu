// 一鍵超分到 4K（P1-4／對稱差 D10）行為斷言。
//
// 驗的是**真函式**不是源碼字串：檔位白名單（含 4K）、不支援時的具名拒絕（正反例）、
// 4K 的長邊保證由真實比例表推導（非手寫數字）、體積上限與既有上限同源、
// 以及「不得把 2K 當 4K 賣／不得把 "4k" 當 size 送上游（上游會靜默回 1k）」這兩條紅線。

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

/** env 開關是全域狀態：每個用到 4K 的斷言都自己設／自己清，不靠執行順序。 */
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

test("檔位白名單含 4K，且每個檔位的保底長邊真的達到自己的門檻（不是枚舉裡的字串）", () => {
  assert.deepEqual([...UPSCALE_TIERS], ["1k", "2k", "4k"]);
  assert.deepEqual(upscaleTierContractViolations(), []);

  // 4K＝3840 UHD 門檻；保底值由真實比例表（app.py:171-179 逐字轉錄）推導，
  // 這裡用同一張表獨立重算一次，證明不是拿被測模組的數字自己比自己。
  const contract = UPSCALE_TIER_CONTRACTS["4k"];
  assert.equal(contract.thresholdPx, 3840);
  const edges2k = Object.values(PIXAI_BRIDGE_UPSCALE_RATIO_SIZES).map((row) => Math.max(row["2k"][0], row["2k"][1]));
  assert.equal(contract.minOutputLongEdgePx, Math.min(...edges2k) * 4);
  assert.equal(contract.maxOutputLongEdgePx, Math.max(...edges2k) * 4);
  assert.ok(contract.minOutputLongEdgePx >= 3840, "4K 檔位在最壞比例下也必須 ≥3840px");

  // 1k／2k 的保底值同樣由表推導。
  assert.equal(UPSCALE_TIER_CONTRACTS["1k"].minOutputLongEdgePx, Math.min(...LONG_EDGES_1K) * 2);
  assert.equal(UPSCALE_TIER_CONTRACTS["2k"].minOutputLongEdgePx, Math.min(...edges2k) * 2);

  // 反例哨兵：2K 基底 ×2 在 1:1 下只有 2304px ⇒ 證明「2K 檔位的參數化」不足以當 4K 賣。
  const square = PIXAI_BRIDGE_UPSCALE_RATIO_SIZES["1:1"]["2k"];
  assert.equal(Math.max(square[0], square[1]), 1152);
  assert.ok(UPSCALE_TIER_CONTRACTS["2k"].minOutputLongEdgePx < 3840);
  assert.notEqual(
    `${UPSCALE_TIER_CONTRACTS["2k"].bridgeSize}x${UPSCALE_TIER_CONTRACTS["2k"].factor}`,
    `${UPSCALE_TIER_CONTRACTS["4k"].bridgeSize}x${UPSCALE_TIER_CONTRACTS["4k"].factor}`,
  );
});

test("橋白名單就是上游真實白名單：size=\"4k\" 具名拒收（上游對未知 size 靜默回 1k）", () => {
  assert.deepEqual([...UPSCALE_BRIDGE_SIZES], ["1k", "2k"]);
  assert.equal(assertUpscaleBridgeSizeSupported("1k"), "1k");
  assert.equal(assertUpscaleBridgeSizeSupported("2k"), "2k");
  for (const bad of ["4k", "4K", "2K", "8k", "1080p", ""]) {
    assert.throws(
      () => assertUpscaleBridgeSizeSupported(bad),
      (error: unknown) => error instanceof UpscaleTierError && error.code === "upscale_bridge_size_unsupported",
      `size "${bad}" 必須具名拒收`,
    );
  }
  // 每個檔位送出去的 size 都在白名單內——4K 送的是 2k，靠 factor=4 推上去。
  for (const tier of UPSCALE_TIERS) {
    assert.ok(UPSCALE_BRIDGE_SIZES.includes(UPSCALE_TIER_CONTRACTS[tier].bridgeSize));
  }
  assert.equal(UPSCALE_TIER_CONTRACTS["4k"].bridgeSize, "2k");
  assert.equal(UPSCALE_TIER_CONTRACTS["4k"].factor, 4);
});

test("4K 未校準時 fail-closed（具名碼），校準開關打開後回真契約（正反例）", () => {
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

test("可提交檔位＝宣告 ∩ 已校準；一鍵預設＝最高可提交檔位", () => {
  withFourKUpstream(undefined, () => {
    assert.deepEqual([...servableUpscaleTiers()], ["1k", "2k"]);
    assert.deepEqual([...servableUpscaleTiers(["2k"])], ["2k"]);
    assert.equal(isUpscaleTierServable("4k"), false);
    assert.equal(defaultUpscaleTier(), "2k");
  });
  withFourKUpstream("true", () => {
    assert.deepEqual([...servableUpscaleTiers()], ["1k", "2k", "4k"]);
    assert.equal(isUpscaleTierServable("4k"), true);
    assert.equal(defaultUpscaleTier(), "4k", "4K 校準開啟後，一鍵超分預設即 4K（免改碼）");
  });
});

test("檔位字串與像素尺寸兩種 size 語義分得開（不把 1024x1024 當檔位、不把 4k 當像素）", () => {
  assert.deepEqual(interpretUpscaleSize("2k"), { kind: "tier", tier: "2k", raw: "2k" });
  assert.deepEqual(interpretUpscaleSize("4K"), { kind: "tier", tier: "4k", raw: "4K" });
  assert.deepEqual(interpretUpscaleSize("1024x1024"), { kind: "pixels", width: 1024, height: 1024, raw: "1024x1024" });
  assert.deepEqual(interpretUpscaleSize("4096×2160"), { kind: "pixels", width: 4096, height: 2160, raw: "4096×2160" });
  assert.deepEqual(interpretUpscaleSize(""), { kind: "empty" });
  assert.deepEqual(interpretUpscaleSize(undefined), { kind: "empty" });
  assert.equal(interpretUpscaleSize("huge").kind, "unknown");
  assert.equal(interpretUpscaleSize("5k").kind, "unknown");
});

test("未知檔位具名拒收；像素尺寸走一鍵預設（C 端原圖尺寸只作計費提示）", () => {
  const unknown = resolveUpscaleTier("8k");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false ? unknown.code : null, "upscale_tier_unsupported");

  const pixels = resolveUpscaleTier("1024x1024");
  assert.equal(pixels.ok, true);
  assert.equal(pixels.ok === true ? pixels.tier : null, "2k");
  assert.equal(pixels.ok === true ? pixels.defaulted : null, true);
});

test("提交解析：一鍵（不帶檔位）＝最高可提交檔位；factor 由契約決定，越界 factor 具名拒", () => {
  const submission = resolveUpscaleSubmission({ declaredTiers: ["1k", "2k", "4k"], input: { image: "https://x/y.png" } });
  assert.equal(submission.tier, "2k");
  assert.equal(submission.bridgeSize, "2k");
  assert.equal(submission.factor, 2);
  assert.equal(submission.defaultedTier, true);

  const matching = resolveUpscaleSubmission({ declaredTiers: ["1k", "2k", "4k"], input: { image: "https://x/y.png", factor: 2 } });
  assert.equal(matching.factor, 2);
  assert.equal(matching.tier, "2k", "只給 factor=2 ⇒ 取最高 factor-2 檔位");

  // 未宣告的檔位不得提交（modelId 只在訊息裡出現）。
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

test("倍率→檔位是表驅動：factor 4 具名指向 4K 檔位（不是被拒成「越界倍率」）", () => {
  const catchCode = (input: unknown): { code: string | null; message: string } => {
    try {
      resolveUpscaleSubmission({ declaredTiers: ["1k", "2k", "4k"], input });
      return { code: null, message: "" };
    } catch (error) {
      return { code: error instanceof UpscaleTierError ? error.code : "unexpected", message: String((error as Error).message) };
    }
  };

  // factor=4 ⇒ 唯一 factor-4 檔位＝4k ⇒ 走 4K 檔位閘（未校準時具名拒，不是「倍率非法」）。
  const four = catchCode({ image: "https://x/y.png", factor: 4 });
  assert.equal(four.code, "upscale_4k_upstream_unverified");
  // 舊配對 (size="2k", factor=4) ＝上游 (bridgeSize 2k × 4) ＝就是 4K 檔位 ⇒ 同一條閘。
  const legacyPair = catchCode({ image: "https://x/y.png", size: "2k", factor: 4 });
  assert.equal(legacyPair.code, "upscale_4k_upstream_unverified");
  // 舊配對 (size="1k", factor=2) 仍是 1k 檔位（既有行為不變）。
  const legacy1k = resolveUpscaleSubmission({ declaredTiers: ["1k", "2k", "4k"], input: { image: "https://x/y.png", size: "1k", factor: 2 } });
  assert.equal(legacy1k.tier, "1k");
  // (size="1k", factor=4) 沒有任何檔位販售這個組合 ⇒ 具名拒（不靜默改成別的檔位）。
  assert.equal(catchCode({ image: "https://x/y.png", size: "1k", factor: 4 }).code, "upscale_factor_conflict");
  // factor 3／100 沒有檔位 ⇒ 具名拒（舊行為是原樣轉發上游）。
  assert.equal(catchCode({ image: "https://x/y.png", factor: 3 }).code, "upscale_factor_conflict");
  assert.equal(catchCode({ image: "https://x/y.png", factor: 100 }).code, "upscale_factor_conflict");
  // 顯式檔位與同時給的 factor 矛盾 ⇒ 具名拒（顯式檔位不被靜默改寫成 2k）。
  const contradictory = catchCode({ image: "https://x/y.png", tier: "4k", factor: 2 });
  assert.equal(contradictory.code, "upscale_factor_conflict");
  assert.match(contradictory.message, /4k/);
});

test("視頻超分在上游無通道 ⇒ 具名拒收（不假交付）；缺圖／音頻同理", () => {
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
  assert.equal(catchCode({ image: "https://x/y.png", mediaKind: "image" }), null, "圖像＋未指定檔位必須放行（一鍵）");
});

test("體積上限與既有上限同源；data URL 輸入超限具名拒（未知不回 0 冒充實測）", () => {
  // 輸出上限＝平台抓回上游結果的硬上限（artifact-service 的真源），禁靜默漂移。
  assert.equal(UPSCALE_OUTPUT_MAX_BYTES, ARTIFACT_MAX_DOWNLOAD_BYTES);
  assert.equal(UPSCALE_INPUT_MAX_BYTES, 25 * 1024 * 1024);

  // 4 bytes → "AAAAAA=="（base64 量測）：解出的位元組數必須等於真實解碼長度。
  assert.equal(measureUpscaleInputBytes("data:image/png;base64,AAAAAA=="), 4);
  assert.equal(measureUpscaleInputBytes("data:image/png;base64,AAAA"), 3);
  assert.equal(measureUpscaleInputBytes("https://x/y.png"), null, "http(s) 輸入由上游自取，回 null 不回 0");
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

test("4K 檔位走同一條成本路徑（generationCoins 吃得住 tier 值，且與 1k 同價＝現行一口價）", async () => {
  const { generationCoins } = await import("../generation-model-catalog.ts");
  const coins1k = generationCoins("pixai-upscale", { resolution: "1k" });
  const coins4k = generationCoins("pixai-upscale", { resolution: "4k" });
  assert.ok(coins1k > 0, "超分檔位必須有價（非零）");
  assert.equal(coins4k, coins1k, "現行一口價：4K 與 1K 同價（定價口徑未經授權不改，僅走同一條 cost gate）");
  assert.equal(coins4k, 0.001);
});