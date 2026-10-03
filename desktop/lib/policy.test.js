// desktop/lib/policy.test.js
//
// W3 純函式測試。跑法（依 spec）：
//   npx --yes tsx --test desktop/lib/policy.test.js
//
// 全部用 node:test + node:assert，無外部依賴。

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const policy = require("./policy.js");
// denylist 唯一真源＝雲端向量表（不 import TS 模組、本機不再自帶第二份 JSON）。
// 從 desktop/lib 往上兩層到 repo 根，再進 deploy-staging/gateway。
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
test("isSensitivePath: denylist 目錄本身與其下皆拒", () => {
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

test("isSensitivePath: denylist 檔案與 ~ 展開", () => {
  assert.equal(isSensitivePath("~/.git-credentials", HOME, "linux"), true);
  assert.equal(isSensitivePath("~/.netrc", HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.npmrc`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.pgpass`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.bash_history`, HOME, "linux"), true);
  assert.equal(isSensitivePath(`${HOME}/.zsh_history`, HOME, "linux"), true);
});

test("isSensitivePath: 一般檔案不誤殺；無法解析 fail-closed", () => {
  assert.equal(isSensitivePath(`${HOME}/Downloads/clip.mp4`, HOME, "linux"), false);
  assert.equal(isSensitivePath("/tmp/eimu/movie.mov", HOME, "linux"), false);
  // H3：家目錄外**也**要判敏感（掃所有路徑段，與雲端 device-bridge-policy.ts 同語義）。
  assert.equal(isSensitivePath("/home/other/.ssh/id_rsa", HOME, "linux"), true);
  assert.equal(isSensitivePath("/tmp/x/.ssh/id_rsa", HOME, "linux"), true);
  assert.equal(isSensitivePath("/mnt/data/proj/.aws/credentials", HOME, "linux"), true);
  assert.equal(isSensitivePath("", HOME, "linux"), true);
  assert.equal(isSensitivePath(null, HOME, "linux"), true);
  assert.equal(isSensitivePath("a\0b", HOME, "linux"), true);
  assert.equal(isSensitivePath("~/x", null, "linux"), true); // 無法展開 home → fail-closed
});

// ---------------------------------------------------------------------------
// denylist 唯一真源 = 雲端向量表（device-bridge-policy.vectors.json）
// ---------------------------------------------------------------------------
test("denylist: 本機實作逐條滿足雲端真源向量表（sensitive 段）", () => {
  assert.ok(Array.isArray(cloudVectors.sensitive) && cloudVectors.sensitive.length >= 30, "雲端向量表 sensitive 段應存在");
  for (const v of cloudVectors.sensitive) {
    assert.equal(
      isSensitivePath(v.path, HOME, "linux"),
      v.expected,
      `sensitive[${v.category}]: ${JSON.stringify(v.path)} expected=${v.expected}`,
    );
  }
});

// 本機**刻意更嚴**的加固項（保守超集，只多擋不鬆綁；不進雲端真源檔）。
// 理由：本機殼層額外把 `.mozilla` 整個段、`.config/{gcloud,gh,git,code,electron}`
// 序列、`.python_history` 視為敏感（憑證/設定/profile 洩漏面），雲端未列但本機一律拒。
test("denylist: 本機刻意更嚴的加固項逐條斷言（不上真源檔）", () => {
  const localStricter = [
    [`${HOME}/.mozilla/other/x`, true, "整個 .mozilla 段（不限 firefox 序列）"],
    [`${HOME}/.config/gh/hosts.yml`, true, "gh CLI 憑證序列 .config/gh"],
    [`${HOME}/.config/git/config`, true, "git 設定序列 .config/git"],
    [`${HOME}/.config/gcloud/credentials.db`, true, "gcloud 憑證序列 .config/gcloud"],
    [`${HOME}/.config/Code/User/settings.json`, true, "編輯器設定序列 .config/code（大小寫折疊）"],
    [`${HOME}/.config/Electron/x`, true, "Electron profile 序列 .config/electron"],
    [`${HOME}/.python_history`, true, "額外敏感檔名 .python_history"],
  ];
  for (const [p, expected, why] of localStricter) {
    assert.equal(isSensitivePath(p, HOME, "linux"), expected, `${p} — ${why}`);
  }
});

// ---------------------------------------------------------------------------
// allowedRoots 邊界
// ---------------------------------------------------------------------------
test("isPathAllowed: 剛挑選的檔案本身與其目錄下的路徑放行", () => {
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

test("isPathAllowed: 前綴混淆 /home/u/allowed-evil 被拒", () => {
  const roots = [`${HOME}/allowed`];
  assert.equal(isPathAllowed(`${HOME}/allowed-evil/x.mp4`, roots, POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/allowed_evil/x.mp4`, roots, POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/allowed2`, roots, POSIX), false);
});

test("isPathAllowed: 授權根外的絕對路徑與敏感路徑被拒", () => {
  const roots = [`${HOME}/Movies`];
  assert.equal(isPathAllowed(`${HOME}/Documents/x.mp4`, roots, POSIX), false);
  assert.equal(isPathAllowed("/etc/passwd", roots, POSIX), false);
  assert.equal(isPathAllowed("", roots, POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/Movies/x.mp4`, [], POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/Movies/x.mp4`, null, POSIX), false);
});

test("isPathAllowed: 敏感路徑即使在授權根之下仍拒", () => {
  const roots = [`${HOME}/`]; // 挑選整個家目錄也不得放行 .ssh
  assert.equal(isPathAllowed(`${HOME}/.ssh/id_rsa`, roots, POSIX), false);
  assert.equal(isPathAllowed(`${HOME}/.bash_history`, roots, POSIX), false);
});

test("isPathAllowed: 敏感根本身不被當作有效授權根", () => {
  const roots = [`${HOME}/.ssh`, `${HOME}/Movies`];
  assert.equal(isPathAllowed(`${HOME}/.ssh/id_rsa`, roots, POSIX), false); // 因 isSensitivePath 直接拒
  assert.equal(isPathAllowed(`${HOME}/Movies/a.mp4`, roots, POSIX), true);
});

// ---------------------------------------------------------------------------
// origin host 驗證
// ---------------------------------------------------------------------------
test("isAppHost: 僅收 APP_HOSTS；不可解析拒", () => {
  const hosts = new Set(["www.eimu.dev", "eimu.dev"]);
  assert.equal(isAppHost("https://www.eimu.dev/studio", hosts), true);
  assert.equal(isAppHost("https://eimu.dev/a", hosts), true);
  assert.equal(isAppHost("https://evil.com/?x=www.eimu.dev", hosts), false);
  assert.equal(isAppHost("https://sub.www.eimu.dev/", hosts), false);
  assert.equal(isAppHost("file:///tmp/x.html", hosts), false);
  // M1：file:// 帶 App host 也算冒充（new URL(...).host === "www.eimu.dev"）⇒ 必拒。
  assert.equal(isAppHost("file://www.eimu.dev/x", hosts), false);
  assert.equal(isAppHost("file://www.eimu.dev/api/auth/github", hosts), false);
  assert.equal(isAppHost("javascript://www.eimu.dev/x", hosts), false);
  assert.equal(isAppHost("not a url", hosts), false);
});

// ---------------------------------------------------------------------------
// ffmpeg 候選表 fallback
// ---------------------------------------------------------------------------
test("pickFfmpegCandidate: linux 候選表含 harness 路徑、HOME 展開、PATH 後備", () => {
  const list = pickFfmpegCandidate({ HOME: "/home/tester" }, "linux");
  assert.equal(list[0], "/opt/agent-harness/bin/ffmpeg");
  assert.ok(list.includes("/home/tester/.kunpeng/bin/ffmpeg"));
  assert.ok(list.includes("/opt/homebrew/bin/ffmpeg"));
  assert.ok(list.includes("/usr/local/bin/ffmpeg"));
  assert.equal(list[list.length - 1], "ffmpeg");
});

test("pickFfmpegCandidate: EIMU_FFMPEG 置頂", () => {
  const list = pickFfmpegCandidate({ HOME: "/home/tester", EIMU_FFMPEG: "/custom/ffmpeg" }, "linux");
  assert.equal(list[0], "/custom/ffmpeg");
});

test("pickFfmpegCandidate: win32 候選表含 ffmpeg.exe 與 USERPROFILE 展開", () => {
  const list = pickFfmpegCandidate({ USERPROFILE: "C:\\Users\\tester" }, "win32");
  assert.equal(list[0], "ffmpeg");
  assert.ok(list.includes("ffmpeg.exe"));
  assert.ok(list.some((p) => p.includes(".kunpeng") && p.includes("ffmpeg.exe")));
  assert.ok(list.some((p) => p.includes("WinGet") && p.includes("ffmpeg.exe")));
});

// ---------------------------------------------------------------------------
// argv 固定性 / 注入
// ---------------------------------------------------------------------------
test("buildFfmpegArgs: transcode argv 固定，注入字串不變成額外參數", () => {
  const evil = "/tmp/in; rm -rf / #.mp4";
  const out = buildFfmpegArgs("transcode", evil, "/tmp/out.mp4", {});
  // input 必須是單一陣列元素，`;` 不會拆成新參數
  assert.equal(out[out.indexOf("-i") + 1], evil);
  assert.ok(!out.includes("rm"));
  assert.ok(!out.includes("-rf"));
  assert.ok(out.includes("-c:v"));
  assert.equal(out[out.length - 1], "/tmp/out.mp4");
  // argv 每個元素皆字串
  assert.ok(out.every((a) => typeof a === "string"));
});

test("buildFfmpegArgs: output 注入同樣只是單一元素", () => {
  const out = buildFfmpegArgs("transcode", "/tmp/in.mp4", "/tmp/out $(whoami).mp4", {});
  assert.equal(out[out.length - 1], "/tmp/out $(whoami).mp4");
  assert.ok(!out.includes("whoami"));
});

test("buildFfmpegArgs: 非白名單 codec/preset/crf 一律拒（非靜默丟棄）", () => {
  assert.throws(() => buildFfmpegArgs("transcode", "/a", "/b", { videoCodec: "libx264; rm -rf /" }), LocalError);
  assert.throws(() => buildFfmpegArgs("transcode", "/a", "/b", { preset: "-i /etc/passwd" }), LocalError);
  assert.throws(() => buildFfmpegArgs("transcode", "/a", "/b", { crf: 999 }), LocalError);
  assert.throws(() => buildFfmpegArgs("transcode", "/a", "/b", { crf: "23; ls" }), LocalError);
  assert.throws(() => buildFfmpegArgs("transcode", "/a", "/b", { maxWidth: 4 }), LocalError);
  assert.throws(() => buildFfmpegArgs("transcode", "", "/b", {}), LocalError);
  assert.throws(() => buildFfmpegArgs("bogus", "/a", "/b", {}), LocalError);
});

test("buildFfmpegArgs: 白名單值與數值正確落位", () => {
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

test("buildFfmpegArgs: copy 模式與 frame 模式", () => {
  const copy = buildFfmpegArgs("transcode", "/a.mkv", "/b.mp4", { copy: true });
  assert.deepEqual(copy, ["-hide_banner", "-nostdin", "-y", "-i", "/a.mkv", "-c", "copy", "/b.mp4"]);
  const frame = buildFfmpegArgs("frame", "/a.mp4", "/f.jpg", { tSec: 12.5, maxWidth: 480 });
  assert.equal(frame[frame.indexOf("-ss") + 1], "12.5");
  assert.equal(frame[frame.indexOf("-frames:v") + 1], "1");
  assert.equal(frame[frame.indexOf("-vf") + 1], "scale=480:-2");
  assert.equal(frame[frame.length - 1], "/f.jpg");
});

test("normalizeTranscodeOptions: webm 自動改用 vp9/opus", () => {
  const o = normalizeTranscodeOptions({ format: "webm" });
  assert.equal(o.videoCodec, "libvpx-vp9");
  assert.equal(o.audioCodec, "libopus");
});

// ---------------------------------------------------------------------------
// 抽幀計畫
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
// pickFiles 選項
// ---------------------------------------------------------------------------
test("sanitizePickOptions: kind 白名單、filters 清洗", () => {
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
test("FfmpegGate: 併發上限與喚醒", async () => {
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

test("FfmpegGate: 記憶體門檻不足時排隊，恢復後放行", async () => {
  let mem = 100; // 低於 minMemMB
  const gate = new FfmpegGate({ maxConcurrent: 1, minMemMB: 400, memAvailableMB: () => mem });
  let done = false;
  const p = gate.run(async () => { done = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false); // 被記憶體門檻擋住
  mem = 1000;
  gate._wakeAll(); // 模擬壓力恢復後的重評估
  await p;
  assert.equal(done, true);
});

test("FfmpegGate: maxConcurrent=0 關閉限流", async () => {
  const gate = new FfmpegGate({ maxConcurrent: 0, minMemMB: 0, memAvailableMB: () => 0 });
  await gate.acquire();
  assert.equal(gate.stats().active, 1); // 無視記憶體門檻（throttling off）
  gate.release();
});

test("FfmpegGate: run 在 fn 拋錯時仍釋放 slot", async () => {
  const gate = new FfmpegGate({ maxConcurrent: 1, minMemMB: 0, memAvailableMB: () => 1000 });
  await assert.rejects(gate.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(gate.stats().active, 0);
});
