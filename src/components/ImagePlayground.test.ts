import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("image playground controls normal, fallback, and failed progress timing", () => {
  const source = read("src/components/ImagePlayground.tsx");
  assert.match(source, /NORMAL_PROGRESS_DURATION_MS/);
  assert.match(source, /FALLBACK_PROGRESS_DURATION_MS/);
  assert.match(source, /progressDurationMs/);
  assert.match(source, /endpointLabel === "fallback"/);
  assert.match(source, /failedProviders\.length > 0/);
  assert.match(source, /progressStartedAt/);
  assert.match(source, /showProgress/);
  assert.match(source, /revealGeneratedResult = !showProgress/);
  assert.doesNotMatch(source, /<GenerationProgressBar|QuietRevealTheater|theaterStartedAt|finalImageSrc/);
});

test("image playground reveals a completed image without waiting for the estimated progress duration", () => {
  const source = read("src/components/ImagePlayground.tsx");

  assert.match(source, /const hasGeneratedImage = images\.some/);
  assert.match(source, /failedProviders\.length > 0 \|\| hasGeneratedImage/);
});

test("professional mode renders as a standalone app without the normal showcase shell", () => {
  const source = read("src/components/ImagePlayground.tsx");
  const proBranch = source.indexOf("hasOpenedProfessionalMode &&");
  const normalShell = source.indexOf("min-h-screen bg-transparent");
  const showcase = source.indexOf("<CaseShowcase");

  assert.notEqual(proBranch, -1);
  assert.match(source, /pro-app-shell/);
  assert.match(source, /onExitProfessionalMode/);
  assert.match(source, /!showProfessionalMode && \(/);
  assert.ok(proBranch < normalShell);
  assert.ok(proBranch < showcase);
});

test("professional workstation stylesheet stays out of the first-paint bundle", () => {
  const playground = read("src/components/ImagePlayground.tsx");
  const workstation = read("src/components/pro-workstation/InvokeInspiredWorkstation.tsx");

  // ~37KB of pro-mode-only CSS. Importing it here put it in the homepage's
  // render-blocking <link rel=stylesheet>; it now rides the lazy chunk that
  // InvokeInspiredWorkstation itself pulls in.
  assert.doesNotMatch(playground, /import "\.\/pro-workstation\/workstation\.css"/);
  assert.match(workstation, /import "\.\/workstation\.css"/);
});

test("the result column is the canvas alone, with no duplicated chrome", () => {
  const source = read("src/components/ImagePlayground.tsx");

  // The model picker moved onto the left rail, so the right column renders
  // ImageDisplay directly ??no wrapper card, identity header, or second status
  // badge on top of the one ImageDisplay already draws.
  // 2026-08-16 暴君裁定「擠」：畫布模式 = 全場畫布工作站（canvas-ws-overlay），
  // 不再有 compact 嵌右欄；聊天卡變左側浮動面板（canvas-chat-panel）。
  assert.match(source, /inCanvasWorkstation = displayMode === "agent" && resultMode === "canvas" && !showProfessionalMode/);
  assert.match(source, /canvas-ws-overlay fixed inset-x-0 top-0 z-50 h-\[100dvh\] bg-\[#F2F2F7\]/);
  assert.match(source, /<CanvasEmbed canvas=\{canvasHost\} expanded onClose=\{\(\) => setResultMode\("image"\)\}/);
  assert.match(source, /<ImageDisplay/);
  assert.match(source, /chatPanelState === "expanded" \? \{ width: chatPanelWidth \}/);
  assert.doesNotMatch(source, /ModelSelect/);
});

test("canvas workstation is a fullscreen overlay with expandable chat panel", () => {
  const source = read("src/components/ImagePlayground.tsx");
  const embed = read("src/components/canvas/CanvasEmbed.tsx");
  const nodeView = read("src/components/canvas/CanvasNodeView.tsx");

  // 工作站：畫布吃滿全場，聊天面板 expanded|rail 兩態 + 右緣拖寬，localStorage 記憶。
  assert.match(source, /const \[chatPanelState, setChatPanelState\] = useState<"expanded" \| "rail">\("expanded"\)/);
  assert.match(source, /const \[chatPanelWidth, setChatPanelWidth\] = useState\(420\)/);
  assert.match(source, /canvas-chat-resize/);
  assert.match(source, /chatPanelState === "rail" && "canvas-chat-rail"/);
  assert.match(source, /--ce-chrome-left/);
  assert.match(embed, /expanded = false/);
  assert.match(nodeView, /enterDelay/);
  assert.match(nodeView, /transitionDelay/);
});

test("the model picker is wired into the left prompt panel", () => {
  const source = read("src/components/ImagePlayground.tsx");
  const prompt = read("src/components/PromptInput.tsx");

  assert.match(source, /models=\{PROVIDERS\.image_tinchak\.models\}/);
  assert.match(source, /modelId=\{selectedModels\.image_tinchak\}/);
  assert.match(source, /onModelChange=\{handleModelChange\}/);
  assert.match(source, /generateAudio=\{generateAudio\}/);
  assert.match(source, /onGenerateAudioChange=\{setGenerateAudio\}/);
  assert.match(prompt, /<ModelPicker[\s\S]{0,180}models=\{models\}[\s\S]{0,180}value=\{modelId\}/);
});

test("public image generation never launches the browser-only Adobe adapter", () => {
  const source = read("src/components/ImagePlayground.tsx");

  assert.doesNotMatch(source, /ADOBE_FIREFLY_MODEL_ID|generateAdobeFireflyImage|externalGenerator/);
  assert.match(source, /if \(!LOCAL_TEST_MODE && \(!isLoggedIn \|\| !user\)\)/);
});

test("professional mode is a toggle inside the prompt card, not a bare row", () => {
  const source = read("src/components/ImagePlayground.tsx");
  const prompt = read("src/components/PromptInput.tsx");

  // It used to occupy a whole right-aligned row above the grid.
  assert.doesNotMatch(source, /mb-4 flex justify-end/);
  assert.match(source, /onToggleProfessionalMode=\{openProfessionalMode\}/);
  assert.match(source, /isProfessionalMode=\{showProfessionalMode\}/);

  // Reachable at every width, and exposes real toggle state to assistive tech.
  assert.match(prompt, /onClick=\{onToggleProfessionalMode\}/);
  assert.match(prompt, /aria-pressed=\{isProfessionalMode\}/);
  assert.doesNotMatch(prompt, /hidden md:inline-flex[\s\S]{0,200}专业模式/);
});

test("professional mode keeps its draft mounted after returning home", () => {
  const source = read("src/components/ImagePlayground.tsx");

  assert.match(source, /const \[hasOpenedProfessionalMode, setHasOpenedProfessionalMode\] = useState\(false\)/);
  assert.match(source, /hasOpenedProfessionalMode && \(/);
  assert.match(source, /aria-hidden=\{!showProfessionalMode\}/);
  assert.match(source, /!showProfessionalMode && \(/);
  assert.doesNotMatch(source, /if \(showProfessionalMode\) \{\s*return/);
});

test("canvas workstation chat panel keeps the composer inside the panel", () => {
  const source = read("src/components/ImagePlayground.tsx");

  // 面板是 fixed + overflow:hidden 的 flex 容器：内容超高时若高度链没把
  // transcript 的滚动接住，输入区会被推出面板外（用户截图：底部只见
  // 被裁掉的「思考过程」最后一行、输入框整体不可见）。加固规则：
  //  - 面板给 min-height:0 / max-height 兜底（bottom 已定界，双保险）
  //  - section.lg-card 拿 flex:1 之外再显式 min-height:0 + overflow:hidden，
  //    不许 agent 面把卡片按内容撑高
  //  - 非 lg-card 兄弟（如 agentBaseline 撤回条）shrink-0，不抢高度
  //  - composer 锚点 shrink-0，永不被 flex 压没
  assert.match(source, /\.canvas-chat-panel \{[^}]*min-height: 0;[^}]*max-height: calc\(100dvh - 1\.5rem[^}]*\}/);
  assert.match(source, /\.canvas-chat-scroll-fill > section\.lg-card \{[^}]*flex: 1 1 0%;[^}]*min-height: 0;[^}]*overflow: hidden;/);
  assert.match(source, /\.canvas-chat-scroll-fill > :not\(section\.lg-card\) \{ flex-shrink: 0; \}/);
  assert.match(source, /\.agent-composer-anchor \{ flex-shrink: 0; \}/);
});
