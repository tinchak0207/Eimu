import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_RECIPE_TEMPLATES,
  recipeTemplateToRecallConfig,
} from "./recipe-templates.ts";
import { parseWorkflowRecallConfig } from "./workflow-recall.ts";
import { getStyleById } from "./style-library.ts";
import {
  deleteUserRecipeTemplate,
  listUserRecipeTemplates,
  saveUserRecipeTemplate,
  USER_RECIPE_TEMPLATE_LIMIT,
} from "./recipe-template-store.ts";

test("内置模板数量在 8-12 之间且 id 唯一", () => {
  assert.ok(BUILT_IN_RECIPE_TEMPLATES.length >= 8 && BUILT_IN_RECIPE_TEMPLATES.length <= 12,
    `内置模板应有 8-12 个，实际 ${BUILT_IN_RECIPE_TEMPLATES.length}`);
  const ids = new Set(BUILT_IN_RECIPE_TEMPLATES.map((template) => template.id));
  assert.equal(ids.size, BUILT_IN_RECIPE_TEMPLATES.length);
});

test("内置模板槽位齐全：名称/说明非空，六槽至少四槽有值", () => {
  for (const template of BUILT_IN_RECIPE_TEMPLATES) {
    assert.ok(template.name.trim(), `${template.id} 缺名称`);
    assert.ok(template.note.trim(), `${template.id} 缺说明`);
    assert.ok(template.slots.prompt.trim(), `${template.id} 缺画面描述槽`);
    const filled = [
      template.slots.prompt,
      template.slots.contextPrompt,
      template.slots.composition?.length,
      template.slots.negativePrompt,
      template.slots.styleTemplateId,
      template.slots.qualityProfile,
    ].filter(Boolean).length;
    assert.ok(filled >= 4, `${template.id} 槽位填充不足（${filled}/6）`);
  }
});

test("内置模板引用的风格槽都是 style-library 既有条目", () => {
  for (const template of BUILT_IN_RECIPE_TEMPLATES) {
    if (!template.slots.styleTemplateId) continue;
    assert.ok(getStyleById(template.slots.styleTemplateId),
      `${template.id} 引用了不存在的风格 ${template.slots.styleTemplateId}`);
  }
});

test("内置模板转出的配方全部通过 workflow-recall 契约校验（模板=配方，不是黑盒）", () => {
  for (const template of BUILT_IN_RECIPE_TEMPLATES) {
    const config = recipeTemplateToRecallConfig(template);
    const result = parseWorkflowRecallConfig(JSON.stringify(config));
    assert.equal(result.ok, true, `${template.id} 的配方未通过契约校验`);
    if (!result.ok) continue;
    assert.equal(result.config.prompt, template.slots.prompt);
    if (template.slots.qualityProfile) {
      assert.equal(result.config.qualityProfile, template.slots.qualityProfile);
    }
    if (template.slots.styleTemplateId) {
      assert.equal(result.config.styleTemplate, template.slots.styleTemplateId);
    }
  }
});

test("配方存储：内存兜底下建/列/删闭环与契约清洗", async () => {
  // 无 Blob 环境变量时自动落到内存兜底（node --test 下必然如此）
  const userId = 900001;

  const saved = await saveUserRecipeTemplate({
    userId,
    name: "  测试配方  ",
    config: {
      prompt: "奶油质地主体",
      contextPrompt: "棚拍",
      negativePrompt: "水印",
      copies: 99,          // 超界，应被 clamp 到 8
      imageSize: "1024x1024",
      qualityProfile: "balanced",
      modelId: "gpt-image-2",
    },
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.template.name, "测试配方");
  assert.equal(saved.template.config.copies, 8, "超界 copies 必须被契约清洗");
  assert.equal(saved.template.config.modelId, "gpt-image-2", "modelId 作为加法式扩展字段保留");

  const listed = await listUserRecipeTemplates(userId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "测试配方");

  // 同名覆盖：不新建第二条
  const again = await saveUserRecipeTemplate({ userId, name: "测试配方", config: { prompt: "更新后的配方" } });
  assert.equal(again.ok, true);
  assert.equal((await listUserRecipeTemplates(userId)).length, 1);

  // 非法输入被拒
  const badName = await saveUserRecipeTemplate({ userId, name: "   ", config: { prompt: "x" } });
  assert.equal(badName.ok, false);
  const badConfig = await saveUserRecipeTemplate({ userId, name: "空配方", config: {} });
  assert.equal(badConfig.ok, false);

  // 删除幂等
  assert.equal(await deleteUserRecipeTemplate(userId, listed[0].id), true);
  assert.equal(await deleteUserRecipeTemplate(userId, listed[0].id), false);
  assert.equal((await listUserRecipeTemplates(userId)).length, 0);
});

test("配方存储：达到上限后拒绝新建", async () => {
  const userId = 900002;
  for (let index = 0; index < USER_RECIPE_TEMPLATE_LIMIT; index += 1) {
    const saved = await saveUserRecipeTemplate({ userId, name: `配方${index}`, config: { prompt: `p${index}` } });
    assert.equal(saved.ok, true);
  }
  const overflow = await saveUserRecipeTemplate({ userId, name: "超限配方", config: { prompt: "x" } });
  assert.equal(overflow.ok, false);
  if (overflow.ok) return;
  assert.equal(overflow.code, "limit_reached");
});
