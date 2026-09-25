// 分鏡審查面板測試（2026-09-24，能力建設）——與資產面板同構，真行為斷言對齊。
//
// 真行為斷言（GM 視角「用戶看到什麼」）：
//   1. 投影：真分鏡節點 → 審查列（逐鏡，鏡號/描述/台詞/場景/縮圖對得上真資料；非分鏡節點不入列）。
//   2. 縮圖來源：節點本體圖 → 連入圖片節點 → 無圖（三態）
//   3. 面板能開／能關；縮圖真的印出來（逐鏡 img）。
//   4. 駁回＝填理由後停下（狀態與理由落盤；不改動畫面描述/台詞）。
//   5. 整批批准＝逐筆 approved。
//   6. 全自動檔不阻塞流程（preset/auto → stops=false；只有 collaborate 是停點）。
//   7. 導出內容對得上真資料：CSV 逐欄（含轉義）、圖包真的打包（JSZip 解回真 zip 檔名）。
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as unknown as Record<string, unknown>).React ??= React;

import {
  approvalStatusOf,
  buildShotReviewCsv,
  exportShotReviewZip,
  reviewShotsFromNodes,
  reviewStopBehavior,
  reviewSummary,
  shotApprovalFor,
  shotZipPlan,
  ShotReviewPanel,
} from "./ShotReviewPanel";
// 門檻判定/清洗輪子＝真源（路 1 落地）；面板不重寫第二套。
import { isAssetApproved } from "@/lib/character-cards";
import type { CanvasConnection, CanvasNode } from "@/lib/canvas/types";

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function shotFields(over: Record<string, string> = {}) {
  return {
    shotNumber: "S01-03",
    scriptContent: "他推门进来",
    visualDescription: "雨夜街口，侧面中景",
    dialogue: "你终于来了",
    actionState: "",
    narrativeFunction: "",
    timeOfDay: "夜",
    eraCoordinate: "",
    dateCoordinate: "",
    weather: "雨",
    referenceAssets: "场景:[雨夜街] 角色:[霍辞渊]",
    shotSize: "中景",
    cameraAngle: "平视",
    focalLength: "",
    cameraMovement: "推",
    composition: "",
    atmosphere: "",
    colorTone: "",
    lighting: "",
    exposureBlur: "",
    soundEffect: "雨声",
    ...over,
  };
}

function shotNode(id: string, over: Partial<CanvasNode> = {}, fields: Record<string, string> = {}): CanvasNode {
  return {
    id,
    type: "text",
    title: `镜 ${fields.shotNumber ?? "S01-03"}`,
    position: { x: 0, y: 0 },
    width: 220,
    height: 140,
    metadata: { storyboardShot: shotFields(fields) },
    ...over,
  };
}

// ─────────────────────────────────────────── 投影（真節點 → 審查列）

test("reviewShotsFromNodes：逐鏡投影對得上真資料；非分鏡節點不入列；shotNumber 空的整包丟", () => {
  const nodes: CanvasNode[] = [
    shotNode("n1", {}, { shotNumber: "S01-01" }),
    shotNode("n2", {}, { shotNumber: "S01-02", visualDescription: "特写：手指发抖", dialogue: "（无）" }),
    { id: "n3", type: "image", title: "素材图", position: { x: 0, y: 0 }, width: 100, height: 100 },
    shotNode("n4", {}, { shotNumber: "" }),
  ];
  const shots = reviewShotsFromNodes(nodes);
  assert.equal(shots.length, 2, "只有真分镜实体进列（空镜号整包丢）");
  assert.deepEqual(shots.map((s) => s.id), ["n1", "n2"]);
  assert.equal(shots[0].shotNumber, "S01-01");
  assert.equal(shots[1].visualDescription, "特写：手指发抖");
  assert.equal(shots[1].dialogue, "（无）");
  assert.equal(shots[0].imageUrl, null, "没有图就是 null（不编造占位图）");
});

test("reviewShotsFromNodes：縮圖三態——本體圖 → 連入圖片節點 → 無圖；場景名由呼叫端解析", () => {
  const source: CanvasNode = {
    id: "img-1",
    type: "image",
    title: "出图",
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    metadata: { content: PNG_1PX, status: "success" },
  };
  const own = shotNode("n-own", { metadata: { storyboardShot: shotFields(), content: PNG_1PX } as never });
  // 本體非 image 型別 → 內容不算圖（與輪子 imageUrlOf 同一把尺）
  const linked = shotNode("n-linked");
  const bare = shotNode("n-bare");

  const connections: CanvasConnection[] = [
    { id: "c1", fromNodeId: "img-1", toNodeId: "n-linked" },
    { id: "c2", fromNodeId: "img-1", toNodeId: "n-own" },
  ];
  const shots = reviewShotsFromNodes([source, own, linked, bare], {
    connections,
    sceneNameOf: (id) => (id === "n-own" ? "雨夜街" : undefined),
  });
  const byId = new Map(shots.map((s) => [s.id, s]));

  assert.equal(byId.get("n-linked")!.imageUrl, PNG_1PX, "连入的图片节点当缩图");
  assert.equal(byId.get("n-own")!.imageUrl, PNG_1PX, "裁切：text 节点的 content 不算图，走连入路径");
  assert.equal(byId.get("n-bare")!.imageUrl, null);
  assert.equal(byId.get("n-own")!.sceneName, "雨夜街");
  assert.equal(byId.get("n-linked")!.sceneName, "", "取不到场景名＝空字串（不猜）");
});

test("reviewShotsFromNodes：批准狀態從節點 metadata 讀出（缺省＝已批准）", () => {
  const nodes: CanvasNode[] = [
    shotNode("n1"),
    { ...shotNode("n2"), metadata: { storyboardShot: shotFields(), approval: { status: "rejected", reason: "机位不对" } } as never },
  ];
  const shots = reviewShotsFromNodes(nodes);
  assert.equal(approvalStatusOf(shots[0]), "approved");
  assert.equal(approvalStatusOf(shots[1]), "rejected");
  assert.equal(shots[1].approval?.reason, "机位不对");
});

// ─────────────────────────────────────────── 狀態機（與資產面同形）

test("approvalStatusOf：缺省＝已批准、三態讀出、契約外的值與門檻同向", () => {
  assert.equal(approvalStatusOf(undefined), "approved");
  assert.equal(approvalStatusOf({}), "approved");
  assert.equal(approvalStatusOf({ approval: { status: "pending" } }), "pending");
  assert.equal(approvalStatusOf({ approval: { status: "rejected", reason: "x" } }), "rejected");
  const dirty = { status: "weird" as never };
  assert.equal(approvalStatusOf({ approval: dirty }), "pending");
  assert.equal(isAssetApproved(dirty, "collaborate"), false, "門檻會擋 → 顯示必須同向");
});

test("shotApprovalFor：寫入值走真源清洗（駁回帶理由、批准帶時間戳、非法狀態回 null 不寫半套）", () => {
  assert.deepEqual(shotApprovalFor("rejected", "眼神要更狠", "2026-09-24T10:00:00.000Z"), {
    status: "rejected",
    decidedAt: "2026-09-24T10:00:00.000Z",
    reason: "眼神要更狠",
  });
  assert.deepEqual(shotApprovalFor("approved", undefined, "2026-09-24T11:00:00.000Z"), {
    status: "approved",
    decidedAt: "2026-09-24T11:00:00.000Z",
  });
  // 真源清洗：空白理由＝沒有理由（欄位省略，不是空字串）
  assert.deepEqual(shotApprovalFor("rejected", "   ", "2026-09-24T12:00:00.000Z"), {
    status: "rejected",
    decidedAt: "2026-09-24T12:00:00.000Z",
  });
  assert.equal(shotApprovalFor("nope" as never, "x"), null, "非法狀態不寫半套");
  // 面板讀回同一組值（讀寫同一把尺）
  assert.equal(approvalStatusOf({ approval: shotApprovalFor("rejected", "机位不对")! }), "rejected");
});

test("reviewStopBehavior：与真源判定尺一致——只有协作档是停点；预设/自动档不阻塞流程", () => {
  for (const mode of ["collaborate", "preset", "auto"] as const) {
    assert.equal(
      reviewStopBehavior(mode).stops,
      !isAssetApproved({ status: "pending" }, mode),
      `${mode} 档：横幅与门禁判定必须一致`,
    );
  }
  assert.equal(reviewStopBehavior("collaborate").stops, true);
  assert.equal(reviewStopBehavior("preset").stops, false);
  assert.equal(reviewStopBehavior("auto").stops, false);
  assert.match(reviewStopBehavior("collaborate").note, /停点/);
  assert.match(reviewStopBehavior("preset").note, /不阻塞流程/);
});

test("reviewSummary：三態計數", () => {
  assert.deepEqual(
    reviewSummary([{}, { approval: { status: "pending" } }, { approval: { status: "rejected", reason: "x" } }]),
    { total: 3, approved: 1, pending: 1, rejected: 1 },
  );
});

// ─────────────────────────────────────────── 導出

test("buildShotReviewCsv：BOM＋CRLF＋分鏡表頭；逗號/引號/換行轉義；圖片連結對得上", () => {
  const shots = reviewShotsFromNodes([shotNode("n1", { metadata: { storyboardShot: shotFields({ visualDescription: '雨夜街，他说"走"' }) } as never })]);
  const csv = buildShotReviewCsv(shots);
  assert.ok(csv.startsWith("\ufeff"));
  const [header, row] = csv.slice(1).split("\r\n");
  assert.equal(header, "镜号,场景,审核状态,驳回理由,画面描述,台词,图片链接");
  assert.match(row, /^S01-03,,approved,,/);
  assert.ok(row.includes('"雨夜街，他说""走"""'), "引号翻倍转义");
  assert.ok(row.includes("你终于来了"), "台词在列");

  assert.ok(
    buildShotReviewCsv([{ ...shots[0], approval: { status: "rejected", reason: "机位不对" } }]).includes("rejected,机位不对,"),
  );
});

test("shotZipPlan：有名有圖的鏡次才進清單，檔名＝镜号", () => {
  const shots = [
    { id: "n1", shotNumber: "S01-01", sceneName: "", visualDescription: "", dialogue: "", prompt: "", imageUrl: PNG_1PX },
    { id: "n2", shotNumber: "S01-02", sceneName: "", visualDescription: "", dialogue: "", prompt: "", imageUrl: null },
    { id: "n3", shotNumber: "S02-01", sceneName: "", visualDescription: "", dialogue: "", prompt: "", imageUrl: PNG_1PX },
  ];
  assert.deepEqual(shotZipPlan(shots), [
    { fileName: "镜S01-01", url: PNG_1PX },
    { fileName: "镜S02-01", url: PNG_1PX },
  ]);
});

test("exportShotReviewZip：真跑 exportShotsZip，JSZip 解回的檔名/張數對得上真資料；坏链接计入 skipped", async () => {
  const captured: { blob: Blob | null } = { blob: null };
  const doc = {
    createElement: () => ({ style: {} as Record<string, string>, download: "", href: "", click() {} }),
    body: { appendChild() {}, removeChild() {} },
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: globals.document,
    FileReader: globals.FileReader,
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
  };
  globals.document = doc;
  globals.FileReader = class {
    onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      void blob
        .arrayBuffer()
        .then((buffer) => this.onload?.({ target: { result: buffer } }))
        .catch((error: unknown) => this.onerror?.(error));
    }
  };
  URL.createObjectURL = ((blob: Blob) => {
    captured.blob = blob;
    return "blob:test";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

  try {
    const result = await exportShotReviewZip(
      [
        { id: "n1", shotNumber: "S01-01", sceneName: "", visualDescription: "", dialogue: "", prompt: "", imageUrl: PNG_1PX },
        { id: "n2", shotNumber: "S01-02", sceneName: "", visualDescription: "", dialogue: "", prompt: "", imageUrl: "https://broken.test/none.png" },
      ],
      new Date("2026-09-24T00:00:00.000Z"),
    );
    assert.equal(result.exported, 1);
    assert.equal(result.skipped, 1);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(captured.blob!);
    assert.deepEqual(Object.keys(zip.files), ["镜S01-01.png"], "zip 内檔名对得上真分镜数据");
  } finally {
    if (saved.document === undefined) delete globals.document;
    else globals.document = saved.document;
    if (saved.FileReader === undefined) delete globals.FileReader;
    else globals.FileReader = saved.FileReader;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  }
});

// ─────────────────────────────────────────── SSR 真渲染

const noop = () => {};

function render(over: Partial<React.ComponentProps<typeof ShotReviewPanel>> = {}) {
  const shots = reviewShotsFromNodes(
    [
      shotNode("n1", {
        type: "image",
        metadata: { storyboardShot: shotFields(), content: PNG_1PX, prompt: "雨夜街口，侧面中景" } as never,
      }),
      shotNode("n2", { metadata: { storyboardShot: shotFields({ shotNumber: "S01-04", visualDescription: "特写：手指发抖" }) } as never }),
    ],
    { sceneNameOf: (id) => (id === "n1" ? "雨夜街" : undefined) },
  );
  return renderToStaticMarkup(
    createElement(ShotReviewPanel, {
      open: true,
      onClose: noop,
      shots,
      interactionMode: "collaborate",
      onReject: noop,
      onApproveAll: noop,
      ...over,
    }),
  );
}

test("面板能開／能關：open=false 不渲染；open=true 是真 dialog", () => {
  assert.equal(render({ open: false }), "");
  const html = render();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="分镜审查"/);
});

test("逐鏡縮圖真的印出來（img src ＝ 真資料；無圖的鏡次顯示「还没有图」不是空白）", () => {
  const html = render();
  assert.equal((html.match(/<img /g) ?? []).length, 1, "只有 n1 有图");
  assert.ok(html.includes(`src="${PNG_1PX}"`));
  assert.match(html, /镜 S01-03/);
  assert.match(html, /镜 S01-04/);
  assert.match(html, /雨夜街/);
  assert.match(html, /特写：手指发抖/);
  assert.match(html, /台词：你终于来了/);
  assert.match(html, /还没有图/);
});

test("檔位橫幅：协作档说停点；预设/自动档说不阻塞流程且无停点字样", () => {
  assert.match(render({ interactionMode: "collaborate" }), /停点/);
  for (const mode of ["preset", "auto"] as const) {
    const html = render({ interactionMode: mode });
    assert.match(html, /不阻塞流程/);
    assert.equal(/停点/.test(html), false, `${mode} 档不得出现停点文案`);
  }
});

test("摘要與空態/切換按鈕", () => {
  const html = render();
  assert.match(html, /共 2 镜 · 已批准 2 · 待批准 0 · 已退回 0/);
  const empty = render({ shots: [] });
  assert.match(empty, /还没有分镜/);
  assert.match(empty, /disabled=""/);
  assert.equal(/资产审查/.test(empty), false);
  assert.match(render({ onSwitchToAssets: noop }), /资产审查/);
});