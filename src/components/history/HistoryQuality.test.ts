import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("history filter chips speak the same style-chip language as the rest of the site", () => {
  const source = read("src/components/history/HistoryFilterBar.tsx");

  // The chip used to be a bespoke solid-blue pill — a different control family
  // from the 画质/风格/模型 chips on the homepage. Reusing .style-chip means one
  // chip grammar site-wide instead of three different button styles.
  assert.match(source, /className=\{cn\("style-chip", active && "active"\)\}/);
  assert.doesNotMatch(source, /bg-\[#007AFF\] text-white shadow-\[0_8px_20px_rgba\(0,122,255,0\.26\)\]/);
  // Chip icons match the 3.5-unit size used by StylePresets/ModelPicker, not
  // the smaller 3-unit size that read as a different scale on this one page.
  assert.doesNotMatch(source, /<Star className="h-3 w-3"/);
  assert.doesNotMatch(source, /<ImageIcon className="h-3 w-3"/);
});

test("history empty state matches the 40px card radius used elsewhere on this page", () => {
  const source = read("src/components/history/HistoryEmptyState.tsx");
  const selectionBar = read("src/components/history/HistorySelectionBar.tsx");

  // 48px was the one outlier corner on /history — the selection bar is 40px,
  // so the empty state should match it, not stand out as its own radius.
  assert.match(source, /rounded-ios-3xl/);
  assert.doesNotMatch(source, /rounded-ios-4xl/);
  assert.match(selectionBar, /rounded-ios-3xl/);
});

/**
 * Every black-on-near-white text opacity below 0.44 measured under 3:1
 * contrast, and below 0.56 measured under 4.5:1 (WCAG AA normal text) —
 * verified by hand against this app's near-white page background. This
 * page had ~15 different values scattered from 0.20 to 0.40, most of them
 * failing outright (as low as ~1.6:1). Lock the floor so a future edit
 * cannot reintroduce an unreadable caption.
 */
test("history page text never drops below the measured AA contrast floor", () => {
  const files = [
    "src/components/HistoryClient.tsx",
    "src/components/history/HistoryStats.tsx",
    "src/components/history/HistoryFilterBar.tsx",
    "src/components/history/HistoryCard.tsx",
    "src/components/history/HistoryEmptyState.tsx",
    "src/components/history/HistoryGrid.tsx",
    "src/components/history/HistorySelectionBar.tsx",
  ];

  const failingTextColor = /text-\[rgba\(0,0,0,0\.(0[0-9]|[0-3][0-9])\)\]/;

  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, failingTextColor, `${file} still has sub-floor text contrast`);
  }
});

test("history quota/coin text uses a gold tone that actually passes contrast", () => {
  const stats = read("src/components/history/HistoryStats.tsx");
  const card = read("src/components/history/HistoryCard.tsx");

  // rgba(120,90,20,0.55) measured ~2.4:1 — a pale tan easy to miss entirely.
  // 0.85 on the same hue measures ~4.5:1. Card overlay coins sit on a dark
  // hover scrim, so they use a lighter gold (#FFCE73) that reads on black.
  assert.doesNotMatch(stats, /rgba\(120,90,20,0\.55\)/);
  assert.doesNotMatch(card, /rgba\(120,90,20,0\.55\)/);
  assert.match(stats, /rgba\(120,90,20,0\.85\)/);
  assert.match(card, /#FFCE73/);
});

test("a benign missing-image card never uses the same icon as a real failure", () => {
  const source = read("src/components/history/HistoryCard.tsx");

  // Most 本地缓存 entries never had an image to begin with — that's expected,
  // not broken. Reusing the same "broken image" icon for both cases made a
  // page full of ordinary local-only records look like a wall of errors.
  assert.doesNotMatch(source, /ImageOff/);
  assert.match(source, /<AlertTriangle className="h-5 w-5 text-\[#FF3B30\]" \/>/);
  assert.match(source, /<FileQuestion className="h-5 w-5 text-\[rgba\(0,0,0,0\.44\)\]" \/>/);
});

/**
 * Tailwind's bare `color/NN` opacity modifier only resolves NN against the
 * theme's `opacity` scale — which by default only defines multiples of 5
 * (0, 5, 10, ..., 95, 100). This project never overrides that scale, so a
 * modifier like `/74` or `/92` silently compiles to NOTHING: no CSS rule at
 * all, no build warning. The Lightbox's entire dark backdrop (`bg-[#1f2230]
 * /74`) and half its white-on-dark text/icon colors were built entirely out
 * of these silently-dead classes — the modal was, in production, a fully
 * transparent overlay with white text on top of it, over the light page
 * behind. That is exactly "白色背景也是白色根本看不到". Bracket rgba() is a
 * real arbitrary CSS value (no scale lookup), so it always compiles.
 */
test("history lightbox never uses a non-multiple-of-5 opacity modifier", () => {
  const files = [
    "src/components/history/HistoryLightbox.tsx",
    "src/components/history/HistoryCard.tsx",
  ];

  const modifierPattern = /(?:white|black|#[0-9a-fA-F]{3,8})\/(\d{1,3})\b/g;

  for (const file of files) {
    const source = read(file);
    const offenders: string[] = [];
    for (const match of source.matchAll(modifierPattern)) {
      const value = Number(match[1]);
      if (value % 5 !== 0) offenders.push(match[0]);
    }
    assert.deepEqual(offenders, [], `${file} has dead opacity modifiers: ${offenders.join(", ")}`);
  }
});

test("the lightbox backdrop is a real arbitrary color, not a dead scale lookup", () => {
  const source = read("src/components/history/HistoryLightbox.tsx");
  const className = source.match(/className="hist-lightbox-enter[^"]*"/)?.[0] ?? "";

  assert.ok(className, "lightbox root className not found");
  assert.doesNotMatch(className, /bg-\[#1f2230\]\/74/);
  assert.match(className, /bg-\[rgba\(31,34,48,0\.74\)\]/);
});

test("the header count matches what the grid actually renders below it", () => {
  const client = read("src/components/HistoryClient.tsx");

  // history.total is the server's count for the current query and excludes
  // locally-merged cache-only entries; history.entries is what HistoryGrid
  // actually renders. The header count must describe what's on screen.
  assert.match(client, /筛选出 \$\{history\.entries\.length\} 条/);
  assert.match(client, /共 \$\{history\.entries\.length\} 条/);
  assert.doesNotMatch(client, /total=\{history\.total\}/);
});
