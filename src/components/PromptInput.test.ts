import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/**
 * Task 6+9：JSX 面板（GenerateControls / EditPanel / UpscalePanel / ActionRow）与
 * rail 类常量抽到 prompt-input/ 底下——断言按「旧档＋新档」拼接读取，语义不变。
 */
const PROMPT_INPUT_SURFACE = [
  "src/components/PromptInput.tsx",
  "src/components/prompt-input/rail-classes.ts",
  "src/components/prompt-input/GenerateControls.tsx",
  "src/components/prompt-input/EditPanel.tsx",
  "src/components/prompt-input/UpscalePanel.tsx",
  "src/components/prompt-input/ActionRow.tsx",
].map(read).join("\n\n");

test("prompt input appends example snippets and replaces the previous one on repeat clicks", () => {
  // 2026-09-05 项目负责人裁定：连点模板不叠加——新模板替换上一次插入的模板，
  // 用户手打文字照旧保留（replacePromptSnippet 内部先摘掉旧模板再插入新模板）。
  const source = PROMPT_INPUT_SURFACE;
  assert.match(source, /replacePromptSnippet/);
  assert.match(source, /handleSuggestionSelect/);
  assert.match(source, /setInput\(\(current\) => replacePromptSnippet\(current, lastSuggestionRef\.current, prompt\)\)/);
  assert.match(source, /lastSuggestionRef\.current = prompt/);
  assert.doesNotMatch(source, /setInput\(prompt\);\s*onSubmit\(prompt\)/);
  assert.doesNotMatch(source, /handleSuggestionSelect[\s\S]{0,160}onSubmit/);
});

test("style selection immediately appends its prompt suffix without duplicating it on submit", () => {
  const prompt = PROMPT_INPUT_SURFACE;
  const enhancer = read("src/lib/prompt-enhancer.ts");

  assert.match(prompt, /const handleStyleChange/);
  assert.match(prompt, /STYLE_PRESETS\.find/);
  assert.match(prompt, /replacePromptStyleSuffix/);
  assert.match(prompt, /onChange=\{handleStyleChange\}/);
  assert.match(enhancer, /userPrompt\.trim\(\)\.includes\(meta\.suffix\)/);
});

test("prompt input renders one control set for every breakpoint", () => {
  const source = PROMPT_INPUT_SURFACE;

  // 画质／风格／示例 share a single responsive implementation — no mobile-only
  // duplicate of the same three controls.
  assert.doesNotMatch(source, /md:hidden/);
  assert.doesNotMatch(source, /<select/);
  assert.doesNotMatch(source, /ChevronDown/);
  assert.doesNotMatch(source, /STYLE_OPTIONS/);

  // Seven source-level rows (示例／模型／比例／清晰／时长／音讯／风格) share one label rail.
  assert.match(source, /const LABEL_CLASS/);
  assert.ok((source.match(/className=\{LABEL_CLASS\}/g) ?? []).length >= 7);

  // Every control area is a scrolling rail; the video duration row is conditional.
  assert.match(source, /const RAIL_CLASS/);
  assert.match(source, /overflow-x-auto/);
  assert.ok((source.match(/className=\{RAIL_CLASS\}/g) ?? []).length >= 7);
});

test("no settings row can widen the card, so phones never scroll sideways", () => {
  const source = PROMPT_INPUT_SURFACE;
// Task 10：聊天卡卷动容器随面板壳搬到 canvas-workstation/，playground
// 读取改为「旧档＋新档」拼接，语义不变。
  const playground =
    read("src/components/ImagePlayground.tsx") +
    read("src/components/canvas-workstation/CanvasChatWorkstation.tsx");

  // Chips are flex-shrink:0 + nowrap, so a row without min-w-0 reports their
  // full combined width as its min-content and drags the card past the
  // viewport. Every label row and every control area must be able to shrink.
  const rowDefinition = source.match(/const ROW_CLASS = "([^"]*)"/)?.[1] ?? "";
  assert.match(rowDefinition, /min-w-0/);
  // 生成 7 行 + 改图／放大控件行都走同一条 ROW_CLASS，行数只增不减。
  assert.ok((source.match(/className=\{ROW_CLASS\}/g) ?? []).length >= 7);
  assert.doesNotMatch(source, /<div className="flex items-center gap-2">\s*<span className=\{LABEL_CLASS\}/);

  // The auto-sized grid column takes its floor from the item's min-content too.
  // 2026-08-22: 该列改为条件渲染（canvas 工作台分支）——普通分支必须保留 min-w-0。
  assert.match(playground, /: "min-w-0 space-y-3"\}/);

  // Backstop so a future row can only ever clip, never push the page.
  assert.match(source, /lg-card relative overflow-x-clip rounded-ios-3xl/);
});

test("chip rails never wrap, so labels cannot drift between rows", () => {
  const source = PROMPT_INPUT_SURFACE;
  const css = read("src/app/globals.css");

  // Wrapping is what produced misaligned labels and orphan "4+1" rows:
  // the label centres against the whole block instead of the first row.
  const railDefinition = source.match(/const RAIL_CLASS =\s*("[^"]*")/)?.[1] ?? "";
  assert.notEqual(railDefinition, "");
  assert.doesNotMatch(railDefinition, /flex-wrap/);
  assert.match(railDefinition, /items-center/);
  assert.match(railDefinition, /overflow-x-auto/);

  // A chip must not shrink or wrap its own text inside the scroll rail.
  assert.match(css, /\.style-chip \{[\s\S]*?flex-shrink: 0;/);
  assert.match(css, /\.style-chip \{[\s\S]*?white-space: nowrap;/);
});

test("every generated option uses the shared 36px chip control", () => {
  const source = PROMPT_INPUT_SURFACE;
  const css = read("src/app/globals.css");

  // Model capabilities are rendered as the same 36px chips; refresh is h-9 too.
  assert.match(css, /\.style-chip \{[\s\S]*?height: 2\.25rem;/);
  assert.match(source, /className=\{cn\("style-chip", aspectRatio === ratio/);
  assert.match(source, /className=\{cn\("style-chip gap-1\.5", outputResolution === resolution/);
  assert.match(source, /h-9 w-9 shrink-0 items-center justify-center rounded-full/);
});

test("chips are quiet gray fills, not another wall of outlined boxes", () => {
  const css = read("src/app/globals.css");

  // 描边胶囊 × 几十个 = 用户点名的「分割感非常重」。胶囊统一为安静的灰色
  // 填充，与画质分段控件同族；选中态用蓝 tint 填充表达，不允许描边回归。
  assert.match(css, /\.style-chip \{[^}]*border: none;/);
  assert.match(css, /\.style-chip \{[^}]*background: rgba\(0, 0, 0, 0\.045\);/);
  assert.doesNotMatch(css, /\.style-chip \{[^}]*border: 1px solid/);
  // No transform on hover: a scaled chip gets clipped by the rail's overflow.
  assert.doesNotMatch(css, /\.style-chip:hover \{[^}]*transform/);
  assert.doesNotMatch(css, /\.style-chip\.active \{[^}]*transform/);
});

test("example chips carry no decorative arrow glyph", () => {
  const source = PROMPT_INPUT_SURFACE;

  // The inline SVG arrow rendered like a stray "return" symbol next to every
  // example and added nothing the chip's affordance did not already say.
  assert.doesNotMatch(source, /suggestions\.map[\s\S]{0,420}<svg/);
});

test("prompt input separates groups with whitespace, never divider lines", () => {
  const source = PROMPT_INPUT_SURFACE;
  // 硬分隔线是「分割感」的另一半来源；分组交给留白。
  assert.ok((source.match(/lg-divider/g) ?? []).length === 0);
});

test("prompt input exposes model-specific ratio, resolution, duration, and price controls", () => {
  const source = PROMPT_INPUT_SURFACE;

  assert.match(source, /modelAspectRatios\(modelId\)/);
  assert.match(source, /modelResolutions\(modelId\)/);
  assert.match(source, /modelDurations\(modelId\)/);
  assert.match(source, /resolutionLabel\(resolution\)/);
  assert.match(source, /generationCoins\(modelId, \{ resolution, durationSeconds, generateAudio \}\)/);
  assert.match(source, /modelSupportsAudio\(modelId\)/);
});

test("prompt input gives style selection visible applied state and a clear control", () => {
  const source = PROMPT_INPUT_SURFACE;

  assert.match(source, /const activeStyle = useMemo/);
  assert.match(source, /已套用 \{activeStyle\.label\}/);
  assert.match(source, /aria-label=\{`清除\$\{activeStyle\.label\}风格`\}/);

  // Clearing lives on the applied-state pill, not on an extra 默认 chip that
  // would push the style rail past the 644px it gets at the 1280px breakpoint.
  assert.doesNotMatch(source, /aria-pressed=\{stylePreset === "none"\}/);
  assert.doesNotMatch(source, /> *默认 *</);
});

test("prompt input keeps the example rail refreshable next to the description box", () => {
  const source = PROMPT_INPUT_SURFACE;

  assert.match(source, /suggestions\.map/);
  assert.match(source, /换一批示例/);
  assert.match(source, /RefreshCw/);
  // Examples fill the textarea, so the rail sits above the settings group.
  assert.ok(source.indexOf("换一批示例") < source.indexOf(">模型</span>"));
});

test("the action row stacks on phones and right-aligns from sm up", () => {
  const source = PROMPT_INPUT_SURFACE;

  // A `w-full` CTA sharing a flex-wrap row with an `ml-auto` sibling only lands
  // correctly once it wraps; stacking removes that dependency entirely.
  assert.match(source, /flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center/);
  assert.doesNotMatch(source, /flex flex-wrap items-center gap-2 sm:gap-3/);
  assert.match(source, /h-11 w-full[^"]*sm:w-auto/);
  // The CTA never shares a row with the example chips.
  assert.doesNotMatch(source, /justify-between[\s\S]{0,200}suggestions\.map/);
});

test("professional workstation entry is fully removed from the prompt card (2026-08-27)", () => {
  const source = PROMPT_INPUT_SURFACE;

  // 专业工作站入口移除：AI 工作站（agent 模式）已吸收其独有机制，
  // toggle switch、props 链与「专业控制」文案不再存在。
  assert.doesNotMatch(source, /isProfessionalMode/);
  assert.doesNotMatch(source, /onToggleProfessionalMode/);
  assert.doesNotMatch(source, /pro-mode-toggle/);
  assert.doesNotMatch(source, /专业控制|专业工作站/);
});

test("the result canvas sizes to its content instead of a blank square", () => {
  const display = read("src/components/ImageDisplay.tsx");

  // Empty state gets a compact band on phones; a full-width square of nothing
  // is the "下方很空" complaint. Square returns once there is something to show.
  assert.match(display, /hasMedia \|\| isRendering \? "aspect-square" : "min-h-\[15rem\]"/);
  // Desktop still matches the prompt panel's height so the columns bottom-align.
  assert.match(display, /xl:aspect-auto xl:h-full/);
});

test("prompt input prevents iOS zoom and keeps controls tappable", () => {
  const source = PROMPT_INPUT_SURFACE;

  // The textarea is the only native text input, so it carries the 16px rule.
  assert.match(source, /min-h-\[180px\][^\"]*text-\[16px\]/);
  // Every remaining control is a button at 32px+ so it stays comfortably tappable.
  assert.ok((source.match(/h-8 |h-9 |h-7 w-7/g) ?? []).length >= 3);
  assert.doesNotMatch(source, /uppercase tracking-widest/);
  // Labels stay at the readable 13px step, never the 11px caption step.
  assert.doesNotMatch(source, /LABEL_CLASS = "[^"]*ios-caption2/);
});

test("resolution and duration cost is derived from the selected model, never hardcoded", () => {
  const source = PROMPT_INPUT_SURFACE;

  assert.doesNotMatch(source, /快速 · 1 币|高清 · 2 币/);
  assert.match(source, /generationCoins\(modelId, \{ resolution, durationSeconds, generateAudio \}\)/);
  assert.match(source, /durationSeconds: duration,[\s\S]{0,80}generateAudio/);
  assert.match(source, /resolutionLabel\(resolution\)/);
});

test("audio-capable video models expose an accessible toggle with live pricing", () => {
  const source = PROMPT_INPUT_SURFACE;
  const picker = read("src/components/ModelPicker.tsx");

  assert.match(source, /isVideo && supportsAudio/);
  assert.match(source, /aria-pressed=\{generateAudio\}/);
  assert.match(source, /onGenerateAudioChange\(!generateAudio\)/);
  assert.match(source, /生成音讯/);
  assert.match(picker, /generateAudio/);
});

test("the model picker groups models by vendor submenus and prices every option", () => {
  const picker = read("src/components/ModelPicker.tsx");

  assert.match(picker, /modelPickerName\(value, stripVendorPrefix/);
  assert.match(picker, /stripVendorPrefix/);
  assert.match(picker, /modelPromotionTag/);
  // Price appears once per option inside the submenus, not on the closed trigger.
  assert.match(picker, /modelPriceLabel\(model, priceOptions\)/);
  // First level is a vendor directory (PixAI among them); models live in
  // second-level submenus opened on hover.
  assert.match(picker, /generationModel\(model\)\?\.vendor/);
  assert.match(picker, /DropdownMenuSubTrigger/);
  assert.match(picker, /DropdownMenuSubContent/);
  const catalog = read("src/lib/generation-model-catalog/catalog.ts");
  assert.match(catalog, /vendor: "PixAI",/);
  const triggerBlock = picker.slice(picker.indexOf("<DropdownMenuTrigger"), picker.indexOf("</DropdownMenuTrigger>"));
  assert.doesNotMatch(triggerBlock, /modelPriceLabel|币\/张|币\/条/);
  // The trigger wears the same chip skin as the surrounding rails.
  assert.match(triggerBlock, /style-chip/);
});
