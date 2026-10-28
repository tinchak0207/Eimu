// desktop/lib/local-render.js
//
// 本机 agent 的媒体执行面。只产白名单 argv，不 spawn、不读档。
// 模型给的是切段数字，不是 ffmpeg 参数字符串。滤镜里只出现这些数字。

"use strict";

const MAX_CUTS = 48;
const MAX_SEC = 86400;
const MIN_SPEED = 0.25;
const MAX_SPEED = 8;

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * @param {unknown} raw
 * @returns {{ok:true,cuts:{in_sec:number,out_sec:number,speed:number}[]}|{ok:false,message:string}}
 */
function sanitizeCuts(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CUTS) {
    return { ok: false, message: `cuts must be an array of 1..${MAX_CUTS} segments` };
  }
  const cuts = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { ok: false, message: "cut must be an object" };
    const inn = Number(item.in_sec);
    const out = Number(item.out_sec);
    if (!Number.isFinite(inn) || !Number.isFinite(out) || inn < 0 || out > MAX_SEC || !(out > inn)) {
      return { ok: false, message: "cut in_sec/out_sec out of range" };
    }
    let speed = 1;
    if (item.speed !== undefined && item.speed !== null) {
      speed = Number(item.speed);
      if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
        return { ok: false, message: `speed must be ${MIN_SPEED}..${MAX_SPEED}` };
      }
    }
    cuts.push({ in_sec: round3(inn), out_sec: round3(out), speed: round3(speed) });
  }
  return { ok: true, cuts };
}

function buildProbeArgs(input) {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input];
}

function hasAudio(parsed) {
  const streams = parsed && Array.isArray(parsed.streams) ? parsed.streams : [];
  return streams.some((s) => s && s.codec_type === "audio");
}

function summarizeProbe(parsed) {
  const format = parsed && parsed.format && typeof parsed.format === "object" ? parsed.format : {};
  const streams = parsed && Array.isArray(parsed.streams) ? parsed.streams : [];
  const duration = format.duration !== undefined ? Number(format.duration) : null;
  const size = format.size !== undefined ? Number(format.size) : null;
  return {
    duration_sec: Number.isFinite(duration) ? duration : null,
    size: Number.isFinite(size) ? size : null,
    format_name: typeof format.format_name === "string" ? format.format_name : null,
    has_audio: hasAudio(parsed),
    streams: streams.map((s) => ({
      index: s.index,
      codec_type: s.codec_type,
      codec_name: s.codec_name,
      width: s.width,
      height: s.height,
    })),
  };
}

/**
 * @param {string} input
 * @param {string} output
 * @param {{in_sec:number,out_sec:number,speed:number}[]} cuts
 * @param {{audio?: boolean}} [opts]
 */
function buildRenderArgs(input, output, cuts, opts = {}) {
  if (!Array.isArray(cuts) || cuts.length === 0) {
    throw new Error("cuts required");
  }
  const audio = opts.audio !== false;
  const parts = [];
  const labels = [];
  cuts.forEach((c, i) => {
    parts.push(`[0:v]trim=start=${c.in_sec}:end=${c.out_sec},setpts=(PTS-STARTPTS)/${c.speed}[v${i}]`);
    labels.push(`[v${i}]`);
    if (audio) {
      parts.push(`[0:a]atrim=start=${c.in_sec}:end=${c.out_sec},asetpts=(PTS-STARTPTS)/${c.speed}[a${i}]`);
      labels.push(`[a${i}]`);
    }
  });
  const concat = audio
    ? `${labels.join("")}concat=n=${cuts.length}:v=1:a=1[v][a]`
    : `${labels.join("")}concat=n=${cuts.length}:v=1:a=0[v]`;
  const args = [
    "-hide_banner", "-nostdin", "-y",
    "-i", input,
    "-filter_complex", `${parts.join(";")};${concat}`,
    "-map", "[v]",
  ];
  if (audio) args.push("-map", "[a]");
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p",
  );
  if (audio) args.push("-c:a", "aac", "-b:a", "160k");
  args.push("-movflags", "+faststart", output);
  return args;
}

module.exports = {
  MAX_CUTS,
  sanitizeCuts,
  buildProbeArgs,
  buildRenderArgs,
  summarizeProbe,
  hasAudio,
};
