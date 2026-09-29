// 解說劇型別與旁白音色（P1-5／對稱差 D7）——真行為斷言。
//
// 獨立 oracle：型別值域**逐字抄自 AID `ScriptTypeEnum`**
// （`src/lib/aid-enums/creation.ts:122-127` 的 `AID_SCRIPT_TYPE_ENUM`，該檔逐字轉錄自
// `aid-interface/…/enums/ScriptTypeEnum.java`）；音色值域取真語音庫裡的真實 id。
//
// 真執行器：`npx tsx --test src/lib/canvas/project-narration.test.ts`

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

/** AID `ScriptTypeEnum` 的值集合（逐字；鍵序＝AID 宣告序）。 */
const AID_ORACLE = [
  { value: "plot", desc: "剧情演绎" },
  { value: "monologue", desc: "真人解说漫" },
];
const REAL_VOICE = VOICE_LIBRARY.find((v) => v.id === "zh-CN-YunxiNeural")!.id;

test("型別值域逐字對齊 AID ScriptTypeEnum（不另立詞表），解說劇＝monologue", () => {
  assert.deepEqual([...CANVAS_SCRIPT_TYPES], AID_ORACLE.map((m) => m.value));
  assert.equal(COMMENTARY_SCRIPT_TYPE, "monologue");
  // 標籤＝AID desc 原字（未改寫、未簡繁轉換）。
  for (const m of AID_ORACLE) {
    assert.equal(CANVAS_SCRIPT_TYPE_LABELS[m.value as keyof typeof CANVAS_SCRIPT_TYPE_LABELS], m.desc);
  }
  assert.equal(isCommentaryScriptType("monologue"), true);
  assert.equal(isCommentaryScriptType("plot"), false);
});

test("判據：只認值域內的字串，其餘（含 AID 其他 enum 的值）一律不認", () => {
  assert.equal(isCanvasScriptType("plot"), true);
  assert.equal(isCanvasScriptType("monologue"), true);
  for (const bad of ["commentary", "short_drama", "series", "movie", "", "  ", 0, null, undefined, {}, []]) {
    assert.equal(isCanvasScriptType(bad), false, `${JSON.stringify(bad)} 不得被認成劇本型別`);
  }
});

test("清洗：逐欄獨立、非法省略該鍵（不整包作廢、不寫假值）", () => {
  // 型別非法但音色合法 ⇒ 只丟型別那一個鍵。
  assert.deepEqual(normalizeProjectNarration({ scriptType: "不存在的型別", narrationVoice: REAL_VOICE }), {
    narrationVoice: REAL_VOICE,
  });
  // 音色未知（語音庫同一把尺）⇒ 只丟音色那一個鍵。
  assert.deepEqual(normalizeProjectNarration({ scriptType: "monologue", narrationVoice: "不存在的音色" }), {
    scriptType: "monologue",
  });
  // 合法 ⇒ 兩欄都留；空物件 ⇒ 不冒鍵（缺欄＝未宣告）。
  assert.deepEqual(normalizeProjectNarration({ scriptType: "plot", narrationVoice: REAL_VOICE }), {
    scriptType: "plot",
    narrationVoice: REAL_VOICE,
  });
  assert.deepEqual(normalizeProjectNarration({}), {});
  assert.deepEqual(Object.keys(normalizeProjectNarration({ scriptType: "monologue" })), ["scriptType"]);
});

test("音色值域＝語音庫同一把尺：別名與 SF 形式也收，自由字串不收", () => {
  assert.equal(normalizeProjectNarration({ narrationVoice: "alloy" }).narrationVoice, "alloy", "別名可提交");
  assert.equal(
    normalizeProjectNarration({ narrationVoice: "FunAudioLLM/CosyVoice2-0.5B:alex" }).narrationVoice,
    "FunAudioLLM/CosyVoice2-0.5B:alex",
  );
  assert.equal(normalizeProjectNarration({ narrationVoice: "某个自由字串" }).narrationVoice, undefined);
  // 前後空白照清（回 trim 後的原值）。
  assert.equal(normalizeProjectNarration({ narrationVoice: `  ${REAL_VOICE} ` }).narrationVoice, REAL_VOICE);
});

test("衝突具名回報：非解說劇綁了旁白音色＝會被忽略（不靜默吞、不代用戶清）", () => {
  assert.deepEqual(narrationVoiceConflicts({ scriptType: "plot", narrationVoice: REAL_VOICE }).length, 1);
  assert.deepEqual(narrationVoiceConflicts({ narrationVoice: REAL_VOICE }).length, 1, "未宣告型別也算綁了不會生效");
  assert.deepEqual(narrationVoiceConflicts({ scriptType: "monologue", narrationVoice: REAL_VOICE }), []);
  // 解說劇沒綁音色不是衝突（會走上游預設），不得當錯誤回報。
  assert.deepEqual(narrationVoiceConflicts({ scriptType: "monologue" }), []);
  assert.deepEqual(narrationVoiceConflicts({}), []);
});

test("生效值：只有解說劇才有生效的旁白音色（給 UI/API 明示，不讓呼叫端猜）", () => {
  assert.equal(effectiveNarrationVoice({ scriptType: "monologue", narrationVoice: REAL_VOICE }), REAL_VOICE);
  assert.equal(effectiveNarrationVoice({ scriptType: "monologue" }), null, "未綁＝null（＝上游預設，不假裝綁了）");
  assert.equal(effectiveNarrationVoice({ scriptType: "plot", narrationVoice: REAL_VOICE }), null, "非解說劇不生效");
  assert.equal(effectiveNarrationVoice({ narrationVoice: REAL_VOICE }), null);
  assert.equal(effectiveNarrationVoice({}), null);
});

test("落盤白名單：合法值保留，非法值省略欄位（舊專案零改動）", () => {
  const base = { id: "p1", title: "t", nodes: [] };
  const kept = normalizeProject({ ...base, scriptType: "monologue", narrationVoice: REAL_VOICE });
  assert.equal(kept?.scriptType, "monologue");
  assert.equal(kept?.narrationVoice, REAL_VOICE);
  const dropped = normalizeProject({ ...base, scriptType: "commentary", narrationVoice: "x" });
  assert.equal("scriptType" in (dropped ?? {}), false, "值域外型別省略欄位");
  assert.equal("narrationVoice" in (dropped ?? {}), false, "未知音色省略欄位");
  const old = normalizeProject(base);
  assert.equal("scriptType" in (old ?? {}), false, "舊專案形狀不變");
  assert.equal("narrationVoice" in (old ?? {}), false);
});

test("讀取端與 agent op 清洗：兩處同一把尺，非法即省略該鍵（不清掉用戶已設的值）", () => {
  assert.equal(canvasProjectMeta({ scriptType: "monologue" }).scriptType, "monologue");
  assert.equal(canvasProjectMeta({ scriptType: "commentary" }).scriptType, undefined);
  assert.equal(canvasProjectMeta({ narrationVoice: REAL_VOICE }).narrationVoice, REAL_VOICE);

  const patch = normalizeProjectMetaPatch({ scriptType: "monologue", narrationVoice: REAL_VOICE, currentStep: 3 });
  assert.equal(patch.scriptType, "monologue");
  assert.equal(patch.narrationVoice, REAL_VOICE);
  assert.equal(patch.currentStep, 3);
  const bad = normalizeProjectMetaPatch({ scriptType: "commentary", narrationVoice: "x" });
  assert.deepEqual(Object.keys(bad), [], "非法值省略該鍵＝不動該欄，不整包作廢");
});

test("落盤建構（toCanvasProject）與匯出/匯入都帶著走（否則會靜默丟設定）", () => {
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
    // 第 11、12 個位置參數（照三欄/風格先例往後追加）。
    "monologue",
    REAL_VOICE,
  );
  assert.equal(built.scriptType, "monologue");
  assert.equal(built.narrationVoice, REAL_VOICE);
  // 非法值不落盤（同一把尺）。
  const bad = toCanvasProject(
    { id: "p2", title: "t" }, state, { x: 0, y: 0, k: 1 }, "dots",
    undefined, undefined, undefined, undefined, undefined, undefined, "commentary", "不存在的音色",
  );
  assert.equal("scriptType" in bad, false);
  assert.equal("narrationVoice" in bad, false);
});