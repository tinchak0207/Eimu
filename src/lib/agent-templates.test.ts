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

// ———— 2026-08-25 工具鏈綁定：requiredTools 必須指向真實 registry，不許假裝能力 ————

import { AGENT_TOOL_DEFINITIONS } from "./agent-tool-contract.ts";
import { ECOMMERCE_TOOL_IDS } from "./ecommerce-product-adapter.ts";
import { FASHION_TOOL_IDS } from "./fashion-tryon-tools.ts";
import { NOVEL_IP_VISUAL_TOOL_IDS } from "./novel-ip-visual-tools.ts";
import { SHORTDRAMA_TOOL_IDS } from "./shortdrama-domain/index.ts";
import { ART_TOOL_DEFINITIONS } from "./art-workflows/tool-registry.ts";

const REGISTRY_IDS = new Set<string>([
  ...AGENT_TOOL_DEFINITIONS.map((tool) => tool.id),
  ...ECOMMERCE_TOOL_IDS,
  ...FASHION_TOOL_IDS,
  ...NOVEL_IP_VISUAL_TOOL_IDS,
  ...SHORTDRAMA_TOOL_IDS,
  ...ART_TOOL_DEFINITIONS.map((tool) => tool.id),
]);

test("toolchain binding: every step declares >=1 requiredTools (工业级可执行工具链)", () => {
  for (const template of AGENT_TEMPLATES) {
    assert.ok(
      template.pipeline.steps.length >= 7,
      `${template.id} 應為 >=7 步的 SOTA 流水線（實際 ${template.pipeline.steps.length}）`,
    );
    for (const step of template.pipeline.steps) {
      assert.ok(
        Array.isArray(step.requiredTools) && step.requiredTools.length >= 1,
        `${template.id} / ${step.name} 缺少 requiredTools`,
      );
    }
  }
});

test("toolchain binding: available tool ids must exist in some registry", () => {
  for (const template of AGENT_TEMPLATES) {
    for (const step of template.pipeline.steps) {
      for (const tool of step.requiredTools ?? []) {
        if (!tool.unsupported) {
          assert.ok(
            REGISTRY_IDS.has(tool.id),
            `${template.id} / ${step.name} 引用未註冊工具 ${tool.id} 且未標 unsupported`,
          );
        }
      }
    }
  }
});

test("toolchain binding: unsupported tools must not fake availability", () => {
  for (const template of AGENT_TEMPLATES) {
    for (const step of template.pipeline.steps) {
      for (const tool of step.requiredTools ?? []) {
        if (tool.unsupported) {
          // 未接上游的意圖工具必須給出 requiredCapability，讓 harness 知道缺什麼
          assert.ok(
            tool.requiredCapability !== undefined,
            `${template.id} / ${step.name} 工具 ${tool.id} 標 unsupported 但沒說明 requiredCapability`,
          );
        }
      }
    }
  }
});

test("toolchain binding: every template has >=3 gates (门禁是工業級 workflow 的硬性要求)", () => {
  for (const template of AGENT_TEMPLATES) {
    const gated = template.pipeline.steps.filter((step) => Boolean(step.gate)).length;
    assert.ok(gated >= 3, `${template.id} 門禁數 ${gated} < 3`);
  }
});

test("toolchain binding: expanded canvas cards reach industrial density (>=35)", () => {
  for (const template of AGENT_TEMPLATES) {
    let cards = 0;
    for (const step of template.pipeline.steps) {
      const deliverables = step.deliverable.split(/[+＋、;；]/).filter((part) => part.trim().length > 1);
      cards += Math.max(1, deliverables.length);
      cards += step.promptNotes.length;
      if (step.gate) cards += 1;
      cards += 1; // 每步至少一張生成卡
    }
    assert.ok(
      cards >= 35,
      `${template.id} 展開後約 ${cards} 張卡，未達工業級密度（>=35）`,
    );
  }
});
