import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("reference image upload uses proven image upload libraries", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");
  const pkg = read("package.json");

  assert.match(pkg, /"react-dropzone"/);
  assert.match(pkg, /"browser-image-compression"/);
  assert.match(source, /useDropzone/);
  assert.match(source, /imageCompression/);
  assert.match(source, /MAX_REFERENCE_IMAGES = 6/);
  assert.match(source, /accept:\s*\{\s*"image\/\*"/);
  assert.match(source, /multiple: true/);
  assert.match(source, /URL\.revokeObjectURL/);
});

test("reference image previews are not revoked when upload widget remounts", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  assert.doesNotMatch(source, /useEffect\(\(\) => \(\) => \{[\s\S]*?revokeObjectURL/);
  assert.match(source, /const removeImage[\s\S]*?URL\.revokeObjectURL\(target\.previewUrl\)/);
});

test("prompt variant uses an AI-assistant-styled upload button with a single thumbnail-row mental model", () => {
  // 2026-09-10 项目负责人裁定：上传区语义统一为「上传钮＋内联缩图列」单一心智模型；
  // hover 大面板与数字胶囊删除，点缩图开全屏灯箱（与生成图放大同一组件）。
  const upload = read("src/components/ReferenceImageUpload.tsx");
  const prompt = read("src/components/PromptInput.tsx");
  const playground = read("src/components/ImagePlayground.tsx");

  assert.match(upload, /variant\?:\s*"panel"\s*\|\s*"prompt"/);
  assert.match(upload, /aria-label="上传参考图"/);
  assert.match(upload, /<ImagePlus/);
  // hover 大面板与数字胶囊已连根拔除。
  assert.doesNotMatch(upload, /onMouseEnter|onMouseLeave/);
  assert.doesNotMatch(upload, /hoverOpen|isExpanded/);
  assert.doesNotMatch(upload, /展开参考图预览/);
  assert.doesNotMatch(upload, /<Images\b/);
  assert.match(prompt, /variant="prompt"/);
  assert.match(prompt, /referenceImages/);
  assert.match(prompt, /onReferenceImagesChange/);
  assert.match(playground, /referenceImages=\{referenceImages\}/);
  assert.match(playground, /onReferenceImagesChange=\{setReferenceImages\}/);
  assert.doesNotMatch(playground, /<section[^>]*>[\s\S]{0,180}<ReferenceImageUpload value=\{referenceImages\}/);
});

test("prompt reference thumbnails open the shared ImageLightbox fullscreen viewer", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");
  const lightbox = read("src/components/ImageLightbox.tsx");

  // 缩图点击 → ImageLightbox（与 ImageDisplay「点一下放大」同一组件、同一视觉）。
  assert.match(source, /import \{ ImageLightbox \} from "@\/components\/ImageLightbox"/);
  assert.match(source, /setLightboxImage\(image\)/);
  assert.match(source, /<ImageLightbox\s*\n\s*src=\{lightboxImage\.previewUrl\}/);
  assert.doesNotMatch(source, /setActivePreview/);
  assert.doesNotMatch(source, /role="dialog"/);
  // 旧自制放大层（黑 70 遮罩＋右上关闭钮）不得残留。
  assert.doesNotMatch(source, /bg-black\/70/);
  // 灯箱组件承载 Esc / 后退 / 点背板三关闭路径。
  assert.match(lightbox, /event\.key === "Escape"/);
  assert.match(lightbox, /addEventListener\("popstate"/);
  // 单张 object-contain＋浅底保留原比例认知；多张（≥2）object-cover 方格。
  assert.match(source, /value\.length >= 2 \? "object-cover" : "object-contain"/);
});

test("prompt reference controls expose 44px mobile hit targets", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  assert.match(source, /aria-label="上传参考图"[\s\S]*?min-h-11 min-w-11/);
  assert.match(source, /aria-label="移除参考图"[\s\S]*?min-h-11 min-w-11/);
});

test("prompt upload button mirrors the AI-assistant composer pill with a 44px mobile target", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  // 手机 44px（h-11 w-11）、桌面收小（sm:h-8 sm:w-8）；配色语法与 AgentComposer 附件钮同源。
  assert.match(source, /flex h-11 w-11 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-full/);
  assert.match(source, /bg-ios-blue\/10 text-ios-blue/);
  assert.match(source, /<ImagePlus className="h-5 w-5"/);
});

test("prompt reference preview opens a skeleton immediately and keeps a polished scroll container", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  assert.match(source, /const \[pendingCount, setPendingCount\] = useState\(0\)/);
  // 拖入即出骨架（pendingCount + processing），上传区不自动弹任何面板。
  assert.match(source, /setPendingCount\(referenceCandidates\.length\);[\s\S]*?setIsProcessing\(true\);/);
  assert.match(source, /Array\.from\(\{ length: pendingCount \}\)/);
  assert.match(source, /\[scrollbar-width:none\] \[&::\-webkit-scrollbar\]:hidden/);
});

test("reference image preview closes on Escape and when its active image is removed", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  // Esc / 后退关闭由 ImageLightbox 内部生命周期承担；本档负责删图时联动收灯箱。
  assert.match(source, /lightboxImage && \(\s*\n\s*<ImageLightbox/);
  assert.match(source, /onClose=\{\(\) => setLightboxImage\(null\)\}/);
  assert.match(source, /if \(lightboxImage\?\.id === id\) setLightboxImage\(null\)/);
});

test("compact upload mode leaves preview rendering to its parent panel", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  assert.match(source, /value\.length > 0 && !compact && \(/);
});
