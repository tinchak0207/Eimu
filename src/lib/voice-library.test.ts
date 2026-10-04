// 结构化语音库（P1-11／对称差 D33）——真行为断言。
//
// 独立 oracle：14 颗 edge 音色的 id／gender／清单原值**逐字抄自实查指令的输出**
// （`/opt/edge-tts/venv/bin/python -m edge_tts --list-voices` 的 zh-* 段），
// 不是从被测模组读出来的；别名 7 条逐字抄自上游 `tts-proxy.js:18-26`。
//
// 真执行器：`npx tsx --test src/lib/voice-library.test.ts`

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

/** 实查输出（zh-* 全量，14 条）：id → gender。 */
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

test("语音库逐条对得上实查清单（id 全集与 Gender 都是清单原值）", () => {
  for (const [id, gender] of Object.entries(EDGE_ORACLE)) {
    const entry = describeVoice(id);
    assert.ok(entry, `实查清单里的 ${id} 必须在语音库中可描述`);
    assert.equal(entry!.gender, gender, `${id} 的 Gender 必须是清单原值`);
    assert.equal(entry!.route, "edge");
    assert.ok(entry!.name.length > 0, "每条都要有 Name");
    assert.ok(entry!.description?.length, `${id} 的 Description 由清单原值组成，不得为空`);
    assert.ok(entry!.source.includes("edge_tts"), "每条都要记下实查来源");
  }
  // 反向：语音库里不得出现清单外的 edge 音色（避免手写想像值混进来）。
  const libraryEdgeIds = VOICE_LIBRARY.filter((v) => v.route === "edge" && !(v.id in VOICE_ALIASES)).map((v) => v.id);
  assert.deepEqual(libraryEdgeIds.slice().sort(), Object.keys(EDGE_ORACLE).sort());
});

test("Age 一律缺席：没有真源就不编造（对手 D33 的 Age 我方无来源）", () => {
  for (const voice of VOICE_LIBRARY) {
    assert.equal("age" in voice, false, `${voice.id} 不得带 age（edge-tts 清单没有这个栏位）`);
  }
});

test("别名逐字对得上上游 VOICE_ALIASES，且别名本身是可提交值", () => {
  assert.deepEqual(Object.keys(VOICE_ALIASES).sort(), ["alloy", "echo", "fable", "nova", "onyx", "shimmer", "tara"]);
  assert.equal(VOICE_ALIASES.tara, "zh-CN-XiaoxiaoNeural");
  assert.equal(VOICE_ALIASES.echo, "zh-CN-YunxiNeural");
  for (const alias of Object.keys(VOICE_ALIASES)) {
    assert.equal(isServableVoice(alias), true, `别名 ${alias} 上游接受 ⇒ 我方也不得拒收`);
    assert.ok(describeVoice(alias), `别名 ${alias} 必须有描述条目`);
  }
});

test("已知缺陷被钉住：shimmer 指向的 zh-CN-XiaoyouNeural 已不在 Microsoft 现行清单", () => {
  // 这是上游 proxy 的缺陷（不在本刀修：要改 + 部署 VPS）。本测试把它变成事实，
  // 哪天 proxy 修好了、或 Microsoft 复活该音色，这条会红，逼人回来更新事实。
  assert.equal(VOICE_ALIASES.shimmer, "zh-CN-XiaoyouNeural");
  assert.equal(describeVoice("zh-CN-XiaoyouNeural"), undefined, "不在实查清单里 ⇒ 描述不出来");
});

test("接受集 ≠ 描述集：上游按模式接受的音色可提交但描述不出来", () => {
  // 没在清单里、但形状合法的 edge 音色（上游 proxy 会照用）。
  assert.equal(isServableVoice("en-US-JennyNeural"), true);
  assert.equal(describeVoice("en-US-JennyNeural"), undefined, "没有真源 ⇒ 不描述（不是「不存在」）");
  // SF 的 <model>:<preset> 形式：有真实模型 id 才收。
  assert.equal(isServableVoice("FunAudioLLM/CosyVoice2-0.5B:alex"), true);
  assert.ok(describeVoice("FunAudioLLM/CosyVoice2-0.5B:alex"), "主路预设是我们能证实的那一颗");
  // 只带 ":" 而不像真实模型 id 的（上游会拒 → 降级 → 静默变预设）⇒ 不收。
  assert.equal(isServableVoice("foo:bar"), false);
  assert.equal(isServableVoice(":alex"), false);
});

test("未知／非法值一律 null（不再静默回退到预设音色）", () => {
  for (const bad of ["不存在的音色", "default ", "  ", "zh-CN-Xiaoxiao", 123, null, undefined, {}, []]) {
    if (bad === "default ") {
      // "default" 是未带 voice 时的既有占位值，不是音色名 ⇒ 也不在语音库里（由呼叫端自行保留该语义）。
      assert.equal(normalizeVoiceId(bad), null);
      continue;
    }
    assert.equal(normalizeVoiceId(bad), null, `${JSON.stringify(bad)} 必须被判非法`);
  }
  assert.equal(isServableVoice(""), false);
  assert.equal(isServableVoice("   "), false);
});

test("normalizeVoiceId 前后空白照清（回 trim 后的原值）", () => {
  assert.equal(normalizeVoiceId("  zh-CN-YunxiNeural  "), "zh-CN-YunxiNeural");
  assert.equal(normalizeVoiceId(" alloy "), "alloy");
});

test("ListVoices 语义：无参数全量回，且预设音色是明示常数", () => {
  const all = listVoices();
  assert.ok(all.length >= 22, `1 主路 ＋ 14 edge ＋ 7 别名（实得 ${all.length}）`);
  assert.equal(all.length, VOICE_LIBRARY.length);
  assert.equal(new Set(all.map((v) => v.id)).size, all.length, "id 必须唯一");
  assert.equal(DEFAULT_TTS_VOICE, "zh-CN-XiaoxiaoNeural", "与上游 proxy:13 的 DEFAULT_VOICE 同源");
});