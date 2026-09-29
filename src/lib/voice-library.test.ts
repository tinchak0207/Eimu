// 結構化語音庫（P1-11／對稱差 D33）——真行為斷言。
//
// 獨立 oracle：14 顆 edge 音色的 id／gender／清單原值**逐字抄自實查指令的輸出**
// （`/opt/edge-tts/venv/bin/python -m edge_tts --list-voices` 的 zh-* 段），
// 不是從被測模組讀出來的；別名 7 條逐字抄自上游 `tts-proxy.js:18-26`。
//
// 真執行器：`npx tsx --test src/lib/voice-library.test.ts`

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TTS_VOICE,
  VOICE_ALIASES,
  VOICE_LIBRARY,
  describeVoice,
  isServableVoice,
  listVoices,
  normalizeVoiceId,
} from "./voice-library";

/** 實查輸出（zh-* 全量，14 條）：id → gender。 */
const EDGE_ORACLE: Record<string, "female" | "male"> = {
  "zh-CN-XiaoxiaoNeural": "female",
  "zh-CN-XiaoyiNeural": "female",
  "zh-CN-YunjianNeural": "male",
  "zh-CN-YunxiNeural": "male",
  "zh-CN-YunxiaNeural": "male",
  "zh-CN-YunyangNeural": "male",
  "zh-CN-liaoning-XiaobeiNeural": "female",
  "zh-CN-shaanxi-XiaoniNeural": "female",
  "zh-HK-HiuGaaiNeural": "female",
  "zh-HK-HiuMaanNeural": "female",
  "zh-HK-WanLungNeural": "male",
  "zh-TW-HsiaoChenNeural": "female",
  "zh-TW-HsiaoYuNeural": "female",
  "zh-TW-YunJheNeural": "male",
};

test("語音庫逐條對得上實查清單（id 全集與 Gender 都是清單原值）", () => {
  for (const [id, gender] of Object.entries(EDGE_ORACLE)) {
    const entry = describeVoice(id);
    assert.ok(entry, `實查清單裡的 ${id} 必須在語音庫中可描述`);
    assert.equal(entry!.gender, gender, `${id} 的 Gender 必須是清單原值`);
    assert.equal(entry!.route, "edge");
    assert.ok(entry!.name.length > 0, "每條都要有 Name");
    assert.ok(entry!.description?.length, `${id} 的 Description 由清單原值組成，不得為空`);
    assert.ok(entry!.source.includes("edge_tts"), "每條都要記下實查來源");
  }
  // 反向：語音庫裡不得出現清單外的 edge 音色（避免手寫想像值混進來）。
  const libraryEdgeIds = VOICE_LIBRARY.filter((v) => v.route === "edge" && !(v.id in VOICE_ALIASES)).map((v) => v.id);
  assert.deepEqual(libraryEdgeIds.slice().sort(), Object.keys(EDGE_ORACLE).sort());
});

test("Age 一律缺席：沒有真源就不編造（對手 D33 的 Age 我方無來源）", () => {
  for (const voice of VOICE_LIBRARY) {
    assert.equal("age" in voice, false, `${voice.id} 不得帶 age（edge-tts 清單沒有這個欄位）`);
  }
});

test("別名逐字對得上上游 VOICE_ALIASES，且別名本身是可提交值", () => {
  assert.deepEqual(Object.keys(VOICE_ALIASES).sort(), ["alloy", "echo", "fable", "nova", "onyx", "shimmer", "tara"]);
  assert.equal(VOICE_ALIASES.tara, "zh-CN-XiaoxiaoNeural");
  assert.equal(VOICE_ALIASES.echo, "zh-CN-YunxiNeural");
  for (const alias of Object.keys(VOICE_ALIASES)) {
    assert.equal(isServableVoice(alias), true, `別名 ${alias} 上游接受 ⇒ 我方也不得拒收`);
    assert.ok(describeVoice(alias), `別名 ${alias} 必須有描述條目`);
  }
});

test("已知缺陷被釘住：shimmer 指向的 zh-CN-XiaoyouNeural 已不在 Microsoft 現行清單", () => {
  // 這是上游 proxy 的缺陷（不在本刀修：要改 + 部署 VPS）。本測試把它變成事實，
  // 哪天 proxy 修好了、或 Microsoft 復活該音色，這條會紅，逼人回來更新事實。
  assert.equal(VOICE_ALIASES.shimmer, "zh-CN-XiaoyouNeural");
  assert.equal(describeVoice("zh-CN-XiaoyouNeural"), undefined, "不在實查清單裡 ⇒ 描述不出來");
});

test("接受集 ≠ 描述集：上游按模式接受的音色可提交但描述不出來", () => {
  // 沒在清單裡、但形狀合法的 edge 音色（上游 proxy 會照用）。
  assert.equal(isServableVoice("en-US-JennyNeural"), true);
  assert.equal(describeVoice("en-US-JennyNeural"), undefined, "沒有真源 ⇒ 不描述（不是「不存在」）");
  // SF 的 <model>:<preset> 形式：有真實模型 id 才收。
  assert.equal(isServableVoice("FunAudioLLM/CosyVoice2-0.5B:alex"), true);
  assert.ok(describeVoice("FunAudioLLM/CosyVoice2-0.5B:alex"), "主路預設是我們能證實的那一顆");
  // 只帶 ":" 而不像真實模型 id 的（上游會拒 → 降級 → 靜默變預設）⇒ 不收。
  assert.equal(isServableVoice("foo:bar"), false);
  assert.equal(isServableVoice(":alex"), false);
});

test("未知／非法值一律 null（不再靜默回退到預設音色）", () => {
  for (const bad of ["不存在的音色", "default ", "  ", "zh-CN-Xiaoxiao", 123, null, undefined, {}, []]) {
    if (bad === "default ") {
      // "default" 是未帶 voice 時的既有佔位值，不是音色名 ⇒ 也不在語音庫裡（由呼叫端自行保留該語義）。
      assert.equal(normalizeVoiceId(bad), null);
      continue;
    }
    assert.equal(normalizeVoiceId(bad), null, `${JSON.stringify(bad)} 必須被判非法`);
  }
  assert.equal(isServableVoice(""), false);
  assert.equal(isServableVoice("   "), false);
});

test("normalizeVoiceId 前後空白照清（回 trim 後的原值）", () => {
  assert.equal(normalizeVoiceId("  zh-CN-YunxiNeural  "), "zh-CN-YunxiNeural");
  assert.equal(normalizeVoiceId(" alloy "), "alloy");
});

test("ListVoices 語義：無參數全量回，且預設音色是明示常數", () => {
  const all = listVoices();
  assert.ok(all.length >= 22, `1 主路 ＋ 14 edge ＋ 7 別名（實得 ${all.length}）`);
  assert.equal(all.length, VOICE_LIBRARY.length);
  assert.equal(new Set(all.map((v) => v.id)).size, all.length, "id 必須唯一");
  assert.equal(DEFAULT_TTS_VOICE, "zh-CN-XiaoxiaoNeural", "與上游 proxy:13 的 DEFAULT_VOICE 同源");
});