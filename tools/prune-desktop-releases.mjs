// tools/prune-desktop-releases.mjs
//
// ─────────────────────────────────────────────────────────────────────────────
// Eimu 桌面版發行產物「滾動清理」工具
// ─────────────────────────────────────────────────────────────────────────────
//
// 【用途】
//   Vercel Blob（Hobby 方案）只有 1 GiB 硬配額（1,073,741,824 bytes）。Eimu 桌面版
//   每版兩平台產物約 240 MB（Linux AppImage ≈126 MB＋Windows exe ≈112 MB），兩版就
//   吃掉半個 store，累積幾版就會撞線。本工具把 store 內 `desktop/Eimu-*` 的發行產物
//   滾動清理到「只留最近 N 個版本」（預設 N=2），確保永遠有空間發下一版。
//
// 【在發行流程中的位置】
//   1. 發新版「前」：先跑本工具（可加 `--keep 1` 的等價效果，或直接保留到只剩 N-1 個
//      舊版），把舊版清掉，讓新產物有空間上傳。
//   2. 上傳新產物、驗收（下載回來比對 size／sha256，見記憶
//      2026-10-04-vercel-blob-put-fixed-pathname）。
//   3. 驗收後再跑一次乾跑確認 store 內剛好只剩 ≤ N 個版本，避免無聲累積。
//
// 【為什麼必須這樣做（2026-10-04 事故）】
//   Vercel Blob Hobby 方案跨過 1 GiB 配額後，平台不是只拒絕「那一筆上傳」——它會把
//   **整個 store 停用**（status: limits-exceeded-suspended）：此後每一個物件對外都是
//   403（含 latest*.yml feed），且**刪檔不會解封**，官方說法是必須等滿 30 天或升級
//   Pro 才能解除。當日已達 324 物件／1,116,478,479 B，導致站內下載鈕與自動更新 feed
//   全斷。因此清理必須是「發行前的常態步驟」，不能等上傳失敗才做。
//
// 【保留集合（安全鎖）】
//   保留 = 最新 N 個版本 ∪ `src/lib/desktop-releases.ts` 內出現的任何版本。
//   後者是硬性安全鎖：任何正在對外宣傳（下載按鈕指向）的版本，即使不在最新 N 個內
//   也絕不能被刪——否則使用者點下載會 404。
//
// 【紅線（絕對不刪）】
//   - 任何 pathname 不在 `desktop/` 前綴下的物件（history/** 使用者圖片、admin/** 等）。
//   - 任何檔名結尾是 `latest-linux.yml`／`latest.yml`／`latest*.yml` 的 feed 檔。
//   見下方 isDeletableArtifact() 內的明確註解。
//
// 【用法】
//   node tools/prune-desktop-releases.mjs            # 乾跑（預設，只印計畫，不刪）
//   node tools/prune-desktop-releases.mjs --apply    # 真的刪（破壞性，需暴君下令）
//   node tools/prune-desktop-releases.mjs --keep 3   # 保留最近 3 個版本
//
// 【憑證】
//   讀 repo 的 `.env.pulled` 內 `BLOB_READ_WRITE_TOKEN`。值常被引號包住，必須去引號
//   （否則 SDK 回 BlobAccessError）。token 值不得印出。
// ─────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const BLOB_LIMIT_BYTES = 1_073_741_824; // Hobby 硬上限 1 GiB
const WARN_THRESHOLD = 0.8; // 超過上限 80% 時印醒目警告
const DELETE_BATCH_SIZE = 20; // del() 每批最多 20 個
const RELEASES_FILE = path.join(REPO_ROOT, "src", "lib", "desktop-releases.ts");

// 只考慮 desktop/Eimu-<semver>… 的物件；semver 允許 prerelease（-beta.1 之類）。
// 注意：此 regex 的選擇性 prerelease 群組在天真使用下會把「平台後綴」一起吃進來
// （`Eimu-0.3.2-windows-x64` 的 group(1) 會是 `0.3.2-windows-x64`）。因此捕捉後必須
// 再經 normalizeVersion() 把平台段切掉，否則同一版會被拆成多個「版本」而排序失效。
const ARTIFACT_RE = /^desktop\/Eimu-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const VERSION_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const FEED_NAME_RE = /^latest(?:-[A-Za-z0-9]+)?\.yml$/; // latest.yml / latest-linux.yml / …

// 命名慣例：Eimu-<version>-<platform>-<arch><ext>（例：0.3.2-windows-x64-setup.exe）。
// 把第一個平台關鍵字之後全部切掉，只留真正的版本號（含可能的 prerelease，如 -beta.1）。
const PLATFORM_CUT_RE = /-(?:linux|windows|win32|win|darwin|macos|mac|osx|freebsd)\b.*$/i;
function normalizeVersion(token) {
  return String(token).replace(PLATFORM_CUT_RE, "");
}

// ── 參數解析 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
let KEEP = 2;
{
  const i = argv.indexOf("--keep");
  if (i >= 0) {
    const raw = argv[i + 1];
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`[prune] --keep 需要一個 ≥1 的整數，收到：${raw ?? "(空)"}`);
      process.exit(2);
    }
    KEEP = n;
  }
}

// ── 憑證讀取（去引號；值不落 log）────────────────────────────────────────────
function loadToken() {
  const envPath = path.join(REPO_ROOT, ".env.pulled");
  if (!fs.existsSync(envPath)) {
    throw new Error(`找不到憑證檔：${envPath}（BLOB_READ_WRITE_TOKEN 應在此）`);
  }
  const text = fs.readFileSync(envPath, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith("BLOB_READ_WRITE_TOKEN="));
  if (!line) {
    throw new Error(`.env.pulled 內沒有 BLOB_READ_WRITE_TOKEN`);
  }
  let value = line.slice(line.indexOf("=") + 1).trim();
  // 去引號：值常被 " " 包住，直接塞環境變數會得到 BlobAccessError。
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!value) throw new Error("BLOB_READ_WRITE_TOKEN 值為空");
  return value;
}

// ── semver 比較（自己寫，不引入新依賴）───────────────────────────────────────
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
  // prerelease 排序：有 prerelease < 無 prerelease（0.3.0-beta < 0.3.0）
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// ── 解析發行清單內對外宣傳的版本（安全鎖）──────────────────────────────────
function parseAdvertisedVersions() {
  if (!fs.existsSync(RELEASES_FILE)) {
    throw new Error(`找不到發行清單：${RELEASES_FILE}`);
  }
  const text = fs.readFileSync(RELEASES_FILE, "utf8");
  const found = new Set();
  // 1) version: "x.y.z" 欄位
  for (const m of text.matchAll(/version:\s*"([^"]+)"/g)) {
    const v = VERSION_RE.exec(m[1]);
    if (v) found.add(normalizeVersion(v[1]));
  }
  // 2) URL 內出現的 Eimu-<版本>
  for (const m of text.matchAll(/Eimu-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)) {
    found.add(normalizeVersion(m[1]));
  }
  return found;
}

// ── 紅線：這個 pathname 能不能列入刪除？────────────────────────────────────
function isDeletableArtifact(pathname) {
  // 紅線 1：必須在 desktop/ 前綴下。history/**（使用者圖片）、admin/** 一律不碰。
  if (!pathname.startsWith("desktop/")) return false;
  const base = pathname.slice("desktop/".length);
  // 紅線 2：feed 檔（latest.yml / latest-linux.yml / latest*.yml）永遠不准刪。
  //         殼的自動更新靠它，刪掉等於斷更新。
  if (FEED_NAME_RE.test(base)) return false;
  // 只認 Eimu-<semver> 產物（AppImage / exe / blockmap）。
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
    console.error("[prune] 無法載入 @vercel/blob（repo node_modules 應已安裝）。");
    process.exit(1);
  }

  let token;
  try {
    token = loadToken();
  } catch (e) {
    console.error(`[prune] 憑證載入失敗：${e.message}`);
    process.exit(1);
  }

  let advertised;
  try {
    advertised = parseAdvertisedVersions();
  } catch (e) {
    console.error(`[prune] ${e.message}`);
    process.exit(1);
  }

  // 全量 list（分頁）。
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
      `[prune] list() 失敗：${e?.message || e}\n` +
        `        若為 store 被停用（limits-exceeded-suspended），帶憑證的 list() 通常仍可讀；` +
        `請確認 token 正確（.env.pulled 的值需去引號）。`
    );
    process.exit(1);
  }

  const totalBytes = blobs.reduce((s, b) => s + (b.size || 0), 0);
  const headroom = BLOB_LIMIT_BYTES - totalBytes;
  const usedPct = (totalBytes / BLOB_LIMIT_BYTES) * 100;

  console.log("── Eimu 桌面版發行產物滾動清理 ─────────────────────────────");
  console.log(`模式            : ${APPLY ? "APPLY（真的刪除）" : "DRY-RUN（只印計畫，不刪）"}`);
  console.log(`保留版本數 N    : ${KEEP}`);
  console.log(`store 物件總數  : ${blobs.length}`);
  console.log(`store 總用量    : ${fmtBytes(totalBytes)}（${totalBytes.toLocaleString("en-US")} B）`);
  console.log(`上限            : ${fmtBytes(BLOB_LIMIT_BYTES)}`);
  console.log(
    `餘裕            : ${fmtBytes(headroom)}（${headroom >= 0 ? "+" : ""}${((headroom / BLOB_LIMIT_BYTES) * 100).toFixed(2)}%）`
  );
  console.log(`已用比例        : ${usedPct.toFixed(2)}%`);
  console.log("");

  if (totalBytes > BLOB_LIMIT_BYTES * WARN_THRESHOLD) {
    console.log("⚠️  警告：store 用量已超過 Hobby 上限的 80%，");
    console.log("    下一次發行（單版約 240 MB）隨時可能撞線；跨線會導致整個 store 被停用（刪檔不解封）。");
    console.log("    建議立刻清理舊版產物。");
    console.log("");
  }

  // 解析發行清單版本
  const advertisedSorted = [...advertised].sort(compareVersions);
  console.log(`發行清單內宣傳的版本（安全鎖，絕不刪）: ${advertisedSorted.length ? advertisedSorted.join(", ") : "(無)"}`);
  console.log("");

  // 收集 desktop 發行產物，按版本分組
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
    console.log("store 內沒有任何 desktop/Eimu-<版本> 產物，無事可做。");
    console.log(`（desktop/ 下另有 ${nonArtifactDesktop} 個非版本產物，如 latest*.yml feed，一律不碰。）`);
    return;
  }

  // 保留集合 = 最新 N 個 ∪ 宣傳版本
  const latestN = new Set(allVersions.slice(-KEEP));
  const keepSet = new Set([...latestN, ...advertised]);

  console.log(`store 內 desktop 版本（由舊到新）: ${allVersions.join(", ")}`);
  console.log(`最新 ${KEEP} 個版本               : ${[...latestN].sort(compareVersions).join(", ")}`);
  console.log(
    `實際保留集合              : ${[...keepSet].sort(compareVersions).join(", ") || "(無)"}` +
      (advertised.size ? "  ← 含發行清單安全鎖" : "")
  );
  const toPruneVersions = allVersions.filter((v) => !keepSet.has(v));
  console.log(`將被清理的版本            : ${toPruneVersions.join(", ") || "(無)"}`);
  console.log("");

  // 建立刪除計畫（逐物件再過一次紅線）
  const plan = [];
  for (const v of toPruneVersions) {
    for (const obj of byVersion.get(v)) {
      if (isDeletableArtifact(obj.pathname)) {
        plan.push(obj);
      } else {
        console.log(`  跳過（命中紅線，不刪）: ${obj.pathname}`);
      }
    }
  }
  plan.sort((a, b) => a.pathname.localeCompare(b.pathname));

  const planBytes = plan.reduce((s, o) => s + o.size, 0);
  console.log(`本次計畫刪除清單（${plan.length} 件，合計 ${fmtBytes(planBytes)}）:`);
  if (plan.length === 0) {
    console.log("  (空 — 已達目標版本數，無需清理)");
  } else {
    for (const o of plan) {
      console.log(`  DEL  ${o.pathname}  (${fmtBytes(o.size)})`);
    }
  }
  console.log("");
  console.log(`刪除後預估總量  : ${fmtBytes(totalBytes - planBytes)}（${totalBytes - planBytes} B）`);
  console.log(`刪除後餘裕      : ${fmtBytes(BLOB_LIMIT_BYTES - (totalBytes - planBytes))}（${(((BLOB_LIMIT_BYTES - (totalBytes - planBytes)) / BLOB_LIMIT_BYTES) * 100).toFixed(2)}%）`);

  if (!APPLY) {
    console.log("");
    console.log("（DRY-RUN 結束，未刪除任何物件。要真的執行請加 --apply。）");
    return;
  }

  if (plan.length === 0) {
    console.log("");
    console.log("無物件可刪，結束。");
    return;
  }

  // ── 實刪：分批 ≤20 ────────────────────────────────────────────────────────
  console.log("");
  console.log(`開始刪除（每批 ≤ ${DELETE_BATCH_SIZE} 個）…`);
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
      console.error(`  FAIL 批次 [${i}..${i + batch.length - 1}] 刪除失敗：${e?.message || e}`);
      console.error(`       本批 pathname：${names.join(", ")}`);
      process.exit(1);
    }
  }
  console.log(`已刪除 ${deleted} 件，共 ${fmtBytes(deletedBytes)}。`);

  // ── 對帳：重新 list 算總量 ────────────────────────────────────────────────
  console.log("");
  console.log("重新 list() 對帳…");
  let reBlobs = [];
  try {
    let cursor;
    do {
      const res = await blob.list({ token, limit: 1000, cursor });
      reBlobs = reBlobs.concat(res.blobs);
      cursor = res.hasMore ? res.cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.error(`[prune] 對帳 list() 失敗：${e?.message || e}`);
    process.exit(1);
  }
  const reTotal = reBlobs.reduce((s, b) => s + (b.size || 0), 0);
  console.log(`對帳後 store 物件數 : ${reBlobs.length}`);
  console.log(`對帳後 store 總用量 : ${fmtBytes(reTotal)}`);
  console.log(`餘裕                : ${fmtBytes(BLOB_LIMIT_BYTES - reTotal)}`);

  // 確認剩餘版本數
  const reVersions = new Set();
  for (const b of reBlobs) {
    const m = ARTIFACT_RE.exec(b.pathname || "");
    if (m) reVersions.add(normalizeVersion(m[1]));
  }
  console.log(`對帳後 desktop 版本 : ${[...reVersions].sort(compareVersions).join(", ") || "(無)"}`);
  if (reVersions.size > KEEP) {
    console.log(`⚠️  注意：剩餘版本數 ${reVersions.size} > N=${KEEP}，可能有版本被安全鎖（發行清單）保留。`);
  }
}

main().catch((e) => {
  console.error(`[prune] 非預期錯誤：${e?.stack || e}`);
  process.exit(1);
});
