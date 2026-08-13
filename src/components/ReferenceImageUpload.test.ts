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

test("prompt variant uses a plus upload button and expandable preview", () => {
  const upload = read("src/components/ReferenceImageUpload.tsx");
  const prompt = read("src/components/PromptInput.tsx");
  const playground = read("src/components/ImagePlayground.tsx");

  assert.match(upload, /variant\?:\s*"panel"\s*\|\s*"prompt"/);
  assert.match(upload, /aria-label="上传参考图"/);
  assert.match(upload, /<Plus/);
  assert.match(upload, /展开参考图预览/);
  assert.match(upload, /role="dialog"/);
  assert.match(prompt, /variant="prompt"/);
  assert.match(prompt, /referenceImages/);
  assert.match(prompt, /onReferenceImagesChange/);
  assert.match(playground, /referenceImages=\{referenceImages\}/);
  assert.match(playground, /onReferenceImagesChange=\{setReferenceImages\}/);
  assert.doesNotMatch(playground, /<section[^>]*>[\s\S]{0,180}<ReferenceImageUpload value=\{referenceImages\}/);
});

test("prompt reference preview fills a single image and scrolls instead of overflowing for many images", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  assert.match(source, /previewCount === 1 \? "grid-cols-1"/);
  assert.match(source, /max-h-\[min\(46dvh,16rem\)\] overflow-y-auto/);
  assert.match(source, /inset-x-0 w-auto max-w-\[22rem\]/);
  assert.match(source, /onClick=\{\(\) => setIsExpanded\(false\)\}/);
  assert.match(source, /<X className="h-3\.5 w-3\.5" \/>/);
});

test("prompt reference controls expose 44px mobile hit targets", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  assert.match(source, /aria-label="上传参考图"[\s\S]*?min-h-11 min-w-11/);
  assert.match(source, /aria-label="展开参考图预览"[\s\S]*?min-h-11/);
  assert.match(source, /aria-label="移除参考图"[\s\S]*?min-h-11 min-w-11/);
  assert.match(source, /title="关闭预览"[\s\S]*?h-11 w-11/);
});

test("prompt upload keeps a 44px hit target with a half-size visible control", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  assert.match(source, /className="flex min-h-11 min-w-11 items-center justify-center text-black\/55/);
  assert.match(source, /h-\[22px\] w-\[22px\]/);
  assert.match(source, /<Plus className="h-2 w-2" \/>/);
});

test("prompt reference preview opens a skeleton immediately and keeps a polished scroll container", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  assert.match(source, /const \[pendingCount, setPendingCount\] = useState\(0\)/);
  assert.match(source, /setPendingCount\(referenceCandidates\.length\);[\s\S]*?setIsExpanded\(true\);/);
  assert.match(source, /isExpanded && \(value\.length > 0 \|\| pendingCount > 0\)/);
  assert.match(source, /Array\.from\(\{ length: pendingCount \}\)/);
  assert.match(source, /\[scrollbar-width:none\] \[&::\-webkit-scrollbar\]:hidden/);
  assert.match(source, /sticky top-0 z-10/);
});

test("reference image preview closes on Escape and when its active image is removed", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  assert.match(source, /window\.addEventListener\("keydown", closeOnEscape\)/);
  assert.match(source, /event\.key === "Escape"\) setActivePreview\(null\)/);
  assert.match(source, /if \(activePreview\?\.id === id\) setActivePreview\(null\)/);
});

test("compact upload mode leaves preview rendering to its parent panel", () => {
  const source = read("src/components/ReferenceImageUpload.tsx");

  assert.match(source, /value\.length > 0 && !compact && \(/);
});
