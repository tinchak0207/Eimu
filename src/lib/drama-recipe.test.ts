// 短剧配方纯逻辑测试（docs/skills/drama-recipe.md 的确定性契约）：
//   - normalizeDramaPipeline：缺段容忍且明说跳过；脏条目丢弃不拖垮整段
//   - storyboardToBatchTasks：卡 id 序锁定注入、参考图/负面词/LoRA 合并；
//     不存在或种类不符的卡 id → 该任务 needs_asset
//   - deriveDurations：台词按语速折算、动作拍 0 秒、总时长=各场求和（击穿求和正确性）
//   - deriveRequiredAssets：引用卡 id 全集升序去重
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SPEECH_RATE,
  deriveDurations,
  deriveRequiredAssets,
  normalizeDramaPipeline,
  storyboardToBatchTasks,
} from "./drama-recipe";
import type { CharacterCard } from "./character-cards";

function card(partial: Partial<CharacterCard> & { id: string }): CharacterCard {
  return {
    name: partial.id,
    kind: "character",
    prompt: "",
    references: [],
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...partial,
  };
}

function fullPipeline(): Record<string, unknown> {
  return {
    outline: {
      title: "  夜市食神  ",
      logline: "落魄大厨重夺街头之王",
      episodes: [
        { ep: 1, synopsis: " 第一集：出摊 " },
        { ep: 2, synopsis: "第二集：对决" },
        { ep: "x", synopsis: "脏集号应被丢弃" },
      ],
      assetCardIds: ["C01", "P01"],
    },
    cast: [
      { cardId: "C01", name: "老陈", appearancePrompt: "围裙大叔，锅铲不离手", voicePrompt: "沙哑低音" },
      { cardId: "", name: "无卡条目应被丢弃" },
    ],
    art: [{ cardId: "P01", name: "夜市主街", prompt: "霓虹灯牌与蒸汽", variants: ["雨夜", "黄昏"] }],
    script: {
      episode: "E01",
      scenes: [
        {
          sceneId: "S01",
          heading: "夜市主街·外",
          beats: [
            { type: "action", text: "老陈掀开锅盖，蒸汽腾起。" },
            { type: "dialogue", speaker: "老陈", text: "锅气才是灵魂。" },
          ],
        },
      ],
    },
    storyboard: {
      shots: [
        {
          shotId: "E01-01",
          prompt: "老陈在夜市主街颠勺，火焰腾起",
          characterCardIds: ["C01"],
          sceneCardIds: ["P01"],
          negativePrompt: "多手指",
          size: "1024x1024",
        },
      ],
    },
  };
}

// ─────────────────────────────────────────── normalizeDramaPipeline

test("normalizeDramaPipeline：全段有效→零跳过，字段宽松清洗（trim、脏条目丢弃）", () => {
  const result = normalizeDramaPipeline(fullPipeline());
  assert.deepEqual(result.skipped, []);
  assert.equal(result.outline?.title, "夜市食神");
  assert.equal(result.outline?.episodes.length, 2); // ep:"x" 被丢
  assert.equal(result.outline?.episodes[0].synopsis, "第一集：出摊");
  assert.equal(result.cast?.length, 1); // 空 cardId 条目被丢
  assert.equal(result.cast?.[0].cardId, "C01");
  assert.equal(result.art?.[0].variants.length, 2);
  assert.equal(result.script?.episode, "E01");
  assert.equal(result.storyboard?.shots[0].shotId, "E01-01");
});

test("normalizeDramaPipeline：缺段容忍且明说跳过（skipped 按管线顺序列出缺失段）", () => {
  const partial = fullPipeline();
  delete partial.outline;
  delete partial.storyboard;
  const result = normalizeDramaPipeline(partial);
  assert.deepEqual(result.skipped, ["outline", "storyboard"]);
  assert.equal(result.outline, null);
  assert.equal(result.storyboard, null);
  assert.ok(result.cast); // 其余段不受影响
  assert.ok(result.script);
  // 空对象 / 非对象：五段全跳过，不抛错
  assert.deepEqual(normalizeDramaPipeline({}).skipped, ["outline", "cast", "art", "script", "storyboard"]);
  assert.deepEqual(normalizeDramaPipeline("garbage").skipped, ["outline", "cast", "art", "script", "storyboard"]);
});

test("normalizeDramaPipeline：段存在但清洗后为空→同样进 skipped（明说跳过而非静默保留空段）", () => {
  const result = normalizeDramaPipeline({ cast: [{ cardId: "", name: "" }], storyboard: { shots: [] } });
  assert.deepEqual(result.skipped, ["outline", "cast", "art", "script", "storyboard"]);
  assert.equal(result.cast, null);
  assert.equal(result.storyboard, null);
});

// ─────────────────────────────────────────── deriveDurations

test("deriveDurations：默认 4 字/秒折算；动作拍 0 秒；总时长=各场求和（击穿求和正确性）", () => {
  const script = {
    episode: "E01",
    scenes: [
      {
        sceneId: "S01",
        beats: [
          { type: "dialogue", speaker: "老陈", text: "锅气才是灵魂。" }, // 7 字 → ceil(7/4)=2
          { type: "action", text: "老陈颠勺，火焰腾起。" }, // 动作拍 → 0
          { type: "dialogue", speaker: "老陈", text: "嗯。" }, // 1 字 → max(1, ceil(0.25))=1
        ],
      },
      {
        sceneId: "S02",
        beats: [{ type: "dialogue", speaker: "阿香", text: "今天天气真不错啊各位食客" }], // 12 字 → 3
      },
    ],
  };
  const report = deriveDurations(script);
  assert.ok(report);
  assert.equal(report.speechRate, DEFAULT_SPEECH_RATE);
  const s01 = report.scenes[0];
  assert.deepEqual(s01.beats.map((b) => b.seconds), [2, 0, 1]);
  assert.equal(s01.seconds, 3); // 场内求和
  assert.equal(report.scenes[1].seconds, 3);
  // 总时长 = 各场之和（不存冗余：输入里根本没有 total 字段）
  assert.equal(report.totalSeconds, report.scenes.reduce((sum, s) => sum + s.seconds, 0));
  assert.equal(report.totalSeconds, 6);
});

test("deriveDurations：语速参数可覆盖（2 字/秒），最短 1 秒兜底", () => {
  const script = {
    scenes: [
      {
        sceneId: "S01",
        beats: [
          { type: "dialogue", speaker: "A", text: "你好" }, // 2 字 @2字/秒 → 1
          { type: "dialogue", speaker: "B", text: "一二三四五" }, // 5 字 → ceil(2.5)=3
        ],
      },
    ],
  };
  const report = deriveDurations(script, { speechRate: 2 });
  assert.ok(report);
  assert.equal(report.speechRate, 2);
  assert.deepEqual(report.scenes[0].beats.map((b) => b.seconds), [1, 3]);
  assert.equal(report.totalSeconds, 4);
  // 非法语速（0/负数）回退默认，不除零
  const fallback = deriveDurations(script, { speechRate: 0 });
  assert.equal(fallback?.speechRate, DEFAULT_SPEECH_RATE);
});

test("deriveDurations：无有效场次 → null（调用方决定降级），不抛错", () => {
  assert.equal(deriveDurations({}), null);
  assert.equal(deriveDurations({ scenes: [{ sceneId: "S01", beats: [] }] }), null);
});

// ─────────────────────────────────────────── storyboardToBatchTasks

test("storyboardToBatchTasks：每分镜一任务；prompt=卡 id 序锁定片段前缀+段提示词；参考图/负面词/LoRA 合并", () => {
  const c01 = card({
    id: "C01",
    kind: "character",
    name: "老陈",
    prompt: "围裙大叔，锅铲不离手",
    references: [{ url: "https://img.example/c01.png", role: "character", name: "老陈设定图" }],
    negativePrompt: "多手指",
    loraIds: ["lora-x"],
  });
  const p01 = card({
    id: "P01",
    kind: "scene",
    name: "夜市主街",
    prompt: "霓虹灯牌与蒸汽",
    references: [{ url: "https://img.example/p01.png", role: "scene", name: "夜市设定图" }],
    negativePrompt: "模糊",
    loraIds: ["lora-x", "lora-y"],
  });
  const storyboard = {
    shots: [
      {
        shotId: "E01-01",
        prompt: "老陈颠勺，火焰腾起",
        characterCardIds: ["C01"],
        sceneCardIds: ["P01"], // 注入顺序由 applyCharacterCards 按卡 id 升序决定，与传入顺序无关
        negativePrompt: "文字扭曲",
      },
    ],
  };
  const tasks = storyboardToBatchTasks(storyboard, [p01, c01]);
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.equal(task.needsAsset, false);
  assert.deepEqual(task.missingCardIds, []);
  // 卡 id 序（C01 < P01）稳定拼接，与传入顺序无关
  assert.equal(task.prompt, "围裙大叔，锅铲不离手\n霓虹灯牌与蒸汽\n老陈颠勺，火焰腾起");
  // 参考图：两张卡的 references 合并
  assert.equal(task.referenceImages.length, 2);
  assert.equal(task.referenceImages[0].url, "https://img.example/c01.png");
  // 负面词：段级 + 卡级合并去重
  assert.equal(task.negativePrompt, "文字扭曲, 多手指, 模糊");
  // LoRA 合并去重（generate_image 装配时仍受单选铁律 slice(0,1) 约束）
  assert.deepEqual(task.loraIds, ["lora-x", "lora-y"]);
});

test("storyboardToBatchTasks：击穿——引用不存在的卡 id → 该任务 needs_asset + missingCardIds；已解析卡照常注入", () => {
  const c01 = card({ id: "C01", kind: "character", prompt: "围裙大叔" });
  const storyboard = {
    shots: [
      { shotId: "SB-01", prompt: "夜市全景", characterCardIds: ["C01", "C99"], sceneCardIds: ["P77"] },
    ],
  };
  const tasks = storyboardToBatchTasks(storyboard, [c01]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].needsAsset, true);
  assert.deepEqual(tasks[0].missingCardIds, ["C99", "P77"]);
  // 部分解析不回退：C01 的锁定片段仍注入
  assert.equal(tasks[0].prompt, "围裙大叔\n夜市全景");
  // 需要资产的零任务也允许（空分镜段 → 空数组，不抛错）
  assert.deepEqual(storyboardToBatchTasks({ shots: [] }, [c01]), []);
});

test("storyboardToBatchTasks：击穿——卡 id 存在但种类不符（角色引用指向 scene 卡）→ 同样 needs_asset，不静默替换", () => {
  const p01 = card({ id: "P01", kind: "scene", prompt: "夜市主街" });
  const storyboard = {
    shots: [{ shotId: "SB-01", prompt: "主角特写", characterCardIds: ["P01"], sceneCardIds: [] }],
  };
  const tasks = storyboardToBatchTasks(storyboard, [p01]);
  assert.equal(tasks[0].needsAsset, true);
  assert.deepEqual(tasks[0].missingCardIds, ["P01"]);
  // 种类不符的卡不注入 prompt
  assert.equal(tasks[0].prompt, "主角特写");
});

// ─────────────────────────────────────────── deriveRequiredAssets

test("deriveRequiredAssets：引用卡 id 全集升序去重（资产清单由代码推导）", () => {
  const storyboard = {
    shots: [
      { shotId: "SB-01", prompt: "a", characterCardIds: ["C02", "C01"], sceneCardIds: ["P02"] },
      { shotId: "SB-02", prompt: "b", characterCardIds: ["C01"], sceneCardIds: ["P01", "P02"] },
    ],
  };
  assert.deepEqual(deriveRequiredAssets(storyboard), ["C01", "C02", "P01", "P02"]);
  assert.deepEqual(deriveRequiredAssets({ shots: [] }), []);
  assert.deepEqual(deriveRequiredAssets("garbage"), []);
});
