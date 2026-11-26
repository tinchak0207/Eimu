import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "astra-ad-studio-"));
const result = spawnSync(process.execPath, [
  path.join(root, "scripts", "render_campaign.mjs"),
  path.join(root, "demo-input", "demo-campaign.json"),
  temp,
], { encoding: "utf8" });

assert.equal(result.status, 0, result.stderr);
assert.ok(fs.existsSync(path.join(temp, "preview.html")));
assert.ok(fs.existsSync(path.join(temp, "motion-preview.html")));
assert.ok(fs.existsSync(path.join(temp, "ASTRA-AD-STUDIO-REPORT.md")));

const creatives = fs.readdirSync(path.join(temp, "creatives")).filter((file) => file.endsWith(".svg"));
assert.equal(creatives.length, 3);

const report = fs.readFileSync(path.join(temp, "ASTRA-AD-STUDIO-REPORT.md"), "utf8");
assert.match(report, /Recommended direction \| Product Proof/);
assert.match(report, /Synthetic demo content/);

const svg = fs.readFileSync(path.join(temp, "creatives", creatives[0]), "utf8");
assert.match(svg, /Your launch is not/);
assert.match(svg, /the problem\./);
assert.match(svg, /1080/);

console.log("astra-ad-studio tests passed");
