import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTemplate } from "@/lib/agent-templates";
import { AGENT_TEMPLATES, AGENT_TEMPLATE_DOMAIN_LABELS } from "@/lib/agent-templates";
import { templateToCanvasLayout, applyTemplateToCanvas } from "@/components/canvas-workstation/agent-template-canvas";
import { recipeTemplateToRecallConfig } from "@/lib/recipe-templates";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/** 本地 fixture：不依賴 AGENT_TEMPLATES 的即時內容（另一 agent 重寫中）。 */
function fixture(overrides: Partial<AgentTemplate> = {}): AgentTemplate {
  return {
    id: "fixture-novel-cover",
    name: "玄幻封面",
    note: "小说封面起手",
    domain: "novel",
    painPoint: "书写好了，封面拿不出手",
    initialPrompt: "帮我做一张玄幻小说封面",
    slots: {
      prompt: "国风水墨玄幻少年，负剑立于山巅",
      contextPrompt: "水墨山海背景",
      negativePrompt: "低画质、错肢",
      composition: ["主体居中偏左", "留白放标题"],
      styleTemplateId: "sai-anime",
      qualityProfile: "balanced",
    },
    ...overrides,
  };
}

// ── AgentTemplateGallery：分組渲染 / 卡即動作 / 空態（聲明級斷言，
//    與 CaseShowcase.test 同風格；props 注入設計讓組件本身無狀態可純渲染）──

test("gallery groups templates by domain with card-as-action (name + painPoint only)", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateGallery.tsx");
  const playground = read("src/components/ImagePlayground.tsx");

  // 分組標題用 AGENT_TEMPLATE_DOMAIN_LABELS，分組順序固定四領域。
  assert.match(source, /AGENT_TEMPLATE_DOMAIN_LABELS\[domain\]/);
  assert.match(source, /const DOMAIN_ORDER: AgentTemplateDomain\[\] = \["novel", "ecommerce", "shortdrama", "art"\]/);
  // 極簡原則：每卡只有 name + painPoint 兩行，點整卡觸發 onUseTemplate。
  assert.match(source, /onClick=\{\(\) => onUseTemplate\(template\)\}/);
  assert.match(source, /\{template\.name\}/);
  assert.match(source, /\{template\.painPoint\}/);
  // 不自取 AGENT_TEMPLATES（保持可測試；僅類型與領域標籤 import）、不渲染 note / initialPrompt。
  assert.doesNotMatch(source, /import \{ AGENT_TEMPLATES[,}]/);
  assert.doesNotMatch(source, /template\.note/);
  assert.doesNotMatch(source, /template\.initialPrompt/);
  // 空態是簡單提示，不是一排禁用卡。
  assert.match(source, /templates\.length === 0/);
  assert.match(source, /模板尚未就绪/);
  // 正文不小於 13px（卡片副標顯式 13px，其餘走 ios 字級 token）。
  assert.doesNotMatch(source, /text-\[1[0-2]px\]|text-\[[0-9]px\]/);
  // hover 不 layout shift：只有顏色過渡，無位移。
  assert.doesNotMatch(source, /hover:-translate|hover:scale/);
  // 無 emoji 圖示、無計數徽章。
  assert.doesNotMatch(source, /🔢|count|badge/);

  // 接線：ImagePlayground 注入 templates + onUseTemplate。
  assert.match(playground, /<AgentTemplateGallery templates=\{AGENT_TEMPLATES\} onUseTemplate=\{handleUseAgentTemplate\}/);
});

// ── agent-template-canvas：模板 → 畫布 workflow（純函式）──

test("templateToCanvasLayout spreads slots as prompt nodes wired to an image node", () => {
  const tpl = fixture();
  const { nodes, connections } = templateToCanvasLayout(tpl);

  // 每個非空槽一顆 Prompt 節點：prompt/context/negative + 2 條构图 = 5 顆，
  // 加終點生成節點 = 6 顆。
  assert.equal(nodes.length, 6);
  const promptNodes = nodes.filter((n) => n.type === "prompt");
  assert.equal(promptNodes.length, 5);
  const imageNodes = nodes.filter((n) => n.type === "image");
  assert.equal(imageNodes.length, 1);

  // 槽位文本落在 content（Prompt 節點語義：正文）。
  const contents = promptNodes.map((n) => n.metadata?.content ?? "");
  assert.ok(contents.includes("国风水墨玄幻少年，负剑立于山巅"));
  assert.ok(contents.includes("水墨山海背景"));
  assert.ok(contents.includes("低画质、错肢"));
  assert.ok(contents.includes("主体居中偏左"));

  // 全部槽位連到生成節點，沒有懸空連線。
  const image = imageNodes[0];
  assert.equal(connections.length, 5);
  assert.ok(connections.every((c) => c.toNodeId === image.id));
  assert.ok(connections.every((c) => promptNodes.some((n) => n.id === c.fromNodeId)));

  // 生成節點攜帶主 prompt + 質量檔；風格槽沒有畫布欄位（由 agent 在對話裡接手）。
  assert.equal(image.metadata?.prompt, "国风水墨玄幻少年，负剑立于山巅");
  assert.equal(image.metadata?.quality, "balanced");
  assert.equal(image.metadata?.count, 1);
});

test("templateToCanvasLayout uses the shared recipeTemplateToRecallConfig conversion", () => {
  const tpl = fixture();
  // 同一模板 → 同一 WorkflowRecallConfig：配方總線結構不另開一套。
  const config = recipeTemplateToRecallConfig(tpl);
  assert.equal(config.prompt, tpl.slots.prompt);
  assert.equal(config.contextPrompt, tpl.slots.contextPrompt);
  assert.deepEqual(config.regionalPrompts?.map((r) => r.text), tpl.slots.composition);
  // 空槽不產生節點：裁掉 composition/context/negative 後只剩 prompt 槽。
  const minimal = templateToCanvasLayout(
    fixture({ slots: { prompt: "只有主体" } }),
  );
  assert.equal(minimal.nodes.length, 2); // 1 槽 + 1 生成節點
  assert.equal(minimal.connections.length, 1);
});

test("applyTemplateToCanvas routes through addNodes and tolerates missing host", () => {
  const calls: { nodes: unknown[]; connections?: unknown[] }[] = [];
  applyTemplateToCanvas((nodes, connections) => calls.push({ nodes, connections }), fixture());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].nodes.length, 6);
  assert.equal(calls[0].connections?.length, 5);

  // host 尚未就绪（undefined）不拋錯、也不鋪節點——點卡時機早於畫布掛載的防禦。
  applyTemplateToCanvas(undefined, fixture());
  // 空槽模板也不拋錯、不鋪節點。
  const emptyCalls: unknown[][] = [];
  applyTemplateToCanvas(
    (nodes) => emptyCalls.push(nodes),
    fixture({ slots: { prompt: "" }, domain: "art" }),
  );
  assert.equal(emptyCalls.length, 0);
});

// ── 內建模板的真實資料抽查（若另一 agent 重寫導致空數組，此測跳過）──

test("built-in agent templates convert cleanly when present", () => {
  if (AGENT_TEMPLATES.length === 0) return;
  for (const tpl of AGENT_TEMPLATES) {
    assert.ok(AGENT_TEMPLATE_DOMAIN_LABELS[tpl.domain], `未知领域：${tpl.domain}`);
    assert.ok(tpl.initialPrompt.length > 0, `${tpl.id} 缺 initialPrompt`);
    const { nodes, connections } = templateToCanvasLayout(tpl);
    // 至少：主 prompt 槽 + 生成節點。
    assert.ok(nodes.length >= 2, `${tpl.id} 铺不出 workflow`);
    assert.ok(connections.length >= 1, `${tpl.id} 槽位未连线`);
  }
});
