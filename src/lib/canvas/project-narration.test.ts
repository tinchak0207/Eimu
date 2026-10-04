// 解说剧型别与旁白音色（P1-5／对称差 D7）——真行为断言。
//
// 独立 oracle：型别值域**逐字抄自 AID `ScriptTypeEnum`**
// （`src/lib/aid-enums/creation.ts:122-127` 的 `AID_SCRIPT_TYPE_ENUM`，该档逐字转录自
// `aid-interface/…/enums/ScriptTypeEnum.java`）；音色值域取真语音库里的真实 id。
//
// 真执行器：`npx tsx --test src/lib/canvas/project-narration.test.ts`

import test from "node:test";
import assert from "node:assert/strict";
import {
  CANVAS_SCRIPT_TYPES,
  CANVAS_SCRIPT_TYPE_LABELS,
  COMMENTARY_SCRIPT_TYPE,
  effectiveNarrationVoice,
  isCanvasScriptType,
  isCommentaryScriptType,
  narrationVoiceConflicts,
  normalizeProjectNarration,
} from "./project-narration";
import { normalizeProject } from "./project-store";
import { canvasProjectMeta, normalizeProjectMetaPatch, toCanvasProject, fromCanvasProject } from "./layout";
import { VOICE_LIBRARY } from "@/lib/voice-library";

/** AID `ScriptTypeEnum` 的值集合（逐字；键序＝AID 宣告序）。 */
const AID_ORACLE = [
  { value: "plot", desc: "剧情演绎" },
  { value: "monologue", desc: "真人解说漫" },
];
const REAL_VOICE = VOICE_LIBRARY.find((v) => v.id === "zh-CN-YunxiNeural")!.id;

test("型别值域逐字对齐 AID ScriptTypeEnum（不另立词表），解说剧＝monologue", () => {
  assert.deepEqual([...CANVAS_SCRIPT_TYPES], AID_ORACLE.map((m) => m.value));
  assert.equal(COMMENTARY_SCRIPT_TYPE, "monologue");
  // 标签＝AID desc 原字（未改写、未简繁转换）。
  for (const m of AID_ORACLE) {
    assert.equal(CANVAS_SCRIPT_TYPE_LABELS[m.value as keyof typeof CANVAS_SCRIPT_TYPE_LABELS], m.desc);
  }
  assert.equal(isCommentaryScriptType("monologue"), true);
  assert.equal(isCommentaryScriptType("plot"), false);
});

test("判据：只认值域内的字串，其余（含 AID 其他 enum 的值）一律不认", () => {
  assert.equal(isCanvasScriptType("plot"), true);
  assert.equal(isCanvasScriptType("monologue"), true);
  for (const bad of ["commentary", "short_drama", "series", "movie", "", "  ", 0, null, undefined, {}, []]) {
    assert.equal(isCanvasScriptType(bad), false, `${JSON.stringify(bad)} 不得被认成剧本型别`);
  }
});

test("清洗：逐栏独立、非法省略该键（不整包作废、不写假值）", () => {
  // 型别非法但音色合法 ⇒ 只丢型别那一个键。
  assert.deepEqual(normalizeProjectNarration({ scriptType: "不存在的型别", narrationVoice: REAL_VOICE }), {
    narrationVoice: REAL_VOICE,
  });
  // 音色未知（语音库同一把尺）⇒ 只丢音色那一个键。
  assert.deepEqual(normalizeProjectNarration({ scriptType: "monologue", narrationVoice: "不存在的音色" }), {
    scriptType: "monologue",
  });
  // 合法 ⇒ 两栏都留；空物件 ⇒ 不冒键（缺栏＝未宣告）。
  assert.deepEqual(normalizeProjectNarration({ scriptType: "plot", narrationVoice: REAL_VOICE }), {
    scriptType: "plot",
    narrationVoice: REAL_VOICE,
  });
  assert.deepEqual(normalizeProjectNarration({}), {});
  assert.deepEqual(Object.keys(normalizeProjectNarration({ scriptType: "monologue" })), ["scriptType"]);
});

test("音色值域＝语音库同一把尺：别名与 SF 形式也收，自由字串不收", () => {
  assert.equal(normalizeProjectNarration({ narrationVoice: "alloy" }).narrationVoice, "alloy", "别名可提交");
  assert.equal(
    normalizeProjectNarration({ narrationVoice: "FunAudioLLM/CosyVoice2-0.5B:alex" }).narrationVoice,
    "FunAudioLLM/CosyVoice2-0.5B:alex",
  );
  assert.equal(normalizeProjectNarration({ narrationVoice: "某个自由字串" }).narrationVoice, undefined);
  // 前后空白照清（回 trim 后的原值）。
  assert.equal(normalizeProjectNarration({ narrationVoice: `  ${REAL_VOICE} ` }).narrationVoice, REAL_VOICE);
});

test("冲突具名回报：非解说剧绑了旁白音色＝会被忽略（不静默吞、不代用户清）", () => {
  assert.deepEqual(narrationVoiceConflicts({ scriptType: "plot", narrationVoice: REAL_VOICE }).length, 1);
  assert.deepEqual(narrationVoiceConflicts({ narrationVoice: REAL_VOICE }).length, 1, "未宣告型别也算绑了不会生效");
  assert.deepEqual(narrationVoiceConflicts({ scriptType: "monologue", narrationVoice: REAL_VOICE }), []);
  // 解说剧没绑音色不是冲突（会走上游预设），不得当错误回报。
  assert.deepEqual(narrationVoiceConflicts({ scriptType: "monologue" }), []);
  assert.deepEqual(narrationVoiceConflicts({}), []);
});

test("生效值：只有解说剧才有生效的旁白音色（给 UI/API 明示，不让呼叫端猜）", () => {
  assert.equal(effectiveNarrationVoice({ scriptType: "monologue", narrationVoice: REAL_VOICE }), REAL_VOICE);
  assert.equal(effectiveNarrationVoice({ scriptType: "monologue" }), null, "未绑＝null（＝上游预设，不假装绑了）");
  assert.equal(effectiveNarrationVoice({ scriptType: "plot", narrationVoice: REAL_VOICE }), null, "非解说剧不生效");
  assert.equal(effectiveNarrationVoice({ narrationVoice: REAL_VOICE }), null);
  assert.equal(effectiveNarrationVoice({}), null);
});

test("落盘白名单：合法值保留，非法值省略栏位（旧专案零改动）", () => {
  const base = { id: "p1", title: "t", nodes: [] };
  const kept = normalizeProject({ ...base, scriptType: "monologue", narrationVoice: REAL_VOICE });
  assert.equal(kept?.scriptType, "monologue");
  assert.equal(kept?.narrationVoice, REAL_VOICE);
  const dropped = normalizeProject({ ...base, scriptType: "commentary", narrationVoice: "x" });
  assert.equal("scriptType" in (dropped ?? {}), false, "值域外型别省略栏位");
  assert.equal("narrationVoice" in (dropped ?? {}), false, "未知音色省略栏位");
  const old = normalizeProject(base);
  assert.equal("scriptType" in (old ?? {}), false, "旧专案形状不变");
  assert.equal("narrationVoice" in (old ?? {}), false);
});

test("读取端与 agent op 清洗：两处同一把尺，非法即省略该键（不清掉用户已设的值）", () => {
  assert.equal(canvasProjectMeta({ scriptType: "monologue" }).scriptType, "monologue");
  assert.equal(canvasProjectMeta({ scriptType: "commentary" }).scriptType, undefined);
  assert.equal(canvasProjectMeta({ narrationVoice: REAL_VOICE }).narrationVoice, REAL_VOICE);

  const patch = normalizeProjectMetaPatch({ scriptType: "monologue", narrationVoice: REAL_VOICE, currentStep: 3 });
  assert.equal(patch.scriptType, "monologue");
  assert.equal(patch.narrationVoice, REAL_VOICE);
  assert.equal(patch.currentStep, 3);
  const bad = normalizeProjectMetaPatch({ scriptType: "commentary", narrationVoice: "x" });
  assert.deepEqual(Object.keys(bad), [], "非法值省略该键＝不动该栏，不整包作废");
});

test("落盘建构（toCanvasProject）与汇出/汇入都带著走（否则会静默丢设定）", () => {
  const state = fromCanvasProject({ nodes: [{ id: "n1", type: "image", metadata: {} }] });
  const built = toCanvasProject(
    { id: "p1", title: "t" },
    state,
    { x: 0, y: 0, k: 1 },
    "dots",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // 第 11、12 个位置参数（照三栏/风格先例往后追加）。
    "monologue",
    REAL_VOICE,
  );
  assert.equal(built.scriptType, "monologue");
  assert.equal(built.narrationVoice, REAL_VOICE);
  // 非法值不落盘（同一把尺）。
  const bad = toCanvasProject(
    { id: "p2", title: "t" }, state, { x: 0, y: 0, k: 1 }, "dots",
    undefined, undefined, undefined, undefined, undefined, undefined, "commentary", "不存在的音色",
  );
  assert.equal("scriptType" in bad, false);
  assert.equal("narrationVoice" in bad, false);
});