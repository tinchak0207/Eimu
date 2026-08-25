import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TEMPLATES, AGENT_TEMPLATE_DOMAIN_LABELS } from "@/lib/agent-templates";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/**
 * AgentTemplateCarousel 是 CaseShowcase.tsx 的逐行複製（2026-08-25 用戶裁定：
 * 複用 = 整複製改文字，禁止造輪子）。測試鎖死兩件事：
 * ① 與首頁的交互能力逐項等價（wheel passive:false / scroll drive / detent /
 *    commitSteps / 彈簧 / 鍵盤 / 圓點 / 箭頭 / CasePromptReveal / 層棧）；
 * ② 模板化改動（數據源 / 卡面文字 / 正面卡啟動）接線正確。
 */

test("carousel is a verbatim copy of CaseShowcase interaction machinery", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");

  // 觸控板兩指橫掃：{ passive: false } 手動掛載（React onWheel 是 passive，
  // preventDefault 會被忽略）——2026-08-25 事故的直接雷點，鎖死。
  assert.match(source, /addEventListener\("wheel", onWheel, \{ passive: false \}\)/);
  assert.match(source, /Math\.abs\(event\.deltaX\) <= Math\.abs\(event\.deltaY\)/);

  // 滾動驅動 + IntersectionObserver 只在段內累計。
  assert.match(source, /window\.addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
  assert.match(source, /IntersectionObserver/);

  // 磁力與落格：detent/undetent/commitSteps 三件套 + 三角度 refs。
  assert.match(source, /detent\(rawRef\.current, STEP\)/);
  assert.match(source, /undetent\(angleRef\.current, STEP\)/);
  assert.match(source, /commitSteps\(travel, flickSteps\)/);

  // 二階彈簧雙檔位（跟隨/落格）+ dt 積分。
  assert.match(source, /SPRING_TRACK/);
  assert.match(source, /SPRING_SETTLE/);
  assert.match(source, /MAX_DT/);

  // 鍵盤導航 + 圓點 + 箭頭。
  assert.match(source, /"ArrowRight"/);
  assert.match(source, /"ArrowLeft"/);
  assert.match(source, /case-dot/);
  assert.match(source, /case-arrow/);

  // 材質層棧：光照四件套的消費層一個不少。
  assert.match(source, /<div className="case-edge" aria-hidden="true" \/>/);
  assert.match(source, /<div className="case-surface" aria-hidden="true">/);
  assert.match(source, /<div className="case-sheen" \/>/);
  assert.match(source, /<div className="case-rim case-rim-l" \/>/);
  assert.match(source, /<div className="case-rim case-rim-r" \/>/);

  // 共享 CSS（禁止另起爐灶）。
  assert.match(source, /import "\.\.\/case-showcase\.css"/);
  // 共享物理庫。
  assert.match(source, /from "@\/lib\/carousel-detent"/);
});

test("carousel renders template cards with poster watermark and pipeline flow", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  const data = read("src/lib/agent-templates.ts");

  for (const template of AGENT_TEMPLATES) {
    assert.ok(data.includes(template.name), `模板数据应包含卡片名「${template.name}」`);
  }
  // 卡面：領域漸變海報 + 大字水印 + 步驟鏈（複製版的 case-photo 內容換成模板版）。
  assert.match(source, /bg-gradient-to-br", item\.accent/);
  assert.match(source, /atc-watermark/);
  assert.match(source, /AGENT_TEMPLATE_DOMAIN_LABELS\[item\.domain\]/);
  assert.match(source, /item\.pipeline\.steps\.map\(\(s\) => s\.name\)\.join\(" → "\)/);
  // 8 張卡全部進入輪播數據源（props 直傳）。
  assert.ok(AGENT_TEMPLATES.length >= 8, `内置模板应不少于 8 张，实际 ${AGENT_TEMPLATES.length}`);
});

test("front card click activates the template; side cards rotate to front", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");

  // 正面卡：啟動流水線；側卡：轉到正面；movedRef 擋拖拽誤觸。
  assert.match(source, /onUseTemplate\(cases\[front\]\)/);
  assert.match(source, /if \(movedRef\.current\) return;/);
  assert.match(source, /goTo\(index\)/);
});

test("playground wires the carousel in place of the old gallery", () => {
  const playground = read("src/components/ImagePlayground.tsx");
  assert.match(playground, /import \{ AgentTemplateCarousel \} from "@\/components\/canvas-workstation\/AgentTemplateCarousel"/);
  assert.match(playground, /<AgentTemplateCarousel templates=\{AGENT_TEMPLATES\} onUseTemplate=\{handleUseAgentTemplate\}/);
});

test("template data carries accent gradient and glow for the poster card", () => {
  for (const template of AGENT_TEMPLATES) {
    assert.match(template.accent, /^from-\[#/, `${template.id} accent gradient class`);
    assert.match(template.accent, /via-\[#/);
    assert.match(template.accent, /to-\[#/);
    assert.match(template.glow, /^#[0-9A-Fa-f]{6}$/, `${template.id} glow hex`);
  }
});
