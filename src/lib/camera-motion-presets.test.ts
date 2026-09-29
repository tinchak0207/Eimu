// 運鏡預設庫 + 公開 API 端點的**真行為**測試（2026-09-27 立）。
//
// 依 [[verification-guards-not-oracles-0923]]：源碼字串斷言只算變更探針。
// 本檔以行為斷言為主——真的呼叫 list/get/compose 與 route handler（NextRequest →
// Response），外加兩個獨立來源的 oracle：①`HARNESS_TOOL_IDS`（harness 註冊表，
// 非本檔資料）②`CAMERA_MOVE_TO_PROMPT`（既有軌跡映射表，用來反證本檔沒有複製它）。
// 未驗：任一條預設在生產 harness 上「跑得動」（toolId 合法 ≠ 該工具可用），
// 以及運鏡結果的視覺品質——那是生成端與暴君驗收的事。

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  CAMERA_MOTION_PRESETS,
  cameraMotionPrompt,
  getCameraMotionPreset,
  listCameraMotionPresetTags,
  listCameraMotionPresets,
  type CameraMotionPreset,
} from "./camera-motion-presets";
import { CAMERA_MOVE_TO_PROMPT, describeCameraTrajectory } from "./camera-trajectory-to-prompt";
import { HARNESS_STUB_TOOLS, HARNESS_TOOL_IDS } from "./harness-tool-registry";
import { GET } from "../app/api/camera-motion-presets/route.ts";

const ALL = CAMERA_MOTION_PRESETS;

/** 覆蓋度清單（每格必須恰有一條互斥預設承接；tagLabel 為權威鍵）。 */
const REQUIRED_CATEGORIES = [
  "固定",
  "推轨",
  "拉远",
  "横移",
  "跟拍",
  "环绕",
  "升降",
  "手持",
  "摇臂",
  "俯冲",
  "仰拍",
  "变焦",
  "眩晕变焦",
  "一镜到底",
  "第一人称",
  "越肩",
  "贴地",
  "航拍",
  "螺旋",
  "甩镜",
  "延时",
  "稳定器",
  "跟焦",
] as const;

// ───────────────────────────── 目錄契約（真資料斷言）

test("條數落在 20-24 區間（互斥覆蓋目標）", () => {
  assert.ok(ALL.length >= 20, `太少：${ALL.length}`);
  assert.ok(ALL.length <= 24, `太多：${ALL.length}`);
});

test("key 全庫唯一、kebab-case、cm- 前綴", () => {
  const keys = ALL.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length, "key 必須唯一");
  for (const key of keys) {
    assert.match(key, /^cm-[a-z0-9]+(?:-[a-z0-9]+)*$/, `非 kebab/cm- 前綴：${key}`);
  }
});

test("tagLabel 全庫唯一且 ≤4 個碼位（膠囊標籤）；name 非空", () => {
  const labels = ALL.map((p) => p.tagLabel);
  assert.equal(new Set(labels).size, labels.length, `tagLabel 必須互斥：${labels.join("/")}`);
  for (const p of ALL) {
    assert.ok([...p.tagLabel].length <= 4, `${p.key} tagLabel 過長：${p.tagLabel}`);
    assert.ok([...p.tagLabel].length >= 1, `${p.key} tagLabel 為空`);
    assert.ok(p.name.trim().length > 0, `${p.key} name 為空`);
  }
});

test("prompt 非空且長度 ≥20；tags 有 3-6 個非空檢索詞", () => {
  for (const p of ALL) {
    assert.ok(p.prompt.trim().length >= 20, `${p.key} prompt 過短`);
    assert.ok(p.tags.length >= 3 && p.tags.length <= 6, `${p.key} tags 數量 ${p.tags.length}`);
    for (const tag of p.tags) assert.ok(tag.trim().length > 0, `${p.key} 有空 tag`);
  }
});

test("toolId ⊆ HARNESS_TOOL_IDS，且不是已知 stub（獨立來源 oracle）", () => {
  for (const p of ALL) {
    assert.equal(typeof p.toolId, "string");
    assert.ok(HARNESS_TOOL_IDS.has(p.toolId), `${p.key} 的 toolId 未註冊：${p.toolId}`);
    assert.equal(HARNESS_STUB_TOOLS[p.toolId], undefined, `${p.key} 指向 stub 工具：${p.toolId}`);
  }
});

test("prompt 不逐字複製既有 CAMERA_MOVE_TO_PROMPT（防第二份映射表）", () => {
  const existing = new Set(Object.values(CAMERA_MOVE_TO_PROMPT));
  for (const p of ALL) {
    assert.equal(existing.has(p.prompt), false, `${p.key} 逐字複製既有映射值`);
  }
});

test("互斥覆蓋：REQUIRED_CATEGORIES 每格恰有一條承接（tagLabel 權威鍵）", () => {
  const byLabel = new Map<string, CameraMotionPreset>();
  for (const p of ALL) byLabel.set(p.tagLabel, p);
  for (const label of REQUIRED_CATEGORIES) {
    assert.ok(byLabel.has(label), `缺類別：${label}`);
  }
  assert.equal(byLabel.size, ALL.length, "有未被覆蓋清單收錄的預設");
});

// ───────────────────────────── listCameraMotionPresets（檢索行為）

test("無參數＝全庫，順序與內容逐位元等於 CAMERA_MOTION_PRESETS", () => {
  const listed = listCameraMotionPresets();
  assert.equal(listed.length, ALL.length);
  assert.deepEqual(listed, ALL);
  assert.equal(listCameraMotionPresets({}), ALL);
  assert.equal(listCameraMotionPresets({ query: "", tag: "" }), ALL);
});

test("query 命中真子集（中文名）＋ 空 query 不篩", () => {
  const hit = listCameraMotionPresets({ query: "推轨" });
  assert.ok(hit.length >= 1 && hit.length < ALL.length, `應為真子集：${hit.length}/${ALL.length}`);
  assert.ok(hit.some((p) => p.key === "cm-dolly-in"), "推轨 應命中 cm-dolly-in");
  for (const p of hit) assert.ok(ALL.includes(p), "命中項必須來自全庫");
  assert.equal(listCameraMotionPresets({ query: "  " }).length, ALL.length, "純空白 query 不得篩掉任何條");
});

test("query 負向對照：亂碼回 0（不得無腦全命中）", () => {
  assert.deepEqual(listCameraMotionPresets({ query: "zzz乱码zzz" }), []);
  assert.deepEqual(listCameraMotionPresets({ query: "QQ_NOPE_0927" }), []);
});

test("query 大小寫不敏感、可命中 prompt 內的英文術語", () => {
  const lower = listCameraMotionPresets({ query: "dolly" });
  const upper = listCameraMotionPresets({ query: "DOLLY" });
  assert.equal(lower.length, upper.length);
  assert.ok(lower.length >= 2, "dolly 應命中推轨/拉远/眩晕变焦");
  assert.ok(lower.every((p) => p.key.includes("dolly") || p.prompt.toLowerCase().includes("dolly")));
});

test("tag 精確命中 tags；未知 tag 回 0；query＋tag 取交集", () => {
  const aerial = listCameraMotionPresets({ tag: "航拍" });
  assert.ok(aerial.length >= 1);
  for (const p of aerial) assert.ok(p.tags.includes("航拍"), `${p.key} 不含該 tag`);
  assert.deepEqual(listCameraMotionPresets({ tag: "不存在的标签" }), []);
  const both = listCameraMotionPresets({ query: "无人机", tag: "航拍" });
  for (const p of both) {
    assert.ok(p.tags.includes("航拍"));
    assert.match([p.prompt, p.name, p.tagLabel, ...p.tags].join(" ").toLowerCase(), /无人机/);
  }
});

test("每條都能被自己的 tagLabel 與 name 檢索到；每個 tag 都有歸屬", () => {
  for (const p of ALL) {
    assert.ok(
      listCameraMotionPresets({ query: p.tagLabel }).some((x) => x.key === p.key),
      `${p.key} 無法用 tagLabel 檢索到`,
    );
    assert.ok(
      listCameraMotionPresets({ query: p.name }).some((x) => x.key === p.key),
      `${p.key} 無法用 name 檢索到`,
    );
  }
  const facet = listCameraMotionPresetTags();
  assert.ok(facet.length >= 40, `tags facet 太少：${facet.length}`);
  for (const tag of facet) {
    assert.ok(listCameraMotionPresets({ tag }).length >= 1, `tag 無任一條目引用：${tag}`);
  }
  assert.deepEqual(listCameraMotionPresetTags(), facet, "facet 必須確定性（同輸入同輸出）");
});

// ───────────────────────────── getCameraMotionPreset

test("getCameraMotionPreset：已知回同一物件參照、容忍大小寫與空白；未知回 null", () => {
  for (const p of ALL) {
    assert.equal(getCameraMotionPreset(p.key), p, "必須回全庫同一物件（不做複製）");
  }
  assert.equal(getCameraMotionPreset("CM-DOLLY-IN"), ALL.find((p) => p.key === "cm-dolly-in"));
  assert.equal(getCameraMotionPreset("  cm-fixed  "), ALL.find((p) => p.key === "cm-fixed"));
  assert.equal(getCameraMotionPreset("cm-not-exist"), null);
  assert.equal(getCameraMotionPreset(""), null);
});

// ───────────────────────────── cameraMotionPrompt（組裝行為）

test("cameraMotionPrompt：未知 key 回 null；每條已知 key 都能組出含本文的提示詞", () => {
  assert.equal(cameraMotionPrompt("cm-nope"), null);
  assert.equal(cameraMotionPrompt(""), null);
  for (const p of ALL) {
    const out = cameraMotionPrompt(p.key);
    assert.ok(out && out.length > p.prompt.length, `${p.key} 組裝結果為空`);
    assert.ok(out.includes(p.prompt), `${p.key} 組裝結果丟失 preset 本文`);
    assert.match(out, /^Camera: /, `${p.key} 未走既有 Camera 槽編排`);
    assert.match(out, /ending framed on the subject\.$/, `${p.key} 未走既有尾句`);
  }
});

test("零情境逐位元等價退化：undefined / 空字串 / 純空白三路完全相同，且不注入空段", () => {
  for (const p of ALL) {
    const base = cameraMotionPrompt(p.key);
    assert.equal(cameraMotionPrompt(p.key, undefined), base);
    assert.equal(cameraMotionPrompt(p.key, ""), base);
    assert.equal(cameraMotionPrompt(p.key, "   \n\t "), base);
    assert.doesNotMatch(base ?? "", /,\s*,|,\s*\./, `${p.key} 注入了空情境段`);
  }
});

test("有情境時差異只落在情境段；情境首尾空白被 trim", () => {
  const ctx = "雨夜天台，主角背对镜头站定";
  for (const p of ALL) {
    const base = cameraMotionPrompt(p.key) as string;
    const withCtx = cameraMotionPrompt(p.key, ctx) as string;
    assert.notEqual(withCtx, base, `${p.key} 情境未生效`);
    assert.ok(withCtx.includes(ctx), `${p.key} 情境遺失`);
    // 去掉情境段（含其前置分隔符）後必須逐位元還原基準輸出
    assert.equal(withCtx.replace(`, ${ctx}`, ""), base, `${p.key} 基準段被情境污染`);
    assert.equal(cameraMotionPrompt(p.key, `  ${ctx}  `), withCtx, `${p.key} 未 trim 情境`);
  }
});

test("複用契約：組裝結果逐字等於既有 describeCameraTrajectory 的輸出（零第二套邏輯）", () => {
  const ctx = "海面晨雾，孤舟向右出画";
  for (const p of ALL) {
    assert.equal(cameraMotionPrompt(p.key), describeCameraTrajectory({ summary: p.prompt }));
    assert.equal(cameraMotionPrompt(p.key, ctx), describeCameraTrajectory({ summary: `${p.prompt}, ${ctx}` }));
  }
});

// ───────────────────────────── GET /api/camera-motion-presets（端點真行為）

function req(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: "GET" });
}

async function bodyOf(res: Response) {
  return (await res.json()) as {
    presets?: CameraMotionPreset[];
    total?: number;
    tags?: string[];
    success?: boolean;
    code?: string;
  };
}

test("公開只讀：無任何登入環境也回 200 全量，body 形狀 {presets,total,tags}", async () => {
  const prevMode = process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  const prevKey = process.env.IMAGE_STUDIO_BIZ_KEY;
  delete process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  delete process.env.IMAGE_STUDIO_BIZ_KEY;
  try {
    const res = await GET(req("/api/camera-motion-presets"));
    assert.equal(res.status, 200, "公開端點不得要求登入");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await bodyOf(res);
    assert.equal(body.total, ALL.length);
    assert.equal(body.presets?.length, ALL.length);
    assert.deepEqual(body.presets, ALL, "端點必須回全庫（無分頁截斷）");
    assert.ok((body.tags?.length ?? 0) >= 40);
    for (const tag of body.tags ?? []) {
      assert.ok(ALL.some((p) => p.tags.includes(tag)), `facet tag 無歸屬：${tag}`);
    }
  } finally {
    if (prevMode !== undefined) process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = prevMode;
    if (prevKey !== undefined) process.env.IMAGE_STUDIO_BIZ_KEY = prevKey;
  }
});

test("端點 q / tag 篩選與純函式層一致；負向對照 total=0", async () => {
  const hit = await bodyOf(await GET(req("/api/camera-motion-presets?q=%E6%8E%A8%E8%BD%A8"))); // q=推轨
  assert.ok((hit.total ?? 0) >= 1 && (hit.total ?? 0) < ALL.length);
  assert.ok(hit.presets?.some((p) => p.key === "cm-dolly-in"));
  assert.equal(hit.total, hit.presets?.length, "total 必須等於過濾後回傳條數");

  const neg = await bodyOf(await GET(req("/api/camera-motion-presets?q=zzz%E4%B9%B1%E7%A0%81zzz"))); // q=zzz乱码zzz
  assert.equal(neg.total, 0);
  assert.deepEqual(neg.presets, []);

  const byTag = await bodyOf(await GET(req("/api/camera-motion-presets?tag=%E8%88%AA%E6%8B%8D"))); // tag=航拍
  assert.ok((byTag.total ?? 0) >= 1);
  for (const p of byTag.presets ?? []) assert.ok(p.tags.includes("航拍"));

  const both = await bodyOf(await GET(req("/api/camera-motion-presets?q=dolly&tag=dolly%20zoom")));
  for (const p of both.presets ?? []) assert.ok(p.tags.includes("dolly zoom"));
});
