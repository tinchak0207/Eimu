import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_TEMPLATES,
  AGENT_TEMPLATE_DOMAIN_LABELS,
  type AgentTemplateDomain,
} from "./agent-templates.ts";
import { recipeTemplateToRecallConfig } from "./recipe-templates.ts";
import { getStyleById } from "./style-library.ts";

const DOMAINS: AgentTemplateDomain[] = ["novel", "ecommerce", "shortdrama", "art"];
const QUALITY_PROFILES = ["draft", "balanced", "print"];

test("agent templates cover four domains with two pipeline blueprints each", () => {
  assert.equal(AGENT_TEMPLATES.length, 8);
  for (const domain of DOMAINS) {
    assert.equal(
      AGENT_TEMPLATES.filter((t) => t.domain === domain).length,
      2,
      `domain ${domain} should have exactly 2 templates`,
    );
  }
});

test("pipeline structure is complete: >=4 steps, deliverable + inputFrom + notes, gates present", () => {
  for (const template of AGENT_TEMPLATES) {
    const { pipeline } = template;
    assert.ok(pipeline.summary.length > 10, `${template.id} pipeline summary`);
    assert.ok(
      pipeline.steps.length >= 4,
      `${template.id} pipeline steps ${pipeline.steps.length} < 4`,
    );
    let gatedSteps = 0;
    for (const step of pipeline.steps) {
      assert.ok(step.name.length > 2, `${template.id} step name`);
      assert.ok(step.deliverable.length > 6, `${template.id} ${step.name} deliverable`);
      assert.ok(step.inputFrom.length > 6, `${template.id} ${step.name} inputFrom`);
      assert.ok(
        step.promptNotes.length >= 2 && step.promptNotes.every((n) => n.length > 6),
        `${template.id} ${step.name} promptNotes`,
      );
      if (step.gate !== undefined) {
        assert.ok(step.gate.length > 6, `${template.id} ${step.name} gate`);
        gatedSteps += 1;
      }
    }
    assert.ok(gatedSteps >= 2, `${template.id} pipeline should have >=2 gated steps`);
    // 衔接关系存在：至少一半步骤显式声明上一步产出如何喂入
    const linked = pipeline.steps.filter((s) => /JSON|cref|sref|参考|注入|锚|门禁|批准|锁定|源图|对拍|seed/i.test(s.inputFrom));
    assert.ok(
      linked.length >= Math.ceil(pipeline.steps.length / 2),
      `${template.id} pipeline inputFrom linkage too weak`,
    );
  }
});

test("card copy is present and within reasonable length", () => {
  for (const template of AGENT_TEMPLATES) {
    assert.ok(template.name.length >= 3 && template.name.length <= 6, `${template.id} name length`);
    assert.ok(template.note.length > 6, `${template.id} note`);
    assert.ok(template.painPoint.length > 6, `${template.id} painPoint`);
    assert.ok(
      template.initialPrompt.length >= 30 && template.initialPrompt.length <= 80,
      `${template.id} initialPrompt length ${template.initialPrompt.length}`,
    );
    // 卡面海報區漸變（2026-08-25 視覺主體）：8 張都必須有 Tailwind 三色類。
    assert.match(template.accent, /^from-\[#/, `${template.id} accent gradient class`);
    assert.match(template.accent, /via-\[#/);
    assert.match(template.accent, /to-\[#/);
  }
});

test("ids are unique and follow agent-<domain>-<slug> naming", () => {
  const ids = AGENT_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const template of AGENT_TEMPLATES) {
    assert.match(template.id, new RegExp(`^agent-${template.domain}-[a-z][a-z0-9-]*$`));
  }
});

test("every template converts to a recall config with non-empty prompt", () => {
  for (const template of AGENT_TEMPLATES) {
    const config = recipeTemplateToRecallConfig(template);
    assert.ok(config.prompt.length > 10, `${template.id} prompt`);
    if (template.slots.contextPrompt) assert.equal(config.contextPrompt, template.slots.contextPrompt);
    if (template.slots.negativePrompt) assert.equal(config.negativePrompt, template.slots.negativePrompt);
    if (template.slots.composition?.length) {
      assert.deepEqual(
        config.regionalPrompts?.map((item) => item.text),
        template.slots.composition,
      );
    }
    if (template.slots.styleTemplateId) {
      assert.equal(config.styleTemplate, template.slots.styleTemplateId);
    }
    if (template.slots.qualityProfile) {
      assert.equal(config.qualityProfile, template.slots.qualityProfile);
    }
  }
});

test("styleTemplateId references existing style-library entries and qualityProfile is valid", () => {
  for (const template of AGENT_TEMPLATES) {
    if (template.slots.styleTemplateId) {
      assert.ok(
        getStyleById(template.slots.styleTemplateId),
        `${template.id} styleTemplateId ${template.slots.styleTemplateId} not in style-library`,
      );
    }
    if (template.slots.qualityProfile) {
      assert.ok(
        QUALITY_PROFILES.includes(template.slots.qualityProfile),
        `${template.id} qualityProfile ${template.slots.qualityProfile}`,
      );
    }
  }
});

test("domain labels cover all domains used by templates", () => {
  assert.deepEqual([...DOMAINS], Object.keys(AGENT_TEMPLATE_DOMAIN_LABELS));
  assert.deepEqual(
    new Set(AGENT_TEMPLATES.map((t) => t.domain)),
    new Set(DOMAINS),
  );
});
