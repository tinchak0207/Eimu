#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [inputArg, outputArg] = process.argv.slice(2);

if (!inputArg || !outputArg || process.argv.includes("--help")) {
  console.log("Usage: node scripts/render_campaign.mjs <campaign.json> <output-directory>");
  process.exit(inputArg && outputArg ? 0 : 1);
}

const inputPath = path.resolve(inputArg);
const outputDir = path.resolve(outputArg);
const sourceDir = path.dirname(inputPath);
const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));

const formats = {
  square: [1080, 1080],
  portrait: [1080, 1350],
  story: [1080, 1920],
  landscape: [1920, 1080],
  "x-landscape": [1600, 900],
};

const format = typeof data.format === "object"
  ? [Number(data.format.width), Number(data.format.height)]
  : formats[data.format || "portrait"];

if (!format || !format.every((value) => Number.isFinite(value) && value > 0)) {
  throw new Error("Invalid format. Use a named format or positive width and height values.");
}

if (!Array.isArray(data.creatives) || data.creatives.length === 0) {
  throw new Error("The campaign requires at least one creative.");
}

fs.mkdirSync(path.join(outputDir, "creatives"), { recursive: true });

const esc = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const slug = (value, fallback = "creative") => {
  const result = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return result || fallback;
};

const wrap = (text, maxChars) => {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
};

const textBlock = (lines, x, y, size, lineHeight, attrs = "") => lines
  .map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" ${attrs} font-size="${size}">${esc(line)}</text>`)
  .join("\n");

const mimeFor = (file) => ({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
}[path.extname(file).toLowerCase()] || "application/octet-stream");

const imageDataUrl = (relativePath) => {
  if (!relativePath) return "";
  const file = path.resolve(sourceDir, relativePath);
  if (!fs.existsSync(file)) throw new Error(`Background image not found: ${file}`);
  return `data:${mimeFor(file)};base64,${fs.readFileSync(file).toString("base64")}`;
};

const [width, height] = format;
const brand = {
  primary: data.brand?.primary || "#7c3aed",
  secondary: data.brand?.secondary || "#090b12",
  accent: data.brand?.accent || "#a7f3d0",
  text: data.brand?.text || "#ffffff",
};

const renderCreative = (creative, index) => {
  const margin = Math.round(Math.min(width, height) * 0.07);
  const hookSize = Math.round(Math.min(width * 0.09, height * 0.075));
  const bodySize = Math.round(hookSize * 0.36);
  const hookLines = wrap(creative.hook, Math.max(14, Math.floor(width / hookSize * 1.7)));
  const bodyLines = wrap(creative.body, Math.max(24, Math.floor(width / bodySize * 1.65)));
  const background = imageDataUrl(creative.backgroundImage);
  const id = slug(creative.id || creative.label, `creative-${index + 1}`);
  const hookY = Math.round(height * 0.55);
  const bodyY = hookY + hookLines.length * hookSize * 1.03 + Math.round(bodySize * 0.9);
  const ctaY = Math.min(height - margin - 90, bodyY + bodyLines.length * bodySize * 1.25 + Math.round(bodySize * 1.3));
  const label = creative.label || `Direction ${index + 1}`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${esc(brand.secondary)}"/><stop offset="1" stop-color="${esc(brand.primary)}"/></linearGradient>
    <radialGradient id="glow-${id}" cx="75%" cy="18%" r="75%"><stop offset="0" stop-color="${esc(brand.accent)}" stop-opacity=".62"/><stop offset="1" stop-color="${esc(brand.accent)}" stop-opacity="0"/></radialGradient>
    <filter id="blur-${id}"><feGaussianBlur stdDeviation="44"/></filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg-${id})"/>
  ${background ? `<image href="${background}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/><rect width="${width}" height="${height}" fill="${esc(brand.secondary)}" opacity=".52"/>` : ""}
  <circle cx="${Math.round(width * .8)}" cy="${Math.round(height * .16)}" r="${Math.round(Math.min(width, height) * .38)}" fill="url(#glow-${id})" filter="url(#blur-${id})"/>
  <rect x="${margin}" y="${margin}" width="${Math.round(width * .34)}" height="58" rx="29" fill="${esc(brand.text)}" fill-opacity=".12" stroke="${esc(brand.text)}" stroke-opacity=".26"/>
  <text x="${margin + 28}" y="${margin + 38}" fill="${esc(brand.text)}" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700" letter-spacing="2">${esc(data.product || "ASTRA AD STUDIO").toUpperCase()}</text>
  <text x="${width - margin}" y="${margin + 38}" text-anchor="end" fill="${esc(brand.text)}" fill-opacity=".72" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="600">0${index + 1} / ${esc(label)}</text>
  ${textBlock(hookLines, margin, hookY, hookSize, Math.round(hookSize * 1.03), `fill="${esc(brand.text)}" font-family="Inter, Arial, sans-serif" font-weight="800" letter-spacing="-2"`)}
  ${textBlock(bodyLines, margin, bodyY, bodySize, Math.round(bodySize * 1.25), `fill="${esc(brand.text)}" fill-opacity=".82" font-family="Inter, Arial, sans-serif" font-weight="500"`)}
  ${creative.proof ? `<text x="${margin}" y="${ctaY - 44}" fill="${esc(brand.accent)}" font-family="Inter, Arial, sans-serif" font-size="${Math.round(bodySize * .72)}" font-weight="700">${esc(creative.proof)}</text>` : ""}
  <rect x="${margin}" y="${ctaY}" width="${Math.max(230, String(creative.cta || "Learn more").length * 20 + 72)}" height="78" rx="39" fill="${esc(brand.accent)}"/>
  <text x="${margin + 36}" y="${ctaY + 51}" fill="${esc(brand.secondary)}" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="800">${esc(creative.cta || "Learn more")}</text>
  <text x="${width - margin}" y="${height - margin}" text-anchor="end" fill="${esc(brand.text)}" fill-opacity=".58" font-family="Inter, Arial, sans-serif" font-size="20">${esc(data.url || data.campaign || "")}</text>
</svg>`;

  const file = path.join(outputDir, "creatives", `${String(index + 1).padStart(2, "0")}-${id}.svg`);
  fs.writeFileSync(file, svg);
  return { ...creative, id, label, file: path.relative(outputDir, file) };
};

const rendered = data.creatives.map(renderCreative);

const gallery = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(data.campaign || "Astra Ad Studio")}</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#07080d;color:#fff}*{box-sizing:border-box}body{margin:0;padding:48px}.head{max-width:1200px;margin:0 auto 32px}.head p{color:#9ca3af}.grid{max-width:1200px;margin:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:28px}.card{background:#11131b;border:1px solid #242735;border-radius:22px;padding:16px}.card object{width:100%;display:block;border-radius:14px;background:#000}.meta{padding:14px 4px 2px}.meta strong{display:block}.meta span{color:#9ca3af;font-size:14px}</style></head><body><header class="head"><h1>${esc(data.campaign || "Astra Ad Studio")}</h1><p>${esc(data.product || "Product")} · ${esc(data.audience || "Audience")}</p></header><main class="grid">${rendered.map((item) => `<article class="card"><object data="${esc(item.file)}" type="image/svg+xml"></object><div class="meta"><strong>${esc(item.label)}</strong><span>${esc(item.hook)}</span></div></article>`).join("")}</main></body></html>`;
fs.writeFileSync(path.join(outputDir, "preview.html"), gallery);

if (data.motion?.frames?.length) {
  const duration = Number(data.motion.duration) || Math.max(...data.motion.frames.map((frame) => Number(frame.end) || 0), 15);
  const frameCss = [];
  const frames = data.motion.frames.map((frame, index) => {
    const start = Math.max(0, Number(frame.start) || 0);
    const end = Math.max(start + .1, Number(frame.end) || start + 3);
    const startPct = Math.min(100, start / duration * 100);
    const endPct = Math.min(100, end / duration * 100);
    const enterPct = Math.min(endPct, startPct + 1.5);
    const exitPct = Math.max(enterPct, endPct - 1.5);
    frameCss.push(`@keyframes scene-${index}{0%,${startPct.toFixed(3)}%{opacity:0;transform:translateY(5%)}${enterPct.toFixed(3)}%,${exitPct.toFixed(3)}%{opacity:1;transform:none}${endPct.toFixed(3)}%,100%{opacity:0;transform:translateY(-3%)}}`);
    return `<section class="frame" style="animation-name:scene-${index}"><div class="kicker">${esc(frame.kicker || data.product || "")}</div><h2>${esc(frame.hook || "")}</h2><p>${esc(frame.body || "")}</p>${frame.cta ? `<span>${esc(frame.cta)}</span>` : ""}</section>`;
  }).join("");
  const motion = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(data.campaign || "Motion ad")}</title><style>
:root{--duration:${duration}s;font-family:Inter,ui-sans-serif,system-ui}*{box-sizing:border-box}body{margin:0;background:#05060a;display:grid;place-items:center;min-height:100vh}.stage{position:relative;width:min(56.25vh,100vw);aspect-ratio:${width}/${height};overflow:hidden;color:${esc(brand.text)};background:linear-gradient(145deg,${esc(brand.secondary)},${esc(brand.primary)});box-shadow:0 40px 100px #0009}.stage:before{content:"";position:absolute;inset:-30%;background:radial-gradient(circle at 80% 20%,${esc(brand.accent)}88,transparent 45%);animation:drift var(--duration) ease-in-out infinite alternate}.frame{position:absolute;inset:8%;display:flex;flex-direction:column;justify-content:center;opacity:0;transform:translateY(5%);animation-duration:var(--duration);animation-timing-function:linear;animation-iteration-count:infinite}.kicker{font-size:clamp(12px,2.4vh,28px);font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:${esc(brand.accent)}}h2{font-size:clamp(36px,8vh,96px);line-height:.95;letter-spacing:-.05em;margin:.25em 0;max-width:10ch}p{font-size:clamp(17px,3vh,36px);line-height:1.2;max-width:22ch;color:#ffffffe0}span{align-self:flex-start;margin-top:1em;padding:.65em 1em;border-radius:999px;background:${esc(brand.accent)};color:${esc(brand.secondary)};font-size:clamp(16px,2.5vh,30px);font-weight:800}@keyframes drift{to{transform:translate(-8%,7%) scale(1.08)}}${frameCss.join("")}</style></head><body><main class="stage">${frames}</main></body></html>`;
  fs.writeFileSync(path.join(outputDir, "motion-preview.html"), motion);
}

const report = `# ${data.campaign || "Astra Ad Studio Campaign"}

> Finished creative pack for **${data.product || "the product"}**.

## Campaign brief

| Field | Value |
|---|---|
| Audience | ${data.audience || "Not supplied"} |
| Objective | ${data.objective || "Not supplied"} |
| Primary format | ${width} × ${height} |
| Recommended direction | ${data.recommended || rendered[0].label} |

## Creative directions

${rendered.map((item, index) => `### ${index + 1}. ${item.label}\n\n**Hook:** ${item.hook}\n\n**Asset:** [Open SVG](./${item.file})\n`).join("\n")}
## Previews

- [Open campaign gallery](./preview.html)
${data.motion?.frames?.length ? "- [Open motion preview](./motion-preview.html)" : ""}

## Publishing notes

${data.notes || "Review the selected creative at mobile size and export the final platform format after approval."}
`;
fs.writeFileSync(path.join(outputDir, "ASTRA-AD-STUDIO-REPORT.md"), report);

console.log(`Rendered ${rendered.length} creative(s) to ${outputDir}`);
console.log(path.join(outputDir, "ASTRA-AD-STUDIO-REPORT.md"));
