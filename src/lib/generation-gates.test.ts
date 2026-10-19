import test from "node:test";
import assert from "node:assert/strict";

import { CORE_STYLE_PHRASES, gatesBlock, runPreGenerationGates } from "./generation-gates";
import { ASPECT_RATIO_VALUES } from "./generation-model-catalog";
import { STYLE_PRESETS } from "./prompt-enhancer";

function byId(checks: ReturnType<typeof runPreGenerationGates>, id: string) {
  const check = checks.find((entry) => entry.id === id);
  assert.ok(check, `missing gate ${id}`);
  return check;
}

const GREEN_INPUT = {
  prompt: "一只戴眼镜的橘猫坐在窗边",
  modelId: "gpt-image-2",
  aspectRatio: "1:1",
  referenceImageCount: 0,
  negativePrompt: "模糊",
  stylePresetId: "realistic",
  loraIds: [],
};

test("全绿基线：合法输入五道门全 pass，不阻断", () => {
  const checks = runPreGenerationGates(GREEN_INPUT);

  assert.deepEqual(
    checks.map((check) => [check.id, check.status]),
    [
      ["prompt_nonempty", "pass"],
      ["prompt_length", "pass"],
      ["size_legal", "pass"],
      ["negative_antonym", "pass"],
      ["lora_single", "pass"],
    ],
  );
  assert.equal(gatesBlock(checks), false);
});

test("prompt_nonempty：纯空白提示词必须真的被拦", () => {
  const checks = runPreGenerationGates({ ...GREEN_INPUT, prompt: "   \n\t  " });
  const gate = byId(checks, "prompt_nonempty");

  assert.equal(gate.status, "fail");
  assert.ok(gate.detail);
  assert.equal(gatesBlock(checks), true);
});

test("prompt_length：6001 字符必须真的被拦，6000 恰好放行", () => {
  const over = runPreGenerationGates({ ...GREEN_INPUT, prompt: "画".repeat(6001) });
  assert.equal(byId(over, "prompt_length").status, "fail");
  assert.match(byId(over, "prompt_length").detail ?? "", /6001/);
  assert.equal(gatesBlock(over), true);

  const edge = runPreGenerationGates({ ...GREEN_INPUT, prompt: "画".repeat(6000) });
  assert.equal(byId(edge, "prompt_length").status, "pass");
  assert.equal(gatesBlock(edge), false);
});

test("size_legal：格式非法的宽高比必须真的被拦，枚举值全放行", () => {
  for (const bad of ["16:10", "banana", "1:1;drop", ""]) {
    const checks = runPreGenerationGates({ ...GREEN_INPUT, aspectRatio: bad });
    const gate = byId(checks, "size_legal");
    // 空串视为「未提供」→ skip；其余非法值必须是 fail
    assert.equal(gate.status, bad === "" ? "skip" : "fail", `aspectRatio=${JSON.stringify(bad)}`);
    if (bad !== "") assert.equal(gatesBlock(checks), true);
  }

  for (const legal of ASPECT_RATIO_VALUES) {
    const checks = runPreGenerationGates({ ...GREEN_INPUT, aspectRatio: legal });
    assert.equal(byId(checks, "size_legal").status, "pass", `aspectRatio=${legal}`);
    assert.equal(gatesBlock(checks), false);
  }
});

test("negative_antonym：水彩风 preset + 负面词含「水彩」必须真的被拦", () => {
  const checks = runPreGenerationGates({
    ...GREEN_INPUT,
    stylePresetId: "watercolor",
    negativePrompt: "水彩，模糊，低画质",
  });
  const gate = byId(checks, "negative_antonym");

  assert.equal(gate.status, "fail");
  assert.match(gate.detail ?? "", /水彩/);
  assert.equal(gatesBlock(checks), true);

  // 英文核心短语同样命中（大小写不敏感）
  const englishHit = runPreGenerationGates({
    ...GREEN_INPUT,
    stylePresetId: "watercolor",
    negativePrompt: "no Watercolor please",
  });
  assert.equal(byId(englishHit, "negative_antonym").status, "fail");
});

test("negative_antonym：不可判定的组合是 skip，不是 fail（跳过≠失败）", () => {
  // 只有负面词、没有风格 preset
  assert.equal(
    byId(runPreGenerationGates({ ...GREEN_INPUT, stylePresetId: null }), "negative_antonym").status,
    "skip",
  );
  // 只有 preset、没有负面词
  assert.equal(
    byId(runPreGenerationGates({ ...GREEN_INPUT, negativePrompt: null }), "negative_antonym").status,
    "skip",
  );
  // preset = "none"
  assert.equal(
    byId(runPreGenerationGates({ ...GREEN_INPUT, stylePresetId: "none" }), "negative_antonym").status,
    "skip",
  );
  // 未知的 preset id（style-library 模板不在 v1 门范围）
  const unknown = runPreGenerationGates({ ...GREEN_INPUT, stylePresetId: "ads-automotive" });
  assert.equal(byId(unknown, "negative_antonym").status, "skip");
  assert.equal(gatesBlock(unknown), false);
});

test("lora_single：多个 LoRA 是 skip（仅记录），绝不阻断", () => {
  const checks = runPreGenerationGates({
    ...GREEN_INPUT,
    loraIds: ["123456", "789012"],
  });
  const gate = byId(checks, "lora_single");

  assert.equal(gate.status, "skip");
  assert.match(gate.detail ?? "", /slice\(0,1\)/);
  assert.equal(gatesBlock(checks), false, "skip 不是失败，多 LoRA 不能拦");
});

test("CORE_STYLE_PHRASES 恰好覆盖 STYLE_PRESETS 全部条目（数据不脱钩）", () => {
  const presetKeys = STYLE_PRESETS.map((preset) => preset.key).sort();
  const phraseKeys = Object.keys(CORE_STYLE_PHRASES).sort();

  assert.deepEqual(phraseKeys, presetKeys);
  for (const [key, phrases] of Object.entries(CORE_STYLE_PHRASES)) {
    assert.ok(phrases.length > 0, `preset ${key} 缺少核心短语`);
    for (const phrase of phrases) assert.ok(phrase.trim().length > 0);
  }
});

test("ASPECT_RATIO_VALUES 与全站 union 一一对应（无重复、15 个值）", () => {
  assert.equal(ASPECT_RATIO_VALUES.length, 15);
  assert.equal(new Set(ASPECT_RATIO_VALUES).size, 15);
});
