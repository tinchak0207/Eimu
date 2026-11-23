// 冻结镜像里的 directVideoPrompt（chunk 2291.js 的 function p）会改写每一条普通视频 prompt。
// 官方 H3 Content IR 已是完整提交字符串，命中栏位就原样返回。幂等，只动 function p 的入口。
const fs = require("fs");

const CHUNK = "/app/.next/server/chunks/2291.js";
const NEEDLE = "function p(a,b={}){let c=a.trim();if(!c)return c;";
const INSERT =
  "if(/^integrated_multimodal_description\\s*:/m.test(c)&&/^overall_soundscape\\s*:/m.test(c)&&/^non_diegetic_music\\s*:/m.test(c))return c;" +
  "if(/^subject_definitions\\s*:/m.test(c)&&/^detailed_description\\s*:/m.test(c)&&/^overall_soundscape\\s*:/m.test(c))return c;";

const text = fs.readFileSync(CHUNK, "utf8");
const hits = text.split(NEEDLE).length - 1;
if (hits !== 1) {
  console.error("ABORT needle count=" + hits + " file=" + CHUNK);
  process.exit(1);
}
const oBefore = (text.match(/function o\(/g) || []).length;
if (text.includes(NEEDLE + INSERT)) {
  if (oBefore < 1) {
    console.error("ABORT function o missing on already-patched chunk");
    process.exit(1);
  }
  console.log("ALREADY");
  process.exit(0);
}
const next = text.replace(NEEDLE, NEEDLE + INSERT);
const oAfter = (next.match(/function o\(/g) || []).length;
if (next === text || oAfter !== oBefore || !next.includes(NEEDLE + INSERT)) {
  console.error("ABORT patch did not land cleanly");
  process.exit(1);
}
fs.writeFileSync(CHUNK, next);
console.log("PATCHED");
