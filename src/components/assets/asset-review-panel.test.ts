// 資產審查面板測試（2026-09-24，能力建設）。
//
// 真行為斷言（GM 視角「用戶看到什麼」，守門件不計入）：
//   1. 面板能開／能關（SSR 真渲染：open=false 無 DOM，open=true 有 dialog）。
//   2. 縮圖真的印出來（逐張 img src ＝ 真資料 url，不是「N 张参考图」字樣）。
//   3. 單張替換＝覆蓋（`applyReplaceReference` 真的換掉那一格、長度不變、其他格不動）。
//   4. 重生成請求 payload 對得上（prompt＝卡自己的；參考圖不含正在換的那張）。
//   5. 駁回＝填理由後停下（狀態與理由落盤；**不觸發重生成**）。
//   6. 整批批准＝逐筆 approved。
//   7. 全自動檔不阻塞流程（preset/auto → stops=false；只有 collaborate 是停點）。
//   8. 導出內容對得上真資料：CSV 列逐欄（含轉義）、圖包真的打包（用 JSZip 解回真 zip 檔名）。
//   9. 檔位相依／價格顯示真的印在按鈕上。
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig jsx=preserve → classic runtime，SSR 渲染前補全局 React 樁（Scene3dPreview.test.ts 同款）。
(globalThis as unknown as Record<string, unknown>).React ??= React;

import {
  applyReplaceReference,
  approvalStatusOf,
  assetZipPlan,
  buildAssetRegeneratePayload,
  buildAssetReviewCsv,
  exportAssetReviewZip,
  reviewStopBehavior,
  reviewSummary,
  AssetReviewPanel,
  REVIEW_PANEL_OPEN_EVENT,
  openReviewPanel,
} from "./AssetReviewPanel";
// 寫入與判定輪子＝真源（路 1 落地）；面板不重寫第二套。
import { clearApproval, isAssetApproved, setApproval } from "@/lib/character-cards";
import type { CharacterCard } from "@/lib/character-cards";

function card(over: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id: "card-1",
    name: "霍辞渊",
    kind: "character",
    prompt: "冷面将军，银甲",
    references: [
      { url: "data:image/png;base64,AAAA", role: "character", name: "正面" },
      { url: "data:image/png;base64,BBBB", role: "character", name: "侧面" },
    ],
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...over,
  };
}

/** 1x1 PNG（真 blob，供 zip 打包用）。 */
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

// ─────────────────────────────────────────── 凍結契約消費（缺省＝已批准）

test("approvalStatusOf：缺省＝已批准（存量資產不追溯）；pending/rejected 讀出；契約外的值與門檻同向", () => {
  assert.equal(approvalStatusOf(card()), "approved");
  assert.equal(approvalStatusOf(card({ approval: { status: "pending" } })), "pending");
  assert.equal(approvalStatusOf(card({ approval: { status: "rejected", reason: "发型不对" } })), "rejected");
  assert.equal(approvalStatusOf(null), "approved");
  assert.equal(approvalStatusOf(undefined), "approved");

  // 契約外的值（真源清洗端會直接丟鍵，正常到不了）：面板不得顯示「已批准」而門檻卻擋
  const dirty = { status: "weird" as never };
  assert.equal(approvalStatusOf({ approval: dirty }), "pending");
  assert.equal(isAssetApproved(dirty, "collaborate"), false, "門檻確實會擋 → 顯示必須同向");
});

test("寫入沿用真源 setApproval/clearApproval（面板不重寫）：駁回帶理由、批准帶時間戳、清除回缺省態", () => {
  const rejected = setApproval(card(), "rejected", { reason: "眼神不对，要更狠", decidedAt: "2026-09-24T10:00:00.000Z" });
  assert.deepEqual(rejected.approval, {
    status: "rejected",
    decidedAt: "2026-09-24T10:00:00.000Z",
    reason: "眼神不对，要更狠",
  });
  // 駁回的卡仍逐字保留其他欄位（寫入不動 DNA）
  assert.equal(rejected.name, "霍辞渊");
  assert.equal(rejected.references.length, 2);
  // 面板讀回同一張卡的狀態＝真源寫入的值（讀寫同一把尺）
  assert.equal(approvalStatusOf(rejected), "rejected");

  const approved = setApproval(card({ approval: { status: "pending" } }), "approved", { decidedAt: "2026-09-24T11:00:00.000Z" });
  assert.deepEqual(approved.approval, { status: "approved", decidedAt: "2026-09-24T11:00:00.000Z" });
  assert.equal(approvalStatusOf(approved), "approved");

  const cleared = clearApproval(card({ approval: { status: "rejected", reason: "x" } }));
  assert.equal("approval" in cleared, false);
  assert.equal(approvalStatusOf(cleared), "approved", "清除＝回到缺省＝已批准");
});

// ─────────────────────────────────────────── 逐張替換＝直接覆蓋（決策 6/7）

test("applyReplaceReference：既有格＝覆蓋原圖（不並存、不變長度、其他格逐字不動、role/name 保留）", () => {
  const before = card({ references: [{ url: PNG_1PX, role: "character", name: "正面" }, { url: PNG_1PX, role: "scene", name: "侧面" }] });
  const after = applyReplaceReference(before, 0, "data:image/png;base64,MINE");

  assert.equal(after.references.length, 2, "覆蓋不是並存：長度必須不變");
  assert.equal(after.references[0].url, "data:image/png;base64,MINE");
  assert.equal(after.references[0].role, "character", "原樣使用：角色/名稱不動");
  assert.equal(after.references[0].name, "正面");
  assert.deepEqual(after.references[1], before.references[1], "其他格逐字不動");
  assert.equal(after.id, before.id);
  assert.equal(after.prompt, before.prompt, "不動既有 DNA 簽名");
});

test("applyReplaceReference：還沒有圖時＝補位（用戶自帶素材是唯一的路）", () => {
  const after = applyReplaceReference(card({ references: [] }), 0, "data:image/png;base64,MINE");
  assert.equal(after.references.length, 1);
  assert.equal(after.references[0].url, "data:image/png;base64,MINE");
});

// ─────────────────────────────────────────── 重生成（決策 11：直接扣，不過確認卡）

test("buildAssetRegeneratePayload：prompt＝卡自己的；參考圖不含正在換的那張；不重複注入卡", () => {
  const target = card();
  const payload = buildAssetRegeneratePayload(target, 0, "gpt-image-2") as {
    prompt: string;
    model: string;
    count: number;
    reference_images: { url: string }[];
  };
  assert.equal(payload.prompt, "冷面将军，银甲");
  assert.equal(payload.model, "gpt-image-2");
  assert.equal(payload.count, 1);
  assert.deepEqual(
    payload.reference_images.map((r) => r.url),
    ["data:image/png;base64,BBBB"],
    "正在重生成的那张不能当自己的参考",
  );
  assert.equal("cards" in payload, false, "卡注入选项不进 payload（由调用端以 cards: [] 显式关闭）");

  const withNegative = buildAssetRegeneratePayload(card({ negativePrompt: "双头, 模糊" }), 1) as {
    negative_prompt?: string;
    reference_images: { url: string }[];
  };
  assert.equal(withNegative.negative_prompt, "双头, 模糊");
  assert.deepEqual(withNegative.reference_images.map((r) => r.url), ["data:image/png;base64,AAAA"]);
});

test("重生成事件不進 payload 的確認卡欄位（決策 11：直接扣費）", () => {
  const payload = buildAssetRegeneratePayload(card(), 0);
  assert.equal("confirm" in payload, false);
  assert.equal("require_confirm" in payload, false);
});

// ─────────────────────────────────────────── 駁回＝停下（決策 4）

test("駁回只寫狀態與理由：不產生任何生成副作用（不呼叫生成路徑、不改參考圖/提示詞）", () => {
  // 面板的駁回入口只走 onReject；本斷言釘死「駁回 = 純資料變更」
  const rejected = setApproval(card(), "rejected", { reason: "要更苍白的皮肤" });
  assert.equal(rejected.approval?.status, "rejected");
  assert.equal(rejected.approval?.reason, "要更苍白的皮肤");
  assert.equal(rejected.references.length, 2, "駁回不得改動參考圖");
  assert.equal(rejected.prompt, card().prompt, "駁回不得改動提示詞");
  assert.equal(approvalStatusOf(rejected), "rejected");
});

// ─────────────────────────────────────────── 檔位（決策 1/2）

test("reviewStopBehavior：与真源判定尺一致——只有协作档是停点；预设/自动档不阻塞流程", () => {
  // 面板横幅的 stops 必须等于真源 isAssetApproved 的判定（非同源自造的第二把尺）
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
  assert.match(reviewStopBehavior("auto").note, /不阻塞流程/);
});

test("reviewSummary：三態計數與總數", () => {
  const s = reviewSummary([
    card({ id: "a" }),
    card({ id: "b", approval: { status: "pending" } }),
    card({ id: "c", approval: { status: "rejected", reason: "x" } }),
    card({ id: "d", approval: { status: "approved" } }),
  ]);
  assert.deepEqual(s, { total: 4, approved: 2, pending: 1, rejected: 1 });
  assert.deepEqual(reviewSummary([]), { total: 0, approved: 0, pending: 0, rejected: 0 });
});

// ─────────────────────────────────────────── 導出（決策 9）：CSV 列對得上真資料

test("buildAssetReviewCsv：BOM＋CRLF＋表頭；每卡一行；逗號/引號/換行轉義；連結逐張列出", () => {
  const csv = buildAssetReviewCsv([
    card({ name: '霍辞渊, "将军"', prompt: "第一行\n第二行" }),
    card({ id: "card-2", name: "雨夜街", kind: "scene", references: [{ url: "https://x.test/a.png", role: "scene", name: "街" }] }),
  ]);
  assert.ok(csv.startsWith("\ufeff"), "Excel 读 UTF-8 中文必需 BOM");
  const [header, ...rows] = csv.slice(1).split("\r\n");
  assert.equal(header, "资产名,类型,审核状态,驳回理由,参考图数量,参考图链接,描述");
  assert.equal(rows.length, 2);

  // 行 1：名称/描述含逗号换行 → 整格包引号、内部引号翻倍
  assert.match(rows[0], /^"霍辞渊, ""将军""",角色,approved,,"?2"?,/);
  assert.match(rows[0], /第一行\n第二行/);
  assert.ok(rows[0].includes("data:image/png;base64,AAAA data:image/png;base64,BBBB"), "两张参考图链接都要在");

  // 行 2：真数据逐欄對位
  assert.ok(rows[1].startsWith("雨夜街,场景,approved,,"));
  assert.ok(rows[1].includes("https://x.test/a.png"));

  const rejected = buildAssetReviewCsv([card({ approval: { status: "rejected", reason: "发型不对" } })]);
  assert.ok(rejected.split("\r\n")[1].includes("rejected,发型不对,"), "驳回理由要落到 CSV（给甲方看的是理由）");
});

// ─────────────────────────────────────────── 導出（決策 9）：圖包真的打出來

test("assetZipPlan：檔名逐張對得上真資料（卡名-序號）", () => {
  const plan = assetZipPlan([
    card({ name: "霍辞渊" }),
    card({ id: "card-2", name: "雨夜街", references: [{ url: PNG_1PX, role: "scene", name: "街" }] }),
  ]);
  assert.deepEqual(plan.map((p) => p.fileName), ["霍辞渊-1", "霍辞渊-2", "雨夜街-1"]);
  assert.deepEqual(plan.map((p) => p.url), [card().references[0].url, card().references[1].url, PNG_1PX]);
});

test("exportAssetReviewZip：真跑 exportShotsZip，JSZip 解回的檔名/張數對得上真資料；取不到的圖計入 skipped", async () => {
  // 瀏覽器 API 樁（只在這裡；本檔其他測試不碰 DOM）
  const captured: { blob: Blob | null; download: string | null } = { blob: null, download: null };
  const doc = {
    createElement: () => ({
      style: {} as Record<string, string>,
      download: "",
      href: "",
      click() {},
    }),
    body: { appendChild() {}, removeChild() {} },
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const savedDoc = globals.document;
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;
  const savedFileReader = globals.FileReader;
  globals.document = doc;
  // Node 沒有 FileReader；jszip 在瀏覽器讀 Blob 走這條（缺了它 jszip 讀不到 Blob —— 環境缺口不是產品缺口）
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
    const result = await exportAssetReviewZip(
      [
        card({ name: "霍辞渊", references: [{ url: PNG_1PX, role: "character", name: "正面" }] }),
        card({ id: "card-2", name: "雨夜街", kind: "scene", references: [{ url: "https://broken.test/gone.png", role: "scene", name: "街" }] }),
      ],
      new Date("2026-09-24T00:00:00.000Z"),
    );
    assert.equal(result.exported, 1);
    assert.equal(result.skipped, 1, "取不到的图跳过并计数（不整包失败）");
    assert.ok(captured.blob, "压縮包真的生成了");

    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(captured.blob!);
    assert.deepEqual(Object.keys(zip.files), ["霍辞渊-1.png"], "zip 内檔名对得上真数据（副档名由轮子补齐）");
  } finally {
    if (savedDoc === undefined) delete globals.document;
    else globals.document = savedDoc;
    if (savedFileReader === undefined) delete globals.FileReader;
    else globals.FileReader = savedFileReader;
    URL.createObjectURL = savedCreate;
    URL.revokeObjectURL = savedRevoke;
  }
});

test("exportAssetReviewZip：上游永不回应 → 逾时落终态（该张 skipped，不永久 pending）", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("data:")) return new Response(new Blob(["img"], { type: "image/png" }), { status: 200 });
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    });
  }) as typeof fetch;

  const doc = {
    createElement: () => ({ style: {} as Record<string, string>, download: "", href: "", click() {} }),
    body: { appendChild() {}, removeChild() {} },
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const savedDoc = globals.document;
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;
  const savedFileReader = globals.FileReader;
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
  URL.createObjectURL = (() => "blob:test") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("did not settle within 600ms")), 600);
  });
  try {
    const started = Date.now();
    const result = await Promise.race([
      exportAssetReviewZip(
        [card({ name: "霍辞渊", references: [{ url: PNG_1PX, role: "character", name: "正面" }] }),
         card({ id: "card-2", name: "雨夜街", kind: "scene", references: [{ url: "https://store.tinchak0207.xyz/never.png", role: "scene", name: "街" }] })],
        new Date("2026-09-24T00:00:00.000Z"),
        50,
      ),
      gate,
    ]);
    const elapsed = Date.now() - started;
    assert.equal(result.skipped, 1, "逾时那张落 skipped（面板提示「跳过 N 张取不到的」）");
    assert.equal(result.exported, 1, "data: 好图不受影响");
    assert.ok(elapsed < 600, `不得永久 pending（实测 ${elapsed}ms）`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    globalThis.fetch = savedFetch;
    if (savedDoc === undefined) delete globals.document;
    else globals.document = savedDoc;
    if (savedFileReader === undefined) delete globals.FileReader;
    else globals.FileReader = savedFileReader;
    URL.createObjectURL = savedCreate;
    URL.revokeObjectURL = savedRevoke;
  }
});

// ─────────────────────────────────────────── SSR 真渲染（用戶看到什麼）

const noopAsync = async () => null;
const noopBool = async () => true;
const noop = () => {};

function render(over: Partial<React.ComponentProps<typeof AssetReviewPanel>> = {}) {
  return renderToStaticMarkup(
    createElement(AssetReviewPanel, {
      open: true,
      onClose: noop,
      cards: [card()],
      activeCardIds: ["card-1"],
      interactionMode: "collaborate",
      onRegenerate: noopAsync,
      onReplace: noopBool,
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
  assert.match(html, /aria-label="资产审查"/);
});

test("縮圖牆真的印出來（逐張 img src ＝ 真資料 url，不是只有「N 张参考图」字樣）", () => {
  const html = render();
  assert.ok(html.includes('src="data:image/png;base64,AAAA"'), "第一张参考图真的渲染");
  assert.ok(html.includes('src="data:image/png;base64,BBBB"'), "第二张参考图真的渲染");
  assert.equal((html.match(/<img /g) ?? []).length, 2, "两张图两张 img（不是计数文字）");
  assert.match(html, /霍辞渊/);
  assert.match(html, /角色/, "kind 标签");
  assert.match(html, /生效中/);
});

test("重生成按钮带单价（看得见但不拦）；不存在确认卡字样", () => {
  const html = render({ modelId: "gpt-image-2" });
  assert.match(html, /重生成 · [\d.]+ 币\/张/);
  assert.ok(html.includes("重生成 · 1 币/张"), "gpt-image-2 默认档单价＝1 币/张");
  assert.equal(/确认扣费|需要确认|扣费确认/.test(html), false, "决策 11：不过扣费确认卡");
});

test("檔位橫幅：协作档说停点；预设/自动档说不阻塞流程，且不出现停点字样", () => {
  const collab = render({ interactionMode: "collaborate" });
  assert.match(collab, /停点/);

  for (const mode of ["preset", "auto"] as const) {
    const html = render({ interactionMode: mode });
    assert.match(html, /不阻塞流程/);
    assert.equal(/停点/.test(html), false, `${mode} 档不得出现停点文案`);
  }
});

test("摘要計數與狀態徽章對得上真資料", () => {
  const html = render({
    cards: [card({ id: "a" }), card({ id: "b", approval: { status: "pending" } })],
    activeCardIds: [],
  });
  assert.match(html, /共 2 张资产 · 已批准 1 · 待批准 1 · 已驳回 0/);
  assert.match(html, /已批准/);
  assert.match(html, /待批准/);
});

test("空图资产给的是「上传自有素材」入口（不是死掉的替换）", () => {
  const html = render({ cards: [card({ references: [] })] });
  assert.match(html, /这张资产还没有图/);
  assert.match(html, /上传自有素材/);
});

test("空清单＝空态文案＋整批批准/导出禁用；分镜切换按钮按 prop 出现", () => {
  const empty = render({ cards: [] });
  assert.match(empty, /还没有资产图/);
  assert.match(empty, /disabled=""/);
  assert.equal(/分镜审查/.test(empty), false, "未传 onSwitchToShots＝不渲染该按钮");
  const withSwitch = render({ onSwitchToShots: noop });
  assert.match(withSwitch, /分镜审查/);
});

// ─────────────────────────────────────────── 外部開啟介面（給路 4 的步驟條）

test("openReviewPanel：派发 CustomEvent（含 panel/focusId）；無 window 時回 false", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const savedWindow = globals.window;
  const seen: unknown[] = [];
  const fakeWindow = {
    dispatchEvent: (event: unknown) => {
      seen.push(event);
      return true;
    },
  };
  globals.window = fakeWindow;

  try {
    assert.equal(openReviewPanel({ panel: "shot", focusId: "node-9" }), true);
    assert.equal(seen.length, 1);
    const event = seen[0] as { type: string; detail: { panel: string; focusId?: string } };
    assert.equal(event.type, REVIEW_PANEL_OPEN_EVENT);
    assert.deepEqual(event.detail, { panel: "shot", focusId: "node-9" });

    assert.equal(openReviewPanel(), true);
    assert.deepEqual((seen[1] as { detail: unknown }).detail, { panel: "asset" }, "缺省開資產面");
  } finally {
    if (savedWindow === undefined) delete globals.window;
    else globals.window = savedWindow;
  }

  delete globals.window;
  assert.equal(openReviewPanel(), false, "無 window（SSR）＝誠實回 false，不謊報已開");
});