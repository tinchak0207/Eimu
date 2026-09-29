import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TEMPLATES, AGENT_TEMPLATE_DOMAIN_LABELS } from "@/lib/agent-templates";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/** 2026-09-20 逐模板拆檔後：模板資料散在同目錄多檔，讀整目錄當一份來源。 */
function readDirSources(relDir: string) {
  const abs = join(process.cwd(), relDir);
  return readdirSync(abs)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(abs, f), "utf8"))
    .join("\n");
}

/**
 * AgentTemplateCarousel 是 CaseShowcase.tsx 的逐行複製（2026-08-25 用戶裁定：
 * 複用 = 整複製改文字，禁止造輪子）。測試鎖死兩件事：
 * ① 與首頁的交互能力逐項等價（scroll drive / detent /
 *    commitSteps / 彈簧 / 鍵盤 / 圓點 / 箭頭 / CasePromptReveal / 層棧）；
 *    （wheel 被動性除外：09-12 起本元件刻意 passive:true，見下方錨點註解。）
 * ② 模板化改動（數據源 / 卡面文字 / 正面卡啟動）接線正確。
 */

test("carousel is a verbatim copy of CaseShowcase interaction machinery", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");

  // 觸控板兩指橫掃：2026-09-12 性能審計落地（09-11 OOM note）——本元件 wheel
  // 改掛 { passive: true } 並移除 preventDefault（非 passive wheel 阻塞合成器
  // 滾動），與 CaseShowcase 的 passive:false 是**刻意分歧**，橫向漂移的 CSS
  // 兜底（overscroll-behavior-x）在共用樣式檔，另片處理。deltaX 占優守衛保留。
  assert.match(source, /addEventListener\("wheel", onWheel, \{ passive: true \}\)/);
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

test("carousel renders template cards with poster watermark and circular step selector", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  const data = readDirSources("src/lib/agent-templates");

  for (const template of AGENT_TEMPLATES) {
    assert.ok(data.includes(template.name), `模板数据应包含卡片名「${template.name}」`);
  }
  // 卡面：領域漸變海報 + 大字水印 + 圓形環節選擇器（2026-08-26 替換黑話步驟鏈）。
  assert.match(source, /bg-gradient-to-br", item\.accent/);
  assert.match(source, /atc-watermark/);
  assert.match(source, /AGENT_TEMPLATE_DOMAIN_LABELS\[item\.domain\]/);
  // 選擇器（2026-09-29 重做）：籤 = button + aria-pressed + 序號 + shortName。
  assert.match(source, /atc-step-selector/);
  assert.match(source, /step\.shortName/);
  assert.match(source, /aria-pressed=\{isSelected\}/);
  assert.match(source, /data-step-index/);
  // 刷子手勢：window capture 四件套（觸控板修復：冒泡會被 stage 轉卡 move 截斷）。
  assert.match(source, /window\.addEventListener\("pointermove", handleWindowMove, true\)/);
  assert.match(source, /window\.addEventListener\("pointerup", handleWindowUp, true\)/);
  assert.match(source, /window\.addEventListener\("pointercancel", endGesture, true\)/);
  assert.match(source, /removeEventListener\("pointermove", handleWindowMove, true\)/);
  assert.match(source, /onDragStart=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(source, /elementFromPoint/);
  // 刷子語義：目標狀態 = 按下那格切換後的狀態；扫過的格子只刷一次、不重置已有選擇。
  assert.match(source, /target: !selected\.includes\(index\)/);
  assert.match(source, /working: new Set\(selected\)/);
  assert.match(source, /gesture\.visited\.has\(index\)/);
  assert.doesNotMatch(source, /gesture\.chosen/); // 舊「拖過 = 重置為掃過路徑」退場
  // 觸摸：按下不切換（可能是橫滑），pointercancel 只收尾。
  assert.match(source, /pendingTap: isTouch \? index : null/);
  assert.match(source, /touch-none max-md:touch-pan-x/);
  // 鍵盤 click（detail=0）才在 onClick 切換。
  assert.match(source, /event\.detail !== 0/);
  // 09-29 定稿（暴君兩次否決「控件鋪滿卡面遮成片」）：卡面默認只有一行按鈕，
  // 環節收進「调整环节」展開的玻璃托盤（grid-rows 過渡，收起時 inert 不可聚焦）。
  assert.match(source, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(source, /inert=\{!open\}/);
  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /\{open \? "收起" : "调整环节"\}/);
  assert.match(read("src/components/canvas-workstation/agent-template-carousel.css"), /\.atc-step-tray-wrap\[data-open\] \{\s*grid-template-rows: 1fr;/);
  // 執行 = 實心淺玻璃；跳過 = 細描邊空位（不用刪除線、不用白色實心色塊）。
  assert.match(source, /bg-white\/\[0\.2\] font-medium text-white/);
  assert.match(source, /text-white\/45 shadow-\[inset_0_0_0_1px_rgba\(255,255,255,0\.16\)\]/);
  assert.doesNotMatch(source, /line-through/);
  assert.doesNotMatch(source, /border-white bg-white font-semibold/);
  // 說明文字、勾選框、拖拽徽章、Dock 空白全選全部退場。
  assert.doesNotMatch(source, /按住拖过 = 只跑扫过的/);
  assert.doesNotMatch(source, /role="checkbox"/);
  assert.doesNotMatch(source, /dragCount/);
  assert.doesNotMatch(source, /data-atc-hint/);
  // 舊黑話步驟鏈已退場。
  assert.doesNotMatch(source, /atc-flow/);
  assert.doesNotMatch(source, /join\(" → "\)/);
  // 8 張卡全部進入輪播數據源（props 直傳）。
  assert.ok(AGENT_TEMPLATES.length >= 8, `内置模板应不少于 8 张，实际 ${AGENT_TEMPLATES.length}`);
});

test("front card no longer launches; the submit pill runs the picked steps", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");

  // 正面卡點擊不做事，側卡轉到正面；movedRef 擋拖拽誤觸。確認彈窗整個退場。
  assert.match(source, /if \(movedRef\.current\) return;/);
  assert.match(source, /if \(index !== front\) goTo\(index\)/);
  assert.doesNotMatch(source, /setConfirmTemplate/);
  assert.doesNotMatch(source, /是否使用完整模板开始创作/);
  assert.doesNotMatch(source, /createPortal/);
  // 主按鈕：空集護欄 + 文案即範圍。
  assert.match(source, /if \(picked\.length > 0\) onUseTemplate\(item, picked\)/);
  assert.match(source, /开始创作\n/);
  assert.match(source, /\{canSubmit && !allSelected && \(/);
  assert.match(source, /\{count\}\/\{total\}/);
  assert.match(source, /disabled=\{!canSubmit\}/);
  // 選了部分才在托盤末尾出「恢复全部」。
  assert.match(source, /\{!allSelected && \(/);
  assert.match(source, /恢复全部/);
});

test("selection map: missing key = all steps (default), full set collapses back to default", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  assert.match(source, /if \(sorted\.length === count\) \{/);
  assert.match(source, /delete rest\[templateId\]/);
  assert.match(source, /selectedStepsByTemplate\[item\.id\] \?\?\s*Array\.from\(\{ length: item\.pipeline\.steps\.length \}/);
  assert.match(source, /const canSubmit = count > 0;/);
  // driver.js 教學不再由卡面觸發（零說明文字的設計不需要教程）。
  assert.doesNotMatch(source, /maybeStartAtcTour|forceStartAtcTour/);
});

test("playground wires the carousel in place of the old gallery", () => {
  const playground = read("src/components/ImagePlayground.tsx");
  assert.match(playground, /import \{ AgentTemplateCarousel \} from "@\/components\/canvas-workstation\/AgentTemplateCarousel"/);
  assert.match(playground, /<AgentTemplateCarousel templates=\{AGENT_TEMPLATES\} onUseTemplate=\{handleUseAgentTemplate\}/);
  // 套模板走裁剪：注入與鋪畫布都用 cropTemplate 後的模板（全選 = 原對象零開銷）。
  assert.match(playground, /const cropped = cropTemplate\(template, selectedIndices\)/);
  // 2026-08-26 Bug3：同 workflow 重點 = 替換不是疊加 —— replaceWorkflowNodes
  // 先刪同 workflow_id 舊節點及連線再鋪新的（舊斷言鎖的 addNodes 追加語義已退場）。
  assert.match(playground, /templateToCanvasLayout\(cropped\)/);
  assert.match(playground, /replaceWorkflowNodes\(cropped\.id, layout\.nodes, layout\.connections\)/);
  assert.doesNotMatch(playground, /applyTemplateToCanvas\(canvasHostRef/);
});

test("carousel stage keeps the atc-tour-locking short-circuit on wheel and scroll", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  assert.equal((source.match(/classList\.contains\("atc-tour-locking"\)/g) ?? []).length, 2);
  assert.match(read("src/components/canvas-workstation/agent-template-carousel.css"), /atc-tour-locking/);
});

test("playground resets template-gallery dismissal on a new agent session and restores canvas snapshots", () => {
  const playground = read("src/components/ImagePlayground.tsx");
  const hook = read("src/hooks/use-canvas-chat.ts");

  // Bug1a：新 session id 才復位 dismissed；ref 錨住上一個非空 id，
  // 卸載-重掛的 null 中間態與同會話 resume 都不能誤判成新對話。
  assert.match(playground, /prevAgentSessionRef\.current !== nextSessionId|nextSessionId !== prevAgentSessionRef\.current/);
  assert.match(playground, /setAgentTemplateDismissed\(false\)/);
  assert.match(playground, /onSessionChange=\{handleAgentSessionChange\}/);
  // Bug1b：每個新 sid 拉一次快照；nodes>0 且畫布仍空才回填。
  assert.match(playground, /fetchAgentCanvasSnapshot\(sid\)/);
  assert.match(playground, /host\.restoreAgentSnapshot\(snapshot\)/);
  assert.match(playground, /host\.nodes\.length > 0 \|\| host\.plans\.length > 0/);
  // hook 端：回填走 fromCanvasProject 校驗，空快照拒絕落地，不進撤銷棧。
  assert.match(hook, /const restoreAgentSnapshot = useCallback/);
  assert.match(hook, /fromCanvasProject\(snapshot\)/);
  assert.match(hook, /restored\.nodes\.length === 0\) return false/);
});

test("template data carries accent gradient and glow for the poster card", () => {
  for (const template of AGENT_TEMPLATES) {
    assert.match(template.accent, /^from-\[#/, `${template.id} accent gradient class`);
    assert.match(template.accent, /via-\[#/);
    assert.match(template.accent, /to-\[#/);
    assert.match(template.glow, /^#[0-9A-Fa-f]{6}$/, `${template.id} glow hex`);
  }
});
