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
  // v5 嵌合畫布：canvas 模式預設嵌在右側欄（compact），可展開全屏（fixed overlay）可收合。
  assert.match(source, /resultMode === "canvas" && canvasExpanded && \(/);
  assert.match(source, /<div className="fixed inset-0 z-50 bg-\[#F2F2F7\]">/);
  assert.match(source, /resultMode === "canvas" && !canvasExpanded \? \(/);
  assert.match(source, /height="min\(46vh, 440px\)"/);
  assert.match(source, /onToggleExpand=\{\(\) => setCanvasExpanded\(true\)\}/);
  assert.match(source, /<CanvasEmbed/);
  assert.match(source, /<ImageDisplay/);
  assert.doesNotMatch(source, /ModelSelect/);
  assert.match(source, /const resultView = useMemo/);
});

test("canvas fullscreen overlay is expandable and collapsible", () => {
  const source = read("src/components/ImagePlayground.tsx");
  const embed = read("src/components/canvas/CanvasEmbed.tsx");
  const nodeView = read("src/components/canvas/CanvasNodeView.tsx");

  assert.match(source, /const \[canvasExpanded, setCanvasExpanded\] = useState\(false\)/);
  assert.match(source, /canvasExpanded \? \(/);
  assert.match(embed, /expanded = false/);
  assert.match(embed, /onToggleExpand/);
  assert.match(embed, /expanded \? "收合" : "展开"/);
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
