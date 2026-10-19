// tools/prune-desktop-releases.mjs
//
// ─────────────────────────────────────────────────────────────────────────────
// Eimu 桌面版发行产物「滚动清理」工具
// ─────────────────────────────────────────────────────────────────────────────
//
// 【用途】
//   Vercel Blob（Hobby 方案）只有 1 GiB 硬配额（1,073,741,824 bytes）。Eimu 桌面版
//   每版两平台产物约 240 MB（Linux AppImage ≈126 MB＋Windows exe ≈112 MB），两版就
//   吃掉半个 store，累积几版就会撞线。本工具把 store 内 `desktop/Eimu-*` 的发行产物
//   滚动清理到「只留最近 N 个版本」（预设 N=2），确保永远有空间发下一版。
//
// 【在发行流程中的位置】
//   1. 发新版「前」：先跑本工具（可加 `--keep 1` 的等价效果，或直接保留到只剩 N-1 个
//      旧版），把旧版清掉，让新产物有空间上传。
//   2. 上传新产物、验收（下载回来比对 size／sha256，见记忆
//      2026-10-04-vercel-blob-put-fixed-pathname）。
//   3. 验收后再跑一次干跑确认 store 内刚好只剩 ≤ N 个版本，避免无声累积。
//
// 【为什么必须这样做（2026-10-04 事故）】
//   Vercel Blob Hobby 方案跨过 1 GiB 配额后，平台不是只拒绝「那一笔上传」——它会把
//   **整个 store 停用**（status: limits-exceeded-suspended）：此后每一个物件对外都是
//   403（含 latest*.yml feed），且**删档不会解封**，官方说法是必须等满 30 天或升级
//   Pro 才能解除。当日已达 324 物件／1,116,478,479 B，导致站内下载钮与自动更新 feed
//   全断。因此清理必须是「发行前的常态步骤」，不能等上传失败才做。
//
// 【保留集合（安全锁）】
//   保留 = 最新 N 个版本 ∪ `src/lib/desktop-releases.ts` 内出现的任何版本。
//   后者是硬性安全锁：任何正在对外宣传（下载按钮指向）的版本，即使不在最新 N 个内
//   也绝不能被删——否则使用者点下载会 404。
//
// 【红线（绝对不删）】
//   - 任何 pathname 不在 `desktop/` 前缀下的物件（history/** 使用者图片、admin/** 等）。
//   - 任何档名结尾是 `latest-linux.yml`／`latest.yml`／`latest*.yml` 的 feed 档。
//   见下方 isDeletableArtifact() 内的明确注解。
//
// 【用法】
//   node tools/prune-desktop-releases.mjs            # 干跑（预设，只印计画，不删）
//   node tools/prune-desktop-releases.mjs --apply    # 真的删（破坏性，需项目负责人下令）
//   node tools/prune-desktop-releases.mjs --keep 3   # 保留最近 3 个版本
//
// 【凭证】
//   读 repo 的 `.env.pulled` 内 `BLOB_READ_WRITE_TOKEN`。值常被引号包住，必须去引号
//   （否则 SDK 回 BlobAccessError）。token 值不得印出。
// ─────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const BLOB_LIMIT_BYTES = 1_073_741_824; // Hobby 硬上限 1 GiB
const WARN_THRESHOLD = 0.8; // 超过上限 80% 时印醒目警告
const DELETE_BATCH_SIZE = 20; // del() 每批最多 20 个
const RELEASES_FILE = path.join(REPO_ROOT, "src", "lib", "desktop-releases.ts");

// 只考虑 desktop/Eimu-<semver>… 的物件；semver 允许 prerelease（-beta.1 之类）。
// 注意：此 regex 的选择性 prerelease 群组在天真使用下会把「平台后缀」一起吃进来
// （`Eimu-0.3.2-windows-x64` 的 group(1) 会是 `0.3.2-windows-x64`）。因此捕捉后必须
// 再经 normalizeVersion() 把平台段切掉，否则同一版会被拆成多个「版本」而排序失效。
const ARTIFACT_RE = /^desktop\/Eimu-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const VERSION_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const FEED_NAME_RE = /^latest(?:-[A-Za-z0-9]+)?\.yml$/; // latest.yml / latest-linux.yml / …

// 命名惯例：Eimu-<version>-<platform>-<arch><ext>（例：0.3.2-windows-x64-setup.exe）。
// 把第一个平台关键字之后全部切掉，只留真正的版本号（含可能的 prerelease，如 -beta.1）。
const PLATFORM_CUT_RE = /-(?:linux|windows|win32|win|darwin|macos|mac|osx|freebsd)\b.*$/i;
function normalizeVersion(token) {
  return String(token).replace(PLATFORM_CUT_RE, "");
}

// ── 参数解析 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
let KEEP = 2;
{
  const i = argv.indexOf("--keep");
  if (i >= 0) {
    const raw = argv[i + 1];
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`[prune] --keep 需要一个 ≥1 的整数，收到：${raw ?? "(空)"}`);
      process.exit(2);
    }
    KEEP = n;
  }
}

// ── 凭证读取（去引号；值不落 log）────────────────────────────────────────────
function loadToken() {
  const envPath = path.join(REPO_ROOT, ".env.pulled");
  if (!fs.existsSync(envPath)) {
    throw new Error(`找不到凭证档：${envPath}（BLOB_READ_WRITE_TOKEN 应在此）`);
  }
  const text = fs.readFileSync(envPath, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith("BLOB_READ_WRITE_TOKEN="));
  if (!line) {
    throw new Error(`.env.pulled 内没有 BLOB_READ_WRITE_TOKEN`);
  }
  let value = line.slice(line.indexOf("=") + 1).trim();
  // 去引号：值常被 " " 包住，直接塞环境变数会得到 BlobAccessError。
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!value) throw new Error("BLOB_READ_WRITE_TOKEN 值为空");
  return value;
}

// ── semver 比较（自己写，不引入新依赖）───────────────────────────────────────
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? "" };
}
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // prerelease 排序：有 prerelease < 无 prerelease（0.3.0-beta < 0.3.0）
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// ── 解析发行清单内对外宣传的版本（安全锁）──────────────────────────────────
function parseAdvertisedVersions() {
  if (!fs.existsSync(RELEASES_FILE)) {
    throw new Error(`找不到发行清单：${RELEASES_FILE}`);
  }
  const text = fs.readFileSync(RELEASES_FILE, "utf8");
  const found = new Set();
  // 1) version: "x.y.z" 栏位
  for (const m of text.matchAll(/version:\s*"([^"]+)"/g)) {
    const v = VERSION_RE.exec(m[1]);
    if (v) found.add(normalizeVersion(v[1]));
  }
  // 2) URL 内出现的 Eimu-<版本>
  for (const m of text.matchAll(/Eimu-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)) {
    found.add(normalizeVersion(m[1]));
  }
  return found;
}

// ── 红线：这个 pathname 能不能列入删除？────────────────────────────────────
function isDeletableArtifact(pathname) {
  // 红线 1：必须在 desktop/ 前缀下。history/**（使用者图片）、admin/** 一律不碰。
  if (!pathname.startsWith("desktop/")) return false;
  const base = pathname.slice("desktop/".length);
  // 红线 2：feed 档（latest.yml / latest-linux.yml / latest*.yml）永远不准删。
  //         壳的自动更新靠它，删掉等于断更新。
  if (FEED_NAME_RE.test(base)) return false;
  // 只认 Eimu-<semver> 产物（AppImage / exe / blockmap）。
  return ARTIFACT_RE.test(pathname);
}

function fmtBytes(n) {
  return `${n.toLocaleString("en-US")} B`;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  let blob;
  try {
    blob = await import("@vercel/blob");
  } catch {
    console.error("[prune] 无法载入 @vercel/blob（repo node_modules 应已安装）。");
    process.exit(1);
  }

  let token;
  try {
    token = loadToken();
  } catch (e) {
    console.error(`[prune] 凭证载入失败：${e.message}`);
    process.exit(1);
  }

  let advertised;
  try {
    advertised = parseAdvertisedVersions();
  } catch (e) {
    console.error(`[prune] ${e.message}`);
    process.exit(1);
  }

  // 全量 list（分页）。
  let blobs = [];
  try {
    let cursor;
    do {
      const res = await blob.list({ token, limit: 1000, cursor });
      blobs = blobs.concat(res.blobs);
      cursor = res.hasMore ? res.cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.error(
      `[prune] list() 失败：${e?.message || e}\n` +
        `        若为 store 被停用（limits-exceeded-suspended），带凭证的 list() 通常仍可读；` +
        `请确认 token 正确（.env.pulled 的值需去引号）。`
    );
    process.exit(1);
  }

  const totalBytes = blobs.reduce((s, b) => s + (b.size || 0), 0);
  const headroom = BLOB_LIMIT_BYTES - totalBytes;
  const usedPct = (totalBytes / BLOB_LIMIT_BYTES) * 100;

  console.log("── Eimu 桌面版发行产物滚动清理 ─────────────────────────────");
  console.log(`模式            : ${APPLY ? "APPLY（真的删除）" : "DRY-RUN（只印计画，不删）"}`);
  console.log(`保留版本数 N    : ${KEEP}`);
  console.log(`store 物件总数  : ${blobs.length}`);
  console.log(`store 总用量    : ${fmtBytes(totalBytes)}（${totalBytes.toLocaleString("en-US")} B）`);
  console.log(`上限            : ${fmtBytes(BLOB_LIMIT_BYTES)}`);
  console.log(
    `余裕            : ${fmtBytes(headroom)}（${headroom >= 0 ? "+" : ""}${((headroom / BLOB_LIMIT_BYTES) * 100).toFixed(2)}%）`
  );
  console.log(`已用比例        : ${usedPct.toFixed(2)}%`);
  console.log("");

  if (totalBytes > BLOB_LIMIT_BYTES * WARN_THRESHOLD) {
    console.log("⚠️  警告：store 用量已超过 Hobby 上限的 80%，");
    console.log("    下一次发行（单版约 240 MB）随时可能撞线；跨线会导致整个 store 被停用（删档不解封）。");
    console.log("    建议立刻清理旧版产物。");
    console.log("");
  }

  // 解析发行清单版本
  const advertisedSorted = [...advertised].sort(compareVersions);
  console.log(`发行清单内宣传的版本（安全锁，绝不删）: ${advertisedSorted.length ? advertisedSorted.join(", ") : "(无)"}`);
  console.log("");

  // 收集 desktop 发行产物，按版本分组
  const byVersion = new Map(); // version -> [{pathname,size}]
  let nonArtifactDesktop = 0; // 不符合 Eimu-<semver> 的 desktop/*（例如 feed）
  for (const b of blobs) {
    const m = ARTIFACT_RE.exec(b.pathname || "");
    if (m) {
      const v = normalizeVersion(m[1]);
      if (!byVersion.has(v)) byVersion.set(v, []);
      byVersion.get(v).push({ pathname: b.pathname, size: b.size || 0 });
    } else if ((b.pathname || "").startsWith("desktop/")) {
      nonArtifactDesktop++;
    }
  }

  const allVersions = [...byVersion.keys()].sort(compareVersions);
  if (allVersions.length === 0) {
    console.log("store 内没有任何 desktop/Eimu-<版本> 产物，无事可做。");
    console.log(`（desktop/ 下另有 ${nonArtifactDesktop} 个非版本产物，如 latest*.yml feed，一律不碰。）`);
    return;
  }

  // 保留集合 = 最新 N 个 ∪ 宣传版本
  const latestN = new Set(allVersions.slice(-KEEP));
  const keepSet = new Set([...latestN, ...advertised]);

  console.log(`store 内 desktop 版本（由旧到新）: ${allVersions.join(", ")}`);
  console.log(`最新 ${KEEP} 个版本               : ${[...latestN].sort(compareVersions).join(", ")}`);
  console.log(
    `实际保留集合              : ${[...keepSet].sort(compareVersions).join(", ") || "(无)"}` +
      (advertised.size ? "  ← 含发行清单安全锁" : "")
  );
  const toPruneVersions = allVersions.filter((v) => !keepSet.has(v));
  console.log(`将被清理的版本            : ${toPruneVersions.join(", ") || "(无)"}`);
  console.log("");

  // 建立删除计画（逐物件再过一次红线）
  const plan = [];
  for (const v of toPruneVersions) {
    for (const obj of byVersion.get(v)) {
      if (isDeletableArtifact(obj.pathname)) {
        plan.push(obj);
      } else {
        console.log(`  跳过（命中红线，不删）: ${obj.pathname}`);
      }
    }
  }
  plan.sort((a, b) => a.pathname.localeCompare(b.pathname));

  const planBytes = plan.reduce((s, o) => s + o.size, 0);
  console.log(`本次计画删除清单（${plan.length} 件，合计 ${fmtBytes(planBytes)}）:`);
  if (plan.length === 0) {
    console.log("  (空 — 已达目标版本数，无需清理)");
  } else {
    for (const o of plan) {
      console.log(`  DEL  ${o.pathname}  (${fmtBytes(o.size)})`);
    }
  }
  console.log("");
  console.log(`删除后预估总量  : ${fmtBytes(totalBytes - planBytes)}（${totalBytes - planBytes} B）`);
  console.log(`删除后余裕      : ${fmtBytes(BLOB_LIMIT_BYTES - (totalBytes - planBytes))}（${(((BLOB_LIMIT_BYTES - (totalBytes - planBytes)) / BLOB_LIMIT_BYTES) * 100).toFixed(2)}%）`);

  if (!APPLY) {
    console.log("");
    console.log("（DRY-RUN 结束，未删除任何物件。要真的执行请加 --apply。）");
    return;
  }

  if (plan.length === 0) {
    console.log("");
    console.log("无物件可删，结束。");
    return;
  }

  // ── 实删：分批 ≤20 ────────────────────────────────────────────────────────
  console.log("");
  console.log(`开始删除（每批 ≤ ${DELETE_BATCH_SIZE} 个）…`);
  let deleted = 0;
  let deletedBytes = 0;
  for (let i = 0; i < plan.length; i += DELETE_BATCH_SIZE) {
    const batch = plan.slice(i, i + DELETE_BATCH_SIZE);
    const names = batch.map((o) => o.pathname);
    try {
      await blob.del(names, { token });
      for (const o of batch) {
        deleted++;
        deletedBytes += o.size;
        console.log(`  OK   ${o.pathname}  (${fmtBytes(o.size)})`);
      }
    } catch (e) {
      console.error(`  FAIL 批次 [${i}..${i + batch.length - 1}] 删除失败：${e?.message || e}`);
      console.error(`       本批 pathname：${names.join(", ")}`);
      process.exit(1);
    }
  }
  console.log(`已删除 ${deleted} 件，共 ${fmtBytes(deletedBytes)}。`);

  // ── 对帐：重新 list 算总量 ────────────────────────────────────────────────
  console.log("");
  console.log("重新 list() 对帐…");
  let reBlobs = [];
  try {
    let cursor;
    do {
      const res = await blob.list({ token, limit: 1000, cursor });
      reBlobs = reBlobs.concat(res.blobs);
      cursor = res.hasMore ? res.cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.error(`[prune] 对帐 list() 失败：${e?.message || e}`);
    process.exit(1);
  }
  const reTotal = reBlobs.reduce((s, b) => s + (b.size || 0), 0);
  console.log(`对帐后 store 物件数 : ${reBlobs.length}`);
  console.log(`对帐后 store 总用量 : ${fmtBytes(reTotal)}`);
  console.log(`余裕                : ${fmtBytes(BLOB_LIMIT_BYTES - reTotal)}`);

  // 确认剩余版本数
  const reVersions = new Set();
  for (const b of reBlobs) {
    const m = ARTIFACT_RE.exec(b.pathname || "");
    if (m) reVersions.add(normalizeVersion(m[1]));
  }
  console.log(`对帐后 desktop 版本 : ${[...reVersions].sort(compareVersions).join(", ") || "(无)"}`);
  if (reVersions.size > KEEP) {
    console.log(`⚠️  注意：剩余版本数 ${reVersions.size} > N=${KEEP}，可能有版本被安全锁（发行清单）保留。`);
  }
}

main().catch((e) => {
  console.error(`[prune] 非预期错误：${e?.stack || e}`);
  process.exit(1);
});
