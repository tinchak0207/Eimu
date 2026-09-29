/**
 * P1-3 生成式後期（續片 `extend_video`／局部改片 `edit_video`）行為測試。
 *
 * 為什麼必須有這份：本能力壓在**付費上游 fetch 之前的 fail-closed 閘門**上
 * （實作檔頭與 openai-video-upstream.ts:194-196 明寫「映射未校準＝具名拒收，零上游成本」）。
 * 這一格出錯就是花錢，所以判準全部走**真函式 + 本地替身（stub fetch／stub resolver）**，
 * 零付費上游請求：測試中所有 fetch 都由測試自己接管的 globalThis.fetch 回應，
 * 沒有任何真實網路出口。
 *
 * 真單未驗：本檔不提交任何上游請求；`VIDEO_POST_PRODUCTION_UPSTREAM` 的正式開通
 * 與真單校準待暴君逐次報備。
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

// ── 現場真值（來自 generation-model-catalog 的實資料，不是測試自造）──────────
const SUPPORTING_MODEL = "seedance-2.5-480p";   // catalog.ts:626-645 宣告三型別
const SUPPORTING_MODEL_720P = "seedance-2.5-720p"; // catalog.ts:646-664
const UNSUPPORTING_MODEL = "seedance-2.0";      // catalog.ts:609-625 無 videoGenerationTypes
const UNSUPPORTING_30S_MODEL = "seedance-2.5-30s"; // catalog.ts:667-683 無 videoGenerationTypes
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
      `預期 VideoPostProductionError，實得 ${error instanceof Error ? error.name : typeof error}：${String(error)}`,
    );
    return error;
  }
  assert.fail("預期拋出 VideoPostProductionError，但沒有拋錯（＝靜默接受了非法輸入）");
}

// ── 1. 型別契約 ────────────────────────────────────────────────────────────

test("型別契約：VIDEO_POST_PRODUCTION_MODES 逐字為 extend_video／edit_video", () => {
  assert.deepEqual([...VIDEO_POST_PRODUCTION_MODES], ["extend_video", "edit_video"]);
});

test("型別契約：VIDEO_GENERATION_TYPES 含 generate ＋ 兩個後期型別，且僅此三者", () => {
  assert.deepEqual([...VIDEO_GENERATION_TYPES], ["generate", "extend_video", "edit_video"]);
  assert.ok(VIDEO_GENERATION_TYPES.includes("generate"));
  assert.ok(VIDEO_GENERATION_TYPES.includes("extend_video"));
  assert.ok(VIDEO_GENERATION_TYPES.includes("edit_video"));
  // 後期型別集合必須是 VIDEO_GENERATION_TYPES 去掉 generate 的子集（兩表不得漂移）。
  assert.deepEqual(
    VIDEO_GENERATION_TYPES.filter((value) => value !== "generate"),
    [...VIDEO_POST_PRODUCTION_MODES],
  );
});

test("型別契約（編譯期）：VideoPostProductionMode 不接受 generate／未知字串", () => {
  // @ts-expect-error "generate" 不是生成式後期型別（普通生成走 mode 缺省路徑）
  const notAMode: VideoPostProductionMode = "generate";
  // @ts-expect-error 未知名稱不是後期型別
  const alsoNot: VideoPostProductionMode = "upscale_video";
  assert.equal(typeof notAMode, "string");
  assert.equal(typeof alsoNot, "string");
  // VideoGenerationType 收三種（編譯期斷言，值域與真相對齊）
  const all: readonly VideoGenerationType[] = ["generate", "extend_video", "edit_video"];
  assert.equal(all.length, 3);
});

test("型別契約（執行期）：非後期型別值一律具名拒收，不靜默降級成普通 generate", () => {
  for (const mode of ["generate", "upscale_video", "extend", "", "EXTEND_VIDEO", 1, null]) {
    const error = catchVideoPostProductionError(() => parseVideoPostProduction(
      { mode, source: { url: SOURCE_URL }, continueSeconds: 10 },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    ));
    assert.equal(error.code, "video_post_production_invalid_request", `mode=${String(mode)}`);
    assert.equal(error.status, 400);
  }
  // mode 缺席也拒（不是「當普通生成」）
  const missing = catchVideoPostProductionError(() => parseVideoPostProduction(
    { source: { url: SOURCE_URL }, continueSeconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(missing.code, "video_post_production_invalid_request");
});

test("型別契約：input 不是物件（null／陣列／字串）＝本次提交非生成式後期，回 null 走普通生成", () => {
  for (const input of [null, undefined, [], "extend_video", 42]) {
    assert.equal(
      parseVideoPostProduction(input, { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull }),
      null,
      `input=${JSON.stringify(input)}`,
    );
  }
});

// ── 2. 能力閘門（最重要）──────────────────────────────────────────────────

test("能力閘門：catalog 真資料——只有 Seedance-2.5 族宣告 extend_video／edit_video", () => {
  // 正例：兩個 2.5 檔位都支援（真資料，不是測試自造）
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
  // 反例：2.0 系與 drama 30s 檔位都沒宣告 ⇒ 不推導不升格
  for (const modelId of [UNSUPPORTING_MODEL, UNSUPPORTING_30S_MODEL]) {
    assert.deepEqual([...videoGenerationTypesFor(modelId)], ["generate"], modelId);
    assert.equal(supportsVideoGenerationType(modelId, "extend_video"), false, modelId);
    assert.equal(supportsVideoGenerationType(modelId, "edit_video"), false, modelId);
    assert.equal(generationModel(modelId)?.videoGenerationTypes, undefined, modelId);
  }
  // 未知模型 ⇒ 只支援普通生成（能力宣告缺一即不許提交）
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

test("能力閘門：assertVideoGenerationTypeSupported 正例放行、反例具名 400", () => {
  assert.doesNotThrow(() => assertVideoGenerationTypeSupported(SUPPORTING_MODEL, "extend_video"));
  assert.doesNotThrow(() => assertVideoGenerationTypeSupported(SUPPORTING_MODEL, "edit_video"));
  for (const modelId of [UNSUPPORTING_MODEL, UNSUPPORTING_30S_MODEL, UNKNOWN_MODEL]) {
    for (const mode of ["extend_video", "edit_video"] as const) {
      const error = catchVideoPostProductionError(() => assertVideoGenerationTypeSupported(modelId, mode));
      assert.equal(error.code, "video_generation_type_unsupported", `${modelId}/${mode}`);
      assert.equal(error.status, 400);
      // 訊息必須指路（可用型別＋目前僅 Seedance-2.5 族），不得默不作聲
      assert.match(error.message, /不支援生成型別/);
      assert.match(error.message, /Seedance-2\.5/);
    }
  }
});

test("能力閘門：不支援的模型 parse 時拒絕，且不支援的參數不必細看（能力錯先於參數錯）", () => {
  // 故意同時帶壞參數：錯誤碼必須仍是不支援（能力閘先做），不是參數錯。
  const error = catchVideoPostProductionError(() => parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: -99 },
    { modelId: UNSUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(error.code, "video_generation_type_unsupported");
});

test("能力閘門：支援的模型 parse 正例回正規化物件（不是回 null，也不是降級）", () => {
  const parsed = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(parsed);
  assert.equal(parsed.mode, "extend_video");
});

// ── 3. 參數契約 ────────────────────────────────────────────────────────────

test("參數契約 extend：續長缺失／0／負數／小數／超上限各自具名拒收", () => {
  const cases: Array<[unknown, string]> = [
    [undefined, "video_extend_seconds_invalid"],  // 必填
    [null, "video_extend_seconds_invalid"],
    ["", "video_extend_seconds_invalid"],
    [0, "video_extend_seconds_invalid"],          // 邊界 0
    [-1, "video_extend_seconds_invalid"],         // 負數
    [10.5, "video_extend_seconds_invalid"],       // 小數
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

test("參數契約 extend：續長在 1–30 但不在 catalog 檔位 ⇒ 具名未核價拒收（成本閘前先拒）", () => {
  // seedance-2.5-480p 的 durations 是 10..30；9 合法但未登錄。
  const error = catchVideoPostProductionError(() => parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 9 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(error.code, "video_post_production_seconds_not_priced");
  assert.match(error.message, /未登錄|檔位/);
  // 邊界正例：10（下界）與 30（上界）都放行
  for (const seconds of [10, 30]) {
    const parsed = parseVideoPostProduction(
      { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: seconds },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    );
    assert.equal(parsed?.mode === "extend_video" ? parsed.continueSeconds : null, seconds);
  }
  // 720p 檔位上限 29：30 未登錄 ⇒ 拒
  const over = catchVideoPostProductionError(() => parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 30 },
    { modelId: SUPPORTING_MODEL_720P, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(over.code, "video_post_production_seconds_not_priced");
});

test("參數契約 extend：續接點負數／非整數／越過來源片長各自具名拒收；缺省＝null", () => {
  for (const continueFromSeconds of [-1, 1.5, -0.5]) {
    const error = catchVideoPostProductionError(() => parseVideoPostProduction(
      { mode: "extend_video", source: { url: SOURCE_URL, durationSeconds: 15 }, continueSeconds: 10, continueFromSeconds },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    ));
    assert.equal(error.code, "video_extend_point_invalid", `continueFromSeconds=${continueFromSeconds}`);
  }
  // 越界：16s > 來源 15s
  const beyond = catchVideoPostProductionError(() => parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL, durationSeconds: 15 }, continueSeconds: 10, continueFromSeconds: 16 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(beyond.code, "video_extend_point_invalid");
  // 邊界正例：0（片首）與 15（＝片長）都放行
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
  // 缺省 ⇒ null（＝交上游預設＝來源片尾）
  const omitted = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(omitted?.mode === "extend_video" ? omitted.continueFromSeconds : undefined, null);
});

test("參數契約 edit：起訖缺失／起點負數／起訖倒置／終點越界各自具名拒收", () => {
  const cases: Array<[unknown, unknown, unknown, string]> = [
    [undefined, 10, 15, "video_edit_segment_invalid"],   // 缺 start
    [0, undefined, 15, "video_edit_segment_invalid"],    // 缺 end
    [-1, 10, 15, "video_edit_segment_invalid"],          // 起點負數
    [5, 5, 15, "video_edit_segment_invalid"],            // 起訖相等（倒置的邊界）
    [8, 3, 15, "video_edit_segment_invalid"],            // 起訖倒置
    [0, 16, 15, "video_edit_segment_invalid"],           // 終點超出來源片長 15
    [0.5, 10, 15, "video_edit_segment_invalid"],         // 非整數
    [0, 10.5, 15, "video_edit_segment_invalid"],
  ];
  for (const [startSeconds, endSeconds, durationSeconds, code] of cases) {
    const error = catchVideoPostProductionError(() => parseVideoPostProduction(
      { mode: "edit_video", source: { url: SOURCE_URL, durationSeconds }, startSeconds, endSeconds, instruction: "把貓換成狗" },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    ));
    assert.equal(error.code, code, `start=${String(startSeconds)} end=${String(endSeconds)}`);
    assert.equal(error.status, 400);
  }
  // 邊界正例：start=0 合法（非負整數），end=片長 15 合法，區段長 15 落在 2.5-480p 檔位
  const ok = parseVideoPostProduction(
    { mode: "edit_video", source: { url: SOURCE_URL, durationSeconds: 15 }, startSeconds: 0, endSeconds: 15, instruction: "把貓換成狗" },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(ok?.mode, "edit_video");
  assert.equal(ok && ok.mode === "edit_video" ? ok.startSeconds : null, 0);
  assert.equal(ok && ok.mode === "edit_video" ? ok.endSeconds : null, 15);
});

test("參數契約 edit：改動描述缺失／全空白／超 2000 字元各自具名拒收", () => {
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
  // 事實記錄（未修改實作）：超長沿用的錯誤碼與「缺失」同碼。
  assert.equal(tooLong.code, "video_edit_instruction_missing");
  assert.match(tooLong.message, /2000/);
  // 邊界正例：正好 2000 字元放行
  const boundary = parseVideoPostProduction(
    { mode: "edit_video", source: { url: SOURCE_URL, durationSeconds: 15 }, startSeconds: 0, endSeconds: 10, instruction: "改".repeat(2_000) },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(boundary?.mode, "edit_video");
});

test("參數契約：B 端 snake_case（source_video.object_key、continue_seconds、edit_segment）同樣被接受", () => {
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

test("參數契約：videoPostProductionGeneratedSeconds＝本次新生成秒數（續長／區段長），不是來源片長", () => {
  const extend = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL, durationSeconds: 30 }, continueSeconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(extend);
  assert.equal(videoPostProductionGeneratedSeconds(extend), 10);

  const edit = parseVideoPostProduction(
    { mode: "edit_video", source: { url: SOURCE_URL, durationSeconds: 30 }, startSeconds: 4, endSeconds: 14, instruction: "換服裝" },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(edit);
  assert.equal(videoPostProductionGeneratedSeconds(edit), 10);
});

test("參數契約：effectiveVideoPrompt 只在 prompt 為空時用改動描述，不偷偷改寫用戶 prompt", () => {
  const edit = parseVideoPostProduction(
    { mode: "edit_video", source: { url: SOURCE_URL }, startSeconds: 0, endSeconds: 10, instruction: "把貓換成狗" },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(effectiveVideoPrompt("", edit), "把貓換成狗");
  assert.equal(effectiveVideoPrompt("   ", edit), "把貓換成狗");
  assert.equal(effectiveVideoPrompt("用戶原話", edit), "用戶原話");
  assert.equal(effectiveVideoPrompt("", null), "");
  const extend = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  // extend 沒有改動描述可用 ⇒ 空 prompt 仍為空（由路由層另外擋）
  assert.equal(effectiveVideoPrompt("", extend), "");
});

// ── 4. 來源影片（objectKey → url；解不出＝fail-closed）───────────────────────

test("來源影片：objectKey 經注入解析器解成 URL，並保留 objectKey 供溯源", () => {
  const resolved = resolveSourceVideo({ objectKey: "uploads/u1/clip.mp4" }, resolverOk);
  assert.equal(resolved.url, "https://files.example.com/files/uploads/u1/clip.mp4");
  assert.equal(resolved.objectKey, "uploads/u1/clip.mp4");
  assert.equal(resolved.mimeType, "video/mp4");
});

test("來源影片：解析器回 null ＝ 具名拒收，不送出空 URL、不猜 URL（fail-closed）", () => {
  const error = catchVideoPostProductionError(() => resolveSourceVideo({ objectKey: "uploads/u1/missing.mp4" }, resolverNull));
  assert.equal(error.code, "video_source_video_unresolved");
  assert.equal(error.status, 400);
  // 經 parseVideoPostProduction 同一入口也一樣拒
  const viaParse = catchVideoPostProductionError(() => parseVideoPostProduction(
    { mode: "extend_video", source: { object_key: "uploads/u1/missing.mp4" }, continue_seconds: 10 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  ));
  assert.equal(viaParse.code, "video_source_video_unresolved");
  // 解析器只認特定 key ⇒ 別的 key 一樣拒（不是「解不出就放行」）
  const otherKey = catchVideoPostProductionError(() => resolveSourceVideo(
    { objectKey: "uploads/u1/其它.mp4" },
    resolverExpectingOnly("uploads/u1/clip.mp4"),
  ));
  assert.equal(otherKey.code, "video_source_video_unresolved");
});

test("來源影片：缺 source／缺 url 與 objectKey ⇒ video_source_video_missing", () => {
  for (const source of [undefined, null, {}, { mimeType: "video/mp4" }, { objectKey: "" }, { url: "   " }]) {
    const error = catchVideoPostProductionError(() => resolveSourceVideo(source as never, resolverOk));
    assert.equal(error.code, "video_source_video_missing", JSON.stringify(source));
  }
  // 解析器在沒有 objectKey 時不該被呼叫（避免拿空 key 去猜 URL）
  let called = 0;
  const spy: SourceVideoUrlResolver = (key) => { called += 1; return key ? SOURCE_URL : null; };
  assert.throws(() => resolveSourceVideo({}, spy));
  assert.equal(called, 0);
});

test("來源影片：非 http(s) 形狀的 URL 具名拒收（含解析器回傳的假 URL）", () => {
  for (const url of ["blob:https://x/y", "ftp://x/y", "data:video/mp4;base64,AA", "/files/clip.mp4", "javascript:alert(1)"]) {
    const error = catchVideoPostProductionError(() => resolveSourceVideo({ url }, resolverOk));
    assert.equal(error.code, "video_source_video_not_url", url);
  }
  // 解析器回的 URL 也受同一形狀檢查（不會因為來自解析器就放行）
  const error = catchVideoPostProductionError(() => resolveSourceVideo({ objectKey: "k" }, () => "not-a-url"));
  assert.equal(error.code, "video_source_video_not_url");
  // http 也接受（本地/內網素材）
  assert.equal(resolveSourceVideo({ url: "http://10.0.0.5/clip.mp4" }, resolverNull).url, "http://10.0.0.5/clip.mp4");
});

test("來源影片：url 直用優先於 objectKey；片長非法（0／負數／小數）具名拒收", () => {
  const bothGiven = resolveSourceVideo({ url: SOURCE_URL, objectKey: "uploads/u1/clip.mp4" }, resolverNull);
  assert.equal(bothGiven.url, SOURCE_URL);
  assert.equal(bothGiven.objectKey, "uploads/u1/clip.mp4");
  for (const durationSeconds of [0, -5, 1.5]) {
    const error = catchVideoPostProductionError(() => resolveSourceVideo({ url: SOURCE_URL, durationSeconds }, resolverNull));
    assert.equal(error.code, "video_post_production_invalid_request", String(durationSeconds));
  }
  // 合法片長（含字串數字）保留
  assert.equal(resolveSourceVideo({ url: SOURCE_URL, durationSeconds: "12" }, resolverNull).durationSeconds, 12);
  // 事實記錄（契約缺口，未修改實作，見回報⑤）：無法解析的片長值被當成「未提供」，
  // 靜默丟棄而非具名拒收 ⇒ 續接點／區段的「越界檢查」對來源片長失去上界。
  // 因為生成秒數另受 catalog 檔位（assertGeneratedSecondsIsPriced）與 PAID_VIDEO_MAX_SECONDS
  // 約束，此缺口不直接放大計費秒數，但會讓來源片長的邊界檢查失效。
  for (const garbage of [NaN, "abc"]) {
    const normalized = resolveSourceVideo({ url: SOURCE_URL, durationSeconds: garbage }, resolverNull);
    assert.equal(normalized.durationSeconds, undefined, `片長 ${String(garbage)} 被靜默視為未提供`);
  }
  const unbounded = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL, durationSeconds: "abc" }, continueSeconds: 10, continueFromSeconds: 9_999 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.equal(
    unbounded && unbounded.mode === "extend_video" ? unbounded.continueFromSeconds : undefined,
    9_999,
    "來源片長不可解析 ⇒ 續接點越界檢查失效（缺口事實）",
  );
});

// ── 5. 成本閘仍生效（新路徑不得繞道；閘在 fetch 之前）────────────────────────

test("成本閘：後期路徑的（model, resolution, seconds）＝成本閘實際審到的值，且秒數＝本次生成秒數", () => {
  const supplier = supplierRecord({ id: "env:xiaoyxiao", label: "xiaoyxiao", supplierModelId: "seedance-2.5-900-特惠" });
  const facts = openaiVideoSubmissionFacts(supplier, videoInput({
    modelId: SUPPORTING_MODEL,
    resolution: "480p",
    workflow: {
      durationSeconds: 5, // 普通生成秒數；後期請求必須被它覆寫
      videoPostProduction: {
        mode: "extend_video",
        source: { url: SOURCE_URL, mimeType: "video/mp4" },
        continueSeconds: 10,
        continueFromSeconds: null,
      },
    },
  }));
  assert.equal(facts.seconds, 10, "成本閘審到的秒數必須是本次新生成秒數");
  assert.equal(facts.supplierModelId, "seedance-2.5-900-特惠");
  assert.equal(facts.resolution, "480p");
  assert.equal(facts.supplierLabel, "xiaoyxiao");

  // 同一組事實過既有閘：放行，且三元組秒數檔位含 10
  const decision = evaluatePaidVideoSubmission(facts);
  assert.equal(decision.allowed, true);
  assert.ok(decision.allowed && decision.triple);
  assert.ok(decision.allowed && decision.triple ? decision.triple.seconds.includes(10) : false);
  assert.ok(decision.allowed && decision.triple ? decision.triple.resolutions.includes("480p") : false);

  // 反例：同一 model 但秒數未登錄（9s）⇒ 閘拒（triple_not_priced）。實作在 parse 層就先拒。
  const unpriced = evaluatePaidVideoSubmission({ ...facts, seconds: 9 });
  assert.equal(unpriced.allowed, false);
  assert.equal(unpriced.allowed === false ? unpriced.reason : null, "triple_not_priced");

  // 反例：預設靜態映射（sd8-seedance-2.5）不在白名單 ⇒ 閘拒（新路徑繞不過白名單）
  const unmapped = evaluatePaidVideoSubmission({ ...facts, supplierModelId: "sd8-seedance-2.5" });
  assert.equal(unmapped.allowed, false);
  assert.equal(unmapped.allowed === false ? unmapped.reason : null, "model_not_whitelisted");
});

test("成本閘：後期請求在上游映射未校準時於任何 fetch 之前拒收（零上游成本）", async () => {
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
        assert.equal(error.status, 400, "400＝確定性失敗，不重放、不燒錢");
        return true;
      },
    );
    assert.equal(harness.calls.length, 0, "未校準＝不得發出任何上游請求");
  } finally {
    restoreEnv("VIDEO_POST_PRODUCTION_UPSTREAM", originalEnv);
    harness.restore();
  }
});

test("成本閘：形狀壞／未知 mode 的後期 workflow 也在 fetch 之前拒收（不吞、不降級）", async () => {
  const originalEnv = process.env.VIDEO_POST_PRODUCTION_UPSTREAM;
  try {
    process.env.VIDEO_POST_PRODUCTION_UPSTREAM = "1"; // 即使校準開關已開，形狀壞仍拒
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    const broken: Array<Record<string, unknown>> = [
      { mode: "extend_video", source: { url: "" }, continueSeconds: 10 },      // 來源 url 空
      { mode: "extend_video", continueSeconds: 10 },                            // 缺 source
      { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 0 },// 秒數非法
      { mode: "edit_video", source: { url: SOURCE_URL }, startSeconds: 5, endSeconds: 5, instruction: "x" },
      { mode: "generate", source: { url: SOURCE_URL } },                        // 普通生成不得混進來
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
            // 故意的壞形狀（runtime 才可能出現）：型別上以 GenerationWorkflow 承接。
            workflow: { durationSeconds: 10, videoPostProduction } as unknown as GenerationWorkflow,
          })),
          (error: unknown) => {
            assert.ok(error instanceof Error, JSON.stringify(videoPostProduction));
            assert.match(error.message, /video-post-production/);
            return true;
          },
        );
        assert.equal(harness.calls.length, 0, `形狀壞仍發了請求：${JSON.stringify(videoPostProduction)}`);
      } finally {
        harness.restore();
      }
    }
  } finally {
    restoreEnv("VIDEO_POST_PRODUCTION_UPSTREAM", originalEnv);
  }
});

/**
 * 事實記錄（契約缺口，未修改實作，見回報⑤）：
 * `parseVideoPostProduction` 對「欄位存在但形狀不是物件」（字串／數字／陣列）回 null，
 * 與「欄位不存在」同義 ⇒ 客戶端送 `video_post_production: "extend_video"` 這種形狀時，
 * 建單端會把它當普通生成建單收費（靜默降級），與檔頭「絕不靜默降級成一般生成」相衝。
 * 本測試**固化現況**（不是宣稱它正確），缺口是否要改成具名拒收由 orchestrator／暴君裁定。
 */
test("契約缺口（現況固化）：非物件形狀的後期欄位被當成『沒有後期』＝普通生成", () => {
  for (const malformed of ["extend_video", "edit_video", 42, [], ["extend_video"]]) {
    assert.equal(
      parseVideoPostProduction(malformed, { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull }),
      null,
      `malformed=${JSON.stringify(malformed)} 目前回 null（＝普通生成）`,
    );
    // 對照組：物件形狀但 mode 非法 ⇒ 具名拒收（形狀對了就會 fail-closed）
    assert.throws(() => parseVideoPostProduction(
      { mode: malformed, source: { url: SOURCE_URL } },
      { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
    ));
  }
  // 後果鏈：回 null ⇒ 沒有 postProduction ⇒ workflow 不落 videoPostProduction ⇒
  // adapter 端 readNormalizedVideoPostProduction 也回 null ⇒ 走普通生成提交。
  assert.equal(readNormalizedVideoPostProduction({ videoPostProduction: "extend_video" }), null);
  assert.equal(effectiveVideoPrompt("", null), "");
});

test("成本閘（正向對照）：普通生成請求確實會呼叫 fetch——證明上面的「零呼叫」不是空斷言", async () => {
  const harness = stubFetchOk();
  try {
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    const output = await generateWithOpenaiVideo(supplierRecord(), videoInput({
      modelId: "seedance-2.0",
      resolution: "720p",
      workflow: { durationSeconds: 5, generateAudio: false },
    }));
    assert.ok(output.url);
    assert.ok(harness.calls.length > 0, "stub 必須能偵測到 fetch，否則『零呼叫』毫無意義");
  } finally {
    harness.restore();
  }
});

// ── 6. 上游欄位映射的形狀與落點 ─────────────────────────────────────────────

test("上游欄位契約：VIDEO_POST_PRODUCTION_UPSTREAM_FIELD 形狀逐字固定，且語義仍標未校準", () => {
  assert.deepEqual({ ...VIDEO_POST_PRODUCTION_UPSTREAM_FIELD }, {
    sourceVideoUrls: "reference_video_urls",
    extendSeconds: "extend_seconds",
    extendFromSeconds: "extend_from_seconds",
    editSegment: "edit_segment",
  });
  assert.equal(VIDEO_POST_PRODUCTION_UPSTREAM_SEMANTICS, "upstream-field-mapping-unverified");
});

test("上游欄位落點：apply 併進請求體（不覆寫既有欄位、續接點未指定時不落空欄位）", () => {
  const extend = parseVideoPostProduction(
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 10, continueFromSeconds: 5 },
    { modelId: SUPPORTING_MODEL, resolveObjectKeyUrl: resolverNull },
  );
  assert.ok(extend);
  const body = applyVideoPostProductionToUpstreamBody(
    { model: "sd8-seedance-2.5", prompt: "續一段", aspect_ratio: "16:9", duration: 10, resolution: "480p" },
    extend,
  );
  assert.equal(body.model, "sd8-seedance-2.5", "既有欄位不得被覆寫");
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
  assert.equal("extend_from_seconds" in bodyNoFrom, false, "未指定續接點不得落 null／undefined 欄位");

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

test("上游欄位落點（真提交路徑）：開關開啟後，請求體真的帶上來源影片與續長，且秒數為本次生成秒數", async () => {
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
    assert.ok(createCall, "必須有 POST /videos 提交");
    const posted = JSON.parse(String(createCall.body)) as Record<string, unknown>;
    assert.deepEqual(posted.reference_video_urls, [SOURCE_URL], "來源影片必須真的落進請求體");
    assert.equal(posted.extend_seconds, 10);
    assert.equal(posted.extend_from_seconds, 4);
    // workflow.durationSeconds＝5（普通生成），後期請求的 duration 必須是 10（本次生成秒數）
    assert.equal(posted.duration, 10, "後期秒數必須覆寫普通生成秒數");
    assert.equal(posted.prompt, "續一段橘貓打哈欠");
  } finally {
    restoreEnv("VIDEO_POST_PRODUCTION_UPSTREAM", originalEnv);
    harness.restore();
  }
});

test("上游欄位落點（真提交路徑）：edit_video 請求體帶 edit_segment，且不帶 extend 欄位", async () => {
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

test("提交前硬閘：videoPostProductionUpstreamEnabled 只認 1／true，其餘（含未設）＝關閉並具名拒收", () => {
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
          `env=${String(off)} 必須拒收`,
        );
      }
    }
  } finally {
    restoreEnv("VIDEO_POST_PRODUCTION_UPSTREAM", original);
  }
});

// ── 7. workflow 持久化契約（worker/adapter 端讀回）────────────────────────────

test("workflow 讀回契約：正規化物件 round-trip 一致（續片／改片）", () => {
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

test("workflow 讀回契約：非後期 workflow 回 null（＝零行為變化），形狀壞則明確拋錯不吞", () => {
  assert.equal(readNormalizedVideoPostProduction({}), null);
  assert.equal(readNormalizedVideoPostProduction({ videoPostProduction: undefined }), null);
  assert.equal(readNormalizedVideoPostProduction({ videoPostProduction: null }), null);
  assert.equal(readNormalizedVideoPostProduction({ videoPostProduction: [] }), null);
  assert.equal(readNormalizedVideoPostProduction({ videoPostProduction: "x" }), null);

  const broken: Array<Record<string, unknown>> = [
    { mode: "extend_video", continueSeconds: 10 },                                       // 缺 source.url
    { mode: "extend_video", source: { url: "" }, continueSeconds: 10 },                   // 空 url
    { mode: "extend_video", source: { url: SOURCE_URL }, continueSeconds: 0 },            // 秒數非法
    { mode: "extend_video", source: { url: SOURCE_URL } },                                // 缺秒數
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

// ── 本地替身（零真實網路出口）───────────────────────────────────────────────

interface FetchHarness {
  calls: Array<{ method: string; url: string; body?: unknown }>;
  restore: () => void;
}

/** 接管 globalThis.fetch，回一筆成功的 openai-video 任務（提交 → 立即 completed）。 */
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
    prompt: "續一段橘貓打哈欠",
    kind: "video_generate",
    size: "16:9",
    ratio: "16:9",
    resolution: "480p",
    quality: null,
    workflow: { references: [], metadata: {}, durationSeconds: 5, generateAudio: false },
    ...overrides,
  } as SupplierGenerationInput;
}

/** 以建單前的正規化真函式產生 workflow.videoPostProduction（＝路由實際落庫的形狀）。 */
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
  assert.ok(parsed, "測試夾具：後期參數必須先通過建單前校驗");
  return { references: [], metadata: {}, durationSeconds: 5, generateAudio: false, videoPostProduction: parsed };
}