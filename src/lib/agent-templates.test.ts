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

test("agent templates cover four domains with three cards each", () => {
  assert.equal(AGENT_TEMPLATES.length, 12);
  for (const domain of DOMAINS) {
    assert.equal(
      AGENT_TEMPLATES.filter((t) => t.domain === domain).length,
      3,
      `domain ${domain} should have exactly 3 templates`,
    );
  }
});

test("ids are unique and follow agent-<domain>-<slug> naming", () => {
  const ids = AGENT_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const template of AGENT_TEMPLATES) {
    assert.match(template.id, new RegExp(`^agent-${template.domain}-[a-z][a-z0-9-]*$`));
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
