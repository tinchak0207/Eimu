"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeCuts, buildRenderArgs, buildProbeArgs } = require("./local-render.js");

test("sanitizeCuts 只留数字切段，拒绝滤镜字符串", () => {
  const ok = sanitizeCuts([{ in_sec: 0, out_sec: 2, speed: 4 }, { in_sec: 8, out_sec: 11 }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.cuts, [
    { in_sec: 0, out_sec: 2, speed: 4 },
    { in_sec: 8, out_sec: 11, speed: 1 },
  ]);
  assert.equal(sanitizeCuts([{ in_sec: 0, out_sec: 2, speed: 100 }]).ok, false);
  assert.equal(sanitizeCuts("trim=0:1").ok, false);
});

test("render argv 不含 shell，切段只出现在 filter_complex", () => {
  const cuts = sanitizeCuts([{ in_sec: 0, out_sec: 3, speed: 4 }]);
  const args = buildRenderArgs("/home/a/in.mp4", "/home/a/out.mp4", cuts.cuts, { audio: true });
  assert.equal(args.includes("-filter_complex"), true);
  assert.equal(args.includes("trim=start=0:end=3"), false);
  assert.match(args[args.indexOf("-filter_complex") + 1], /trim=start=0:end=3/);
  assert.equal(args.at(-1), "/home/a/out.mp4");
  assert.deepEqual(buildProbeArgs("/home/a/in.mp4").slice(0, 3), ["-v", "error", "-print_format"]);
});
