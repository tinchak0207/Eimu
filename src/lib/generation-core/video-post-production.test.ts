/**
 * P1-3 生成式后期（续片 `extend_video`／局部改片 `edit_video`）行为测试。
 *
 * 为什么必须有这份：本能力压在**付费上游 fetch 之前的 fail-closed 闸门**上
 * （实作档头与 openai-video-upstream.ts:194-196 明写「映射未校准＝具名拒收，零上游成本」）。
 * 这一格出错就是花钱，所以判准全部走**真函式 + 本地替身（stub fetch／stub resolver）**，
 * 零付费上游请求：测试中所有 fetch 都由测试自己接管的 globalThis.fetch 回应，
 * 没有任何真实网路出口。
 *
 * 真单未验：本档不提交任何上游请求；`VIDEO_POST_PRODUCTION_UPSTREAM` 的正式开通
 * 与真单校准待项目负责人逐次报备。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { generationCapabilities, generationModel } from "../generation-model-catalog";
import type { VideoGenerationType } from "../generation-model-catalog";
import {
  VIDEO_POST_PRODUCTION_MODES,
  VIDEO_POST_PRODUCTION_UPSTREAM_FIELD,
  VIDEO_POST_PRODUCTION_UPSTREAM_SEMANTICS,
  VIDEO_GENERATION_TYPES,
  VideoPostProductionError,
  applyVideoPostProductionToUpstreamBody,
  assertVideoGenerationTypeSupported,
  assertVideoPostProductionUpstreamReady,
  effectiveVideoPrompt,
  parseVideoPostProduction,
  readNormalizedVideoPostProduction,
  resolveSourceVideo,
  supportsVideoGenerationType,
  videoGenerationTypesFor,
  videoPostProductionGeneratedSeconds,
  videoPostProductionUpstreamEnabled,
  type SourceVideoUrlResolver,
  type VideoPostProductionMode,
} from "./video-post-production.ts";
import { generateWithOpenaiVideo, openaiVideoSubmissionFacts } from "./openai-video-upstream.ts";
import { evaluatePaidVideoSubmission } from "./paid-video-cost-gate.ts";
import { SupplierRequestError } from "./failure-classifier.ts";
import type { GenerationWorkflow, SupplierGenerationInput, SupplierRecord } from "./types.ts";

// ── 现场真值（来自 generation-model-catalog 的实资料，不是测试自造）──────────
const SUPPORTING_MODEL = "seedance-2.5-480p";   // catalog.ts:626-645 宣告三型别
const SUPPORTING_MODEL_720P = "seedance-2.5-720p"; // catalog.ts:646-664
const UNSUPPORTING_MODEL = "seedance-2.0";      // catalog.ts:609-625 无 videoGenerationTypes
const UNSUPPORTING_30S_MODEL = "seedance-2.5-30s"; // catalog.ts:667-683 无 videoGenerationTypes
const UNKNOWN_MODEL = "not-a-real-model";

const SOURCE_URL = "https://cdn.example.com/source/clip.mp4";

const resolverOk: SourceVideoUrlResolver = (objectKey) => `https://files.example.com/files/${objectKey}`;
const resolverNull: SourceVideoUrlResolver = () => null;

function resolverExpectingOnly(objectKey: string): SourceVideoUrlResolver {
  return (key) => (key === objectKey ? `https://files.example.com/files/${key}` : null);
}

function catchVideoPostProductionError(run: () => unknown): VideoPostProductionError {
  try {
    run();
  } catch (error) {
    assert.ok(
      error instanceof VideoPostProductionError,
      `预期 VideoPostProductionError，实得 ${error instanceof Error ? error.name : typeof error}：${String(error)}`,
    );
    return error;
  }
  assert.fail("预期抛出 VideoPostProductionError，但没有抛错（＝静默接受了非法输入）");
}

// ── 1. 型别契约 ────────────────────────────────────────────────────────────

test("型别契约：VIDEO_POST_PRODUCTION_MODES 逐字为 extend_video／edit_video", () => {
  assert.deepEqual([...VIDEO_POST_PRODUCTION_MODES], ["extend_video", "edit_video"]);
});

test("型别契约：VIDEO_GENERATION_TYPES 含 generate ＋ 两个后期型别，且仅此三者", () => {
  assert.deepEqual([...VIDEO_GENERATION_TYPES], ["generate", "extend_video", "edit_video"]);
  assert.ok(VIDEO_GENERATION_TYPES.includes("generate"));
  assert.ok(VIDEO_GENERATION_TYPES.includes("extend_video"));
  assert.ok(VIDEO_GENERATION_TYPES.includes("edit_video"));
  // 后期型别集合必须是 VIDEO_GENERATION_TYPES 去掉 generate 的子集（两表不得漂移）。
  assert.deepEqual(
    VIDEO_GENERATION_TYPES.filter((value) => value !== "generate"),
    [...VIDEO_POST_PRODUCTION_MODES],
  );
});

test("型别契约（编译期）：VideoPostProductionMode 不接受 generate／未知字串", () => {
  // @ts-expect-error "generate" 不是生成式后期型别（普通生成走 mode 缺省路径）
  const notAMode: VideoPostProductionMode = "generate";
  // @ts-expect-error 未知名称不是后期型别
  const alsoNot: VideoPostProductionMode = "upscale_video";
  assert.equal(typeof notAMode, "string");
  assert.equal(typeof alsoNot, "string");
  // VideoGenerationType 收三种（编译期断言，值域与真相对齐）
  const all: readonly VideoGenerationType[] = ["generate", "extend_video", "edit_video"];
  assert.equal(all.length, 3);
});

test("型别契约（执行期）：非后期型别值一律具名拒收，不静默降级成普通 generate", () => {
  for (const mode of ["generate", "upscale_video", "extend", "", "EXTEND_VIDEO", 1, null]) {
    const error = catchVideoPostProductionError(() => parseVideoPostProduction(
      { mode, source: { url: SOURCE_URL }, continueSeconds: 10 },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    ));
    assert.equal(error.code, "video_post_production_invalid_request", `mode=${String(mode)}`);
    assert.equal(error.status, 400);
  }
  // mode 缺席也拒（不是「当普通生成」）
  const missing = catchVideoPostProductionError(() => parseVideoPostProduction(
    { source: { url: SOURCE_URL }, continueSeconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(missing.code, "video_post_production_invalid_request");
});

test("型别契约：input 不是物件（null／阵列／字串）＝本次提交非生成式后期，回 null 走普通生成", () => {
  for (const input of [null, undefined, [], "extend_video", 42]) {
    assert.equal(
      parseVideoPostProduction(input, { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull }),
      null,
      `input=${JSON.stringify(input)}`,
    );
  }
});

// ── 2. 能力闸门（最重要）──────────────────────────────────────────────────

test("能力闸门：catalog 真资料——只有 Seedance-2.5 族宣告 extend_video／edit_video", () => {
  // 正例：两个 2.5 档位都支援（真资料，不是测试自造）
  for (const modelId of [SUPPORTING_MODEL, SUPPORTING_MODEL_720P]) {
    assert.deepEqual(
      [...videoGenerationTypesFor(modelId)],
      ["generate", "extend_video", "edit_video"],
      modelId,
    );
    assert.equal(supportsVideoGenerationType(modelId, "extend_video"), true, modelId);
    assert.equal(supportsVideoGenerationType(modelId, "edit_video"), true, modelId);
    assert.ok(supportsVideoGenerationType(modelId, "generate"), modelId);
  }
  // 反例：2.0 系与 drama 30s 档位都没宣告 ⇒ 不推导不升格
  for (const modelId of [UNSUPPORTING_MODEL, UNSUPPORTING_30S_MODEL]) {
    assert.deepEqual([...videoGenerationTypesFor(modelId)], ["generate"], modelId);
    assert.equal(supportsVideoGenerationType(modelId, "extend_video"), false, modelId);
    assert.equal(supportsVideoGenerationType(modelId, "edit_video"), false, modelId);
    assert.equal(generationModel(modelId)?.videoGenerationTypes, undefined, modelId);
  }
  // 未知模型 ⇒ 只支援普通生成（能力宣告缺一即不许提交）
  assert.deepEqual([...videoGenerationTypesFor(UNKNOWN_MODEL)], ["generate"]);
  assert.equal(supportsVideoGenerationType(UNKNOWN_MODEL, "edit_video"), false);
  // capability 投射／catalog 真源一致
  assert.deepEqual(
    [...(generationCapabilities(SUPPORTING_MODEL)?.videoGenerationTypes ?? [])],
    [...videoGenerationTypesFor(SUPPORTING_MODEL)],
  );
  assert.deepEqual(
    [...(generationCapabilities(UNSUPPORTING_MODEL)?.videoGenerationTypes ?? [])],
    ["generate"],
  );
});

test("能力闸门：assertVideoGenerationTypeSupported 正例放行、反例具名 400", () => {
  assert.doesNotThrow(() => assertVideoGenerationTypeSupported(SUPPORTING_MODEL, "extend_video"));
  assert.doesNotThrow(() => assertVideoGenerationTypeSupported(SUPPORTING_MODEL, "edit_video"));
  for (const modelId of [UNSUPPORTING_MODEL, UNSUPPORTING_30S_MODEL, UNKNOWN_MODEL]) {
    for (const mode of ["extend_video", "edit_video"] as const) {
      const error = catchVideoPostProductionError(() => assertVideoGenerationTypeSupported(modelId, mode));
      assert.equal(error.code, "video_generation_type_unsupported", `${modelId}/${mode}`);
      assert.equal(error.status, 400);
      // 讯息必须指路（可用型别＋目前仅 Seedance-2.5 族），不得默不作声
      assert.match(error.message, /不支援生成型别/);
      assert.match(error.message, /Seedance-2\.5/);
    }
  }
});

test("能力闸门：不支援的模型 parse 时拒绝，且不支援的参数不必细看（能力错先于参数错）", () => {
  // 故意同时带坏参数：错误码必须仍是不支援（能力闸先做），不是参数错。
  const error = catchVideoPostProductionError(() => parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: -99 },
    { modelId: UNSUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(error.code, "video_generation_type_unsupported");
});

test("能力闸门：支援的模型 parse 正例回正规化物件（不是回 null，也不是降级）", () => {
  const parsed = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(parsed);
  assert.equal(parsed.mode, "extend_video");
});

// ── 3. 参数契约 ────────────────────────────────────────────────────────────

test("参数契约 extend：续长缺失／0／负数／小数／超上限各自具名拒收", () => {
  const cases: Array<[unknown, string]> = [
    [undefined, "video_extend_seconds_invalid"],  // 必填
    [null, "video_extend_seconds_invalid"],
    ["", "video_extend_seconds_invalid"],
    [0, "video_extend_seconds_invalid"],          // 边界 0
    [-1, "video_extend_seconds_invalid"],         // 负数
    [10.5, "video_extend_seconds_invalid"],       // 小数
    [31, "video_extend_seconds_invalid"],         // > PAID_VIDEO_MAX_SECONDS(30)
    [1000, "video_extend_seconds_invalid"],
    [NaN, "video_extend_seconds_invalid"],
  ];
  for (const [continueSeconds, code] of cases) {
    const error = catchVideoPostProductionError(() => parseVideoPostProduction(
      { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    ));
    assert.equal(error.code, code, `continueSeconds=${String(continueSeconds)}`);
    assert.equal(error.status, 400);
  }
});

test("参数契约 extend：续长在 1–30 但不在 catalog 档位 ⇒ 具名未核价拒收（成本闸前先拒）", () => {
  // seedance-2.5-480p 的 durations 是 10..30；9 合法但未登录。
  const error = catchVideoPostProductionError(() => parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 9 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(error.code, "video_post_production_seconds_not_priced");
  assert.match(error.message, /未登录|档位/);
  // 边界正例：10（下界）与 30（上界）都放行
  for (const seconds of [10, 30]) {
    const parsed = parseVideoPostProduction(
      { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: seconds },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    );
    assert.equal(parsed?.mode === "extend_video" ? parsed.continueSeconds : null, seconds);
  }
  // 720p 档位上限 29：30 未登录 ⇒ 拒
  const over = catchVideoPostProductionError(() => parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 30 },
    { modelId: SUPPORTING_MODEL_720P, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(over.code, "video_post_production_seconds_not_priced");
});

test("参数契约 extend：续接点负数／非整数／越过来源片长各自具名拒收；缺省＝null", () => {
  for (const continueFromSeconds of [-1, 1.5, -0.5]) {
    const error = catchVideoPostProductionError(() => parseVideoPostProduction(
      { mode: "extend_video", source: { url: SOURCE_URL, durationSeconds: 15 }, continueSeconds: 10, continueFromSeconds },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    ));
    assert.equal(error.code, "video_extend_point_invalid", `continueFromSeconds=${continueFromSeconds}`);
  }
  // 越界：16s > 来源 15s
  const beyond = catchVideoPostProductionError(() => parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL, durationSeconds: 15 }, continueSeconds: 10, continueFromSeconds: 16 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(beyond.code, "video_extend_point_invalid");
  // 边界正例：0（片首）与 15（＝片长）都放行
  const atZero = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL, durationSeconds: 15 }, continueSeconds: 10, continueFromSeconds: 0 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(atZero?.mode === "extend_video" ? atZero.continueFromSeconds : undefined, 0);
  const atEnd = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL, durationSeconds: 15 }, continueSeconds: 10, continueFromSeconds: 15 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(atEnd?.mode === "extend_video" ? atEnd.continueFromSeconds : undefined, 15);
  // 缺省 ⇒ null（＝交上游预设＝来源片尾）
  const omitted = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(omitted?.mode === "extend_video" ? omitted.continueFromSeconds : undefined, null);
});

test("参数契约 edit：起讫缺失／起点负数／起讫倒置／终点越界各自具名拒收", () => {
  const cases: Array<[unknown, unknown, unknown, string]> = [
    [undefined, 10, 15, "video_edit_segment_invalid"],   // 缺 start
    [0, undefined, 15, "video_edit_segment_invalid"],    // 缺 end
    [-1, 10, 15, "video_edit_segment_invalid"],          // 起点负数
    [5, 5, 15, "video_edit_segment_invalid"],            // 起讫相等（倒置的边界）
    [8, 3, 15, "video_edit_segment_invalid"],            // 起讫倒置
    [0, 16, 15, "video_edit_segment_invalid"],           // 终点超出来源片长 15
    [0.5, 10, 15, "video_edit_segment_invalid"],         // 非整数
    [0, 10.5, 15, "video_edit_segment_invalid"],
  ];
  for (const [startSeconds, endSeconds, durationSeconds, code] of cases) {
    const error = catchVideoPostProductionError(() => parseVideoPostProduction(
      { mode: "edit_video", source: { url: SOURCE_URL, durationSeconds }, startSeconds, endSeconds, instruction: "把猫换成狗" },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    ));
    assert.equal(error.code, code, `start=${String(startSeconds)} end=${String(endSeconds)}`);
    assert.equal(error.status, 400);
  }
  // 边界正例：start=0 合法（非负整数），end=片长 15 合法，区段长 15 落在 2.5-480p 档位
  const ok = parseVideoPostProduction(
    { mode: "edit_video", source: { url: SOURCE_URL, durationSeconds: 15 }, startSeconds: 0, endSeconds: 15, instruction: "把猫换成狗" },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(ok?.mode, "edit_video");
  assert.equal(ok && ok.mode === "edit_video" ? ok.startSeconds : null, 0);
  assert.equal(ok && ok.mode === "edit_video" ? ok.endSeconds : null, 15);
});

test("参数契约 edit：改动描述缺失／全空白／超 2000 字元各自具名拒收", () => {
  for (const instruction of [undefined, null, "", "   "]) {
    const error = catchVideoPostProductionError(() => parseVideoPostProduction(
      { mode: "edit_video", source: { url: SOURCE_URL, durationSeconds: 15 }, startSeconds: 0, endSeconds: 10, instruction },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    ));
    assert.equal(error.code, "video_edit_instruction_missing", `instruction=${JSON.stringify(instruction)}`);
  }
  const tooLong = catchVideoPostProductionError(() => parseVideoPostProduction(
    { mode: "edit_video", source: { url: SOURCE_URL, durationSeconds: 15 }, startSeconds: 0, endSeconds: 10, instruction: "改".repeat(2_001) },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  ));
  // 事实记录（未修改实作）：超长沿用的错误码与「缺失」同码。
  assert.equal(tooLong.code, "video_edit_instruction_missing");
  assert.match(tooLong.message, /2000/);
  // 边界正例：正好 2000 字元放行
  const boundary = parseVideoPostProduction(
    { mode: "edit_video", source: { url: SOURCE_URL, durationSeconds: 15 }, startSeconds: 0, endSeconds: 10, instruction: "改".repeat(2_000) },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(boundary?.mode, "edit_video");
});

test("参数契约：B 端 snake_case（source_video.object_key、continue_seconds、edit_segment）同样被接受", () => {
  const extend = parseVideoPostProduction(
    { mode: "extend_video", source_video: { object_key: "uploads/u1/clip.mp4" }, continue_seconds: "10", continue_from_seconds: 3 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverOk },
  );
  assert.equal(extend?.mode, "extend_video");
  assert.equal(extend && extend.mode === "extend_video" ? extend.continueSeconds : null, 10);
  assert.equal(extend && extend.mode === "extend_video" ? extend.continueFromSeconds : null, 3);

  const edit = parseVideoPostProduction(
    {
      mode: "edit_video",
      source_video: { object_key: "uploads/u1/clip.mp4" },
      edit_segment: { start_seconds: 2, end_seconds: 12, instruction: "把天空改成日落" },
    },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverOk },
  );
  assert.equal(edit?.mode, "edit_video");
  assert.equal(edit && edit.mode === "edit_video" ? edit.startSeconds : null, 2);
  assert.equal(edit && edit.mode === "edit_video" ? edit.instruction : null, "把天空改成日落");
});

test("参数契约：videoPostProductionGeneratedSeconds＝本次新生成秒数（续长／区段长），不是来源片长", () => {
  const extend = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL, durationSeconds: 30 }, continueSeconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(extend);
  assert.equal(videoPostProductionGeneratedSeconds(extend), 10);

  const edit = parseVideoPostProduction(
    { mode: "edit_video", source: { url: SOURCE_URL, durationSeconds: 30 }, startSeconds: 4, endSeconds: 14, instruction: "换服装" },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(edit);
  assert.equal(videoPostProductionGeneratedSeconds(edit), 10);
});

test("参数契约：effectiveVideoPrompt 只在 prompt 为空时用改动描述，不偷偷改写用户 prompt", () => {
  const edit = parseVideoPostProduction(
    { mode: "edit_video", source: { url: SOURCE_URL }, startSeconds: 0, endSeconds: 10, instruction: "把猫换成狗" },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(effectiveVideoPrompt("", edit), "把猫换成狗");
  assert.equal(effectiveVideoPrompt("   ", edit), "把猫换成狗");
  assert.equal(effectiveVideoPrompt("用户原话", edit), "用户原话");
  assert.equal(effectiveVideoPrompt("", null), "");
  const extend = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  // extend 没有改动描述可用 ⇒ 空 prompt 仍为空（由路由层另外挡）
  assert.equal(effectiveVideoPrompt("", extend), "");
});

// ── 4. 来源影片（objectKey → url；解不出＝fail-closed）───────────────────────

test("来源影片：objectKey 经注入解析器解成 URL，并保留 objectKey 供溯源", () => {
  const resolved = resolveSourceVideo({ objectKey: "uploads/u1/clip.mp4" }, resolverOk);
  assert.equal(resolved.url, "https://files.example.com/files/uploads/u1/clip.mp4");
  assert.equal(resolved.objectKey, "uploads/u1/clip.mp4");
  assert.equal(resolved.mimeType, "video/mp4");
});

test("来源影片：解析器回 null ＝ 具名拒收，不送出空 URL、不猜 URL（fail-closed）", () => {
  const error = catchVideoPostProductionError(() => resolveSourceVideo({ objectKey: "uploads/u1/missing.mp4" }, resolverNull));
  assert.equal(error.code, "video_source_video_unresolved");
  assert.equal(error.status, 400);
  // 经 parseVideoPostProduction 同一入口也一样拒
  const viaParse = catchVideoPostProductionError(() => parseVideoPostProduction(
    { mode: "extend_video", source: { object_key: "uploads/u1/missing.mp4" }, continue_seconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(viaParse.code, "video_source_video_unresolved");
  // 解析器只认特定 key ⇒ 别的 key 一样拒（不是「解不出就放行」）
  const otherKey = catchVideoPostProductionError(() => resolveSourceVideo(
    { objectKey: "uploads/u1/其它.mp4" },
    resolverExpectingOnly("uploads/u1/clip.mp4"),
  ));
  assert.equal(otherKey.code, "video_source_video_unresolved");
});

test("来源影片：缺 source／缺 url 与 objectKey ⇒ video_source_video_missing", () => {
  for (const source of [undefined, null, {}, { mimeType: "video/mp4" }, { objectKey: "" }, { url: "   " }]) {
    const error = catchVideoPostProductionError(() => resolveSourceVideo(source as never, resolverOk));
    assert.equal(error.code, "video_source_video_missing", JSON.stringify(source));
  }
  // 解析器在没有 objectKey 时不该被呼叫（避免拿空 key 去猜 URL）
  let called = 0;
  const spy: SourceVideoUrlResolver = (key) => { called += 1; return key ? SOURCE_URL : null; };
  assert.throws(() => resolveSourceVideo({}, spy));
  assert.equal(called, 0);
});

test("来源影片：非 http(s) 形状的 URL 具名拒收（含解析器回传的假 URL）", () => {
  for (const url of ["blob:https://x/y", "ftp://x/y", "data:video/mp4;base64,AA", "/files/clip.mp4", "javascript:alert(1)"]) {
    const error = catchVideoPostProductionError(() => resolveSourceVideo({ url }, resolverOk));
    assert.equal(error.code, "video_source_video_not_url", url);
  }
  // 解析器回的 URL 也受同一形状检查（不会因为来自解析器就放行）
  const error = catchVideoPostProductionError(() => resolveSourceVideo({ objectKey: "k" }, () => "not-a-url"));
  assert.equal(error.code, "video_source_video_not_url");
  // http 也接受（本地/内网素材）
  assert.equal(resolveSourceVideo({ url: "http://10.0.0.5/clip.mp4" }, resolverNull).url, "http://10.0.0.5/clip.mp4");
});

test("来源影片：url 直用优先于 objectKey；片长非法（0／负数／小数）具名拒收", () => {
  const bothGiven = resolveSourceVideo({ url: SOURCE_URL, objectKey: "uploads/u1/clip.mp4" }, resolverNull);
  assert.equal(bothGiven.url, SOURCE_URL);
  assert.equal(bothGiven.objectKey, "uploads/u1/clip.mp4");
  for (const durationSeconds of [0, -5, 1.5]) {
    const error = catchVideoPostProductionError(() => resolveSourceVideo({ url: SOURCE_URL, durationSeconds }, resolverNull));
    assert.equal(error.code, "video_post_production_invalid_request", String(durationSeconds));
  }
  // 合法片长（含字串数字）保留
  assert.equal(resolveSourceVideo({ url: SOURCE_URL, durationSeconds: "12" }, resolverNull).durationSeconds, 12);
  // 事实记录（契约缺口，未修改实作，见回报⑤）：无法解析的片长值被当成「未提供」，
  // 静默丢弃而非具名拒收 ⇒ 续接点／区段的「越界检查」对来源片长失去上界。
  // 因为生成秒数另受 catalog 档位（assertGeneratedSecondsIsPriced）与 PAID_VIDEO_MAX_SECONDS
  // 约束，此缺口不直接放大计费秒数，但会让来源片长的边界检查失效。
  for (const garbage of [NaN, "abc"]) {
    const normalized = resolveSourceVideo({ url: SOURCE_URL, durationSeconds: garbage }, resolverNull);
    assert.equal(normalized.durationSeconds, undefined, `片长 ${String(garbage)} 被静默视为未提供`);
  }
  const unbounded = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL, durationSeconds: "abc" }, continueSeconds: 10, continueFromSeconds: 9_999 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(
    unbounded && unbounded.mode === "extend_video" ? unbounded.continueFromSeconds : undefined,
    9_999,
    "来源片长不可解析 ⇒ 续接点越界检查失效（缺口事实）",
  );
});

// ── 5. 成本闸仍生效（新路径不得绕道；闸在 fetch 之前）────────────────────────

test("成本闸：后期路径的（model, resolution, seconds）＝成本闸实际审到的值，且秒数＝本次生成秒数", () => {
  const supplier = supplierRecord({ id: "env:xiaoyxiao", label: "xiaoyxiao", supplierModelId: "seedance-2.5-900-特惠" });
  const facts = openaiVideoSubmissionFacts(supplier, videoInput({
    modelId: SUPPORTING_MODEL,
    resolution: "480p",
    workflow: {
      durationSeconds: 5, // 普通生成秒数；后期请求必须被它覆写
      videoPostProduction: {
        mode: "extend_video",
        source: { url: SOURCE_URL, mimeType: "video/mp4" },
        continueSeconds: 10,
        continueFromSeconds: null,
      },
    },
  }));
  assert.equal(facts.seconds, 10, "成本闸审到的秒数必须是本次新生成秒数");
  assert.equal(facts.supplierModelId, "seedance-2.5-900-特惠");
  assert.equal(facts.resolution, "480p");
  assert.equal(facts.supplierLabel, "xiaoyxiao");

  // 同一组事实过既有闸：放行，且三元组秒数档位含 10
  const decision = evaluatePaidVideoSubmission(facts);
  assert.equal(decision.allowed, true);
  assert.ok(decision.allowed && decision.triple);
  assert.ok(decision.allowed && decision.triple ? decision.triple.seconds.includes(10) : false);
  assert.ok(decision.allowed && decision.triple ? decision.triple.resolutions.includes("480p") : false);

  // 反例：同一 model 但秒数未登录（9s）⇒ 闸拒（triple_not_priced）。实作在 parse 层就先拒。
  const unpriced = evaluatePaidVideoSubmission({ ...facts, seconds: 9 });
  assert.equal(unpriced.allowed, false);
  assert.equal(unpriced.allowed === false ? unpriced.reason : null, "triple_not_priced");

  // 反例：预设静态映射（sd8-seedance-2.5）不在白名单 ⇒ 闸拒（新路径绕不过白名单）
  const unmapped = evaluatePaidVideoSubmission({ ...facts, supplierModelId: "sd8-seedance-2.5" });
  assert.equal(unmapped.allowed, false);
  assert.equal(unmapped.allowed === false ? unmapped.reason : null, "model_not_whitelisted");
});

test("成本闸：后期请求在上游映射未校准时于任何 fetch 之前拒收（零上游成本）", async () => {
  const harness = stubFetchOk();
  const originalEnv = process.env.VIDEO_POST_PRODUCTION_UPSTREAM;
  try {
    delete process.env.VIDEO_POST_PRODUCTION_UPSTREAM;
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    await assert.rejects(
      () => generateWithOpenaiVideo(supplierRecord(), videoInput({
        modelId: SUPPORTING_MODEL,
        resolution: "480p",
        workflow: postProductionWorkflow({ mode: "extend_video", continueSeconds: 10 }),
      })),
      (error: unknown) => {
        assert.ok(error instanceof SupplierRequestError);
        assert.match(error.message, /video_post_production_upstream_unverified/);
        assert.equal(error.status, 400, "400＝确定性失败，不重放、不烧钱");
        return true;
      },
    );
    assert.equal(harness.calls.length, 0, "未校准＝不得发出任何上游请求");
  } finally {
    restoreEnv("VIDEO_POST_PRODUCTION_UPSTREAM", originalEnv);
    harness.restore();
  }
});

test("成本闸：形状坏／未知 mode 的后期 workflow 也在 fetch 之前拒收（不吞、不降级）", async () => {
  const originalEnv = process.env.VIDEO_POST_PRODUCTION_UPSTREAM;
  try {
    process.env.VIDEO_POST_PRODUCTION_UPSTREAM = "1"; // 即使校准开关已开，形状坏仍拒
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    const broken: Array<Record<string, unknown>> = [
      { mode: "extend_video", source: { url: "" }, continueSeconds: 10 },      // 来源 url 空
      { mode: "extend_video", continueSeconds: 10 },                            // 缺 source
      { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 0 },// 秒数非法
      { mode: "edit_video", source: { url: SOURCE_URL }, startSeconds: 5, endSeconds: 5, instruction: "x" },
      { mode: "generate", source: { url: SOURCE_URL } },                        // 普通生成不得混进来
      { mode: "unknown_mode", source: { url: SOURCE_URL } },
      {},                                                                        // 缺 mode
    ];
    for (const videoPostProduction of broken) {
      const harness = stubFetchOk();
      try {
        await assert.rejects(
          () => generateWithOpenaiVideo(supplierRecord(), videoInput({
            modelId: SUPPORTING_MODEL,
            resolution: "480p",
            // 故意的坏形状（runtime 才可能出现）：型别上以 GenerationWorkflow 承接。
            workflow: { durationSeconds: 10, videoPostProduction } as unknown as GenerationWorkflow,
          })),
          (error: unknown) => {
            assert.ok(error instanceof Error, JSON.stringify(videoPostProduction));
            assert.match(error.message, /video-post-production/);
            return true;
          },
        );
        assert.equal(harness.calls.length, 0, `形状坏仍发了请求：${JSON.stringify(videoPostProduction)}`);
      } finally {
        harness.restore();
      }
    }
  } finally {
    restoreEnv("VIDEO_POST_PRODUCTION_UPSTREAM", originalEnv);
  }
});

/**
 * 事实记录（契约缺口，未修改实作，见回报⑤）：
 * `parseVideoPostProduction` 对「栏位存在但形状不是物件」（字串／数字／阵列）回 null，
 * 与「栏位不存在」同义 ⇒ 客户端送 `video_post_production: "extend_video"` 这种形状时，
 * 建单端会把它当普通生成建单收费（静默降级），与档头「绝不静默降级成一般生成」相冲。
 * 本测试**固化现况**（不是宣称它正确），缺口是否要改成具名拒收由 orchestrator／项目负责人裁定。
 */
test("契约缺口（现况固化）：非物件形状的后期栏位被当成『没有后期』＝普通生成", () => {
  for (const malformed of ["extend_video", "edit_video", 42, [], ["extend_video"]]) {
    assert.equal(
      parseVideoPostProduction(malformed, { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull }),
      null,
      `malformed=${JSON.stringify(malformed)} 目前回 null（＝普通生成）`,
    );
    // 对照组：物件形状但 mode 非法 ⇒ 具名拒收（形状对了就会 fail-closed）
    assert.throws(() => parseVideoPostProduction(
      { mode: malformed, source: { url: SOURCE_URL } },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    ));
  }
  // 后果链：回 null ⇒ 没有 postProduction ⇒ workflow 不落 videoPostProduction ⇒
  // adapter 端 readNormalizedVideoPostProduction 也回 null ⇒ 走普通生成提交。
  assert.equal(readNormalizedVideoPostProduction({ videoPostProduction: "extend_video" }), null);
  assert.equal(effectiveVideoPrompt("", null), "");
});

test("成本闸（正向对照）：普通生成请求确实会呼叫 fetch——证明上面的「零呼叫」不是空断言", async () => {
  const harness = stubFetchOk();
  try {
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    const output = await generateWithOpenaiVideo(supplierRecord(), videoInput({
      modelId: "seedance-2.0",
      resolution: "720p",
      workflow: { durationSeconds: 5, generateAudio: false },
    }));
    assert.ok(output.url);
    assert.ok(harness.calls.length > 0, "stub 必须能侦测到 fetch，否则『零呼叫』毫无意义");
  } finally {
    harness.restore();
  }
});

// ── 6. 上游栏位映射的形状与落点 ─────────────────────────────────────────────

test("上游栏位契约：VIDEO_POST_PRODUCTION_UPSTREAM_FIELD 形状逐字固定，且语义仍标未校准", () => {
  assert.deepEqual({ ...VIDEO_POST_PRODUCTION_UPSTREAM_FIELD }, {
    sourceVideoUrls: "reference_video_urls",
    extendSeconds: "extend_seconds",
    extendFromSeconds: "extend_from_seconds",
    editSegment: "edit_segment",
  });
  assert.equal(VIDEO_POST_PRODUCTION_UPSTREAM_SEMANTICS, "upstream-field-mapping-unverified");
});

test("上游栏位落点：apply 并进请求体（不覆写既有栏位、续接点未指定时不落空栏位）", () => {
  const extend = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 10, continueFromSeconds: 5 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(extend);
  const body = applyVideoPostProductionToUpstreamBody(
    { model: "sd8-seedance-2.5", prompt: "续一段", aspect_ratio: "16:9", duration: 10, resolution: "480p" },
    extend,
  );
  assert.equal(body.model, "sd8-seedance-2.5", "既有栏位不得被覆写");
  assert.equal(body.duration, 10);
  assert.deepEqual(body.reference_video_urls, [SOURCE_URL]);
  assert.equal(body.extend_seconds, 10);
  assert.equal(body.extend_from_seconds, 5);
  assert.equal(body.edit_segment, undefined);

  const noFrom = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(noFrom);
  const bodyNoFrom = applyVideoPostProductionToUpstreamBody({ model: "sd8-seedance-2.5" }, noFrom);
  assert.equal("extend_from_seconds" in bodyNoFrom, false, "未指定续接点不得落 null／undefined 栏位");

  const edit = parseVideoPostProduction(
    { mode: "edit_video", source: { url: SOURCE_URL }, startSeconds: 2, endSeconds: 12, instruction: "把天空改成日落" },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(edit);
  const editBody = applyVideoPostProductionToUpstreamBody({ model: "sd8-seedance-2.5" }, edit);
  assert.deepEqual(editBody.reference_video_urls, [SOURCE_URL]);
  assert.deepEqual(editBody.edit_segment, { start_seconds: 2, end_seconds: 12, instruction: "把天空改成日落" });
  assert.equal(editBody.extend_seconds, undefined);
});

test("上游栏位落点（真提交路径）：开关开启后，请求体真的带上来源影片与续长，且秒数为本次生成秒数", async () => {
  const harness = stubFetchOk();
  const originalEnv = process.env.VIDEO_POST_PRODUCTION_UPSTREAM;
  try {
    process.env.VIDEO_POST_PRODUCTION_UPSTREAM = "1";
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    const output = await generateWithOpenaiVideo(supplierRecord(), videoInput({
      modelId: SUPPORTING_MODEL,
      resolution: "480p",
      workflow: postProductionWorkflow({
        mode: "extend_video",
        continueSeconds: 10,
        continueFromSeconds: 4,
        sourceDurationSeconds: 15,
      }),
    }));
    assert.equal(output.url, "https://cdn.example.com/out/video.mp4");
    assert.equal(output.supplierModelId, "sd8-seedance-2.5");
    const createCall = harness.calls.find((call) => call.method === "POST");
    assert.ok(createCall, "必须有 POST /videos 提交");
    const posted = JSON.parse(String(createCall.body)) as Record<string, unknown>;
    assert.deepEqual(posted.reference_video_urls, [SOURCE_URL], "来源影片必须真的落进请求体");
    assert.equal(posted.extend_seconds, 10);
    assert.equal(posted.extend_from_seconds, 4);
    // workflow.durationSeconds＝5（普通生成），后期请求的 duration 必须是 10（本次生成秒数）
    assert.equal(posted.duration, 10, "后期秒数必须覆写普通生成秒数");
    assert.equal(posted.prompt, "续一段橘猫打哈欠");
  } finally {
    restoreEnv("VIDEO_POST_PRODUCTION_UPSTREAM", originalEnv);
    harness.restore();
  }
});

test("上游栏位落点（真提交路径）：edit_video 请求体带 edit_segment，且不带 extend 栏位", async () => {
  const harness = stubFetchOk();
  const originalEnv = process.env.VIDEO_POST_PRODUCTION_UPSTREAM;
  try {
    process.env.VIDEO_POST_PRODUCTION_UPSTREAM = "1";
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    await generateWithOpenaiVideo(supplierRecord(), videoInput({
      modelId: SUPPORTING_MODEL,
      resolution: "480p",
      workflow: postProductionWorkflow({
        mode: "edit_video",
        startSeconds: 2,
        endSeconds: 12,
        instruction: "把天空改成日落",
        sourceDurationSeconds: 15,
      }),
    }));
    const posted = JSON.parse(String(harness.calls.find((call) => call.method === "POST")?.body)) as Record<string, unknown>;
    assert.deepEqual(posted.edit_segment, { start_seconds: 2, end_seconds: 12, instruction: "把天空改成日落" });
    assert.equal(posted.extend_seconds, undefined);
    assert.equal(posted.duration, 10);
  } finally {
    restoreEnv("VIDEO_POST_PRODUCTION_UPSTREAM", originalEnv);
    harness.restore();
  }
});

test("提交前硬闸：videoPostProductionUpstreamEnabled 只认 1／true，其余（含未设）＝关闭并具名拒收", () => {
  const original = process.env.VIDEO_POST_PRODUCTION_UPSTREAM;
  try {
    for (const off of [undefined, "", "0", "false", "yes", "TRUE "]) {
      if (off === undefined) delete process.env.VIDEO_POST_PRODUCTION_UPSTREAM;
      else process.env.VIDEO_POST_PRODUCTION_UPSTREAM = off;
      const enabled = off === "TRUE ";
      assert.equal(videoPostProductionUpstreamEnabled(), enabled, `env=${String(off)}`);
      const parsed = parseVideoPostProduction(
        { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 10 },
        { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
      );
      assert.ok(parsed);
      if (enabled) {
        assert.doesNotThrow(() => assertVideoPostProductionUpstreamReady(parsed));
      } else {
        assert.throws(
          () => assertVideoPostProductionUpstreamReady(parsed),
          (error: unknown) => {
            assert.ok(error instanceof SupplierRequestError);
            assert.equal(error.status, 400);
            assert.match(error.message, /video_post_production_upstream_unverified/);
            assert.match(error.message, /upstream-field-mapping-unverified/);
            return true;
          },
          `env=${String(off)} 必须拒收`,
        );
      }
    }
  } finally {
    restoreEnv("VIDEO_POST_PRODUCTION_UPSTREAM", original);
  }
});

// ── 7. workflow 持久化契约（worker/adapter 端读回）────────────────────────────

test("workflow 读回契约：正规化物件 round-trip 一致（续片／改片）", () => {
  const extend = parseVideoPostProduction(
    { mode: "extend_video", source: { objectKey: "uploads/u1/clip.mp4", durationSeconds: 15 }, continueSeconds: 10, continueFromSeconds: 5 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverOk },
  );
  assert.ok(extend);
  assert.deepEqual(readNormalizedVideoPostProduction({ videoPostProduction: extend }), extend);

  const edit = parseVideoPostProduction(
    { mode: "edit_video", source: { url: SOURCE_URL }, startSeconds: 2, endSeconds: 12, instruction: "改造型" },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(edit);
  assert.deepEqual(readNormalizedVideoPostProduction({ videoPostProduction: edit }), edit);
});

test("workflow 读回契约：非后期 workflow 回 null（＝零行为变化），形状坏则明确抛错不吞", () => {
  assert.equal(readNormalizedVideoPostProduction({}), null);
  assert.equal(readNormalizedVideoPostProduction({ videoPostProduction: undefined }), null);
  assert.equal(readNormalizedVideoPostProduction({ videoPostProduction: null }), null);
  assert.equal(readNormalizedVideoPostProduction({ videoPostProduction: [] }), null);
  assert.equal(readNormalizedVideoPostProduction({ videoPostProduction: "x" }), null);

  const broken: Array<Record<string, unknown>> = [
    { mode: "extend_video", continueSeconds: 10 },                                       // 缺 source.url
    { mode: "extend_video", source: { url: "" }, continueSeconds: 10 },                   // 空 url
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 0 },            // 秒数非法
    { mode: "extend_video", source: { url: SOURCE_URL } },                                // 缺秒数
    { mode: "edit_video", source: { url: SOURCE_URL }, startSeconds: 5, endSeconds: 5, instruction: "x" },
    { mode: "edit_video", source: { url: SOURCE_URL }, startSeconds: 0, endSeconds: 10 },
    { mode: "unknown", source: { url: SOURCE_URL } },
  ];
  for (const videoPostProduction of broken) {
    assert.throws(
      () => readNormalizedVideoPostProduction({ videoPostProduction }),
      (error: unknown) => {
        assert.ok(error instanceof SupplierRequestError, JSON.stringify(videoPostProduction));
        assert.equal(error.status, 400);
        return true;
      },
      JSON.stringify(videoPostProduction),
    );
  }
});

// ── 本地替身（零真实网路出口）───────────────────────────────────────────────

interface FetchHarness {
  calls: Array<{ method: string; url: string; body?: unknown }>;
  restore: () => void;
}

/** 接管 globalThis.fetch，回一笔成功的 openai-video 任务（提交 → 立即 completed）。 */
function stubFetchOk(): FetchHarness {
  const calls: FetchHarness["calls"] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(init?.method ?? "GET");
    const target = String(url);
    calls.push({ method, url: target, body: init?.body });
    if (target.endsWith("/videos") && method === "POST") {
      return jsonResponse(200, { id: "task_p1_3_stub", model: "sd8-seedance-2.5", status: "queued" });
    }
    if (target.includes("/videos/task_p1_3_stub")) {
      return jsonResponse(200, { id: "task_p1_3_stub", status: "completed", video_url: "https://cdn.example.com/out/video.mp4" });
    }
    return jsonResponse(404, { error: { message: "not found" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function supplierRecord(overrides: Partial<SupplierRecord> = {}): SupplierRecord {
  return {
    id: "env:cangyuansuanli",
    label: "cangyuansuanli",
    adapterType: "openai_video",
    supplyTier: "managed_pool",
    failureDomain: "ai.cangyuansuanli.cn",
    baseUrl: "https://ai.cangyuansuanli.cn/v1",
    credentialRef: "CANGYUANSUANLI_API_KEY",
    configuration: {},
    priority: 8,
    concurrencyLimit: 2,
    qualityScore: 1,
    unitCost: 0,
    healthStatus: "healthy",
    healthScore: 1,
    latencyEwmaMs: null,
    supplierModelId: null,
    capabilityId: 1,
    capabilityConcurrencyLimit: 2,
    contractVersion: 1,
    capabilityHealthStatus: "healthy",
    account: {
      id: "env:cangyuansuanli:default",
      supplierId: "env:cangyuansuanli",
      label: "cangyuansuanli default account",
      credentialRef: "CANGYUANSUANLI_API_KEY",
      enabled: true,
      concurrencyLimit: 2,
      healthStatus: "healthy",
      cooldownUntil: null,
      tokenSource: "static",
      credentialExpiresAt: null,
      refreshStatus: "healthy",
      lastRefreshAt: null,
      lastRefreshFailureAt: null,
      attempts5m: 0,
      successes5m: 0,
      successRate5m: 1,
      healthObservedAt: null,
      lastSelectedAt: null,
      configuration: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...overrides,
  } as SupplierRecord;
}

function videoInput(overrides: Partial<SupplierGenerationInput> = {}): SupplierGenerationInput {
  return {
    jobId: "job-p1-3",
    attemptId: "attempt-p1-3",
    modelId: SUPPORTING_MODEL,
    supplierModelId: null,
    prompt: "续一段橘猫打哈欠",
    kind: "video_generate",
    size: "16:9",
    ratio: "16:9",
    resolution: "480p",
    quality: null,
    workflow: { references: [], metadata: {}, durationSeconds: 5, generateAudio: false },
    ...overrides,
  } as SupplierGenerationInput;
}

/** 以建单前的正规化真函式产生 workflow.videoPostProduction（＝路由实际落库的形状）。 */
function postProductionWorkflow(input: Record<string, unknown>): Record<string, unknown> {
  const durationSeconds = typeof input.sourceDurationSeconds === "number" ? input.sourceDurationSeconds : 15;
  const parsed = parseVideoPostProduction(
    {
      mode: input.mode,
      source: { url: SOURCE_URL, durationSeconds },
      ...(input.continueSeconds !== undefined ? { continueSeconds: input.continueSeconds } : {}),
      ...(input.continueFromSeconds !== undefined ? { continueFromSeconds: input.continueFromSeconds } : {}),
      ...(input.startSeconds !== undefined ? { startSeconds: input.startSeconds } : {}),
      ...(input.endSeconds !== undefined ? { endSeconds: input.endSeconds } : {}),
      ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
    },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(parsed, "测试夹具：后期参数必须先通过建单前校验");
  return { references: [], metadata: {}, durationSeconds: 5, generateAudio: false, videoPostProduction: parsed };
}