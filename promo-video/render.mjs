// 逐帧確定性渲染：Chrome 截圖 → ffmpeg。用法：
//   node promo-video/render.mjs stills 1,5.5,12      # 輸出指定時間點靜幀到 out/stills/
//   node promo-video/render.mjs video                 # 全片（WORKERS 路並行 + 動態模糊子幀）
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, "out");
const FPS = Number(process.env.FPS || 60);
const SUB = Number(process.env.SUB || 1);          // 動態模糊子幀數（快門 180°）
const WORKERS = Number(process.env.WORKERS || 4);
const [mode = "stills", arg = "1"] = process.argv.slice(2);
const MODE_STILL = mode === "stills";
fs.mkdirSync(path.join(OUT, "stills"), { recursive: true });

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  args: ["--force-color-profile=srgb", "--hide-scrollbars", "--font-render-hinting=none", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--use-angle=gl", "--allow-file-access-from-files"],
  // 走獨顯 RTX（PRIME offload）
  env: { ...process.env, __NV_PRIME_RENDER_OFFLOAD: "1", __GLX_VENDOR_LIBRARY_NAME: "nvidia", __EGL_VENDOR_LIBRARY_FILENAMES: "/usr/share/glvnd/egl_vendor.d/10_nvidia.json" },
});

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("pageerror", e => console.error("pageerror:", e.message));
  page.on("console", m => { if (m.type() === "error") console.error("console:", m.text()); });
  await page.goto("file://" + path.join(DIR, "index.html"));
  const cues = await page.evaluate(() => window.ready);
  return { page, cues };
}

async function grab(page, t) {
  await page.evaluate(t => window.renderFrame(t), t);
  return page.screenshot({ type: MODE_STILL ? "png" : "jpeg", ...(MODE_STILL ? {} : { quality: 98 }) });
}

if (mode === "stills") {
  const { page, cues } = await openPage();
  fs.writeFileSync(path.join(OUT, "cues.json"), JSON.stringify(cues));
  for (const t of arg.split(",").map(Number)) {
    fs.writeFileSync(path.join(OUT, "stills", `t${t.toFixed(2)}.png`), await grab(page, t));
    console.log("still", t);
  }
} else {
  const { page: p0, cues } = await openPage();
  fs.writeFileSync(path.join(OUT, "cues.json"), JSON.stringify(cues));
  await p0.close();
  const total = Math.round(cues.duration * FPS);
  const per = Math.ceil(total / WORKERS);
  const t0 = Date.now();
  let done = 0;
  const segs = await Promise.all([...Array(WORKERS)].map(async (_, w) => {
    const a = w * per, b = Math.min(total, a + per);
    const file = path.join(OUT, `seg${w}.mkv`);
    const { page } = await openPage();
    // 子幀在 ffmpeg 端用 tmix 平均（線性光近似足夠），輸出幀率 = FPS
    const vf = SUB > 1 ? `tmix=frames=${SUB}:weights=${Array(SUB).fill(1).join(" ")},select='eq(mod(n\\,${SUB})\\,${SUB - 1})',setpts=N/${FPS}/TB` : "null";
    const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS * SUB), "-i", "-",
      "-vf", vf, "-r", String(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-pix_fmt", "yuv420p", "-x264-params", "aq-mode=3", file], { stdio: ["pipe", "inherit", "inherit"] });
    for (let f = a; f < b; f++) {
      for (let s = 0; s < SUB; s++) {
        const t = (f + (SUB > 1 ? (s / SUB - 0.25) * 0.5 : 0)) / FPS;   // 180° 快門：子幀分佈在幀中心 ±1/4 幀
        const buf = await grab(page, Math.max(0, t));
        if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once("drain", r));
      }
      if (++done % 60 === 0) console.log(`${done}/${total} frames  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end();
    await new Promise((res, rej) => ff.on("close", c => c ? rej(new Error("ffmpeg " + c)) : res()));
    await page.close();
    return file;
  }));
  fs.writeFileSync(path.join(OUT, "segs.txt"), segs.map(s => `file '${s}'`).join("\n"));
  console.log("render done", ((Date.now() - t0) / 1000).toFixed(0) + "s");
}
await browser.close();
