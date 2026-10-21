// 资产审查面板测试（2026-09-24，能力建设）。
//
// 真行为断言（GM 视角「用户看到什么」，守门件不计入）：
//   1. 面板能开／能关（SSR 真渲染：open=false 无 DOM，open=true 有 dialog）。
//   2. 缩图真的印出来（逐张 img src ＝ 真资料 url，不是「N 张参考图」字样）。
//   3. 单张替换＝覆盖（`applyReplaceReference` 真的换掉那一格、长度不变、其他格不动）。
//   4. 重生成请求 payload 对得上（prompt＝卡自己的；参考图不含正在换的那张）。
//   5. 驳回＝填理由后停下（状态与理由落盘；**不触发重生成**）。
//   6. 整批批准＝逐笔 approved。
//   7. 全自动档不阻塞流程（preset/auto → stops=false；只有 collaborate 是停点）。
//   8. 导出内容对得上真资料：CSV 列逐栏（含转义）、图包真的打包（用 JSZip 解回真 zip 档名）。
//   9. 档位相依／价格显示真的印在按钮上。
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig jsx=preserve → classic runtime，SSR 渲染前补全局 React 桩（Scene3dPreview.test.ts 同款）。
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
// 写入与判定轮子＝真源（路 1 落地）；面板不重写第二套。
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

// ─────────────────────────────────────────── 冻结契约消费（缺省＝已批准）

test("approvalStatusOf：缺省＝已批准（存量资产不追溯）；pending/rejected 读出；契约外的值与门槛同向", () => {
  assert.equal(approvalStatusOf(card()), "approved");
  assert.equal(approvalStatusOf(card({ approval: { status: "pending" } })), "pending");
  assert.equal(approvalStatusOf(card({ approval: { status: "rejected", reason: "发型不对" } })), "rejected");
  assert.equal(approvalStatusOf(null), "approved");
  assert.equal(approvalStatusOf(undefined), "approved");

  // 契约外的值（真源清洗端会直接丢键，正常到不了）：面板不得显示「已批准」而门槛却挡
  const dirty = { status: "weird" as never };
  assert.equal(approvalStatusOf({ approval: dirty }), "pending");
  assert.equal(isAssetApproved(dirty, "collaborate"), false, "门槛确实会挡 → 显示必须同向");
});

test("写入沿用真源 setApproval/clearApproval（面板不重写）：驳回带理由、批准带时间戳、清除回缺省态", () => {
  const rejected = setApproval(card(), "rejected", { reason: "眼神不对，要更狠", decidedAt: "2026-09-24T10:00:00.000Z" });
  assert.deepEqual(rejected.approval, {
    status: "rejected",
    decidedAt: "2026-09-24T10:00:00.000Z",
    reason: "眼神不对，要更狠",
  });
  // 驳回的卡仍逐字保留其他栏位（写入不动 DNA）
  assert.equal(rejected.name, "霍辞渊");
  assert.equal(rejected.references.length, 2);
  // 面板读回同一张卡的状态＝真源写入的值（读写同一把尺）
  assert.equal(approvalStatusOf(rejected), "rejected");

  const approved = setApproval(card({ approval: { status: "pending" } }), "approved", { decidedAt: "2026-09-24T11:00:00.000Z" });
  assert.deepEqual(approved.approval, { status: "approved", decidedAt: "2026-09-24T11:00:00.000Z" });
  assert.equal(approvalStatusOf(approved), "approved");

  const cleared = clearApproval(card({ approval: { status: "rejected", reason: "x" } }));
  assert.equal("approval" in cleared, false);
  assert.equal(approvalStatusOf(cleared), "approved", "清除＝回到缺省＝已批准");
});

// ─────────────────────────────────────────── 逐张替换＝直接覆盖（决策 6/7）

test("applyReplaceReference：既有格＝覆盖原图（不并存、不变长度、其他格逐字不动、role/name 保留）", () => {
  const before = card({ references: [{ url: PNG_1PX, role: "character", name: "正面" }, { url: PNG_1PX, role: "scene", name: "侧面" }] });
  const after = applyReplaceReference(before, 0, "data:image/png;base64,MINE");

  assert.equal(after.references.length, 2, "覆盖不是并存：长度必须不变");
  assert.equal(after.references[0].url, "data:image/png;base64,MINE");
  assert.equal(after.references[0].role, "character", "原样使用：角色/名称不动");
  assert.equal(after.references[0].name, "正面");
  assert.deepEqual(after.references[1], before.references[1], "其他格逐字不动");
  assert.equal(after.id, before.id);
  assert.equal(after.prompt, before.prompt, "不动既有 DNA 签名");
});

test("applyReplaceReference：还没有图时＝补位（用户自带素材是唯一的路）", () => {
  const after = applyReplaceReference(card({ references: [] }), 0, "data:image/png;base64,MINE");
  assert.equal(after.references.length, 1);
  assert.equal(after.references[0].url, "data:image/png;base64,MINE");
});

// ─────────────────────────────────────────── 重生成（决策 11：直接扣，不过确认卡）

test("buildAssetRegeneratePayload：prompt＝卡自己的；参考图不含正在换的那张；不重复注入卡", () => {
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

test("重生成事件不进 payload 的确认卡栏位（决策 11：直接扣费）", () => {
  const payload = buildAssetRegeneratePayload(card(), 0);
  assert.equal("confirm" in payload, false);
  assert.equal("require_confirm" in payload, false);
});

// ─────────────────────────────────────────── 驳回＝停下（决策 4）

test("驳回只写状态与理由：不产生任何生成副作用（不呼叫生成路径、不改参考图/提示词）", () => {
  // 面板的驳回入口只走 onReject；本断言钉死「驳回 = 纯资料变更」
  const rejected = setApproval(card(), "rejected", { reason: "要更苍白的皮肤" });
  assert.equal(rejected.approval?.status, "rejected");
  assert.equal(rejected.approval?.reason, "要更苍白的皮肤");
  assert.equal(rejected.references.length, 2, "驳回不得改动参考图");
  assert.equal(rejected.prompt, card().prompt, "驳回不得改动提示词");
  assert.equal(approvalStatusOf(rejected), "rejected");
});

// ─────────────────────────────────────────── 档位（决策 1/2）

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

test("reviewSummary：三态计数与总数", () => {
  const s = reviewSummary([
    card({ id: "a" }),
    card({ id: "b", approval: { status: "pending" } }),
    card({ id: "c", approval: { status: "rejected", reason: "x" } }),
    card({ id: "d", approval: { status: "approved" } }),
  ]);
  assert.deepEqual(s, { total: 4, approved: 2, pending: 1, rejected: 1 });
  assert.deepEqual(reviewSummary([]), { total: 0, approved: 0, pending: 0, rejected: 0 });
});

// ─────────────────────────────────────────── 导出（决策 9）：CSV 列对得上真资料

test("buildAssetReviewCsv：BOM＋CRLF＋表头；每卡一行；逗号/引号/换行转义；连结逐张列出", () => {
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

  // 行 2：真数据逐栏对位
  assert.ok(rows[1].startsWith("雨夜街,场景,approved,,"));
  assert.ok(rows[1].includes("https://x.test/a.png"));

  const rejected = buildAssetReviewCsv([card({ approval: { status: "rejected", reason: "发型不对" } })]);
  assert.ok(rejected.split("\r\n")[1].includes("rejected,发型不对,"), "驳回理由要落到 CSV（给甲方看的是理由）");
});

// ─────────────────────────────────────────── 导出（决策 9）：图包真的打出来

test("assetZipPlan：档名逐张对得上真资料（卡名-序号）", () => {
  const plan = assetZipPlan([
    card({ name: "霍辞渊" }),
    card({ id: "card-2", name: "雨夜街", references: [{ url: PNG_1PX, role: "scene", name: "街" }] }),
  ]);
  assert.deepEqual(plan.map((p) => p.fileName), ["霍辞渊-1", "霍辞渊-2", "雨夜街-1"]);
  assert.deepEqual(plan.map((p) => p.url), [card().references[0].url, card().references[1].url, PNG_1PX]);
});

test("exportAssetReviewZip：真跑 exportShotsZip，JSZip 解回的档名/张数对得上真资料；取不到的图计入 skipped", async () => {
  // 浏览器 API 桩（只在这里；本档其他测试不碰 DOM）
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
  // Node 没有 FileReader；jszip 在浏览器读 Blob 走这条（缺了它 jszip 读不到 Blob —— 环境缺口不是产品缺口）
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
    assert.ok(captured.blob, "压缩包真的生成了");

    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(captured.blob!);
    assert.deepEqual(Object.keys(zip.files), ["霍辞渊-1.png"], "zip 内档名对得上真数据（副档名由轮子补齐）");
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

// ─────────────────────────────────────────── SSR 真渲染（用户看到什么）

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

test("面板能开／能关：open=false 不渲染；open=true 是真 dialog", () => {
  assert.equal(render({ open: false }), "");
  const html = render();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="资产审查"/);
});

test("缩图墙真的印出来（逐张 img src ＝ 真资料 url，不是只有「N 张参考图」字样）", () => {
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

test("档位横幅：协作档说停点；预设/自动档说不阻塞流程，且不出现停点字样", () => {
  const collab = render({ interactionMode: "collaborate" });
  assert.match(collab, /停点/);

  for (const mode of ["preset", "auto"] as const) {
    const html = render({ interactionMode: mode });
    assert.match(html, /不阻塞流程/);
    assert.equal(/停点/.test(html), false, `${mode} 档不得出现停点文案`);
  }
});

test("摘要计数与状态徽章对得上真资料", () => {
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

// ─────────────────────────────────────────── 外部开启介面（给路 4 的步骤条）

test("openReviewPanel：派发 CustomEvent（含 panel/focusId）；无 window 时回 false", () => {
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
    assert.deepEqual((seen[1] as { detail: unknown }).detail, { panel: "asset" }, "缺省开资产面");
  } finally {
    if (savedWindow === undefined) delete globals.window;
    else globals.window = savedWindow;
  }

  delete globals.window;
  assert.equal(openReviewPanel(), false, "无 window（SSR）＝诚实回 false，不谎报已开");
});