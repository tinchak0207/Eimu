import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Tailwind's bare `color/NN` opacity modifier (e.g. `bg-white/74`,
 * `text-black/58`, `border-[#1f2230]/74`) resolves NN against the theme's
 * `opacity` scale. This project never overrides that scale, so the scale is
 * Tailwind's default: only multiples of 5 (0, 5, 10, ..., 95, 100). Any other
 * fraction — /74, /92, /58, /46, /38, /62, /34, /36, /42, /78, /28, /12, /52,
 * /64, /16, /56... — is not a recognized key, and the class silently compiles
 * to NOTHING. No build error, no warning, just an absent CSS rule.
 *
 * This produced real, shipped bugs: the /history lightbox's entire dark
 * backdrop (`bg-[#1f2230]/74`) was fully transparent in production, turning
 * every white-on-dark control in it into invisible white-on-light-page. The
 * homepage's own zoom lightbox, several shared ui/ primitives (Button,
 * Textarea), ReferenceImageUpload, and ~40 spots in the professional
 * workstation had the same dead classes for backgrounds, borders, and text.
 *
 * The fix is always the same: replace `color/NN` with a bracket value —
 * either an arbitrary color `bg-[rgba(255,255,255,0.74)]` or an arbitrary
 * alpha on the theme token `bg-primary/[0.94]` — which Tailwind treats as a
 * literal with no scale lookup, so it always compiles regardless of the
 * fraction. This test scans every .tsx file under src/ and fails if that
 * dead pattern reappears.
 */

const SRC_ROOT = join(process.cwd(), "src");
// Covers bare color names (white/black), arbitrary hex colors, AND named
// theme colors behind a utility prefix (bg-primary/94, text-foreground/88).
// The utility prefix is required for named colors so ordinary code (x/2 in
// arithmetic, 1k/2k in copy, w-1/2 fractions) never false-positives.
const DEAD_MODIFIER = /\b(?:(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|accent|caret|decoration|shadow)-[a-z0-9-]+|white|black|#[0-9a-fA-F]{3,8})\/(\d{1,3})\b/g;

function listTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...listTsxFiles(full));
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

test("no .tsx file uses a Tailwind opacity modifier outside the default 5-step scale", () => {
  const offendersByFile: Record<string, string[]> = {};

  for (const file of listTsxFiles(SRC_ROOT)) {
    const source = readFileSync(file, "utf8");
    const offenders: string[] = [];
    for (const match of source.matchAll(DEAD_MODIFIER)) {
      const value = Number(match[1]);
      if (value % 5 !== 0) offenders.push(match[0]);
    }
    if (offenders.length) {
      offendersByFile[file.slice(process.cwd().length + 1)] = offenders;
    }
  }

  assert.deepEqual(
    offendersByFile,
    {},
    `Found dead Tailwind opacity modifiers (silently compile to nothing):\n${JSON.stringify(offendersByFile, null, 2)}`,
  );
});
