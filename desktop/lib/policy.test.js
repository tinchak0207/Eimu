// desktop/lib/policy.test.js
//
// W3 纯函式测试。跑法（依 spec）：
//   npx --yes tsx --test desktop/lib/policy.test.js
//
// 全部用 node:test + node:assert，无外部依赖。

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const policy = require("./policy.js");
// denylist 唯一真源＝云端向量表（不 import TS 模组、本机不再自带第二份 JSON）。
// 从 desktop/lib 往上两层到 repo 根，再进 deploy-staging/gateway。
const VECTORS_PATH = path.join(__dirname, "..", "..", "deploy-staging", "gateway", "device-bridge-policy.vectors.json");
const cloudVectors = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8"));
const {
  LocalError,
  isSensitivePath,
  isPathAllowed,
  isAppHost,
  pickFfmpegCandidate,
  buildFfmpegArgs,
  normalizeTranscodeOptions,
  sanitizeFramePlan,
  resolveFrameTimes,
  sanitizePickOptions,
  FfmpegGate,
} = policy;

const HOME = "/home/tester";
const POSIX = { home: HOME, platform: "linux" };

// ---------------------------------------------------------------------------
// denylist
// ---------------------------------------------------------------------------
test("isSensitivePath: denylist 目录本身与其下皆拒", () => {
  assert.equal(isSensitivePath(`${HOME}/.ssh/id_rsa`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.ssh`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.ssh/nested/deep/key`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.aws/credentials`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.gnupg/secring.gpg`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.kube/config`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.docker/config.json`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.config/google-chrome/Default/Login Data`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.mozilla/firefox/x/cookies.sqlite`, HOME, "linux"), true);
});

test("isSensitivePath: denylist 档案与 ~ 展开", () => {
  assert.equal(isSensitivePath("~/.git-credentials", HOME, "linux"), true);
  assert.equal(isSensitivePath("~/.netrc", HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.npmrc`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.pgpass`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.bash_history`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.zsh_history`, HOME, "linux"), true);
});

test("isSensitivePath: 一般档案不误杀；无法解析 fail-closed", () => {
  assert.equal(isSensitivePath(`${HOME}/Downloads/clip.mp4`, HOME, "linux"), false);
  assert.equal(isSensitivePath("/tmp/eimu/movie.mov", HOME, "linux"), false);
  // H3：家目录外**也**要判敏感（扫所有路径段，与云端 device-bridge-policy.ts 同语义）。
  assert.equal(isSensitivePath("/home/other/.ssh/id_rsa", HOME, "linux"), true);
  assert.equal(isSensitivePath("/tmp/x/.ssh/id_rsa", HOME, "linux"), true);
  assert.equal(isSensitivePath("/mnt/data/proj/.aws/credentials", HOME, "linux"), true);
  assert.equal(isSensitivePath("", HOME, "linux"), true);
  assert.equal(isSensitivePath(null, HOME, "linux"), true);
  assert.equal(isSensitivePath("a\0b", HOME, "linux"), true);
  assert.equal(isSensitivePath("~/x", null, "linux"), true); // 无法展开 home → fail-closed
});

// ---------------------------------------------------------------------------
// denylist 唯一真源 = 云端向量表（device-bridge-policy.vectors.json）
// ---------------------------------------------------------------------------
test("denylist: 本机实作逐条满足云端真源向量表（sensitive 段）", () => {
  assert.ok(Array.isArray(cloudVectors.sensitive) && cloudVectors.sensitive.length >= 30, "云端向量表 sensitive 段应存在");
  for (const v of cloudVectors.sensitive) {
    assert.equal(
      isSensitivePath(v.path, HOME, "linux"),
      v.expected,
      `sensitive[${v.category}]: ${JSON.stringify(v.path)} expected=${v.expected}`,
    );
  }
});

// 本机**刻意更严**的加固项（保守超集，只多挡不松绑；不进云端真源档）。
// 理由：本机壳层额外把 `.mozilla` 整个段、`.config/{gcloud,gh,git,code,electron}`
// 序列、`.python_history` 视为敏感（凭证/设定/profile 泄漏面），云端未列但本机一律拒。
test("denylist: 本机刻意更严的加固项逐条断言（不上真源档）", () => {
  const localStricter = [
    [`${HOME}/.mozilla/other/x`, true, "整个 .mozilla 段（不限 firefox 序列）"],
    [`${HOME}/.config/gh/hosts.yml`, true, "gh CLI 凭证序列 .config/gh"],
    [`${HOME}/.config/git/config`, true, "git 设定序列 .config/git"],
    [`${HOME}/.config/gcloud/credentials.db`, true, "gcloud 凭证序列 .config/gcloud"],
    [`${HOME}/.config/Code/User/settings.json`, true, "编辑器设定序列 .config/code（大小写折叠）"],
    [`${HOME}/.config/Electron/x`, true, "Electron profile 序列 .config/electron"],
    [`${HOME}/.python_history`, true, "额外敏感档名 .python_history"],
  ];
  for (const [p, expected, why] of localStricter) {
    assert.equal(isSensitivePath(p, HOME, "linux"), expected, `${p} — ${why}`);
  }
});

// ---------------------------------------------------------------------------
// allowedRoots 边界
// ---------------------------------------------------------------------------
test("isPathAllowed: 刚挑选的档案本身与其目录下的路径放行", () => {
  const roots = [`${HOME}/Movies`, `${HOME}/clips/a.mp4`];
  assert.equal(isPathAllowed(`${HOME}/clips/a.mp4`, roots, POSIX), true);
  assert.equal(isPathAllowed(`${HOME}/Movies/v1/take.mp4`, roots, POSIX), true);
  assert.equal(isPathAllowed(`${HOME}/Movies`, roots, POSIX), true);
});

test("isPathAllowed: .. 逃逸被拒", () => {
  const roots = [`${HOME}/allowed`];
  assert.equal(isPathAllowed(`${HOME}/allowed/../secret.txt`, roots, POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/allowed/sub/../../secret.txt`, roots, POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/allowed/./ok.mp4`, roots, POSIX), true);
});

test("isPathAllowed: 前缀混淆 /home/u/allowed-evil 被拒", () => {
  const roots = [`${HOME}/allowed`];
  assert.equal(isPathAllowed(`${HOME}/allowed-evil/x.mp4`, roots, POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/allowed_evil/x.mp4`, roots, POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/allowed2`, roots, POSIX), false);
});

test("isPathAllowed: 授权根外的绝对路径与敏感路径被拒", () => {
  const roots = [`${HOME}/Movies`];
  assert.equal(isPathAllowed(`${HOME}/Documents/x.mp4`, roots, POSIX), false);
  assert.equal(isPathAllowed("/etc/passwd", roots, POSIX), false);
  assert.equal(isPathAllowed("", roots, POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/Movies/x.mp4`, [], POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/Movies/x.mp4`, null, POSIX), false);
});

test("isPathAllowed: 敏感路径即使在授权根之下仍拒", () => {
  const roots = [`${HOME}/`]; // 挑选整个家目录也不得放行 .ssh
  assert.equal(isPathAllowed(`${HOME}/.ssh/id_rsa`, roots, POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/.bash_history`, roots, POSIX), false);
});

test("isPathAllowed: 敏感根本身不被当作有效授权根", () => {
  const roots = [`${HOME}/.ssh`, `${HOME}/Movies`];
  assert.equal(isPathAllowed(`${HOME}/.ssh/id_rsa`, roots, POSIX), false); // 因 isSensitivePath 直接拒
  assert.equal(isPathAllowed(`${HOME}/Movies/a.mp4`, roots, POSIX), true);
});

// ---------------------------------------------------------------------------
// origin host 验证
// ---------------------------------------------------------------------------
test("isAppHost: 仅收 APP_HOSTS；不可解析拒", () => {
  const hosts = new Set(["www.eimu.dev", "eimu.dev"]);
  assert.equal(isAppHost("https://www.eimu.dev/studio", hosts), true);
  assert.equal(isAppHost("https://eimu.dev/a", hosts), true);
  assert.equal(isAppHost("https://evil.com/?x=www.eimu.dev", hosts), false);
  assert.equal(isAppHost("https://sub.www.eimu.dev/", hosts), false);
  assert.equal(isAppHost("file:///tmp/x.html", hosts), false);
  // M1：file:// 带 App host 也算冒充（new URL(...).host === "www.eimu.dev"）⇒ 必拒。
  assert.equal(isAppHost("file://www.eimu.dev/x", hosts), false);
  assert.equal(isAppHost("file://www.eimu.dev/api/auth/github", hosts), false);
  assert.equal(isAppHost("javascript://www.eimu.dev/x", hosts), false);
  assert.equal(isAppHost("not a url", hosts), false);
});

// ---------------------------------------------------------------------------
// ffmpeg 候选表 fallback
// ---------------------------------------------------------------------------
test("pickFfmpegCandidate: linux 候选表含 harness 路径、HOME 展开、PATH 后备", () => {
  const list = pickFfmpegCandidate({ HOME: "/home/tester" }, "linux");
  assert.equal(list[0], "/opt/eimu-harness/bin/ffmpeg");
  assert.ok(list.includes("/home/tester/.kunpeng/bin/ffmpeg"));
  assert.ok(list.includes("/opt/homebrew/bin/ffmpeg"));
  assert.ok(list.includes("/usr/local/bin/ffmpeg"));
  assert.equal(list[list.length - 1], "ffmpeg");
});

test("pickFfmpegCandidate: EIMU_FFMPEG 置顶", () => {
  const list = pickFfmpegCandidate({ HOME: "/home/tester", EIMU_FFMPEG: "/custom/ffmpeg" }, "linux");
  assert.equal(list[0], "/custom/ffmpeg");
});

test("pickFfmpegCandidate: win32 候选表含 ffmpeg.exe 与 USERPROFILE 展开", () => {
  const list = pickFfmpegCandidate({ USERPROFILE: "C:\\Users\\tester" }, "win32");
  assert.equal(list[0], "ffmpeg");
  assert.ok(list.includes("ffmpeg.exe"));
  assert.ok(list.some((p) => p.includes(".kunpeng") && p.includes("ffmpeg.exe")));
  assert.ok(list.some((p) => p.includes("WinGet") && p.includes("ffmpeg.exe")));
});

// ---------------------------------------------------------------------------
// argv 固定性 / 注入
// ---------------------------------------------------------------------------
test("buildFfmpegArgs: transcode argv 固定，注入字串不变成额外参数", () => {
  const evil = "/tmp/in; rm -rf / #.mp4";
  const out = buildFfmpegArgs("transcode", evil, "/tmp/out.mp4", {});
  // input 必须是单一阵列元素，`;` 不会拆成新参数
  assert.equal(out[out.indexOf("-i") + 1], evil);
  assert.ok(!out.includes("rm"));
  assert.ok(!out.includes("-rf"));
  assert.ok(out.includes("-c:v"));
  assert.equal(out[out.length - 1], "/tmp/out.mp4");
  // argv 每个元素皆字串
  assert.ok(out.every((a) => typeof a === "string"));
});

test("buildFfmpegArgs: output 注入同样只是单一元素", () => {
  const out = buildFfmpegArgs("transcode", "/tmp/in.mp4", "/tmp/out $(whoami).mp4", {});
  assert.equal(out[out.length - 1], "/tmp/out $(whoami).mp4");
  assert.ok(!out.includes("whoami"));
});

test("buildFfmpegArgs: 非白名单 codec/preset/crf 一律拒（非静默丢弃）", () => {
  assert.throws(() => buildFfmpegArgs("transcode", "/a", "/b", { videoCodec: "libx264; rm -rf /" }), LocalError);
  assert.throws(() => buildFfmpegArgs("transcode", "/a", "/b", { preset: "-i /etc/passwd" }), LocalError);
  assert.throws(() => buildFfmpegArgs("transcode", "/a", "/b", { crf: 999 }), LocalError);
  assert.throws(() => buildFfmpegArgs("transcode", "/a", "/b", { crf: "23; ls" }), LocalError);
  assert.throws(() => buildFfmpegArgs("transcode", "/a", "/b", { maxWidth: 4 }), LocalError);
  assert.throws(() => buildFfmpegArgs("transcode", "", "/b", {}), LocalError);
  assert.throws(() => buildFfmpegArgs("bogus", "/a", "/b", {}), LocalError);
});

test("buildFfmpegArgs: 白名单值与数值正确落位", () => {
  const out = buildFfmpegArgs("transcode", "/a.mp4", "/b.mp4", {
    videoCodec: "libx264", preset: "fast", crf: 20, audioBitrateKbps: 96, maxWidth: 1280, faststart: true,
  });
  assert.deepEqual(out.slice(0, 5), ["-hide_banner", "-nostdin", "-y", "-i", "/a.mp4"]);
  assert.equal(out[out.indexOf("-c:v") + 1], "libx264");
  assert.equal(out[out.indexOf("-preset") + 1], "fast");
  assert.equal(out[out.indexOf("-crf") + 1], "20");
  assert.equal(out[out.indexOf("-vf") + 1], "scale=1280:-2");
  assert.equal(out[out.indexOf("-movflags") + 1], "+faststart");
});

test("buildFfmpegArgs: copy 模式与 frame 模式", () => {
  const copy = buildFfmpegArgs("transcode", "/a.mkv", "/b.mp4", { copy: true });
  assert.deepEqual(copy, ["-hide_banner", "-nostdin", "-y", "-i", "/a.mkv", "-c", "copy", "/b.mp4"]);
  const frame = buildFfmpegArgs("frame", "/a.mp4", "/f.jpg", { tSec: 12.5, maxWidth: 480 });
  assert.equal(frame[frame.indexOf("-ss") + 1], "12.5");
  assert.equal(frame[frame.indexOf("-frames:v") + 1], "1");
  assert.equal(frame[frame.indexOf("-vf") + 1], "scale=480:-2");
  assert.equal(frame[frame.length - 1], "/f.jpg");
});

test("normalizeTranscodeOptions: webm 自动改用 vp9/opus", () => {
  const o = normalizeTranscodeOptions({ format: "webm" });
  assert.equal(o.videoCodec, "libvpx-vp9");
  assert.equal(o.audioCodec, "libopus");
});

// ---------------------------------------------------------------------------
// 抽帧计画
// ---------------------------------------------------------------------------
test("sanitizeFramePlan / resolveFrameTimes", () => {
  assert.deepEqual(sanitizeFramePlan(null), { count: 8, timesSec: null, maxWidth: 720 });
  assert.throws(() => sanitizeFramePlan({ count: 999 }), LocalError);
  assert.throws(() => sanitizeFramePlan({ timesSec: [] }), LocalError);
  assert.throws(() => sanitizeFramePlan({ timesSec: [1, -2] }), LocalError);
  const plan = sanitizeFramePlan({ timesSec: [0, 1.5] });
  assert.deepEqual(resolveFrameTimes(100, plan), [0, 1.5]);
  const even = resolveFrameTimes(10, { count: 2, timesSec: null, maxWidth: 720 });
  assert.deepEqual(even, [2.5, 7.5]);
  assert.deepEqual(resolveFrameTimes(10, { count: 1, timesSec: null, maxWidth: 720 }), [5]);
});

// ---------------------------------------------------------------------------
// pickFiles 选项
// ---------------------------------------------------------------------------
test("sanitizePickOptions: kind 白名单、filters 清洗", () => {
  assert.deepEqual(sanitizePickOptions(null), { kind: "files", multiple: true, filters: [] });
  const o = sanitizePickOptions({ kind: "directory", multiple: false, filters: [{ name: "Video", extensions: ["mp4", "mov"] }, { bad: true }] });
  assert.equal(o.kind, "directory");
  assert.equal(o.multiple, false);
  assert.deepEqual(o.filters, [{ name: "Video", extensions: ["mp4", "mov"] }]);
  const inj = sanitizePickOptions({ filters: [{ name: "x", extensions: ["mp4; rm -rf /"] }] });
  assert.deepEqual(inj.filters[0].extensions, []);
});

// ---------------------------------------------------------------------------
// FfmpegGate
// ---------------------------------------------------------------------------
test("FfmpegGate: 并发上限与唤醒", async () => {
  const gate = new FfmpegGate({ maxConcurrent: 2, minMemMB: 0, memAvailableMB: () => 100000 });
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    await gate.acquire();
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    gate.release();
  };
  await Promise.all([task(), task(), task(), task(), task()]);
  assert.equal(maxActive, 2);
  assert.equal(gate.stats().active, 0);
  assert.equal(gate.stats().queued, 0);
});

test("FfmpegGate: 记忆体门槛不足时排队，恢复后放行", async () => {
  let mem = 100; // 低于 minMemMB
  const gate = new FfmpegGate({ maxConcurrent: 1, minMemMB: 400, memAvailableMB: () => mem });
  let done = false;
  const p = gate.run(async () => { done = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false); // 被记忆体门槛挡住
  mem = 1000;
  gate._wakeAll(); // 模拟压力恢复后的重评估
  await p;
  assert.equal(done, true);
});

test("FfmpegGate: maxConcurrent=0 关闭限流", async () => {
  const gate = new FfmpegGate({ maxConcurrent: 0, minMemMB: 0, memAvailableMB: () => 0 });
  await gate.acquire();
  assert.equal(gate.stats().active, 1); // 无视记忆体门槛（throttling off）
  gate.release();
});

test("FfmpegGate: run 在 fn 抛错时仍释放 slot", async () => {
  const gate = new FfmpegGate({ maxConcurrent: 1, minMemMB: 0, memAvailableMB: () => 1000 });
  await assert.rejects(gate.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(gate.stats().active, 0);
});
