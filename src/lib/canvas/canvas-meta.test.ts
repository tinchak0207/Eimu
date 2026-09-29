// 作品/劇集三級狀態機前端接線測試（2026-09-15 刀 1 收尾）。
//
// 釘死兩件事：
//   1. `canvasProjectMeta` 的讀取側最小校驗（合法保留、非法省略、缺欄位回 {}）。
//   2. `toCanvasProject` 與 `canvasProjectMeta` 的往復合同 + 向後相容
//      （不帶三欄時產出的 project 不得含三欄鍵 —— 舊快照/舊匯出檔不可被塞新鍵）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { canvasProjectMeta, parseImportFile, toCanvasProject } from "./layout";
import { normalizeProject } from "./project-store";
import type { CanvasReducerState } from "./reducer";
import type { CanvasEpisode, CanvasViewport } from "./types";

// ─────────────────────────── helpers

const EMPTY_STATE: CanvasReducerState = { units: [], nodes: [], connections: [] };
const VP: CanvasViewport = { x: 0, y: 0, k: 1 };

function episode(over: Partial<CanvasEpisode> = {}): CanvasEpisode {
  return {
    id: "ep-1",
    episodeNo: 1,
    title: "第一集",
    status: "draft",
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...over,
  };
}

// ─────────────────────────── canvasProjectMeta：合法值保留

test("canvasProjectMeta：三欄齊備時原樣取出", () => {
  const meta = canvasProjectMeta({
    projectType: "series",
    currentStep: 4,
    episodes: [episode(), episode({ id: "ep-2", episodeNo: 2, title: "第二集", status: "processing", script: "劇本原文" })],
  });
  assert.equal(meta.projectType, "series");
  assert.equal(meta.currentStep, 4);
  assert.equal(meta.episodes?.length, 2);
  assert.equal(meta.episodes?.[1].script, "劇本原文", "script 是非空字串就該保留");
});

test("canvasProjectMeta：movie 亦合法（只有 undefined 與未知字串被省略）", () => {
  assert.equal(canvasProjectMeta({ projectType: "movie" }).projectType, "movie");
});

// ─────────────────────────── canvasProjectMeta：非法值省略

test("canvasProjectMeta：非法 projectType 省略該欄（不是回退成預設值）", () => {
  assert.deepEqual(canvasProjectMeta({ projectType: "anime" }), {});
  assert.deepEqual(canvasProjectMeta({ projectType: 3 }), {});
  assert.deepEqual(canvasProjectMeta({ projectType: null }), {});
});

test("canvasProjectMeta：currentStep 走 isValidCreationStep（1..7 整數）", () => {
  assert.equal(canvasProjectMeta({ currentStep: 1 }).currentStep, 1);
  assert.equal(canvasProjectMeta({ currentStep: 7 }).currentStep, 7);
  for (const bad of [0, 8, -1, 3.5, "3", null, Number.NaN]) {
    assert.equal(canvasProjectMeta({ currentStep: bad }).currentStep, undefined, `${String(bad)} 應被省略`);
    assert.equal("currentStep" in canvasProjectMeta({ currentStep: bad }), false);
  }
});

test("canvasProjectMeta：episodes 非陣列或空陣列 → 省略該欄", () => {
  assert.deepEqual(canvasProjectMeta({ episodes: "not-array" }), {});
  assert.deepEqual(canvasProjectMeta({ episodes: [] }), {}, "空陣列與缺欄位同義，不佔 Blob 體積");
  assert.deepEqual(canvasProjectMeta({ episodes: null }), {});
});

test("canvasProjectMeta：逐項最小校驗 —— 缺 id/title、episodeNo 非正整數、status 非三值 → 丟該項", () => {
  const meta = canvasProjectMeta({
    episodes: [
      episode({ id: "" }),
      episode({ title: "" }),
      episode({ episodeNo: 0 }),
      episode({ episodeNo: 1.5 }),
      episode({ status: "reviewing" as unknown as CanvasEpisode["status"] }), // AID 審核態不進本站型別
      { id: "ep-ok", episodeNo: 3, title: "第三集", status: "finished" },
    ],
  });
  assert.equal(meta.episodes?.length, 1, "只有最後一項合法");
  assert.equal(meta.episodes?.[0].id, "ep-ok");
});

test("canvasProjectMeta：逐項校驗不捏造時間戳（缺 createdAt/updatedAt 給空字串）", () => {
  const meta = canvasProjectMeta({ episodes: [{ id: "ep-x", episodeNo: 1, title: "T", status: "draft" }] });
  assert.equal(meta.episodes?.[0].createdAt, "");
  assert.equal(meta.episodes?.[0].updatedAt, "");
});

test("canvasProjectMeta：非物件輸入（快照可能是 null/字串）回 {}", () => {
  assert.deepEqual(canvasProjectMeta(null as unknown as Parameters<typeof canvasProjectMeta>[0]), {});
  assert.deepEqual(canvasProjectMeta(undefined as unknown as Parameters<typeof canvasProjectMeta>[0]), {});
  assert.deepEqual(canvasProjectMeta("junk" as unknown as Parameters<typeof canvasProjectMeta>[0]), {});
});

// ─────────────────────────── 往復合同

test("toCanvasProject → canvasProjectMeta 往返：三欄同值取回", () => {
  const eps = [episode({ script: "原文" }), episode({ id: "ep-2", episodeNo: 2, title: "第二集", status: "finished" })];
  const project = toCanvasProject({ id: "p1", title: "我的作品" }, EMPTY_STATE, VP, "dots", undefined, undefined, "series", 5, eps);
  const meta = canvasProjectMeta(project);
  assert.equal(meta.projectType, "series");
  assert.equal(meta.currentStep, 5);
  assert.deepEqual(meta.episodes, eps, "逐欄原樣（含 script），不得在讀取端被改寫");
});

test("toCanvasProject：currentStep 非法（0/8/小數）不帶鍵 —— 型別守門在寫入側就攔住", () => {
  for (const bad of [0, 8, 2.5]) {
    const project = toCanvasProject({ id: "p1", title: "t" }, EMPTY_STATE, VP, "dots", undefined, undefined, undefined, bad);
    assert.equal("currentStep" in project, false, `currentStep=${bad} 不該落盤`);
  }
});

test("toCanvasProject：episodes 空陣列不帶鍵（不寫空殼佔位）", () => {
  const project = toCanvasProject({ id: "p1", title: "t" }, EMPTY_STATE, VP, "dots", undefined, undefined, undefined, undefined, []);
  assert.equal("episodes" in project, false);
});

// ─────────────────────────── 向後相容

test("向後相容：不帶三欄 → project 不含三欄鍵（舊呼叫端零改動語義）", () => {
  const project = toCanvasProject({ id: "p1", title: "t" }, EMPTY_STATE, VP, "dots", { totalCoins: 10, usedCoins: 1 }, ["card-1"]);
  assert.equal("projectType" in project, false);
  assert.equal("currentStep" in project, false);
  assert.equal("episodes" in project, false);
  // 既有欄位不受影響
  assert.deepEqual(project.cardIds, ["card-1"]);
  assert.deepEqual(project.budget, { totalCoins: 10, usedCoins: 1 });
  assert.deepEqual(canvasProjectMeta(project), {});
});

// ─────────────────────────── 全鏈：寫入 → store 落盤清洗 → 讀回

test("全鏈：toCanvasProject → normalizeProject(store 落盤清洗) → canvasProjectMeta 三欄不變", () => {
  const eps = [episode({ script: "第一集原文" }), episode({ id: "ep-2", episodeNo: 2, title: "第二集", status: "processing" })];
  const built = toCanvasProject({ id: "p1", title: "我的作品" }, EMPTY_STATE, VP, "dots", undefined, undefined, "series", 3, eps);
  // buildProject 的產物在 route 原樣透傳、由 saveCanvasProject 走 normalizeProject 落 Blob。
  const stored = normalizeProject(built);
  assert.ok(stored, "合法 project 必須能落盤");
  assert.equal(stored.projectType, "series");
  assert.equal(stored.currentStep, 3);
  assert.deepEqual(stored.episodes, eps, "store 清洗不得改動合法劇集（含 script 原文）");
  // 讀回：openSavedCanvas 走 canvasProjectMeta（listCanvasProjects 回的是 store 清洗後的值）
  const meta = canvasProjectMeta(stored);
  assert.equal(meta.projectType, "series");
  assert.equal(meta.currentStep, 3);
  assert.deepEqual(meta.episodes, eps);
});

test("全鏈：匯出檔往返（buildExportFile → parseImportFile）三欄帶著走", () => {
  const eps = [episode({ script: "原文" })];
  const built = toCanvasProject({ id: "p1", title: "作品" }, EMPTY_STATE, VP, "dots", undefined, undefined, "movie", 2, eps);
  const parsed = parseImportFile({ kind: "image-studio.canvas", version: 1, exportedAt: "x", project: built });
  assert.ok(parsed);
  assert.equal(parsed.projectType, "movie");
  assert.equal(parsed.currentStep, 2);
  assert.deepEqual(parsed.episodes, eps);
});

test("全鏈：舊匯出檔（無三欄）匯入不冒出空欄位鍵", () => {
  const built = toCanvasProject({ id: "p1", title: "作品" }, EMPTY_STATE, VP, "dots");
  const parsed = parseImportFile(built);
  assert.ok(parsed);
  assert.equal("projectType" in parsed, false);
  assert.equal("currentStep" in parsed, false);
  assert.equal("episodes" in parsed, false);
});
