import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TEMPLATES, AGENT_TEMPLATE_DOMAIN_LABELS } from "@/lib/agent-templates";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("carousel renders every template card with name, pain point, domain label and pipeline summary", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  const data = read("src/lib/agent-templates.ts");

  for (const template of AGENT_TEMPLATES) {
    assert.ok(
      data.includes(template.name),
      `模板数据应包含卡片名「${template.name}」（卡名由 templates.map 渲染）`,
    );
  }
  // 结构契约：每张卡渲染 name / painPoint / 领域标签 / pipeline 摘要。
  assert.match(source, /atc-name">\{template\.name\}/);
  assert.match(source, /atc-pain">\{template\.painPoint\}/);
  assert.match(source, /AGENT_TEMPLATE_DOMAIN_LABELS\[template\.domain\]/);
  assert.match(source, /pipelineSummary/);
  assert.match(source, /道门禁/);
  // 领域标签映射覆盖全部领域。
  for (const label of Object.values(AGENT_TEMPLATE_DOMAIN_LABELS)) {
    assert.match(data, new RegExp(`${label}`));
  }
  // 8 张卡全部进入轮播数据源。
  assert.ok(AGENT_TEMPLATES.length >= 8, `内置模板应不少于 8 张，实际 ${AGENT_TEMPLATES.length}`);
});

test("only the front card activates a template; side cards rotate instead", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");

  // 正面卡：触发 onUseTemplate；非正面卡：转到正面。拖过的手势不算点击。
  assert.match(source, /if \(index === front\) \{\s*\n\s*onUseTemplate\(templates\[front\]\);/);
  assert.match(source, /if \(movedRef\.current \|\| draggingRef\.current\) return;/);
  assert.match(source, /goTo\(index\);/);
});

test("empty templates render a safe empty state without the ring", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");

  assert.match(source, /templates\.length === 0/);
  assert.match(source, /atc-empty/);
});

test("carousel reuses the homepage case-showcase CSS and physics", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  const css = read("src/components/canvas-workstation/agent-template-carousel.css");

  // 共享類：不複製 537 行 CSS，直接 import 首頁樣式。
  assert.match(source, /import "\.\.\/case-showcase\.css"/);
  // 類結構與首頁一致：frame > stage > glow + slab(side-l/r + face(edge + surface))。
  assert.match(source, /className="atc-frame"/);
  assert.match(source, /className="case-stage atc-stage"/);
  assert.match(source, /className="case-glow"/);
  assert.match(source, /case-side case-side-l/);
  assert.match(source, /case-side case-side-r/);
  assert.match(source, /case-face/);
  // 物理復用：detent 磁力 + flick 落格 + 鍵盤導航。
  assert.match(source, /commitSteps/);
  assert.match(source, /detent\(/);
  assert.match(source, /undetent\(/);
  assert.match(source, /"ArrowRight"/);
  assert.match(source, /"ArrowLeft"/);
  // 無 WebGL 依賴（無圖可餵）。
  assert.doesNotMatch(source, /CaseGlassWebGL/);
  // 面板場景縮小卡片尺寸變數。
  assert.match(css, /--case-card-w: 300px/);
});

test("card layer stack matches the homepage: edge + surface(sheen/rim) must exist", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  const css = read("src/components/canvas-workstation/agent-template-carousel.css");

  // 質感層棧完整性鎖死：光照四件套（掠射亮線 + sheen 掃光 + 左右棱線）
  // 全部由這幾層消費，砍層 = 手搓卡，直接紅。
  assert.match(source, /<div className="case-edge" aria-hidden="true" \/>/);
  assert.match(source, /<div className="case-surface" aria-hidden="true">/);
  assert.match(source, /<div className="case-sheen" \/>/);
  assert.match(source, /<div className="case-rim case-rim-l" \/>/);
  assert.match(source, /<div className="case-rim case-rim-r" \/>/);
  // 文字層不吞指針：點擊/拖拽由 slab 承接。
  assert.match(css, /\.atc-media \{[^}]*pointer-events: none/s);
  // 置中外殼：宿主 overlay 非 flex 容器，frame 負責鋪滿 + 垂直置中。
  assert.match(css, /\.atc-frame \{[^}]*position: absolute[^}]*align-items: center[^}]*justify-content: center/s);
});

test("playground wires the carousel in place of the old gallery", () => {
  const playground = read("src/components/ImagePlayground.tsx");
  assert.match(playground, /import \{ AgentTemplateCarousel \} from "@\/components\/canvas-workstation\/AgentTemplateCarousel"/);
  assert.match(playground, /<AgentTemplateCarousel templates=\{AGENT_TEMPLATES\} onUseTemplate=\{handleUseAgentTemplate\} \/>/);
});
