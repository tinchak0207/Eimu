import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeAdobeImageData } from "./adobe-firefly-client.ts";

test("Adobe Firefly uses the Embed SDK V2 publish flow", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/adobe-firefly-client.ts"), "utf8");

  assert.match(source, /NEXT_PUBLIC_ADOBE_EMBED_CLIENT_ID/);
  assert.match(source, /cc-embed\.adobe\.com\/sdk\/v4\/CCEverywhere\.js/);
  assert.match(source, /appVersion:\s*"2"/);
  assert.match(source, /promptText/);
  assert.match(source, /onPublish/);
  assert.match(source, /asset\?\.\[0\]\?\.data/);
  assert.match(source, /target:\s*"publish"/);
  assert.match(source, /outputType:\s*"base64"/);
});

test("Adobe Firefly publish data is normalized for the shared Base64 renderer", () => {
  assert.equal(
    normalizeAdobeImageData("data:image/jpeg;base64,encoded-jpeg"),
    "encoded-jpeg",
  );
});

test("Adobe Firefly takes over the viewport above the host navigation", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/adobe-firefly-client.ts"), "utf8");

  assert.match(source, /CC-EVERYWHERE-CONTAINER-/);
  assert.match(source, /position:\s*"fixed"/);
  assert.match(source, /zIndex:\s*"2147483647"/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /disconnect\(\)/);
});

test("Adobe Firefly expands its embedded workspace instead of showing a centered desktop window", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/adobe-firefly-client.ts"), "utf8");

  assert.match(source, /#cc-everywhere-root/);
  assert.match(source, /#cc-everywhere-iframe-container/);
  assert.match(source, /#cc-everywhere-iframe/);
  assert.match(source, /100dvh/);
  assert.match(source, /adoptedStyleSheets/);
  assert.match(source, /CSSStyleSheet/);
  assert.match(source, /enforceInlineFullscreen/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /overflow:\s*"hidden"/);
});

test("Adobe Firefly uses one delayed-auth SDK instance without IMS token injection", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/adobe-firefly-client.ts"), "utf8");

  assert.match(source, /loginMode:\s*"delayed"/);
  assert.match(source, /let adobeModulePromise: Promise<AdobeEmbedModule> \| undefined/);
  assert.doesNotMatch(source, /ims-jump/);
  assert.doesNotMatch(source, /api\/adobe-token/);
});
